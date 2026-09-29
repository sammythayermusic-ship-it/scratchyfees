'use client'

import type { Howl as HowlType } from 'howler'
import { SFX, type SfxKey } from './manifest'

/**
 * Tiny howler wrapper. Sounds load lazily on the first user gesture (browsers block audio before one),
 * mute persists in localStorage, and the scratch loop can be started/stopped cheaply while scratching.
 */
const MUTE_KEY = 'scratchy.muted'
let howls: Partial<Record<SfxKey, HowlType>> = {}
let loading: Promise<void> | null = null
let muted = readMuted()
const muteListeners = new Set<(m: boolean) => void>()

function readMuted(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

export function isMuted(): boolean {
  return muted
}

export function setMuted(m: boolean): void {
  muted = m
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0')
  } catch {
    /* ignore */
  }
  for (const h of Object.values(howls)) h?.mute(m)
  for (const l of muteListeners) l(m)
}

export function onMuteChange(l: (m: boolean) => void): () => void {
  muteListeners.add(l)
  return () => muteListeners.delete(l)
}

/** Call from a user gesture (first click/tap). Safe to call repeatedly. */
export function unlockAudio(): Promise<void> {
  if (loading) return loading
  loading = import('howler').then(({ Howl }) => {
    howls = Object.fromEntries(
      (Object.keys(SFX) as SfxKey[]).map((k) => {
        const c = SFX[k]
        return [
          k,
          new Howl({
            src: [...c.src],
            volume: c.volume,
            loop: 'loop' in c ? c.loop : false,
            mute: muted,
            preload: true,
          }),
        ]
      }),
    ) as typeof howls
  })
  return loading
}

export function play(key: SfxKey, rate = 1): void {
  if (muted) return
  const h = howls[key]
  if (!h) return
  const id = h.play()
  if (rate !== 1) h.rate(rate, id)
}

let loopId: number | null = null
export function startScratchLoop(): void {
  const h = howls.scratchLoop
  if (!h || muted || loopId !== null) return
  loopId = h.play()
  h.fade(0, SFX.scratchLoop.volume, 60, loopId)
}
export function stopScratchLoop(): void {
  const h = howls.scratchLoop
  if (!h || loopId === null) return
  const id = loopId
  loopId = null
  h.fade(h.volume(id) as number, 0, 120, id)
  setTimeout(() => h.stop(id), 130)
}
