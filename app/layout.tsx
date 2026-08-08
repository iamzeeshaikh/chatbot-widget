import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import DeployRefresh from "./components/DeployRefresh";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ZeeOps Dashboard",
  description: "ZeeOps chatbot management dashboard",
  // Installable-app (PWA) metadata for agents' phones/desktops.
  appleWebApp: {
    capable: true,
    title: "ZeeOps",
    statusBarStyle: "default",
  },
  // No `icons` field on purpose. The icons come from the App Router file
  // convention instead — app/favicon.ico, app/icon.svg and app/apple-icon.png —
  // which emits the <link> tags with content-hashed URLs and serves
  // /favicon.ico for the legacy request browsers make whether we link it or
  // not. Declaring `icons` here would override those files with hand-written
  // paths and put us back to maintaining two lists.
  // Stops Chrome offering to translate the dashboard at all — see the
  // translate="no" note on <html> below for why that matters here.
  other: { google: "notranslate" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // translate="no" is load-bearing, not cosmetic. Google Translate (and other
    // DOM-rewriting extensions) replace text nodes in place; React then tries to
    // update a node whose parent it no longer owns and dies with
    // "Cannot read properties of null (reading 'removeChild')". On a dashboard
    // that re-renders long lists on every poll that happens constantly, and it
    // strands client-side navigation — the URL changes but the page never swaps
    // until a hard refresh. Machine-translating agent names, statuses and site
    // ids would be wrong anyway.
    <html
      lang="en"
      translate="no"
      className={`notranslate ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        {/* Stale-tab recovery: detects a new deployment under a long-lived
            tab and reloads it (hidden) or offers a reload (visible). In the
            root layout so pipeline, tasks and lead records inherit it too. */}
        <DeployRefresh />
        {/* Register the service worker so the dashboard installs as a PWA. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) { window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); }); }`,
          }}
        />
      </body>
    </html>
  );
}
