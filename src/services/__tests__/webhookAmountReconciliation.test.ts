import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { reconcileWebhookAmount } from '../payments';


// P1 REGRESSION TEST — webhook amount reconciliation. The IntaSend
// webhook handler used to confirm a claim's payment based solely on
// invoice_id, state, and api_ref — never looking at the paid amount at
// all. Signature verification means an attacker can't forge/alter a
// payload without the shared secret, but that's a different guarantee:
// a legitimately-signed webhook could still report a different amount
// than what the claim actually owes (a fee-calculation bug, a race
// between STK-push initiation and confirmation, a provider-side anomaly)
// and nothing would have caught it. reconcileWebhookAmount is the pure
// decision logic behind processClaimPaymentConfirmed's new check,
// extracted to services/payments.ts so it's directly testable — same
// reasoning as isAgentActionable/isAdminSessionCurrent: server.ts has no
// exports and unsafe top-level side effects to import in a test file.

describe('reconcileWebhookAmount', () => {
  it('an exact match reconciles', () => {
    expect(reconcileWebhookAmount(500, 500)).toBe('match');
    expect(reconcileWebhookAmount('500', '500')).toBe('match');
  });

  it('formatting differences within epsilon still reconcile ("500" vs "500.00")', () => {
    expect(reconcileWebhookAmount('500.00', 500)).toBe('match');
    expect(reconcileWebhookAmount(500.3, 500)).toBe('match'); // within 0.5 tolerance
  });

  it('a genuine mismatch is flagged, not silently accepted', () => {
    expect(reconcileWebhookAmount(300, 500)).toBe('mismatch');
    expect(reconcileWebhookAmount(500, 300)).toBe('mismatch');
  });

  it('a mismatch just outside the epsilon tolerance is still flagged', () => {
    expect(reconcileWebhookAmount(500.51, 500)).toBe('mismatch');
  });

  it('a missing/absent amount is "unknown", not silently treated as a match', () => {
    expect(reconcileWebhookAmount(undefined, 500)).toBe('unknown');
    expect(reconcileWebhookAmount(null, 500)).toBe('unknown');
    expect(reconcileWebhookAmount('', 500)).toBe('unknown');
  });

  it('a non-numeric amount is "unknown", not silently treated as a match', () => {
    expect(reconcileWebhookAmount('not-a-number', 500)).toBe('unknown');
  });

  // ---------------------------------------------------------------------------
  // P1 HARDENING (B-1) — EXECUTED coverage for the classes of malformed payload
  // that previously returned 'unknown' and were then treated by the caller as
  // "fine, proceed to escrow".
  //
  // The old predicate used parseFloat(String(x)). That produced NaN for
  // booleans/objects/arrays, and the caller's guard was only
  // `!== undefined && !== null && !== ''`, so EVERY one of these reached
  // escrow_held with no reconciliation at all. Each case below is now asserted
  // directly against the real function, not by reading server.ts source.
  // ---------------------------------------------------------------------------
  it('P1: a numeric-PREFIX string is NOT accepted as the number it starts with', () => {
    // parseFloat('500abc') === 500, which the old predicate scored as a MATCH.
    expect(reconcileWebhookAmount('500abc', 500)).toBe('unknown');
    expect(reconcileWebhookAmount('1,000', 500)).toBe('unknown');
    expect(reconcileWebhookAmount('500KES', 500)).toBe('unknown');
    expect(reconcileWebhookAmount('1e', 500)).toBe('unknown');
  });

  it('P1: objects, arrays and booleans are malformed, not absent, and never reconcile', () => {
    // parseFloat({})/parseFloat(true) are NaN -> 'unknown' -> previously
    // proceeded straight to escrow. The result is the same string, but the
    // CALLER now treats 'unknown' as "verify with the provider, else withhold
    // escrow" instead of "carry on".
    expect(reconcileWebhookAmount({}, 500)).toBe('unknown');
    expect(reconcileWebhookAmount([], 500)).toBe('unknown');
    expect(reconcileWebhookAmount(true, 500)).toBe('unknown');
    expect(reconcileWebhookAmount(false, 500)).toBe('unknown');
    expect(reconcileWebhookAmount([500], 500)).toBe('unknown');
  });

  it('P1: non-finite numbers are rejected before any comparison', () => {
    expect(reconcileWebhookAmount(Infinity, 500)).toBe('unknown');
    expect(reconcileWebhookAmount(-Infinity, 500)).toBe('unknown');
    expect(reconcileWebhookAmount(NaN, 500)).toBe('unknown');
    expect(reconcileWebhookAmount('Infinity', 500)).toBe('unknown');
  });

  it('P1: zero and negative amounts can never settle a positive fee', () => {
    // A real collection is strictly positive. Zero/negative is a provider or
    // data fault: reported as 'unknown' so the provider is consulted, rather
    // than as 'mismatch' (which would wrongly imply a deliberate short-pay).
    expect(reconcileWebhookAmount(0, 500)).toBe('unknown');
    expect(reconcileWebhookAmount('0', 500)).toBe('unknown');
    expect(reconcileWebhookAmount('0.00', 500)).toBe('unknown');
    expect(reconcileWebhookAmount(-500, 500)).toBe('unknown');
    expect(reconcileWebhookAmount('-0.01', 500)).toBe('unknown');
  });

  it('P1: valid numeric forms still reconcile after strict validation', () => {
    expect(reconcileWebhookAmount('500', 500)).toBe('match');
    expect(reconcileWebhookAmount(500, 500)).toBe('match');
    expect(reconcileWebhookAmount('500.00', 500)).toBe('match');
    expect(reconcileWebhookAmount(' 500.00 ', 500)).toBe('match');
    expect(reconcileWebhookAmount(500.5, 500)).toBe('match');   // exactly epsilon
    expect(reconcileWebhookAmount(499.5, 500)).toBe('match');   // exactly epsilon
    expect(reconcileWebhookAmount('5e2', 500)).toBe('match');   // exponent form
  });

  it('P1: a genuinely short payment is still a mismatch, not excused as unknown', () => {
    expect(reconcileWebhookAmount(300, 500)).toBe('mismatch');
    expect(reconcileWebhookAmount(499.4, 500)).toBe('mismatch');
    expect(reconcileWebhookAmount(500.51, 500)).toBe('mismatch');
  });

  it('P1: an unusable EXPECTED fee also yields unknown (server can never fabricate)', () => {
    expect(reconcileWebhookAmount(500, undefined)).toBe('unknown');
    expect(reconcileWebhookAmount(500, null)).toBe('unknown');
    expect(reconcileWebhookAmount(500, '')).toBe('unknown');
    expect(reconcileWebhookAmount(500, 'abc')).toBe('unknown');
  });
});

const serverTs = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');
// P2-A3.3: the IntaSend webhook ROUTE moved verbatim to src/routes/webhooks.ts.
// serverTs still owns processClaimPaymentConfirmed (shared with the dev
// simulator, and injected into the route), so BOTH files are read here.
const webhooksTs = fs.readFileSync(path.resolve(__dirname, '../../routes/webhooks.ts'), 'utf8');

describe('processClaimPaymentConfirmed is wired to actually enforce the reconciliation result', () => {
  it('a mismatch refuses BEFORE the atomic escrow-hold transition (never holds escrow with a wrong amount)', () => {
    const fnStart = serverTs.indexOf('async function processClaimPaymentConfirmed');
    expect(fnStart).toBeGreaterThan(-1);
    const body = serverTs.slice(fnStart, fnStart + 20000);
    // P1 (B-1): this local was renamed from `reconciliation` to `claimRecon`
    // when the 'unknown' branch was given its own provider-verification path,
    // so both reconciliation decisions (mismatch AND unverifiable) could be
    // distinguished. The contract this test protects is unchanged: a refusal
    // must still precede the escrow-hold CAS.
    const mismatchIdx = body.indexOf("claimRecon === 'mismatch'");
    const escrowHoldIdx = body.indexOf('attemptClaimEscrowHold(claimId, invoiceId)');
    expect(mismatchIdx, 'mismatch check not found').toBeGreaterThan(-1);
    expect(escrowHoldIdx, 'attemptClaimEscrowHold call not found').toBeGreaterThan(-1);
    expect(mismatchIdx).toBeLessThan(escrowHoldIdx);
  });

  it('P1: an UNVERIFIABLE amount also refuses before escrow, and is never treated as success', () => {
    // The defect this batch fixes: 'unknown' (absent OR malformed amount) used
    // to fall through to the escrow CAS. It must now either be settled by an
    // authoritative provider lookup or return before the CAS.
    const fnStart = serverTs.indexOf('async function processClaimPaymentConfirmed');
    const body = serverTs.slice(fnStart, fnStart + 20000);
    const unknownIdx = body.indexOf("claimRecon === 'unknown'");
    const verifyIdx = body.indexOf('fetchAuthoritativeCollectionStatus');
    const escrowHoldIdx = body.indexOf('attemptClaimEscrowHold(claimId, invoiceId)');
    expect(unknownIdx, 'unknown-branch check not found').toBeGreaterThan(-1);
    expect(verifyIdx, 'authoritative provider verification not called').toBeGreaterThan(-1);
    expect(unknownIdx).toBeLessThan(escrowHoldIdx);
    expect(verifyIdx).toBeLessThan(escrowHoldIdx);
    // The provider call is bounded, so a webhook can never hang on it.
    const svc = fs.readFileSync(path.resolve(__dirname, '../payments.ts'), 'utf8');
    expect(svc).toMatch(/fetchWithTimeout\([\s\S]{0,400}?12000\s*\)/);
  });

  it('P1: a failed provider verification is audited and returns without holding escrow', () => {
    const fnStart = serverTs.indexOf('async function processClaimPaymentConfirmed');
    const body = serverTs.slice(fnStart, fnStart + 20000);
    expect(body).toMatch(/WEBHOOK_AMOUNT_UNVERIFIED/);
    // "not confirmed and no escrow" is expressed by returning null, which the
    // caller treats as a non-confirmation. The escrow CAS must not run first.
    const unverifiedIdx = body.indexOf('WEBHOOK_AMOUNT_UNVERIFIED');
    const escrowHoldIdx = body.indexOf('attemptClaimEscrowHold(claimId, invoiceId)');
    expect(unverifiedIdx).toBeLessThan(escrowHoldIdx);
  });

  it('the webhook route extracts and passes the amount field into processClaimPaymentConfirmed', () => {
    // P2-A3.3: the route body moved verbatim to src/routes/webhooks.ts, so
    // the resolver reads from whichever file owns it. Both assertions below
    // are unchanged - the amount is still read the same way and still handed
    // to the same injected confirmation helper.
    const start = webhooksTs.indexOf("app.post('/api/webhooks/intasend'");
    expect(start, 'webhook route not found in routes/webhooks.ts').toBeGreaterThan(-1);
    const body = webhooksTs.slice(start, start + 6000);
    expect(body).toMatch(/const webhookAmount = value \?\? amount;/);
    expect(body).toMatch(/processClaimPaymentConfirmed\(claimId, invoice_id, webhookAmount\)/);
  });

  it('a mismatch is audit-logged for manual review, not just console-logged and silently dropped', () => {
    const fnStart = serverTs.indexOf('async function processClaimPaymentConfirmed');
    const body = serverTs.slice(fnStart, fnStart + 14000);
    expect(body).toMatch(/WEBHOOK_AMOUNT_MISMATCH_REFUSED/);
  });
});
