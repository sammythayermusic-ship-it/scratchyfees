import { LADDER_ROWS } from './econ'

/** Holdings → tickets per drop → whale multiplier → share weight, computed by core's entryTerms. */
export function TicketLadder() {
  return (
    <div className="overflow-hidden rounded-2xl border border-magenta/20">
      <table className="w-full text-right text-sm tabular-nums">
        <caption className="sr-only">Tickets and multiplier by amount of $SCRATCHY held</caption>
        <thead className="bg-stage/70 text-[11px] uppercase tracking-wider text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-semibold">
              Holding
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              Tickets
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              Mult.
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Weight
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-magenta/10">
          {LADDER_ROWS.map((r) => (
            <tr key={r.holding} className="bg-stage-2/40">
              <th scope="row" className="px-3 py-2 text-left font-semibold text-ink">
                {r.holding}
              </th>
              <td className="px-2 py-2 text-gold">{r.tickets}</td>
              <td className="px-2 py-2 text-magenta">{r.mult}</td>
              <td className="px-3 py-2 text-ink">{r.weight}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
