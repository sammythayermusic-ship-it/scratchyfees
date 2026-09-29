'use client'

import { useSyncExternalStore } from 'react'
import { isMuted, onMuteChange, setMuted, unlockAudio } from '@/lib/sfx/sound'

/** Mute toggle — persists in localStorage (PLAN §6). */
export function SoundToggle() {
  const muted = useSyncExternalStore(onMuteChange, isMuted, () => false)
  return (
    <button
      type="button"
      className="btn-ghost text-sm"
      aria-pressed={!muted}
      aria-label={muted ? 'Unmute sound' : 'Mute sound'}
      onClick={() => {
        void unlockAudio()
        setMuted(!muted)
      }}
    >
      {muted ? '🔇' : '🔊'}
    </button>
  )
}
