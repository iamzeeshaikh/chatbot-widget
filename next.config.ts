import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // lib/gmailintake.ts runs the Apps Script's own parser; ship the file with it.
  outputFileTracingIncludes: {
    '/api/intake/pull': ['./scripts/quote-intake-apps-script.gs'],
    '/api/intake/script': ['./scripts/quote-intake-apps-script.gs', './scripts/sports-quote-intake-apps-script.gs'],
    '/w.js': ['./public/widget.js'],
  },
  // Paths that exist for the ZeeOps dashboards only. On a ZeeDesk host they do
  // not resolve: the original widget file names chat.zeeops.dev, and the
  // install page is written for the ZeeOps app. Done here, by host, rather
  // than in middleware, so the widget every site loads never passes through
  // code that could fail.
  async rewrites() {
    const zeedesk = [{ type: 'host' as const, value: '(app|chat)\\.zeedesk\\.dev' }]
    return {
      beforeFiles: [
        { source: '/widget.js', has: zeedesk, destination: '/_not-found' },
        { source: '/install', has: zeedesk, destination: '/_not-found' },
      ],
    }
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
