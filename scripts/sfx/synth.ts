/**
 * Placeholder sound pack — synthesized from scratch in code (no samples, nothing copyrighted), so the site
 * has every cue it needs until Sammy's recorded pack replaces it.
 *
 *   pnpm sfx   → apps/web/public/sfx/<cue>.wav   (mono 16-bit 32 kHz)
 *
 * The cue list below is the contract with apps/web/lib/sfx/manifest.ts — swap any file in public/sfx
 * (same name, or update the manifest's `src`) and nothing else changes. See docs/SFX.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const RATE = 32_000
const out = resolve(import.meta.dirname, '../../apps/web/public/sfx')
mkdirSync(out, { recursive: true })

type Buf = Float32Array
const buf = (seconds: number): Buf => new Float32Array(Math.round(seconds * RATE))
const TAU = Math.PI * 2
let seed = 1337
const rand = () => {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff
  return seed / 0x7fffffff
}

/** additive "bell": fundamental + inharmonic partials with exponential decay */
function bell(b: Buf, at: number, freq: number, dur: number, gain: number, bright = 1): void {
  const start = Math.round(at * RATE)
  const n = Math.min(b.length - start, Math.round(dur * RATE))
  const partials = [
    [1, 1],
    [2.01, 0.45 * bright],
    [3.02, 0.22 * bright],
    [4.17, 0.12 * bright],
    [5.43, 0.06 * bright],
  ] as const
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const attack = Math.min(1, t / 0.004)
    let v = 0
    for (const [mult, amp] of partials)
      v += amp * Math.sin(TAU * freq * mult * t) * Math.exp((-t * (3 + mult * 1.6)) / dur)
    b[start + i]! += gain * attack * v
  }
}

/** soft square-ish synth voice for fanfares */
function voice(b: Buf, at: number, freq: number, dur: number, gain: number): void {
  const start = Math.round(at * RATE)
  const n = Math.min(b.length - start, Math.round(dur * RATE))
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const env = Math.min(1, t / 0.01) * Math.min(1, (dur - t) / 0.08)
    const vib = 1 + 0.004 * Math.sin(TAU * 5.5 * t)
    let v = 0
    for (let h = 1; h <= 7; h += 2) v += Math.sin(TAU * freq * vib * h * t) / h
    b[start + i]! += gain * env * v * 0.6
  }
}

function noise(b: Buf, at: number, dur: number, gain: number, shape: (t: number) => number, lp = 0.3): void {
  const start = Math.round(at * RATE)
  const n = Math.min(b.length - start, Math.round(dur * RATE))
  let y = 0
  for (let i = 0; i < n; i++) {
    y += lp * (rand() * 2 - 1 - y) // one-pole low-pass
    b[start + i]! += gain * shape(i / RATE) * y
  }
}

function sweep(b: Buf, at: number, f0: number, f1: number, dur: number, gain: number): void {
  const start = Math.round(at * RATE)
  const n = Math.min(b.length - start, Math.round(dur * RATE))
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const f = f0 * Math.pow(f1 / f0, t / dur)
    phase += (TAU * f) / RATE
    b[start + i]! += gain * Math.sin(phase) * Math.sin((Math.PI * t) / dur)
  }
}

function normalize(b: Buf, peak = 0.89): Buf {
  let m = 0
  for (const v of b) m = Math.max(m, Math.abs(v))
  if (m > 0) for (let i = 0; i < b.length; i++) b[i] = (b[i]! / m) * peak
  // 3 ms fades so nothing clicks
  const f = Math.round(0.003 * RATE)
  for (let i = 0; i < f; i++) {
    b[i]! *= i / f
    b[b.length - 1 - i]! *= i / f
  }
  return b
}

function wav(name: string, b: Buf): void {
  const data = Buffer.alloc(b.length * 2)
  for (let i = 0; i < b.length; i++)
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, b[i]!)) * 32_767), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(resolve(out, `${name}.wav`), Buffer.concat([h, data]))
  console.log(`  ${name}.wav  ${(b.length / RATE).toFixed(2)}s`)
}

const note = (semitonesFromA4: number) => 440 * Math.pow(2, semitonesFromA4 / 12)
const C5 = 3,
  E5 = 7,
  G5 = 10,
  C6 = 15,
  E6 = 19,
  G6 = 22,
  C7 = 27

// scratch loop: gritty band-limited noise with a scrubbing wobble — seamless 1.2 s loop
{
  const b = buf(1.2)
  noise(b, 0, 1.2, 0.8, (t) => 0.55 + 0.45 * Math.abs(Math.sin(TAU * 7.5 * t)), 0.55)
  wav('scratch-loop', normalize(b, 0.5))
}
// win stingers, escalating with the tier
const WIN_ARPS: number[][] = [
  [C6, E6],
  [C5, E5, G5, C6],
  [C5, E5, G5, C6, E6, G6],
  [C5, G5, C6, E6, G6, C7, E6, C7],
  [C5, E5, G5, C6, E6, G6, C7, G6, C7, E6, C7],
]
WIN_ARPS.forEach((arp, i) => {
  const step = 0.085 - i * 0.008
  const tail = 0.6 + i * 0.25
  const b = buf(arp.length * step + tail)
  arp.forEach((n, k) => bell(b, k * step, note(n), tail, 0.9, 0.8 + i * 0.1))
  if (i >= 2) noise(b, 0, arp.length * step + tail * 0.6, 0.12 + i * 0.03, (t) => Math.exp(-t * 3), 0.9)
  if (i >= 3) bell(b, arp.length * step, note(C7 + 12), tail, 0.5, 1.2)
  wav(`win-${i + 1}`, normalize(b))
})
// jackpot fanfare: brass-ish arpeggio → sustained major chord → sparkles
{
  const b = buf(3.4)
  ;[C5, E5, G5, C6].forEach((n, k) => voice(b, k * 0.13, note(n), 0.4, 0.5))
  ;[C5, E5, G5, C6, E6].forEach((n) => voice(b, 0.6, note(n), 2.4, 0.35))
  for (let k = 0; k < 18; k++) bell(b, 0.7 + k * 0.13, note(C6 + ((k * 7) % 24)), 0.7, 0.25, 1.4)
  noise(b, 0.6, 2.6, 0.12, (t) => Math.exp(-t * 1.2), 0.95)
  wav('jackpot', normalize(b))
}
// loss: gentle two-note "aww" that still feels fun
{
  const b = buf(0.8)
  bell(b, 0, note(G5), 0.5, 0.7, 0.5)
  bell(b, 0.16, note(E5 - 1), 0.6, 0.6, 0.5)
  wav('lose', normalize(b, 0.7))
}
// card flip whoosh
{
  const b = buf(0.35)
  noise(b, 0, 0.35, 1, (t) => Math.sin((Math.PI * t) / 0.35), 0.25)
  wav('flip', normalize(b, 0.6))
}
// new tickets dropped
{
  const b = buf(1.1)
  bell(b, 0, note(E6), 0.8, 0.8, 1)
  bell(b, 0.12, note(G6), 0.8, 0.8, 1)
  bell(b, 0.24, note(C7), 0.9, 0.9, 1.1)
  sweep(b, 0, 300, 1_600, 0.3, 0.25)
  wav('drop', normalize(b))
}
// ui tick
{
  const b = buf(0.06)
  bell(b, 0, note(C7), 0.06, 1, 0.3)
  wav('click', normalize(b, 0.5))
}
// siren for TIER-MAX / jackpot takeovers
{
  const b = buf(2)
  for (let k = 0; k < 4; k++) sweep(b, k * 0.5, 700, 1_300, 0.5, 0.6)
  wav('siren', normalize(b, 0.7))
}
console.log(`placeholder sfx written to ${out}`)
