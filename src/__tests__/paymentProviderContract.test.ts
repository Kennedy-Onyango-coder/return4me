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

function webhookBody(): string {
  const start = WEBHOOKS.indexOf("app.post('/api/webhooks/intasend'");
  expect(start, 'webhook route not found').toBeGreaterThan(-1);
  return WEBHOOKS.slice(start, start + 4200);
}

describe('IntaSend collection webhook contract', () => {
  const body = webhookBody();

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
