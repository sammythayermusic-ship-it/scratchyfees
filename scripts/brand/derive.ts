/**
 * Derive web-ready crops from the OFFICIAL brand art in assets/brand/ (never modified, never regenerated).
 *
 *   pnpm brand   → apps/web/public/brand/*  +  apps/web/app/{icon,apple-icon}.png
 *
 * - mascot-cutout.png   transparent background: flood-fill of the pure-black backdrop from the edges,
 *                       then the dark outline that the fill ate is restored as a clean stroke
 * - mascot-sticker.png  cutout + dark outline + gold rim (win-modal sticker)
 * - mascot-head.png     head-only crop of the cutout (favicons, loading states)
 * - banner-hero.webp    full banner for the hero; og.jpg 1200×630 cover crop for link previews
 * - x-banner.webp       the 1500×500 X banner (web-sized)
 * - palette.json        dominant colours sampled from the art (documents where the site palette came from)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'

const root = resolve(import.meta.dirname, '../..')
const src = (f: string) => resolve(root, 'assets/brand', f)
const outDir = resolve(root, 'apps/web/public/brand')
const appDir = resolve(root, 'apps/web/app')
mkdirSync(outDir, { recursive: true })

const MASCOT = src('scratchy-mascot-swagger.png')
const BANNER = src('scratchy-banner-full.png')
const XBANNER = src('scratchy-x-banner-1500x500.png')
const PFP = src('scratchy-mascot-swagger-pfp-400.png')

const OUTLINE = { r: 0x0e, g: 0x01, b: 0x1d } // stage colour — reads as the art's black outline
const GOLD = { r: 0xfb, g: 0xd5, b: 0x3f }

/** Flood-fill near-black pixels connected to the image border → background mask (1 = background). */
function backgroundMask(data: Buffer, w: number, h: number, channels: number, threshold = 40): Uint8Array {
  const bg = new Uint8Array(w * h)
  const queue = new Int32Array(w * h)
  let head = 0
  let tail = 0
  const dark = (i: number) => {
    const o = i * channels
    return Math.max(data[o]!, data[o + 1]!, data[o + 2]!) < threshold
  }
  const push = (i: number) => {
    if (!bg[i] && dark(i)) {
      bg[i] = 1
      queue[tail++] = i
    }
  }
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }
  while (head < tail) {
    const i = queue[head++]!
    const x = i % w
    const y = (i / w) | 0
    if (x > 0) push(i - 1)
    if (x < w - 1) push(i + 1)
    if (y > 0) push(i - w)
    if (y < h - 1) push(i + w)
  }
  return bg
}

/** Grow a single-channel 0/255 mask by ~radius px (blur + threshold). */
async function dilate(mask: Buffer, w: number, h: number, radius: number): Promise<Buffer> {
  return sharp(mask, { raw: { width: w, height: h, channels: 1 } })
    .blur(Math.max(0.3, radius / 2))
    .threshold(8)
    .extractChannel(0)
    .raw()
    .toBuffer()
}

function solid(w: number, h: number, c: { r: number; g: number; b: number }, alpha: Buffer): Buffer {
  const out = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = c.r
    out[i * 4 + 1] = c.g
    out[i * 4 + 2] = c.b
    out[i * 4 + 3] = alpha[i]!
  }
  return out
}

async function mascot() {
  const img = sharp(MASCOT).ensureAlpha()
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels } = info
  const bg = backgroundMask(data, w, h, channels)

  // Foreground alpha, softened by 1px so edges anti-alias.
  const fg = Buffer.alloc(w * h)
  for (let i = 0; i < w * h; i++) fg[i] = bg[i] ? 0 : 255
  const fgSoft = await sharp(fg, { raw: { width: w, height: h, channels: 1 } })
    .blur(0.8)
    .extractChannel(0)
    .raw()
    .toBuffer()
  if (fgSoft.length !== w * h) throw new Error('alpha mask must be single-channel')

  const cut = Buffer.from(data)
  for (let i = 0; i < w * h; i++) cut[i * 4 + 3] = fgSoft[i]!

  // Restore the outline the flood-fill removed: a dark stroke under the character.
  const outlineMask = await dilate(fg, w, h, 14)
  const outlineLayer = solid(w, h, OUTLINE, outlineMask)
  const cutout = await sharp(outlineLayer, { raw: { width: w, height: h, channels: 4 } })
    .composite([{ input: cut, raw: { width: w, height: h, channels: 4 } }])
    .png()
    .toBuffer()
  await sharp(cutout)
    .resize(1024, 1024)
    .png({ compressionLevel: 9 })
    .toFile(resolve(outDir, 'mascot-cutout.png'))

  // Sticker: gold rim outside the dark outline.
  const rimMask = await dilate(outlineMask, w, h, 22)
  const rimLayer = solid(w, h, GOLD, rimMask)
  const sticker = await sharp(rimLayer, { raw: { width: w, height: h, channels: 4 } })
    .composite([{ input: cutout }])
    .png()
    .toBuffer()
  await sharp(sticker)
    .resize(768, 768)
    .png({ compressionLevel: 9 })
    .toFile(resolve(outDir, 'mascot-sticker.png'))

  // Head-only crop (sunglasses + grin), square.
  const head = { left: 590, top: 40, width: 1000, height: 1000 }
  const headPng = await sharp(cutout).extract(head).png().toBuffer()
  await sharp(headPng)
    .resize(512, 512)
    .png({ compressionLevel: 9 })
    .toFile(resolve(outDir, 'mascot-head.png'))

  // App icons: head on the brand stage colour, rounded like an app tile.
  const headSized = async (size: number) =>
    sharp(headPng)
      .resize(Math.round(size * 0.92))
      .png()
      .toBuffer()
  for (const [file, size] of [
    [resolve(appDir, 'icon.png'), 512],
    [resolve(appDir, 'apple-icon.png'), 180],
    [resolve(outDir, 'icon-192.png'), 192],
    [resolve(outDir, 'icon-512.png'), 512],
  ] as const) {
    await sharp({ create: { width: size, height: size, channels: 4, background: { ...OUTLINE, alpha: 1 } } })
      .composite([{ input: await headSized(size), gravity: 'center' }])
      .png()
      .toFile(file)
  }
}

async function banners() {
  await sharp(BANNER)
    .resize({ width: 1920 })
    .webp({ quality: 86 })
    .toFile(resolve(outDir, 'banner-hero.webp'))
  await sharp(BANNER)
    .resize({ width: 960 })
    .webp({ quality: 82 })
    .toFile(resolve(outDir, 'banner-hero-960.webp'))
  await sharp(BANNER)
    .resize({ width: 1200, height: 630, fit: 'cover', position: 'centre' })
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(resolve(outDir, 'og.jpg'))
  await sharp(XBANNER).webp({ quality: 86 }).toFile(resolve(outDir, 'x-banner.webp'))
  await sharp(PFP).png().toFile(resolve(outDir, 'mascot-pfp-400.png'))
}

async function palette() {
  const sample = async (file: string, region?: sharp.Region) => {
    let img = sharp(file)
    if (region) img = img.extract(region)
    const { dominant } = await img.stats()
    return `#${[dominant.r, dominant.g, dominant.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  }
  const out = {
    source: 'sampled from assets/brand/* by scripts/brand/derive.ts',
    mascotBody: await sample(MASCOT, { left: 700, top: 1000, width: 200, height: 200 }),
    mascotRays: await sample(MASCOT, { left: 1600, top: 900, width: 120, height: 120 }),
    bannerStage: await sample(BANNER, { left: 1100, top: 900, width: 400, height: 200 }),
    bannerWordmark: await sample(BANNER, { left: 1000, top: 480, width: 500, height: 200 }),
    tokens: {
      stage: '#0E011D',
      stage2: '#250144',
      pink: '#FC04A8',
      magenta: '#F919D7',
      ray: '#7E017C',
      electric: '#A0019F',
      plum: '#4E0268',
      gold: '#FBD53F',
      goldDeep: '#F9A723',
      goldHi: '#FDF771',
      goldShade: '#DF8D21',
    },
  }
  writeFileSync(resolve(outDir, 'palette.json'), JSON.stringify(out, null, 2) + '\n')
}

await mascot()
await banners()
await palette()
console.log(`brand crops written to ${outDir}`)
