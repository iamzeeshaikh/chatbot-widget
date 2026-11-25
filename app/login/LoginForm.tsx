'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download, Eye, EyeOff, ArrowRight } from 'lucide-react'
import type { Workspace } from '@/lib/workspaces'

// The two dashboards must not look like each other. Which one this is comes
// from the hostname (see HOST_WORKSPACES), so the sign-in page already knows
// before anyone types — `null` is an unbound host (localhost, a preview
// deployment), where either account may sign in and the neutral mark is right.
const BRANDS = {
  sports: {
    title: 'Sports Dashboard',
    subtitle: 'Sign in to the sports dashboard',
    mark: 'bg-green-600',
    button: 'bg-green-600 hover:bg-green-700',
    focus: 'focus:border-green-500',
    link: 'text-green-700 hover:text-green-800',
    icon: (
      <svg viewBox="0 0 100 100" className="w-7 h-7" aria-hidden>
        <path d="M35 22 Q31 50 38 62 Q44 72 50 74 Q56 72 62 62 Q69 50 65 22Z" fill="white" />
        <path d="M35 30 Q20 30 20 44 Q20 56 35 56" stroke="white" strokeWidth="7" fill="none" strokeLinecap="round" />
        <path d="M65 30 Q80 30 80 44 Q80 56 65 56" stroke="white" strokeWidth="7" fill="none" strokeLinecap="round" />
        <rect x="44" y="74" width="12" height="10" rx="2" fill="white" />
        <rect x="32" y="84" width="36" height="8" rx="3" fill="white" />
      </svg>
    ),
  },
  packaging: {
    title: 'Packaging Dashboard',
    subtitle: 'Sign in to the packaging dashboard',
    mark: 'bg-blue-600',
    button: 'bg-blue-600 hover:bg-blue-700',
    focus: 'focus:border-blue-500',
    link: 'text-blue-600 hover:text-blue-700',
    icon: (
      <svg viewBox="0 0 100 100" className="w-7 h-7" aria-hidden>
        <rect x="12" y="40" width="76" height="52" rx="5" fill="white" />
        <polygon points="12,40 50,22 88,40" fill="white" opacity="0.75" />
        <rect x="38" y="40" width="24" height="52" fill="#1d4ed8" opacity="0.35" />
      </svg>
    ),
  },
  zeedesk: {
    title: 'ZeeDesk',
    subtitle: 'Sign in to your workspace',
    mark: 'bg-blue-600',
    button: 'bg-blue-600 hover:bg-blue-700',
    focus: 'focus:border-blue-500',
    link: 'text-blue-600 hover:text-blue-700',
    icon: (
      <svg viewBox="0 0 24 24" className="w-7 h-7 fill-white" aria-hidden>
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
      </svg>
    ),
  },
  neutral: {
    title: 'Welcome back',
    subtitle: 'Sign in to your dashboard',
    mark: 'bg-blue-600',
    button: 'bg-blue-600 hover:bg-blue-700',
    focus: 'focus:border-blue-500',
    link: 'text-blue-600 hover:text-blue-700',
    icon: (
      <svg viewBox="0 0 24 24" className="w-7 h-7 fill-white" aria-hidden>
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
      </svg>
    ),
  },
}

export default function LoginForm({ workspace }: { workspace: Workspace | null }) {
  const brand = BRANDS[workspace ?? 'neutral']
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Invalid credentials')
        setLoading(false)
        return
      }
      router.push('/')
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  if (workspace === 'zeedesk') {
    return <ZeeDeskLogin email={email} setEmail={setEmail} password={password} setPassword={setPassword}
      error={error} loading={loading} onSubmit={handleLogin} />
  }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-gray-100 border border-gray-200 rounded-2xl p-8 w-full max-w-sm shadow-2xl">
        <div className="mb-8 text-center">
          <div className={`w-12 h-12 ${brand.mark} rounded-xl flex items-center justify-center mx-auto mb-4`}>
            {brand.icon}
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{brand.title}</h1>
          <p className="text-gray-500 text-sm mt-1">{brand.subtitle}</p>
        </div>
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 font-medium mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className={`w-full bg-gray-200 border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none ${brand.focus} transition-colors`}
              placeholder="you@zeeops.dev"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 font-medium mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className={`w-full bg-gray-200 border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none ${brand.focus} transition-colors`}
              placeholder="••••••••"
            />
          </div>
          {error && (
            <p className="text-red-600 text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className={`w-full ${brand.button} text-white font-medium py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="text-center mt-4">
          <a href="/install" className={`text-xs ${brand.link} font-medium inline-flex items-center gap-1.5`}><Download size={12} strokeWidth={2} aria-hidden /> Install this dashboard as an app</a>
        </p>
      </div>
    </div>
  )
}

// ── ZeeDesk ──────────────────────────────────────────────────────────────────
// Its own sign-in, not the ZeeOps card with another name (owner, 25 Nov: "ye
// same zeeops wala hai, modern rakho"). Split screen in the ZeeDesk palette —
// the deep teal app bar (#03363d) and its blue (#1f73b7) — with a Z mark of its
// own. Nothing on it says ZeeOps. /install on a ZeeDesk host is ZeeDesk's
// own install page (app/zd-install).

function ZeeDeskMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <rect width="40" height="40" rx="11" fill="#1f73b7" />
      <path d="M12 13h16L14.5 27H28" stroke="white" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="29" cy="12" r="3.2" fill="#5eead4" />
    </svg>
  )
}

function ZeeDeskLogin({ email, setEmail, password, setPassword, error, loading, onSubmit }: {
  email: string; setEmail: (v: string) => void
  password: string; setPassword: (v: string) => void
  error: string; loading: boolean; onSubmit: (e: React.FormEvent) => void
}) {
  const [show, setShow] = useState(false)
  const field = 'w-full h-12 rounded-xl border border-[#d8dcde] bg-white px-4 text-[15px] text-[#2f3941] placeholder-[#87929d] outline-none transition focus:border-[#1f73b7] focus:ring-4 focus:ring-[#1f73b7]/15'
  return (
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_1fr] bg-white">
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-[#03363d] p-12 text-white">
        <div aria-hidden className="pointer-events-none absolute -right-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-[#1f73b7]/25 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-40 -left-24 h-[26rem] w-[26rem] rounded-full bg-[#5eead4]/10 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <ZeeDeskMark size={36} />
          <span className="text-lg font-semibold tracking-tight">ZeeDesk</span>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-[40px] font-semibold leading-[1.1] tracking-tight">Every customer conversation, in one place.</h2>
          <p className="mt-4 text-[15px] leading-relaxed text-white/70">Live chats, enquiries and follow-ups for your whole team — answered fast, never lost.</p>
          <div className="mt-10 rounded-2xl border border-white/10 bg-white/[0.06] p-4 backdrop-blur">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#5eead4]/20 text-sm font-semibold text-[#5eead4]">S</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">New chat</p>
                <p className="truncate text-xs text-white/60">Hi, can I get a price for 500 boxes?</p>
              </div>
              <span className="rounded-full bg-[#5eead4]/15 px-2 py-0.5 text-[11px] font-medium text-[#5eead4]">Open</span>
            </div>
          </div>
        </div>
        <p className="relative text-xs text-white/40">© {new Date().getFullYear()} ZeeDesk</p>
      </aside>

      <main className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-[380px]">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <ZeeDeskMark size={36} />
            <span className="text-lg font-semibold tracking-tight text-[#03363d]">ZeeDesk</span>
          </div>
          <h1 className="text-[28px] font-semibold tracking-tight text-[#03363d]">Sign in</h1>
          <p className="mt-1.5 text-[15px] text-[#68737d]">Welcome back. Enter your details to open your desk.</p>

          <form onSubmit={onSubmit} className="mt-8 space-y-5">
            <div>
              <label htmlFor="zd-email" className="mb-1.5 block text-sm font-medium text-[#2f3941]">Email</label>
              <input id="zd-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
                autoComplete="email" placeholder="you@zeedesk.dev" className={field} />
            </div>
            <div>
              <label htmlFor="zd-pass" className="mb-1.5 block text-sm font-medium text-[#2f3941]">Password</label>
              <div className="relative">
                <input id="zd-pass" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required
                  autoComplete="current-password" placeholder="Your password" className={`${field} pr-12`} />
                <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-[#68737d] hover:bg-[#f3f5f6] hover:text-[#2f3941]">
                  {show ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            {error && <p role="alert" className="rounded-xl border border-[#f5c2c0] bg-[#fff0f1] px-4 py-3 text-sm text-[#cc3340]">{error}</p>}
            <button type="submit" disabled={loading}
              className="group flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#03363d] text-[15px] font-semibold text-white transition hover:bg-[#0b4a52] disabled:cursor-not-allowed disabled:opacity-60">
              {loading ? 'Signing in…' : <>Sign in <ArrowRight size={17} className="transition group-hover:translate-x-0.5" /></>}
            </button>
          </form>

          <a href="/install" className="mt-8 flex items-center justify-center gap-2 rounded-xl border border-[#e9ebed] px-4 py-3 text-sm font-medium text-[#1f73b7] transition hover:bg-[#f8f9f9]">
            <Download size={15} aria-hidden /> Install ZeeDesk as an app
          </a>
        </div>
      </main>
    </div>
  )
}
