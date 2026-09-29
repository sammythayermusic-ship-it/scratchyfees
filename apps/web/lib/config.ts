/** Public, build-time configuration (NEXT_PUBLIC_*; documented in /.env.example). */
export const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000'
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws'
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
export const CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? 'devnet'
export const X_HANDLE = process.env.NEXT_PUBLIC_X_HANDLE ?? 'ScratchyFees'
export const DOMAIN = 'scratchyfees.fun'
/** PUMP has 6 decimals (the devnet mock mirrors it) */
export const PUMP_DECIMALS = 6
