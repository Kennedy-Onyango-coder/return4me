import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Regression test: the IntaSend webhook handler (POST /api/webhooks/intasend)
// authenticates collection events with the configured CHALLENGE value (sent in
// the payload), NOT with an HMAC signature header. This replaced a prior HMAC
// implementation whose `===` comparison was variable-time — and, more
// importantly, whose contract did not match IntaSend's collection webhook at
// all, so real completed payments were rejected as unauthenticated and left the
// claim stuck in `pending_payment`.
//
// Every secret comparison in this codebase must be timing-safe. The challenge
// is an opaque string (not a hex digest), so it is hashed to a fixed length and
// compared with crypto.timingSafeEqual. This is a static source-audit test
// (server.ts's Express app is not separately exported), following the same
// pattern as adminRouteAudit.test.ts.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
const webhooksTs = fs.readFileSync(path.resolve(__dirname, '../routes/webhooks.ts'), 'utf8');

function routeBody(method: 'get' | 'post', route: string): string {
  const marker = `app.${method}('${route}'`;
  const start = serverTs.indexOf(marker);
  if (start > -1) return serverTs.slice(start, start + 3000);
  const moduleStart = webhooksTs.indexOf(marker);
  expect(
    moduleStart,
    `route ${method.toUpperCase()} ${route} not found in server.ts or routes/webhooks.ts`
  ).toBeGreaterThan(-1);
  return webhooksTs.slice(moduleStart, moduleStart + 3000);
}

describe('IntaSend webhook challenge verification is timing-safe', () => {
  const body = routeBody('post', '/api/webhooks/intasend');

  it('does not compare the challenge with a plain === ', () => {
    expect(body).not.toMatch(/challenge\s*===\s*configuredChallenge/);
    expect(body).not.toMatch(/configuredChallenge\s*===\s*challenge/);
  });

  it('verifies the challenge through the timing-safe helper', () => {
    expect(body).toContain('challengeMatches(payload.challenge, configuredChallenge)');
  });

  it('the helper hashes both sides to a fixed length and uses crypto.timingSafeEqual', () => {
    const start = webhooksTs.indexOf('function challengeMatches');
    expect(start, 'challengeMatches helper not found').toBeGreaterThan(-1);
    const helper = webhooksTs.slice(start, start + 700);
    // Fixed-length digests make crypto.timingSafeEqual safe to call (it requires
    // equal-length buffers) and stop a length difference leaking via early exit.
    expect(helper).toMatch(/createHash\('sha256'\)/);
    expect(helper).toMatch(/crypto\.timingSafeEqual\(/);
  });
});
