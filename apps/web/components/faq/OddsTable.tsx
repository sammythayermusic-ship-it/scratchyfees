import { ECON, ODDS_ROWS } from './econ'

/** Rarity swatches matching the ticket frames in globals.css. */
const SWATCH: Record<number, string> = {
  0: 'bg-[linear-gradient(135deg,#8e7aa8,#4e0268)]',
  1: 'bg-[linear-gradient(135deg,#ff9fe6,#fc04a8)]',
  2: 'bg-[linear-gradient(135deg,#e7a5ff,#a802ee,#f919d7)]',
  3: 'bg-[linear-gradient(135deg,#fdf771,#f9a723)]',
  4: 'bg-[linear-gradient(90deg,#fdf771,#fc04a8,#fbd53f,#f919d7)]',
  5: 'bg-[linear-gradient(90deg,#ff5ebc,#fdf771,#5ae3ff,#a802ee)]',
}

/** PLAN §2.3 per-ticket odds + the §2.4 jackpot roll, rendered from core TIERS / config. */
export function OddsTable() {
  return (
    <div className="overflow-hidden rounded-2xl border border-magenta/20">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Per-ticket odds and prizes</caption>
        <thead className="bg-stage/70 text-[11px] uppercase tracking-wider text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">
              Result
            </th>
            <th scope="col" className="px-2 py-2 text-right font-semibold">
              Chance
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Prize
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-magenta/10">
          {ODDS_ROWS.map((r) => (
            <tr key={r.id} className="bg-stage-2/40">
              <th scope="row" className="px-3 py-2.5 font-semibold text-ink">
                <span className="flex items-center gap-2">
                  <span className={`h-3 w-3 shrink-0 rounded-full ${SWATCH[r.id] ?? ''}`} aria-hidden />
                  {r.name}
                </span>
              </th>
              <td className="px-2 py-2.5 text-right tabular-nums text-ink">
                {r.chance}
                {r.oneIn !== '—' && (
                  <span className="block whitespace-nowrap text-[11px] text-muted">{r.oneIn}</span>
                )}
              </td>
              <td className="px-3 py-2.5 text-right font-display text-lg text-gold">{r.prize}</td>
            </tr>
          ))}
          <tr className="bg-gold/10">
            <th scope="row" className="px-3 py-2.5 font-semibold text-ink">
              🚨 JACKPOT
              <span className="block text-[11px] font-normal text-muted">its own roll on every ticket</span>
            </th>
            <td className="px-2 py-2.5 text-right tabular-nums text-ink">
              {ECON.jackpotChance}
              <span className="block whitespace-nowrap text-[11px] text-muted">1 in {ECON.jackpotOdds}</span>
            </td>
            <td className="px-3 py-2.5 text-right font-display text-lg">
              <span className="foil-text">the whole pot</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
