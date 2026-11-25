import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'
import { workspaceForHost } from '@/lib/workspaces'

// PWA manifest — makes the agent dashboard installable ("Add to Home Screen" /
// desktop install) without any app store. Internal agents only. Named by the
// host it is served on, so the ZeeDesk team's install carries its own name.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const zeedesk = workspaceForHost((await headers()).get('host')) === 'zeedesk'
  return {
    name: zeedesk ? 'ZeeDesk' : 'ZeeOps Chat Widget',
    short_name: zeedesk ? 'ZeeDesk' : 'ZeeOps',
    description: zeedesk ? 'ZeeDesk workspace' : 'ZeeOps live-chat agent dashboard',
    start_url: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f5f6f7',
    theme_color: zeedesk ? '#03363d' : '#2563eb',
    // ZeeDesk installs under its own mark (public/zd-icons, drawn by
    // scratch/gen-zd-icons.mjs), never the other dashboards' icon.
    icons: zeedesk ? [
      { src: '/zd-icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/zd-icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/zd-icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ] : [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
