import type { MetadataRoute } from 'next'

// PWA manifest — makes the agent dashboard installable ("Add to Home Screen" /
// desktop install) without any app store. Internal agents only.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ZeeOps Chat Widget',
    short_name: 'ZeeOps',
    description: 'ZeeOps live-chat agent dashboard',
    start_url: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f5f6f7',
    theme_color: '#2563eb',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
