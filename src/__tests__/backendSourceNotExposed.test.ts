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
});
