'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download } from 'lucide-react'
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
