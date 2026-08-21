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
