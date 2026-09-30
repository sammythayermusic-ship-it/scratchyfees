import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@scratchy/core'],
  poweredByHeader: false,
  // www → apex (the worker serves both hostnames as custom domains)
  async redirects() {
    return [
      {
        source: '/',
        has: [{ type: 'host', value: 'www.scratchyfees.fun' }],
        destination: 'https://scratchyfees.fun/',
        permanent: true,
      },
      {
        source: '/:path+',
        has: [{ type: 'host', value: 'www.scratchyfees.fun' }],
        destination: 'https://scratchyfees.fun/:path+',
        permanent: true,
      },
    ]
  },
  // hardening (security review #11): no framing (clickjacking), no MIME sniffing, no referrer leaks off-site
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
  // lets CI / a second build run beside a live `next dev` without clobbering its .next
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
}

export default nextConfig
