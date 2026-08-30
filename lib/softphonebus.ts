'use client'

// The one wire between "a lead page wants to call somebody" and "the softphone,
// which lives in the root layout, owns the microphone".
//
// The softphone has to be mounted ONCE, above the router: an incoming call must
// ring wherever the agent happens to be, and a Device torn down and rebuilt on
// every navigation would drop a call mid-sentence. The button that starts a
// call, though, lives on a lead page, several routes below it.
//
// React context would mean wrapping the whole tree in a client provider and
// threading it through pages that are otherwise server-rendered. Both sides are
// in the same bundle, so a module-scope subscription is smaller, needs no
// provider, and cannot re-render anything by existing.

type CallRequest = { leadId: string; leadName: string }

let handler: ((req: CallRequest) => void) | null = null
let ready = false
const readyWatchers = new Set<(v: boolean) => void>()

/** The softphone claims the line. Returns its own unsubscribe. */
export function attachSoftphone(fn: (req: CallRequest) => void): () => void {
  handler = fn
  return () => { if (handler === fn) handler = null }
}

/** The softphone says whether it is registered and able to place a call. */
export function setSoftphoneReady(v: boolean): void {
  ready = v
  for (const w of readyWatchers) w(v)
}

export function softphoneReady(): boolean {
  return ready
}

export function watchSoftphoneReady(fn: (v: boolean) => void): () => void {
  readyWatchers.add(fn)
  fn(ready)
  return () => { readyWatchers.delete(fn) }
}

/** A page asks for a call. False means there is no softphone to take it, and
 *  the caller should fall back to ringing the agent's own phone. */
export function requestBrowserCall(req: CallRequest): boolean {
  if (!handler || !ready) return false
  handler(req)
  return true
}
