import type { Metadata } from 'next'
import { AdminPanel } from '@/components/admin/AdminPanel'

/** Operator console — token-gated client-side; not linked from the site nav and never indexed. */
export const metadata: Metadata = {
  title: 'Admin · $SCRATCHY',
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: 'no-referrer',
}

export default function AdminPage() {
  return <AdminPanel />
}
