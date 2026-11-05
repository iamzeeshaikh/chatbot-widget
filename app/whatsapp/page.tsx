import InboxView from '../inbox/InboxView'

// WhatsApp on its own — /whatsapp. The same list and chat the Inbox's WhatsApp
// folder shows, in a page of its own so the team can keep it open in a
// separate window and answer from there (owner, 2026-11-05).
export default function WhatsAppPage() {
  return <InboxView mode="whatsapp" />
}
