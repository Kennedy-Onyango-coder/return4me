import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
// PHASE 9D (F3) — the ONE shared coordinate validator. Imported here so the
// admin agent-location route's contract can be asserted against the exact
// semantics it now inherits.
import { normalizeCoordinateInput } from '../services/coordinates';

// authenticateJWT (src/services/auth.ts) only verifies that a token is
// validly signed and unexpired — it does NOT check role. That means every
// route mounted at /api/admin/* is only actually admin-only because it
// separately checks `req.user?.role !== 'admin'` inline. Without that
// check, an 'admin_pending_2fa' token (issued after password verification
// but before the TOTP code is confirmed — see /api/auth/admin-login) or
// any other authenticated role's token would be able to call it.
//
// This is a static source-audit test, not a live HTTP test — this
// codebase doesn't currently export server.ts's Express app separately
// from its startup bootstrap (DB migrations, cron jobs, etc. all run
// inline in startServer()), and restructuring that split is out of scope
// for a hardening pass whose explicit brief is "do not restructure
// working code." What this test DOES catch, which a live HTTP test
// wouldn't do any better: a future admin route added without the role
// check, or an existing one whose check gets accidentally removed or
// commented out.

const serverTs = [
  fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8'),
  // The two admin dispute routes were extracted into their own module so they
  // can be exercised over real HTTP (see routes/adminDisputes.ts). They are
  // still /api/admin routes, so they must stay inside this audit's scope —
  // without this, moving them would silently drop their role-check coverage.
  fs.readFileSync(path.resolve(__dirname, '../routes/adminDisputes.ts'), 'utf8'),
  // Phase 6E: the Claims Administration read routes are also /api/admin routes
  // in their own module, so they are scanned here too — otherwise adding them
  // would place them entirely outside this audit, which is exactly the
  // regression this scanner exists to prevent.
  fs.readFileSync(path.resolve(__dirname, '../routes/adminClaims.ts'), 'utf8'),
  // PHASE 11A: the admin lost-report read route. Same reasoning as the claims
  // module above — it is an /api/admin route in its own file, so it must stay
  // inside this audit's scope or its role check would be unguarded by it.
  fs.readFileSync(path.resolve(__dirname, '../routes/adminLostReports.ts'), 'utf8'),
].join('\n');

function findAdminRoutes(source: string): Array<{ method: string; route: string; body: string }> {
  const routeRegex = /app\.(get|post|put|delete)\('(\/api\/admin[^']*)',\s*authenticateJWT,/g;
  const matches: Array<{ method: string; route: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = routeRegex.exec(source)) !== null) {
    matches.push({ method: m[1], route: m[2], index: m.index });
  }
  return matches.map((match, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].index : match.index + 4000;
    return { method: match.method, route: match.route, body: source.slice(match.index, end) };
  });
}

describe('every /api/admin route enforces an explicit admin role check', () => {
  const adminRoutes = findAdminRoutes(serverTs);

  it('found at least one /api/admin route to check (sanity check that the parser itself works)', () => {
    expect(adminRoutes.length).toBeGreaterThan(0);
  });

  for (const { method, route, body } of findAdminRoutes(serverTs)) {
    it(`${method.toUpperCase()} ${route} checks req.user?.role !== 'admin' before doing anything sensitive`, () => {
      expect(body).toMatch(/role\s*!==\s*['"]admin['"]/);
    });
  }
});

// Coverage gap this closes: the audit above only scans routes whose path
// starts with /api/admin — but three equally admin-only, equally sensitive
// routes (2FA setup/confirm/disable for admin accounts) live under
// /api/auth/admin-2fa/* instead, entirely outside that regex's reach.
// They are correctly protected today (verified below), but the audit
// above would not have caught it if they weren't — this closes that blind
// spot so a future accidental removal of the role check on any of these
// three specifically is caught, the same way it already would be for a
// route under /api/admin.
describe('the three admin-2fa routes under /api/auth (outside /api/admin) also enforce the admin role check', () => {
  const adminTwoFaRoutes = [
    "/api/auth/admin-2fa/setup",
    "/api/auth/admin-2fa/confirm",
    "/api/auth/admin-2fa/disable",
  ];

  for (const route of adminTwoFaRoutes) {
    it(`POST ${route} checks req.user?.role !== 'admin'`, () => {
      const marker = `app.post('${route}', authenticateJWT,`;
      const start = serverTs.indexOf(marker);
      expect(start, `route not found: ${route}`).toBeGreaterThan(-1);
      const body = serverTs.slice(start, start + 1500);
      expect(body).toMatch(/role\s*!==\s*['"]admin['"]/);
    });
  }
});

// ---------------------------------------------------------------------------
// PHASE 9D (F3) — ADMIN COORDINATE INPUT GOES THROUGH THE ONE SHARED VALIDATOR
//
// The forensic review found this route carried a SECOND, independent
// coordinate check using a lenient `parseFloat()` — so '1.29junk' was silently
// accepted as 1.29, and the latitude/longitude range rule was duplicated in a
// place that could drift from the shared implementation.
//
// The route now delegates to `normalizeCoordinateInput` (services/coordinates.ts),
// the same function the found-item report route uses. The static assertion
// below catches a future edit that reintroduces local parsing; the behavioural
// assertions pin the exact accept/reject contract the route inherits.
// ---------------------------------------------------------------------------
describe('PHASE 9D — admin agent-location coordinates use the shared validator', () => {
  const route = findAdminRoutes(serverTs).find((r) => r.route === '/api/admin/agents/:id/location');

  it('the route exists and is still admin-gated (sanity check for this audit)', () => {
    expect(route).toBeDefined();
    expect(route!.body).toMatch(/role\s*!==\s*['"]admin['"]/);
  });

  it('delegates to normalizeCoordinateInput and no longer parses coordinates locally', () => {
    expect(route!.body).toContain('normalizeCoordinateInput(latitude, longitude)');
    // The lenient local parser and its duplicated range rule must be gone.
    expect(route!.body).not.toMatch(/parseFloat\s*\(/);
    expect(route!.body).not.toMatch(/isNaN\s*\(/);
    expect(route!.body).not.toMatch(/<\s*-?90|-90\s*>/);
  });

  it('keeps the same 400 response for an invalid pair', () => {
    expect(route!.body).toMatch(/status\(400\)/);
    expect(route!.body).toContain('Invalid latitude/longitude');
  });

  it('ACCEPTS every value the endpoint must accept (including 0 and boundaries)', () => {
    const accepted: Array<[any, any]> = [
      ['1.29', '36.82'],
      ['0', '36.82'],          // zero latitude — the F1 case, also valid here
      ['-1.2921', '0'],        // zero longitude
      [0, 0],                  // numbers, not strings
      [-1.2921, 36.8219],
      ['-90', '180'],          // inclusive boundaries
      ['90', '-180'],
      [' 36.8219 ', '-1.2921'], // surrounding whitespace
    ];
    for (const [lat, lon] of accepted) {
      expect(normalizeCoordinateInput(lat, lon), `${lat},${lon}`).not.toBeNull();
    }
  });

  it('REJECTS trailing garbage and malformed numeric strings (the F3 defect)', () => {
    for (const bad of ['1.29junk', '12abc', '1,29', 'abc', 'NaN', 'Infinity', '-Infinity']) {
      expect(normalizeCoordinateInput(bad, '36.82'), `lat=${bad}`).toBeNull();
      expect(normalizeCoordinateInput('-1.29', bad), `lon=${bad}`).toBeNull();
    }
  });

  it('REJECTS blank, whitespace-only, null and missing coordinate input', () => {
    for (const bad of ['', '   ', null, undefined]) {
      expect(normalizeCoordinateInput(bad, '36.82'), `lat=${String(bad)}`).toBeNull();
      expect(normalizeCoordinateInput('-1.29', bad), `lon=${String(bad)}`).toBeNull();
    }
  });

  it('REJECTS out-of-range values on either axis, without clamping them', () => {
    expect(normalizeCoordinateInput('90.0001', '36.82')).toBeNull();
    expect(normalizeCoordinateInput('-91', '36.82')).toBeNull();
    expect(normalizeCoordinateInput('-1.29', '180.5')).toBeNull();
    expect(normalizeCoordinateInput('-1.29', '-181')).toBeNull();
  });
});
