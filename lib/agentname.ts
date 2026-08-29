// The name a CUSTOMER sees when a human answers them in the widget.
//
// Why it exists: the widget showed every reply the same way, so an agent's
// answer was indistinguishable from the bot's. A visitor who thinks they are
// still talking to a robot writes to a robot — shorter, warier, and often not
// at all. Putting a person's name on the bubble is the whole difference.
//
// Where the name comes from: `members` carries an email and nothing else (no
// DDL in this project, so it cannot grow a `name` column), and the reply's own
// audit row (`reply_author`) records the email too. So the email is the source,
// and this tidies it into something a stranger can read:
//
//   samirkhan@shopcardboardboxes.com  -> "Samirkhan"
//   jennifer.wright@…                 -> "Jennifer Wright"
//   danny_diaz@…                      -> "Danny Diaz"
//   dev@zeecustomboxes.com            -> "Dev"
//
// A local part written as one word cannot be split reliably — "samirkhan" could
// be Samir Khan or Sam Irkhan — so it is left as one word rather than guessed
// at. If a nicer name is wanted, the answer is to let an admin set one per
// member (a control row, no DDL); this stays the fallback.

const SEPARATORS = /[._\-+]+/

export function agentDisplayName(email: string | null | undefined): string {
  const local = String(email ?? '').split('@')[0].trim()
  if (!local) return 'Support'
  return local
    .replace(/\d+/g, ' ')            // drop digits: "sarah2024" -> "sarah"
    .split(SEPARATORS)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .trim() || 'Support'
}
