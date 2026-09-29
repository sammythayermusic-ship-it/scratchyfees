import type { RoundParams } from '@scratchy/core'
import { TIER_MULTIPLE, TIER_NAMES } from '@/lib/money'
import { CopyButton } from './CopyButton'
import {
  groupBig,
  multExact,
  ppmFraction,
  ppmPercent,
  pumpExact,
  ticketProof,
  type TicketRow,
} from './verify'

const u12 = (u: number) => u.toFixed(12)

function Step({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[7.5rem_1fr] sm:gap-3">
      <dt className="text-[11px] uppercase tracking-wider text-muted sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-[12px] leading-relaxed text-ink">{children}</dd>
    </div>
  )
}

/** "Show your work" for one ticket: message → HMAC → x, y → tier, jackpot → prize, every value from core. */
export function TicketProofView({
  row,
  seed,
  params,
}: {
  row: TicketRow
  seed: string
  params: RoundParams
}) {
  const p = ticketProof(seed, params, row.wallet, row.idx, row.multMicro)
  const k = p.k10 === 0n ? '0' : TIER_MULTIPLE[p.tier]
  const capPpm = ppmPercent(params.singlePrizeCapPpm)
  return (
    <div className="rounded-xl border border-gold/25 bg-stage/80 p-3">
      <dl className="flex flex-col gap-2.5">
        <Step label="Message">
          <span className="flex items-start justify-between gap-2">
            <span>&quot;{p.message}&quot;</span>
            <CopyButton value={p.message} label="Copy HMAC message" />
          </span>
        </Step>
        <Step label="HMAC-SHA256">
          <span className="text-muted">key = server seed, msg = message →</span>
          <br />
          <span className="text-gold">{p.bytesTier}</span>
          <span className="text-magenta">{p.bytesJackpot}</span>
          <span className="text-muted">{p.digestHex.slice(32)}</span>
        </Step>
        <Step label="Tier roll">
          x = <span className="text-gold">0x{p.bytesTier}</span> &gt;&gt; 11 = {groupBig(p.x)}
          <br />u = x / 2^53 = {u12(p.u)}
          <br />
          <span className="text-muted">
            {ppmFraction(p.lowerPpm)} ≤ u &lt; {ppmFraction(p.upperPpm)} →{' '}
          </span>
          <b className="font-sans text-sm text-gold">
            {TIER_NAMES[p.tier]} (k = {k})
          </b>
        </Step>
        <Step label="Jackpot roll">
          y = <span className="text-magenta">0x{p.bytesJackpot}</span> &gt;&gt; 11 = {groupBig(p.y)}
          <br />y / 2^53 = {u12(p.uJackpot)} {p.jackpot ? '<' : '≥'} 1 / {groupBig(p.jackpotOdds)} →{' '}
          <b className={`font-sans text-sm ${p.jackpot ? 'text-gold' : 'text-muted'}`}>
            {p.jackpot ? 'JACKPOT HIT' : 'no jackpot'}
          </b>
        </Step>
        <Step label="Prize">
          {p.k10 === 0n ? (
            <>k = 0 → prize = 0</>
          ) : (
            <>
              <span className="text-muted">floor(k10 × ticketBudget × mult_µ / (10 × W_µ))</span>
              <br />= floor({p.k10.toString()} × {groupBig(p.budget.ticketBudgetRaw)} ×{' '}
              {groupBig(row.multMicro)} / (10 × {groupBig(params.totalWeightMicro)}))
              <br />= {groupBig(p.uncappedPrizeRaw)} raw
              <br />
              <span className="text-muted">
                cap = floor(P × {capPpm}) = {groupBig(p.budget.singlePrizeCapRaw)} raw →{' '}
                {p.capped ? 'CAPPED' : 'under the cap'}
              </span>
            </>
          )}
          <br />
          prize = <b className="font-sans text-sm text-gold">{pumpExact(p.prizeRaw)} PUMP</b>
          <span className="text-muted"> · mult {multExact(row.multMicro)}</span>
        </Step>
        {row.stored && (
          <Step label="Server record">
            <span className={row.match ? 'text-emerald-300' : 'font-semibold text-red-300'}>
              {TIER_NAMES[row.stored.tier as 0] ?? `tier ${row.stored.tier}`} ·{' '}
              {row.stored.jackpot ? 'jackpot' : 'no jackpot'} · {pumpExact(row.stored.prizeRaw)} PUMP{' '}
              {row.match ? '✅ identical' : '❌ differs'}
            </span>
          </Step>
        )}
      </dl>
    </div>
  )
}
