'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

// Which dashboard you are in, said by the browser itself.
//
// The tab icon, the tab title and the accent colour used to be set inside
// app/page.tsx — so they were right on the dashboard and wrong everywhere else.
// Open a lead, the pipeline or a report and the tab reverted to the generic
// ZeeOps mark, which on a machine with five tabs open is the difference between
// finding the sports CRM and hunting for it.
//
// It lives in the root layout instead, and reads the workspace from the
// `zee-auth` cookie — the same non-httpOnly cookie the dashboard already reads
// for identity, so this needs no fetch and applies before anything paints.
const FAVICON_PACKAGING = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="12" y="40" width="76" height="52" rx="5" fill="#2563eb"/><polygon points="12,40 50,22 88,40" fill="#1d4ed8"/><rect x="38" y="40" width="24" height="52" fill="#93c5fd" opacity="0.35"/></svg>')}`
const FAVICON_SPORTS = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#16a34a"/><path d="M35 22 Q31 50 38 62 Q44 72 50 74 Q56 72 62 62 Q69 50 65 22Z" fill="white"/><path d="M35 30 Q20 30 20 44 Q20 56 35 56" stroke="white" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M65 30 Q80 30 80 44 Q80 56 65 56" stroke="white" stroke-width="7" fill="none" stroke-linecap="round"/><rect x="44" y="74" width="12" height="10" rx="2" fill="white"/><rect x="32" y="84" width="36" height="8" rx="3" fill="white"/></svg>')}`

// The Sales ledger gets its own tab icon — a banknote in the dashboard's
// colour — so it is findable among the dashboard's other tabs.
const faviconSales = (fill: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="4" y="22" width="92" height="56" rx="9" fill="${fill}"/><circle cx="50" cy="50" r="17" fill="white"/><text x="50" y="58" font-family="Arial,Helvetica,sans-serif" font-size="24" font-weight="700" text-anchor="middle" fill="${fill}">$</text><circle cx="19" cy="50" r="5" fill="white" opacity="0.7"/><circle cx="81" cy="50" r="5" fill="white" opacity="0.7"/></svg>`)}`
const FAVICON_SALES_PACKAGING = faviconSales('#2563eb')
const FAVICON_SALES_SPORTS = faviconSales('#16a34a')

function workspaceFromCookie(): 'sports' | 'packaging' | null {
  try {
    const raw = document.cookie.split('; ').find((c) => c.startsWith('zee-auth='))?.split('=')[1]
    if (!raw) return null
    const ui = JSON.parse(atob(decodeURIComponent(raw)))
    return ui?.workspace === 'sports' ? 'sports' : ui?.workspace === 'packaging' ? 'packaging' : null
  } catch {
    return null
  }
}

export default function WorkspaceChrome() {
  const pathname = usePathname()
  useEffect(() => {
    const brand = workspaceFromCookie()
    if (!brand) return                    // signed out: leave the defaults alone

    const sales = pathname === '/sales' || pathname?.startsWith('/sales/')
    const label = brand === 'sports' ? 'Sports' : 'Packaging'
    document.title = sales ? `Sales · ${label} | ZeeOps` : `${label} Dashboard | ZeeOps`
    // Read by the [data-ws="sports"] block in globals.css, which remaps the
    // accent utilities the way dark mode is remapped, so the two dashboards are
    // told apart at a glance rather than by reading the title. Packaging keeps
    // the blue it has always had: no attribute, no override.
    document.documentElement.dataset.ws = brand

    // Swap the TAB icon. Deliberately leaves rel='apple-touch-icon' alone:
    // "Add to Home Screen" reads the live DOM, and removing it once left agents
    // who install the dashboard for task reminders with a blank icon.
    document.querySelectorAll("link[rel='icon'], link[rel='shortcut icon']").forEach((l) => l.remove())
    const link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/svg+xml'
    link.href = sales
      ? (brand === 'sports' ? FAVICON_SALES_SPORTS : FAVICON_SALES_PACKAGING)
      : (brand === 'sports' ? FAVICON_SPORTS : FAVICON_PACKAGING)
    document.head.appendChild(link)
  }, [pathname])

  return null
}
