import type { ReactNode } from 'react'

/** One question: a native <details> disclosure (works without JS; opens on /faq#id deep links). */
export function FaqItem({
  id,
  q,
  defaultOpen,
  children,
}: {
  id: string
  q: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <details id={id} open={defaultOpen} className="group panel scroll-mt-20">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-[1.25rem] px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-gold sm:px-5 [&::-webkit-details-marker]:hidden">
        <h3 className="font-display text-lg leading-snug text-ink sm:text-xl">{q}</h3>
        <span
          aria-hidden
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-stage/70 font-display text-xl leading-none text-gold ring-1 ring-gold/30 transition-transform duration-200 group-open:rotate-45 group-open:bg-pink group-open:text-ink"
        >
          +
        </span>
      </summary>
      <div className="flex flex-col gap-3 px-4 pb-5 text-[15px] leading-relaxed text-muted sm:px-5 [&_strong]:font-bold [&_strong]:text-ink">
        {children}
      </div>
    </details>
  )
}

/** A titled group of questions with an anchor for the section chips. */
export function FaqSection({
  id,
  title,
  kicker,
  children,
}: {
  id: string
  title: string
  kicker: string
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-20">
      <p className="text-[11px] uppercase tracking-[0.25em] text-magenta">{kicker}</p>
      <h2 id={`${id}-heading`} className="font-display mb-3 text-3xl text-ink sm:text-4xl">
        {title}
      </h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}

/** Inline link style used inside answers. */
export const FAQ_LINK = 'text-gold underline decoration-gold/40 underline-offset-2 hover:decoration-gold'
