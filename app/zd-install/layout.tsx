import type { Metadata } from 'next'

// ZeeDesk's own install page, served as /install on the ZeeDesk hosts
// (next.config.ts rewrites it there). Relative URLs only: it must never name
// another dashboard's address.
export const metadata: Metadata = {
  title: 'Install ZeeDesk',
  description: 'Put ZeeDesk on your phone or computer and open it like any other app.',
}

export default function ZdInstallLayout({ children }: { children: React.ReactNode }) {
  return children
}
