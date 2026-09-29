import { ECON } from './econ'

/** Where prize money comes from: pool fee → venue share → sweep + swap → 70/30 split → round budget. */
export function FeeFlow() {
  const steps = [
    <>
      Every buy and sell on the <strong>$SCRATCHY / PUMP pool</strong> pays a{' '}
      <strong>{ECON.tradingFee}</strong> trading fee.
    </>,
    <>
      <strong>Meteora</strong>, the venue that runs the pool, keeps its protocol share of that fee.
    </>,
    <>
      Every <strong>{ECON.sweepMinutes} minutes</strong> the rest is claimed automatically, and the $SCRATCHY
      part is swapped to PUMP so the pool is one currency.
    </>,
  ]
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-3 rounded-xl bg-stage/50 px-3 py-2.5">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-pink font-display text-sm text-ink">
              {i + 1}
            </span>
            <span className="text-sm">{s}</span>
          </li>
        ))}
      </ol>
      <div className="rounded-xl bg-stage/50 px-3 py-3">
        <div className="flex h-9 overflow-hidden rounded-full ring-1 ring-gold/30" aria-hidden>
          <div
            className="grid place-items-center bg-gradient-to-r from-gold-deep via-gold to-gold-hi font-display text-sm text-stage"
            style={{ width: `${ECON.poolSplitWidth}%` }}
          >
            {ECON.poolSplit}
          </div>
          <div className="grid flex-1 place-items-center bg-plum font-display text-sm text-muted">
            {ECON.opsSplit}
          </div>
        </div>
        <p className="mt-2 text-sm">
          <span className="font-bold text-gold">{ECON.poolSplit} → the prize pool</span> (the PRIZE wallet
          that pays winners) · <strong>{ECON.opsSplit} → operations</strong>.
        </p>
      </div>
      <p className="rounded-xl bg-stage/50 px-3 py-2.5 text-sm">
        Then at every drop, <strong>{ECON.payoutRate}</strong> of the prize pool becomes that round&apos;s
        budget: <strong>{ECON.ticketShare}</strong> for ticket prizes, <strong>{ECON.jackpotShare}</strong>{' '}
        into the jackpot.
      </p>
    </div>
  )
}
