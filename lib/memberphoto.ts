// A team member's profile photo (owner, 2026-10-28: Samir's photo in the CRM).
// No DDL: the photo is a file in the public chat-attachments bucket at
// member-photos/<email>.jpg, so the URL follows from the address alone. A
// member without one simply shows their initials (the <img> removes itself).
export function memberPhotoUrl(email: string | null | undefined): string | null {
  const e = String(email ?? '').trim().toLowerCase()
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!e || !base) return null
  return `${base.replace(/\/$/, '')}/storage/v1/object/public/chat-attachments/member-photos/${encodeURIComponent(e)}.jpg`
}
