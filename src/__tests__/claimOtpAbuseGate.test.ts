import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P0 fix: POST /api/claims/:id/request-otp used to require only a claim
// ID — no phone parameter at all — and was gated solely by IP-based
// limiters (otpIpLimiter: 5/5min per IP; otpGlobalLimiter: a system-wide
// bucket), neither of which is keyed to the specific claim being
// targeted. An attacker who found or guessed a claim ID (the same
// ~900,000-combination numeric space documented elsewhere in this file)
// could repeatedly trigger real OTP SMS messages to that claim's real
// registered owner_phone — a harassment/cost-abuse vector against a third
// party who never initiated anything. Fixed with two independent layers:
// a claim-ID-keyed rate limiter (follows the target regardless of how
// many IPs an attacker rotates through) and a mandatory phone-match check
// (the same standard already used by /lookup, /pay, and /payment-auth)
// before any SMS is sent.
//
// Static source-audit test (same pattern used throughout this suite)
// since server.ts doesn't export its Express app separately from
// startServer()'s bootstrap.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

function routeBody(method: 'get' | 'post', route: string): string {
  const marker = `app.${method}('${route}'`;
  const start = serverTs.indexOf(marker);
  expect(start, `route ${method.toUpperCase()} ${route} not found in server.ts`).toBeGreaterThan(-1);
  return serverTs.slice(start, start + 2200);
}

describe('claim OTP request route is rate-limited per claim ID, not just per IP', () => {
  it('defines a claim-ID-keyed OTP limiter, separate from the IP-based ones', () => {
    expect(serverTs).toMatch(/const otpClaimLimiter = rateLimit\(/);
  });

  it('the claim limiter is keyed on the claim ID URL param, not on IP', () => {
    const start = serverTs.indexOf('const otpClaimLimiter');
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 500);
    expect(body).toMatch(/keyGenerator:\s*\(req\)\s*=>\s*`claim-otp:\$\{req\.params\.id/);
  });

  it('POST /api/claims/:id/request-otp is mounted with otpGlobalLimiter, otpIpLimiter, AND otpClaimLimiter', () => {
    expect(serverTs).toMatch(
      /app\.post\('\/api\/claims\/:id\/request-otp',\s*otpGlobalLimiter,\s*otpIpLimiter,\s*otpClaimLimiter,/
    );
  });
});

describe('claim OTP request route requires phone match before sending any SMS', () => {
  const body = routeBody('post', '/api/claims/:id/request-otp');

  it('requires a phone in the request body (400 if missing)', () => {
    expect(body).toMatch(/const \{ phone \} = req\.body;/);
    expect(body).toMatch(/if \(!phone\)/);
  });

  it('normalizes and compares the supplied phone against claim.owner_phone before proceeding', () => {
    expect(body).toMatch(/normalizedInput !== normalizedOwner/);
    expect(body).toMatch(/toE164Kenyan\(String\(phone\)/);
    expect(body).toMatch(/toE164Kenyan\(String\(claim\.owner_phone/);
  });

  it('the phone-match check happens before the OTP code is generated/sent (fails closed, not after)', () => {
    const phoneCheckIdx = body.indexOf('normalizedInput !== normalizedOwner');
    const otpGenIdx = body.indexOf('crypto.randomInt(1000, 10000)');
    expect(phoneCheckIdx).toBeGreaterThan(-1);
    expect(otpGenIdx).toBeGreaterThan(-1);
    expect(phoneCheckIdx).toBeLessThan(otpGenIdx);
  });
});

describe('the frontend sends the phone it already collected, matching the flow that set claim.owner_phone', () => {
  it("OwnerView's triggerOtpRequest includes { phone: ownerPhone } in the request-otp call", () => {
    const ownerViewTsx = fs.readFileSync(
      path.resolve(__dirname, '../components/OwnerView.tsx'),
      'utf8'
    );
    const start = ownerViewTsx.indexOf('const triggerOtpRequest');
    expect(start).toBeGreaterThan(-1);
    const body = ownerViewTsx.slice(start, start + 500);
    expect(body).toMatch(/body:\s*JSON\.stringify\(\{\s*phone:\s*ownerPhone\s*\}\)/);
  });
});
