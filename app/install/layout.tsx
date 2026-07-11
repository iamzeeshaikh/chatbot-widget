import type { Metadata } from 'next'

// Metadata for the public install page (the page itself is a client
// component, so its metadata lives here). The OpenGraph block is what makes
// the link show a proper preview card when shared on WhatsApp etc.
export const metadata: Metadata = {
  title: 'Install the ZeeOps App',
  description: 'Get the ZeeOps agent dashboard on your phone — with chat notifications even when the app is closed.',
  openGraph: {
    title: 'Install the ZeeOps App',
    description: 'Agent dashboard on your phone — new customer chats ping you even when the app is closed. Tap for install steps.',
    url: 'https://chat.zeeops.dev/install',
    siteName: 'ZeeOps',
    images: [{ url: 'https://chat.zeeops.dev/icon-512.png', width: 512, height: 512 }],
    type: 'website',
  },
}

export default function InstallLayout({ children }: { children: React.ReactNode }) {
  return children
}
