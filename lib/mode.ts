import { supabase } from './supabase'

// Conversation mode (bot vs human takeover) is persisted as a control row in
// chat_logs with role 'mode' and message 'bot' | 'human'. The current mode is
// the most recent such row for the session. (There is no dedicated
// conversation_mode table in this database, so we store it here.)
export type ConvMode = 'bot' | 'human'

export const MODE_ROLE = 'mode'

export async function getMode(sessionId: string): Promise<ConvMode> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message')
    .eq('session_id', sessionId)
    .eq('role', MODE_ROLE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.message === 'human' ? 'human' : 'bot'
}

export async function setMode(sessionId: string, siteId: string, mode: ConvMode): Promise<void> {
  await supabase.from('chat_logs').insert({
    site_id: siteId,
    session_id: sessionId,
    role: MODE_ROLE,
    message: mode,
  })
}

// Derive each session's current mode from a batch of chat_logs rows (used by the
// conversations list, which already fetches all logs). Rows must be passed in
// ascending created_at order so the last 'mode' row per session wins.
export function deriveModes(logsAscending: { session_id: string; role: string; message: string }[]): Record<string, ConvMode> {
  const modes: Record<string, ConvMode> = {}
  for (const log of logsAscending) {
    if (log.role === MODE_ROLE) modes[log.session_id] = log.message === 'human' ? 'human' : 'bot'
  }
  return modes
}
