'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'

interface Member {
  id: string
  email: string
  role: 'admin' | 'standard'
  assigned_sites: string[]
  created_at: string
}
interface Site { site_id: string; name: string; bot_name: string; primary_color: string }

function readSession(): { email: string; role: 'admin' | 'standard'; workspace: 'sports' | 'packaging'; sites: string[] } {
  const fallback = { email: '', role: 'standard' as const, workspace: 'packaging' as const, sites: [] }
  if (typeof document === 'undefined') return fallback
  const cookie = document.cookie.split('; ').find((r) => r.startsWith('zee-auth='))
  if (!cookie) return fallback
  try { return { ...fallback, ...JSON.parse(atob(cookie.split('=')[1])) } } catch { return fallback }
}

const emptyForm = { email: '', password: '', role: 'standard' as 'admin' | 'standard', sites: [] as string[] }

export default function MembersPage() {
  const router = useRouter()
  const [authChecked, setAuthChecked] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [workspace, setWorkspace] = useState<'sports' | 'packaging'>('packaging')

  const [members, setMembers] = useState<Member[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Add form
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)

  // Edit
  const [editId, setEditId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{ role: 'admin' | 'standard'; sites: string[]; password: string }>({ role: 'standard', sites: [], password: '' })

  // Delete
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    const s = readSession()
    if (s.role !== 'admin') { router.replace('/'); return }
    setWorkspace(s.workspace)
    setIsAdmin(true)
    setAuthChecked(true)
  }, [router])

  const load = useCallback(async () => {
    setLoading(true)
    const [m, s] = await Promise.all([
      fetch('/api/admin/members').then((r) => r.json()).catch(() => ({ members: [] })),
      fetch('/api/admin/sites').then((r) => r.json()).catch(() => ({ sites: [] })),
    ])
    setMembers(m.members ?? [])
    setSites(s.sites ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { if (isAdmin) load() }, [isAdmin, load])

  const siteName = (id: string) => sites.find((s) => s.site_id === id)?.name ?? id

  async function addMember(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    const res = await fetch('/api/admin/members', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: addForm.email.trim(),
        password: addForm.password,
        role: addForm.role,
        assigned_sites: addForm.role === 'admin' ? [] : addForm.sites,
      }),
    })
    const data = await res.json()
    setSaving(false)
    if (!res.ok) { setError(data.error || 'Could not add member'); return }
    setShowAdd(false); setAddForm(emptyForm)
    load()
  }

  function startEdit(m: Member) {
    setEditId(m.id)
    setEditForm({ role: m.role, sites: m.assigned_sites ?? [], password: '' })
    setError('')
  }

  async function saveEdit(id: string) {
    setBusyId(id); setError('')
    const res = await fetch('/api/admin/members', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id, role: editForm.role,
        assigned_sites: editForm.role === 'admin' ? [] : editForm.sites,
        password: editForm.password || undefined,
      }),
    })
    const data = await res.json()
    setBusyId(null)
    if (!res.ok) { setError(data.error || 'Could not update member'); return }
    setEditId(null)
    load()
  }

  async function removeMember(id: string) {
    setBusyId(id); setError('')
    const res = await fetch('/api/admin/members', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const data = await res.json()
    setBusyId(null); setConfirmDeleteId(null)
    if (!res.ok) { setError(data.error || 'Could not remove member'); return }
    load()
  }

  function toggleSite(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((s) => s !== id) : [...list, id]
  }

  if (!authChecked) {
    return <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-500 text-sm">Checking access…</div>
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <div className="border-b border-gray-800/80 bg-gray-950/95 backdrop-blur px-5 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/')} className="px-2.5 py-1.5 text-xs text-gray-400 hover:text-white bg-gray-900 hover:bg-gray-800 border border-gray-800 rounded-lg transition-colors">← Dashboard</button>
          <div>
            <h1 className="text-base font-bold text-white leading-tight flex items-center gap-2">
              {workspace === 'sports' ? '🏆 Sports' : '📦 Packaging'} Members
            </h1>
            <p className="text-gray-500 text-[11px]">Manage who can access the {workspace} dashboard</p>
          </div>
        </div>
        <button onClick={() => { setShowAdd(true); setAddForm(emptyForm); setError('') }}
          className="px-3.5 py-1.5 text-xs font-medium text-white rounded-lg transition-colors"
          style={{ backgroundColor: workspace === 'sports' ? '#16a34a' : '#2563eb' }}>
          + Add member
        </button>
      </div>

      <div className="p-6 max-w-5xl mx-auto">
        {error && !showAdd && !editId && (
          <p className="text-red-400 text-xs bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2 mb-4">{error}</p>
        )}

        {loading ? (
          <div className="flex items-center gap-3 py-12 text-gray-500">
            <div className="w-4 h-4 border-2 border-gray-600 border-t-gray-300 rounded-full animate-spin" />
            <span className="text-sm">Loading members…</span>
          </div>
        ) : (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-800/40">
                  {['Email', 'Role', 'Assigned Sites', 'Added', ''].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 text-[11px] text-gray-500 font-semibold uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-12 text-gray-500 text-sm">No members yet</td></tr>
                ) : members.map((m) => {
                  const isEditing = editId === m.id
                  if (isEditing) return (
                    <tr key={m.id} className="border-b border-gray-800/50 bg-gray-800/30 align-top">
                      <td className="px-4 py-3 text-white">{m.email}</td>
                      <td className="px-4 py-3">
                        <select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value as 'admin' | 'standard' })}
                          className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500">
                          <option value="admin">Admin</option>
                          <option value="standard">Standard</option>
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        {editForm.role === 'admin' ? (
                          <span className="text-xs text-gray-500">All sites</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5 max-w-md">
                            {sites.map((s) => {
                              const on = editForm.sites.includes(s.site_id)
                              return (
                                <button key={s.site_id} type="button" onClick={() => setEditForm({ ...editForm, sites: toggleSite(editForm.sites, s.site_id) })}
                                  className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${on ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'}`}>
                                  {s.name}
                                </button>
                              )
                            })}
                          </div>
                        )}
                        <input type="password" value={editForm.password} onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                          placeholder="New password (optional)"
                          className="mt-2 block w-56 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{new Date(m.created_at).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <button onClick={() => saveEdit(m.id)} disabled={busyId === m.id} className="text-xs bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded disabled:opacity-50">{busyId === m.id ? '…' : 'Save'}</button>
                          <button onClick={() => setEditId(null)} className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-2 py-1 rounded">Cancel</button>
                        </div>
                      </td>
                    </tr>
                  )

                  return (
                    <tr key={m.id} className="border-b border-gray-800/40 hover:bg-gray-800/25 transition-colors group">
                      <td className="px-4 py-3 text-white font-medium">{m.email}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${m.role === 'admin' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'bg-gray-700 text-gray-300 border border-gray-600'}`}>
                          {m.role === 'admin' ? 'Admin' : 'Standard'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {m.role === 'admin' ? (
                          <span className="text-xs text-gray-500">All sites</span>
                        ) : m.assigned_sites.length === 0 ? (
                          <span className="text-xs text-gray-600">None assigned</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {m.assigned_sites.map((id) => (
                              <span key={id} className="text-[11px] px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-300">{siteName(id)}</span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{new Date(m.created_at).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        {confirmDeleteId === m.id ? (
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-gray-300">Remove?</span>
                            <button onClick={() => removeMember(m.id)} disabled={busyId === m.id} className="text-xs text-red-400 hover:text-red-300 font-semibold">Yes</button>
                            <span className="text-xs text-gray-600">·</span>
                            <button onClick={() => setConfirmDeleteId(null)} className="text-xs text-gray-400 hover:text-gray-300">No</button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => startEdit(m)} className="p-1.5 text-gray-500 hover:text-blue-400 hover:bg-gray-700/60 rounded-lg" title="Edit">✏️</button>
                            <button onClick={() => setConfirmDeleteId(m.id)} className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-gray-700/60 rounded-lg" title="Remove">🗑</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add member modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-20" onClick={() => setShowAdd(false)}>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-white mb-4">Add member</h2>
            <form onSubmit={addMember} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 font-medium mb-1">Email</label>
                <input type="email" required value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" placeholder="member@example.com" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 font-medium mb-1">Password</label>
                <input type="text" required minLength={6} value={addForm.password} onChange={(e) => setAddForm({ ...addForm, password: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" placeholder="At least 6 characters" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 font-medium mb-1">Role</label>
                <select value={addForm.role} onChange={(e) => setAddForm({ ...addForm, role: e.target.value as 'admin' | 'standard' })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500">
                  <option value="standard">Standard — assigned sites only</option>
                  <option value="admin">Admin — full access, all sites</option>
                </select>
              </div>
              {addForm.role === 'standard' && (
                <div>
                  <label className="block text-xs text-gray-400 font-medium mb-1.5">Assigned sites</label>
                  <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
                    {sites.map((s) => {
                      const on = addForm.sites.includes(s.site_id)
                      return (
                        <button key={s.site_id} type="button" onClick={() => setAddForm({ ...addForm, sites: toggleSite(addForm.sites, s.site_id) })}
                          className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${on ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'}`}>
                          {s.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {error && <p className="text-red-400 text-xs bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{error}</p>}
              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={saving} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg text-sm disabled:opacity-50">{saving ? 'Adding…' : 'Add member'}</button>
                <button type="button" onClick={() => setShowAdd(false)} className="px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
