# Sound effects — the swap-in point

Every sound the site plays is declared in one file:
**[`apps/web/lib/sfx/manifest.ts`](../apps/web/lib/sfx/manifest.ts)**. Nothing else in the codebase names a
sound file. The placeholders currently shipped in `apps/web/public/sfx/` are synthesized from scratch by
code (`pnpm sfx` → [`scripts/sfx/synth.ts`](../scripts/sfx/synth.ts)); they contain no samples and nothing
copyrighted.

## Cue list

| Key           | File (placeholder)     | When it plays                                                   | Length / feel                   |
| ------------- | ---------------------- | --------------------------------------------------------------- | ------------------------------- |
| `scratchLoop` | `sfx/scratch-loop.wav` | while a finger/mouse is scratching foil (looped, stops on lift) | seamless loop, ~1.2 s, gritty   |
| `win1`        | `sfx/win-1.wav`        | tier 1 win (smallest)                                           | short sparkle                   |
| `win2`        | `sfx/win-2.wav`        | tier 2 win                                                      | 4-note arpeggio                 |
| `win3`        | `sfx/win-3.wav`        | tier 3 win                                                      | bigger arpeggio + shimmer       |
| `win4`        | `sfx/win-4.wav`        | tier 4 win                                                      | fanfare-ish                     |
| `win5`        | `sfx/win-5.wav`        | TIER-MAX win (plays with `siren`)                               | biggest non-jackpot stinger     |
| `jackpot`     | `sfx/jackpot.wav`      | progressive jackpot takeover (own screen + global banner)       | ~3.4 s brass fanfare + sparkles |
| `siren`       | `sfx/siren.wav`        | TIER-MAX and jackpot takeovers                                  | ~2 s rising siren               |
| `lose`        | `sfx/lose.wav`         | a losing reveal ("not this one")                                | gentle two-note "aww"           |
| `flip`        | `sfx/flip.wav`         | SCRATCH ALL / card flip                                         | whoosh                          |
| `drop`        | `sfx/drop.wav`         | new tickets dropped (round start)                               | chime                           |
| `click`       | `sfx/click.wav`        | UI ticks                                                        | tiny tick                       |

`winCue(tier)` in the manifest maps a tier (1–5) to `win1`…`win5`.

## Replacing the placeholders with the real pack

1. **Same names:** drop your files into `apps/web/public/sfx/` with the names above. Done — no code change.
2. **Different names or formats:** edit `src` for that key in `manifest.ts`. `src` is a list, so you can give
   fallbacks, for example `src: ['/sfx/jackpot.webm', '/sfx/jackpot.mp3']`. howler picks the first format
   the browser supports. Prefer `.webm` (Opus) + `.mp3` for size; WAV works everywhere but is large.
3. **Levels:** `volume` (0–1) is a per-cue trim, so mix there rather than re-exporting files.
4. **Loop:** only `scratchLoop` loops. It should be seamless (no click at the loop point) and ≤ 2 s.
5. Keep the jackpot fanfare ≤ ~4 s and the win stingers ≤ ~2 s so SCRATCH ALL summaries don't pile up.

## Behaviour you get for free

- **Autoplay rules:** sounds load lazily on the first user gesture (browsers block audio before one).
- **Mute:** the speaker toggle in the header persists in `localStorage` (`scratchy.muted`) per browser.
- **Reduced motion** doesn't mute sound. That's a separate user choice.
- To regenerate the placeholders (e.g. after deleting them): `pnpm sfx`.
