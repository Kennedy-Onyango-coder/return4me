import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// LOGIN RECOVERY — THE AGENT CODE STEP MUST NOT READ AS A DELIVERY PROMISE
// =============================================================================
// THE DEFECT (measured, not assumed). An approved agent whose account has no
// VERIFIED email address can still reach POST /api/auth/request-otp, but the
// server resolves the delivery destination from `contact_email AND
// email_verified_at`. For that account there is no destination, so nothing is
// dispatched — while the response stays deliberately generic (server.ts's
// anti-enumeration branch answers byte-identically for every account state).
// The signed-out card nevertheless stated, UNCONDITIONALLY:
//
//   "Enter the one-time code we sent to your verified email address."
//
// So an agent in that state was told a code had been sent, received nothing,
// and had no way to learn why. Two reachable states hit it:
//   * ACTIVE + contact_email + email_verified_at IS NULL -> 403 at /api/agents/queue
//   * ACTIVE + NO contact_email at all (legacy, pre-N4) -> 200 at /api/agents/queue
// The second is the crueller of the two: the agent is fully authorised and the
// API works, but the only credential path in is an OTP that cannot be delivered.
// That is a dead end which is invisible from the UI.
//
// THE FIX (additive, E1-safe). The pinned sentence belongs to
// agentSignInUx11:144 (+ its Kiswahili twin at :145) and
// publicHelpBatch13:242, and is NOT touched. Instead the code step carries an
// honest note that makes the step CONDITIONAL: a code can only be sent to a
// verified address, so an unverified account sends nothing.
//
// STATIC TEXT IS THE SECURITY REQUIREMENT, NOT A STYLE PREFERENCE. Any note that
// branched on the request response (its message, its status, a `success` flag)
// would become exactly the enumeration oracle the server refuses to be. The note
// is account-agnostic copy, shown to everyone identically.
//
// WHY PLAIN ENGLISH AND NOT tr(en, sw). This snapshot's AgentView has no `tr`
// helper at all — `git grep -F "tr('" src/components/AgentView.tsx` returns 0
// hits, and only `const t = translations.en` exists — so a tr(...) call would
// not compile. Restoring that bilingual layer is a separate work item (it is why
// agentSignInUx11 is currently red); the assertion below pins the debt
// deliberately rather than pretending it is gone.
//
// Same comment stripper / slice conventions as the UX-11, UX-07 and UX-10
// suites: the contract is asserted against the shipped source, with no snapshots
// and no line-number assertions.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the N3, UX-06..UX-11 suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const count = (source: string, re: RegExp) => (source.match(re) || []).length;
/** From `start` (inclusive) to `end` (exclusive); '' when either marker is absent. */
function sliceBetween(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  if (a === -1) return '';
  const b = source.indexOf(end, a + start.length);
  return b === -1 ? '' : source.slice(a, b);
}

const VIEW_TSX = read('src/components/AgentView.tsx');
const VIEW = stripComments(VIEW_TSX);
const INDEX_CSS = read('src/index.css');

/** The signed-out card, sliced on the same section comments UX-11 slices on. */
const CARD = stripComments(
  sliceBetween(VIEW_TSX, '{/* 1. AGENT SIGN-IN CARD', '{/* 2. QUEUE LOADING'),
);

/**
 * The additive recovery note, sliced from the marker comment that introduces it
 * to the closing tag of its own element. Sliced from the RAW source so the
 * comment cannot be mistaken for rendered copy, then comment-stripped.
 *
 * The slice MUST start at the `{/*` opener, not at the marker word itself: a
 * slice that begins inside a block comment leaves the stripper nothing to match,
 * and the comment's own prose would then be asserted on as if it were rendered
 * copy (guarding the guard, not the UI).
 */
const NOTE = stripComments(sliceBetween(VIEW_TSX, '{/* LOGIN-DEAD-END', '</p>'));

/** The E1 sentence the note must QUALIFY rather than replace. */
const E1_PROMISE = 'Enter the one-time code we sent to your verified email address.';
/** The honest qualifier that turns the step from a promise into a condition. */
const QUALIFIER = 'If no code arrives';

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

// -----------------------------------------------------------------------------
// 1. The step stops promising what the server may never deliver.
// -----------------------------------------------------------------------------

describe('LOGIN-RECOVERY — the code step stops promising a delivery it may not make', () => {
  it('keeps the E1 sentence byte-identical, and qualifies it AFTER it', () => {
    // The pinned sentence is owned by agentSignInUx11:144 and
    // publicHelpBatch13:242 — this suite must never be why it changes.
    expect(CARD).toContain(E1_PROMISE);
    expect(CARD).toContain(QUALIFIER);
    // Order is the contract: the last word on delivery must be the honest one,
    // so an agent reading top-down cannot be left promising themselves a code
    // that is not coming.
    expect(CARD.indexOf(QUALIFIER)).toBeGreaterThan(CARD.indexOf(E1_PROMISE));
  });

  it('names only what is true today, and promises no capability that does not exist', () => {
    expect(NOTE, 'the note must survive the marker slice').not.toBe('');
    expect(NOTE).toContain('spam or junk folder');
    expect(NOTE).toContain('verified email address');
    // The condition, stated so it is TRUE for every account state: legacy agents
    // have no address to verify, unverified agents have one unverified, and both
    // are correctly told that nothing was sent.
    expect(NOTE).toContain('no code is sent');
    for (const forbidden of [
      // The retired delivery promises, in both languages.
      'We sent it to',
      'Tuliituma kwa',
      'Umetumwa kwa',
      'We text a one-time code to this number to verify it.',
      'Tunatuma msimbo wa mara moja kwa nambari hii',
      // The Help-surface promise Batch 13 retired; it must not reappear here.
      'Support can reissue a code',
      // Requirement 5 is NOT implemented: there is no resend endpoint and no
      // admin control, so the note may not imply one exists.
      'resend',
      'Resend',
      'send the code again',
      'guarantee',
      // The other false claim this note deliberately avoids: we cannot say we
      // emailed a link to an account that has no address on file.
      'we emailed you',
      'the link we sent you',
    ]) {
      expect(NOTE, `the recovery note must not carry: ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// -----------------------------------------------------------------------------
// 2. The note is static, announces nothing, and uses the shared ladders.
// -----------------------------------------------------------------------------

describe('LOGIN-RECOVERY — the note stays account-agnostic and design-system clean', () => {
  it('never branches on the request response, and never announces itself', () => {
    // STATICNESS IS THE ANTI-ENUMERATION PROPERTY. Any of these in the note
    // would turn honest copy into a per-account oracle.
    for (const stateful of ['res.', '.message', 'success', 'status ===', 'authError']) {
      expect(NOTE, `the note must not read the response via: ${stateful}`).not.toContain(stateful);
    }
    // The card already carries exactly one live region (the auth-error region);
    // a second one would re-announce on every keystroke for screen readers.
    expect(count(NOTE, /role=/g)).toBe(0);
    expect(count(NOTE, /aria-live/g)).toBe(0);
    expect(count(CARD, /role="status"/g)).toBe(0);
  });

  it('uses only the shared type/colour ladders, and only defined CSS variables', () => {
    expect(offLadderType(NOTE)).toEqual([]);
    expect(legacyColour(NOTE)).toEqual([]);
    const tokens = Array.from(new Set(NOTE.match(/var\(--[a-z0-9-]+\)/g) || []));
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      const name = token.slice('var('.length, -')'.length);
      expect(INDEX_CSS, `${name} must be defined in src/index.css`).toContain(name);
    }
    // No new primary action: the step keeps exactly one, the submit.
    expect(count(NOTE, /variant="primary"/g)).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// 3. Tripwires: a copy change may not ride along with a protocol change.
// -----------------------------------------------------------------------------

describe('LOGIN-RECOVERY — the code surface is copy-only, the protocol is untouched', () => {
  it('still requests the code from the same endpoint, with the same body, and no role', () => {
    // Server-managed anti-enumeration means the client may not tell the server
    // (or reveal) which flow it is in: `role` must never enter this request.
    const REQUEST_CALL = sliceBetween(
      VIEW_TSX,
      "fetch('/api/auth/request-otp'",
      "fetch('/api/auth/verify-otp'",
    );
    expect(REQUEST_CALL).not.toBe('');
    expect(REQUEST_CALL).not.toContain('role');
    expect(count(VIEW, /fetch\('\/api\/auth\/request-otp'/g)).toBe(1);
    expect(count(VIEW, /fetch\('\/api\/auth\/verify-otp'/g)).toBe(1);
    // The registration arm may add the email; the plain sign-in arm may not.
    expect(VIEW).toContain(
      'body: JSON.stringify(isRegistering ? { phone, email: contactEmail.trim() } : { phone }),',
    );
  });
});

