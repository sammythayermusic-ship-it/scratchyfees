'use client'

import Image from 'next/image'
import { PlayArea } from '@/components/home/PlayArea'
import { StatsBand } from '@/components/home/StatsBand'
import { RecentWins } from '@/components/home/RecentWins'
import { useMyWallet } from './providers'

export default function Home() {
  const { setWallet } = useMyWallet()
  return (
    <div className="flex flex-col gap-6 pt-4">
      <section className="relative overflow-hidden rounded-3xl border border-gold/25 shadow-[0_30px_80px_-30px_rgba(252,4,168,0.7)]">
        <Image
          src="/brand/banner-hero.webp"
          alt="$SCRATCHY — scratchyfees.fun"
          width={1920}
          height={823}
          priority
          sizes="(max-width: 1152px) 100vw, 1152px"
          className="h-auto w-full"
        />
      </section>
      <p className="text-center font-display text-xl text-ink sm:text-2xl">
        Hold <span className="text-gold">$50+</span> of $SCRATCHY · paste your wallet · scratch every 10
        minutes · <span className="text-magenta">win $PUMP instantly</span>
      </p>
      <StatsBand />
      <PlayArea onWallet={setWallet} />
      <RecentWins />
    </div>
  )
}
