'use client'

/**
 * Gyroscope tilt. iOS requires DeviceOrientationEvent.requestPermission() from a user gesture, so it is
 * requested from the "LET'S SCRATCH" CTA — never from the scratch surface itself.
 */
let enabled = false

export function motionEnabled(): boolean {
  return enabled
}

export async function enableMotion(): Promise<void> {
  if (enabled || typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> }
  try {
    if (typeof D.requestPermission === 'function') enabled = (await D.requestPermission()) === 'granted'
    else enabled = true
  } catch {
    enabled = false
  }
}
