/**
 * Pooled foil-flake particles on an overlay canvas. The rAF loop only runs while flakes are alive, so an idle
 * tray costs nothing. Flakes are tiny rotated quads in foil colors that tumble and fall with gravity.
 */
interface Flake {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vr: number
  size: number
  life: number
  color: string
}

const COLORS = ['#e9e2f4', '#c9bddc', '#fbd53f', '#f919d7', '#ffffff', '#b3a7c9']
const MAX = 160

export class FlakeLayer {
  private readonly pool: Flake[] = []
  private readonly live: Flake[] = []
  private raf = 0
  private last = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly dpr: number,
  ) {}

  emit(x: number, y: number, n: number, burst = false): void {
    for (let i = 0; i < n && this.live.length < MAX; i++) {
      const f = this.pool.pop() ?? ({} as Flake)
      const angle = burst ? Math.random() * Math.PI * 2 : -Math.PI / 2 + (Math.random() - 0.5) * 1.6
      const speed = (burst ? 120 + Math.random() * 260 : 30 + Math.random() * 110) * this.dpr
      f.x = x
      f.y = y
      f.vx = Math.cos(angle) * speed
      f.vy = Math.sin(angle) * speed
      f.rot = Math.random() * Math.PI
      f.vr = (Math.random() - 0.5) * 14
      f.size = (2 + Math.random() * 4) * this.dpr
      f.life = 0.7 + Math.random() * 0.6
      f.color = COLORS[(Math.random() * COLORS.length) | 0]!
      this.live.push(f)
    }
    if (!this.raf) {
      this.last = performance.now()
      this.raf = requestAnimationFrame(this.step)
    }
  }

  private readonly step = (t: number) => {
    const dt = Math.min(0.05, (t - this.last) / 1000)
    this.last = t
    const g = this.canvas.getContext('2d')!
    g.clearRect(0, 0, this.canvas.width, this.canvas.height)
    for (let i = this.live.length - 1; i >= 0; i--) {
      const f = this.live[i]!
      f.life -= dt
      if (f.life <= 0 || f.y > this.canvas.height + 20) {
        this.live.splice(i, 1)
        this.pool.push(f)
        continue
      }
      f.vy += 900 * this.dpr * dt
      f.vx *= 0.985
      f.x += f.vx * dt
      f.y += f.vy * dt
      f.rot += f.vr * dt
      g.save()
      g.globalAlpha = Math.min(1, f.life * 1.6)
      g.translate(f.x, f.y)
      g.rotate(f.rot)
      g.fillStyle = f.color
      g.fillRect(-f.size / 2, -f.size / 4, f.size, f.size / 2)
      g.restore()
    }
    this.raf = this.live.length ? requestAnimationFrame(this.step) : 0
    if (!this.raf) g.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.live.length = 0
  }
}
