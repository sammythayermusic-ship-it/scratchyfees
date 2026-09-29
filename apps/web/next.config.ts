import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@scratchy/core'],
  poweredByHeader: false,
}

export default nextConfig
