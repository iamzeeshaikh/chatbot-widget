'use client'

// The Inbox — /inbox.
//
// Every email conversation the member may see, in one list the way a mailbox
// shows it: unread bold with a count, the customer's own words as the preview,
// newest first. Clicking a row opens the lead's record, which is where the
// full thread, the reply composer and read-marking already live — this page
// deliberately does not duplicate any of that, it only answers "what is
// waiting on us?" at a glance.
//
// Built from the record page's design system: the same type scale, tabular
// numbers and lucide icons at one stroke weight, in the light Tailwind
// utilities globals.css remaps for dark mode.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Inbox as InboxIcon, Mail, Reply, RefreshCw } from 'lucide-react'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import GlobalSearch from '@/app/components/GlobalSearch'

interface Thread {
  leadId: string; siteId: string; siteName: string
  subject: string; from: string; snippet: string
  at: string | null; direction: 'in' | 'out'
  messages: number; unread: number; owner: string | null
}

export default function InboxPage() {
  const [threads, setThreads] = useState<Thread[] | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'unavailable' | 'error'>('loading')
  const [onlyUnread, setOnlyUnread] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => fetch('/api/inbox')
      .then(async (r) => {
        if (!alive) return
        if (r.status === 403) { setStatus('unavailable'); return }
        if (!r.ok) { setStatus('error'); return }
        const d = await r.json()
        if (!alive) return
        setThreads(d.threads ?? [])
        setStatus('ok')
      })
      .catch(() => { if (alive) setStatus('error') })
    load()
    const iv = setInterval(load, 60000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  const list = (threads ?? []).filter((t) => !onlyUnread || t.unread > 0)
  const unreadTotal = (threads ?? []).reduce((n, t) => n + t.unread, 0)

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      <div className="border-b border-gray-200 bg-white/95 backdrop-blur px-5 py-3 flex items-center justify-between gap-3 sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/" className="px-2.5 py-1.5 text-xs text-gray-500 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg transition-colors inline-flex items-center gap-1">
            <ArrowLeft size={13} strokeWidth={2} aria-hidden /> Dashboard
          </Link>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-gray-900 leading-tight flex items-center gap-2">
              <InboxIcon size={15} strokeWidth={2} aria-hidden /> Inbox
            </h1>
            <p className="text-gray-500 text-[11px]">
              {status === 'ok'
                ? unreadTotal > 0
                  ? `${unreadTotal} unread repl${unreadTotal === 1 ? 'y' : 'ies'} from customers`
                  : 'Nothing unread — all caught up'
                : ' '}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <GlobalSearch />
          <button onClick={() => setOnlyUnread((v) => !v)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${onlyUnread ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'}`}>
            Unread only
          </button>
        </div>
      </div>

      <div className="p-4 sm:p-6 max-w-5xl mx-auto">
        {status === 'loading' && (
          <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 bg-gray-200/60 rounded-xl animate-pulse" />
          ))}</div>
        )}

        {status === 'unavailable' && (
          <div className="text-center py-20">
            <Mail size={28} strokeWidth={1.5} className="mx-auto text-gray-400 mb-3" aria-hidden />
            <p className="text-sm font-medium text-gray-700">Email is not enabled for this workspace</p>
          </div>
        )}
        {status === 'error' && (
          <div className="text-center py-20">
            <p className="text-sm font-medium text-gray-700">The inbox could not be loaded.</p>
            <button onClick={() => location.reload()} className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100">
              <RefreshCw size={12} strokeWidth={2} aria-hidden /> Try again
            </button>
          </div>
        )}

        {status === 'ok' && list.length === 0 && (
          <div className="text-center py-20">
            <InboxIcon size={28} strokeWidth={1.5} className="mx-auto text-gray-400 mb-3" aria-hidden />
            <p className="text-sm font-medium text-gray-700">{onlyUnread ? 'Nothing unread' : 'No email conversations yet'}</p>
            <p className="text-xs text-gray-500 mt-1">{onlyUnread ? 'Every customer reply has been read.' : 'Email a lead from their record and the thread will appear here.'}</p>
          </div>
        )}

        {status === 'ok' && list.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden divide-y divide-gray-100">
            {list.map((t) => {
              const unread = t.unread > 0
              return (
                <Link key={t.leadId} href={`/leads/${encodeURIComponent(t.leadId)}`}
                  className={`flex items-center gap-3 px-4 py-3 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${unread ? 'bg-blue-50/40' : ''}`}>
                  {/* The unread dot is the row's anchor: scanning the left edge
                      answers "what needs me" without reading a word. */}
                  <span className={`w-2 h-2 rounded-full shrink-0 ${unread ? 'bg-blue-600' : 'bg-transparent'}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={`text-sm truncate ${unread ? 'font-bold text-gray-900' : 'font-medium text-gray-800'}`}>{t.from || '(no sender)'}</span>
                      {unread && <span className="text-[10px] font-bold text-white bg-blue-600 rounded-full px-1.5 py-px tabular-nums shrink-0">{t.unread}</span>}
                      <span className="text-[10px] text-gray-500 border border-gray-200 bg-gray-100 rounded-full px-1.5 py-px truncate max-w-[130px] shrink-0">{t.siteName}</span>
                    </span>
                    <span className="block text-xs text-gray-700 truncate mt-0.5">
                      <span className={unread ? 'font-semibold' : ''}>{t.subject || '(no subject)'}</span>
                      {t.snippet && <span className="text-gray-500"> — {t.direction === 'out' && <Reply size={10} className="inline -mt-px mr-0.5" aria-hidden />}{t.snippet}</span>}
                    </span>
                  </span>
                  <span className="text-[11px] text-gray-500 shrink-0 tabular-nums" title={t.at ? formatDateTime(t.at) : undefined}>
                    {t.at ? timeAgo(t.at) : ''}
                  </span>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
