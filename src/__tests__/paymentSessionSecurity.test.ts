import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Security tests for the server-controlled payment session (eCitizen-style
// flow). Static source-audit tests (pattern of paymentAuthGate.test.ts).
const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

function routeBody(marker: string): string {
  const idx = serverTs.indexOf(marker);
  expect(idx, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const after = serverTs.slice(idx);
  const nextRoute = after.indexOf("\n  app.", 10);
  const end = nextRoute > -1 ? idx + nextRoute : idx + 12000;
  return serverTs.slice(idx, end);
}

describe('payment session: creation endpoint', () => {
  it('is rate-limited alongside other claim-ID-guessable routes', () => {
    expect(serverTs).toMatch(/app\.post\('\/api\/claims\/:id\/payment-session',\s*claimGuessLimiter,/);
  });

  it('still requires ownership proof: the claim owner phone must match', () => {
    const b = routeBody("app.post('/api/claims/:id/payment-session', claimGuessLimiter");
    expect(b).toMatch(/toE164Kenyan\(String\(phone\)\.replace/);
    expect(b).toMatch(/normalizedInput !== normalizedOwner/);
    expect(b).toMatch(/normalizedOwner = toE164Kenyan\(String\(claim\.owner_phone/);
  });

  it('accepts a payer M-Pesa number different from owner_phone and validates it', () => {
    const b = routeBody("app.post('/api/claims/:id/payment-session', claimGuessLimiter");
    expect(b).toMatch(/payerPhone/);
    expect(b).toMatch(/candidate = toE164Kenyan\(String\(payerPhone\)/);
    expect(b).toMatch(/\/\^\\\+254\\d\{9\}\$\/\.test\(candidate\)/);
    expect(b).toMatch(/let normalizedPayer = normalizedOwner/);
  });

  it('computes the authoritative amount server-side, never from the client body', () => {
    const b = routeBody("app.post('/api/claims/:id/payment-session', claimGuessLimiter");
    expect(b).toMatch(/resolveAuthoritativePaymentFee\(item, category\)/);
    expect(b).not.toMatch(/req\.body\.amount/);
    expect(b).toMatch(/const \{ phone, payerPhone \} = req\.body;/);
  });
});

describe('payment session: initiation endpoint', () => {
  it('requires the ownership token, so an unauthorized caller cannot push a real STK', () => {
    const b = routeBody("app.post('/api/claims/:id/payment-session/:sessionId/initiate'");
    expect(b).toMatch(/paymentAuthToken/);
    expect(b).toMatch(/getClaimPaymentAuthToken/);
    expect(b).toMatch(/timingSafeEqualHex/);
  });

  it('enforces claim isolation: a session opened for another claim cannot be used', () => {
    const b = routeBody("app.post('/api/claims/:id/payment-session/:sessionId/initiate'");
    expect(b).toMatch(/session\.claim_id !== claimId/);
    expect(b).toMatch(/403/);
  });

  it('rejects an expired session server-side', () => {
    const b = routeBody("app.post('/api/claims/:id/payment-session/:sessionId/initiate'");
    expect(b).toMatch(/session\.expires_at/);
    expect(b).toMatch(/410/);
  });

  it('is idempotent via a CAS reservation: a lost race must not push a second STK', () => {
    const b = routeBody("app.post('/api/claims/:id/payment-session/:sessionId/initiate'");
    expect(b).toMatch(/reservePaymentSession\(sessionId\)/);
    expect(b).toMatch(/alreadyInitiated: true/);
  });

  it('does NOT confirm the payment during initiation', () => {
    const b = routeBody("app.post('/api/claims/:id/payment-session/:sessionId/initiate'");
    expect(b).not.toMatch(/escrow_held/);
    expect(b).toMatch(/finalizePaymentSessionInitiated/);
    expect(b).toMatch(/triggerMpesaStkPush/);
  });
});

describe('payment session: webhook confirmation', () => {
  const fnStart = serverTs.indexOf('const session = await db.getPaymentSessionByProviderInvoice(invoiceId);');
  const body = fnStart > -1 ? serverTs.slice(fnStart, fnStart + 9000) : '';

  it('resolves the provider invoice to its payment session', () => {
    expect(fnStart).toBeGreaterThan(-1);
  });

  it('refuses a cross-claim confirmation (invoice bound to another claim)', () => {
    expect(body).toMatch(/session\.claim_id !== claimId/);
    expect(body).toMatch(/WEBHOOK_CROSS_CLAIM_REFUSED/);
  });

  it('reconciles the confirmed amount against the session, not the client', () => {
    expect(body).toMatch(/reconcileWebhookAmount\(confirmedAmount, session\.amount\)/);
    expect(body).toMatch(/sessionAmountRecon === 'mismatch'/);
  });

  it('is idempotent: session CAS plus the claim-level escrow CAS', () => {
    expect(body).toMatch(/attemptPaymentSessionConfirm\(session\.id\)/);
    expect(body).toMatch(/attemptClaimEscrowHold\(claimId, invoiceId\)/);
  });
});

describe('payment session: DB primitives are CAS-guarded', () => {
  const dbTs = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');

  it('reservePaymentSession only transitions from created (one winner)', () => {
    expect(dbTs).toMatch(/status: 'payment_initiated'/);
    expect(dbTs).toMatch(/eq\(paymentSessionsTable\.status, 'created'\)/);
  });

  it('attemptPaymentSessionConfirm only transitions from pending (idempotent)', () => {
    expect(dbTs).toMatch(/status: 'confirmed'/);
    expect(dbTs).toMatch(/eq\(paymentSessionsTable\.status, 'pending'\)/);
  });

  it('finalizePaymentSessionInitiated records the provider invoice on the reserved state', () => {
    expect(dbTs).toMatch(/provider_invoice_id: providerInvoiceId/);
    expect(dbTs).toMatch(/status: 'pending'/);
  });
});