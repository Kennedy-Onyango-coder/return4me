import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  planPageRequest,
  INDEXABLE_PAGE_PATHS,
  NOINDEX_PAGE_PATHS,
  TOKEN_BEARING_PAGE_PATHS,
} from '../utils/publicRoutes';
import { SITE_ORIGIN, NOINDEX_ROBOTS_DIRECTIVE } from '../utils/seoHead';

// ===========================================================================
// BATCH 1 / P2 — THE PRODUCTION HTML PATH, OVER REAL HTTP.
//
// This file mounts the REAL `createApp()` from src/server.ts under
// NODE_ENV=production (so the express.static branch, not Vite), on an ephemeral
// socket, and asks it the questions the batch changes the answers to:
//   * a public page is indexable and carries ITS OWN canonical;
//   * a private page is noindex in the header AND in the document;
//   * an activation URL is not redirected and never carries its token into a
//     canonical, a Location header or the document;
//   * an unknown path is a real 404, not the homepage shell with a 200;
//   * an unmatched /api route is JSON, not the SPA shell;
//   * HEAD answers with the status and headers of GET and no body;
//   * real static files are still served by express.static, and the /src
//     middleware is untouched.
//
// THE BUILT ARTIFACT IS READ, NEVER PRODUCED. dist/index.html is the same file
// the production server serves; this test only reads it and SKIPS the
// assertions that need it when it is absent (reported as a skip, never as a
// pass). Nothing is written to index.html or dist/index.html.
//
// `redirect: 'manual'` is used everywhere, because the whole point of several
// assertions is to observe the STATUS and the Location header rather than have
// fetch follow them.
// ===========================================================================

const DIST_INDEX = path.join(process.cwd(), 'dist', 'index.html');
const distReady = fs.existsSync(DIST_INDEX);
const distTemplate = distReady ? fs.readFileSync(DIST_INDEX, 'utf8') : '';
const distHeadMarkersPresent =
  distTemplate.includes('<meta name="robots"') && distTemplate.includes('rel="canonical"');

// Paths are taken from the planner's OWN exported lists, so this file cannot
// disagree with P1 about which page is which kind.
const INDEXABLE_PAGE = INDEXABLE_PAGE_PATHS.filter((p) => p !== '/')[0];
const PRIVATE_PAGE = NOINDEX_PAGE_PATHS.filter((p) => TOKEN_BEARING_PAGE_PATHS.indexOf(p) === -1)[0];
const ACTIVATION_PAGE = TOKEN_BEARING_PAGE_PATHS[0];
const ITEM_ID = 'R4M-123ABC';
const ACTIVATION_TOKEN = 'p2-integration-token-9f3c1d';

let server: any = null;
let base = '';

// Imported at MODULE scope, with NODE_ENV still whatever the runner set ('test'),
// exactly as src/__tests__/lifecycleHttpE2E.test.ts does. The database pool is
// created at import time and REFUSES a placeholder DATABASE_URL once NODE_ENV is
// already 'production' (src/db/index.ts), so the switch to 'production' has to
// happen around the createApp() CALL, not around the import. createApp() reads
// NODE_ENV when it runs, which is what selects the express.static branch.
const { createApp } = await import('../server.ts');

type Probe = { status: number; headers: Headers; body: string; location: string | null };

/** One request, redirects NOT followed, body always read. */
async function probe(urlPath: string, init: RequestInit = {}): Promise<Probe> {
  const res = await fetch(base + urlPath, { redirect: 'manual', ...init });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body, location: res.headers.get('location') };
}

beforeAll(async () => {
  // 'production' selects createApp()'s deterministic express.static branch
  // instead of booting a Vite dev server. Restored immediately; no production
  // code path is altered.
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const app = await createApp();
    server = await new Promise<any>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});


describe.skipIf(!distReady)('P2 integration: pages served from the built shell', () => {
  it.skipIf(!distHeadMarkersPresent)('serves an indexable public page with its OWN canonical and index, follow', async () => {
    const res = await probe(INDEXABLE_PAGE);
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/html');

    const canonical = `<link rel="canonical" href="${SITE_ORIGIN}${INDEXABLE_PAGE}" />`;
    expect(res.body).toContain(canonical);
    expect(res.body).toContain('<meta name="robots" content="index, follow" />');
    expect(canonical).not.toContain('?');

    // A public page is indexable in the document itself. P2 deliberately does
    // NOT emit a global `X-Robots-Tag: index, follow` header: a blanket header
    // would override every private page's correct directive.
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });

  it.skipIf(!distHeadMarkersPresent)('serves a private page noindex in the HEADER and the document', async () => {
    const res = await probe(PRIVATE_PAGE);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe(NOINDEX_ROBOTS_DIRECTIVE);
    expect(res.body).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(res.body).toContain(`<link rel="canonical" href="${SITE_ORIGIN}${PRIVATE_PAGE}" />`);
    // The homepage's index,follow must not survive for a private page.
    expect(res.body).not.toContain('index, follow');
  });

  it.skipIf(!distHeadMarkersPresent)('does not redirect an activation URL and never leaks its token', async () => {
    // The planner's own contract, asserted here as well: a token-bearing page is
    // a PAGE, never a redirect plan.
    expect(planPageRequest(ACTIVATION_PAGE, `?token=${ACTIVATION_TOKEN}`)).toEqual({
      kind: 'page',
      canonicalPath: ACTIVATION_PAGE,
      noindex: true,
    });

    const res = await probe(`${ACTIVATION_PAGE}?token=${ACTIVATION_TOKEN}`);

    // No redirect: the incoming URL and its query reach the page intact.
    expect(res.status).toBe(200);
    expect(res.location).toBeNull();

    // And the credential is nowhere in the response or in the canonical.
    expect(res.body).not.toContain(ACTIVATION_TOKEN);
    expect(res.body).not.toContain('token=');
    expect(res.body).toContain(`<link rel="canonical" href="${SITE_ORIGIN}${ACTIVATION_PAGE}" />`);

    // Activation pages are never indexable.
    expect(res.headers.get('x-robots-tag')).toBe(NOINDEX_ROBOTS_DIRECTIVE);
    expect(res.body).toContain('<meta name="robots" content="noindex, nofollow" />');
  });

  it.skipIf(!distHeadMarkersPresent)('serves a well-formed item route as 200 noindex, without a database lookup', async () => {
    // ITEM_ID is a fabricated id that exists in no table: the catch-all
    // classifies the URL from its SHAPE alone, so the page is served with no
    // lookup at all. That is P1's fail-closed item policy (ITEM_PAGES_NOINDEX).
    const res = await probe(`/item/${ITEM_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<div id="root"></div>');
    expect(res.body).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/item/${ITEM_ID}" />`);
    expect(res.headers.get('x-robots-tag')).toBe(NOINDEX_ROBOTS_DIRECTIVE);
    expect(res.body).toContain('<meta name="robots" content="noindex, nofollow" />');
  });

  it('normalises an allowlisted path using the planner status and location', async () => {
    // Case is normalised, so the Location is the planner's canonical path and
    // never the request's own text.
    const cased = await probe('/Lost');
    expect(cased.status).toBe(301);
    expect(cased.location).toBe('/lost');
    expect(String(cased.location)).not.toContain('?');

    // A trailing slash on an item URL is normalised the same way, with the id
    // carried through byte for byte.
    const slashed = await probe(`/item/${ITEM_ID}/`);
    expect(slashed.status).toBe(301);
    expect(slashed.location).toBe(`/item/${ITEM_ID}`);
  });

  it('does not follow a redirect plan for a non-GET method', async () => {
    // Only GET/HEAD may be redirected (the planner leaves that rule to the
    // caller), so a POST must never receive a 301 whose Location a caller could
    // be made to re-issue.
    const res = await probe('/Lost', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.location).toBeNull();
  });

  it('answers an unknown extensionless path with a real 404, not the homepage shell', async () => {
    const res = await probe('/lostt');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-robots-tag')).toBe(NOINDEX_ROBOTS_DIRECTIVE);
    expect(res.body).toContain('Page not found');
    // NOT the SPA shell: no root element, no canonical, and no reflection of the
    // requested path.
    expect(res.body).not.toContain('id="root"');
    expect(res.body).not.toContain('rel="canonical"');
    expect(res.body).not.toContain('/lostt');
    expect(res.body).not.toContain('index, follow');

    // A mistyped PRIVATE path is a 404 too - it is not silently a 200 page.
    const typo = await probe('/consolex');
    expect(typo.status).toBe(404);
    expect(typo.headers.get('x-robots-tag')).toBe(NOINDEX_ROBOTS_DIRECTIVE);
  });

  it('answers HEAD with the status and headers of GET and no body', async () => {
    const privatePage = await probe(PRIVATE_PAGE, { method: 'HEAD' });
    expect(privatePage.status).toBe(200);
    expect(privatePage.headers.get('x-robots-tag')).toBe(NOINDEX_ROBOTS_DIRECTIVE);
    expect(privatePage.body).toBe('');
    // The length of the document a GET would have sent is still declared.
    expect(Number(privatePage.headers.get('content-length'))).toBeGreaterThan(0);

    const unknown = await probe('/lostt', { method: 'HEAD' });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('x-robots-tag')).toBe(NOINDEX_ROBOTS_DIRECTIVE);
    expect(unknown.body).toBe('');

    const redirecting = await probe('/Lost', { method: 'HEAD' });
    expect(redirecting.status).toBe(301);
    expect(redirecting.location).toBe('/lost');
    expect(redirecting.body).toBe('');
  });
});

describe('P2 integration: the /api terminator and the static boundary', () => {
  it('answers an unmatched /api route with JSON 404, not the SPA shell', async () => {
    const res = await probe('/api/p2-no-such-endpoint-9f3c');
    expect(res.status).toBe(404);
    expect(String(res.headers.get('content-type'))).toContain('application/json');
    const json = JSON.parse(res.body);
    expect(typeof json.error).toBe('string');
    // What it must not be: a 200 HTML shell for a JSON endpoint, and it must not
    // echo the requested path back.
    expect(res.body).not.toContain('<html');
    expect(res.body).not.toContain('id="root"');
    expect(res.body).not.toContain('p2-no-such-endpoint-9f3c');
  });

  it('answers an unmatched /api route for a non-GET method as JSON too', async () => {
    const res = await probe('/api/p2-no-such-endpoint-9f3c', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(String(res.headers.get('content-type'))).toContain('application/json');
  });

  it('leaves every REGISTERED /api endpoint exactly as it was', async () => {
    // The terminator sits AFTER every registration, so a real endpoint is
    // untouched by it.
    const res = await probe('/api/categories');
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('application/json');
  });

  it('still serves real static files through express.static', async () => {
    const robots = await probe('/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.body).toContain('Sitemap: https://return4me.co.ke/sitemap.xml');
    // express.static serves these before the planner is ever consulted.
    expect(robots.headers.get('x-robots-tag')).toBeNull();

    const manifest = await probe('/manifest.json');
    expect(manifest.status).toBe(200);
    expect(JSON.parse(manifest.body)).toBeTruthy();

    const asset = await probe('/assets/favicon.ico');
    expect(asset.status).toBe(200);
    expect(Number(asset.headers.get('content-length'))).toBeGreaterThan(0);
  });

  it('keeps the existing guard for a missing file that has an extension', async () => {
    const res = await probe('/p2-definitely-missing.png');
    expect(res.status).toBe(404);
    expect(res.body).toBe('Not Found');
  });

  it('does not put the planner in front of the /src middleware', async () => {
    // The /src sourcemap branch answers before the catch-all, so the planner
    // never sees it and no canonical is involved. The batch leaves this path
    // exactly as it found it.
    const res = await probe('/src/main.tsx');
    expect(String(res.headers.get('content-type'))).toContain('javascript');
    expect(res.body).not.toContain('rel="canonical"');
  });
});

describe('P2 integration: the legacy ?claim= homepage link', () => {
  it('is a redirect plan in the planner, but express.static answers the URL first', async () => {
    // P1 translates the already-published https://return4me.co.ke/?claim=<id>
    // link into a 301 to /item/<id>.
    expect(planPageRequest('/', `?claim=${ITEM_ID}`)).toEqual({
      kind: 'redirect',
      status: 301,
      location: `/item/${ITEM_ID}`,
    });

    // MEASURED, not assumed: express.static is registered BEFORE the catch-all
    // and resolves '/' to dist/index.html, so '/?claim=<id>' is answered by the
    // shell and the planner never sees it — the redirect plan above is therefore
    // unreachable for this one URL. The SPA keeps handling ?claim= as it does
    // today; making the planner authoritative here would mean changing the
    // static handler's index behaviour, which this batch does not do.
    const res = await probe(`/?claim=${ITEM_ID}`);
    expect(res.status).toBe(200);
    expect(res.location).toBeNull();
    expect(String(res.headers.get('content-type'))).toContain('text/html');

    // The property that must hold regardless of which layer answers: the query
    // string never reaches the canonical URL.
    expect(res.body).toContain('<link rel="canonical" href="https://return4me.co.ke/" />');
    expect(res.body).not.toContain('?claim');
  });
});
