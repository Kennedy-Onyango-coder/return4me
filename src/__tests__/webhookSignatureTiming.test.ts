import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Regression test: the IntaSend webhook handler (POST /api/webhooks/intasend)
// used to compare its computed HMAC-SHA256 signature against the header/
// embedded signature with plain `===` — a variable-time string comparison.
// Every other secret comparison in this codebase (OTP codes, pickup codes,
// the claim payment-auth token) goes through timingSafeEqualHex specifically
// to avoid this class of issue; the webhook handler was the one place that
// didn't. Static source-audit test (same pattern as adminRouteAudit.test.ts)
// since server.ts doesn't export its Express app separately from
// startServer()'s bootstrap.
//
// P2-A3.3: the route was extracted verbatim into routes/webhooks.ts, so the
// resolver below reads from whichever file owns it. Every assertion is
// unchanged — this is a source-LOCATION change only, and the assertion that
// both checks are timing-safe still has to find exactly two.

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

describe('IntaSend webhook signature verification is timing-safe', () => {
  const body = routeBody('post', '/api/webhooks/intasend');

  it('does not use a plain === comparison against the computed HMAC digest', () => {
    expect(body).not.toMatch(/computed === signatureHeader/);
    expect(body).not.toMatch(/computed === signature\b/);
  });

  it('uses timingSafeEqualHex for both the header and embedded signature checks', () => {
    const matches = body.match(/timingSafeEqualHex\(computed,/g) || [];
    expect(matches.length).toBe(2);
  });
});
