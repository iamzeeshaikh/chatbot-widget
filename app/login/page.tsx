import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { WORKSPACE_LABEL, workspaceForHost } from '@/lib/workspaces'
import LoginForm from './LoginForm'

// Server component purely so the hostname is known before first paint: which
// dashboard this is must not flash or be decided by the browser. The form
// itself is the client half.
async function hostWorkspace() {
  const h = await headers()
  return workspaceForHost(h.get('x-forwarded-host') || h.get('host'))
}

export async function generateMetadata(): Promise<Metadata> {
  const ws = await hostWorkspace()
  return { title: ws ? `Sign in · ${WORKSPACE_LABEL[ws]} Dashboard | ZeeOps` : 'Sign in | ZeeOps' }
}

export default async function LoginPage() {
  return <LoginForm workspace={await hostWorkspace()} />
}
