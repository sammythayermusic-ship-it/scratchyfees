# Devnet dress rehearsal — results (2026-09-29)

`pnpm devnet:rehearsal --rounds 144 --round-seconds 30 --jackpot-at 40 --breaker-at 90` against the real devnet
cluster (public RPC), real Meteora DAMM v2 pool, real transfers, mock SCRATCHY/PUMP mints. 107 minutes.
Three players (~$60 / ~$600 / ~$5,000 of mock SCRATCHY) played every round over HTTP; TRADER swapped every 10
rounds to generate real 3% fees; one forced jackpot (round 40) and one forced breaker drill (round 90).

| Check                                                                | Result                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------- |
| a day of rounds                                                      | ✅ 144 (1 skipped: first round, no price yet)        |
| payouts confirmed                                                    | ✅ 436 / 436                                         |
| every payout verified on-chain (memo ↔ row, recipient, exact amount) | ✅ 436 transfers                                     |
| exactly one landed tx per payout                                     | ✅ 436 attempts for 436 payouts                      |
| every PRIZE PUMP movement maps to one payout / sweep                 | ✅ 421 transactions                                  |
| finalized PRIZE balance == ledger                                    | ✅ exact (diff 0)                                    |
| no unexplained inflow / outflow                                      | ✅                                                   |
| every revealed ticket re-derives from its revealed seed              | ✅ 23,795 tickets                                    |
| J(n) = J(n−1) + accrual − paid                                       | ✅ all rounds                                        |
| forced jackpot                                                       | ✅ round 40: 1,348,568.59 PUMP paid on-chain         |
| breaker drill: trip → hold → re-derive → release → pay               | ✅ round 90                                          |
| sweeps split exactly 70/30                                           | ✅ 14/14 finished (a 15th was mid-split at shutdown) |
| scratch → confirmed latency (public devnet RPC)                      | p50 2.7 s · p95 24 s · max 59 s                      |
| gas                                                                  | PRIZE 0.0021 SOL · CREATOR 0.0002 SOL                |

The two red lines in the raw report were harness timing, now fixed in the script: one scratch arrived as its
round ended (the API correctly refused it with `not_live`), and the run stopped while the last sweep was
splitting (the sweeper resumes open splits on boot). Raw report: `.devnet/rehearsal-report.json`.
The public devnet RPC rate-limits hard (the p95 latency is mostly 429 back-off); use Helius on mainnet.
