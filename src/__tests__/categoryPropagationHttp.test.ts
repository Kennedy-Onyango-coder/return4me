import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { db } from '../db/database';
import { testRunId } from '../db/__tests__/ensureTestCategory';
import { generateToken } from '../services/auth';
import { registerPublicCategoryRoutes, registerAdminCategoryRoutes } from '../routes/categories';

// ===========================================================================
// PHASE 16.1 BATCH 1A — ADMIN-CREATED CATEGORY → PUBLIC CATEGORY PROPAGATION
// ===========================================================================
// The forensic audit found that an administrator-created category was persisted
// correctly but did not reach the already-mounted public surfaces: `App` fetched
// /api/categories once per mount, and the console's own refresh had no path back
// to App's state. This suite proves the SERVERSIDE half of the fixed chain over a
// REAL HTTP boundary:
//
//     POST /api/admin/categories -> persisted -> GET /api/categories returns it
//
// plus the two companion behaviours (inactive exclusion, and the
// is_admin_modified create-asymmetry fix). The CLIENT half — AdminView invoking
// the App refresh callback after a successful mutation, and AgentView reading the
// App-level list and re-requesting it through that same callback — is pinned at
// source level below, which is this repository's established convention where no
// DOM harness exists (see
// categoryArchitectureBatch1/2.test.ts, publicClueStyleConfig.test.ts).
//
// The category routes were extracted into routes/categories.ts (handler bodies
// moved VERBATIM) precisely so this file can mount the REAL handlers — the same
// reason routes/adminDisputes.ts exists. `authenticateJWT` is the real middleware
// (signed tokens minted with generateToken); `requireCurrentAdminSession` needs a
// live admin row and is therefore stubbed to `next()`, exactly as
// disputeWorkflow.test.ts does — the route's OWN inline role check is what the
// admin-role assertions exercise.
// ===========================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

let server: any;
let baseUrl = '';
let adminToken = '';

/** Unique-per-run ids so a persistent database cannot collide across runs. */
const PREFIX = `test-b1a-${testRunId}`;

async function api(method: string, p: string, token?: string, body?: any) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, text, json };
}

/** A valid create payload; callers override the field under test. */
function createPayload(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name_en: 'Batch 1A Propagation Fixture',
    name_sw: 'Jaribio la Uenezaji la Batch 1A',
    total_fee: 500,
    finder_share: 125,
    agent_share: 175,
    platform_share: 200,
    is_sensitive_document: false,
    ...overrides,
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerPublicCategoryRoutes(app, {
    // server.ts's sendServerError, non-production branch.
    sendServerError: (res: any, error: any, _context: string) =>
      res.status(500).json({ error: error?.message || String(error) }),
  });
  registerAdminCategoryRoutes(app, {
    requireCurrentAdminSession: (_req: any, _res: any, next: any) => next(),
    sendServerError: (res: any, error: any, _context: string) =>
      res.status(500).json({ error: error?.message || String(error) }),
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminToken = generateToken(
    { userId: `TEST-B1A-ADMIN-${testRunId}`, phone: '+254700000000', role: 'admin', username: 'b1a-admin' } as any,
    '1h',
  );
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// §10-A — create through the real admin route, read through the real public route
// ---------------------------------------------------------------------------
describe('10-A: a category created over HTTP is served by GET /api/categories', () => {
  const id = `${PREFIX}-propagate`;

  it('POST /api/admin/categories creates the category (HTTP 200)', async () => {
    const created = await api('POST', '/api/admin/categories', adminToken, createPayload(id));
    expect(created.status).toBe(200);
    expect(created.json?.success).toBe(true);
    expect(created.json?.category?.id).toBe(id);
  });

  it('GET /api/categories returns it — the propagation chain the audit found broken', async () => {
    const res = await api('GET', '/api/categories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);

    const served = res.json.find((c: any) => c.id === id);
    expect(served, 'the newly created ACTIVE category must be publicly listed').toBeDefined();
    expect(served.name_en).toBe('Batch 1A Propagation Fixture');
    expect(served.name_sw).toBe('Jaribio la Uenezaji la Batch 1A');
    expect(served.total_fee).toBe(500);
    expect(served.is_sensitive_document).toBe(false);
    expect(served.sort_order).toBeGreaterThan(0);
  });

  it('the public payload is still the explicit DTO whitelist — no internal field leaks', async () => {
    const res = await api('GET', '/api/categories');
    const served = res.json.find((c: any) => c.id === id);
    for (const internal of [
      'is_admin_modified', 'elevated_review', 'public_clue_style', 'is_active',
      'base_fee', 'complexity_fee', 'delay_fee', 'ceiling_percent',
      'finder_pct', 'agent_pct', 'platform_pct', 'finder_reward_cap',
      'is_canonical', 'item_count',
    ]) {
      expect(served, `${internal} must not be public`).not.toHaveProperty(internal);
    }
  });

  it('the create route still requires an admin token', async () => {
    const noToken = await api('POST', '/api/admin/categories', undefined, createPayload(`${PREFIX}-noauth`));
    expect([401, 403], 'an unauthenticated create must be refused').toContain(noToken.status);
    expect(await db.getCategory(`${PREFIX}-noauth`), 'and nothing may be persisted').toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §10-B — an inactive category is absent from the public list, but stays resolvable
// ---------------------------------------------------------------------------
describe('10-B: an inactive category is excluded from GET /api/categories and stays resolvable', () => {
  const id = `${PREFIX}-inactive`;

  it('creating with is_active:false succeeds but is NOT publicly listed', async () => {
    const created = await api('POST', '/api/admin/categories', adminToken, createPayload(id, { is_active: false }));
    expect(created.status).toBe(200);

    const res = await api('GET', '/api/categories');
    const ids = res.json.map((c: any) => c.id);
    expect(ids, 'a deactivated category must not be offered for new work').not.toContain(id);
  });

  it('the row still exists for historical/internal resolution', async () => {
    // The public list is active-only, but nothing is deleted: the record must still
    // resolve so items and lost reports that reference it keep working.
    const historic = await db.getCategory(id);
    expect(historic, 'deactivation must never remove the row').toBeDefined();
    expect(historic!.is_active).toBe(false);
    expect((await db.getCategories()).map((c) => c.id)).toContain(id);
  });

  it('reactivating it makes it publicly listed again — the boundary is the flag, not the row', async () => {
    await db.setCategoryActive(id, true);
    const res = await api('GET', '/api/categories');
    expect(res.json.map((c: any) => c.id)).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// §10-E — the is_admin_modified create-asymmetry fix
// ---------------------------------------------------------------------------
describe('10-E: POST /api/admin/categories persists is_admin_modified', () => {
  it('is_admin_modified: true is stored as true (it used to be silently dropped)', async () => {
    const id = `${PREFIX}-adminmod-true`;
    const res = await api('POST', '/api/admin/categories', adminToken, createPayload(id, { is_admin_modified: true }));
    expect(res.status).toBe(200);
    const stored = await db.getCategory(id);
    expect(stored?.is_admin_modified, 'an explicit admin override must survive creation').toBe(true);
  });

  it('an OMITTED is_admin_modified keeps the existing default (false)', async () => {
    const id = `${PREFIX}-adminmod-omitted`;
    const res = await api('POST', '/api/admin/categories', adminToken, createPayload(id));
    expect(res.status).toBe(200);
    const stored = await db.getCategory(id);
    expect(stored?.is_admin_modified, 'omitting the field must not change behaviour').toBe(false);
  });

  it('a non-boolean is treated as "not supplied" rather than coerced', async () => {
    const id = `${PREFIX}-adminmod-junk`;
    const res = await api('POST', '/api/admin/categories', adminToken, createPayload(id, { is_admin_modified: 'yes' }));
    expect(res.status).toBe(200);
    const stored = await db.getCategory(id);
    expect(stored?.is_admin_modified).toBe(false);
  });

  it('the PUT path is unchanged: it still honours the flag', async () => {
    // Regression guard for the asymmetry fix: bringing POST into line must not have
    // altered the update path (which is asserted here through the DB layer because
    // PUT is still inline in server.ts and cannot be mounted).
    const id = `${PREFIX}-adminmod-put`;
    await api('POST', '/api/admin/categories', adminToken, createPayload(id));
    expect((await db.getCategory(id))?.is_admin_modified).toBe(false);
    await db.updateCategory(id, { ...(createPayload(id) as any), is_admin_modified: true });
    expect((await db.getCategory(id))?.is_admin_modified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §10-C — AdminView notifies App after a SUCCESSFUL category mutation
// ---------------------------------------------------------------------------
// There is no DOM/component harness in this repository (no jsdom, no React Testing
// Library — see vitest.config.ts `environment: 'node'`), so the client wiring is
// pinned at source level, exactly as categoryArchitectureBatch1/2.test.ts,
// publicClueStyleConfig.test.ts and phase9PublicSurface.test.ts do for the same
// reason.
describe('10-C: the admin category mutation path invokes the App refresh callback', () => {
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const APP = stripComments(read('src/App.tsx'));
  const ADMIN_VIEW_RAW = read('src/components/AdminView.tsx');
  const ADMIN_VIEW = stripComments(ADMIN_VIEW_RAW);

  /** One handler: from its declaration to the next named one. */
  function handler(startAnchor: string, endAnchor: string): string {
    const start = ADMIN_VIEW.indexOf(startAnchor);
    expect(start, `${startAnchor} not found in AdminView.tsx`).toBeGreaterThan(-1);
    const end = ADMIN_VIEW.indexOf(endAnchor, start + startAnchor.length);
    expect(end, `${endAnchor} not found after ${startAnchor}`).toBeGreaterThan(start);
    return ADMIN_VIEW.slice(start, end);
  }

  it('AdminView declares and destructures the optional callback', () => {
    expect(ADMIN_VIEW_RAW).toContain('onCategoriesChanged?: () => void;');
    // Optional, so every existing render site keeps compiling unchanged.
    expect(ADMIN_VIEW).toContain('onCategoriesChanged }');
  });

  it('App defines a reusable fetchCategories and passes it to AdminView on BOTH render sites', () => {
    // A stable callback (not a mount-only inline function) is what makes the
    // refresh callable from AdminView at all.
    expect(APP).toMatch(/const fetchCategories = useCallback\(async \(attempt = 1\)/);
    const wired = APP.match(/onCategoriesChanged=\{fetchCategories\}/g) || [];
    expect(wired.length, 'both AdminView render sites must be wired').toBe(2);
  });

  it('every category mutation path calls the callback only AFTER success', () => {
    const paths: Array<[string, string, string]> = [
      ['create + update', 'const handleSaveCategory', 'const handleDeleteCategory'],
      ['delete', 'const handleDeleteCategory', 'const handleToggleCategoryActive'],
      ['activate/deactivate', 'const handleToggleCategoryActive', 'useEffect(() => {'],
    ];

    for (const [label, startAnchor, endAnchor] of paths) {
      const body = handler(startAnchor, endAnchor);
      const call = body.indexOf('onCategoriesChanged?.()');
      expect(call, `${label} must invoke onCategoriesChanged`).toBeGreaterThan(-1);

      // The call must sit AFTER the server-success gate and after the existing
      // success handling — never on the failure branch.
      const guard = body.indexOf('if (!res.ok)');
      expect(guard, `${label} must still check res.ok`).toBeGreaterThan(-1);
      expect(call, `${label} must call the callback only after res.ok`).toBeGreaterThan(guard);

      const localRefresh = body.indexOf('setCategories(catData)');
      expect(localRefresh, `${label} must keep its existing local refresh`).toBeGreaterThan(-1);
      expect(call, `${label} must call the callback after the existing success handling`)
        .toBeGreaterThan(localRefresh);
    }

    // Exactly three call sites — an unrelated admin operation must never trigger it.
    expect((ADMIN_VIEW.match(/onCategoriesChanged\?\.\(\)/g) || []).length).toBe(3);
  });

  it('the console keeps its own category state (no global store was introduced)', () => {
    expect(ADMIN_VIEW).toContain('const [categories, setCategories] = useState<any[]>([]);');
    // No Redux/Zustand/Context was added.
    expect(ADMIN_VIEW_RAW).not.toMatch(/createContext|useContext|zustand|redux/);
  });
});

// ---------------------------------------------------------------------------
// §10-D — AgentView re-syncs categories from App's single source
// ---------------------------------------------------------------------------
// PHASE 16.1 BATCH 3 (H-1 / M-6) — SUPERSEDES the original §10-D assertions.
//
// §10-D used to pin AgentView's OWN mount-only `fetch('/api/categories')`. That
// made AgentView a SECOND, independent owner of the category list: fetched once,
// never refreshed, so a category an administrator had just created was missing
// from the verification panel's selector and one they had just deactivated
// stayed selectable until a full page reload.
//
// App.fetchCategories (Batch 1A) is the single category source — already re-run
// after every successful admin mutation via AdminView's `onCategoriesChanged`.
// Batch 3 removed AgentView's duplicate owner and made it READ that state and
// re-request it through the SAME callback, so §10-D's freshness guarantee is
// preserved and tightened: the refresh happens at the moment of USE (opening the
// verification panel, the only place the selector is rendered) rather than
// blindly on entry, so the list the agent picks from is the catalogue as of that
// instant.
//
// There is no DOM harness here (vitest.config.ts `environment: 'node'`), so — as
// §10-C and categoryArchitectureBatch1/2.test.ts do — the wiring is pinned at
// source level. The assertions that matter run against `AGENT_VIEW` (comments
// stripped): the file still QUOTES the deleted duplicate fetch inside the comment
// documenting its removal, so a `toContain` on the raw text would keep passing
// while the live behaviour was gone.
// ---------------------------------------------------------------------------
describe('10-D: AgentView reads the App-level category source and refreshes it on use', () => {
  // Local copy of §10-C's helper, local for the same reason §10-C keeps its own:
  // each block isolates the exact source region it pins.
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const AGENT_VIEW_RAW = read('src/components/AgentView.tsx');
  const AGENT_VIEW = stripComments(AGENT_VIEW_RAW);
  // BATCH 4: the Hub JSX (including the verification selector) moved to
  // components/agent/AgentHub.tsx; the category STATE and the refresh callback
  // stayed in AgentView. Contracts that span the extraction are judged on the
  // composed surface, exactly as agentHubReliabilityBatch3.test.ts does.
  const AGENT_HUB = stripComments(read('src/components/agent/AgentHub.tsx'));
  const HUB_SURFACE = `${AGENT_VIEW}\n${AGENT_HUB}`;
  const APP = stripComments(read('src/App.tsx'));

  it('the private category fetch and its state are GONE — not merely bypassed', () => {
    // Comment-stripped on purpose: the removed code survives as documentation, and
    // a raw `toContain` on it would pass while the feature was missing.
    expect(AGENT_VIEW, 'AgentView must not fetch the category list itself')
      .not.toMatch(/fetch\('\/api\/categories'\)/);
    expect(AGENT_VIEW, 'no private category state may remain').not.toMatch(/const \[categories, setCategories\]/);
    expect(AGENT_VIEW, 'the old mount-only fetch effect must be gone')
      .not.toMatch(/useEffect\(\(\) => \{\s*fetch\(/);

    // The file still records WHY the duplicate was removed (traceability), and App
    // still owns the one definition AgentView now depends on.
    expect(AGENT_VIEW_RAW).toContain('mount-only fetch were REMOVED here.');
    expect(APP).toMatch(/const fetchCategories = useCallback\(async \(attempt = 1\)/);
  });

  it('AgentView takes the list as a prop and the App refresh callback as an optional prop', () => {
    expect(AGENT_VIEW_RAW).toContain('categories: any[];');
    expect(AGENT_VIEW_RAW).toContain('refreshCategories?: () => void;');
    // Optional, so any caller that only has data to pass keeps compiling.
    expect(AGENT_VIEW).toMatch(
      /export default function AgentView\(\{ lang, token, setToken, categories, refreshCategories \}: AgentViewProps\)/,
    );
  });

  it('the refresh runs through the EXISTING App callback, at the moment of use', () => {
    // `refreshCategories?.()` re-runs App.fetchCategories — the same function
    // AdminView receives as `onCategoriesChanged`. Exactly one call site, so no
    // extra category traffic was introduced.
    expect((AGENT_VIEW.match(/refreshCategories\?\.\(\)/g) || []).length).toBe(1);

    const open = AGENT_VIEW.indexOf('const openVerificationPanel = (item: any) => {');
    expect(open, 'openVerificationPanel not found in AgentView.tsx').toBeGreaterThan(-1);
    const call = AGENT_VIEW.indexOf('refreshCategories?.()', open);
    const panelOpens = AGENT_VIEW.indexOf('setVerifyingItemId(item.id)', open);
    expect(panelOpens, 'the panel must still open').toBeGreaterThan(open);
    // The refresh must precede the panel opening in the same tick — it may not be
    // moved behind a guard that can skip it.
    expect(call, 'the refresh must run when the panel opens').toBeLessThan(panelOpens);

    // The selector renders from the App-level prop, so it offers exactly the
    // catalogue the rest of the app sees. BATCH 4 moved that <select> into
    // AgentHub, which reads the list as `props.categories`; asserting the
    // composed surface AND the single occurrence keeps the "no second owner"
    // guarantee §10-D was written to protect.
    expect(AGENT_HUB).toContain('{props.categories.map((c: any) => (');
    expect((HUB_SURFACE.match(/categories\.map\(\(c: any\) => \(/g) || []).length).toBe(1);
    // …and AgentView is what hands the App-level list across to the Hub.
    expect(AGENT_VIEW).toContain('categories={categories}');
  });

  it('App passes the list and the refresh callback to BOTH AgentView render sites', () => {
    const sites = APP.match(/<AgentView[\s\S]*?\/>/g) || [];
    expect(sites.length, 'both AgentView render sites must be wired').toBe(2);
    for (const site of sites) {
      expect(site, 'each site must pass the App-level list').toContain('categories={categories}');
      expect(site, 'each site must pass the App-level refresh').toContain('refreshCategories={fetchCategories}');
    }
    // Exactly two call sites — no other component receives this callback.
    expect((APP.match(/refreshCategories=\{fetchCategories\}/g) || []).length).toBe(2);
  });

  it('App mounts AgentView conditionally per view/surface, so entry re-reads the App state', () => {
    // Both existing render sites are conditional — closed with the view switch.
    expect(APP).toMatch(/\{currentView === 'agent' && \(/);
    expect(APP).toMatch(/\{dashboardSurface === 'agent' && \(/);
  });

  it('no polling or timer was introduced for categories', () => {
    // The brief explicitly forbids a timer/poll for this: freshness comes from
    // re-entry and use, not from a background loop.
    expect(AGENT_VIEW_RAW, 'categories must not be polled').not.toMatch(/setInterval\([\s\S]{0,200}api\/categories/);
    expect(AGENT_VIEW, 'no timer may drive the category list').not.toMatch(/setInterval\(|setTimeout\(/);
  });
});
