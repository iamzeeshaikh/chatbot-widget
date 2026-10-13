import { NextRequest, NextResponse } from 'next/server'
import { emailFromToken, recordUnsubscribe } from '@/lib/unsubscribe'

export const dynamic = 'force-dynamic'

// The unsubscribe link in a promotional email (lib/unsubscribe.ts).
//
// GET shows a page with one button and changes nothing: mail scanners and link
// previews open every URL in a message, and a GET that unsubscribed would
// unsubscribe people who never clicked. POST does it — from that button, or
// from Gmail's own "Unsubscribe" (RFC 8058 one-click, List-Unsubscribe-Post).

const page = (title: string, body: string) => new NextResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f3f4f6;color:#111827}main{max-width:440px;margin:12vh auto;padding:32px 28px;background:#fff;border:1px solid #e5e7eb;border-radius:14px}h1{font-size:20px;margin:0 0 10px}p{color:#4b5563;line-height:1.55;margin:0 0 18px}button{font:inherit;font-weight:600;padding:10px 18px;border-radius:9px;border:0;background:#111827;color:#fff;cursor:pointer}</style></head><body><main>${body}</main></body></html>`,
  { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const email = emailFromToken(token)
  if (!email) return page('Link not valid', '<h1>This link is not valid</h1><p>It may have been cut short by your mail app. Reply to the email with "unsubscribe" and we will take care of it.</p>')
  return page('Unsubscribe', `<h1>Unsubscribe from offers?</h1><p>We will stop sending holiday offers and promotions to <b>${email.replace(/[<>&"]/g, '')}</b>. Replies about an order or a quote you asked for are not affected.</p><form method="post"><button type="submit">Unsubscribe</button></form>`)
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const email = emailFromToken(token)
  if (!email) return page('Link not valid', '<h1>This link is not valid</h1>')
  await recordUnsubscribe(email, 'link')
  return page('Unsubscribed', `<h1>You are unsubscribed</h1><p>${email.replace(/[<>&"]/g, '')} will not receive our offers any more.</p>`)
}
