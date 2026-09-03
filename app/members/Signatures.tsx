'use client'

// Email signatures, in two halves, because a signature is two different things
// owned by two different people:
//
//   • YOUR details — name, job title, direct line. Yours to change.
//   • THE BUSINESS's details — company, phone, website, office address. One
//     per site, admin only, because this text goes out on every agent's mail
//     and one careless edit misrepresents the company on all of it.
//
// The preview is rendered from the same server route the composer uses, so
// what is shown here is literally what will be appended to an email.

import { useEffect, useState } from 'react'
import { PenLine, Building2, Check, Loader2 } from 'lucide-react'

interface Agent { email: string; name: string; title: string; phone: string }
interface SiteContact { siteId: string; company: string; phone: string; website: string; address: string }

export default function Signatures({ isAdmin, siteNames }: {
  isAdmin: boolean
  siteNames: Record<string, string>
}) {
  const [agent, setAgent] = useState<Agent>({ email: '', name: '', title: '', phone: '' })
  const [sites, setSites] = useState<SiteContact[]>([])
  const [loading, setLoading] = useState(true)
  const [savingAgent, setSavingAgent] = useState(false)
  const [savedAgent, setSavedAgent] = useState(false)
  const [savingSite, setSavingSite] = useState<string | null>(null)
  const [savedSite, setSavedSite] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [openSite, setOpenSite] = useState<string | null>(null)
  const [preview, setPreview] = useState('')

  // State is set from the promise callback, never synchronously in the effect
  // body — the latter is what makes React re-render in a cascade.
  useEffect(() => {
    let alive = true
    fetch('/api/signature')
      .then((x) => (x.ok ? x.json() : null))
      .catch(() => null)
      .then((r) => {
        if (!alive) return
        if (r?.agent) setAgent(r.agent)
        setSites(r?.sites ?? [])
        setLoading(false)
      })
    return () => { alive = false }
  }, [])

  // The preview follows whichever site is being edited, and falls back to the
  // first one — a signature with no site in it is not what anybody will send.
  const previewSite = openSite ?? sites[0]?.siteId ?? ''
  useEffect(() => {
    if (!previewSite) return
    fetch(`/api/signature?siteId=${encodeURIComponent(previewSite)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setPreview(d?.signature ?? ''))
      .catch(() => {})
  }, [previewSite, savedAgent, savedSite])

  async function saveAgent() {
    setSavingAgent(true); setError('')
    const r = await fetch('/api/signature', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(agent),
    })
    const j = await r.json().catch(() => ({}))
    setSavingAgent(false)
    if (!r.ok) { setError(j.error || 'Could not save.'); return }
    setSavedAgent(true); setTimeout(() => setSavedAgent(false), 2000)
  }

  async function saveSite(s: SiteContact) {
    setSavingSite(s.siteId); setError('')
    const r = await fetch('/api/signature/site', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    })
    const j = await r.json().catch(() => ({}))
    setSavingSite(null)
    if (!r.ok) { setError(j.error || 'Could not save.'); return }
    setSavedSite(s.siteId); setTimeout(() => setSavedSite(null), 2000)
  }

  const field = 'w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-blue-500'
  const label = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1'

  if (loading) return null

  return (
    <div className="mt-8">
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Email signature</h2>
      <p className="text-gray-500 text-xs mb-4">
        Added to the bottom of every email you send from a lead&apos;s record.
      </p>

      {error && <p className="text-red-600 text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── You ── */}
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-4">
            <PenLine size={15} strokeWidth={2} className="text-gray-500" aria-hidden />
            <h3 className="text-sm font-semibold text-gray-900">Your details</h3>
          </div>
          <div className="space-y-3">
            <div>
              <label className={label} htmlFor="sig-name">Name</label>
              <input id="sig-name" className={field} value={agent.name} placeholder="Steve Hayes"
                onChange={(e) => setAgent({ ...agent, name: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="sig-title">Job title</label>
              <input id="sig-title" className={field} value={agent.title} placeholder="Sales Executive"
                onChange={(e) => setAgent({ ...agent, title: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="sig-phone">Direct line <span className="font-normal normal-case text-gray-400">— optional, the site&apos;s number is used if blank</span></label>
              <input id="sig-phone" className={field} value={agent.phone} placeholder="+1 503 461 4788"
                onChange={(e) => setAgent({ ...agent, phone: e.target.value })} />
            </div>
          </div>
          <button onClick={saveAgent} disabled={savingAgent}
            className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50">
            {savingAgent ? <Loader2 size={13} className="animate-spin" aria-hidden /> : savedAgent ? <Check size={13} aria-hidden /> : null}
            {savedAgent ? 'Saved' : 'Save'}
          </button>
        </div>

        {/* ── Preview ── */}
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Preview</h3>
          <p className="text-gray-500 text-[11px] mb-3">
            {previewSite ? <>As it will appear on mail from <span className="font-medium text-gray-700">{siteNames[previewSite] ?? previewSite}</span></> : 'Pick a site below'}
          </p>
          <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-gray-800 bg-gray-100 border border-gray-200 rounded-xl p-4 min-h-[120px]">
            {preview || 'Nothing filled in yet.'}
          </pre>
        </div>
      </div>

      {/* ── The business, one per site ── */}
      <div className="mt-5">
        <div className="flex items-center gap-2 mb-1">
          <Building2 size={15} strokeWidth={2} className="text-gray-500" aria-hidden />
          <h3 className="text-sm font-semibold text-gray-900">Business details, per site</h3>
        </div>
        <p className="text-gray-500 text-xs mb-3">
          {isAdmin
            ? 'Shared by every agent who writes for that site. Leave the address blank until you have the real one — a made-up address on outgoing mail is worse than none.'
            : 'Set by an admin. Ask them to change these if something is wrong.'}
        </p>

        <div className="grid gap-2">
          {sites.map((s) => {
            const open = openSite === s.siteId
            return (
              <div key={s.siteId} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <button onClick={() => setOpenSite(open ? null : s.siteId)}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-100 transition-colors">
                  <span className="text-sm font-medium text-gray-900 truncate">{siteNames[s.siteId] ?? s.siteId}</span>
                  <span className="text-[11px] text-gray-500 truncate max-w-[55%]">
                    {s.address || s.website || <span className="text-amber-700">nothing set</span>}
                  </span>
                </button>
                {open && (
                  <div className="border-t border-gray-200 p-4 grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className={label} htmlFor={`c-${s.siteId}`}>Company name</label>
                      <input id={`c-${s.siteId}`} className={field} value={s.company} disabled={!isAdmin}
                        placeholder={siteNames[s.siteId] ?? ''}
                        onChange={(e) => setSites(sites.map((x) => x.siteId === s.siteId ? { ...x, company: e.target.value } : x))} />
                    </div>
                    <div>
                      <label className={label} htmlFor={`p-${s.siteId}`}>Phone</label>
                      <input id={`p-${s.siteId}`} className={field} value={s.phone} disabled={!isAdmin}
                        onChange={(e) => setSites(sites.map((x) => x.siteId === s.siteId ? { ...x, phone: e.target.value } : x))} />
                    </div>
                    <div>
                      <label className={label} htmlFor={`w-${s.siteId}`}>Website</label>
                      <input id={`w-${s.siteId}`} className={field} value={s.website} disabled={!isAdmin}
                        onChange={(e) => setSites(sites.map((x) => x.siteId === s.siteId ? { ...x, website: e.target.value } : x))} />
                    </div>
                    <div>
                      <label className={label} htmlFor={`a-${s.siteId}`}>Office address</label>
                      <input id={`a-${s.siteId}`} className={field} value={s.address} disabled={!isAdmin}
                        placeholder="Leave blank until you have the real one"
                        onChange={(e) => setSites(sites.map((x) => x.siteId === s.siteId ? { ...x, address: e.target.value } : x))} />
                    </div>
                    {isAdmin && (
                      <div className="sm:col-span-2">
                        <button onClick={() => saveSite(s)} disabled={savingSite === s.siteId}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50">
                          {savingSite === s.siteId ? <Loader2 size={13} className="animate-spin" aria-hidden /> : savedSite === s.siteId ? <Check size={13} aria-hidden /> : null}
                          {savedSite === s.siteId ? 'Saved' : 'Save'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
