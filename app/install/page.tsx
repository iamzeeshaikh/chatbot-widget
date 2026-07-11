'use client'

// Public install-helper page (chat.zeeops.dev/install) — sent to agents so
// each device gets the right steps. On Android it can trigger the native
// install prompt directly; iOS only allows manual Add-to-Home-Screen, so it
// walks through it. No auth required (middleware only guards / and /members).

import { useEffect, useState } from 'react'

type Platform = 'ios' | 'android' | 'desktop'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export default function InstallPage() {
  const [platform, setPlatform] = useState<Platform>('desktop')
  const [installed, setInstalled] = useState(false)
  const [inAppBrowser, setInAppBrowser] = useState(false)
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const ua = navigator.userAgent
    if (/iPhone|iPad|iPod/.test(ua)) setPlatform('ios')
    else if (/Android/.test(ua)) setPlatform('android')
    // Already running as the installed app?
    if (window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone) {
      setInstalled(true)
    }
    // In-app browsers (WhatsApp/Facebook/Instagram) can't install anything.
    if (/FBAN|FBAV|Instagram|WhatsApp|Line\/|Snapchat/i.test(ua)) setInAppBrowser(true)
    const onPrompt = (e: Event) => { e.preventDefault(); setPromptEvent(e as BeforeInstallPromptEvent) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  async function installNow() {
    if (!promptEvent) return
    await promptEvent.prompt()
    const choice = await promptEvent.userChoice
    if (choice.outcome === 'accepted') setDone(true)
  }

  const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
    <div className="flex items-start gap-3 py-2.5">
      <span className="w-7 h-7 rounded-full bg-blue-600 text-white text-sm font-bold flex items-center justify-center shrink-0">{n}</span>
      <div className="text-sm text-gray-800 leading-relaxed pt-0.5">{children}</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-100 flex items-start justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto mb-3 shadow-lg">
            <svg viewBox="0 0 24 24" className="w-8 h-8 fill-white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Install the ZeeOps App</h1>
          <p className="text-sm text-gray-500 mt-1">Agent dashboard on your phone — with chat notifications even when the app is closed.</p>
        </div>

        {installed || done ? (
          <div className="bg-green-100 border border-green-300 rounded-2xl p-5 text-center">
            <p className="text-2xl mb-1">✅</p>
            <p className="text-sm font-semibold text-green-700">App installed!</p>
            <p className="text-xs text-gray-700 mt-2">Open it from your home screen, sign in, then tap the <b>📳 button</b> in the header and allow notifications — new customer chats will ping this device even when the app is closed.</p>
          </div>
        ) : inAppBrowser ? (
          <div className="bg-amber-100 border border-amber-300 rounded-2xl p-5">
            <p className="text-sm font-semibold text-amber-700 mb-1">⚠ You&apos;re inside another app&apos;s browser</p>
            <p className="text-sm text-gray-800">Apps like WhatsApp can&apos;t install anything. Tap the menu (⋮ or …) and choose <b>&quot;Open in browser&quot;</b> / <b>&quot;Open in Safari&quot;</b>, then come back to this page.</p>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
            {platform === 'android' && (
              <>
                <p className="text-sm font-semibold text-gray-900 mb-2">📱 Android</p>
                {promptEvent ? (
                  <button onClick={installNow}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl text-sm transition-colors mb-3">
                    📲 Install App now
                  </button>
                ) : (
                  <p className="text-xs text-gray-500 mb-2">If no install button appears, do it manually:</p>
                )}
                <Step n={1}>Open this page in <b>Chrome</b> (not inside WhatsApp/Facebook).</Step>
                <Step n={2}>Tap the <b>⋮ menu</b> (top right).</Step>
                <Step n={3}>Tap <b>&quot;Install app&quot;</b> or <b>&quot;Add to Home screen&quot;</b> → <b>Install</b>.</Step>
              </>
            )}
            {platform === 'ios' && (
              <>
                <p className="text-sm font-semibold text-gray-900 mb-1">🍎 iPhone / iPad</p>
                <p className="text-xs text-gray-500 mb-2">Must be done in <b>Safari</b>.</p>
                <Step n={1}>Open <b>chat.zeeops.dev/install</b> in <b>Safari</b> (the blue compass icon 🧭).</Step>
                <Step n={2}>Tap the <b>Share</b> button — the square with an arrow pointing up <b>□↑</b> (bottom bar, or next to the address bar).</Step>
                <Step n={3}>A panel slides up. <b>Scroll DOWN past the app icons</b> — keep going through the list of actions.</Step>
                <Step n={4}>Tap <b>&quot;Add to Home Screen&quot;</b> ➕ then <b>Add</b>.</Step>
                <div className="mt-3 bg-gray-50 border border-gray-200 rounded-xl p-3">
                  <p className="text-xs text-gray-700 leading-relaxed">
                    <b>Don&apos;t see &quot;Add to Home Screen&quot;?</b><br />
                    • Scroll to the very bottom of that panel → tap <b>&quot;Edit Actions…&quot;</b> → tap the green ➕ next to &quot;Add to Home Screen&quot;.<br />
                    • Make sure you&apos;re in Safari itself — links opened from WhatsApp open a mini-browser that can&apos;t install. Copy the address and paste it into Safari.
                  </p>
                </div>
              </>
            )}
            {platform === 'desktop' && (
              <>
                <p className="text-sm font-semibold text-gray-900 mb-2">💻 Computer (Chrome / Edge)</p>
                {promptEvent && (
                  <button onClick={installNow}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl text-sm transition-colors mb-3">
                    📲 Install App now
                  </button>
                )}
                <Step n={1}>Open <b>chat.zeeops.dev</b> in Chrome or Edge.</Step>
                <Step n={2}>Look at the right end of the address bar for the <b>install icon</b> (a screen with a down arrow).</Step>
                <Step n={3}>Click it → <b>Install</b>. The app opens in its own window and lands in your Dock / Start Menu.</Step>
              </>
            )}
          </div>
        )}

        <div className="text-center mt-5">
          <a href="/login" className="text-sm text-blue-600 hover:text-blue-700 font-medium">Already installed? Sign in →</a>
        </div>
      </div>
    </div>
  )
}
