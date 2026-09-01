import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

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

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

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
