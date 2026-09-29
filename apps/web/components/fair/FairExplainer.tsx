import { CUMULATIVE_PPM, SPEC_DEFAULTS, TIERS } from '@scratchy/core'
import { TIER_NAMES } from '@/lib/money'
import { ppmFraction } from './verify'

const pct = (fraction: string) => `${Number((Number(fraction) * 100).toFixed(4))}%`
const JACKPOT_ODDS = Number(SPEC_DEFAULTS.JACKPOT_ODDS).toLocaleString('en-US')

/** [code, trailing comment] per line of the formula block */
const MATH_LINES: [string, string?][] = [
  ['', '# per ticket'],
  ['digest = HMAC-SHA256(key = serverSeed, msg = "wallet:roundId:ticketIdx")'],
  ['x      = uint64(digest bytes 0–7)  >> 11', '   # 53-bit uniform, u = x / 2^53'],
  ['tier   = first row with u < cumulative odds'],
  ['y      = uint64(digest bytes 8–15) >> 11', '   # separate jackpot roll'],
  [`jackpot hit ⇔ y / 2^53 < 1 / ${JACKPOT_ODDS}`],
  [''],
  ['', "# prize, from the round's own stored parameters"],
  ['B      = P × payoutRate'],
  [
    `prize  = min( floor(k × (1 − jackpotShare) × B × mult / W),  floor(P × ${pct(SPEC_DEFAULTS.SINGLE_PRIZE_CAP)}) )`,
  ],
]

const STEPS = [
  {
    n: '1',
    title: 'Commit',
    body: (
      <>
        Before a round starts, the server picks a secret 32-byte <b className="text-ink">server seed</b> and
        publishes its <b className="text-ink">SHA-256 hash</b>. The hash locks the seed in — change one bit
        and the hash no longer matches.
      </>
    ),
  },
  {
    n: '2',
    title: 'Reveal',
    body: (
      <>
        When the round ends, the seed itself is published. Anyone can hash it and check it against the
        commitment that was public the whole time.
      </>
    ),
  },
  {
    n: '3',
    title: 'Recompute',
    body: (
      <>
        Every ticket is <code className="text-gold">HMAC-SHA256(seed, &quot;wallet:round:ticket&quot;)</code>.
        With the seed public, anyone can re-derive every ticket — tier, jackpot roll and exact prize — and
        compare it with what was paid.
      </>
    ),
  },
]

/** The three-step commit–reveal story, then the exact math and the odds table (all from @scratchy/core). */
export function FairExplainer() {
  return (
    <section aria-labelledby="how-heading" className="flex flex-col gap-3">
      <h2 id="how-heading" className="sr-only">
        How it works
      </h2>
      <ol className="grid gap-3 sm:grid-cols-3">
        {STEPS.map((s) => (
          <li key={s.n} className="panel p-4">
            <h3 className="font-display flex items-center gap-2.5 text-xl text-ink">
              <span
                aria-hidden
                className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-b from-gold-hi via-gold to-gold-deep text-base text-stage-3 shadow-[0_0_18px_rgba(251,213,63,0.45)]"
              >
                {s.n}
              </span>
              {s.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
          </li>
        ))}
      </ol>
      <p className="px-1 text-center text-sm text-muted">
        So every outcome is fixed the moment tickets are issued. The scratch is theater — exactly like a paper
        scratch card, scratching only reveals what was already printed.
      </p>
    </section>
  )
}

export function FairMath() {
  return (
    <section className="panel p-4 sm:p-6" aria-labelledby="math-heading">
      <h2 id="math-heading" className="font-display text-2xl">
        The exact math
      </h2>
      <p className="mt-1 text-sm text-muted">
        One shared implementation (<code>packages/core</code>) runs on the server when tickets are issued and
        in your browser on this page. All money math is integer math on raw PUMP units — no floats.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-xl border border-magenta/20 bg-stage/80 p-3 text-[12px] leading-relaxed text-ink sm:text-[13px]">
        <code>
          {MATH_LINES.map(([code, comment], i) => (
            <span key={i}>
              {code}
              {comment && <span className="text-muted">{comment}</span>}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
      <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm text-muted sm:grid-cols-2">
        <div>
          <dt className="inline text-ink">P</dt>{' '}
          <dd className="inline">— pool snapshot taken when the round starts</dd>
        </div>
        <div>
          <dt className="inline text-ink">B</dt>{' '}
          <dd className="inline">— round budget ({pct(SPEC_DEFAULTS.PAYOUT_RATE)} of P by default)</dd>
        </div>
        <div>
          <dt className="inline text-ink">jackpotShare</dt>{' '}
          <dd className="inline">— {pct(SPEC_DEFAULTS.JACKPOT_SHARE)} of B feeds the progressive jackpot</dd>
        </div>
        <div>
          <dt className="inline text-ink">W</dt>{' '}
          <dd className="inline">— Σ tickets × mult over every entry</dd>
        </div>
        <div>
          <dt className="inline text-ink">mult</dt>{' '}
          <dd className="inline">— your whale multiplier for the round</dd>
        </div>
        <div>
          <dt className="inline text-ink">k</dt>{' '}
          <dd className="inline">— the tier&apos;s prize multiple below</dd>
        </div>
      </dl>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[300px] text-left text-sm">
          <caption className="sr-only">Odds table</caption>
          <thead className="text-xs uppercase tracking-wider text-muted">
            <tr>
              <th className="py-1.5 pr-3 font-semibold">Tier</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Chance</th>
              <th className="py-1.5 pr-3 text-right font-semibold">u below</th>
              <th className="py-1.5 text-right font-semibold">Prize k</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-magenta/10 tabular-nums">
            {TIERS.map((t, i) => (
              <tr key={t.key}>
                <td className="py-1.5 pr-3 text-ink">{TIER_NAMES[t.id]}</td>
                <td className="py-1.5 pr-3 text-right">{pct(ppmFraction(t.probPpm))}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-muted">
                  {ppmFraction(CUMULATIVE_PPM[i]!)}
                </td>
                <td className="py-1.5 text-right font-display text-gold">{t.k10 === 0n ? '0' : t.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">
        Boundaries are compared exactly as integers (<code>x × 1,000,000 &lt; cumulative_ppm × 2^53</code>),
        so floating-point rounding can never nudge a ticket into a better or worse tier. The jackpot is 1-in-
        {JACKPOT_ODDS} on every ticket, the same for everyone; its amount is the pot at reveal time. Each
        round stores its own parameters, so a later config change can never break verification of an old
        round.
      </p>
    </section>
  )
}
