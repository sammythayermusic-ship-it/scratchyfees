import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@scratchy/core'],
  poweredByHeader: false,
  // lets CI / a second build run beside a live `next dev` without clobbering its .next
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
}

export default nextConfig
