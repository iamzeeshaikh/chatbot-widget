// Detects conversation-closing pleasantries — "Thank you!", "ok great",
// "sounds good 👍", "bye" — so a customer politely ending a chat doesn't count
// as "waiting for an agent reply" (queue, alert chime, no-reply badges, and
// the Performance dropped/missed logic all use this). Client-safe: no imports.
//
// Deliberately conservative: short messages only, and every word must come
// from the closing vocabulary — anything with real content ("thanks, but what
// about the lids?") keeps counting as waiting.

const CLOSING_WORDS = new Set([
  'thank', 'thanks', 'thankyou', 'thx', 'ty', 'tysm', 'you', 'u', 'so', 'very',
  'much', 'a', 'lot', 'ok', 'okay', 'k', 'great', 'perfect', 'awesome',
  'sounds', 'good', 'got', 'it', 'alright', 'right', 'cool', 'bye', 'goodbye',
  'welcome', 'noted', 'sure', 'fine', 'nice', 'day', 'have', 'appreciate',
  'appreciated', 'that', 'is', 'thats', 'all', 'wonderful', 'excellent',
  'amazing', 'understood', 'done', 'deal', 'no', 'problem', 'np', 'god',
  'bless', 'sir', 'dear', 'will', 'do', 'waiting', 'ill', 'wait', 'then',
])

export function isClosingMessage(text: string | null | undefined): boolean {
  if (!text) return false
  const trimmed = text.trim()
  if (trimmed.length > 80) return false
  const words = trimmed.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
  // No letters at all (e.g. "👍", "🙏🙏") — a short reaction, counts as closing.
  if (words.length === 0) return trimmed.length <= 8
  if (words.length > 8) return false
  return words.every((w) => CLOSING_WORDS.has(w))
}
