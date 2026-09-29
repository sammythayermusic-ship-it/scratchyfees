'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useLiveEvent } from '@/lib/live'
import type { PayoutView } from '@/lib/types'

/** Live payout status: websocket updates for our wallet + a 2 s poll until it lands (fallback). */
export function usePayoutStatus(payoutId: string | null): {
  status: PayoutView['status'] | null
  txSig: string | null
} {
  const [state, setState] = useState<{ status: PayoutView['status'] | null; txSig: string | null }>({
    status: null,
    txSig: null,
  })
  useLiveEvent((e) => {
    if (e.type === 'payout' && e.payoutId === payoutId)
      setState({ status: e.status as PayoutView['status'], txSig: e.txSig })
  })
  useEffect(() => {
    if (!payoutId) return
    let stop = false
    const tick = async () => {
      try {
        const p = await api.payout(payoutId)
        if (!stop) setState({ status: p.status, txSig: p.txSig })
        if (p.status === 'confirmed' || p.status === 'failed_permanent') return
      } catch {
        /* keep polling */
      }
      if (!stop) setTimeout(tick, 2_000)
    }
    void tick()
    return () => {
      stop = true
    }
  }, [payoutId])
  return state
}
