import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Regression test for the payment-authorization hardening: POST
// /api/claims/:id/pay must no longer accept a bare claim ID (optionally
// with an unverified phone) as sufficient to trigger a real M-Pesa STK
// push. It must now require BOTH a matching phone number AND a valid,
// unexpired paymentAuthToken minted by POST /api/claims/:id/payment-auth
// (which itself requires the same phone match before issuing one).
//
// Static source-audit test (same pattern as adminRouteAudit.test.ts and
// claimGuessRateLimit.test.ts) since server.ts doesn't export its Express
// app separately from startServer()'s bootstrap.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

function routeBody(method: 'get' | 'post', route: string): string {
  const marker = `app.${method}('${route}'`;
  const start = serverTs.indexOf(marker);
  expect(start, `route ${method.toUpperCase()} ${route} not found in server.ts`).toBeGreaterThan(-1);
  // Grab a generous slice — enough to cover the whole handler body without
  // needing to balance braces.
  return serverTs.slice(start, start + 4000);
}

describe('claim payment authorization gates POST /api/claims/:id/pay', () => {
  it('payment-auth route exists and is rate-limited', () => {
    expect(serverTs).toMatch(/app\.post\('\/api\/claims\/:id\/payment-auth',\s*claimGuessLimiter,/);
  });

  it('payment-auth route requires a phone number in the body', () => {
    const body = routeBody('post', '/api/claims/:id/payment-auth');
    expect(body).toMatch(/const \{ phone \} = req\.body;/);
    expect(body).toMatch(/if \(!phone\)/);
  });

  it('payment-auth route checks the phone matches claim.owner_phone before issuing a token', () => {
    const body = routeBody('post', '/api/claims/:id/payment-auth');
    expect(body).toMatch(/normalizedInput !== normalizedOwner/);
    expect(body).toMatch(/setClaimPaymentAuthToken/);
  });

  it('/pay requires phone (no longer optional)', () => {
    const body = routeBody('post', '/api/claims/:id/pay');
    expect(body).toMatch(/if \(!phone\)/);
  });

  it('/pay requires a paymentAuthToken and validates it against the stored hash', () => {
    const body = routeBody('post', '/api/claims/:id/pay');
    expect(body).toMatch(/paymentAuthToken/);
    expect(body).toMatch(/getClaimPaymentAuthToken/);
    expect(body).toMatch(/timingSafeEqualHex/);
    expect(body).toMatch(/authRecord\.expires_at\.getTime\(\) < Date\.now\(\)/);
  });
});
