import Link from 'next/link'
import { SoundToggle } from './SoundToggle'

const NAV = [
  { href: '/', label: 'Play', desktopOnly: true }, // on phones the logo is the way home
  { href: '/winners', label: 'Winners' },
  { href: '/fair', label: 'Fair' },
  { href: '/faq', label: 'FAQ' },
]

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-magenta/15 bg-stage/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5">
        <Link href="/" className="flex items-center gap-2" aria-label="$SCRATCHY home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/mascot-head.png"
            alt=""
            width={36}
            height={36}
            className="rounded-full ring-2 ring-gold/70"
          />
          <span className="foil-text font-display hidden text-2xl leading-none min-[440px]:inline">
            $SCRATCHY
          </span>
        </Link>
        <nav className="flex min-w-0 items-center gap-0.5 text-sm sm:gap-2" aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded-full px-2.5 py-1.5 text-muted transition hover:bg-stage-3 hover:text-ink sm:px-3 ${'desktopOnly' in n ? 'hidden sm:inline' : ''}`}
            >
              {n.label}
            </Link>
          ))}
          <SoundToggle />
        </nav>
      </div>
    </header>
  )
}
