import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // lib/gmailintake.ts runs the Apps Script's own parser; ship the file with it.
  outputFileTracingIncludes: {
    '/api/intake/pull': ['./scripts/quote-intake-apps-script.gs'],
    '/api/intake/script': ['./scripts/quote-intake-apps-script.gs'],
  },
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,POST,OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type' },
        ],
      },
      {
        // Never cache widget.js — all sites must always get the latest version
        source: '/widget.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Pragma', value: 'no-cache' },
          { key: 'Expires', value: '0' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
        ],
      },
    ]
  },
}

export default nextConfig
