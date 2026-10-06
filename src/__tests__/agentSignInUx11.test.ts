import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-11 — THE AGENT SIGN-IN EXPERIENCE (AgentView.tsx, signed-out card)
// =============================================================================
// The agent sign-in surface was still written against the pre-UX-01 vocabulary:
// a hand-styled `bg-white`/`stone-*` card that announced itself as "Return4me
// Agent Hub" rather than as a sign-in page, a 36px register/sign-in switch with
// no pressed-state semantics, credential fields with no autofill semantics and a
// `focus:outline-none`, off-ladder `text-[11px]` captions, two competing
// full-width buttons of equal weight, and an error box whose raw `red-*` colours
// did not flip in dark mode. Nothing told a visitor that this page is for
// approved Return4me Agents, or where somebody who is not one yet should go.
//
// UX-11 IS PRESENTATION ONLY. It deliberately changes none of:
//   * the authentication protocol — the same two endpoints are called in the
//     same order with byte-identical bodies (`/api/auth/request-otp` with the
//     phone; `/api/auth/verify-otp` with the phone, the code and the same 17
//     registration fields);
//   * the security model — the same bearer token returned by verify-otp is
//     handed to the same `setToken` (localStorage `agent_token` in App.tsx);
//     no second storage mechanism and no second credential field appear;
//   * the agent registration flow inside the same card (UX-12's scope: the same
//     fields, the same validation, the same submit);
//   * the route architecture — the new secondary path calls the SAME
//     /become-an-agent destination the navbar and homepage already use.
// What it changes is hierarchy, control semantics, the type/colour/radius
// vocabulary and the copy in both languages — all of it by adopting primitives
// and tokens that already exist (`Button`, `Input`, `Banner`, `ICON_SIZE`, the
// `--appearance-*` tokens, the type/radius/elevation ladders), exactly as UX-07
// did for customer authentication and UX-10 did for the public agent page.
//
// This repository has no jsdom/React harness, so — exactly as the UX-06, UX-07,
// UX-08, UX-09 and UX-10 suites do — the contract is asserted against the
// shipped source, with the same comment stripper and the same `sliceBetween`
// helper. No snapshots and no line-number assertions are used anywhere.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the N3, UX-06, UX-07, UX-08, UX-09 and UX-10 suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const VIEW_TSX = read('src/components/AgentView.tsx');
const VIEW = stripComments(VIEW_TSX);
const APP_TSX = read('src/App.tsx');
const INDEX_CSS = read('src/index.css');
const PUBLIC_ROUTES = read('src/utils/publicRoutes.ts');
const DESIGN_SYSTEM = read('docs/design-system.md');
const BUTTON_PRIMITIVE = read('src/components/ui/Button.tsx');

/**
 * The signed-out card — the whole Agent sign-in surface — sliced from the RAW
 * source between its own section comment and the next card, so the registration
 * branch inside the same card is included but the hub never is.
 */
const CARD_RAW = sliceBetween(VIEW_TSX, '{/* 1. AGENT SIGN-IN CARD', '{/* 2. QUEUE LOADING');

/**
 * The UX-11 regions, sliced on the real JSX that delimits them and then
 * comment-stripped, so a comment can never be mistaken for rendered copy.
 */
const IDENTITY = stripComments(sliceBetween(CARD_RAW, '{!token && (', '{authError && ('));
const FEEDBACK = stripComments(sliceBetween(CARD_RAW, '{authError && (', '{showOtp ? ('));
const CODE_STEP = stripComments(sliceBetween(CARD_RAW, '{showOtp ? (', ') : ('));
const REQUEST_FORM = stripComments(
  sliceBetween(CARD_RAW, ') : (', '{!showOtp && !isRegistering && ('),
);
const NOT_AGENT = stripComments(
  CARD_RAW.slice(CARD_RAW.indexOf('{!showOtp && !isRegistering && (')),
);
const MODES = sliceBetween(REQUEST_FORM, 'role="group"', '{isRegistering && (');
const CREDENTIAL = sliceBetween(REQUEST_FORM, '<Input', '{isRegistering && (');
const PRIMARY = sliceBetween(REQUEST_FORM, '<Button type="submit"', '</Button>');

/** Everything UX-11 actually renders on the sign-in surface. */
const SIGN_IN_SURFACE = [
  IDENTITY,
  FEEDBACK,
  CODE_STEP,
  MODES,
  CREDENTIAL,
  PRIMARY,
  NOT_AGENT,
].join('\n');

/**
 * Every `tr('english', 'kiswahili')` pair in a stripped source string. Either
 * quote style is accepted; the trailing comma some call sites carry is optional,
 * and so is the argument layout. The pair is the contract, not the punctuation.
 */
function bilingualPairs(source: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const re =
    /\btr\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    pairs.push([match[1] ?? match[2], match[3] ?? match[4]]);
  }
  return pairs;
}

/* ---------------------------------------------------------------------------
 * The three guards the mutation checks at the bottom re-run against a
 * deliberately broken copy of the surface, so the checks cannot silently rot.
 * ------------------------------------------------------------------------- */
/** Off-ladder / sub-12px type: the UX-01 ladder is the only scale allowed. */
const offLadderType = (source: string): string[] => [
  ...(source.match(/text-\[\d+px\]/g) || []),
  ...(source.match(/text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?![\w-])/g) || []),
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
// A. Identity / context — the page says whose door this is.
// -----------------------------------------------------------------------------

describe('UX-11 gives the agent sign-in surface an identity of its own', () => {
  it('establishes Agent sign in, in both languages, above the form', () => {
    expect(IDENTITY).toContain("tr('Agent sign in', 'Kuingia kwa wakala')");
    expect(IDENTITY).toContain('This page is for approved Return4me Agents.');
    expect(IDENTITY).toContain('Ukurasa huu ni wa mawakala wa Return4me walioidhinishwa.');
    // A real page heading, not a div.
    expect(IDENTITY).toMatch(/<h1\b/);
    expect(count(IDENTITY, /<h1\b/g)).toBe(1);
  });

  it('keeps the registration mode heading and the one-time-code step honest', () => {
    // The registration branch keeps the existing translated title (UX-12 owns
    // that copy); the code step names itself instead of still saying "Hub".
    expect(IDENTITY).toContain('t.agentTitle');
    expect(IDENTITY).toContain("tr('Confirm your code', 'Thibitisha msimbo wako')");
    // E1: the agent sign-in code is emailed to the agent's verified contact
    // address, so the step must name the EMAIL channel and stop promising an SMS.
    expect(IDENTITY).toContain('Enter the one-time code we sent to your verified email address.');
    expect(IDENTITY).toContain('Weka msimbo wa mara moja tulioutuma kwenye barua pepe yako iliyothibitishwa.');
  });
});

// -----------------------------------------------------------------------------
// B/C. The credential fields, and the one dominant action.
// -----------------------------------------------------------------------------

describe('UX-11 keeps the real credential fields and one dominant action', () => {
  it('still carries the two existing credential fields, as accessible inputs', () => {
    for (const id of ['agent-phone', 'agent-otp']) {
      expect(VIEW_TSX, `the ${id} field must survive UX-11`).toContain(`id="${id}"`);
    }
    expect(CREDENTIAL).toContain('<Input');
    expect(CREDENTIAL).toContain('value={phone}');
    expect(CREDENTIAL).toContain('onChange={(e) => setPhone(e.target.value)}');
  });

  it('declares the phone field semantics a mobile sign-in needs', () => {
    expect(CREDENTIAL).toContain('type="tel"');
    expect(CREDENTIAL).toContain('inputMode="tel"');
    expect(CREDENTIAL).toContain('autoComplete="tel"');
    expect(CREDENTIAL).toContain("label={tr('Phone number', 'Namba ya simu')}");
    expect(CREDENTIAL).toContain('required');
  });

  it('declares one-time-code semantics on the code step', () => {
    expect(CODE_STEP).toContain('inputMode="numeric"');
    expect(CODE_STEP).toContain('autoComplete="one-time-code"');
    expect(CODE_STEP).toContain('maxLength={4}');
    expect(CODE_STEP).toContain('required');
    expect(CODE_STEP).toContain('value={otp}');
    expect(CODE_STEP).toContain('onChange={(e) => setOtp(e.target.value)}');
    expect(CODE_STEP).toContain("label={tr('Verification code', 'Msimbo wa uthibitisho')}");
  });

  it('renders every field through a shared primitive, never a hand-built control', () => {
    // No hand-written <label>/<input> anywhere on the sign-in surface: the
    // primitive owns the association, the focus treatment and the error wiring.
    expect(SIGN_IN_SURFACE).not.toMatch(/<label\b/);
    expect(CREDENTIAL).not.toMatch(/<input\b/);
    expect(CODE_STEP).not.toMatch(/<input\b/);
    expect(VIEW_TSX).toContain("import { Banner, Button, ICON_SIZE, Input } from './ui';");
  });

  it('has exactly one primary action, and it is the shared Button at 44px+', () => {
    expect(count(PRIMARY, /<Button/g)).toBe(1);
    expect(PRIMARY).toContain('type="submit"');
    expect(PRIMARY).toContain('variant="primary"');
    expect(PRIMARY).toContain('size="lg"');
    expect(PRIMARY).toContain('loading={authLoading}');
    expect(PRIMARY).toContain("tr('Sign in', 'Ingia')");
    // 52px ladder step (>= the 44px floor) comes from the primitive, not a
    // one-off height on this screen.
    expect(BUTTON_PRIMITIVE).toContain("md: 'h-11");
    expect(BUTTON_PRIMITIVE).toContain("lg: 'h-13");
    expect(PRIMARY).not.toMatch(/[a-z-]*:\s*h-\[\d+px\]/);
  });

  it('never puts a second primary action beside the sign-in action', () => {
    expect(primaryActions(REQUEST_FORM)).toBe(1);
    // Nothing competes with the brand primary: the mode switch is a pressed-state
    // control and the secondary route is an outline button.
    expect(count(SIGN_IN_SURFACE, /variant="accent"/g)).toBe(0);
    expect(count(NOT_AGENT, /variant="primary"/g)).toBe(0);
    expect(NOT_AGENT).toContain('variant="outline"');
  });
});

// -----------------------------------------------------------------------------
// E. Existing data path — the two endpoints and their bodies are untouched.
// -----------------------------------------------------------------------------

const REQUEST_CALL = sliceBetween(
  VIEW,
  "fetch('/api/auth/request-otp'",
  '});',
);
const VERIFY_CALL = sliceBetween(
  VIEW,
  "fetch('/api/auth/verify-otp'",
  'idDocumentPhotoBase64,',
);

describe('UX-11 leaves the agent authentication contract byte-identical', () => {
  it('requests the one-time code from the same endpoint with the same body', () => {
    expect(REQUEST_CALL).toContain("fetch('/api/auth/request-otp'");
    expect(REQUEST_CALL).toContain("method: 'POST'");
    expect(REQUEST_CALL).toContain("'Content-Type': 'application/json'");
    expect(REQUEST_CALL).toContain('body: JSON.stringify({ phone })');
    // F-3 (Batch 3) removed a dead registration payload from this call; UX-11
    // must not reintroduce one.
    expect(REQUEST_CALL).not.toContain('role:');
  });

  it('verifies the code at the same endpoint with the same 17-field payload', () => {
    expect(VERIFY_CALL).toContain("fetch('/api/auth/verify-otp'");
    expect(VERIFY_CALL).toContain("method: 'POST'");
    for (const field of [
      'phone,',
      'code: otp,',
      "role: 'agent',",
      'businessName,',
      'locationAddress,',
      'county: agentCounty,',
      'administrativeUnitId: agentAdministrativeUnitId,',
      'latitude: agentLatitude,',
      'longitude: agentLongitude,',
      'locationAccuracy: agentLocationAccuracy,',
      'payoutMethodType,',
      'tillNumber,',
      'nationalId,',
      'termsAccepted: agreedTerms,',
      'contactEmail,',
      'shopPhotoBase64,',
    ]) {
      expect(VERIFY_CALL, `verify-otp payload field ${field}`).toContain(field);
    }
  });

  it('keeps the success path: the code step, then the same token handoff', () => {
    // A successful request opens the code step…
    expect(VIEW).toContain('setShowOtp(true);');
    // …and a successful verification hands the SAME token to the SAME setter,
    // plus the existing N4 email-axis display flag.
    expect(VIEW).toContain('setToken(data.token);');
    expect(VIEW).toContain('setAwaitingEmailVerification(');
    expect(count(VIEW, /setToken\(data\.token\)/g)).toBe(1);
  });

  it('keeps the failure handling and the single error render intact', () => {
    // Exactly the two authentication code paths write authError, exactly as
    // PHASE 16.1 BATCH 3 (F-1) requires.
    expect(count(VIEW, /setAuthError\(e\.message\)/g)).toBe(2);
    expect(count(VIEW, /\{authError && \(/g)).toBe(1);
    expect(VIEW).toContain('<span>{authError}</span>');
    expect(FEEDBACK).toContain('<Banner kind="error">');
    // Loading protection: both steps disable their controls and announce the
    // busy state while the existing submission is in flight.
    expect(CODE_STEP).toContain('disabled={authLoading}');
    expect(CREDENTIAL).toContain('disabled={authLoading}');
    expect(CODE_STEP).toContain('aria-busy={authLoading || undefined}');
    expect(count(VIEW_TSX, /aria-busy=\{/g)).toBeGreaterThanOrEqual(3);
  });
});

// -----------------------------------------------------------------------------
// Security — no new credential exposure, no new storage, no new transport.
// -----------------------------------------------------------------------------

describe('UX-11 introduces no new authentication surface or storage', () => {
  it('never renders a credential as text', () => {
    // The code and the phone appear only as control values, never as copy.
    expect(count(SIGN_IN_SURFACE, /\{otp\}/g)).toBe(1);
    expect(SIGN_IN_SURFACE).toContain('value={otp}');
    expect(SIGN_IN_SURFACE).not.toMatch(/<[^>]+>\s*\{otp\}\s*</);
    expect(SIGN_IN_SURFACE).not.toContain('type="password"');
    expect(count(SIGN_IN_SURFACE, /console\.(log|info|warn|error|debug)/g)).toBe(0);
  });

  it('does not move authentication state into a different mechanism', () => {
    // App.tsx still owns the ONE agent session: the same localStorage key, read
    // and written by the same handlers, unchanged by UX-11.
    expect(APP_TSX).toContain("localStorage.getItem('agent_token')");
    expect(APP_TSX).toContain("localStorage.setItem('agent_token', token)");
    expect(APP_TSX).toContain("localStorage.removeItem('agent_token')");
    expect(count(APP_TSX, /agent_token/g)).toBe(3);
    // …and the sign-in surface itself touches no storage at all.
    expect(count(stripComments(CARD_RAW), /localStorage|sessionStorage|document\.cookie/g)).toBe(0);
  });

  it('adds no authentication library and no second credential field', () => {
    expect(VIEW_TSX).not.toMatch(/microsoft|firebase|auth0|clerk|next-auth|supabase/i);
    expect(count(VIEW_TSX, /^import .* from '\.\/ui';$/gm)).toBe(1);
    // Two credential fields, unchanged: the phone and the one-time code.
    expect(count(VIEW, /id="agent-phone"/g)).toBe(1);
    expect(count(VIEW, /id="agent-otp"/g)).toBe(1);
  });

  it('keeps the existing, non-disclosing failure semantics', () => {
    // The message shown is still the one the existing contract defines — the
    // server's own error, with the same generic fallbacks. UX-11 adds none.
    expect(VIEW).toContain("data.error || 'Failed to dispatch OTP'");
    expect(VIEW).toContain("data.error || 'OTP Verification failed'");
    expect(SIGN_IN_SURFACE).not.toMatch(/no account|not registered|wrong code|incorrect code|unknown number/i);
  });
});

// -----------------------------------------------------------------------------
// UX — the design-system contract, in both languages, in both themes.
// -----------------------------------------------------------------------------

describe('UX-11 speaks the shared vocabulary and nothing else', () => {
  it('introduces no off-ladder or sub-12px type', () => {
    expect(offLadderType(SIGN_IN_SURFACE)).toEqual([]);
    // …and it does use the ladder deliberately: a page-scale heading, body copy
    // and a caption eyebrow.
    expect(SIGN_IN_SURFACE).toMatch(/text-(section|page)\b/);
    expect(SIGN_IN_SURFACE).toContain('text-body');
    expect(SIGN_IN_SURFACE).toContain('text-caption');
  });

  it('drops every pre-UX-01 colour literal for a theme-aware token', () => {
    expect(legacyColour(SIGN_IN_SURFACE)).toEqual([]);
    // What replaced them: the token layer, and only tokens the stylesheet
    // actually declares (a typo'd token fails silently in CSS).
    const tokens = Array.from(new Set(SIGN_IN_SURFACE.match(/var\(--[a-z0-9-]+\)/g) || []));
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(INDEX_CSS, `undeclared token ${token}`).toContain(`${token.slice(4, -1)}:`);
      // Every one of them has a light AND a dark value, so the surface flips.
      expect(
        (INDEX_CSS.match(new RegExp(`${token.slice(4, -1)}:`, 'g')) || []).length,
        `${token} must exist in both appearance scopes`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('walks the shared radius and elevation ladders', () => {
    expect(SIGN_IN_SURFACE).toMatch(/\brounded-(panel|standard|small)\b/);
    expect(SIGN_IN_SURFACE).not.toMatch(/\brounded-(xl|2xl|3xl|md|full)\b/);
    expect(SIGN_IN_SURFACE).toContain('shadow-raised');
    expect(SIGN_IN_SURFACE).not.toMatch(/shadow-\[/);
  });

  it('sizes every icon from the ICON_SIZE ladder and keeps it decorative', () => {
    expect(SIGN_IN_SURFACE).toContain('size={ICON_SIZE.heading}');
    expect(count(SIGN_IN_SURFACE, /size=\{\d+\}/g)).toBe(0);
    expect(IDENTITY).toContain('aria-hidden="true"');
  });

  it('never suppresses the shared focus treatment', () => {
    expect(SIGN_IN_SURFACE).not.toContain('outline-none');
    expect(SIGN_IN_SURFACE).not.toContain('focus-visible:ring');
  });

  it('gives the mode switch 44px targets and real pressed-state semantics', () => {
    expect(MODES).toContain('role="group"');
    expect(MODES).toContain('aria-label={tr(');
    expect(count(MODES, /aria-pressed=/g)).toBe(2);
    expect(count(MODES, /min-h-11/g)).toBe(2);
    expect(count(MODES, /type="button"/g)).toBe(2);
    // The two existing labels survive, now bilingual.
    expect(MODES).toContain("tr('Agent Login', 'Kuingia kwa Wakala')");
    expect(MODES).toContain("tr('Apply to be Agent', 'Omba kuwa Wakala')");
  });

  it('introduces no native browser dialog for product feedback', () => {
    const card = stripComments(CARD_RAW);
    expect(card).not.toMatch(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  });

  it('communicates the loading state through the shared primitive', () => {
    expect(PRIMARY).toContain('loading={authLoading}');
    expect(count(CODE_STEP, /loading=\{authLoading\}/g)).toBe(1);
    expect(BUTTON_PRIMITIVE).toContain('aria-busy={loading || undefined}');
    expect(CODE_STEP).toContain("tr('Verifying…', 'Inathibitisha…')");
  });
});

// -----------------------------------------------------------------------------
// Bilingual — every string UX-11 introduces exists in English AND Kiswahili.
// -----------------------------------------------------------------------------

describe('UX-11 is bilingual, and no new string ships untranslated', () => {
  it('renders every sign-in string through one tr(en, sw) call', () => {
    const pairs = bilingualPairs(SIGN_IN_SURFACE);
    expect(pairs.length, 'the sign-in surface must carry real copy').toBeGreaterThanOrEqual(11);
    // Every `tr(` call site is a pair, so a one-argument English-only call — a
    // string a translator never sees — cannot slip in unnoticed.
    expect(count(SIGN_IN_SURFACE, /\btr\(/g)).toBe(pairs.length);
    for (const [en, sw] of pairs) {
      expect(en.trim(), `empty EN string`).not.toBe('');
      expect(sw.trim(), `empty SW string for "${en}"`).not.toBe('');
      // An untranslated string is the commonest bilingual regression: the
      // English side pasted into the Kiswahili slot.
      expect(sw, `untranslated: "${en}"`).not.toBe(en);
    }
  });

  it('pairs each visible sign-in string in both languages, in one call', () => {
    for (const pair of [
      "tr('Agent sign in', 'Kuingia kwa wakala')",
      "tr('Confirm your code', 'Thibitisha msimbo wako')",
      "tr('Phone number', 'Namba ya simu')",
      "tr('Verification code', 'Msimbo wa uthibitisho')",
      "tr('Sign in', 'Ingia')",
      "tr('Verify and continue', 'Thibitisha na uendelee')",
      "tr('Verifying…', 'Inathibitisha…')",
      "tr('Use a different number', 'Tumia nambari nyingine')",
      "tr('Need to become an Agent?', 'Unahitaji kuwa Wakala?')",
      "tr('Become an Agent', 'Kuwa Wakala')",
      "tr('Agent Login', 'Kuingia kwa Wakala')",
      "tr('Apply to be Agent', 'Omba kuwa Wakala')",
    ]) {
      expect(VIEW_TSX, `missing bilingual call: ${pair}`).toContain(pair);
    }
  });
});

// -----------------------------------------------------------------------------
// Navigation — the secondary path is the EXISTING public agent journey.
// -----------------------------------------------------------------------------

describe('UX-11 routes to the existing Become an Agent destination', () => {
  it('sends the not-yet-an-agent path to the existing public journey', () => {
    // The same in-file navigation handle the Terms and Privacy links use: no
    // router, no second navigation system, and no URL rewriting from a view.
    expect(NOT_AGENT).toContain("(window as any).setView?.('becomeAgent')");
    expect(NOT_AGENT).not.toContain('pushState');
    expect(NOT_AGENT).not.toContain('replaceState');
    expect(NOT_AGENT).not.toContain('location.href');
    expect(VIEW_TSX).not.toMatch(/from 'react-router/);
  });

  it('names the destination view the public route table already maps', () => {
    // 'becomeAgent' is the EXISTING view name, and publicRoutes maps it to the
    // EXISTING path. UX-11 adds neither a route nor a path.
    expect(PUBLIC_ROUTES).toContain("const BECOME_AGENT_PATH = '/become-an-agent';");
    expect(PUBLIC_ROUTES).toContain("{ path: BECOME_AGENT_PATH, view: 'becomeAgent' },");
    expect(count(PUBLIC_ROUTES, /BECOME_AGENT_PATH/g)).toBe(2);
  });

  it('adds no prop and no signature change to the agent surface', () => {
    // The refinement is presentation-only, so AgentView keeps the exact
    // signature App already renders it with (and no new prop).
    expect(VIEW_TSX).toContain(
      'export default function AgentView({ lang, token, setToken, categories, refreshCategories }: AgentViewProps) {',
    );
    expect(VIEW_TSX).not.toContain('onBecomeAgent');
    expect(count(VIEW_TSX, /export default function AgentView/g)).toBe(1);
  });

  it('creates no new route and leaves the public route model intact', () => {
    expect(PUBLIC_ROUTES).not.toMatch(/agent-sign-in|agentSignIn|agent-signin/);
    expect(count(PUBLIC_ROUTES, /export type PublicViewName =/g)).toBe(1);
    // 'signin' and 'becomeAgent' stay the restorable public views; the
    // authenticated surfaces stay excluded, exactly as UX-02 established.
    expect(PUBLIC_ROUTES).toMatch(/RESTORABLE_VIEWS[^=]*=\s*\[[^\]]*'becomeAgent'/);
    expect(PUBLIC_ROUTES).not.toMatch(/RESTORABLE_VIEWS[^=]*=\s*\[[^\]]*'agent'/);
  });

  it('records the batch in the design-system reference', () => {
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-11/g)).toBe(2);
    const row = DESIGN_SYSTEM.split('\n').find((line) => line.startsWith('| Agent sign in'));
    expect(row, 'the design system must record the agent sign-in surface').toBeDefined();
    expect(row as string).toContain('MIGRATED in UX-11');
    // …and the UX-07 claim that agent authentication was untouched is corrected.
    expect(DESIGN_SYSTEM).not.toContain(
      'agent and admin authentication are a different audience and are untouched',
    );
  });
});

// -----------------------------------------------------------------------------
// Mutation checks — the guards above must FAIL when UX-11 is removed.
// -----------------------------------------------------------------------------

describe('UX-11 guards are live, not decorative (mutation checks)', () => {
  it('detects a reintroduced off-ladder type size', () => {
    expect(offLadderType(SIGN_IN_SURFACE)).toEqual([]);
    expect(offLadderType(`${SIGN_IN_SURFACE}\n<p className="text-[11px]">`)).not.toEqual([]);
    expect(offLadderType(`${SIGN_IN_SURFACE}\n<p className="text-xs">`)).not.toEqual([]);
  });

  it('detects a reintroduced legacy colour literal', () => {
    expect(legacyColour(SIGN_IN_SURFACE)).toEqual([]);
    expect(legacyColour(`${SIGN_IN_SURFACE} bg-stone-100`)).not.toEqual([]);
    expect(legacyColour(`${SIGN_IN_SURFACE} bg-white`)).not.toEqual([]);
    expect(legacyColour(`${SIGN_IN_SURFACE} text-[#003820]`)).not.toEqual([]);
  });

  it('detects a second competing primary action', () => {
    expect(primaryActions(REQUEST_FORM)).toBe(1);
    expect(primaryActions(`${REQUEST_FORM}\n<Button variant="primary">Go</Button>`)).toBe(2);
  });

  it('detects an untranslated string', () => {
    const pairs = bilingualPairs(SIGN_IN_SURFACE);
    expect(pairs.every(([en, sw]) => sw !== en)).toBe(true);
    const mutated = SIGN_IN_SURFACE.replace("'Ingia'", "'Sign in'");
    expect(bilingualPairs(mutated).some(([en, sw]) => sw === en)).toBe(true);
  });

  it('detects a missing mode-switch pressed state', () => {
    expect(count(MODES, /aria-pressed=/g)).toBe(2);
    const mutated = MODES.replace(/aria-pressed=\{[^}]*\}/g, '');
    expect(count(mutated, /aria-pressed=/g)).toBe(0);
  });
});




const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`UX-11 marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}
