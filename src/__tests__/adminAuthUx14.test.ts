import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-14 — THE ADMIN AUTHENTICATION GATE (AdminView.tsx, signed-out surface)
// =============================================================================
// The admin authentication gate was still written against the pre-UX-01
// vocabulary: a `bg-white`/`stone-*` card with `rounded-2xl`/`shadow-sm`, two
// hand-rolled `<label>`+`<input>` pairs at ~42px (below the 44px floor), a
// hand-built `<button>` with a raw `bg-stone-900` surface that does not flip in
// dark mode, a `text-[11px]` "Back to password" caption below the 12px floor, an
// error box whose raw `red-*` colours did not flip either and announced nothing
// to assistive tech, and a heading that named the screen without saying whose
// door it is.
//
// UX-14 IS PRESENTATION ONLY. It deliberately changes none of:
//   * the authentication protocol — the same two endpoints are called in the
//     same order with byte-identical bodies (`/api/auth/admin-login` with
//     { username, passcode }; `/api/auth/admin-login/verify-2fa` with
//     { pendingToken, code });
//   * the security model — the same bearer token returned by the server is
//     handed to the same `setToken` (localStorage `admin_token` in App.tsx);
//     no second storage mechanism, no second credential field, no client-side
//     authorisation, and no change to the 2FA branch, the rate limiting, the
//     session expiry or the server-side role checks;
//   * the route architecture — this remains the `/console` gate, reachable only
//     while there is no admin token.
// What it changes is hierarchy, control semantics, the type/colour/radius/
// elevation vocabulary and the copy in both languages — all of it by adopting
// primitives and tokens that already exist (`Button`, `Input`, `Banner`, the
// `--appearance-*` tokens, the type/radius/elevation ladders), exactly as UX-07
// did for customer authentication and UX-11 did for agent sign-in.
//
// This repository has no jsdom/React harness, so — exactly as the UX-06 … UX-13
// suites do — the contract is asserted against the shipped source, with the same
// comment stripper and the same `sliceBetween` helper. No snapshots and no
// line-number assertions are used anywhere. The scope boundary matters as much
// as the contract: the Admin Console below the gate belongs to UX-15, so every
// assertion here is made against the GATE SLICE, never against the whole file.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the N3 and UX-06 … UX-13 suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ADMIN_VIEW_TSX = read('src/components/AdminView.tsx');
const ADMIN_VIEW = stripComments(ADMIN_VIEW_TSX);
const APP_TSX = read('src/App.tsx');
const INDEX_CSS = read('src/index.css');
const DESIGN_SYSTEM = read('docs/design-system.md');
const BUTTON_PRIMITIVE = read('src/components/ui/Button.tsx');
const INPUT_PRIMITIVE = read('src/components/ui/Input.tsx');
const BANNER_PRIMITIVE = read('src/components/ui/Banner.tsx');

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`UX-14 marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

/**
 * THE SCOPE BOUNDARY. The whole signed-out gate, sliced from its own branch
 * opener to the console's first `token`-gated state — so the Admin Console
 * (UX-15) is provably outside every assertion in this file.
 */
const GATE_TSX = sliceBetween(ADMIN_VIEW_TSX, '{!token && (', '{/* 2. DISTINCT LOADING');
const GATE = stripComments(GATE_TSX);
/** The branch opener + card chrome, up to the brand mark. */
const CARD_TSX = sliceBetween(ADMIN_VIEW_TSX, '{!token && (', '<img');

/** The UX-14 regions, sliced on the real JSX that delimits them. */
const IDENTITY = stripComments(sliceBetween(GATE_TSX, '<img', '{authError && ('));
const FEEDBACK = stripComments(sliceBetween(GATE_TSX, '{authError && (', '<form'));
const FORM = stripComments(sliceBetween(GATE_TSX, '<form', '</form>'));
const CREDENTIAL = stripComments(sliceBetween(GATE_TSX, '{!pendingTwoFactorToken ? (', ') : ('));
const CODE_STEP = stripComments(sliceBetween(GATE_TSX, ') : (', '</form>'));
/** The one dominant action — the LAST <Button in the gate. */
const SUBMIT = stripComments(GATE.slice(GATE.lastIndexOf('<Button')));

/**
 * Every `lang === 'en' ? 'english' : 'kiswahili'` pair in a slice, whatever the
 * layout — the long context sentence wraps across three lines, so the separator
 * and the `:` are allowed to sit on any line.
 */
function bilingualPairs(source: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const re = /lang === 'en'\s*\?\s*'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) pairs.push([match[1], match[2]]);
  return pairs;
}

/** The Kiswahili twin of one specific English string, or null when that string
 *  is not carried by a bilingual pair at all — i.e. it is an untranslated
 *  hard-coded English literal. */
function twinOf(source: string, english: string): string | null {
  const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`lang === 'en'\\s*\\?\\s*'${escaped}'\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'`);
  const match = source.match(re);
  return match ? match[1] : null;
}

/* ---------------------------------------------------------------------------
 * The three guards the mutation checks at the bottom re-run against a
 * deliberately broken copy of the gate, so the checks cannot silently rot.
 * ------------------------------------------------------------------------- */
/** Off-ladder / sub-12px type: the UX-01 ladder is the only scale allowed. */
const offLadderType = (source: string): string[] => [
  ...(source.match(/text-\[\d+px\]/g) || []),
  ...(source.match(/\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?![\w-])/g) || []),
];
/** Pre-UX-01 colour: raw hex, a fixed palette, or a literal white surface. */
const legacyColour = (source: string): string[] => [
  ...(source.match(/#[0-9a-fA-F]{3,8}\b/g) || []),
  ...(source.match(/\b(?:bg|text|border)-(?:stone|slate|gray|zinc|emerald|amber|sky)-/g) || []),
  ...(source.match(/\bbg-white\b/g) || []),
];
/** The number of competing primary actions in a slice. */
const primaryActions = (source: string): number => count(source, /variant="primary"/g);

// -----------------------------------------------------------------------------
// A. The gate renders — in the same place, behind the same condition.
// -----------------------------------------------------------------------------

describe('UX-14 keeps the admin gate exactly where it was', () => {
  it('is still the signed-out branch of the /console admin view', () => {
    expect(GATE_TSX).toContain('{!token && (');
    // The gate is the ONLY unauthenticated branch in the whole file.
    expect(count(ADMIN_VIEW, /\{!token && \(/g)).toBe(1);
    // …and it is still mounted by the /console route with the same token pair.
    expect(APP_TSX).toContain("navigate('/console', 'admin')");
    expect(APP_TSX).toMatch(/currentView === 'admin' && adminToken/);
    expect(APP_TSX).toContain(
      'token={adminToken} setToken={handleSetAdminToken} onCategoriesChanged={fetchCategories}',
    );
  });

  it('does not move the gate behind a weaker condition', () => {
    // No role, no identity and no client-side "already authenticated" shortcut
    // may be introduced: the branch is still driven by the token alone.
    expect(GATE).not.toMatch(/role\s*[!=]==|isAdmin|hasAdmin|requireCurrentAdminSession/);
    expect(GATE).not.toContain('localStorage');
    expect(GATE).not.toMatch(/useState|useEffect|useRef/);
  });
});

// -----------------------------------------------------------------------------
// B. Identity — the official brand mark, the heading, the access statement.
// -----------------------------------------------------------------------------

describe('UX-14 gives the gate an administrative identity', () => {
  it('uses the OFFICIAL Return4me wordmark, undistorted, and no invented mark', () => {
    expect(IDENTITY).toContain('src="/assets/logo_wordmark_transparent.png"');
    expect(IDENTITY).toContain('alt="Return4me"');
    expect(count(IDENTITY, /logo_wordmark_transparent\.png/g)).toBe(1);
    // aspect ratio: auto width against a fixed height, never a stretched box
    expect(IDENTITY).toContain('w-auto');
    expect(IDENTITY).toContain('object-contain');
    expect(IDENTITY.indexOf('w-auto')).toBeLessThan(IDENTITY.indexOf('object-contain'));
    // the generic shield must not be the mark on this screen…
    expect(IDENTITY).not.toContain('<ShieldCheck');
    // …and no text is dressed up as a logo instead of the real asset.
    expect(GATE).not.toMatch(/>\s*Return4me\s*</);
  });

  it('keeps the heading the single <h1>, in both languages', () => {
    expect(IDENTITY).toMatch(/<h1\b/);
    expect(count(IDENTITY, /<h1\b/g)).toBe(1);
    expect(twinOf(IDENTITY, 'Admin Authentication')).toBe('Uthibitishaji wa Msimamizi');
  });

  it('states who the gate is for, without a slogan or a fabricated claim', () => {
    expect(twinOf(IDENTITY, 'Return4me administration')).toBe('Utawala wa Return4me');
    // The existing sentence is kept verbatim (only its typography changed).
    expect(
      twinOf(IDENTITY, 'Access restricted strictly to platform executives and vetted managers.'),
    ).toContain('Ufikiaji umezuiwa');
    // No marketing vocabulary and no claim the system cannot support.
    for (const marketing of ['Welcome', 'welcome', 'Get started', 'Sign up', 'seamless', 'world-class']) {
      expect(GATE, `marketing copy: ${marketing}`).not.toContain(marketing);
    }
    expect(GATE).not.toMatch(/\bAI\b/);
  });

  it('reads in the security-first order: brand, heading, context, form, action', () => {
    const at = (needle: string) => GATE_TSX.indexOf(needle);
    expect(at('<img')).toBeGreaterThan(-1);
    expect(at('<img')).toBeLessThan(at('<h1'));
    expect(at('<h1')).toBeLessThan(at("'Access restricted strictly"));
    expect(at("'Access restricted strictly")).toBeLessThan(at('{authError && ('));
    expect(at('{authError && (')).toBeLessThan(at('<form'));
    expect(at('<form')).toBeLessThan(at('type="submit"'));
    expect(IDENTITY).toContain('text-section');
    expect(IDENTITY).not.toMatch(/\btext-(?:page|display|hero)\b/);
  });
});

// -----------------------------------------------------------------------------
// C. The credential fields and the existing 2FA step.
// -----------------------------------------------------------------------------

describe('UX-14 keeps the real credential fields and the existing 2FA step', () => {
  it('still carries the three existing fields, through the shared Input', () => {
    for (const id of ['admin-username', 'admin-passcode', 'admin-2fa-code']) {
      expect(ADMIN_VIEW_TSX, `the ${id} field must survive UX-14`).toContain(`id="${id}"`);
    }
    expect(CREDENTIAL).toContain('<Input');
    expect(CREDENTIAL).toContain('value={username}');
    expect(CREDENTIAL).toContain('onChange={(e) => setUsername(e.target.value)}');
    expect(CREDENTIAL).toContain('value={passcode}');
    expect(CREDENTIAL).toContain('onChange={(e) => setPasscode(e.target.value)}');
  });

  it('declares the autofill semantics an admin sign-in needs', () => {
    expect(CREDENTIAL).toContain('type="text"');
    expect(CREDENTIAL).toContain('autoComplete="username"');
    expect(CREDENTIAL).toContain('type="password"');
    expect(CREDENTIAL).toContain('autoComplete="current-password"');
    expect(CREDENTIAL).toContain('required');
    expect(CREDENTIAL).toContain('disabled={authLoading}');
    expect(CREDENTIAL).toContain('autoFocus');
  });

  it('keeps the existing 6-digit authenticator step intact', () => {
    expect(CODE_STEP).toContain('id="admin-2fa-code"');
    expect(CODE_STEP).toContain('inputMode="numeric"');
    expect(CODE_STEP).toContain('autoComplete="one-time-code"');
    expect(CODE_STEP).toContain('maxLength={6}');
    expect(CODE_STEP).toContain('autoFocus');
    expect(CODE_STEP).toContain('required');
    expect(CODE_STEP).toContain('value={twoFactorCode}');
    expect(CODE_STEP).toContain('onChange={(e) => setTwoFactorCode(e.target.value)}');
    expect(CODE_STEP).toContain('disabled={twoFactorLoading}');
  });

  it('renders every field through a shared primitive, never a hand-built control', () => {
    expect(GATE).not.toMatch(/<label\b/);
    expect(GATE).not.toMatch(/<input\b/);
    expect(GATE).not.toMatch(/<button\b/);
    expect(GATE).not.toMatch(/<select\b/);
    expect(GATE).not.toMatch(/<textarea\b/);
    expect(GATE).toContain('<Input');
    expect(GATE).toContain('<Button');
    expect(count(GATE, /<Input/g)).toBe(3);
    expect(count(GATE, /<Button/g)).toBe(2);
  });

  it('meets the 44px control floor through the primitives, not a one-off height', () => {
    expect(INPUT_PRIMITIVE).toContain('w-full h-11');
    expect(BUTTON_PRIMITIVE).toContain("md: 'h-11");
    expect(BUTTON_PRIMITIVE).toContain("lg: 'h-13");
    expect(GATE).not.toMatch(/(?:^|\s)h-\[\d+px\]/);
  });
});

// -----------------------------------------------------------------------------
// D. One dominant action, with an honest loading state.
// -----------------------------------------------------------------------------

describe('UX-14 gives the gate one dominant action and an honest loading state', () => {
  it('has exactly one primary action, and it is the shared Button at 52px', () => {
    expect(primaryActions(FORM)).toBe(1);
    expect(SUBMIT).toContain('type="submit"');
    expect(SUBMIT).toContain('variant="primary"');
    expect(SUBMIT).toContain('size="lg"');
    expect(SUBMIT).toContain('className="w-full"');
    expect(SUBMIT).toContain('loading={isAuthBusy}');
    // Nothing competes with it: no second CTA, no secondary navigation.
    expect(count(GATE, /variant="outline"/g)).toBe(0);
    expect(count(GATE, /variant="accent"/g)).toBe(0);
    expect(count(GATE, /variant="danger"/g)).toBe(0);
    expect(GATE).not.toContain('Become an Agent');
  });

  it('communicates progress without inventing it, and cannot double-submit', () => {
    expect(SUBMIT).toContain("lang === 'en' ? 'Signing in…' : 'Inaingia…'");
    expect(SUBMIT).toContain("lang === 'en' ? 'Verifying…' : 'Inathibitisha…'");
    expect(SUBMIT).toContain("lang === 'en' ? 'Unlock System Console' : 'Fungua Konsoli ya Mfumo'");
    expect(SUBMIT).toContain("lang === 'en' ? 'Verify Code' : 'Thibitisha Msimbo'");
    // The shared primitive owns the disable + aria-busy behaviour.
    expect(BUTTON_PRIMITIVE).toContain('disabled={isDisabled}');
    expect(BUTTON_PRIMITIVE).toContain('aria-busy={loading || undefined}');
    expect(GATE).toContain('aria-busy={isAuthBusy || undefined}');
    expect(GATE).not.toMatch(/progress|percent|%/i);
  });

  it('derives the busy flag from the two states that already existed', () => {
    // No new state, no new request, no third request path: a render-time
    // derivation of the credential step and the 2FA step.
    expect(ADMIN_VIEW).toContain(
      'const isAuthBusy = pendingTwoFactorToken ? twoFactorLoading : authLoading;',
    );
    expect(GATE).not.toMatch(/setAuthLoading|setTwoFactorLoading/);
  });
});

// -----------------------------------------------------------------------------
// E. The error state — clear, accessible, and no more disclosing than before.
// -----------------------------------------------------------------------------

describe('UX-14 keeps the authentication error semantics intact', () => {
  it('renders the product error primitive in one live region', () => {
    expect(FEEDBACK).toContain('{authError && (');
    expect(FEEDBACK).toContain('<Banner kind="error">');
    expect(FEEDBACK).toContain('<span>{authError}</span>');
    // The primitive owns the announcement; the gate adds no ARIA of its own.
    expect(BANNER_PRIMITIVE).toContain("role={isInterruptive ? 'alert' : 'status'}");
    expect(BANNER_PRIMITIVE).toContain("aria-live={isInterruptive ? 'assertive' : 'polite'}");
    expect(GATE).not.toMatch(/\brole=\{?"/);
    expect(GATE).not.toMatch(/aria-live|aria-atomic|aria-describedby|aria-labelledby|aria-hidden/);
  });

  it('never uses a native blocking dialog', () => {
    expect(GATE).not.toMatch(/\b(?:alert|prompt|confirm)\s*\(/);
  });

  it('keeps the error form-level, so it still never names the bad credential', () => {
    // No per-field error prop is introduced on either step.
    expect(CREDENTIAL).not.toMatch(/\berror=\{/);
    expect(CODE_STEP).not.toMatch(/\berror=\{/);
    // The message is still whatever the server (or the existing fallback) said.
    expect(ADMIN_VIEW).toContain('setAuthError(e.message);');
    expect(ADMIN_VIEW).toContain("throw new Error(data.error || 'Incorrect password');");
    expect(ADMIN_VIEW).toContain("throw new Error(data.error || 'Incorrect 2FA code');");
  });
});

// -----------------------------------------------------------------------------
// F. The successful transition — same endpoints, same payloads, same token.
// -----------------------------------------------------------------------------

describe('UX-14 leaves the admin authentication mechanism byte-identical', () => {
  it('calls the same two endpoints with the same method, headers and bodies', () => {
    expect(ADMIN_VIEW).toContain("fetch('/api/auth/admin-login', {");
    expect(ADMIN_VIEW).toContain("fetch('/api/auth/admin-login/verify-2fa', {");
    expect(ADMIN_VIEW).toContain('method: \'POST\'');
    expect(ADMIN_VIEW).toContain("headers: { 'Content-Type': 'application/json' }");
    expect(ADMIN_VIEW).toContain('body: JSON.stringify({ username, passcode })');
    expect(ADMIN_VIEW).toContain(
      'body: JSON.stringify({ pendingToken: pendingTwoFactorToken, code: twoFactorCode })',
    );
  });

  it('hands the returned token to the same setToken in both branches', () => {
    expect(count(ADMIN_VIEW, /setToken\(data\.token\);/g)).toBe(2);
    expect(ADMIN_VIEW).toContain('setPendingTwoFactorToken(data.pendingToken);');
    expect(ADMIN_VIEW).toContain('setPendingTwoFactorToken(null);');
    // …and the session still lives in the same single localStorage key.
    expect(APP_TSX).toContain("localStorage.getItem('admin_token')");
    expect(APP_TSX).toContain("localStorage.setItem('admin_token', token)");
    expect(APP_TSX).toContain("localStorage.removeItem('admin_token')");
  });

  it('does not weaken logout or the console sign-out', () => {
    expect(ADMIN_VIEW).toContain('onClick={() => setToken(null)}');
    expect(APP_TSX).toContain('handleSetAdminToken(null)');
  });

  it('makes no authorization decision anywhere in the gate', () => {
    // Admin authorization stays server-side: the gate posts credentials, stores
    // the token it is given, and asserts no role of its own.
    expect(GATE).not.toMatch(/=== 'admin'|'admin' ===/);
    expect(GATE).not.toMatch(/\/api\/admin\//);
  });
});

// -----------------------------------------------------------------------------
// G. Appearance — tokens only, in both themes.
// -----------------------------------------------------------------------------

describe('UX-14 speaks the appearance tokens and nothing else', () => {
  it('builds the card from the semantic tokens', () => {
    expect(CARD_TSX).toContain('rounded-panel');
    expect(CARD_TSX).toContain('shadow-raised');
    expect(CARD_TSX).toContain('border-[var(--appearance-border)]');
    expect(CARD_TSX).toContain('bg-[var(--appearance-surface)]');
    expect(CARD_TSX).toContain('mx-auto w-full');
    expect(CARD_TSX).toContain('max-w-md');
    expect(CARD_TSX).toContain('p-6');
    expect(CARD_TSX).toContain('sm:p-8');
    expect(IDENTITY).toContain('text-[var(--appearance-text-primary)]');
    expect(IDENTITY).toContain('text-[var(--appearance-text-muted)]');
    // The names really do flip: each is declared for the light AND dark themes.
    expect(count(INDEX_CSS, /--appearance-surface:/g)).toBeGreaterThanOrEqual(2);
    expect(count(INDEX_CSS, /--appearance-text-primary:/g)).toBeGreaterThanOrEqual(2);
    expect(INDEX_CSS).toContain("html[data-theme='dark'] {");
  });

  it('reintroduces no legacy palette literal, radius or shadow', () => {
    expect(offLadderType(GATE)).toEqual([]);
    expect(legacyColour(GATE)).toEqual([]);
    expect(GATE).not.toMatch(/rounded-(?:xl|2xl|3xl)(?![\w-])/);
    expect(GATE).not.toMatch(/shadow-(?:sm|md|lg|xl)(?![\w-])/);
  });
});

// -----------------------------------------------------------------------------
// H. Accessibility.
// -----------------------------------------------------------------------------

describe('UX-14 is accessible without piling on ARIA', () => {
  it('associates a real, visible label with every control', () => {
    // The primitive owns the association and the description wiring.
    expect(INPUT_PRIMITIVE).toContain('htmlFor={inputId}');
    expect(INPUT_PRIMITIVE).toContain('<label');
    expect(INPUT_PRIMITIVE).toContain('aria-describedby={describedBy}');
    for (const label of ['Admin Username', 'Access Password', '6-Digit Authenticator Code']) {
      expect(GATE, `${label} must stay a visible label`).toContain(`'${label}'`);
    }
    expect(GATE).not.toContain('hideLabel');
  });

  it('keeps a semantic heading, a real submit and an announced busy state', () => {
    expect(count(IDENTITY, /<h1\b/g)).toBe(1);
    expect(SUBMIT).toContain('type="submit"');
    expect(FORM).toContain(
      'onSubmit={pendingTwoFactorToken ? handleTwoFactorVerify : handleAdminAuth}',
    );
    expect(GATE).toContain('aria-busy={isAuthBusy || undefined}');
    // No focus trap and no tab-order hacks: this is a page, not a dialog.
    expect(GATE).not.toMatch(/tabIndex|inert|aria-modal/);
    expect(GATE).not.toMatch(/role=\{?"dialog/);
  });

  it('adds no motion of its own and defers to the reduced-motion policy', () => {
    expect(GATE).not.toMatch(/animate-|transition-all/);
    expect(INDEX_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.fade-in \{\s*animation: none;/,
    );
  });
});

// -----------------------------------------------------------------------------
// I. Bilingual support, preserved and extended across the whole gate.
// -----------------------------------------------------------------------------

describe('UX-14 speaks both languages on the whole gate', () => {
  it('carries a Kiswahili twin for every visible string it introduces', () => {
    const pairs = bilingualPairs(GATE);
    expect(pairs.length).toBeGreaterThanOrEqual(11);
    for (const [en, sw] of pairs) {
      expect(sw.length, `${en} has an empty translation`).toBeGreaterThan(0);
      expect(sw, `${en} was left untranslated`).not.toBe(en);
    }
  });

  it('translates the load-bearing strings in place', () => {
    const expected: Array<[string, string]> = [
      ['Admin Authentication', 'Uthibitishaji wa Msimamizi'],
      ['Return4me administration', 'Utawala wa Return4me'],
      ['Admin Username', 'Jina la Mtumiaji wa Msimamizi'],
      ['Access Password', 'Nenosiri la Ufikiaji'],
      ['6-Digit Authenticator Code', 'Msimbo wa Kithibitishaji wa Tarakimu 6'],
      ['Back to password', 'Rudi kwenye nenosiri'],
      ['Unlock System Console', 'Fungua Konsoli ya Mfumo'],
      ['Verify Code', 'Thibitisha Msimbo'],
    ];
    for (const [en, sw] of expected) {
      expect(twinOf(GATE, en), `${en} must keep its Kiswahili twin`).toBe(sw);
    }
  });

  it('leaves the existing translation mechanism and its keys untouched', () => {
    expect(ADMIN_VIEW_TSX).toContain("import { translations } from '../types';");
    expect(ADMIN_VIEW_TSX).toContain('const t = translations[lang];');
    expect(ADMIN_VIEW_TSX).toContain('CONSOLE_SECTIONS[activeTab][lang]');
    // UX-14 added no key to the shared dictionary: it used the file's own
    // established `lang === 'en' ? … : …` convention, exactly as the console does.
    expect(count(ADMIN_VIEW_TSX, /lang === 'en' \? /g)).toBeGreaterThanOrEqual(6);
  });
});

// -----------------------------------------------------------------------------
// J. The Console is somebody else's batch — and it is still intact.
// -----------------------------------------------------------------------------

describe('UX-14 neither redesigns the Admin Console nor disturbs its contract', () => {
  it('keeps the gate free of any console concern', () => {
    expect(GATE).not.toContain('r4m-admin-nav');
    expect(GATE).not.toContain('activeTab');
    expect(GATE).not.toContain('CONSOLE_SECTIONS');
    expect(GATE).not.toContain('dashboardData');
  });

  it('still satisfies every fact adminConsoleShell.test.ts pins', () => {
    expect(ADMIN_VIEW_TSX).toContain('r4m-admin-nav');
    expect(ADMIN_VIEW_TSX).toContain("aria-current={activeTab === 'stats' ? 'page' : undefined}");
    expect(ADMIN_VIEW_TSX).toContain('{!token && (');
    expect(ADMIN_VIEW_TSX).toContain('Admin Authentication');
    expect(ADMIN_VIEW_TSX).toContain('pendingTwoFactorToken');
    expect(GATE_TSX).toContain('src="/assets/logo_wordmark_transparent.png"');
    expect(GATE_TSX).toContain('alt="Return4me"');
    expect(GATE_TSX).toMatch(/className="[^"]*w-auto[^"]*object-contain/);
    expect(GATE_TSX).not.toContain('<ShieldCheck');
    expect(ADMIN_VIEW_TSX).toContain('onClick={() => setToken(null)}');
    expect(ADMIN_VIEW_TSX).toContain('Authorization: `Bearer ${token}`');
  });
});

// -----------------------------------------------------------------------------
// K. The design-system reference records the batch.
// -----------------------------------------------------------------------------

describe('UX-14 records the batch in the design-system reference', () => {
  it('adds one UX-14 row and disturbs no neighbouring batch', () => {
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-14/g)).toBe(2);
    const row = DESIGN_SYSTEM.split(/\r?\n/).find((line) =>
      line.startsWith('| Admin authentication'),
    );
    expect(row, 'the design system must record the admin authentication gate').toBeDefined();
    expect(row as string).toContain('MIGRATED in UX-14');
    // The batches either side of this one keep their exact counts.
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-11/g)).toBe(2);
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-12/g)).toBe(1);
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-13/g)).toBe(1);
  });

  it('no longer claims that admin authentication is untouched', () => {
    expect(DESIGN_SYSTEM).not.toContain('admin authentication is a different audience and is untouched');
    expect(DESIGN_SYSTEM).not.toContain(
      'agent and admin authentication are a different audience and are untouched',
    );
  });
});

// -----------------------------------------------------------------------------
// Mutation checks — the guards above must FAIL when UX-14 is removed.
// -----------------------------------------------------------------------------

describe('UX-14 guards are live, not decorative (mutation checks)', () => {
  it('detects a reintroduced off-ladder type size', () => {
    expect(offLadderType(GATE)).toEqual([]);
    expect(offLadderType(`${GATE}\n<p className="text-[11px]">`)).not.toEqual([]);
    expect(offLadderType(`${GATE}\n<p className="text-xs">`)).not.toEqual([]);
  });

  it('detects a reintroduced legacy colour literal', () => {
    expect(legacyColour(GATE)).toEqual([]);
    expect(legacyColour(`${GATE} bg-stone-100`)).not.toEqual([]);
    expect(legacyColour(`${GATE} bg-white`)).not.toEqual([]);
    expect(legacyColour(`${GATE} text-[#003820]`)).not.toEqual([]);
  });

  it('detects a second competing primary action', () => {
    expect(primaryActions(FORM)).toBe(1);
    expect(primaryActions(`${FORM}\n<Button variant="primary">Go</Button>`)).toBe(2);
  });

  it('detects an untranslated visible string', () => {
    const pairs = bilingualPairs(GATE);
    expect(pairs.every(([en, sw]) => sw !== en)).toBe(true);
    const mutated = GATE.replace("'Uthibitishaji wa Msimamizi'", "'Admin Authentication'");
    expect(bilingualPairs(mutated).some(([en, sw]) => sw === en)).toBe(true);
  });

  it('detects a hand-built control on the gate', () => {
    expect(GATE).not.toMatch(/<input\b/);
    expect(`${GATE}\n<input id="x" />`).toMatch(/<input\b/);
  });

  it('the scope slice itself is load-bearing: moving the gate breaks it', () => {
    expect(() =>
      sliceBetween(ADMIN_VIEW_TSX, '{!token && (', '{/* 2. DISTINCT LOADING'),
    ).not.toThrow();
    expect(() =>
      sliceBetween(
        ADMIN_VIEW_TSX.replace('{!token && (', ''),
        '{!token && (',
        '{/* 2. DISTINCT LOADING',
      ),
    ).toThrow();
  });
});

