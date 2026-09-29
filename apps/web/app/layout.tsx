import type { Metadata, Viewport } from 'next'
import { Lilita_One, Nunito } from 'next/font/google'
import { Footer } from '@/components/layout/Footer'
import { Header } from '@/components/layout/Header'
import { SITE_URL, X_HANDLE } from '@/lib/config'
import './globals.css'
import { Providers } from './providers'

const lilita = Lilita_One({ weight: '400', subsets: ['latin'], variable: '--font-lilita', display: 'swap' })
const nunito = Nunito({ subsets: ['latin'], variable: '--font-nunito', display: 'swap' })

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: '$SCRATCHY — scratch tickets paid in $PUMP',
  description:
    'Hold $SCRATCHY, paste your wallet, scratch tickets every 10 minutes. Winners are paid instantly in $PUMP from the pool’s trading fees.',
  openGraph: {
    title: '$SCRATCHY — scratchyfees.fun',
    description: 'Scratch tickets every 10 minutes. Winners paid instantly in $PUMP.',
    images: [{ url: '/brand/og.jpg', width: 1200, height: 630, alt: '$SCRATCHY' }],
  },
  twitter: { card: 'summary_large_image', site: `@${X_HANDLE}`, images: ['/brand/og.jpg'] },
}

export const viewport: Viewport = {
  themeColor: '#0e011d',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${lilita.variable} ${nunito.variable}`}>
      <body className="min-h-dvh antialiased">
        <Providers>
          <div id="shake-root">
            <Header />
            <main className="mx-auto max-w-6xl px-4 pb-8">{children}</main>
            <Footer />
          </div>
        </Providers>
      </body>
    </html>
  )
}
