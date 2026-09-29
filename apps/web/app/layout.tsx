import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '$SCRATCHY — scratch tickets paid in $PUMP',
  description: 'Hold $SCRATCHY, scratch tickets every 10 minutes, winners paid instantly in $PUMP.',
}

export const viewport: Viewport = {
  themeColor: '#0e011d',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  )
}
