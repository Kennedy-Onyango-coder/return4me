import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parsePublicRoute, pathForView, viewForRoute, isRestorableView } from '../utils/publicRoutes';

// ---------------------------------------------------------------------------
// Batch 13 — the public Help & FAQ page (/help).
//
// WHY SOURCE-LEVEL, NOT RENDERED: this repository has no DOM test harness and
// its public views are plain TSX, so the /help contract is asserted against the
// real source plus the REAL routing helpers (`parsePublicRoute` / `pathForView`
// / `isRestorableView`) — the same approach publicNavigation and publicChromeUx02
// already take. Nothing here re-implements production logic; it calls it.
//
// WHAT THIS FILE PROTECTS
//   1. /help is a real, restorable route — not React state hidden behind a URL,
//      so a shared, bookmarked or refreshed link lands on the page.
//   2. It is reachable from the public shell, and titled in both languages.
//   3. It stays STATIC: no request, no storage, no session, no second flow, and
//      every exit goes through the App-owned navigator to a public screen.
//   4. Its answers are the ones the implementation already makes true: the code
//      is EMAILED, the number identifies the account rather than delivering to
//      it, the fee is quoted before payment and released after a confirmed
//      handover.
//   5. helpViewBilingualParity — every rendered string is an EN/SW pair, so an
//      English-only sentence cannot be added here unnoticed.
//   6. The page publishes exactly the three mailboxes that have a reader, and
//      none of the retired ones.
// ---------------------------------------------------------------------------

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(root, relative), 'utf8');

const helpTs = read('src/components/HelpView.tsx');
const appTs = read('src/App.tsx');
const navbarTs = read('src/components/Navbar.tsx');
const routesTs = read('src/utils/publicRoutes.ts');

// This page documents the very defects it fixes — the retired SMS launch
// posture, the mailboxes that were dropped, and the `t(en, sw)` parity rule
// itself — so the tripwires that judge the CODE must judge the code: comments
// are stripped first (exactly as publicNavigation.test.ts / adminLostReportsUi
// do) instead of weakening the documentation to satisfy a grep.
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const helpCode = stripComments(helpTs);

describe('Batch 13 public Help & FAQ: the route and the way in', () => {
  it('is a real, restorable /help route instead of React state behind a URL', () => {
    expect(routesTs).toContain("const HELP_PATH = '/help';");
    expect(routesTs).toContain("{ path: HELP_PATH, view: 'help' }");
    // Every shape a link or the address bar can produce resolves to the page,
    // so a shared, bookmarked or refreshed /help never bounces back to Home.
    expect(parsePublicRoute('/help')).toEqual({ kind: 'view', view: 'help' });
    expect(parsePublicRoute('/help/')).toEqual({ kind: 'view', view: 'help' });
    expect(parsePublicRoute('/HELP')).toEqual({ kind: 'view', view: 'help' });
    expect(pathForView('help')).toBe('/help');
    expect(viewForRoute({ kind: 'view', view: 'help' })).toBe('help');
    expect(isRestorableView('help')).toBe(true);
  });

  it('is reachable from the public shell, and titled in both languages', () => {
    expect(appTs).toContain("const HelpView = lazy(() => import('./components/HelpView'));");
    expect(appTs).toContain("{currentView === 'help' && (");
    expect(appTs).toContain('<HelpView lang={lang} setView={goToView} />');
    expect(appTs).toContain("onClick={() => goToView('help')}");
    expect(appTs).toContain("help: { en: 'Help & FAQ | Return4me', sw: 'Msaada na Maswali | Return4me' },");
    // The shell's view union accepts the new screen, so no `as any` was needed.
    expect(navbarTs).toContain("| 'help'");
    // ...and the drawer's public "Legals & Info" group carries the entry itself,
    // next to Terms and Privacy, so the page is reachable without a URL.
    expect(navbarTs).toContain("onClick={() => handleNavClick('help')}");
  });

  it('is static — no request, no storage, no session, no second flow', () => {
    for (const forbidden of [
      'fetch(',
      'axios',
      'XMLHttpRequest',
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'supabase',
      'useState',
      'useEffect',
      'useRef',
    ]) {
      expect(helpCode, `HelpView must stay static but uses ${forbidden}`).not.toContain(forbidden);
    }
    // Navigating by hand would leave /help out of sync with the address bar.
    expect(helpCode).not.toContain('window.location');
    expect(helpCode).not.toContain('pushState');
  });

  it('hands every exit to the App-owned navigator, and only to public screens', () => {
    const destinations = [...helpCode.matchAll(/setView\('([A-Za-z]+)'\)/g)].map((m) => m[1]).sort();
    expect(destinations).toEqual(['finder', 'privacy', 'signin', 'terms']);
    // The navigator prop is the shared public view union, not a loose string.
    expect(helpCode).toContain("import type { PublicViewName } from '../utils/publicRoutes';");
    expect(helpCode).toContain('setView: (view: PublicViewName) => void;');
  });
});

describe('Batch 13 public Help & FAQ: the answers match the implementation', () => {
  it('says the one-time code arrives by email, and names every email flow', () => {
    expect(helpTs).toContain(
      "t('Your one-time code arrives by email', 'Msimbo wako wa matumizi moja huja kwa barua pepe')",
    );
    // The flow list is the E1 notification catalogue (src/config/
    // notificationEvents.ts): customer login, agent login, data deletion, claim
    // verification, claim linking and the phone-number change all route over
    // email. Registration is the honest exception — it emails an ACTIVATION LINK
    // rather than a code (src/services/customerAuth.ts buildCustomerActivationUrl)
    // — so "registering" must not be listed among the one-time-code flows.
    expect(helpCode).toContain('signing in, filing a claim, linking a claim to your account');
    expect(helpCode).toContain('asking to change your number or delete your data');
    expect(helpCode).toContain('it emails an activation link rather than a code');
    expect(helpCode).not.toContain('signing in, registering, filing a claim');
    expect(helpCode).toContain('Nothing is sent to your phone');
    // The honest failure case is admitted rather than papered over: an account
    // with no verified address is told so, and told where to fix it.
    expect(helpCode).toContain('If the account has no verified email address we say so');
  });

  it('makes the number an identifier and never a delivery channel', () => {
    expect(helpTs).toContain(
      "t('Your phone number identifies the account', 'Nambari yako ya simu inatambulisha akaunti')",
    );
    expect(helpCode).toContain('It is an identifier, not a delivery channel');
    // No retired vocabulary may reappear ON the page. The file's own comments
    // are allowed to name the old posture, which is why this runs on helpCode.
    for (const retired of ['SMS', 'text message']) {
      expect(helpCode, `HelpView must not promise delivery by ${retired}`).not.toContain(retired);
    }
  });

  it('describes the fee and the handover the way the flow already behaves', () => {
    expect(helpCode).toContain('is shown in the payment step before you pay anything');
    expect(helpCode).toContain('holds the payment until the handover is confirmed');
    expect(helpCode).toContain('A dispute window runs before the agent is paid');
    // Handover CONFIRMATION gates the agent's money, but it is settlement that
    // pays it out (claims-and-payments.md), so the page may not say the
    // confirmation itself releases the payment.
    expect(helpCode).toContain('nothing is paid to the agent before that confirmation');
    expect(helpCode).not.toContain('that confirmation is what releases the payment');
    // The resend is a self-service action on the claim page, under its own
    // cooldown, and a dispute is decided by an administrator — so the page may
    // not promise that support hands out codes or hours it does not publish.
    expect(helpCode).toContain('A pickup code can be requested again from the claim page');
    expect(helpCode).toContain('pass a disputed claim to the administrator who decides it');
    expect(helpCode).not.toContain('Support can reissue a code');
    expect(helpCode).not.toContain('working hours');
    // "escrow" is the INTERNAL money vocabulary (claims-and-payments.md: the claim
    // state `escrow_held`). The public page says who holds the money and when it
    // moves, in words a customer uses — the internal term stays internal.
    expect(helpCode).not.toContain('escrow');
  });

  it('points support at the reference the claim itself shows', () => {
    // Claim references are CLM- codes and R4M- is an ITEM drop-off code
    // (src/services/lostReportReference.ts), so the escalation step must not
    // send a claimant looking for an "R4M-" claim reference.
    expect(helpCode).toContain('the claim reference shown on your claim (the CLM- code)');
    expect(helpTs).not.toContain('R4M-');
  });

  it('publishes exactly the three mailboxes that have a reader', () => {
    const addresses = [
      ...new Set([...helpTs.matchAll(/'([a-z]+@return4me\.co\.ke)'/g)].map((m) => m[1])),
    ].sort();
    expect(addresses).toEqual([
      'privacy@return4me.co.ke',
      'security@return4me.co.ke',
      'support@return4me.co.ke',
    ]);
    // They are real, clickable mail links rather than text a reader must copy.
    expect(helpCode).toContain('href={`mailto:${contact.address}`}');
    // The retired mailbox must not return through this page either.
    expect(helpTs).not.toContain('dpo@');
  });

  it('labels every section, with unique ids', () => {
    const labelled = [...helpCode.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    const titleIds = [...helpCode.matchAll(/titleId="([^"]+)"/g)].map((m) => m[1]);
    expect(labelled.length).toBe(7); // one accessible name per section
    expect(new Set(labelled).size).toBe(labelled.length);
    // Every labelled section points at a title that actually exists.
    for (const id of labelled) expect(titleIds).toContain(id);
    // The page heading itself is titled and referenced, never an untitled h1.
    expect(titleIds).toContain('help-page-title');
  });
});

describe('helpViewBilingualParity', () => {
  it('renders only two-literal pairs, never an English-only string', () => {
    // Counted on the comment-stripped source: the page's own commentary quotes
    // the `t(en, sw)` rule, and a prose mention is not a call.
    const calls = (helpCode.match(/\bt\(/g) || []).length;
    const pairs = (helpCode.match(/\bt\(\s*'(?:[^'\\]|\\.)*'\s*,\s*'(?:[^'\\]|\\.)*'/g) || []).length;
    expect(calls).toBeGreaterThanOrEqual(30); // the page is actually still there
    expect(pairs).toBe(calls);
    // A one-argument call would render English-only for a Swahili reader.
    expect(helpCode.match(/\bt\(\s*'(?:[^'\\]|\\.)*'\s*\)/g) || []).toEqual([]);
    // Neither half of a pair may be blank.
    for (const [, en, sw] of helpCode.matchAll(/\bt\(\s*'([^']*)'\s*,\s*'([^']*)'/g)) {
      expect(en.trim().length).toBeGreaterThan(0);
      expect(sw.trim().length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Batch 13 also sweeps the CHANNEL wording of the three authentication screens
// the Help answers describe. A Help page that says "the code is emailed" while
// the screen a customer actually meets says "we sent it to <this number>" is two
// contradictory documents — and the screen is the one they see first. These
// assertions read the REAL screens rather than a copy of their strings, and they
// name the retired wording explicitly so it cannot come back silently.
// ---------------------------------------------------------------------------
const customerAccountTs = read('src/components/CustomerAccountView.tsx');
const agentViewTs = read('src/components/AgentView.tsx');
const ownerViewTs = read('src/components/OwnerView.tsx');

describe('Batch 13 channel wording: every code screen names email, never the phone', () => {
  it('the customer OTP step says the code was emailed, and to which account', () => {
    const gate = stripComments(customerAccountTs);
    expect(gate).toContain('We emailed the code to the verified address on the account for');
    expect(gate).toContain(
      "We'll email a one-time verification code to the verified email address on your account.",
    );
    // The retired hints named the NUMBER as the destination of the code.
    for (const retired of ['We sent it to', 'Tuliituma kwa', 'Umetumwa kwa']) {
      expect(gate, `the customer OTP step must not deliver to the number: ${retired}`).not.toContain(retired);
    }
  });

  it('the agent sign-in and onboarding steps name the email address as the destination', () => {
    const agent = stripComments(agentViewTs);
    expect(agent).toContain(
      'The code is emailed to the verified email address on your account, not to this number.',
    );
    expect(agent).toContain('Enter the one-time code we sent to your verified email address.');
    expect(agent).toContain(
      'This number identifies your account. The verification link is emailed to the address above.',
    );
    // The denial is allowed to exist — it is a promise NOT being made — while the
    // retired delivery promise itself is gone, in both languages.
    expect(agent).toContain('no code is sent by text message');
    expect(agent).not.toContain('We text a one-time code to this number to verify it.');
    expect(agent).not.toContain('Tunatuma msimbo wa mara moja kwa nambari hii');
  });

  it('claim verification still resolves to the verified email address on the claim', () => {
    const owner = stripComments(ownerViewTs);
    expect(owner).toContain('Enter the 4-digit code we sent to the verified email address on this claim.');
    // The pickup-code panel must not advertise a second, SMS delivery path.
    expect(owner).not.toContain('kwa SMS na barua pepe');
    expect(owner).not.toContain('sent a secret 6-digit code to your phone (SMS) and email');
  });
});

// ---------------------------------------------------------------------------
// Batch 13 also removed the last UNSUPPORTED regulatory claim from the two
// legal pages. The repository establishes IntaSend as the payment provider
// (src/services/payments.ts, docs/architecture.md, and the processor table in
// PrivacyView itself) and establishes NO licence, authorisation or registration
// status — for the provider or for Elligrace Technologies Limited. Copy
// therefore says "payment provider", which the code makes true, instead of
// asserting a regulatory standing the repository cannot evidence.
// ---------------------------------------------------------------------------
const termsTs = read('src/components/TermsView.tsx');
const privacyTs = read('src/components/PrivacyView.tsx');

describe('Batch 13 regulatory wording: payment claims stay inside the evidence', () => {
  it('names no banking regulator, licence or PSP authorisation on either legal page', () => {
    for (const [name, source] of [
      ['src/components/TermsView.tsx', termsTs],
      ['src/components/PrivacyView.tsx', privacyTs],
    ] as const) {
      // Case-insensitive, because the retired claim appeared in three shapes:
      // "CBK-authorized payment partner", "licensed Central Bank of Kenya (CBK)
      // payment partners", and "Central Bank of Kenya-authorized Payment Service
      // Provider (PSP) partner".
      for (const unsupported of ['cbk', 'central bank', 'payment service provider', 'psp']) {
        expect(source.toLowerCase(), `${name} must not claim ${unsupported}`).not.toContain(unsupported);
      }
      expect(source, `${name} must not claim a licence it cannot evidence`).not.toMatch(/licen[cs]ed/i);
    }
  });

  it('describes the role the code actually implements: a payment provider', () => {
    // The provider is named in the PrivacyView processor table and in
    // src/services/payments.ts, so the legal pages must agree with them.
    expect(privacyTs).toContain('our payment provider (IntaSend)');
    expect(termsTs).toContain('processed securely through our payment provider');
    expect(termsTs).toContain('processed by our payment provider');
    expect(termsTs).toContain('held by our payment provider');
  });
});
