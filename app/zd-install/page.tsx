'use client'

// ZeeDesk's install helper (app.zeedesk.dev/install). Same job as the ZeeOps
// one, written in ZeeDesk's palette and words: on Android and desktop Chrome it
// can fire the browser's own install prompt; iPhone only allows the manual
// Add to Home Screen, so it walks through that. No sign-in needed.

import { useEffect, useState } from 'react'
import { CheckCircle2, TriangleAlert, Smartphone, Apple, Monitor, Download, ArrowRight } from 'lucide-react'

type Platform = 'ios' | 'android' | 'desktop'
interface BeforeInstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#03363d] text-[12px] font-semibold text-white">{n}</span>
      <span className="text-[14px] leading-relaxed text-[#2f3941]">{children}</span>
    </li>
  )
}

export default function ZdInstallPage() {
  const [platform, setPlatform] = useState<Platform>('desktop')
  const [installed, setInstalled] = useState(false)
  const [inApp, setInApp] = useState(false)
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [host, setHost] = useState('this address')

  useEffect(() => {
    const first = setTimeout(() => {
      const ua = navigator.userAgent
      if (/iPhone|iPad|iPod/.test(ua)) setPlatform('ios')
      else if (/Android/.test(ua)) setPlatform('android')
      if (window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone) setInstalled(true)
      if (/FBAN|FBAV|Instagram|WhatsApp|Line\/|Snapchat/i.test(ua)) setInApp(true)
      setHost(window.location.host)
    }, 0)
    const onPrompt = (e: Event) => { e.preventDefault(); setPromptEvent(e as BeforeInstallPromptEvent) }
    const onDone = () => setInstalled(true)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onDone)
    return () => { clearTimeout(first); window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onDone) }
  }, [])

  async function installNow() {
    if (!promptEvent) return
    await promptEvent.prompt()
    if ((await promptEvent.userChoice).outcome === 'accepted') setInstalled(true)
  }

  const installButton = promptEvent && (
    <button type="button" onClick={installNow} className="mb-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#03363d] text-[15px] font-semibold text-white transition hover:bg-[#0b4a52]">
      <Download size={17} aria-hidden /> Install ZeeDesk now
    </button>
  )

  return (
    <div className="min-h-screen bg-[#f8f9f9] px-4 py-10 text-[#2f3941]" style={{ fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/zd-icons/icon.svg" alt="" width={64} height={64} className="mx-auto mb-4 rounded-2xl shadow-lg" />
          <h1 className="text-[24px] font-semibold tracking-tight text-[#03363d]">Install ZeeDesk</h1>
          <p className="mt-1.5 text-[14px] text-[#68737d]">Open your desk from the home screen or the dock, in its own window.</p>
        </div>

        {installed ? (
          <div className="rounded-2xl border border-[#b7e0cf] bg-[#edf8f4] p-5 text-center">
            <CheckCircle2 size={26} className="mx-auto mb-1 text-[#038153]" aria-hidden />
            <p className="text-[14px] font-semibold text-[#038153]">ZeeDesk is installed</p>
            <p className="mt-1.5 text-[13px] text-[#49545c]">Open it from your home screen or dock and sign in.</p>
          </div>
        ) : inApp ? (
          <div className="rounded-2xl border border-[#f1d2a8] bg-[#fff3e4] p-5">
            <p className="mb-1 flex items-center gap-1.5 text-[14px] font-semibold text-[#ad5918]"><TriangleAlert size={15} aria-hidden /> You are inside another app&apos;s browser</p>
            <p className="text-[14px] text-[#2f3941]">Apps like WhatsApp cannot install anything. Open the menu and choose <b>Open in browser</b> or <b>Open in Safari</b>, then come back to this page.</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-[#d8dcde] bg-white p-5">
            {platform === 'android' && (
              <>
                <p className="mb-3 flex items-center gap-1.5 text-[14px] font-semibold"><Smartphone size={15} aria-hidden /> Android</p>
                {installButton || <p className="mb-1 text-[13px] text-[#68737d]">No install button? Do it by hand:</p>}
                <ol>
                  <Step n={1}>Open this page in <b>Chrome</b>, not inside WhatsApp or Facebook.</Step>
                  <Step n={2}>Tap the <b>three-dot menu</b> at the top right.</Step>
                  <Step n={3}>Tap <b>Install app</b> or <b>Add to Home screen</b>, then <b>Install</b>.</Step>
                </ol>
              </>
            )}
            {platform === 'ios' && (
              <>
                <p className="mb-1 flex items-center gap-1.5 text-[14px] font-semibold"><Apple size={15} aria-hidden /> iPhone or iPad</p>
                <p className="mb-1 text-[13px] text-[#68737d]">This has to be done in <b>Safari</b>.</p>
                <ol>
                  <Step n={1}>Open <b>{host}/install</b> in <b>Safari</b>.</Step>
                  <Step n={2}>Tap the <b>Share</b> button, the square with an arrow pointing up.</Step>
                  <Step n={3}>Scroll down the list and tap <b>Add to Home Screen</b>, then <b>Add</b>.</Step>
                </ol>
                <p className="mt-3 rounded-xl bg-[#f8f9f9] p-3 text-[13px] leading-relaxed text-[#49545c]">
                  <b>Cannot see Add to Home Screen?</b> Scroll to the bottom of that list, tap <b>Edit Actions</b> and add it. A link opened from WhatsApp is not Safari: copy the address and paste it into Safari.
                </p>
              </>
            )}
            {platform === 'desktop' && (
              <>
                <p className="mb-3 flex items-center gap-1.5 text-[14px] font-semibold"><Monitor size={15} aria-hidden /> Computer (Chrome or Edge)</p>
                {installButton}
                <ol>
                  <Step n={1}>Open <b>{host}</b> in Chrome or Edge.</Step>
                  <Step n={2}>At the right end of the address bar, click the <b>install icon</b> (a screen with a down arrow).</Step>
                  <Step n={3}>Click <b>Install</b>. ZeeDesk opens in its own window and stays in your dock or Start menu.</Step>
                </ol>
              </>
            )}
          </div>
        )}

        <p className="mt-6 text-center">
          <a href="/login" className="inline-flex items-center gap-1.5 text-[14px] font-medium text-[#1f73b7] hover:underline">Already installed? Sign in <ArrowRight size={15} aria-hidden /></a>
        </p>
      </div>
    </div>
  )
}
