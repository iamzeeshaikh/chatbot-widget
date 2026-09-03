// The formatted half of an email: a small, closed set of HTML we are willing
// to send, and the plain-text version that travels beside it.
//
// WHY A WHITELIST AND NOT A LIBRARY: this HTML is written by our own agents,
// but it is stored and then RENDERED BACK into the dashboard's timeline. That
// makes it the same class of input as anything else a person types into a
// field somebody else will read — a pasted `<img onerror=…>` from a website
// would run in the next agent's browser. Everything not on the list below is
// dropped, attributes included, so there is nothing to get wrong later.
//
// The plain-text version is not optional politeness. A mail client that cannot
// or will not show HTML falls back to text/plain, and if that part is missing
// or empty the recipient gets a blank email.

const ALLOWED = new Set([
  'b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'p', 'br', 'div', 'span', 'blockquote',
])

/** Strip everything we are not prepared to send or re-render. */
export function sanitizeHtml(input: string): string {
  let html = String(input ?? '')
  // Whole elements whose CONTENT is dangerous, not just their tags — removing
  // `<script>` alone would leave the code behind as text and then re-run it
  // the moment something re-wrapped it.
  html = html.replace(/<(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\/\1>/gi, '')
  html = html.replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, '')

  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (whole, rawTag: string, attrs: string) => {
    const tag = rawTag.toLowerCase()
    if (!ALLOWED.has(tag)) return ''
    if (whole.startsWith('</')) return `</${tag}>`
    if (tag === 'a') {
      // Only http(s) and mailto. `javascript:` in an href is the oldest trick
      // there is, and a relative link in an email goes nowhere anyway.
      const m = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
      const href = (m?.[2] ?? m?.[3] ?? m?.[4] ?? '').trim()
      if (!/^(https?:\/\/|mailto:)/i.test(href)) return '<a>'
      const safe = href.replace(/"/g, '&quot;')
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">`
    }
    // Everything else keeps the tag and loses every attribute — no style, no
    // class, no event handler, nothing to audit.
    return `<${tag}>`
  })
  return html
}

/** The text/plain twin of a formatted body. */
export function htmlToPlain(html: string): string {
  return String(html ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|blockquote)\s*>/gi, '\n')
    .replace(/<\s*li\s*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Plain text as HTML, for the reverse direction — a body typed with no
 *  formatting still has to arrive as a readable HTML part. */
export function plainToHtml(text: string): string {
  const esc = String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc.split('\n').map((l) => l || '<br>').join('<br>')
}
