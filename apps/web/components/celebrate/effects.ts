'use client'

import confetti from 'canvas-confetti'
import { winCue } from '@/lib/sfx/manifest'
import { play } from '@/lib/sfx/sound'

/**
 * Win celebrations (PLAN §6). EVERY win gets the floor — screen-shake + confetti cannon + gold burst +
 * the mega-modal — and it escalates by tier: more shake, side cannons (8e+), gold rain (25e+),
 * siren (TIER-MAX). Jackpots get the full-screen takeover on top. Reduced motion → confetti only, gently.
 */
const GOLD = ['#fdf771', '#fbd53f', '#f9a723', '#ffffff']
const BRAND = ['#fc04a8', '#f919d7', '#a802ee', '#fbd53f', '#fdf771']

const reduced = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function shake(px: number, ms: number): void {
  if (reduced()) return
  const el = document.getElementById('shake-root')
  if (!el) return
  el.style.setProperty('--shake', `${px}px`)
  el.style.setProperty('--shake-dur', `${ms}ms`)
  el.classList.remove('shake')
  void el.offsetWidth
  el.classList.add('shake')
  setTimeout(() => el.classList.remove('shake'), ms + 50)
}

function burst(originY: number, count: number, spread: number, colors: string[], scalar = 1) {
  void confetti({
    particleCount: count,
    spread,
    startVelocity: 55,
    origin: { x: 0.5, y: originY },
    colors,
    scalar,
    ticks: 220,
    disableForReducedMotion: false,
  })
}

function sideCannons(count: number) {
  void confetti({
    particleCount: count,
    angle: 60,
    spread: 60,
    origin: { x: 0, y: 0.8 },
    colors: BRAND,
    startVelocity: 65,
  })
  void confetti({
    particleCount: count,
    angle: 120,
    spread: 60,
    origin: { x: 1, y: 0.8 },
    colors: BRAND,
    startVelocity: 65,
  })
}

function goldRain(ms: number) {
  const end = Date.now() + ms
  const frame = () => {
    void confetti({
      particleCount: 6,
      startVelocity: 0,
      gravity: 0.8,
      spread: 360,
      ticks: 300,
      origin: { x: Math.random(), y: -0.05 },
      colors: GOLD,
      shapes: ['circle'],
      scalar: 1.2,
    })
    if (Date.now() < end) requestAnimationFrame(frame)
  }
  frame()
}

export function sirenFlash(ms: number): void {
  if (reduced()) return
  const el = document.createElement('div')
  el.className = 'siren'
  document.body.appendChild(el)
  setTimeout(() => el.remove(), ms)
}

/** tier: 1..5 (1.5e, 5e, 8e, 25e, 50e) */
export function celebrateWin(tier: number): void {
  play(winCue(tier))
  if (reduced()) {
    burst(0.7, 40, 70, GOLD, 0.8)
    return
  }
  shake(3 + tier * 2.2, 380 + tier * 90)
  burst(0.75, 70 + tier * 40, 70 + tier * 10, BRAND)
  burst(0.55, 40 + tier * 20, 360, GOLD, 1.1) // gold burst
  if (tier >= 3) sideCannons(60 + tier * 20)
  if (tier >= 4) goldRain(tier === 4 ? 2_200 : 3_800)
  if (tier >= 5) {
    sirenFlash(1_800)
    play('siren')
  }
}

export function celebrateJackpot(): void {
  play('jackpot')
  play('siren')
  if (reduced()) {
    burst(0.6, 120, 360, GOLD)
    return
  }
  shake(18, 1_100)
  sirenFlash(4_000)
  for (let i = 0; i < 6; i++) setTimeout(() => sideCannons(120), i * 350)
  burst(0.5, 300, 360, GOLD, 1.3)
  goldRain(6_000)
}
