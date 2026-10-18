import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isAdminSessionCurrent } from '../auth';

// P0 fix: an admin JWT stayed fully usable for its entire remaining
// lifetime (currently 4h) even after admin_users.is_active was set to
// false, because is_active was only ever checked at login and at 2FA
// verification — never on the ~24 subsequent privileged requests a real
// admin session actually makes. requireCurrentAdminSession (server.ts) now
// re-checks both is_active and a token_version counter (admin_users.
// token_version) against the live record on every admin request, via
// isAdminSessionCurrent() extracted here for direct unit testing — same
// rationale as isAgentActionable: server.ts has no exports and a large
// amount of top-level side-effecting setup unsafe to trigger from a test
// file.
//
// Deliberately version-based rather than boolean-only: per the spec,
// "reactivate → old token must STILL remain invalid if version changed" —
// a boolean is_active-only check would let a previously-issued token work
// again the moment the account is reactivated, silently re-trusting a
// token that was minted before whatever security event caused the
// deactivation. A version counter that only ever increases means
// reactivation (is_active: true) alone is never sufficient; only a fresh
// login (which reads the account's current version at issuance) produces
// a token that matches again.

describe('isAdminSessionCurrent — the decision logic behind requireCurrentAdminSession', () => {
  it('login → valid request: a token minted at version 1 is accepted while the account is active at version 1', () => {
    const admin = { is_active: true, token_version: 1 };
    expect(isAdminSessionCurrent(admin, 1)).toBe(true);
  });

  it('disable account → old token rejected: is_active:false rejects even a version-matching token', () => {
    const admin = { is_active: false, token_version: 1 };
    expect(isAdminSessionCurrent(admin, 1)).toBe(false);
  });

  it('a security-sensitive change (e.g. 2FA disabled) bumps token_version, rejecting the old token even while the account stays active', () => {
    const adminBeforeBump = { is_active: true, token_version: 1 };
    const oldToken_version = 1;
    expect(isAdminSessionCurrent(adminBeforeBump, oldToken_version)).toBe(true);

    // Simulates db.bumpAdminTokenVersion() having run (e.g. from the 2FA
    // disable route).
    const adminAfterBump = { is_active: true, token_version: 2 };
    expect(isAdminSessionCurrent(adminAfterBump, oldToken_version)).toBe(false);
  });

  it('reactivate → old token must STILL remain invalid if version changed: is_active flips back to true, but the pre-deactivation token (still carrying the OLD version) is not revalidated', () => {
    // Deactivation bumped the version (e.g. an admin-management action, or
    // any future flow that both disables and revokes in one step).
    const oldTokenVersion = 1;
    const deactivated = { is_active: false, token_version: 2 };
    expect(isAdminSessionCurrent(deactivated, oldTokenVersion)).toBe(false);

    // Reactivating flips is_active back to true, but does NOT roll
    // token_version back down — that's the entire point.
    const reactivated = { is_active: true, token_version: 2 };
    expect(isAdminSessionCurrent(reactivated, oldTokenVersion)).toBe(false);

    // Only a token minted fresh, at the account's current (bumped)
    // version, works again.
    const freshToken_version = 2;
    expect(isAdminSessionCurrent(reactivated, freshToken_version)).toBe(true);
  });

  it('a token with no embedded tokenVersion at all fails closed (never treated as a wildcard match)', () => {
    const admin = { is_active: true, token_version: 1 };
    expect(isAdminSessionCurrent(admin, undefined)).toBe(false);
  });

  it('no admin account found for the token at all = denied', () => {
    expect(isAdminSessionCurrent(undefined, 1)).toBe(false);
    expect(isAdminSessionCurrent(null, 1)).toBe(false);
  });
});

const serverTs = [
  fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8'),
  // The two admin dispute routes were extracted into their own module so they
  // can be exercised over real HTTP (see routes/adminDisputes.ts). They remain
  // /api/admin routes, so the "every admin route carries
  // requireCurrentAdminSession" audit must still see them.
  fs.readFileSync(path.resolve(__dirname, '../../routes/adminDisputes.ts'), 'utf8'),
  // Phase 6E: the Claims Administration read routes live in their own module
  // too, and must satisfy the same requireCurrentAdminSession requirement.
  fs.readFileSync(path.resolve(__dirname, '../../routes/adminClaims.ts'), 'utf8'),
].join('\n');

function findAdminRoutes(source: string): Array<{ method: string; route: string; body: string }> {
  // BATCH 1 (B) — whitespace tolerant after the opening paren, so how a route is
  // formatted can never decide whether it is audited (see adminRouteAudit.test.ts).
  const routeRegex = /app\.(get|post|put|delete)\(\s*'(\/api\/admin[^']*)',\s*authenticateJWT,/g;
  const matches: Array<{ method: string; route: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = routeRegex.exec(source)) !== null) {
    matches.push({ method: m[1], route: m[2], index: m.index });
  }
  return matches.map((match, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].index : match.index + 400;
    return { method: match.method, route: match.route, body: source.slice(match.index, end) };
  });
}

describe('requireCurrentAdminSession is wired into every /api/admin route', () => {
  const adminRoutes = findAdminRoutes(serverTs);

  it('found at least one /api/admin route to check (sanity check that the parser works)', () => {
    expect(adminRoutes.length).toBeGreaterThan(0);
  });

  for (const { method, route, body } of findAdminRoutes(serverTs)) {
    it(`${method.toUpperCase()} ${route} is mounted with requireCurrentAdminSession immediately after authenticateJWT`, () => {
      expect(body).toMatch(/authenticateJWT,\s*requireCurrentAdminSession,/);
    });
  }

// ---------------------------------------------------------------------------
// BATCH 1 (B) — THE PAYOUT ROUTES ARE NAMED, NOT MERELY COUNTED.
//
// The generic test above passes vacuously for a route the scanner never matched,
// so a route that was reformatted, renamed or moved would simply stop being
// session-checked with no failure. Each route that can submit a real payout is
// therefore named here and its exact middleware chain is pinned.
// ---------------------------------------------------------------------------
describe('BATCH 1 (B) — every route that can submit a real payout validates the current admin session', () => {
  const PAYOUT_ROUTES = [
    '/api/admin/claims/:id/settlement/approve-and-pay',
    '/api/admin/claims/:id/settlement/initiate',
    '/api/admin/claims/:id/release-settlement',
  ];

  for (const route of PAYOUT_ROUTES) {
    it(`POST ${route} is discovered and carries authenticateJWT, requireCurrentAdminSession and the payout limiter`, () => {
      const found = findAdminRoutes(serverTs).find((r) => r.method === 'post' && r.route === route);
      expect(found, `the scanner must discover ${route}`).toBeDefined();
      expect(found!.body).toMatch(/authenticateJWT,\s*requireCurrentAdminSession,/);
      // The failed-attempt ceiling is part of the guard chain, not decoration: a
      // route that re-authenticates without it can be brute-forced by a stolen
      // session.
      expect(found!.body).toContain('adminSettlementPayoutLimiter,');
    });
  }
});

});

describe('requireCurrentAdminSession is wired into all three admin-2FA routes under /api/auth', () => {
  const adminTwoFaRoutes = [
    '/api/auth/admin-2fa/setup',
    '/api/auth/admin-2fa/confirm',
    '/api/auth/admin-2fa/disable',
  ];

  for (const route of adminTwoFaRoutes) {
    it(`POST ${route} is mounted with requireCurrentAdminSession immediately after authenticateJWT`, () => {
      const marker = `app.post('${route}', authenticateJWT,`;
      const start = serverTs.indexOf(marker);
      expect(start, `route not found: ${route}`).toBeGreaterThan(-1);
      const body = serverTs.slice(start, start + 200);
      expect(body).toMatch(/authenticateJWT,\s*requireCurrentAdminSession,/);
    });
  }
});

describe('disabling 2FA actually triggers a session-revoking token-version bump', () => {
  it('the admin-2fa/disable route calls db.bumpAdminTokenVersion after disableAdminTotp', () => {
    const start = serverTs.indexOf("app.post('/api/auth/admin-2fa/disable'");
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 1500);
    const disableIdx = body.indexOf('disableAdminTotp');
    const bumpIdx = body.indexOf('bumpAdminTokenVersion');
    expect(disableIdx, 'disableAdminTotp call not found').toBeGreaterThan(-1);
    expect(bumpIdx, 'bumpAdminTokenVersion call not found').toBeGreaterThan(-1);
    expect(bumpIdx).toBeGreaterThan(disableIdx);
  });
});
