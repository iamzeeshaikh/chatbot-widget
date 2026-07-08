import { NextRequest, NextResponse } from 'next/server'
import { stampTyping, VISITOR_TYPING_KEY } from '@/lib/typing'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

// Widget → "the visitor is typing". Throttled client-side (one ping / 3s).
export async function POST(req: NextRequest) {
  try {
    const { sessionId } = await req.json()
    if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400, headers: corsHeaders })
    await stampTyping(String(sessionId), VISITOR_TYPING_KEY)
    return NextResponse.json({ ok: true }, { headers: corsHeaders })
  } catch {
    return NextResponse.json({ ok: false }, { headers: corsHeaders })
  }
}
