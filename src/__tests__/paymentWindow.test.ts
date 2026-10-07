import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  CLAIM_PAYMENT_WINDOW_MS,
  PAYMENT_SESSION_WINDOW_MS,
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
