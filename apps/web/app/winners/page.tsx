import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { WinnersBoard } from '@/components/winners/WinnersBoard'

export const metadata: Metadata = {
  title: 'Winners — $SCRATCHY',
  description:
    'Every $SCRATCHY scratch-ticket win, live: exact $PUMP amounts, Solscan receipts, jackpot hits and the all-time biggest wins.',
  alternates: { canonical: '/winners' },
}

export default function WinnersPage() {
  return (
    <div className="flex flex-col gap-6 pt-6">
      <header className="panel relative flex items-center gap-4 overflow-hidden px-4 py-5 sm:gap-6 sm:px-7 sm:py-7">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[repeating-conic-gradient(from_0deg_at_12%_50%,rgba(249,25,215,0.10)_0deg_9deg,transparent_9deg_18deg)]"
        />
        <Image
          src="/brand/mascot-sticker.png"
          alt="Scratchy, the $SCRATCHY mascot"
          width={768}
          height={768}
          priority
          sizes="(min-width: 640px) 144px, 96px"
          className="relative h-24 w-24 shrink-0 animate-float drop-shadow-[0_10px_30px_rgba(252,4,168,0.55)] sm:h-36 sm:w-36"
        />
        <div className="relative min-w-0">
          <p className="text-[11px] uppercase tracking-[0.25em] text-magenta sm:text-xs">
            receipts or it didn&apos;t happen
          </p>
          <h1 className="foil-text font-display text-5xl leading-none sm:text-7xl">Winners</h1>
          <p className="mt-2 max-w-xl text-sm text-muted sm:text-base">
            Every win is paid automatically in <span className="text-gold">$PUMP</span>, straight to the
            winner&apos;s wallet. Tap any <span className="text-ink">tx ↗</span> to check it on Solscan.
          </p>
          <Link href="/" className="btn-gold mt-4 inline-block text-sm sm:text-base">
            Scratch your tickets
          </Link>
        </div>
      </header>
      <WinnersBoard />
    </div>
  )
}
