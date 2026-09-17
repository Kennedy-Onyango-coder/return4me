import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import {
  createClaimStatusPollLimiter,
  claimStatusPollLimiter,
  CLAIM_STATUS_POLL_MAX,
  CLAIM_STATUS_POLL_WINDOW_MS,
} from '../config/claimStatusPollLimiter';

// ---------------------------------------------------------------------------
// F1 REGRESSION TESTS — claim-status POLLING must not share (or starve) the
// discrete claim/payment limiter bucket.
//
// WHY THIS IS A REAL HTTP HARNESS AND NOT A STRING CHECK: F1 was a runtime
// bucket-sharing defect. The only way to demonstrate the fix is to send real
// requests through real express-rate-limit instances and read the limiter's own
// headers (RateLimit-Limit / Retry-After) to establish WHICH policy produced a
// 429.
//
// WHAT IS REAL HERE: the limiter under test is the shipped
// `createClaimStatusPollLimiter` factory and its default instance (the same
// object server.ts mounts), and the discrete-shaped limiter is built with the
// same library/config shape as `claimGuessLimiter` (20/15 min, IP keyed).
// WHAT IS A HARNESS: the route handlers themselves are trivial stubs, because
// server.ts cannot be imported by a test (it boots the app at import time).
// The real wiring of these limiters onto the real handlers is asserted in
// src/__tests__/claimStatusPrivacy.test.ts and was verified LIVE over HTTP
// against the running server (see the Phase 7B.2 report).
//
// ISOLATION METHOD: the harness trusts the proxy and each test group sends its
// own X-Forwarded-For value, so every group gets a private limiter bucket and
// no test can exhaust another's budget.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname, '../..');
const serverTs = fs.readFileSync(path.resolve(repoRoot, 'src/server.ts'), 'utf8');
const ownerViewTsx = fs.readFileSync(path.resolve(repoRoot, 'src/components/OwnerView.tsx'), 'utf8');

// The hard maximum a single continuous 3-second poller can generate inside one
// 15-minute window: 15 min * 60 s / 3 s = 300 requests.
const MAX_REQUESTS_PER_WINDOW_FROM_LEGIT_POLLING = 300;

function buildApp(statusLimiter: any, discreteLimiter?: any) {
  const app = express();
  app.use(express.json());
  // Trust the proxy so each test group's X-Forwarded-For value selects its own
  // bucket (mirrors how the real deployment derives req.ip through one hop).
  app.set('trust proxy', true);

  app.get('/api/claims/:id/status', statusLimiter, (req, res) => {
    res.json({ status: 'awaiting_agent_confirmation', claim: { id: req.params.id } });
  });

  if (discreteLimiter) {
    // Stand-in for a real DISCRETE claim route (/lookup-shaped): same config
    // shape as claimGuessLimiter, never polled.
    app.post('/api/claims/lookup', discreteLimiter, (req, res) => {
      res.json({ success: true });
    });
  }
  return app;
}

/** Same shape as server.ts's claimGuessLimiter (20 requests / 15 min, IP keyed). */
function buildDiscreteShapedLimiter(overrides?: { max?: number }) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: overrides?.max ?? 20,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    message: { error: 'discrete-claim-limiter' },
  });
}

const servers: any[] = [];
async function serve(app: any): Promise<string> {
  const s = await new Promise<any>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}

async function hit(baseUrl: string, method: 'GET' | 'POST', urlPath: string, xff: string) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
    body: method === 'POST' ? JSON.stringify({ claimId: 'CLM-000000', phone: '+254712345678' }) : undefined,
  });
  try { await res.text(); } catch { /* body not needed */ }
  return {
    status: res.status,
    limit: res.headers.get('ratelimit-limit'),
    remaining: res.headers.get('ratelimit-remaining'),
    retryAfter: res.headers.get('retry-after'),
  };
}

/** Fires `count` sequential status polls and reports the outcome set. */
async function poll(baseUrl: string, count: number, xff: string, claimId = 'CLM-000000') {
  const statuses: number[] = [];
  let lastLimit: string | null = null;
  for (let i = 0; i < count; i++) {
    const r = await hit(baseUrl, 'GET', `/api/claims/${claimId}/status`, xff);
    statuses.push(r.status);
    lastLimit = r.limit;
  }
  return { statuses, throttled: statuses.filter((s) => s === 429).length, lastLimit };
}

let shippedBase = '';
let smallBase = '';
let mixedBase = '';
let discreteBase = '';

beforeAll(async () => {
  shippedBase = await serve(buildApp(claimStatusPollLimiter));
  smallBase = await serve(buildApp(createClaimStatusPollLimiter({ max: 3 })));
  mixedBase = await serve(
    buildApp(createClaimStatusPollLimiter({ max: 2 }), buildDiscreteShapedLimiter())
  );
  discreteBase = await serve(
    buildApp(claimStatusPollLimiter, buildDiscreteShapedLimiter())
  );
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe('the shipped status-polling policy supports legitimate polling', () => {
  it('A/B. 320 consecutive polls (≈16 minutes at the 3s cadence) are never throttled, and the policy is the shipped 600/15min', async () => {
    const { statuses, throttled, lastLimit } = await poll(shippedBase, 320, '203.0.113.10');
    expect(throttled).toBe(0);
    expect(statuses.every((s: number) => s === 200)).toBe(true);
    // Establishes WHICH limiter answered: the dedicated status policy.
    expect(lastLimit).toBe(String(CLAIM_STATUS_POLL_MAX));
    expect(CLAIM_STATUS_POLL_MAX).toBe(600);
    expect(CLAIM_STATUS_POLL_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it('the shipped limit leaves at least 2x headroom over the maximum a legitimate poller can generate per window', () => {
    expect(CLAIM_STATUS_POLL_MAX).toBeGreaterThanOrEqual(MAX_REQUESTS_PER_WINDOW_FROM_LEGIT_POLLING * 2);
  });

  it('the status policy is not effectively unlimited (a small override is genuinely enforced, with its own headers)', async () => {
    const xff = '203.0.113.11';
    expect((await hit(smallBase, 'GET', '/api/claims/CLM-000000/status', xff)).status).toBe(200);
    expect((await hit(smallBase, 'GET', '/api/claims/CLM-000000/status', xff)).status).toBe(200);
    expect((await hit(smallBase, 'GET', '/api/claims/CLM-000000/status', xff)).status).toBe(200);
    const fourth = await hit(smallBase, 'GET', '/api/claims/CLM-000000/status', xff);
    expect(fourth.status).toBe(429);
    // Which limiter fired: the injected status policy (limit 3), not a discrete one.
    expect(fourth.limit).toBe('3');
    expect(fourth.retryAfter).not.toBeNull();
  });

  it('the status bucket is per-caller: one exhausted poller does not throttle another', async () => {
    const exhausted = await poll(smallBase, 4, '203.0.113.12');
    expect(exhausted.throttled).toBe(1);
    const other = await hit(smallBase, 'GET', '/api/claims/CLM-000000/status', '203.0.113.13');
    expect(other.status).toBe(200);
    expect(other.limit).toBe('3');
  });
});

describe('cross-route isolation: polling and discrete claim operations do not share a bucket', () => {
  it('D1. exhausting the STATUS bucket does not 429 the discrete claim route', async () => {
    const xff = '203.0.113.20';
    // Exhaust the status policy (max 2).
    expect((await hit(mixedBase, 'GET', '/api/claims/CLM-000000/status', xff)).status).toBe(200);
    expect((await hit(mixedBase, 'GET', '/api/claims/CLM-000000/status', xff)).status).toBe(200);
    const thirdStatus = await hit(mixedBase, 'GET', '/api/claims/CLM-000000/status', xff);
    expect(thirdStatus.status).toBe(429);
    expect(thirdStatus.limit).toBe('2');

    // The discrete route is untouched by that exhaustion.
    for (let i = 0; i < 3; i++) {
      const r = await hit(mixedBase, 'POST', '/api/claims/lookup', xff);
      expect(r.status).toBe(200);
      expect(r.limit).toBe('20');
    }
  });

  it('D2. exhausting the DISCRETE bucket (the F1 failure mode) does not throttle legitimate status polling', async () => {
    const xff = '203.0.113.21';
    // 20 discrete calls are fine, the 21st is the existing, unchanged cap.
    for (let i = 0; i < 20; i++) {
      expect((await hit(discreteBase, 'POST', '/api/claims/lookup', xff)).status).toBe(200);
    }
    const capped = await hit(discreteBase, 'POST', '/api/claims/lookup', xff);
    expect(capped.status).toBe(429);
    expect(capped.limit).toBe('20'); // proves the discrete limiter is the one enforcing

    // The F1 invariant: polling still works with an exhausted discrete bucket.
    const polled = await poll(discreteBase, 5, xff);
    expect(polled.throttled).toBe(0);
    expect(polled.lastLimit).toBe(String(CLAIM_STATUS_POLL_MAX));
  });

  it('D3. a status 429 never spills into the discrete bucket (the exact F1 failure mode)', async () => {
    const xff = '203.0.113.22';
    const exhausted = await poll(mixedBase, 3, xff); // status max is 2 in this harness
    expect(exhausted.throttled).toBe(1);
    const discrete = await hit(mixedBase, 'POST', '/api/claims/lookup', xff);
    expect(discrete.status).toBe(200);
  });
});

describe('wiring: the failure mode cannot silently return (source-level tripwires)', () => {
  it('the shipped status route uses the dedicated limiter, never the discrete one', () => {
    expect(serverTs).toMatch(/app\.get\('\/api\/claims\/:id\/status',\s*claimStatusPollLimiter,/);
    expect(serverTs).not.toMatch(/app\.get\('\/api\/claims\/:id\/status',\s*claimGuessLimiter,/);
  });

  it('the discrete limiter keeps its original 20/15min policy and its five routes', () => {
    const start = serverTs.indexOf('const claimGuessLimiter = rateLimit({');
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 400);
    expect(body).toMatch(/max:\s*20(,|\s)/);
    for (const route of [
      "app.post('/api/claims/:id/payment-auth', claimGuessLimiter,",
      "app.post('/api/claims/:id/payment-session', claimGuessLimiter,",
      "app.post('/api/claims/:id/pay', claimGuessLimiter,",
      "app.post('/api/claims/lookup', claimGuessLimiter,",
      "app.post('/api/claims/:id/rate', claimGuessLimiter,",
    ]) {
      expect(serverTs).toContain(route);
    }
  });

  it('OwnerView stops polling and says so when the server answers 429 (source-level: no DOM test framework exists in this repo)', () => {
    // Both pollers (awaiting-agent and payment) must handle 429 explicitly...
    expect((ownerViewTsx.match(/response\.status === 429/g) || []).length).toBe(2);
    // ...by clearing the interval rather than hammering every 3 seconds, and by
    // surfacing the pause instead of silently pretending to still be waiting.
    const throttledBlocks = ownerViewTsx.split('response.status === 429');
    for (let i = 1; i < throttledBlocks.length; i++) {
      const block = throttledBlocks[i].slice(0, 320);
      expect(block, 'a 429 branch must clear the polling interval').toMatch(/clearInterval\(interval\)/);
      expect(block, 'a 429 branch must surface a user-visible message').toMatch(/setErrorMsg\(statusPollThrottledMessage\(lang\)\)/);
    }
    // The awaiting-agent step must render that message (it previously had no
    // error surface at all, so a paused poller looked like a healthy one).
    const awaitingStep = ownerViewTsx.slice(
      ownerViewTsx.indexOf("verificationStep === 'awaiting_agent_confirmation'")
    );
    expect(awaitingStep).toMatch(/\{errorMsg && \(/);
  });
});
