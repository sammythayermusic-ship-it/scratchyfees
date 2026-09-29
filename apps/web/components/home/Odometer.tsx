'use client'

/** Odometer-style rolling digits (PLAN §6 pool counter). Pure CSS transforms — no re-layout per frame. */
/**
 * `glyphClassName` styles each glyph individually — needed for gradient (background-clip: text) fills, which
 * cannot paint through the transformed digit columns from a parent element.
 */
export function Odometer({
  value,
  className = '',
  glyphClassName = '',
}: {
  value: string
  className?: string
  glyphClassName?: string
}) {
  return (
    <span className={`inline-flex overflow-hidden leading-none tabular-nums ${className}`} aria-label={value}>
      {value.split('').map((ch, i) =>
        /\d/.test(ch) ? (
          <span
            key={`${i}-${value.length}`}
            className="relative inline-block h-[1em] w-[0.62em] overflow-hidden"
            aria-hidden
          >
            <span
              className="absolute left-0 top-0 flex flex-col transition-transform duration-[900ms] ease-[cubic-bezier(0.2,0.9,0.2,1)]"
              style={{ transform: `translateY(-${Number(ch)}em)` }}
            >
              {Array.from({ length: 10 }, (_, d) => (
                <span key={d} className={`h-[1em] ${glyphClassName}`}>
                  {d}
                </span>
              ))}
            </span>
          </span>
        ) : (
          <span key={`${i}-${value.length}`} className={glyphClassName} aria-hidden>
            {ch}
          </span>
        ),
      )}
    </span>
  )
}
