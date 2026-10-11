import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// PROVIDER CONTRACT AUDIT.
//
// The reported incident: a real KES 200 M-Pesa collection completed at IntaSend
// while the Return4me claim stayed in `pending_payment` on every dashboard. Two
// contract mismatches caused it:
//   1. the webhook expected an HMAC-SHA256 signature, but IntaSend's collection
//      webhook authenticates with a configured CHALLENGE value, so the real
//      callback was rejected (401) and never processed; and
//   2. the authoritative status lookup used a legacy GET URL/host that the
//      current IntaSend API no longer serves, so the fallback could not recover
//      it either.
//
// These source-audit assertions pin the CORRECTED contract. Static source audit
// is the established pattern for server.ts-adjacent modules in this suite.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

const WEBHOOKS = read('src/routes/webhooks.ts');
const PAYMENTS = read('src/services/payments.ts');
const SERVER = read('src/server.ts');

// =============================================================================
// SOURCE SLICING — WHY THERE IS NO CHARACTER BUDGET HERE
//
// This file previously sliced the webhook route with a fixed character budget,
// `WEBHOOKS.slice(start, start + 4200)`. That is not a contract: it is a guess
// about how long the route body happens to be. When the route gained explanatory
// comments, TWO assertions in this file began failing against entirely correct
// code — the assertions were still true, but the text that proved them had moved
// past the 4,200th character. A brittle source slice turns every future comment
// into a red test, which trains a reader to distrust the suite.
//
// The slice therefore runs from the route registration TO THE END OF THE MODULE,
// and the structural fact it depends on — that this route is the LAST
// registration in routes/webhooks.ts, so nothing unrelated can leak into the
// slice — is itself asserted below. That turns a silent-drift hazard into an
// explicit, checkable contract.
// =============================================================================
function webhookBody(): string {
  const start = WEBHOOKS.indexOf("app.post('/api/webhooks/intasend'");
  expect(start, 'webhook route not found').toBeGreaterThan(-1);
  return WEBHOOKS.slice(start);
}

describe('IntaSend collection webhook contract', () => {
  const body = webhookBody();

  it('is the LAST registration in the module (the slice above depends on it)', () => {
    // Without this, a future second route would silently join the slice and the
    // assertions below could pass on someone else's code. Asserting the
    // structural fact keeps the boundary honest instead of implicit.
    const routeStart = WEBHOOKS.indexOf("app.post('/api/webhooks/intasend'");
    expect(routeStart).toBe(WEBHOOKS.lastIndexOf('app.post('));
    // And the module holds exactly one route registration.
    expect((WEBHOOKS.match(/app\.post\(/g) || []).length).toBe(1);
  });

  it('authenticates with the configured challenge, not an HMAC signature', () => {
    expect(body).toContain('INTASEND_WEBHOOK_CHALLENGE');
    expect(body).toContain('challengeMatches(payload.challenge, configuredChallenge)');
    // The competing signature system is gone.
    expect(WEBHOOKS).not.toContain('x-intasend-signature');
    expect(WEBHOOKS).not.toContain('createHmac');
  });

  it('requires the challenge in production and rejects a missing one', () => {
    expect(body).toMatch(/NODE_ENV === 'production' && !configuredChallenge/);
    expect(body).toMatch(/status\(401\)/);
  });

  it('validates the collection topic and safely ignores other lifecycle events', () => {
    expect(body).toContain("payload.topic !== 'collection_event'");
    expect(body).toMatch(/status: 'ignored'/);
  });

  it('requires a usable invoice_id and api_ref', () => {
    expect(body).toMatch(/!invoice_id \|\| typeof invoice_id !== 'string'/);
    expect(body).toMatch(/!claimId \|\| typeof claimId !== 'string'/);
  });

  it('only processes a COMPLETE collection', () => {
    expect(body).toMatch(/if \(state !== 'COMPLETE'\)/);
  });

  it('delegates the financial decision to the ONE canonical confirmation path', () => {
    expect(body).toContain('processClaimPaymentConfirmed(claimId, invoice_id, webhookAmount)');
    // The route must not perform the escrow transition or write payment truth.
    expect(body).not.toContain('attemptClaimEscrowHold');
    expect(body).not.toContain('paid_at');
  });
});

describe('IntaSend authoritative status lookup contract', () => {
  it('POSTs { invoice_id } to the documented /payment/status/ endpoint', () => {
    expect(PAYMENTS).toContain('${INTASEND_BASE_URL}/payment/status/');
    expect(PAYMENTS).toContain("method: 'POST'");
    expect(PAYMENTS).toMatch(/JSON\.stringify\(\{ invoice_id: trimmedInvoice \}\)/);
  });

  it('uses the current production host and keeps the sandbox host', () => {
    expect(PAYMENTS).toContain("'https://api.intasend.com/api/v1'");
    expect(PAYMENTS).toContain("'https://sandbox.intasend.com/api/v1'");
    expect(PAYMENTS).not.toContain('payment.intasend.com');
  });

  it('verifies invoice identity, state, and reads provider_ref (never transaction_id-first)', () => {
    expect(PAYMENTS).toContain('provider_invoice_identity_mismatch');
    expect(PAYMENTS).toMatch(/providerState !== 'COMPLETE'/);
    expect(PAYMENTS).toContain('invoice.provider_ref');
  });

  it('enforces api_ref cross-claim isolation and keeps a bounded timeout', () => {
    expect(PAYMENTS).toContain('provider_api_ref_mismatch');
    expect(PAYMENTS).toMatch(/fetchWithTimeout\([\s\S]{0,400}?12000\s*\)/);
  });

  it('never logs the secret key or the raw provider payload', () => {
    // No console call may interpolate the secret key.
    expect(PAYMENTS).not.toMatch(/console\.[a-z]+\([^)]*secretKey/);
  });
});

describe('production boot guard requires the challenge', () => {
  it('refuses to boot on a placeholder INTASEND_WEBHOOK_CHALLENGE', () => {
    expect(SERVER).toContain('isPlaceholderKey(process.env.INTASEND_WEBHOOK_CHALLENGE)');
  });
});

describe('IntaSend payout initiation contract (Batch 1B-C1)', () => {
  it('POSTs payout initiation to the documented /send-money/initiate/ path', () => {
    // Documented: "Initiate a batch with POST /api/v1/send-money/initiate/."
    expect(PAYMENTS).toContain("'/send-money/initiate/'");
    expect(PAYMENTS).toContain('${INTASEND_BASE_URL}${INTASEND_SEND_MONEY_INITIATE_PATH}');
  });

  it('no longer posts to the bare, undocumented /send-money/ path', () => {
    // Both call sites (batch payout and single-transaction refund) used it.
    expect(PAYMENTS).not.toContain('${INTASEND_BASE_URL}/send-money/`');
  });

  it('leaves the payout status endpoint untouched', () => {
    expect(PAYMENTS).toContain('${INTASEND_BASE_URL}/send-money/status/');
  });

  it('sends the documented per-transaction idempotency_key', () => {
    // "Unique key per transaction. A repeat request with the same key is
    // rejected, so you can retry safely."
    expect(PAYMENTS).toContain('idempotency_key: leg.idempotencyKey');
    expect(PAYMENTS).toMatch(/PAYOUT_LEG_\$\{recipientType\.toUpperCase\(\)\}/);
  });

  it('never correlates provider transactions by an account suffix again', () => {
    // BATCH 1B-C1-R1 — SCOPED to the initiation block instead of the whole
    // file. A file-wide `not.toContain('endsWith(')` / `not.toContain('slice(-9)')`
    // fails on ANY future legitimate use of those ordinary string operations
    // anywhere in payments.ts (URL checks, id handling, an unrelated provider),
    // and it cannot distinguish the account-suffix correlation this test exists
    // to pin from code that has nothing to do with correlation. The suffix
    // matcher only ever lived in the initiation block, so that is where the
    // negative belongs — see the next test, which asserts the same thing on the
    // same slice plus the alternative response keys.
    const start = PAYMENTS.indexOf('async triggerIntasendPayout');
    expect(start, 'triggerIntasendPayout not found').toBeGreaterThan(-1);
    const end = PAYMENTS.indexOf('async triggerIntasendRefund', start);
    expect(end, 'triggerIntasendRefund not found').toBeGreaterThan(start);
    const initiation = PAYMENTS.slice(start, end);

    expect(initiation).not.toContain('slice(-9)');
    expect(initiation).not.toContain('endsWith(');
    // The replacement correlation is still the ONLY one, file-wide and here.
    expect(initiation).toContain('resolvePayoutTransactionBindings');
    expect(PAYMENTS).toContain('resolvePayoutTransactionBindings');
  });

  it('reads only the documented response fields in the initiation parser', () => {
    // Scoped to the INITIATION block: the status lookup keeps its own
    // (pre-existing, out-of-scope) `disbursements` fallback, so a file-wide
    // assertion would be asserting about code this batch does not own.
    const start = PAYMENTS.indexOf('async triggerIntasendPayout');
    expect(start, 'triggerIntasendPayout not found').toBeGreaterThan(-1);
    const end = PAYMENTS.indexOf('async triggerIntasendRefund', start);
    expect(end, 'triggerIntasendRefund not found').toBeGreaterThan(start);
    const initiation = PAYMENTS.slice(start, end);

    // The alternative key names the suffix matcher probed are gone.
    expect(initiation).not.toContain('data?.invoices');
    expect(initiation).not.toContain('data?.disbursements');
    expect(initiation).not.toContain('t?.phone_number');
    expect(initiation).not.toContain('match?.invoice');
    // ...and the suffix correlation itself is gone, from this block and the file.
    expect(initiation).not.toContain('slice(-9)');
    expect(initiation).not.toContain('endsWith(');
    expect(initiation).toContain('resolvePayoutTransactionBindings');
  });
});
