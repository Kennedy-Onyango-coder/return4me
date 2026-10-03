import { describe, it, expect, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// P2-A4 — THE IMPORT GUARD / BOOT BOUNDARY.
//
// Before this batch, `src/server.ts` called `startServer()` UNCONDITIONALLY at
// import. Importing it therefore opened a listening socket, ran the schema
// migration, seeded an admin, started a Vite dev server and launched four
// background sweeps. That is the single reason no runtime HTTP test could ever
// mount the REAL application — the constraint is documented in several test
// headers, including customerClaimJourneyLink.test.ts ("server.ts calls
// startServer() at import time ... so it CANNOT be imported by a test").
//
// This test PROVES the guard using runtime evidence, not source text, wherever
// that is practical. It deliberately does NOT walk the whole lifecycle: that is
// P2-A5.
// ---------------------------------------------------------------------------

/** Count of TCP server handles the process currently owns. */
function listeningSocketCount(): number {
  // getActiveResourcesInfo is the supported API; the _getActiveHandles fallback
  // keeps this working on any runner that does not expose it.
  const info = (process as any).getActiveResourcesInfo?.();
  if (Array.isArray(info)) {
    return info.filter((r: string) => String(r).includes('TCPSERVERWRAP')).length;
  }
  const handles = (process as any)._getActiveHandles?.() ?? [];
  return handles.filter((h: any) => h && typeof h.address === 'function').length;
}

/** createApp installs Vite as middleware unless NODE_ENV === 'production'.
 *  For a boot-boundary test we want the deterministic, socket-free branch, so
 *  NODE_ENV is set only around the call and restored immediately. No production
 *  code path is modified — this just chooses which of the two EXISTING
 *  branches runs. */
async function buildRealApp(mod: any): Promise<any> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await mod.createApp();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

let realServer: any = null;
let realApp: any = null;

afterAll(() => {
  if (realServer) {
    try { realServer.close(); } catch { /* already closed */ }
    realServer = null;
  }
});

describe('P2-A4: importing server.ts must not boot the server', () => {
  it('opens no listening socket and does not run production startup', async () => {
    const before = listeningSocketCount();

    // Dynamic import INSIDE the test: a top-level import would already have run
    // before anything could be measured.
    const mod: any = await import('../server.ts');

    // The headline invariant.
    expect(listeningSocketCount()).toBe(before);

    // Under vitest argv[1] is the runner, never this module.
    expect(mod.isServerEntrypoint()).toBe(false);

    // The seam P2-A5 will use is genuinely exported and callable.
    expect(typeof mod.createApp).toBe('function');
    expect(typeof mod.startServer).toBe('function');
    expect(mod.createApp.constructor.name).toBe('AsyncFunction');
  });

  it('createApp() builds the real app and answers a real HTTP request', async () => {
    const mod: any = await import('../server.ts');
    const app = await buildRealApp(mod);

    // A real Express application with the real middleware surface.
    expect(typeof app).toBe('function');
    expect(typeof app.use).toBe('function');
    expect(typeof app.listen).toBe('function');
    expect(typeof app.post).toBe('function');

    // Open a socket OURSELVES, the same way customerClaimJourneyLink.test.ts
    // does. The module under test never opened one.
    realApp = app;
    realServer = await new Promise<any>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = realServer.address().port;
    expect(port).toBeGreaterThan(0);

    // A REAL request to a REAL unauthenticated, inline-registered route.
    const res = await fetch(`http://127.0.0.1:${port}/api/categories`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  }, 60000);

  it('serves the EXTRACTED route modules — the real ones, not stubs', async () => {
    const mod: any = await import('../server.ts');
    const app = await buildRealApp(mod);

    // A second independent construction must yield a distinct app object: one
    // app per createApp() call, and no module-level singleton that two callers
    // could accidentally share and double-register.
    expect(app).not.toBe(realApp);

    const srv = await new Promise<any>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      // GET /api/items/search is registered by routes/publicSearch.ts (P2-A2).
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/items/search`);
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }, 60000);

  it('production startup is still explicitly callable (not removed)', async () => {
    const mod: any = await import('../server.ts');
    // Shape only. We do NOT invoke it: doing so would listen and start the
    // sweeps, which is precisely what this batch makes opt-in.
    expect(typeof mod.startServer).toBe('function');
    expect(mod.startServer.constructor.name).toBe('AsyncFunction');
    expect(mod.startServer.length).toBe(0);
  });
});

describe('P2-A4: source-level guarantees', () => {
  it('the boot call is guarded and the app/listen split is in place', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
    // Count CODE occurrences only: several comments legitimately mention
    // "app.listen" and must not be mistaken for a second listen call.
    const code = src
      // Line comments FIRST, block comments second. server.ts has `//` comments
      // that mention globs ("/src/* sourcemap requests"); stripping block
      // comments first treats that as an opener and silently deletes tens of
      // thousands of characters of REAL code.
      .replace(/^\s*\/\/.*$/gm, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');

    // Exactly one listen call and exactly one Express app.
    expect(code.match(/app\.listen\(/g) || []).toHaveLength(1);
    expect(code.match(/const app = express\(\);/g) || []).toHaveLength(1);

    // The secret assertions must NOT run at import any more: every "FATAL:"
    // throw now lives inside assertBootSecrets, so it can only be reached from
    // the boot path.
    const secretFnAt = code.indexOf('function assertBootSecrets()');
    expect(secretFnAt).toBeGreaterThan(-1);
    expect(code.slice(0, secretFnAt).includes("throw new Error('FATAL:")).toBe(false);
    // ...and startServer really calls it, before the schema migration.
    expect(code.indexOf('assertBootSecrets();')).toBeGreaterThan(-1);
    expect(code.indexOf('assertBootSecrets();'))
      .toBeLessThan(code.indexOf('await ensureSchemaUpToDate(pool);'));

    // startServer delegates construction rather than duplicating it.
    expect(code).toContain('const app = await createApp();');
    expect(code).toContain('async function createApp() {');

    // The boot call sits behind the entrypoint guard.
    expect(code).toContain('if (isServerEntrypoint()) {');
    expect(code.indexOf('if (isServerEntrypoint()) {'))
      .toBeLessThan(code.indexOf('startServer().catch('));
  });
});
