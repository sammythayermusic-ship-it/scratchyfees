/**
 * Foil texture + soft brush for the scratch layer. Everything here is pre-rendered ONCE per size into
 * offscreen canvases and reused by every ticket, so a scratch stroke is just drawImage calls (60 fps on
 * phones). Coverage is tracked on a coarse grid instead of reading pixels back.
 */

const textureCache = new Map<string, HTMLCanvasElement>()
const brushCache = new Map<number, HTMLCanvasElement>()

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/** Metallic lilac-silver foil with brushed grain, embossed $ pattern and a faint holo tint. */
export function foilTexture(w: number, h: number, dpr: number): HTMLCanvasElement {
  const key = `${w}x${h}`
  const hit = textureCache.get(key)
  if (hit) return hit
  const c = canvas(w, h)
  const g = c.getContext('2d')!
  const base = g.createLinearGradient(0, 0, w, h)
  base.addColorStop(0, '#bdb2d1')
  base.addColorStop(0.28, '#f3eef9')
  base.addColorStop(0.5, '#a99cc2')
  base.addColorStop(0.72, '#ece5f6')
  base.addColorStop(1, '#b3a7c9')
  g.fillStyle = base
  g.fillRect(0, 0, w, h)

  // grain: deterministic speckle noise
  const img = g.getImageData(0, 0, w, h)
  let s = 1_234_567
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 16_807) % 2_147_483_647
    const n = (s / 2_147_483_647 - 0.5) * 34
    img.data[i] = Math.max(0, Math.min(255, img.data[i]! + n))
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1]! + n))
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2]! + n))
  }
  g.putImageData(img, 0, 0)

  // brushed lines
  g.globalAlpha = 0.07
  for (let y = 0; y < h; y += 2 * dpr) {
    g.strokeStyle = y % (6 * dpr) === 0 ? '#ffffff' : '#6d5f86'
    g.lineWidth = dpr
    g.beginPath()
    g.moveTo(0, y)
    g.lineTo(w, y + (y % 7))
    g.stroke()
  }

  // embossed $ pattern
  g.globalAlpha = 0.16
  g.font = `900 ${14 * dpr}px Nunito, system-ui, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const step = 34 * dpr
  for (let y = step / 2; y < h; y += step) {
    for (let x = (y / step) % 2 ? step / 2 : step; x < w; x += step) {
      g.fillStyle = '#ffffff'
      g.fillText('$', x - dpr, y - dpr)
      g.fillStyle = '#56466f'
      g.fillText('$', x + dpr, y + dpr)
    }
  }

  // "SCRATCH HERE" plate
  g.globalAlpha = 1
  const fs = Math.min(26 * dpr, w / 9)
  g.font = `400 ${fs}px "Lilita One", "Arial Black", system-ui, sans-serif`
  g.fillStyle = 'rgba(255,255,255,0.75)'
  g.fillText('SCRATCH HERE', w / 2 - dpr, h / 2 - dpr)
  g.fillStyle = 'rgba(70,52,98,0.55)'
  g.fillText('SCRATCH HERE', w / 2 + dpr, h / 2 + dpr)
  g.fillStyle = 'rgba(214,204,232,0.95)'
  g.fillText('SCRATCH HERE', w / 2, h / 2)

  // holographic tint
  g.globalCompositeOperation = 'overlay'
  const holo = g.createLinearGradient(0, h, w, 0)
  holo.addColorStop(0, 'rgba(252,4,168,0.22)')
  holo.addColorStop(0.35, 'rgba(90,220,255,0.14)')
  holo.addColorStop(0.65, 'rgba(251,213,63,0.2)')
  holo.addColorStop(1, 'rgba(160,1,159,0.22)')
  g.fillStyle = holo
  g.fillRect(0, 0, w, h)
  g.globalCompositeOperation = 'source-over'

  if (textureCache.size > 6) textureCache.clear()
  textureCache.set(key, c)
  return c
}

/** Soft round brush: solid core, feathered edge (drawn with destination-out to erase foil). */
export function brush(radius: number): HTMLCanvasElement {
  const r = Math.max(2, Math.round(radius))
  const hit = brushCache.get(r)
  if (hit) return hit
  const c = canvas(r * 2, r * 2)
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(r, r, 0, r, r, r)
  grad.addColorStop(0, 'rgba(0,0,0,1)')
  grad.addColorStop(0.62, 'rgba(0,0,0,1)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, r * 2, r * 2)
  brushCache.set(r, c)
  return c
}

/** Coarse coverage grid (cells × cells) — cheap "how much is scratched" without getImageData. */
export class Coverage {
  private readonly hit: Uint8Array
  private count = 0

  constructor(
    private readonly cols: number,
    private readonly rows: number,
    private readonly w: number,
    private readonly h: number,
  ) {
    this.hit = new Uint8Array(cols * rows)
  }

  mark(x: number, y: number, r: number): void {
    const cw = this.w / this.cols
    const ch = this.h / this.rows
    const c0 = Math.max(0, Math.floor((x - r) / cw))
    const c1 = Math.min(this.cols - 1, Math.floor((x + r) / cw))
    const r0 = Math.max(0, Math.floor((y - r) / ch))
    const r1 = Math.min(this.rows - 1, Math.floor((y + r) / ch))
    const rr = r * r * 0.8
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const i = row * this.cols + col
        if (this.hit[i]) continue
        const dx = (col + 0.5) * cw - x
        const dy = (row + 0.5) * ch - y
        if (dx * dx + dy * dy <= rr) {
          this.hit[i] = 1
          this.count++
        }
      }
    }
  }

  get ratio(): number {
    return this.count / this.hit.length
  }
}
