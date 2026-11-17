import ZdApp from './ZdApp'

// The ZeeDesk workspace. Members never see this path: middleware.ts serves it
// at "/" for a ZeeDesk session, so their address bar stays on the root.
export default function ZeeDeskHome() {
  return <ZdApp />
}
