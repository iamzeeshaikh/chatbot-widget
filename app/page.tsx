import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

interface Lead {
  id: string
  site_id: string
  name: string | null
  email: string | null
  phone: string | null
  message: string | null
  created_at: string
}

interface Site {
  site_id: string
  name: string
  bot_name: string
  primary_color: string
}

interface SiteWithCount extends Site {
  leadCount: number
}

async function getData(): Promise<{ sites: SiteWithCount[]; leads: Lead[] }> {
  const [sitesRes, leadsRes] = await Promise.all([
    supabase.from('sites').select('site_id, name, bot_name, primary_color').order('created_at'),
    supabase.from('leads').select('*').order('created_at', { ascending: false }).limit(50),
  ])

  const sites = (sitesRes.data ?? []) as Site[]
  const leads = (leadsRes.data ?? []) as Lead[]

  const sitesWithCount: SiteWithCount[] = sites.map((site) => ({
    ...site,
    leadCount: leads.filter((l) => l.site_id === site.site_id).length,
  }))

  return { sites: sitesWithCount, leads }
}

export default async function AdminDashboard() {
  const { sites, leads } = await getData()

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white">Chatbot Widget Dashboard</h1>
          <p className="text-gray-400 mt-1">Manage your sites, leads, and conversations</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Total Sites</p>
            <p className="text-3xl font-bold text-white mt-1">{sites.length}</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Total Leads</p>
            <p className="text-3xl font-bold text-white mt-1">{leads.length}</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Active Bots</p>
            <p className="text-3xl font-bold text-white mt-1">{sites.length}</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Today&apos;s Leads</p>
            <p className="text-3xl font-bold text-white mt-1">
              {leads.filter((l) => l.created_at?.startsWith(new Date().toISOString().split('T')[0])).length}
            </p>
          </div>
        </div>

        {/* Sites */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-white mb-4">Configured Sites</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {sites.map((site) => (
              <div key={site.site_id} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold"
                    style={{ backgroundColor: site.primary_color }}
                  >
                    {site.bot_name?.[0] ?? 'B'}
                  </div>
                  <div>
                    <p className="font-semibold text-white text-sm">{site.name}</p>
                    <p className="text-gray-400 text-xs">{site.bot_name}</p>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-gray-500 font-mono bg-gray-800 px-2 py-1 rounded">{site.site_id}</span>
                  <span className="text-xs text-gray-400">{site.leadCount} leads</span>
                </div>
                <div className="mt-3 pt-3 border-t border-gray-800">
                  <p className="text-xs text-gray-500 font-mono break-all">
                    {'<script src="YOUR_URL/widget.js?siteId='}
                    {site.site_id}
                    {'"></script>'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Leads */}
        <div>
          <h2 className="text-xl font-semibold text-white mb-4">Recent Leads</h2>
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-800/50">
                    <th className="text-left px-4 py-3 text-gray-400 font-medium">Name</th>
                    <th className="text-left px-4 py-3 text-gray-400 font-medium">Email</th>
                    <th className="text-left px-4 py-3 text-gray-400 font-medium">Phone</th>
                    <th className="text-left px-4 py-3 text-gray-400 font-medium">Site</th>
                    <th className="text-left px-4 py-3 text-gray-400 font-medium">Message</th>
                    <th className="text-left px-4 py-3 text-gray-400 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-center py-8 text-gray-500">
                        No leads yet
                      </td>
                    </tr>
                  ) : (
                    leads.map((lead) => (
                      <tr key={lead.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-3 text-white">{lead.name ?? '-'}</td>
                        <td className="px-4 py-3 text-blue-400">{lead.email ?? '-'}</td>
                        <td className="px-4 py-3 text-gray-300">{lead.phone ?? '-'}</td>
                        <td className="px-4 py-3">
                          <span className="bg-gray-800 text-gray-300 text-xs px-2 py-1 rounded font-mono">
                            {lead.site_id}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-400 max-w-xs truncate">{lead.message ?? '-'}</td>
                        <td className="px-4 py-3 text-gray-500 text-xs">
                          {lead.created_at ? new Date(lead.created_at).toLocaleString() : '-'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
