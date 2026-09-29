import type { Metadata } from 'next'
import { FairExplainer, FairMath } from '@/components/fair/FairExplainer'
import { FairVerifier } from '@/components/fair/FairVerifier'
import { ReproduceOffline } from '@/components/fair/ReproduceOffline'

export const metadata: Metadata = {
  title: 'Provably fair — $SCRATCHY',
  description:
    'Every $SCRATCHY ticket is fixed by a seed committed before the round starts. Pick a round, paste a wallet and recompute every ticket in your browser.',
  openGraph: {
    title: 'Provably fair — $SCRATCHY',
    description:
      'Seed hash published before the round, seed revealed after. Recompute every ticket yourself.',
  },
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>

const first = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).slice(0, 64)

export default async function FairPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams
  return (
    <div className="flex flex-col gap-6 pt-6">
      <header className="text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-muted">Don&apos;t trust · verify</p>
        <h1 className="foil-text font-display mt-1 text-5xl sm:text-6xl">Provably fair</h1>
        <p className="mx-auto mt-3 max-w-2xl text-base text-muted sm:text-lg">
          Every ticket&apos;s outcome is locked in before you scratch it — and after each round anyone can
          prove it. No trust required: this page recomputes the tickets right here in your browser.
        </p>
      </header>

      <FairExplainer />

      <FairVerifier
        initialRound={first(sp.round).replace(/[^\d#]/g, '')}
        initialWallet={first(sp.wallet).trim()}
        initialTicket={first(sp.ticket).replace(/[^\d#]/g, '')}
      />

      <FairMath />

      <ReproduceOffline />
    </div>
  )
}
