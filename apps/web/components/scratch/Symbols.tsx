import { useId } from 'react'
import type { SymbolKey } from '@/lib/types'

/**
 * Slot symbols under the foil (three-of-a-kind = your tier). Chunky gold-foil vector icons in the brand
 * palette; the jackpot symbol is the official mascot head crop (assets/brand → public/brand).
 */
export function SlotSymbol({ symbol, size = 64 }: { symbol: SymbolKey; size?: number }) {
  const id = useId().replace(/:/g, '')
  if (symbol === 'scratchy') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/brand/mascot-head.png"
        alt="Scratchy"
        width={size}
        height={size}
        className="drop-shadow-[0_0_12px_rgba(251,213,63,0.9)]"
        draggable={false}
      />
    )
  }
  const gold = `g-${id}`
  const pink = `p-${id}`
  const stroke = '#3a0b5e'
  const defs = (
    <defs>
      <linearGradient id={gold} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fdf771" />
        <stop offset="0.45" stopColor="#fbd53f" />
        <stop offset="1" stopColor="#df8d21" />
      </linearGradient>
      <linearGradient id={pink} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#f919d7" />
        <stop offset="1" stopColor="#a0019f" />
      </linearGradient>
    </defs>
  )
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 64 64',
    'aria-label': symbol,
    role: 'img' as const,
  }
  switch (symbol) {
    case 'coin':
      return (
        <svg {...common}>
          {defs}
          <circle cx="32" cy="32" r="26" fill={`url(#${gold})`} stroke={stroke} strokeWidth="4" />
          <circle cx="32" cy="32" r="18" fill="none" stroke="#df8d21" strokeWidth="3" />
          <text
            x="32"
            y="42"
            textAnchor="middle"
            fontSize="28"
            fontWeight="900"
            fill={stroke}
            fontFamily="Nunito, sans-serif"
          >
            $
          </text>
        </svg>
      )
    case 'bag':
      return (
        <svg {...common}>
          {defs}
          <path
            d="M24 12h16l-4 8h-8z"
            fill={`url(#${gold})`}
            stroke={stroke}
            strokeWidth="3.5"
            strokeLinejoin="round"
          />
          <path
            d="M28 20c-12 6-18 16-16 26 2 8 10 12 20 12s18-4 20-12c2-10-4-20-16-26z"
            fill={`url(#${gold})`}
            stroke={stroke}
            strokeWidth="4"
            strokeLinejoin="round"
          />
          <text
            x="32"
            y="50"
            textAnchor="middle"
            fontSize="22"
            fontWeight="900"
            fill={stroke}
            fontFamily="Nunito, sans-serif"
          >
            $
          </text>
        </svg>
      )
    case 'bar':
      return (
        <svg {...common}>
          {defs}
          <path
            d="M8 44l8-20h32l8 20z"
            fill={`url(#${gold})`}
            stroke={stroke}
            strokeWidth="4"
            strokeLinejoin="round"
          />
          <path
            d="M20 24l4-10h16l4 10"
            fill={`url(#${gold})`}
            stroke={stroke}
            strokeWidth="4"
            strokeLinejoin="round"
          />
          <path d="M18 36h28" stroke="#fdf771" strokeWidth="3" strokeLinecap="round" />
        </svg>
      )
    case 'diamond':
      return (
        <svg {...common}>
          {defs}
          <path
            d="M14 24l8-12h20l8 12-18 28z"
            fill={`url(#${pink})`}
            stroke={stroke}
            strokeWidth="4"
            strokeLinejoin="round"
          />
          <path
            d="M14 24h36M22 12l10 40 10-40"
            fill="none"
            stroke="#fdf771"
            strokeWidth="2.5"
            strokeLinejoin="round"
            opacity="0.8"
          />
        </svg>
      )
    case 'crown':
      return (
        <svg {...common}>
          {defs}
          <path
            d="M8 46l4-28 12 12 8-16 8 16 12-12 4 28z"
            fill={`url(#${gold})`}
            stroke={stroke}
            strokeWidth="4"
            strokeLinejoin="round"
          />
          <rect
            x="10"
            y="46"
            width="44"
            height="8"
            rx="3"
            fill={`url(#${gold})`}
            stroke={stroke}
            strokeWidth="3.5"
          />
          <circle cx="32" cy="38" r="4" fill={`url(#${pink})`} stroke={stroke} strokeWidth="2" />
        </svg>
      )
    case 'seven':
      return (
        <svg {...common}>
          {defs}
          <path
            d="M14 12h36v8L32 54H20l17-32H14z"
            fill={`url(#${pink})`}
            stroke={stroke}
            strokeWidth="4"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'clover':
      return (
        <svg {...common}>
          {defs}
          <g fill="#3ddc84" stroke={stroke} strokeWidth="3.5">
            <circle cx="24" cy="24" r="10" />
            <circle cx="40" cy="24" r="10" />
            <circle cx="24" cy="40" r="10" />
            <circle cx="40" cy="40" r="10" />
          </g>
          <path d="M32 40c2 8 6 14 10 16" stroke={stroke} strokeWidth="4" fill="none" strokeLinecap="round" />
        </svg>
      )
    case 'star':
    default:
      return (
        <svg {...common}>
          {defs}
          <path
            d="M32 6l7.6 16.4L58 25l-13.4 12.6L48 56 32 47 16 56l3.4-18.4L6 25l18.4-2.6z"
            fill={`url(#${gold})`}
            stroke={stroke}
            strokeWidth="4"
            strokeLinejoin="round"
          />
        </svg>
      )
  }
}
