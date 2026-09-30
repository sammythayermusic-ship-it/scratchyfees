import Link from 'next/link'
import { DOMAIN, SCRATCHY_MINT, X_HANDLE } from '@/lib/config'

export function Footer() {
  return (
    <footer className="mt-16 border-t border-magenta/15 bg-stage/60">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/mascot-head.png" alt="" width={28} height={28} className="rounded-full" />
          <span>{DOMAIN} · prizes paid in $PUMP from the $SCRATCHY pool fee</span>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <a
            href={`https://pump.fun/coin/${SCRATCHY_MINT}`}
            target="_blank"
            rel="noreferrer"
            title={SCRATCHY_MINT}
            className="font-mono hover:text-ink"
          >
            CA: {SCRATCHY_MINT.slice(0, 4)}…{SCRATCHY_MINT.slice(-8)}
          </a>
          <Link href="/fair" className="hover:text-ink">
            Provably fair
          </Link>
          <Link href="/faq" className="hover:text-ink">
            FAQ
          </Link>
          <a href={`https://x.com/${X_HANDLE}`} target="_blank" rel="noreferrer" className="hover:text-ink">
            @{X_HANDLE}
          </a>
        </div>
      </div>
      <p className="mx-auto max-w-6xl px-4 pb-8 text-xs text-muted/70">
        Holder rewards from trading fees. Outcomes are pre-committed and verifiable. Nothing here is financial
        advice.
      </p>
    </footer>
  )
}
