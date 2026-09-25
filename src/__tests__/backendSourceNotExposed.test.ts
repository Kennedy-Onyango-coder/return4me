import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Regression test for a real information-disclosure gap: production used
// to serve the ENTIRE src/ directory as static files at /src/* — meaning
// GET /src/server.ts returned the complete backend source (every
// validation rule, rate-limit threshold, magic-byte check, and the
// comments explaining the security model), and GET /src/db/database.ts,
// /src/services/auth.ts, /src/services/payments.ts etc. were all equally
// exposed. The stated purpose (letting browser sourcemaps resolve
// original .tsx text for files not present as raw source in dist/) only
// ever needed the frontend files, which are the only ones an actual
// Vite/browser sourcemap can reference — confirmed zero imports from
// src/components, src/App.tsx, or src/main.tsx into src/db/ or
// src/services/.
//
// Static source-audit test (same pattern as the other route-gating tests
// in this suite) since server.ts doesn't export its Express app
// separately from startServer()'s bootstrap.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

describe('backend source under src/ is not exposed via the /src static route', () => {
  it('a denylist middleware for backend paths is registered before the /src static handler', () => {
    const denylistIdx = serverTs.indexOf('srcBackendPathPrefixes');
    const staticIdx = serverTs.indexOf("app.use('/src', express.static(");
    expect(denylistIdx, 'srcBackendPathPrefixes denylist not found').toBeGreaterThan(-1);
    expect(staticIdx, "app.use('/src', express.static(...)) not found").toBeGreaterThan(-1);
    expect(denylistIdx).toBeLessThan(staticIdx);
  });

  it('the denylist blocks server.ts, db/, services/, and __tests__/', () => {
    const start = serverTs.indexOf('const srcBackendPathPrefixes');
    expect(start).toBeGreaterThan(-1);
    const line = serverTs.slice(start, start + 300);
    expect(line).toMatch(/'\/src\/server\.ts'/);
    expect(line).toMatch(/'\/src\/db\/'/);
    expect(line).toMatch(/'\/src\/services\/'/);
    expect(line).toMatch(/'\/src\/__tests__\/'/);
  });

  it('the denylist middleware terminates blocked requests with 404 rather than serving the file or leaking a 403 that would confirm the path exists', () => {
    const start = serverTs.indexOf("app.use('/src', (req, res, next) =>");
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 400);
    expect(body).toMatch(/res\.status\(404\)\.send\('Not Found'\)/);
  });

  // PHASE 12 — the denylist above and express.static were BOTH bypassable through
  // the hand-rolled /src sourcemap fallback in app.get('*'), which tested the RAW
  // request path but then resolved it with path.join (which normalises '..'):
  // '/src/../sql/schema.sql' passed startsWith('/src/') and resolved to
  // <cwd>/sql/schema.sql, outside src/ — and '/src/../src/db/schema.ts' resolved
  // back INSIDE src/ and served backend source, defeating this very denylist.
  it('the /src sourcemap fallback delegates to the containment-checked resolver', () => {
    expect(serverTs).toContain("import { resolveContainedSourcePath } from './utils/safeStaticPath'");
    expect(serverTs).toContain('resolveContainedSourcePath(srcRoot, req.path)');
  });

  it('the /src sourcemap fallback no longer resolves a raw request path with path.join', () => {
    // Judged on CODE, not prose: this file's own explanatory comment above quotes
    // the vulnerable expression verbatim. Comment lines are dropped with the same
    // line-based filter the rest of this suite uses. (A /* ... */ strip is NOT used
    // here: server.ts's own comments legitimately contain sequences like /src/* and
    // /api/*, which an unterminated-looking block strip would swallow wholesale.)
    const codeOnly = serverTs
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    // The exact vulnerable expression, which must never come back.
    expect(codeOnly).not.toContain('path.join(process.cwd(), req.path)');
  });
});

// ---------------------------------------------------------------------------
// SEC-2B-04 — '/src/routes/' must be in the denylist
// ---------------------------------------------------------------------------
// The six backend-only route modules (adminClaims, adminDisputes,
// adminLostReports, customerClaims, lostReports, publicItems) live under
// src/routes/ and were NOT covered by the four original prefixes. They are
// imported only by server.ts and referenced by no frontend file, so no browser
// sourcemap can ever need them — the same test the comment above applies to
// src/db/ and src/services/. Without the entry, production served
// GET /src/routes/adminClaims.ts (admin API shape + permission-guard wiring)
// as plain text.
//
// These assertions read the SHIPPED ARRAY and apply the SHIPPED predicate to
// real request paths, enumerating the real files on disk — so a future route
// module cannot be added outside the denylist without failing here. The
// predicate itself is pinned to the middleware that applies it, so the data
// assertions describe real behaviour rather than a re-implementation.
describe('SEC-2B-04: backend route modules are denied by the production static denylist', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const routesDir = path.join(repoRoot, 'src', 'routes');

  /** The denylist array exactly as it ships, parsed from server.ts. */
  function denylistPrefixes(): string[] {
    const start = serverTs.indexOf('const srcBackendPathPrefixes = [');
    expect(start, 'srcBackendPathPrefixes declaration not found').toBeGreaterThan(-1);
    const end = serverTs.indexOf('];', start);
    expect(end).toBeGreaterThan(start);
    const literal = serverTs.slice(start, end + 2);
    return [...literal.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  /** The comparison the shipped middleware performs. */
  function isDenied(requestPath: string, prefixes: string[]): boolean {
    return prefixes.some((prefix) => requestPath === prefix || requestPath.startsWith(prefix));
  }

  it('the shipped middleware applies exactly the predicate these assertions model', () => {
    const start = serverTs.indexOf("app.use('/src', (req, res, next) => {");
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 400);
    expect(body).toMatch(
      /srcBackendPathPrefixes\.some\(prefix => req\.path === prefix \|\| req\.path\.startsWith\(prefix\)\)/,
    );
    // 404, not 403 — the response must not confirm a backend layer exists.
    expect(body).toMatch(/res\.status\(404\)\.send\('Not Found'\)/);
  });

  it('every module actually present in src/routes/ is denied', () => {
    const prefixes = denylistPrefixes();
    expect(prefixes, "'/src/routes/' must be in the denylist").toContain('/src/routes/');

    const modules = fs.readdirSync(routesDir).filter((f) => f.endsWith('.ts'));
    expect(modules.length, 'src/routes/ must contain route modules').toBeGreaterThan(0);
    for (const file of modules) {
      expect(isDenied(`/src/routes/${file}`, prefixes), `${file} must be denied`).toBe(true);
    }
  });

  it('the representative backend route paths named by the audit are all denied', () => {
    const prefixes = denylistPrefixes();
    const audited = [
      '/src/routes/adminClaims.ts',
      '/src/routes/adminDisputes.ts',
      '/src/routes/adminLostReports.ts',
      '/src/routes/customerClaims.ts',
      '/src/routes/lostReports.ts',
      '/src/routes/publicItems.ts',
    ];
    for (const requestPath of audited) {
      expect(isDenied(requestPath, prefixes), `${requestPath} must be denied`).toBe(true);
    }
    // The four pre-existing prefixes must not have been dropped in the process.
    for (const preExisting of ['/src/server.ts', '/src/db/schema.ts', '/src/services/auth.ts', '/src/__tests__/setup.testEnv.ts']) {
      expect(isDenied(preExisting, prefixes), `${preExisting} must still be denied`).toBe(true);
    }
  });

  it('frontend source stays reachable — only the backend directory was closed', () => {
    const prefixes = denylistPrefixes();
    for (const frontend of ['/src/App.tsx', '/src/main.tsx', '/src/types.ts', '/src/components/Navbar.tsx']) {
      expect(isDenied(frontend, prefixes), `${frontend} must remain served`).toBe(false);
    }
  });
});
