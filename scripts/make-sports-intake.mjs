// Generates scripts/sports-quote-intake-apps-script.gs from the packaging one.
//
// WHY A GENERATOR AND NOT A SECOND HAND-EDITED FILE: the two mailboxes are
// separate Google accounts, so each needs its own Apps Script project, and the
// sports one must contain NOTHING about packaging — no site codes, no domains,
// no store names, not even in a comment. But the ENGINE (the search, the
// watermark, the quota budget, the body parser) is the same battle-tested code,
// and this project's recurring bug is a fix that lands in one copy and not the
// other. So: one engine, one roster swap, regenerated with
//   node scripts/make-sports-intake.mjs
// after any change to the packaging script. Every replacement below asserts it
// matched exactly once, so an edit that moves the ground under this generator
// fails loudly instead of silently producing a stale sports file.
import fs from 'node:fs';

const SRC = 'scripts/quote-intake-apps-script.gs';
const OUT = 'scripts/sports-quote-intake-apps-script.gs';
let s = fs.readFileSync(SRC, 'utf8');

const subs = [];
const sub = (from, to) => subs.push([from, to]);

// ── The header ───────────────────────────────────────────────────────────
sub(s.slice(0, s.indexOf(' */\n\n// ── Config') + 3), `/**
 * ZeeOps SPORTS Quote Lead Intake — Google Apps Script
 *
 * Runs inside the Gmail account that receives the sports sites' quote-form
 * mail (script.google.com), free, no third-party service.
 *
 * SPORTS ONLY. This script knows five sites and nothing else:
 *   TFU  texasfootballuniforms.com
 *   TVU  thevolleyballuniforms.com
 *   CSJ  californiasoccerjerseys.com
 *   FBJ  floridabasketballjerseys.com
 *   TBJ  thebaseballjerseys.com
 * The other ZeeOps dashboard has its own script, its own Gmail account and its
 * own sites; the two never share a mailbox, a label or a line of config. Mail
 * this script cannot place is left alone: no label, no ingest, one line in the
 * run log at most.
 *
 * HOW IT DECIDES WHICH SITE AN EMAIL BELONGS TO, strongest evidence first:
 *   1. a Gmail LABEL on the thread whose leaf name is one of the five codes
 *      above (or the site's written-out name — see LABEL_ALIASES). Nesting
 *      does not matter: "Sports/TVU" works.
 *   2. the form's own machine-written footer, if it has one ("Page URL:
 *      https://…", "Submitted from: https://…").
 *   3. the SENDER'S DISPLAY NAME ("The Volleyball Uniforms <…@gmail.com>") —
 *      needed because these five all mail through a Gmail account, so the
 *      sending domain identifies nothing. This one is the weakest evidence and
 *      is the only rule that also requires the body to be a filled-in form.
 * An email that matches none of the three is never ingested and never touched.
 *
 * HOW IT FINDS MAIL: the automatic run (processQuoteLeads, on a 30-minute
 * trigger) searches the mailbox for mail that has arrived since the last run,
 * and opens ONLY the threads carrying new messages — see the "Gmail call
 * budget" section for why that matters and what it costs. Threads it has dealt
 * with get "ZeeOps/Processed"; a thread it can place but cannot read a contact
 * out of gets "ZeeOps/Unmatched"; "ZeeOps/Ignore" put on by hand silences a
 * thread for good.
 *
 * FIRST-TIME SETUP
 *   1. Label the existing mail: one label per site (leaf name TFU/TVU/CSJ/
 *      FBJ/TBJ, or the site's name), applied to every past thread. A Gmail
 *      filter keeps future mail labelled automatically.
 *   2. Project Settings → Script Properties → ZEEOPS_WEBHOOK_SECRET.
 *   3. Run testConnection — expect "OK: webhook reachable, auth accepted."
 *   4. Run listSiteLabels — confirms the labels are seen and how big they are.
 *   5. Run previewLeads — a DRY RUN that sends nothing and prints what would
 *      be sent. Read it before step 6.
 *   6. Run processQuoteLeadsBackfill once — ingests every labelled thread,
 *      however old. Re-posting is harmless; the server dedupes.
 *   7. Triggers → processQuoteLeads every 30 minutes, dailyCatchUp daily.
 *
 * A thread labelled by hand LONG after its mail arrived is the failure this
 * design keeps guarding against: the message's own date is behind the
 * watermark, so an ordinary run would never look at it again. Two things stop
 * that — a thread that has never been handled is read in full regardless of the
 * watermark, and a deeper pass re-covers a wider window several times a day.
 */`);

// ── Roster: the only place a site is named ───────────────────────────────
sub(`// Your Gmail label names that mean "this is a real lead for this site" —
// matches lib/quoteintake.ts QUOTE_SITE_CODES on the server exactly. Matched
// by LEAF name (the part after the last "/"), so it doesn't matter which
// parent folder each one lives under. Add a line here the day you start
// labeling a new site (e.g. once TPC exists for The Paper Cups).
// Only codes that are ACTUALLY used as Gmail label leaf names belong here — a
// code listed here claims every thread carrying that label. TCS is confirmed
// from a real thread ("Extra Outsource Projects/tcs"). The rest of the 2026-07
// roster is in SITE_DOMAINS below but deliberately NOT here: their label names
// haven't been seen yet, and guessing one that means something else in this
// mailbox would file leads under the wrong site. Run listSiteLabels to see
// which labels exist and add them as they're confirmed.
var SITE_CODES = ['SCB', 'TTP', 'SFB', 'KBP', 'TBB', 'ZCB', 'TCP', 'TPC', 'PB', 'TCS', 'TWP', 'CPB', 'TCSL'];`,
`// The Gmail label leaf names that mean "this is a real lead for this site" —
// matched by LEAF name (the part after the last "/"), so the parent folder is
// free to be anything. These five must also exist in QUOTE_SITE_CODES on the
// server; a code the server does not know comes back as a 400 in the run log.
var SITE_CODES = ['TFU', 'TVU', 'CSJ', 'FBJ', 'TBJ'];`);

sub(`// SITE_CODES so that turning one back on is deleting one string from this line
// — nothing to remember, nothing to re-derive.
//
// NOTE: this switch is only HALF of it. The server has its own
// RETIRED_LEAD_SITES in lib/workspaces.ts holding 'thetubepackaging' and
// 'zeecustomboxes'. Bringing a site back needs BOTH: remove it here AND remove
// it there, then redeploy. Flipping only this one means the script forwards
// happily and the server silently drops every lead.
var IGNORED_LEAF_CODES = ['TTP', 'ZCB'];`,
`// SITE_CODES so that turning one back on is deleting one string from this line.
//
// NOTE: this switch is only HALF of it. The server keeps its own list of sites
// it no longer accepts leads for (RETIRED_LEAD_SITES in lib/workspaces.ts).
// Retiring a site needs BOTH; switching one back on likewise. Empty today —
// all five sports sites are live.
var IGNORED_LEAF_CODES = [];`);

sub(`// Labels whose leaf is a HUMAN-READABLE NAME rather than a short code. This
// mailbox turned out to use both conventions — "Extra Outsource Projects/tcs"
// is a code, "Extra Outsource Projects/ZEE Pack" is a name — and the matcher
// only ever compared the leaf against SITE_CODES, so every name-style label was
// dropped in silence however it was nested. (ZP was in SITE_DOMAINS and in the
// server's QUOTE_SITE_CODES the whole time; nothing but this lookup was missing.)
//
// Keys are lower-cased leaf names. Add one ONLY when the label has been
// confirmed to carry that site's form notifications — a wrong entry files real
// leads under the wrong site, which is worse than not ingesting them.
var LABEL_ALIASES = {`,
`// Labels whose leaf is a HUMAN-READABLE NAME rather than a short code, because
// a label gets typed by a person and "Volleyball Uniforms" is what a person
// types. Without this the matcher only ever compares the leaf against
// SITE_CODES, and a name-style label is dropped in silence however it is
// nested — a bug that cost weeks of unread leads on the other dashboard before
// this lookup existed.
//
// Keys are lower-cased leaf names. Add one ONLY when the label has been
// confirmed to carry that site's form notifications — a wrong entry files real
// leads under the wrong site, which is worse than not ingesting them.
var LABEL_ALIASES = {`);

sub(`  'zee pack': 'ZP',
  // CPB was in SITE_CODES all along, but this mailbox files its mail under
  // "Extra Outsource Projects/Perfume" — a name, not the code — so it matched
  // nothing. Only NEW mail is affected: the label's existing threads are from
  // Feb 2026 and sit far outside the watermark window, so a normal run will not
  // touch them. Run processQuoteLeadsBackfill if you do want those 7 messages.
  'perfume': 'CPB',
  // The Candle Sleeves files under "Extra Outsource Projects/Candle Sleeves".
  // TCSL was in SITE_DOMAINS and in the server's QUOTE_SITE_CODES from the
  // start, so the site resolved fine everywhere EXCEPT this lookup — its very
  // first lead (13 Aug 2026) was labeled correctly and still never ingested.
  // Note this is NOT "candle": that name belongs to The Candle Packaging (TCP),
  // a different site, so the alias has to carry the word "sleeves".
  'candle sleeves': 'TCSL',
};`,
`  'texas football': 'TFU',
  'texas football uniforms': 'TFU',
  'volleyball': 'TVU',
  'volleyball uniforms': 'TVU',
  'the volleyball uniforms': 'TVU',
  'california soccer': 'CSJ',
  'california soccer jerseys': 'CSJ',
  'florida basketball': 'FBJ',
  'florida basketball jerseys': 'FBJ',
  'baseball jerseys': 'TBJ',
  'the baseball jerseys': 'TBJ',
};`);

// ── Checkout: kept generic and inert ─────────────────────────────────────
sub(`// ── Checkout (cart order) emails ────────────────────────────────────────────
// WooCommerce "New order #6449" notifications live under ONE flat label rather
// than a per-site one, so the site has to come from somewhere else. These mails
// carry the store name in the subject — "[Shop Cardboard Boxes]: New order
// #6449" — which WooCommerce fills in from the store's own settings, so it is
// the store identifying itself rather than us guessing from sender text.
//
// Only consulted for threads under CHECKOUT_LABEL that carry no site-code
// label; a site-code label always wins. Unrecognised store names go to
// ZeeOps/Unmatched instead of being attributed to the wrong site.
var CHECKOUT_LABEL = 'checkout';`,
`// ── Checkout (cart order) emails ────────────────────────────────────────────
// INERT HERE, ON PURPOSE. None of the five sports sites sells online — every
// lead is a quote request — so there is no order mail, no "checkout" label in
// this mailbox, and this whole path no-ops (findCheckoutLabel_ returns null and
// the sweep returns immediately). It is left in place rather than deleted so
// the engine stays identical to the one it is generated from; if a sports site
// ever does take orders, fill in STORE_NAME_CODES with the store name its order
// mail puts in the subject and the path wakes up.
var CHECKOUT_LABEL = 'checkout';`);

sub(s.slice(s.indexOf('var STORE_NAME_CODES = {'), s.indexOf('};', s.indexOf('var STORE_NAME_CODES = {')) + 3),
`var STORE_NAME_CODES = {};
`);

sub(s.slice(s.indexOf('var SITE_DOMAINS = {'), s.indexOf('};', s.indexOf('var SITE_DOMAINS = {')) + 3),
`var SITE_DOMAINS = {
  TFU: 'texasfootballuniforms.com',
  TVU: 'thevolleyballuniforms.com',
  CSJ: 'californiasoccerjerseys.com',
  FBJ: 'floridabasketballjerseys.com',
  TBJ: 'thebaseballjerseys.com',
};
`);


// ── Comments that name the other dashboard's sites ───────────────────────
// The RULE each one teaches is kept; the packaging history that taught it is
// not. That history stays in the file it belongs to.
sub(`// processQuoteLeads only looks at mail from the last N days — a site label
// with a big historical backlog (ZCB, TCP) has MORE threads than any single
// run could safely re-scan, and Gmail's per-label thread order isn't
// reliably newest-first, so a fixed "first 150" cap silently missed brand
// new leads once a label passed that count (found via a real report: 3
// same-day ZCB leads never arrived, all already correctly labeled). Genuine`,
`// processQuoteLeads only looks at mail from the last N days — a site label
// with a big historical backlog has MORE threads than any single run could
// safely re-scan, and Gmail's per-label thread order isn't reliably
// newest-first, so a fixed "first N" cap silently misses brand new leads once
// a label passes that count. Genuine`);

sub(`// the search below. (Found live: Levi Lyons' 28 Jul enquiry landed in the ZCB
// thread that already carried Processed and was never ingested — the thread
// showed "19 deleted messages", i.e. every earlier submission had been in it
// too.) The unit of work is therefore a MESSAGE DATE, kept here: everything`,
`// the search below. (Seen for real on the other dashboard: an enquiry landed in
// a thread that already carried Processed and was never ingested, and every
// earlier submission had been in that same thread too.) The unit of work is
// therefore a MESSAGE DATE, kept here: everything`);

sub(`  // has that is NOT a recognised site code. 14 of the 23 packaging sites have
  // no code yet, so any thread filed under one of their labels is silently
  // ignored — this is how you find their real names instead of guessing them.`,
`  // has that is NOT a recognised site code. A thread filed under a label this
  // script does not know is silently ignored — this is how you find such a
  // label's real name instead of guessing it.`);

sub(`        // was simply the wrong instrument: 45,000+ threads, most of them other
        // packaging companies' form mail and cold sales pitches whose signature
        // block ("Name: … Phone: … Email: …") reads exactly like a submitted
        // form. Two rounds of narrowing still left it landing on a machinery
        // sales pitch and on mail belonging to another dashboard entirely. A`,
`        // was simply the wrong instrument: a busy mailbox is full of other
        // companies' form mail and cold sales pitches whose signature block
        // ("Name: … Phone: … Email: …") reads exactly like a submitted form.
        // Two rounds of narrowing still left the label landing on mail that was
        // nothing of the kind. A`);

sub(`  // notification that carries NO site label at all — nobody filed it, or Gmail
  // threaded it somewhere unexpected. Found live: a zeecustomboxes enquiry
  // (Levi Lyons, 28 Jul) that never reached the dashboard.`,
`  // notification that carries NO site label at all — nobody filed it, or Gmail
  // threaded it somewhere unexpected. This has cost real leads before: an
  // enquiry that simply never reached the dashboard because no label was on it.`);

sub(`// Three real leads were lost that way on 26 Aug 2026 (SFB 24 Aug, and SCB's
// 12:29am/4:01am/7:19am enquiries), all recovered only by a manual rewind.`,
`// Real leads have been lost exactly that way, recovered only by a manual
// rewind after somebody noticed they were missing.`);

sub(`// first version of the rule put it on other companies' mail (packagingbee,
// theproductboxes), and a warning label nobody trusts is worse than no label.`,
`// first version of the rule put it on other companies' mail, and a warning
// label nobody trusts is worse than no label at all.`);

sub(` * watermark, so no ordinary run will ever look at it again. Three real leads
 * were lost that way on 26 Aug 2026, and peptidesboxes/thecoffeesleeves mail
 * had been reaching the dashboard ONLY as manual forwards for a month for the
 * same reason: the forward was a new message, so it cleared the watermark that
 * the original no longer could.`,
` * watermark, so no ordinary run will ever look at it again. Real leads have
 * been lost that way, and other sites' mail reached the dashboard ONLY as
 * manual forwards for weeks for the same reason: the forward was a new
 * message, so it cleared the watermark that the original no longer could.`);

sub(`// The off switch has to be honoured HERE too. Turning TTP/ZCB off in
// codeFromLeaf_ only closed the label path: an unlabelled thread then fell
// through to this fallback, which resolved the same site from its "Page URL:"
// host and posted it anyway. The first run after the switch went in proved it
// — 24 no-label-fallback ingests, every one of them TTP or ZCB.`,
`// The off switch has to be honoured HERE too. Switching a site off in
// codeFromLeaf_ only closes the label path: an unlabelled thread then falls
// through to this fallback, which resolves the same site from its "Page URL:"
// host and posts it anyway. That happened for real — the first run after a
// switch went in ingested two dozen leads for the site that had just been
// turned off.`);

sub(`// "Page URL:" alone was the whole list until 27 Aug 2026, and that is the hole
// this recurring bug kept falling through: the check is only as wide as the
// templates it knows, and every site added since has mailed a different line.
// Measured against 600 stored leads at the time: peptidesboxes writes "New
// quote request from peptidesboxes.com" and never a Page URL at all, and
// thecoffeesleeves writes "Submitted from: https://...". Both were invisible
// here, so an unlabelled thread from either site could only ever be rescued by
// hand — which is exactly what was happening, one manual forward at a time.
// The colon is optional throughout: several of these forms mail the label
// bare ("Submitted from https://theburgersleeves.com/"), which is the same
// line without its punctuation.`,
`// "Page URL:" alone was the whole list once, and that is the hole this
// recurring bug kept falling through: the check is only as wide as the
// templates it knows, and every site added since mailed a different line. Sites
// whose footer was not in this list could only ever be rescued by hand, one
// manual forward at a time. The colon is optional throughout: several forms
// mail the label bare ("Submitted from https://example.com/"), which is the
// same line without its punctuation.
//
// NOTE FOR THE SPORTS SITES: several of them write no such footer at all, which
// is why SENDER_NAME_CODES below exists. A Gmail label remains the strongest
// evidence and the one thing that always works.`);

sub(`// "New quote request from peptidesboxes.com", "New enquiry from ..." — a bare
// domain rather than a URL, so it needs its own pattern.`,
`// "New quote request from example.com", "New enquiry from ..." — a bare domain
// rather than a URL, so it needs its own pattern.`);

sub(` *   3. the sending address's domain (noreply@thecoffeesleeves.com)`,
` *   3. the sending address's domain (noreply@<one of our sites>) — note this
 *      resolves nothing for a site that mails through Gmail, which is all five
 *      of these`);

sub(` * Other packaging businesses' form notifications land in this mailbox too
 * (packagingbee.com.au, theproductboxes.co.uk). They read exactly like a lead,`,
` * Other businesses' form notifications land in this mailbox too. They read
 * exactly like a lead,`);

sub(`// site gets a new Gmail label the day its first lead lands, and until that
// code is added here the lead is dropped in silence — exactly how The Coffee
// Sleeves' "tcs" was missed. Collected here (the labels are already fetched,`,
`// site gets a new Gmail label the day its first lead lands, and until that
// code is added here the lead is dropped in silence — that is how a site's
// very first leads have been missed before. Collected here (the labels are
// already fetched,`);

sub(`// "[Shop Cardboard Boxes]: New order #6449" → "SCB". Returns null when the
// subject has no bracketed store name, or the name isn't one we know — the
// caller then sends the thread to ZeeOps/Unmatched rather than guessing.`,
`// "[Store Name]: New order #6449" → the store's code. Inert here (see
// STORE_NAME_CODES, which is empty — these sites take no online orders).
// Returns null when the subject has no bracketed store name, or the name isn't
// one we know — the caller then sends the thread to ZeeOps/Unmatched rather
// than guessing.`);

sub(`  // The Astro storefronts (COD cart) don't put the store name anywhere in the
  // subject — theirs reads "New COD order — SCB-1787700487431", where the site
  // code is the order id's own prefix. Read it from there.
  // Found live: SCB-1787700487431 (26 Aug) sat in ZeeOps/Unmatched because the
  // bracketed-store-name match above was the only way in, and a COD order has
  // no brackets. Validated through codeFromLeaf_, so it can only ever resolve
  // to a code we already own and the off switch still applies.`,
`  // Some storefronts don't put the store name anywhere in the subject — theirs
  // reads "New COD order — XXX-1787700487431", where the site code is the order
  // id's own prefix. Read it from there. Validated through codeFromLeaf_, so it
  // can only ever resolve to a code we already own and the off switch still
  // applies.`);

sub(`// Lead-form emails list field VALUES one per line with no labels (e.g.
// "Rigid Boxes / suzanne@gmail.com / 8525144962"). We don't try to guess`,
`// Lead-form emails list field VALUES one per line with no labels (e.g.
// "Custom Jerseys / suzanne@gmail.com / 8525144962"). We don't try to guess`);

sub(`// form content. Those headers carry a notification address — USUALLY the
// site's own domain, but not always: The Paper Cups' form notifications
// actually send from an @zeecustomboxes.com address (same underlying
// WordPress setup), so checking only the CURRENT site's own domain missed
// it and grabbed zeecustomboxes.com's address as if it were the customer's.
// Check against EVERY one of our own site domains, not just the current
// one, since a forward's header can reference any of them.`,
`// form content. Those headers carry a notification address — USUALLY the
// site's own domain, but not always: sites sharing one mail setup send from
// each other's addresses, so checking only the CURRENT site's own domain once
// grabbed another site's address as if it were the customer's. Check against
// EVERY one of our own site domains, not just the current one, since a
// forward's header can reference any of them.`);

sub(`// Some forms LABEL their fields instead of listing bare values — Peptides
// Boxes sends "Full name: Joey Pannell / Business email: … / Phone: 12562210417".
// The bare-value logic below can't read those: "Phone: 12562210417" fails the
// digits-only test (it has letters), so the number was silently dropped, and
// the first junk line ("New enquiry from peptidesboxes.com") became the name.`,
`// Some forms LABEL their fields instead of listing bare values — "Full name:
// Joey Pannell / Business email: … / Phone: 12562210417". The bare-value logic
// below can't read those: "Phone: 12562210417" fails the digits-only test (it
// has letters), so the number was silently dropped, and the first junk line
// ("New enquiry from …") became the name.`);

sub(`  // the thread was parked in ZeeOps/Unmatched. (Five real leads sat there:
  // "Box and foam insert interest", "Shipping boxes", "Plain Corrugated
  // Catering Boxes Inquiry", etc.) Used only when the body yields no address.`,
`  // the thread was parked in ZeeOps/Unmatched — five real leads sat there
  // before this fallback existed. Used only when the body yields no address.`);

sub(`    // field — the first Candle Sleeves lead landed with the literal string
    // "*Name* Amanda Mead" as its name AND its product, and no phone, even
    // though every field was right there.`,
`    // field — one site's first lead landed with the literal string
    // "*Name* Amanda Mead" as its name AND its product, and no phone, even
    // though every field was right there.`);

sub(`      // ("*Name*\\nEric"). Zee Custom Boxes' and The Candle Packaging's "Get A
      // Free Quote" forms are all like this, which is why every one of their
      // leads was named "New submission from Get A Free Quote" — the real name
      // was one line further down and nothing ever looked there.`,
`      // ("*Name*\\nEric"). Whole families of "Get A Free Quote" forms are like
      // this, which is why every one of their leads was named "New submission
      // from Get A Free Quote" — the real name was one line further down and
      // nothing ever looked there.`);

// ── Sports-only functional differences ───────────────────────────────────
sub("var SCRIPT_VERSION = '2026-08-29b';", "var SCRIPT_VERSION = 'sports-2026-08-29b';");
sub("payload: JSON.stringify({ siteCode: 'SCB', email: '' })", "payload: JSON.stringify({ siteCode: 'TVU', email: '' })");
sub("var DIAGNOSE_QUERY = 'peptidesboxes.com';", "var DIAGNOSE_QUERY = 'thevolleyballuniforms.com';");


// ── Sports-only additions: how a Gmail-sent form names its site ──────────
sub(`/**
 * Which of OUR sites did this message come from, judged from the message
 * itself rather than from a Gmail label?`,
`// The sender's DISPLAY NAME -> our site code. THE REASON THIS FILE NEEDS A
// RESOLVER THE OTHER ONE DOESN'T: all five of these sites mail through a Gmail
// account — "The Volleyball Uniforms <something@gmail.com>" — so the sending
// domain is gmail.com and identifies nothing, and several of their forms write
// no "Page URL:" footer either. Without this, the ONLY thing that can place
// their mail is a Gmail label somebody remembered to apply.
//
// A display name is WEAKER EVIDENCE than everything else in this file: a label
// and a form's own footer cannot be faked by a stranger, a From header can. So
// this is the one resolver that is not trusted on its own — the body must also
// have the shape of a submitted form (looksLikeFormSubmission_: two or more
// field lines) before a display name is allowed to name a site. Spam would have
// to impersonate the site's own mailer AND arrive as a filled-in quote form, at
// which point the server's own spam rules are what stands in the way, as they
// do for every other path here.
var SENDER_NAME_CODES = {
  'texas football uniforms': 'TFU',
  'the texas football uniforms': 'TFU',
  'the volleyball uniforms': 'TVU',
  'volleyball uniforms': 'TVU',
  'california soccer jerseys': 'CSJ',
  'florida basketball jerseys': 'FBJ',
  'the baseball jerseys': 'TBJ',
  'baseball jerseys': 'TBJ',
};

// The display-name half of a From header: \`Name <addr@host>\` -> \`name\`.
function senderDisplayName_(fromHeader) {
  return String(fromHeader || '').replace(/<[^>]*>/g, '').replace(/["']/g, '').trim().toLowerCase();
}

function codeFromSenderName_(fromHeader) {
  var code = SENDER_NAME_CODES[senderDisplayName_(fromHeader)];
  return code && !isIgnoredLeaf_(code) ? code : null;
}

/**
 * Which of OUR sites did this message come from, judged from the message
 * itself rather than from a Gmail label?`);

sub(` *   4. LAST RESORT: any URL in the body pointing at one of our domains — and`,
` *   4. the sender's display name, but only when the body is a filled-in form
 *      (see SENDER_NAME_CODES) — this is the one that carries these five
 *   5. LAST RESORT: any URL in the body pointing at one of our domains — and`);

sub(`  var sender = String(fromHeader || '').match(/@([A-Za-z0-9.-]+\\.[A-Za-z]{2,})/);
  if (sender) { code = codeFromHost_(sender[1]); if (code) return code; }
`,
`  var sender = String(fromHeader || '').match(/@([A-Za-z0-9.-]+\\.[A-Za-z]{2,})/);
  if (sender) { code = codeFromHost_(sender[1]); if (code) return code; }

  // The display name — only for a body that is actually a filled-in form.
  // See SENDER_NAME_CODES for why this one alone needs that guard.
  code = codeFromSenderName_(fromHeader);
  if (code && looksLikeFormSubmission_(text)) return code;
`);

// ── The dry run, which this mailbox needs more than the other one ────────
sub(`// MANUAL USE ONLY — not on the trigger. processQuoteLeads only looks at
// mail from the last RECENT_DAYS days`,
`// ── Dry run: what WOULD be ingested, without ingesting anything ──────────
// RUN THIS BEFORE processQuoteLeadsBackfill. A backfill of a freshly-labelled
// account posts months of mail in one go, and a label applied from the wrong
// search, or a form this parser reads badly, becomes hundreds of wrong leads
// that then have to be found and cleaned out of the dashboard by hand.
// This sends NOTHING and changes NOTHING: it walks each site label, parses the
// newest messages exactly as the real run would, and prints what the webhook
// would have received — including the ones it could not read, which are the
// ones worth looking at.
var PREVIEW_THREADS_PER_LABEL = 5;

function previewLeads() {
  var start = Date.now();
  var siteLabels = findSiteLabels_();
  var codes = Object.keys(siteLabels);
  if (!codes.length) {
    Logger.log('No site labels found in this mailbox. Create one per site (leaf name ' +
      'TFU, TVU, CSJ, FBJ or TBJ, or the site name), then run listSiteLabels.');
    return;
  }
  Logger.log('DRY RUN [' + SCRIPT_VERSION + '] — nothing is sent and nothing is labelled.');
  var readable = 0, unreadable = 0;
  for (var c = 0; c < codes.length; c++) {
    if (Date.now() - start > TIME_BUDGET_MS) { Logger.log('...stopped early (time budget).'); break; }
    var code = codes[c];
    var threads = siteLabels[code].getThreads(0, PREVIEW_THREADS_PER_LABEL);
    Logger.log('');
    Logger.log('=== ' + code + '  (' + siteLabels[code].getName() + ')  — newest ' + threads.length + ' thread(s)');
    prefetchMessages_(threads);
    for (var t = 0; t < threads.length; t++) {
      var msgs = messagesOf_(threads[t]);
      var msg = msgs[msgs.length - 1];               // newest message on the thread
      if (!msg) continue;
      var parsed = parseLeadBody_(msg.getPlainBody());
      var when = Utilities.formatDate(msg.getDate(), 'UTC', 'yyyy-MM-dd');
      if (parsed.email || parsed.phone) {
        readable++;
        Logger.log('  WOULD SEND  ' + when + '  name=' + (parsed.name || '(none)') +
          '  email=' + (parsed.email || '(none)') + '  phone=' + (parsed.phone || '(none)') +
          '  product=' + (parsed.product || '(none)'));
        // The sending address is printed on purpose: these sites mail through
        // Gmail, and their own notification addresses have to go into
        // OWN_EMAILS before the backfill runs, or a form that carries no
        // customer email hands the site's own address to the dashboard as the
        // lead's. The dry run is where you learn what those addresses are.
        Logger.log('              from=' + msg.getFrom());
      } else {
        unreadable++;
        Logger.log('  NO CONTACT  ' + when + '  from=' + msg.getFrom() +
          '  subject=' + String(threads[t].getFirstMessageSubject() || '').slice(0, 60));
        Logger.log('              first lines: ' +
          String(msg.getPlainBody() || '').split('\\n').slice(0, 4).join(' | ').slice(0, 200));
      }
    }
  }
  Logger.log('');
  Logger.log('DRY RUN total: ' + readable + ' would be sent, ' + unreadable +
    ' carry no readable email/phone. If the readable ones look right, run processQuoteLeadsBackfill.');
}

// MANUAL USE ONLY — not on the trigger. processQuoteLeads only looks at
// mail from the last RECENT_DAYS days`);


// ── Last five: site names still sitting inside engine comments ───────────
sub(` * "ZeeOps/Needs a site label" was wrong: it put a ZeeOps sticker on mail that`,
` * "ZeeOps/Needs a site label" was wrong: it put a ZeeOps label on mail that`);

sub(`    // assumption that an unmapped label would look like a code — so "Mylar" (5)
    // and "CS" (2) were reported while "ZEE Pack" (8) was not. The alarm built
    // to catch a missing label was itself blind to the label that went missing.`,
`    // assumption that an unmapped label would look like a code — so a 5-letter
    // label was reported while an 8-letter site NAME was not. The alarm built to
    // catch a missing label was itself blind to the label that went missing.`);

sub(`// the body ("New Quote Request — The Wax Papers") becomes the lead's name.`,
`// the body ("New Quote Request — Custom Jerseys") becomes the lead's name.`);

sub(`    // labelled matcher nor the colon-less Wax Papers one below could see a`,
`    // labelled matcher nor the colon-less one below could see a`);

sub(`    // The Wax Papers form emits colon-LESS labeled fields ("Name Jose
    // Rodriguez", "Email x@y.com", "Product custom-deli-papers"). Only exact`,
`    // Some forms emit colon-LESS labeled fields ("Name Jose Rodriguez",
    // "Email x@y.com", "Product team-jerseys"). Only exact`);


sub(`var OWN_EMAILS = []; // add any other address you forward from, e.g. 'you@work.com'`,
`// FILL THIS IN AFTER THE FIRST previewLeads RUN. All five sites mail through
// Gmail accounts, so their notification addresses look exactly like a customer's
// (both are @gmail.com) and SITE_DOMAINS cannot rule them out the way it does
// for a site that mails from its own domain. If a form ever arrives without a
// customer email in the body, the From-header fallback would then record the
// SITE'S OWN address as the lead's. previewLeads prints "from=" on every thread
// it reads — put each site's sending address here.
var OWN_EMAILS = []; // e.g. 'tvu.forms@gmail.com', plus any address you forward from`);

fs.writeFileSync('/tmp/.sports-subs-count', String(subs.length));
for (const [from, to] of subs) {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`replacement matched ${n} times (expected 1):\n${from.slice(0, 160)}…`);
  s = s.replace(from, to);
}
fs.writeFileSync(OUT, s);
console.log(`wrote ${OUT} (${subs.length} roster replacements)`);

// ── The audit that makes the promise real ────────────────────────────────
// "The sports script contains nothing about packaging" is a claim, and a claim
// about ABSENCE is only worth what the check behind it is worth. So: every
// packaging site's id, domain, short code and store name, plus the words that
// only belong to that dashboard — if any of them survives anywhere in the
// generated file, including inside a comment, this throws and no file is used.
const FORBIDDEN = [
  'shopcardboardboxes', 'thetubepackaging', 'smallfoodboxes', 'kraftboxpack', 'theburgerboxes',
  'zeecustomboxes', 'thecandlepackaging', 'thepapercups', 'peptidesboxes', 'thecoffeesleeves',
  'thewaxpapers', 'thecustomstickers', 'zeepack', 'thecerealboxes', 'hotdogtrays',
  'theburgersleeves', 'thecandlesleeves', 'cardboardcups', 'shopbubblemailers', 'insertshub',
  'thediecutstickers', 'customperfumeboxes', 'shopdisplayboxes', 'lipboxes', 'thepolymailers',
  'theretailpackaging', 'packagingbee', 'theproductboxes', 'woocommerce', 'packaging',
  'zee pack', 'zee custom', 'candle', 'burger', 'sleeves', 'paper cups', 'perfume', 'cardboard',
  'wax paper', 'cereal', 'hotdog', 'bubble mailer', 'sticker', 'peptide', 'tube packaging',
];
const CODES = ['SCB', 'TTP', 'SFB', 'KBP', 'TBB', 'ZCB', 'TCP', 'TPC', 'TCS', 'TWP', 'CPB',
  'TCSL', 'TCST', 'TCRB', 'HDT', 'TBSL', 'CBC', 'SBM', 'IH', 'TDCS', 'SDB', 'PB'];

const hits = [];
s.split('\n').forEach((line, i) => {
  const low = line.toLowerCase();
  for (const w of FORBIDDEN) if (low.includes(w)) hits.push(`${i + 1}: ${w} — ${line.trim().slice(0, 90)}`);
  for (const c of CODES) if (new RegExp(`\\b${c}\\b`).test(line)) hits.push(`${i + 1}: ${c} — ${line.trim().slice(0, 90)}`);
});
if (hits.length) {
  console.error(`\nAUDIT FAILED — ${hits.length} packaging reference(s) left in ${OUT}:`);
  hits.slice(0, 40).forEach((h) => console.error('  ' + h));
  process.exit(1);
}
console.log('audit clean — no packaging site, code, domain or store name anywhere in the sports file');
