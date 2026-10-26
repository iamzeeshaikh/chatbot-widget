// Bank details printed on an invoice when the customer pays by bank transfer
// (owner, 2026-10-26: the ZCB Digital Ltd GBP account on Wise). Kept in the
// Vercel env var BANK_DETAILS_PACKAGING (multi-line text), NOT in the repo —
// the repo is public. Packaging only; sports is PayPal only.

export function isBankTransfer(paymentTerms: string): boolean {
  return /\b(wire|bank|transfer|wise|iban|swift|ach)\b/i.test(paymentTerms)
}

export function bankDetails(workspace: string): string {
  if (workspace !== 'packaging') return ''
  return String(process.env.BANK_DETAILS_PACKAGING ?? '').replace(/\\n/g, '\n').trim()
}
