# Provably fair — how to verify any ticket

Implements [PLAN.md §4](../PLAN.md) exactly. The same code ([`packages/core/src/fair.ts`](../packages/core/src/fair.ts))
runs on the server when tickets are issued and in your browser on the `/fair` page.

## The scheme

1. **Commit.** Before a round's entrants are known, the server generates `serverSeed` (32 random bytes) and
   publishes `sha256(serverSeed)`. Round N+1's commitment is visible during round N; it is also shown with the
   round when it starts.
2. **Derive.** Every ticket's outcome is fixed at issuance:

   ```
   digest = HMAC_SHA256(key = serverSeed, message = "<wallet>:<roundId>:<ticketIdx>")
   x = big-endian uint64 of digest[0..7]  >> 11      → 53-bit integer, u = x / 2^53 ∈ [0, 1)
   y = big-endian uint64 of digest[8..15] >> 11      → 53-bit integer for the separate jackpot roll
   ```

   `wallet` is the base58 address, `roundId` the integer round number shown on the site, `ticketIdx` the 0-based
   ticket index within that wallet's entry.

3. **Map.** Tier = the first row with `u < cumulative probability` (exact integer comparison
   `x × 1,000,000 < cumulative_ppm × 2^53`, so float rounding can't move a boundary):

   | cumulative | tier     | prize |
   | ---------- | -------- | ----- |
   | 0.700      | loser    | 0     |
   | 0.900      | small    | 1.5e  |
   | 0.970      | nice     | 5e    |
   | 0.995      | big      | 8e    |
   | 0.999      | HUGE     | 25e   |
   | 1.000      | TIER-MAX | 50e   |

   Jackpot hit ⇔ `y × 50,000 < 2^53` (1-in-50,000).

4. **Reveal.** When the round ends the seed is published. Anyone can check `sha256(seed)` against the commitment
   and recompute every ticket. Prize amounts use the round's published parameters (pool P, PAYOUT_RATE, W, and
   each entry's multiplier): `prize = min(floor(k10 × (B − floor(B/10)) × mult_µ / (10 × W_µ)), floor(P/20))`.

The scratch is theater — exactly like a paper scratch ticket, the outcome was printed before you touched it.
Scratching only reveals it.

## Independent check

[`packages/core/test/fixtures/fair-vectors.json`](../packages/core/test/fixtures/fair-vectors.json) was generated
by a separate Python implementation (`hmac` + `hashlib`, no shared code). The TypeScript must reproduce every
vector byte-for-byte, including one ticket per tier and a real jackpot hit. In Python:

```python
import hmac, hashlib
d = hmac.new(bytes.fromhex(seed_hex), f"{wallet}:{round_id}:{idx}".encode(), hashlib.sha256).digest()
x = int.from_bytes(d[0:8], "big") >> 11
y = int.from_bytes(d[8:16], "big") >> 11
cum = [700000, 900000, 970000, 995000, 999000, 1000000]
tier = next(i for i, c in enumerate(cum) if x * 1_000_000 < c * 2**53)
jackpot = y * 50000 < 2**53
```
