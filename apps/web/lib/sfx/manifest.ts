/**
 * ─── THE SOUND SWAP-IN POINT ────────────────────────────────────────────────────────────────────────────
 * Every sound the site plays is listed here. Placeholders live in apps/web/public/sfx/ (synthesized by
 * `pnpm sfx`). To drop in the real pack: replace the files (same names), or point `src` at new files
 * (mp3/webm/ogg/wav — list several for format fallback). Volumes are per-cue trims (0–1).
 * Nothing else in the codebase references sound files directly. See docs/SFX.md.
 */
export const SFX = {
  scratchLoop: { src: ['/sfx/scratch-loop.wav'], volume: 0.35, loop: true },
  win1: { src: ['/sfx/win-1.wav'], volume: 0.7 },
  win2: { src: ['/sfx/win-2.wav'], volume: 0.75 },
  win3: { src: ['/sfx/win-3.wav'], volume: 0.8 },
  win4: { src: ['/sfx/win-4.wav'], volume: 0.85 },
  win5: { src: ['/sfx/win-5.wav'], volume: 0.9 },
  jackpot: { src: ['/sfx/jackpot.wav'], volume: 1 },
  siren: { src: ['/sfx/siren.wav'], volume: 0.55 },
  lose: { src: ['/sfx/lose.wav'], volume: 0.5 },
  flip: { src: ['/sfx/flip.wav'], volume: 0.45 },
  drop: { src: ['/sfx/drop.wav'], volume: 0.7 },
  click: { src: ['/sfx/click.wav'], volume: 0.4 },
} as const satisfies Record<string, { src: readonly string[]; volume: number; loop?: boolean }>

export type SfxKey = keyof typeof SFX

/** win stinger for a tier (1–5); the jackpot has its own fanfare */
export const winCue = (tier: number): SfxKey =>
  (['win1', 'win2', 'win3', 'win4', 'win5'] as const)[Math.min(Math.max(tier, 1), 5) - 1]!
