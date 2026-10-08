import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  CLAIM_PAYMENT_WINDOW_MS,
  PAYMENT_SESSION_WINDOW_MS,
  CLAIM_PAYMENT_WINDOW_LABEL,
  PAYMENT_SESSION_WINDOW_LABEL,
  describePaymentWindow,
  claimPaymentDeadline,
  hasClaimPaymentWindowElapsed,
} from '../config/paymentWindows';

// =============================================================================
// 24-HOUR CLAIM PAYMENT WINDOW.
//
// Product requirement: once an Agent confirms a claimant, the claimant has AT
// LEAST 24 hours to pay. The previous implementation expired the CLAIM 15
// minutes after agent confirmation, and tied each STK session to that same
// 15-minute deadline — so a claimant who logged out, closed the browser, or
// simply took longer lost the claim, and a completed payment could not be
// recovered afterwards.
//
// These tests pin the corrected, server-authoritative policy and prove the two
// windows are genuinely distinct.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

const SERVER = read('src/server.ts');
const CLAIM_PAYMENTS = read('src/routes/claimPayments.ts');
const CUSTOMER_CLAIMS = read('src/routes/customerClaims.ts');
const ACTION = read('src/components/customer/ClaimPaymentAction.tsx');

describe('canonical payment windows', () => {
  it('the CLAIM window is 24 hours and the SESSION window is much shorter', () => {
    expect(CLAIM_PAYMENT_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(PAYMENT_SESSION_WINDOW_MS).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(PAYMENT_SESSION_WINDOW_MS).toBeLessThan(CLAIM_PAYMENT_WINDOW_MS);
  });

  it('claimPaymentDeadline is agent_confirmed_at + 24h (and null without a confirmation)', () => {
    const t = new Date('2026-01-01T00:00:00.000Z');
    expect(claimPaymentDeadline(t)!.getTime()).toBe(t.getTime() + CLAIM_PAYMENT_WINDOW_MS);
    expect(claimPaymentDeadline(null)).toBeNull();
    expect(claimPaymentDeadline(undefined)).toBeNull();
  });

  it('hasClaimPaymentWindowElapsed: still open at 23 hours, elapsed past 24 hours', () => {
    const now = Date.now();
    expect(hasClaimPaymentWindowElapsed(new Date(now - 23 * 60 * 60 * 1000), now)).toBe(false);
    expect(hasClaimPaymentWindowElapsed(new Date(now - 25 * 60 * 60 * 1000), now)).toBe(true);
    // No confirmation means no window is open, so it never counts as elapsed.
    expect(hasClaimPaymentWindowElapsed(null, now)).toBe(false);
  });
});

describe('the server enforces the 24-hour window, not the old 15 minutes', () => {
  it('checkClaimExpiry uses the canonical predicate and no inline 15-minute literal', () => {
    const i = SERVER.indexOf('async function checkClaimExpiry');
    expect(i).toBeGreaterThan(-1);
    const body = SERVER.slice(i, i + 900);
    expect(body).toContain('hasClaimPaymentWindowElapsed');
    expect(body).not.toContain('15 * 60 * 1000');
  });

  it('expireStaleClaims uses the canonical predicate and no inline 15-minute literal', () => {
    const i = SERVER.indexOf('async function expireStaleClaims');
    expect(i).toBeGreaterThan(-1);
    const body = SERVER.slice(i, i + 1500);
    expect(body).toContain('hasClaimPaymentWindowElapsed');
    expect(body).not.toContain('15 * 60 * 1000');
  });

  it('the customer claim display derives its deadline from the canonical window', () => {
    expect(CUSTOMER_CLAIMS).toContain('CLAIM_PAYMENT_WINDOW_MS');
    expect(CUSTOMER_CLAIMS).not.toMatch(/PAYMENT_WINDOW_MS = 15 \* 60 \* 1000/);
  });
});

describe('individual session expiry never expires the claim', () => {
  it('session creation uses the short session window, not agent_confirmed_at', () => {
    expect(CLAIM_PAYMENTS).toContain('new Date(nowMs + PAYMENT_SESSION_WINDOW_MS)');
    // The buggy tie to the claim's confirmation time must be gone.
    expect(CLAIM_PAYMENTS).not.toContain('baseMs + 15 * 60 * 1000');
  });

  it('a stale (expired) session is expired and never reused, so a fresh one can be created', () => {
    expect(CLAIM_PAYMENTS).toContain('db.expirePaymentSession(activeSession.id)');
    expect(CLAIM_PAYMENTS).toMatch(
      /activeSession && new Date\(activeSession\.expires_at\)\.getTime\(\) >= nowMs/
    );
  });

  it('the UI offers a retry when only the session expired, and closes only on claim-window expiry', () => {
    expect(ACTION).toContain("claimStatus === 'payment_window_expired'");
    expect(ACTION).toContain("sessionStatus === 'expired'");
    // The session-expiry branch must NOT tell the user to re-link the claim.
    const idx = ACTION.indexOf("sessionStatus === 'expired'");
    const branch = ACTION.slice(idx, idx + 320);
    expect(branch).not.toContain('Link the claim again');
  });
});


// =============================================================================
// E2-A — THE TWO WINDOWS AS THE CUSTOMER IS ACTUALLY TOLD ABOUT THEM.
//
// The policy above is only half the fix. The defect the audit found was that the
// CLAIM's deadline was described to the claimant as 15 minutes — the length of
// ONE M-Pesa prompt — in the Terms, in the owner journey, in the agent's own
// confirmation prompt and in the admin console, and the owner journey even ran
// its countdown off that same 15-minute number.
//
// These assertions pin the corrected copy: the claim window is named as the
// claim window, the 15-minute clock is named as the PROMPT's clock, and every
// duration is derived from the constants above instead of being re-typed.
// =============================================================================

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** The slice between two markers; fails loudly if either one is missing. */
function between(source: string, from: string, to: string): string {
  const i = source.indexOf(from);
  expect(i, `missing marker: ${from}`).toBeGreaterThan(-1);
  const j = source.indexOf(to, i);
  expect(j, `missing marker: ${to}`).toBeGreaterThan(i);
  return source.slice(i, j);
}

const TERMSVIEW = read('src/components/TermsView.tsx');
const OWNERVIEW = read('src/components/OwnerView.tsx');
const DASHBOARD_TSX = read('src/components/CustomerDashboard.tsx');
const ADMINVIEW = read('src/components/AdminView.tsx');
const AGENT_OPS = read('src/hooks/useAgentOperations.ts');
const TYPES = read('src/types.ts');

/** The Terms section that carries the payment-window promise. */
const TERMS_PAYMENT_SECTION = between(
  TERMSVIEW,
  '13.</span> Physical Verification',
  '</section>',
);

/** The customer-facing payment dictionary in types.ts (the owner pay step). */
const TYPES_PAYMENT_COPY = between(TYPES, 'verifySubmit:', 'collectionCode:');

/**
 * Every duration a CLAIMANT can read. Comments are stripped because the code
 * itself legitimately names the internal `escrow_held` STATUS token.
 */
const USER_FACING_PAYMENT_COPY: Array<[string, string]> = [
  ['ClaimPaymentAction', stripComments(ACTION)],
  ['CustomerDashboard', stripComments(DASHBOARD_TSX)],
  ['OwnerView', stripComments(OWNERVIEW)],
  ['TermsView §13', stripComments(TERMS_PAYMENT_SECTION)],
  ['AdminView strikes tab', stripComments(ADMINVIEW)],
  ['the agent confirmation prompt', stripComments(AGENT_OPS)],
  ['the owner payment dictionary', stripComments(TYPES_PAYMENT_COPY)],
];

/** The miswordings this batch retires, with the clock each one confused. */
const RETIRED_CLAIM_WINDOW_MISWORDINGS = [
  '15-Minute Payment Lockout',
  'within the 15-minute window',
  'within 15 minutes of in-person verification',
  'Your 15-minute payment window has expired',
  'the 15-minute viewing verification window',
  'This will trigger the 15-minute payment window',
  'opens a short payment window',
  'Proceed to Escrow Payment',
  'Payment Held in Escrow',
  'held securely as escrow',
];

describe('E2-A — the two windows are named separately, and by their real numbers', () => {
  it('derives both displayed durations from the constants that govern them', () => {
    // The copy is not allowed to invent a duration: these ARE the labels the
    // surfaces interpolate.
    expect(CLAIM_PAYMENT_WINDOW_LABEL).toBe('24 hours');
    expect(PAYMENT_SESSION_WINDOW_LABEL).toBe('15 minutes');
    expect(describePaymentWindow(CLAIM_PAYMENT_WINDOW_MS)).toBe(CLAIM_PAYMENT_WINDOW_LABEL);
    expect(describePaymentWindow(PAYMENT_SESSION_WINDOW_MS)).toBe(PAYMENT_SESSION_WINDOW_LABEL);
  });

  it('no longer tells the claimant their CLAIM expires with the M-Pesa prompt', () => {
    for (const [surface, source] of USER_FACING_PAYMENT_COPY) {
      for (const wording of RETIRED_CLAIM_WINDOW_MISWORDINGS) {
        expect(source, `${surface} still says: ${wording}`).not.toContain(wording);
      }
    }
  });

  it('names the 24-hour deadline as the CLAIM window everywhere it is decided', () => {
    expect(TERMSVIEW).toContain('Physical Verification & 24-Hour Payment Window');
    expect(TERMSVIEW).toContain('24-Hour Claim Window, 15-Minute M-Pesa Prompt');
    expect(TERMSVIEW).toContain('within the 24-hour claim window');

    expect(OWNERVIEW).toContain('${CLAIM_PAYMENT_WINDOW_LABEL} payment window has expired');
    expect(OWNERVIEW).toContain('within ${CLAIM_PAYMENT_WINDOW_LABEL} of in-person verification');

    expect(ADMINVIEW).toContain('within the 24-hour claim payment window');
    expect(AGENT_OPS).toContain("claim's 24-hour payment window");

    // The claimant's card says which window the deadline belongs to.
    expect(DASHBOARD_TSX).toContain("'Claim payment window closes'");
    expect(DASHBOARD_TSX).toContain("'Claim payment window deadline'");
    expect(DASHBOARD_TSX).not.toContain("'Pay before'");
  });

  it('names the 15-minute clock as the payment-session / M-Pesa PROMPT window', () => {
    // The payment component explains the two clocks and says what an expired
    // prompt does NOT do (end the claim).
    expect(ACTION).toContain('PAYMENT_SESSION_WINDOW_LABEL');
    expect(ACTION).toContain('CLAIM_PAYMENT_WINDOW_LABEL');
    expect(ACTION).toContain('A single M-Pesa prompt only stays valid for');
    expect(ACTION).toContain('your claim is still open and you can ask for a new prompt');

    // The owner journey countdown names both clocks too.
    expect(OWNERVIEW).toContain('PAYMENT_SESSION_WINDOW_LABEL');
    expect(OWNERVIEW).toContain('Any single M-Pesa prompt only stays valid for');
  });

  it('the countdown the claimant watches is the window the SERVER enforces', () => {
    // This was `confirmedTime + 15 * 60 * 1000`: the browser expired the claim
    // on the PROMPT's clock, so a claimant was told to stop paying inside a
    // window the server still accepted payment in.
    expect(OWNERVIEW).toContain('const diff = confirmedTime + CLAIM_PAYMENT_WINDOW_MS - Date.now();');
    expect(OWNERVIEW).not.toContain('confirmedTime + 15 * 60 * 1000');
    expect(OWNERVIEW).toMatch(/import \{\r?\n\s+CLAIM_PAYMENT_WINDOW_MS,/);
  });

  it('a 15-minute number is only ever attached to the M-Pesa prompt', () => {
    for (const [surface, source] of USER_FACING_PAYMENT_COPY) {
      for (const match of source.matchAll(/.{0,60}15[- ]minute.{0,60}/gi)) {
        expect(
          match[0].toLowerCase(),
          `${surface}: "${match[0].replace(/\s+/g, ' ').trim()}" must name the PROMPT`,
        ).toMatch(/prompt/);
      }
    }
  });

  it('never shows the claimant the internal word "escrow"', () => {
    // `escrow_held` is an internal STATUS token and `triggerEscrowPayment` is a
    // handler name — neither of them is copy. Everything else is, and must be
    // plain language about money held until the item is collected.
    const copyOnly = (source: string) =>
      source.replace(/escrow_held|triggerEscrowPayment/g, 'INTERNAL-TOKEN');
    const STRICT_SURFACES = [
      'ClaimPaymentAction',
      'CustomerDashboard',
      'OwnerView',
      'TermsView §13',
      'the owner payment dictionary',
    ];
    for (const [surface, source] of USER_FACING_PAYMENT_COPY) {
      if (!STRICT_SURFACES.includes(surface)) continue;
      expect(copyOnly(source).toLowerCase(), `${surface} shows "escrow"`).not.toContain('escrow');
    }
    // The plain-language replacement states what actually happens to the money.
    expect(ACTION).toContain(
      'Your payment is held securely by our payment provider until you collect the item.',
    );
    expect(TYPES).toContain(
      'held securely by our payment provider and only released to the agent or finder once you physically collect your item.',
    );
  });
});

