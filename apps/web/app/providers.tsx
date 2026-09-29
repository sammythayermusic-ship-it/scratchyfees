'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import { GlobalJackpotBanner } from '@/components/celebrate/GlobalJackpotBanner'
import { LiveProvider } from '@/lib/live'

const WalletCtx = createContext<{ wallet: string | null; setWallet: (w: string | null) => void }>({
  wallet: null,
  setWallet: () => {},
})
export const useMyWallet = () => useContext(WalletCtx)

export function Providers({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<string | null>(null)
  return (
    <LiveProvider>
      <WalletCtx.Provider value={{ wallet, setWallet }}>
        <GlobalJackpotBanner myWallet={wallet} />
        {children}
      </WalletCtx.Provider>
    </LiveProvider>
  )
}
