'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fmtPump, fmtUsd } from '@/lib/money'
import { startScratchLoop, stopScratchLoop } from '@/lib/sfx/sound'
import type { TicketOutcome } from '@/lib/types'
import { brush, Coverage, foilTexture } from './foil'
import { FlakeLayer } from './particles'
import { SlotSymbol } from './Symbols'
import { motionEnabled } from './motion'

/**
 * THE product (PLAN §6): a 2.5D scratch ticket.
 *  - DOM card with CSS 3D tilt (pointer / gyroscope), holographic sheen, rarity frame that ignites ON REVEAL
 *  - DPR-aware foil <canvas> erased with a soft brush (destination-out); coverage on a coarse grid;
 *    auto-completes at 60 %; pooled foil flakes fall off as you scratch
 *  - the outcome is requested on first touch (never before); until it arrives scratching pauses at 25 %
 *  - hot paths use refs + requestAnimationFrame only — no React renders while scratching
 */

export interface ScratchTicketProps {
  label: string
  outcome: TicketOutcome | null
  /** already revealed earlier: render without foil */
  revealed?: boolean
  /** programmatic wipe (SCRATCH ALL / keyboard reveal) */
  auto?: boolean
  pumpUsdE18?: string | null
  practice?: boolean
  /** first touch: ask the server to reveal */
  onStart?: () => void
  /** foil fully cleared */
  onRevealed?: () => void
}

/** only the last specks auto-clear: the player scratches the ticket themselves (playtest feedback) */
const AUTO_COMPLETE = 0.95
const HOLD_WITHOUT_OUTCOME = 0.25
const MAX_DPR = 2

export function ScratchTicket(p: ScratchTicketProps) {
  const [phase, setPhase] = useState<'foil' | 'clearing' | 'done'>(p.revealed ? 'done' : 'foil')
  const [waiting, setWaiting] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const foilRef = useRef<HTMLCanvasElement>(null)
  const flakeRef = useRef<HTMLCanvasElement>(null)
  const st = useRef({
    started: false,
    drawing: false,
    last: null as { x: number; y: number } | null,
    queue: [] as { x: number; y: number }[],
    raf: 0,
    stamps: 0,
    dpr: 1,
    radius: 22,
    coverage: null as Coverage | null,
    flakes: null as FlakeLayer | null,
    areaOffset: { x: 0, y: 0 },
    completing: false,
    tilt: { rx: 0, ry: 0, raf: 0 },
  })
  const outcomeRef = useRef<TicketOutcome | null>(p.outcome)
  const propsRef = useRef(p)
  useEffect(() => {
    propsRef.current = p
  })

  // ── canvas setup ─────────────────────────────────────────────────────────
  const setup = useCallback(() => {
    const area = areaRef.current
    const foil = foilRef.current
    const flakes = flakeRef.current
    const card = cardRef.current
    if (!area || !foil || !flakes || !card) return
    const s = st.current
    if (s.started) return // never wipe progress on resize; CSS scales the canvas
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    const rect = area.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    foil.width = w
    foil.height = h
    const g = foil.getContext('2d')!
    g.globalCompositeOperation = 'source-over'
    g.drawImage(foilTexture(w, h, dpr), 0, 0)
    s.dpr = dpr
    s.radius = Math.max(12, Math.min(22, rect.width / 16)) * dpr
    s.coverage = new Coverage(48, 28, w, h)
    const cr = card.getBoundingClientRect()
    flakes.width = Math.round(cr.width * dpr)
    flakes.height = Math.round((cr.height + 80) * dpr)
    s.areaOffset = { x: (rect.left - cr.left) * dpr, y: (rect.top - cr.top) * dpr }
    s.flakes?.dispose()
    s.flakes = new FlakeLayer(flakes, dpr)
  }, [])

  useLayoutEffect(() => {
    if (phase === 'done') return
    setup()
    const ro = new ResizeObserver(() => setup())
    if (areaRef.current) ro.observe(areaRef.current)
    return () => ro.disconnect()
  }, [phase, setup])

  useEffect(() => {
    const s = st.current
    const canvases = [foilRef.current, flakeRef.current]
    return () => {
      cancelAnimationFrame(s.raf)
      cancelAnimationFrame(s.tilt.raf)
      s.flakes?.dispose()
      if (s.drawing) stopScratchLoop()
      // release canvas memory right away (mobile Safari keeps it otherwise)
      for (const c of canvases) {
        if (c) {
          c.width = 0
          c.height = 0
        }
      }
    }
  }, [])

  // ── completion ───────────────────────────────────────────────────────────
  const complete = useCallback(() => {
    const s = st.current
    if (s.completing) return
    s.completing = true
    s.drawing = false
    stopScratchLoop()
    setPhase('clearing')
    const foil = foilRef.current
    if (foil && s.flakes) {
      for (let i = 0; i < 5; i++) {
        s.flakes.emit(
          s.areaOffset.x + Math.random() * foil.width,
          s.areaOffset.y + Math.random() * foil.height,
          10,
          true,
        )
      }
    }
    setTimeout(() => {
      setPhase('done')
      propsRef.current.onRevealed?.()
    }, 380)
  }, [])

  const maybeComplete = useCallback(() => {
    const s = st.current
    if (!s.coverage || s.completing) return
    if (outcomeRef.current && s.coverage.ratio >= AUTO_COMPLETE) complete()
  }, [complete])

  // outcome arrives from the server
  useEffect(() => {
    outcomeRef.current = p.outcome
    if (p.outcome) maybeComplete()
  }, [p.outcome, maybeComplete])

  // ── drawing ──────────────────────────────────────────────────────────────
  const stamp = useCallback((x: number, y: number) => {
    const s = st.current
    const foil = foilRef.current
    if (!foil || !s.coverage) return false
    if (!outcomeRef.current && s.coverage.ratio >= HOLD_WITHOUT_OUTCOME) {
      setWaiting(true)
      return false
    }
    const g = foil.getContext('2d')!
    g.globalCompositeOperation = 'destination-out'
    const b = brush(s.radius)
    g.drawImage(b, x - s.radius, y - s.radius)
    s.coverage.mark(x, y, s.radius)
    if (++s.stamps % 3 === 0)
      s.flakes?.emit(s.areaOffset.x + x, s.areaOffset.y + y, 1 + ((Math.random() * 2) | 0))
    return true
  }, [])

  const pump = useCallback(() => {
    const s = st.current
    s.raf = 0
    const spacing = s.radius * 0.35
    while (s.queue.length) {
      const pt = s.queue.shift()!
      const from = s.last ?? pt
      const dx = pt.x - from.x
      const dy = pt.y - from.y
      const dist = Math.hypot(dx, dy)
      const steps = Math.max(1, Math.ceil(dist / spacing))
      for (let i = 1; i <= steps; i++) {
        if (!stamp(from.x + (dx * i) / steps, from.y + (dy * i) / steps)) {
          s.queue.length = 0
          break
        }
      }
      s.last = pt
    }
    maybeComplete()
  }, [stamp, maybeComplete])

  const enqueue = useCallback(
    (clientX: number, clientY: number) => {
      const foil = foilRef.current
      if (!foil) return
      const r = foil.getBoundingClientRect()
      const s = st.current
      s.queue.push({
        x: ((clientX - r.left) / r.width) * foil.width,
        y: ((clientY - r.top) / r.height) * foil.height,
      })
      if (!s.raf) s.raf = requestAnimationFrame(pump)
    },
    [pump],
  )

  const begin = useCallback(() => {
    const s = st.current
    if (!s.started) {
      s.started = true
      propsRef.current.onStart?.()
    }
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (phase !== 'foil') return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const s = st.current
    s.drawing = true
    s.last = null
    begin()
    startScratchLoop()
    enqueue(e.clientX, e.clientY)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!st.current.drawing) return
    const events =
      typeof e.nativeEvent.getCoalescedEvents === 'function'
        ? e.nativeEvent.getCoalescedEvents()
        : [e.nativeEvent]
    for (const ev of events.length ? events : [e.nativeEvent]) enqueue(ev.clientX, ev.clientY)
  }
  const onPointerUp = () => {
    const s = st.current
    if (!s.drawing) return
    s.drawing = false
    s.last = null
    stopScratchLoop()
  }

  // ── programmatic wipe (SCRATCH ALL / keyboard) ───────────────────────────
  const autoWipe = useCallback(() => {
    const foil = foilRef.current
    const s = st.current
    if (!foil || s.completing) return
    begin()
    const w = foil.width
    const h = foil.height
    const rows = Math.max(3, Math.round(h / (s.radius * 1.4)))
    const pts: { x: number; y: number }[] = []
    for (let r = 0; r <= rows; r++) {
      const y = (r / rows) * h
      pts.push(r % 2 ? { x: w, y } : { x: 0, y })
      pts.push(r % 2 ? { x: 0, y } : { x: w, y })
    }
    const t0 = performance.now()
    const dur = 420
    let idx = 0
    const tick = (t: number) => {
      const target = Math.min(pts.length, Math.ceil(((t - t0) / dur) * pts.length))
      for (; idx < target; idx++) s.queue.push(pts[idx]!)
      pump()
      if (idx < pts.length || !outcomeRef.current) {
        if (idx >= pts.length && !outcomeRef.current) setWaiting(true)
        s.raf = requestAnimationFrame(tick)
      } else complete()
    }
    s.last = null
    s.raf = requestAnimationFrame(tick)
  }, [begin, complete, pump])

  useEffect(() => {
    if (p.auto && phase === 'foil') autoWipe()
  }, [p.auto, phase, autoWipe])

  // ── tilt (pointer + gyro) ────────────────────────────────────────────────
  useEffect(() => {
    const card = cardRef.current
    if (!card || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const s = st.current
    const apply = () => {
      s.tilt.raf = 0
      card.style.setProperty('--rx', `${s.tilt.rx.toFixed(2)}deg`)
      card.style.setProperty('--ry', `${s.tilt.ry.toFixed(2)}deg`)
      card.style.setProperty('--sheen', `${50 + s.tilt.ry * 4}%`)
    }
    const set = (rx: number, ry: number) => {
      const damp = s.drawing ? 0.3 : 1
      s.tilt.rx = rx * damp
      s.tilt.ry = ry * damp
      if (!s.tilt.raf) s.tilt.raf = requestAnimationFrame(apply)
    }
    const onMove = (e: PointerEvent) => {
      const r = card.getBoundingClientRect()
      set(((e.clientY - r.top) / r.height - 0.5) * -12, ((e.clientX - r.left) / r.width - 0.5) * 14)
    }
    const onLeave = () => set(0, 0)
    const onOrient = (e: DeviceOrientationEvent) => {
      if (!motionEnabled() || e.beta === null || e.gamma === null) return
      set(Math.max(-9, Math.min(9, (e.beta - 40) * -0.25)), Math.max(-10, Math.min(10, e.gamma * 0.3)))
    }
    card.addEventListener('pointermove', onMove)
    card.addEventListener('pointerleave', onLeave)
    window.addEventListener('deviceorientation', onOrient)
    return () => {
      card.removeEventListener('pointermove', onMove)
      card.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('deviceorientation', onOrient)
    }
  }, [])

  // ── render ───────────────────────────────────────────────────────────────
  const o = p.outcome
  const revealedNow = phase !== 'foil'
  const took = o ? BigInt(o.jackpotPrizeRaw) > 0n : false
  const frameTier = revealedNow && o ? (took ? 'jackpot' : String(o.tier)) : 'none'
  const win = !!o && (o.tier > 0 || took)

  return (
    <div className="ticket-wrap" data-practice={p.practice ? 'true' : undefined}>
      <div ref={cardRef} className="ticket" data-tier={frameTier} data-phase={phase}>
        <div className="ticket-rays" aria-hidden />
        <div className="ticket-inner">
          <header className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
            <div className="flex items-center gap-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/mascot-head.png"
                alt=""
                width={26}
                height={26}
                className="rounded-full"
                draggable={false}
              />
              <span className="foil-text font-display text-lg leading-none tracking-wide">$SCRATCHY</span>
            </div>
            <span className="font-display text-xs text-muted tracking-wider">
              {p.practice ? 'PRACTICE' : p.label}
            </span>
          </header>

          <div ref={areaRef} className="scratch-area">
            <div className="reveal-layer">
              <div className="flex items-center justify-center gap-2 sm:gap-3">
                {(o?.symbols ?? (['star', 'star', 'star'] as const)).map((sym, i) => (
                  <div
                    key={i}
                    className={`slot ${revealedNow && o ? 'slot-pop' : ''} ${!o ? 'slot-unknown' : ''}`}
                    style={{ animationDelay: `${i * 90}ms` }}
                  >
                    {o ? (
                      <SlotSymbol symbol={sym} size={56} />
                    ) : (
                      <span className="font-display text-4xl text-muted/60">?</span>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-2 min-h-[2.4rem] text-center">
                {o && took ? (
                  <p className="font-display text-xl text-gold drop-shadow">
                    JACKPOT · {fmtPump(o.jackpotPrizeRaw)} PUMP
                  </p>
                ) : o && o.tier > 0 && p.practice ? (
                  <>
                    <p className="font-display text-xl text-gold leading-tight">3 IN A ROW!</p>
                    <p className="text-xs text-muted">practice only — real tickets pay in PUMP</p>
                  </>
                ) : o && o.tier > 0 ? (
                  <>
                    <p className="font-display text-xl text-gold leading-tight">{fmtPump(o.prizeRaw)} PUMP</p>
                    <p className="text-xs text-muted">{fmtUsd(o.prizeRaw, p.pumpUsdE18)}</p>
                  </>
                ) : o ? (
                  <p className="font-display text-base tracking-wide text-muted">NOT THIS ONE</p>
                ) : null}
              </div>
            </div>
            {phase !== 'done' && (
              <canvas
                ref={foilRef}
                className={`foil-canvas ${phase === 'clearing' ? 'foil-clearing' : ''}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                aria-label="Scratch the foil to reveal your ticket"
              />
            )}
            {waiting && !p.outcome && phase === 'foil' && (
              <div className="waiting-shimmer" aria-live="polite">
                revealing…
              </div>
            )}
          </div>

          <footer className="flex items-center justify-between px-3 pt-1.5 pb-2 text-[10px] uppercase tracking-[0.14em] text-muted">
            <span>Match 3 to win</span>
            <span>paid instantly in $PUMP</span>
          </footer>
        </div>
        <div className="holo-sheen" aria-hidden />
        {win && phase === 'done' && <div className="win-glow" aria-hidden />}
      </div>
      <canvas ref={flakeRef} className="flake-canvas" aria-hidden />
      {phase === 'foil' && (
        <button
          type="button"
          className="sr-only focus:not-sr-only focus:absolute focus:bottom-2 focus:left-1/2 focus:-translate-x-1/2 btn-ghost"
          onClick={autoWipe}
        >
          Reveal ticket
        </button>
      )}
    </div>
  )
}
