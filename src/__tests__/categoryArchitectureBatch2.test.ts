import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { testRunId } from '../db/__tests__/ensureTestCategory';
import { toPublicCategoryView } from '../services/categoryPublicView';

// ===========================================================================
// PHASE 16.1 BATCH 2 — CATEGORY LIFECYCLE & CLASSIFICATION POLICY
// (CAT-02, CAT-04, CAT-06, CAT-09, CAT-14)
// ===========================================================================
// BEHAVIOURAL FIRST. Everything that can be exercised against the real
// DatabaseEngine is asserted by CALLING it. SOURCE assertions are used only
// where the runtime harness genuinely does not exist: server.ts builds the whole
// application and starts listeners at import time and exports nothing, so its
// inline routes cannot be mounted — the established convention of this
// repository (see regionsContract.test.ts, agentMutationOwnership.test.ts,
// categoryArchitectureBatch1.test.ts).
// ===========================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SERVER_RAW = read('src/server.ts');
const DATABASE_RAW = read('src/db/database.ts');
const LOST_REPORT_ROUTES_RAW = read('src/routes/lostReports.ts');

/** One inline route handler: from its registration to the next one. */
function routeBody(anchor: string): string {
  const start = SERVER_RAW.indexOf(anchor);
  expect(start, `${anchor} not found in server.ts`).toBeGreaterThan(-1);
  const rest = SERVER_RAW.slice(start);
  const next = rest.slice(1).search(/\n {2}app\.[a-z]+\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next + 1));
}

// PHASE 16.1 BATCH 1A — `GET /api/categories` and `POST /api/admin/categories`
// were extracted into routes/categories.ts (handler bodies moved VERBATIM) so the
// admin-create → public-read propagation chain can be exercised over real HTTP.
// Their anchors live in that module now; this slicer is kept separate from
// server.ts's so one route's body can never bleed into another's slice.
const CATEGORY_ROUTES_RAW = read('src/routes/categories.ts');

/** One inline route handler in routes/categories.ts. */
function categoryRouteBody(anchor: string): string {
  const start = CATEGORY_ROUTES_RAW.indexOf(anchor);
  expect(start, `${anchor} not found in routes/categories.ts`).toBeGreaterThan(-1);
  const rest = CATEGORY_ROUTES_RAW.slice(start);
  const next = rest.slice(1).search(/\n {2}app\.[a-z]+\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next + 1));
}

// The canonical seed is published once per process by the boot sync. Called at
// file scope exactly once (the mock query engine has no ON CONFLICT, and the
// sync is insert-only, so a single call is both sufficient and idempotent).
beforeAll(async () => {
  await db.syncDefaultCategories();
});

describe('CAT-02 — an administrator edit to a seeded category is durable across boots', () => {
  it('the boot sync no longer rewrites an existing row from the seed', async () => {
    const before = await db.getCategory('national-id');
    expect(before).toBeDefined();

    // An administrator renames and re-prices a SEEDED category.
    await db.updateCategory('national-id', {
      name_en: 'National ID Card (edited)',
      name_sw: 'Kitambulisho cha Kitaifa (kimehaririwa)',
      total_fee: 999,
      finder_share: 250,
      agent_share: 349,
      platform_share: 400,
      is_sensitive_document: before!.is_sensitive_document,
      is_admin_modified: before!.is_admin_modified,
    });

    // ...and the server is restarted: the sync runs again.
    await db.syncDefaultCategories();

    const after = await db.getCategory('national-id');
    expect(after?.name_en, 'a rename must survive a restart').toBe('National ID Card (edited)');
    expect(after?.name_sw, 'a Swahili rename must survive a restart').toBe('Kitambulisho cha Kitaifa (kimehaririwa)');
    expect(after?.total_fee, 'a re-price must survive a restart').toBe(999);
    expect(after?.finder_share).toBe(250);
    expect(after?.agent_share).toBe(349);
    expect(after?.platform_share).toBe(400);

    // Hermetic: hand the fixture back to its previous values so later tests in
    // this file are unaffected by the edit above.
    await db.updateCategory('national-id', {
      name_en: before!.name_en,
      name_sw: before!.name_sw,
      total_fee: before!.total_fee,
      finder_share: before!.finder_share,
      agent_share: before!.agent_share,
      platform_share: before!.platform_share,
      is_sensitive_document: before!.is_sensitive_document,
      is_admin_modified: before!.is_admin_modified,
    });
    // The restore itself must not be undone by a later boot either.
    await db.syncDefaultCategories();
    expect((await db.getCategory('national-id'))?.name_en).toBe(before!.name_en);
  });

  it('a deactivated seeded category STAYS deactivated across a restart', async () => {
    // The seed insert would otherwise bring it back active.
    await db.setCategoryActive('bicycle', false);
    await db.syncDefaultCategories();
    expect((await db.getCategory('bicycle'))?.is_active).toBe(false);
    await db.setCategoryActive('bicycle', true);
  });

  it('a genuinely MISSING seeded category is recreated from the seed defaults', async () => {
    const original = await db.getCategory('novel');
    expect(original).toBeDefined();

    await db.deleteCategory('novel');
    expect(await db.getCategory('novel'), 'fixture: the row must be gone first').toBeUndefined();

    await db.syncDefaultCategories();

    const restored = await db.getCategory('novel');
    expect(restored, 'a missing canonical category must be re-created').toBeDefined();
    expect(restored!.name_en).toBe(original!.name_en);
    expect(restored!.name_sw).toBe(original!.name_sw);
    expect(restored!.total_fee).toBe(original!.total_fee);
    expect(restored!.is_active).toBe(true);
  });

  it('an admin-created category is untouched by the sync', async () => {
    const id = `TEST-B2-CUSTOM-${testRunId}`;
    await db.createCategory({
      id,
      name_en: 'Batch 2 Custom Category',
      name_sw: 'Kategoria Maalum ya Batch 2',
      total_fee: 750,
      finder_share: 200,
      agent_share: 250,
      platform_share: 300,
      is_sensitive_document: false,
    });

    await db.syncDefaultCategories();

    const after = await db.getCategory(id);
    expect(after).toBeDefined();
    expect(after!.name_en).toBe('Batch 2 Custom Category');
    expect(after!.total_fee).toBe(750);
  });

  it('the seed is still the identity source, and identity is not a second list', async () => {
    // The canonical id set is derived from the seed array rather than from a
    // second array literal.
    expect(DATABASE_RAW).not.toMatch(/const\s+canonicalCategoryIds\s*=\s*\[/);
    expect(DATABASE_RAW).toContain('canonicalCategoryIds = new Set(list.map((cat) => cat.id))');
  });
});

describe('CAT-04 — first-class category lifecycle state', () => {
  const id = `TEST-B2-LIFECYCLE-${testRunId}`;

  beforeAll(async () => {
    await db.createCategory({
      id,
      name_en: 'Batch 2 Lifecycle Fixture',
      name_sw: 'Jaribio la Mzunguko wa Batch 2',
      total_fee: 500,
      finder_share: 125,
      agent_share: 175,
      platform_share: 200,
      is_sensitive_document: false,
    });
  });

  it('a newly created category is ACTIVE by default', async () => {
    const created = await db.getCategory(id);
    expect(created?.is_active).toBe(true);
  });

  it('can be DEACTIVATED and REACTIVATED without touching any other field', async () => {
    const before = await db.getCategory(id);

    const deactivated = await db.setCategoryActive(id, false);
    expect(deactivated?.is_active).toBe(false);

    const after = await db.getCategory(id);
    expect(after?.is_active).toBe(false);
    // Deactivation is a lifecycle change, never an edit.
    expect(after?.name_en).toBe(before!.name_en);
    expect(after?.name_sw).toBe(before!.name_sw);
    expect(after?.total_fee).toBe(before!.total_fee);
    expect(after?.finder_share).toBe(before!.finder_share);
    expect(after?.agent_share).toBe(before!.agent_share);
    expect(after?.platform_share).toBe(before!.platform_share);

    const reactivated = await db.setCategoryActive(id, true);
    expect(reactivated?.is_active).toBe(true);
  });

  it('an unknown id is reported as not found rather than silently succeeding', async () => {
    expect(await db.setCategoryActive(`TEST-B2-MISSING-${testRunId}`, false)).toBeUndefined();
  });

  it('an INACTIVE category is excluded from the selectable list but not from the complete one', async () => {
    await db.setCategoryActive(id, false);

    const selectable = await db.getActiveCategories();
    expect(selectable.map((c) => c.id), 'inactive categories must not be selectable').not.toContain(id);
    expect(selectable.every((c) => c.is_active), 'the selectable list must be active-only').toBe(true);
    // The complete list — used for historical resolution, admin, search and fee
    // lookups — still contains it.
    expect((await db.getCategories()).map((c) => c.id)).toContain(id);

    await db.setCategoryActive(id, true);
    expect((await db.getActiveCategories()).map((c) => c.id)).toContain(id);
  });

  it('historical records referencing an inactive category stay valid AND searchable', async () => {
    const itemId = `TEST-B2-HISTORY-${testRunId}`;
    await db.setCategoryActive(id, false);

    await db.createItem({
      id: itemId,
      category_id: id,
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'x',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000050',
      assigned_agent_id: null,
      status: 'at_agent',
      flaggedForReview: false,
      isDescriptionOnly: true,
      description: 'x',
      is_sensitive_document: false,
      rejection_reason: null,
    } as any);

    // The record itself is untouched by the category's lifecycle state...
    expect((await db.getItem(itemId))?.category_id).toBe(id);
    // ...it is still returned by the status-scoped query the public search uses...
    expect((await db.getItemsByStatus('at_agent')).map((i) => i.id)).toContain(itemId);
    // ...and its category still resolves, so the item can still be displayed.
    expect(await db.getCategory(id)).toBeDefined();

    await db.setCategoryActive(id, true);
  });

  it('an administrator can still retrieve and identify inactive categories', async () => {
    await db.setCategoryActive(id, false);

    const adminView = await db.getCategoriesWithUsage();
    const row = adminView.find((c) => c.id === id);
    expect(row, 'the admin list must include inactive categories').toBeDefined();
    expect(row!.is_active).toBe(false);
    expect(row!.is_canonical).toBe(false);
    // The admin payload keeps the operational fields the console edits.
    for (const field of ['base_fee', 'complexity_fee', 'delay_fee', 'ceiling_percent', 'finder_pct', 'agent_pct', 'platform_pct', 'finder_reward_cap', 'is_admin_modified', 'elevated_review', 'public_clue_style']) {
      expect(Object.keys(row!), `admin payload must still expose ${field}`).toContain(field);
    }

    await db.setCategoryActive(id, true);
  });

  it('every NEW-work boundary refuses an inactive category', () => {
    // The public list is active-only, which is what all four selectors read.
    expect(categoryRouteBody("app.get('/api/categories'")).toContain('db.getActiveCategories()');
    // Finder: a new found-item report.
    expect(routeBody("app.post('/api/items/report'")).toContain('await db.getActiveCategories()');
    // Agent: a new verification classification.
    expect(routeBody("app.post('/api/agents/verify-item'")).toContain('await db.getActiveCategories()');
    // Owner: a new lost report (the route module that owns it).
    expect(stripComments(LOST_REPORT_ROUTES_RAW)).toContain('const categories = await db.getActiveCategories();');
  });
});

describe('CAT-06 — a canonical category is retired by deactivation, never deleted', () => {
  it('the canonical id set is derived from the seed and distinguishes custom categories', () => {
    expect(db.isCanonicalCategoryId('national-id')).toBe(true);
    expect(db.isCanonicalCategoryId('other-item')).toBe(true);
    expect(db.isCanonicalCategoryId(`TEST-B2-CUSTOM-${testRunId}`)).toBe(false);
  });

  it('the DELETE route refuses a canonical category with a controlled 409, before any delete', () => {
    const body = routeBody("app.delete('/api/admin/categories/:id'");
    expect(body).toContain('db.isCanonicalCategoryId(id)');
    // Both 409s are controlled; neither is a database error.
    expect(body).toMatch(/res\.status\(409\)/);
    expect(body).not.toMatch(/res\.status\(500\)/);

    const canonicalGuard = body.indexOf('isCanonicalCategoryId(');
    const referenceGuard = body.indexOf('getCategoryReferenceCounts(');
    const del = body.indexOf('db.deleteCategory(');
    expect(canonicalGuard).toBeGreaterThan(-1);
    // The canonical guard comes first, then the (Batch 1) reference guard, and
    // only then the delete itself.
    expect(referenceGuard).toBeGreaterThan(canonicalGuard);
    expect(del).toBeGreaterThan(referenceGuard);
  });

  it('a canonical category is RETIRED by the lifecycle action and the row survives', async () => {
    await db.setCategoryActive('umbrella', false);

    const still = await db.getCategory('umbrella');
    expect(still, 'deactivation must never remove the row').toBeDefined();
    expect(still!.is_active).toBe(false);
    expect(db.isCanonicalCategoryId('umbrella')).toBe(true);

    await db.setCategoryActive('umbrella', true);
    expect((await db.getCategory('umbrella'))?.is_active).toBe(true);
  });

  it('a custom, UNREFERENCED category can still be physically deleted', async () => {
    const id = `TEST-B2-DELETABLE-${testRunId}`;
    await db.createCategory({
      id,
      name_en: 'Batch 2 Deletable',
      name_sw: 'Inayoweza Kufutwa ya Batch 2',
      total_fee: 500,
      finder_share: 125,
      agent_share: 175,
      platform_share: 200,
      is_sensitive_document: false,
    });

    expect(db.isCanonicalCategoryId(id)).toBe(false);
    expect((await db.getCategoryReferenceCounts(id)).total).toBe(0);

    await db.deleteCategory(id);
    expect(await db.getCategory(id)).toBeUndefined();
  });

  it('a custom category that IS referenced stays protected by the CAT-05 guard', async () => {
    const id = `TEST-B2-REFERENCED-${testRunId}`;
    await db.createCategory({
      id,
      name_en: 'Batch 2 Referenced',
      name_sw: 'Inayotumika ya Batch 2',
      total_fee: 500,
      finder_share: 125,
      agent_share: 175,
      platform_share: 200,
      is_sensitive_document: false,
    });

    await db.createItem({
      id: `TEST-B2-ITEM-${testRunId}`,
      category_id: id,
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'x',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000051',
      assigned_agent_id: null,
      status: 'at_agent',
      flaggedForReview: false,
      isDescriptionOnly: true,
      description: 'x',
      is_sensitive_document: false,
      rejection_reason: null,
    } as any);

    const counts = await db.getCategoryReferenceCounts(id);
    expect(counts.items).toBe(1);
    expect(counts.total).toBeGreaterThan(0);

    // ...and the route turns that count into a controlled conflict.
    expect(routeBody("app.delete('/api/admin/categories/:id'")).toMatch(/references\.total > 0/);
  });
});

describe('CAT-09 — the public endpoint exposes no internal operating configuration', () => {
  const INTERNAL_FIELDS = [
    'is_admin_modified', 'elevated_review', 'public_clue_style',
    'base_fee', 'complexity_fee', 'delay_fee', 'ceiling_percent',
    'finder_pct', 'agent_pct', 'platform_pct', 'finder_reward_cap', 'is_active',
  ];

  it('the public DTO is an explicit whitelist of the fields the public UX reads', () => {
    const view = toPublicCategoryView({
      id: 'national-id',
      name_en: 'National ID Card',
      name_sw: 'Kitambulisho cha Kitaifa',
      total_fee: 400, finder_share: 160, agent_share: 128, platform_share: 112,
      is_sensitive_document: true, sort_order: 1, is_active: true,
      is_admin_modified: true, elevated_review: true, public_clue_style: 'national_id',
      base_fee: 280, complexity_fee: 100, delay_fee: 20, ceiling_percent: 12,
      finder_pct: 25, agent_pct: 35, platform_pct: 40, finder_reward_cap: 5000,
    });

    expect(Object.keys(view!).sort()).toEqual([
      'agent_share', 'finder_share', 'id', 'is_sensitive_document',
      'name_en', 'name_sw', 'platform_share', 'sort_order', 'total_fee',
    ]);
  });

  it('no internal operating field survives the DTO', () => {
    const view: any = toPublicCategoryView({
      id: 'x', name_en: 'a', name_sw: 'b', total_fee: 1, finder_share: 0, agent_share: 0, platform_share: 1,
      is_admin_modified: true, elevated_review: true, public_clue_style: 'none',
      base_fee: 1, complexity_fee: 1, delay_fee: 1, ceiling_percent: 12,
      finder_pct: 25, agent_pct: 35, platform_pct: 40, finder_reward_cap: 9, is_active: false,
    });
    for (const internal of INTERNAL_FIELDS) {
      expect(view, `${internal} must not be public`).not.toHaveProperty(internal);
    }
  });

  it('the published price IS public (the Owner fee breakdown depends on it)', () => {
    const view = toPublicCategoryView({ id: 'x', name_en: 'a', name_sw: 'b', total_fee: 700, finder_share: 280, agent_share: 224, platform_share: 196 })!;
    expect(view.total_fee).toBe(700);
    expect(view.finder_share).toBe(280);
    expect(view.agent_share).toBe(224);
    expect(view.platform_share).toBe(196);
  });

  it('fails closed on a missing sensitivity flag (a document is never treated as generic)', () => {
    expect(toPublicCategoryView({ id: 'x', name_en: 'a', name_sw: 'b' })!.is_sensitive_document).toBe(true);
  });

  it('the PUBLIC route uses the DTO; the ADMIN route does not', () => {
    expect(categoryRouteBody("app.get('/api/categories'")).toContain('toPublicCategoryView');

    const adminGet = routeBody("app.get('/api/admin/categories'");
    expect(adminGet).toContain('getCategoriesWithUsage');
    expect(adminGet, 'the admin console must keep the complete record').not.toContain('toPublicCategoryView');
  });

  it('the admin enumeration still carries every operational field', async () => {
    const row = (await db.getCategoriesWithUsage()).find((c) => c.id === 'national-id');
    expect(row).toBeDefined();
    for (const field of INTERNAL_FIELDS.filter((f) => f !== 'is_active')) {
      expect(Object.keys(row!), `admin payload must expose ${field}`).toContain(field);
    }
    expect(Object.keys(row!)).toContain('is_active');
  });
});

describe('CAT-14 — verification keeps the reported category and the verified one distinct', () => {
  const RUN = testRunId;
  const REPORTED = `TEST-B2-REPORTED-${RUN}`;
  const VERIFIED = `TEST-B2-VERIFIED-${RUN}`;
  const AGENT_ID = `TEST-B2-AGENT-${RUN}`;

  beforeAll(async () => {
    for (const id of [REPORTED, VERIFIED]) {
      await db.createCategory({
        id,
        name_en: `Batch 2 ${id}`,
        name_sw: `Batch 2 ${id}`,
        total_fee: 500,
        finder_share: 125,
        agent_share: 175,
        platform_share: 200,
        is_sensitive_document: false,
      });
    }
    // item_verification_changes.agent_id has a real FK to agents(id); the mock
    // does not enforce it.
    await db.createAgent({
      id: AGENT_ID,
      business_name: 'Batch 2 Verification Agent',
      contact_phone: `+254${RUN}3`,
      location_address: 'Test Location',
      latitude: null,
      longitude: null,
      mpesa_till_or_paybill: '123456',
      payout_method_type: 'Till Number',
      status: 'active',
      refundable_deposit: 0,
      national_id_hash: 'test-hash-b2-cat14',
      needs_manual_geocoding: false,
    } as any);
  });

  it('the reported category is PRESERVED and the verified one is recorded separately', async () => {
    const itemId = `TEST-B2-CAT14-ITEM-${RUN}`;
    await db.createItem({
      id: itemId,
      category_id: REPORTED,
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'x',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000052',
      assigned_agent_id: null,
      status: 'awaiting_dropoff',
      flaggedForReview: false,
      isDescriptionOnly: true,
      description: 'Black item',
      is_sensitive_document: false,
      rejection_reason: null,
    } as any);

    const result = await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: VERIFIED, name: null, document_number: null, description: 'Black item', found_area: 'x' },
      'Wrong category',
      null,
      true,
    );
    expect(result.success).toBe(true);

    const item = await db.getItem(itemId);
    expect(item?.category_id, 'the REPORTED category must not be overwritten').toBe(REPORTED);
    expect(item?.verified_category_id, "the agent's classification is recorded here").toBe(VERIFIED);
    expect(item?.verification_status).toBe('corrected');

    // The correction is still fully auditable, including the value it replaced.
    const changes = await db.getItemVerificationChanges(itemId);
    const categoryChange = changes.find((c) => c.field_name === 'category_id');
    expect(categoryChange?.original_value).toBe(REPORTED);
    expect(categoryChange?.verified_value).toBe(VERIFIED);
  });

  it('the verification write never sets items.category_id', () => {
    const start = DATABASE_RAW.indexOf('public async recordItemVerification(');
    expect(start).toBeGreaterThan(-1);
    const end = DATABASE_RAW.indexOf('public async getItemVerificationChanges(', start);
    expect(end).toBeGreaterThan(start);
    const body = stripComments(DATABASE_RAW.slice(start, end));
    // Only the verified column is written. The lookbehind keeps the assertion
    // from matching the `verified_category_id:` line itself.
    expect(body).toMatch(/verified_category_id: newValues\.category_id/);
    expect(body, 'the reported category must never be overwritten').not.toMatch(/(?<!verified_)category_id: newValues\.category_id/);
  });

  // -------------------------------------------------------------------------
  // S5 (Phase 16.1 S1–S6 remediation batch) — VERIFICATION IMMUTABILITY
  // TRIPWIRE.
  //
  // The intended invariant, asserted structurally rather than by trusting a
  // comment:
  //     category_id             -> PRESERVED (never written here)
  //     verified_category_id    -> UPDATED
  //     locked_total_fee        -> PRESERVED
  //     locked_finder_share     -> PRESERVED
  //     locked_agent_share      -> PRESERVED
  //     locked_platform_share   -> PRESERVED
  //
  // This is deliberately exact-set: adding a column to the verification update
  // is a financial/identity decision, so the test forces that decision to be
  // made consciously instead of slipping in. See the F-3/F-4 forensic audit.
  // -------------------------------------------------------------------------
  it('the verification write never touches any locked financial field', () => {
    const start = DATABASE_RAW.indexOf('public async recordItemVerification(');
    expect(start).toBeGreaterThan(-1);
    const end = DATABASE_RAW.indexOf('public async getItemVerificationChanges(', start);
    expect(end).toBeGreaterThan(start);
    const body = stripComments(DATABASE_RAW.slice(start, end));

    // None of the item's locked money values may be written by an Agent
    // correction: verification is a classification/evidence step, never a
    // financial one, and the locked figures are what every money path charges.
    for (const locked of ['locked_total_fee', 'locked_finder_share', 'locked_agent_share', 'locked_platform_share']) {
      expect(body, `recordItemVerification must not reference ${locked}`).not.toContain(locked);
    }

    // The update writes exactly these columns — nothing else.
    const updateStart = body.indexOf('tx.update(itemsTable).set(');
    expect(updateStart, 'the items update was not found').toBeGreaterThan(-1);
    const updateEnd = body.indexOf('}).where(', updateStart);
    expect(updateEnd, 'the end of the items update was not found').toBeGreaterThan(updateStart);
    const updateBody = body.slice(updateStart, updateEnd);

    const assignedColumns = Array.from(updateBody.matchAll(/^\s*([a-z_]+):/gm)).map((m) => m[1]).sort();
    expect(assignedColumns).toEqual([
      'physically_verified_at',
      'verification_status',
      'verified_category_id',
      'verified_description',
      'verified_document_number',
      'verified_found_area',
      'verified_name',
    ]);
  });
});

describe('authorization — category lifecycle mutations are admin-only', () => {
  // PHASE 16.1 BATCH 1A — `app.post('/api/admin/categories'` was extracted into
  // routes/categories.ts (so the create → public-read chain can be exercised over
  // real HTTP) and is asserted separately below against that module. The other
  // three lifecycle routes are still inline in server.ts.
  const MUTATION_ROUTES = [
    "app.put('/api/admin/categories/:id/active'",
    "app.delete('/api/admin/categories/:id'",
    "app.put('/api/admin/categories/:id'",
  ];

  for (const anchor of MUTATION_ROUTES) {
    it(`${anchor.split("'")[1]} keeps the full admin authorization stack`, () => {
      const body = routeBody(anchor);
      expect(body).toContain('authenticateJWT');
      expect(body).toContain('requireCurrentAdminSession');
      expect(body).toContain("req.user?.role !== 'admin'");
      expect(body).toMatch(/res\.status\(403\)/);
    });
  }

  it("POST /api/admin/categories keeps the full admin authorization stack", () => {
    // Same assertions as the loop above, against the extracted module. The route
    // is ALSO inside adminRouteAudit.test.ts's scope (routes/categories.ts is in
    // its source list), so its inline role check is doubly covered.
    const body = categoryRouteBody("app.post('/api/admin/categories'");
    expect(body).toContain('authenticateJWT');
    expect(body).toContain('requireCurrentAdminSession');
    expect(body).toContain("req.user?.role !== 'admin'");
    expect(body).toMatch(/res\.status\(403\)/);
  });

  it('the lifecycle action validates its input and is audited', () => {
    const body = routeBody("app.put('/api/admin/categories/:id/active'");
    expect(body).toContain("typeof is_active !== 'boolean'");
    expect(body).toMatch(/res\.status\(400\)/);
    expect(body).toContain("'CATEGORY_ACTIVATED'");
    expect(body).toContain("'CATEGORY_DEACTIVATED'");
    expect(body).toContain('db.setCategoryActive(id, is_active)');
  });

  it('the lifecycle route is INSIDE the repository admin-route security audit', () => {
    // adminRouteAudit.test.ts enumerates /api/admin routes with the verbs
    // get|post|put|delete and asserts each keeps an inline role check. A new
    // admin mutation must not use a verb that scan cannot see, or it would sit
    // permanently outside that audit.
    expect(SERVER_RAW).toMatch(/app\.put\('\/api\/admin\/categories\/:id\/active',\s*authenticateJWT,/);
    expect(SERVER_RAW).not.toContain("app.patch('/api/admin/categories/:id/active'");
  });

  it('the client only ever hides what the server already refuses (no client-side authority)', () => {
    const adminView = stripComments(read('src/components/AdminView.tsx'));
    // The console sends the lifecycle change to the API. The component builds the
    // URL as a TEMPLATE LITERAL — fetch(`/api/admin/categories/${id}/active`) — so
    // the assertion is made on that exact literal text (and the request method)
    // rather than on a quote style the source does not use. This still pins the
    // lifecycle ENDPOINT itself; it is not a search for the word "active"
    // anywhere in the file.
    expect(adminView).toContain('/api/admin/categories/${id}/active');
    expect(adminView).toMatch(/fetch\(`\/api\/admin\/categories\/\$\{id\}\/active`/);
    expect(adminView).toContain("method: 'PUT'");
    expect(adminView).toContain('body: JSON.stringify({ is_active: nextActive })');
    // ...and the Finder/Owner/Agent selectors read the server's active-only list
    // rather than filtering locally.
    for (const file of ['src/components/FinderView.tsx', 'src/components/AgentView.tsx']) {
      expect(stripComments(read(file)), `${file} must not filter on is_active itself`).not.toContain('is_active');
    }
  });
});
