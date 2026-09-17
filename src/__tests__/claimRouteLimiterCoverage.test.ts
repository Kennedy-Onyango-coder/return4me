import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  claimStatusPollLimiter,
  paymentSessionStatusLimiter,
  CLAIM_STATUS_POLL_MAX,
} from '../config/claimStatusPollLimiter';

// =============================================================================
// PHASE 12 — CLAIM-FAMILY RATE-LIMITER COVERAGE
// =============================================================================
// REPRODUCED FINDING: GET /api/claims/:id/payment-session/:sessionId/status was
// registered with NO limiter, even though OwnerView POLLS it on the same
// 3-second cadence as GET /api/claims/:id/status (`payment_polling: 3`) and
// every other route in the claim family carries one. Its sibling polled route
// deliberately got its own 600/15-min IP policy (see
// config/claimStatusPollLimiter.ts) precisely because unbounded polling is a
// real exposure; this route got nothing, leaving unauthenticated claim-ID
// enumeration unbounded.
//
// These tests exist so a future claim route cannot silently ship unlimited, and
// so the two POLLED routes cannot silently be collapsed onto one shared bucket.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const serverTs = fs.readFileSync(path.resolve(repoRoot, 'src/server.ts'), 'utf8');

/** Any limiter token that legitimately bounds a claim-family route. */
const LIMITER_TOKENS = [
  'claimGuessLimiter',
  'claimStatusPollLimiter',
  'paymentSessionStatusLimiter',
  'otpGlobalLimiter',
  'otpIpLimiter',
  'otpClaimLimiter',
  'otpVerifyLimiter',
  'reportLimiter',
];

/**
 * Claim-family routes that carry NO limiter, on purpose, with the reason. This
 * map is asserted to be EXACT: adding a new unlimited claim route fails the
 * suite, and deleting an exemption also fails, so the exception list can never
 * drift silently.
 */
const LIMITLESS_BY_DESIGN: Record<string, string> = {
  '/api/claims/submit':
    'DEFERRED PRODUCT DECISION (Phase 12), deliberately NOT changed here. It is the only claim route with no limiter. ' +
    'It is already gated by the platform-pause check, canCreateClaim()/the one-active-claim-per-item partial unique index, ' +
    'server-side verification-answer validation and a required +254 number — but nothing bounds request VOLUME. The available ' +
    'policies are reportLimiter (10/15 min per IP) and claimGuessLimiter (20/15 min per IP); this is the most conversion-critical ' +
    'anonymous write in the product, and Kenyan users frequently share an IP (mobile NAT, and cyber cafes are the Agent target ' +
    'market), so choosing a threshold is a product decision that needs sign-off — inventing one here could block real claimants.',
};

const ROUTE_RE = /app\.(?:get|post|put|patch|delete)\(\s*'(\/api\/claims[^']*)'([^\n]*)/g;

function claimRoutes(): Array<{ route: string; line: string }> {
  const out: Array<{ route: string; line: string }> = [];
  for (const m of serverTs.matchAll(ROUTE_RE)) {
    out.push({ route: m[1], line: m[2] });
  }
  return out;
}

describe('every claim-family route is rate-limited, except the one documented exception', () => {
  it('finds the claim routes (guards the extractor itself)', () => {
    const routes = claimRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(10);
    expect(routes.map((r) => r.route)).toContain('/api/claims/:id/status');
    expect(routes.map((r) => r.route)).toContain('/api/claims/lookup');
  });

  it('registers a limiter on every claim route except the documented exception', () => {
    const unlimited: string[] = [];
    for (const { route, line } of claimRoutes()) {
      if (route in LIMITLESS_BY_DESIGN) continue;
      if (!LIMITER_TOKENS.some((token) => line.includes(token))) unlimited.push(route);
    }
    expect(unlimited, `claim routes registered with no rate limiter: ${unlimited.join(', ')}`).toEqual([]);
  });

  it('the exception list is exactly the routes that really have no limiter', () => {
    const reallyUnlimited = claimRoutes()
      .filter(({ line }) => !LIMITER_TOKENS.some((token) => line.includes(token)))
      .map(({ route }) => route);
    expect([...reallyUnlimited].sort()).toEqual(Object.keys(LIMITLESS_BY_DESIGN).sort());
  });
});

describe('the polled claim routes are limited and use SEPARATE buckets', () => {
  it('mounts the payment-session status route with its own limiter', () => {
    expect(serverTs).toContain(
      "app.get('/api/claims/:id/payment-session/:sessionId/status', paymentSessionStatusLimiter"
    );
  });

  it('mounts the claim status route with the poll limiter', () => {
    expect(serverTs).toContain("app.get('/api/claims/:id/status', claimStatusPollLimiter");
  });

  it('the two polled routes use DISTINCT limiter instances', () => {
    // express-rate-limit instances are shared buckets: one instance on both
    // routes would let the payment poller drain the claim-status poller's budget
    // (and vice versa), which is the exact cross-starvation defect that separated
    // this policy from claimGuessLimiter originally.
    expect(paymentSessionStatusLimiter).not.toBe(claimStatusPollLimiter);
  });

  it('both polled routes share the same, poll-appropriate budget', () => {
    // 600/15 min is 2x the 300 requests a single continuous 3-second poller can
    // generate in the window — generous for legitimate polling, still 30x tighter
    // than the general limiter's 1000 ceiling.
    expect(CLAIM_STATUS_POLL_MAX).toBe(600);
  });
});
