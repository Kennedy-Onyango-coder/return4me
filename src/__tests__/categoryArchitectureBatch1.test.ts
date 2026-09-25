import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { testRunId } from '../db/__tests__/ensureTestCategory';
import { verificationProfiles } from '../config/verificationProfiles';
import { groupedCategoryIds } from '../config/categoryTaxonomy';
// PHASE 16.1 BATCH 2 (CAT-09) / F-6 — the PUBLIC category transform. The
// GET /api/categories contract below is asserted through the REAL public
// transform rather than against the internal `db.getCategories()` rows, so a
// future change to the public mapping can no longer pass unnoticed.
import { toPublicCategoryView } from '../services/categoryPublicView';

// ===========================================================================
// PHASE 16.1 BATCH 1 — CATEGORY ARCHITECTURE (CAT-03, CAT-05, CAT-08)
// ===========================================================================
// BEHAVIOURAL FIRST. Everything below that CAN be exercised at runtime against
// the real DatabaseEngine is asserted by CALLING it (ordering, uniqueness, the
// 46-id baseline, reference counts, create/update/delete). SOURCE assertions are
// used ONLY where the runtime harness genuinely does not exist: server.ts
// constructs the whole app and starts listeners at import time and exports
// nothing, so its inline routes cannot be mounted — the established convention
// of this repository (see regionsContract.test.ts, foundItemCounty.test.ts,
// agentMutationOwnership.test.ts, publicClueStyleConfig.test.ts).
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

// PHASE 16.1 BATCH 1A — `GET /api/categories` and `POST /api/admin/categories`
// were extracted into routes/categories.ts (handler bodies moved VERBATIM) so the
// admin-create → public-read propagation chain can be exercised over real HTTP.
// Their anchors therefore live in that module now; every other anchor asserted by
// this file still lives in server.ts, which is why the slicer is separate rather
// than a combined source (a combined source could let one route's body bleed into
// another's slice and quietly weaken an assertion).
const CATEGORY_ROUTES_RAW = read('src/routes/categories.ts');

/** One inline route handler in routes/categories.ts. */
function categoryRouteBody(anchor: string): string {
  const start = CATEGORY_ROUTES_RAW.indexOf(anchor);
  expect(start, `${anchor} not found in routes/categories.ts`).toBeGreaterThan(-1);
  const rest = CATEGORY_ROUTES_RAW.slice(start);
  const next = rest.slice(1).search(/\n {2}app\.[a-z]+\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next + 1));
}

/**
 * Exercise the REAL boot reconciliation exactly once for this file, so the
 * 46 baseline rows exist exactly as they do in a running deployment. Without it
 * the in-memory mock (which starts with an empty `categories` table) could not
 * witness "all 46 baseline ids are represented" or "each seeded category sits at
 * its canonical position" at all.
 *
 * Since BATCH 2 (CAT-02) the sync is INSERT-ONLY for existing rows, so it is
 * naturally idempotent and this call cannot duplicate anything.
 */
beforeAll(async () => {
  await db.syncDefaultCategories();
});

/** One DatabaseEngine method: from its declaration to the next one. */
function databaseMethodBody(anchor: string): string {
  const start = DATABASE_RAW.indexOf(anchor);
  expect(start, `${anchor} not found in database.ts`).toBeGreaterThan(-1);
  const rest = DATABASE_RAW.slice(start);
  const next = rest.slice(1).search(/\n {2}public async /);
  return stripComments(next === -1 ? rest : rest.slice(0, next + 1));
}

/** One inline route handler: from its registration to the next one. */
function routeBody(anchor: string): string {
  const start = SERVER_RAW.indexOf(anchor);
  expect(start, `${anchor} not found in server.ts`).toBeGreaterThan(-1);
  const rest = SERVER_RAW.slice(start);
  const next = rest.slice(1).search(/\n {2}app\.[a-z]+\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next + 1));
}

/**
 * The canonical 46 category ids, read from the SAME source the app seeds from
 * (the `list` array in db/database.ts). Deliberately parsed rather than
 * transcribed: a hand-copied id list in a test is exactly the kind of second
 * vocabulary this phase is removing.
 */
function seededCategoryIds(): string[] {
  const start = DATABASE_RAW.indexOf('const list = [');
  const end = DATABASE_RAW.indexOf('// Derives Recovery Fee Engine inputs');
  expect(start, 'category seed block not found in db/database.ts').toBeGreaterThan(-1);
  expect(end, 'category seed end marker not found').toBeGreaterThan(start);
  return [...DATABASE_RAW.slice(start, end).matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe('CAT-08 — the three category datasets stay in parity with the ONE seed', () => {
  const seeded = seededCategoryIds();

  it('the seed parses and holds the 46 baseline ids', () => {
    expect(seeded).toHaveLength(46);
    expect(new Set(seeded).size).toBe(46);
    expect(seeded).toContain('national-id');
    expect(seeded).toContain('other-item');
  });

  it('verificationProfiles covers EXACTLY the seeded ids — no more, no fewer', () => {
    const profileIds = Object.keys(verificationProfiles);
    const seededSet = new Set(seeded);
    const profileSet = new Set(profileIds);

    const missingProfiles = seeded.filter((id) => !profileSet.has(id));
    const extraProfiles = profileIds.filter((id) => !seededSet.has(id));

    expect(missingProfiles, `seeded categories with no verification profile: ${missingProfiles.join(', ')}`).toEqual([]);
    expect(extraProfiles, `profiles for ids the backend does not seed: ${extraProfiles.join(', ')}`).toEqual([]);
    expect(profileIds).toHaveLength(seeded.length);
  });

  it('the presentation taxonomy covers EXACTLY the seeded ids', () => {
    const grouped = groupedCategoryIds();
    const seededSet = new Set(seeded);
    expect([...new Set(grouped)].sort()).toEqual([...seededSet].sort());
  });
});

// The canonical ordering key, expressed identically in the test and in
// compareCategoryOrder (sort_order, then id as a code-unit comparison).
const orderKey = (category: { sort_order: number; id: string }) =>
  `${String(category.sort_order).padStart(8, '0')}|${category.id}`;

describe('CAT-03 — getCategories() is the ONE deterministic category order', () => {
  const SEEDED = seededCategoryIds();

  it('returns an array of unique, fully-populated category records', async () => {
    const categories = await db.getCategories();
    expect(Array.isArray(categories)).toBe(true);

    const ids = categories.map((c) => c.id);
    expect(ids.length).toBeGreaterThanOrEqual(SEEDED.length);
    expect(new Set(ids).size, 'duplicate category ids').toBe(ids.length);

    for (const category of categories) {
      expect(typeof category.id).toBe('string');
      expect(typeof category.name_en).toBe('string');
      expect(typeof category.name_sw).toBe('string');
      expect(Number.isFinite(category.sort_order), `${category.id}.sort_order must be a real number`).toBe(true);
    }
  });

  it('represents every one of the 46 baseline ids', async () => {
    const ids = (await db.getCategories()).map((c) => c.id);
    const missing = SEEDED.filter((id) => !ids.includes(id));
    expect(missing, `baseline categories missing from getCategories(): ${missing.join(', ')}`).toEqual([]);
  });

  it('places each seeded category at its canonical 1-based seed position', async () => {
    const byId = new Map((await db.getCategories()).map((c) => [c.id, c]));
    SEEDED.forEach((id, index) => {
      expect(byId.get(id)?.sort_order, `${id} must sit at seed position ${index + 1}`).toBe(index + 1);
    });
  });

  it('orders by sort_order ascending with id as the deterministic tie-break', async () => {
    const keys = (await db.getCategories()).map(orderKey);
    expect(keys).toEqual([...keys].sort());
  });

  it('is stable across consecutive reads (no dependence on physical row order)', async () => {
    expect((await db.getCategories()).map((c) => c.id))
      .toEqual((await db.getCategories()).map((c) => c.id));
  });

  it('appends a newly created category after the current highest position', async () => {
    const highest = (await db.getCategories()).reduce((max, c) => Math.max(max, Number(c.sort_order) || 0), 0);

    const id = `TEST-B1-ORDER-${testRunId}`;
    const created = await db.createCategory({
      id,
      name_en: 'Batch 1 Order Fixture',
      name_sw: 'Jaribio la Mpangilio',
      total_fee: 500,
      finder_share: 125,
      agent_share: 175,
      platform_share: 200,
      is_sensitive_document: false,
    });

    expect(created.sort_order).toBe(highest + 1);

    const after = await db.getCategories();
    expect(after[after.length - 1].id).toBe(id);
    expect(after.map(orderKey)).toEqual([...after.map(orderKey)].sort());
  });

  it('keeps the order total and deterministic even when two rows share a position', async () => {
    const tiedId = `TEST-B1-TIE-${testRunId}`;
    await db.createCategory({
      id: tiedId,
      name_en: 'Batch 1 Tie Fixture',
      name_sw: 'Jaribio la Kufanana',
      total_fee: 500,
      finder_share: 125,
      agent_share: 175,
      platform_share: 200,
      is_sensitive_document: false,
      sort_order: 2, // deliberately collides with the seed's second category
    });

    const categories = await db.getCategories();
    const keys = categories.map(orderKey);
    expect(keys).toEqual([...keys].sort());

    // The tie is resolved by id, so the fixture's position is fully determined
    // rather than depending on which row the database happened to return first.
    const expectedIndex = keys.slice().sort().indexOf(orderKey({ sort_order: 2, id: tiedId }));
    expect(categories.findIndex((c) => c.id === tiedId)).toBe(expectedIndex);
  });
});

describe('CAT-05 — the delete guard must see EVERY referencing record', () => {
  const RUN = testRunId;
  const AGENT_ID = `TEST-B1-AGENT-${RUN}`;
  const CUSTOMER_ID = `TEST-B1-CUS-${RUN}`;
  let counter = 0;

  beforeAll(async () => {
    // item_verification_changes.agent_id has a real FK to agents(id) and
    // lost_reports.customer_id has one to customers(id); the mock enforces
    // neither. Create both so every fixture below is valid against real
    // Postgres too (the same pattern itemVerification.test.ts uses).
    await db.createAgent({
      id: AGENT_ID,
      business_name: 'Batch 1 Category Guard Agent',
      contact_phone: `+254${RUN}2`,
      location_address: 'Test Location',
      latitude: null,
      longitude: null,
      mpesa_till_or_paybill: '123456',
      payout_method_type: 'Till Number',
      status: 'active',
      refundable_deposit: 0,
      national_id_hash: 'test-hash-b1-guard',
      needs_manual_geocoding: false,
    } as any);
    await db.createCustomer(CUSTOMER_ID, 'Batch 1 Guard Customer', `+2547${String(Math.floor(10000000 + Math.random() * 89999999)).slice(-8)}`);
  });

  async function makeCategory(suffix: string) {
    const id = `TEST-B1-REF-${suffix}-${RUN}`;
    await db.createCategory({
      id,
      name_en: `Batch 1 Reference ${suffix}`,
      name_sw: `Kumbukumbu ya Batch 1 ${suffix}`,
      total_fee: 500,
      finder_share: 125,
      agent_share: 175,
      platform_share: 200,
      is_sensitive_document: false,
    });
    return id;
  }

  async function makeItem(categoryId: string, status = 'at_agent') {
    const id = `TEST-B1-ITEM-${RUN}-${counter++}`;
    await db.createItem({
      id,
      category_id: categoryId,
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'x',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000040',
      assigned_agent_id: null,
      status,
      flaggedForReview: false,
      isDescriptionOnly: true,
      description: 'x',
      is_sensitive_document: false,
      rejection_reason: null,
    } as any);
    return id;
  }

  it('an UNUSED category reports zero references — deletion stays possible', async () => {
    const id = await makeCategory('UNUSED');
    const counts = await db.getCategoryReferenceCounts(id);
    expect(counts).toEqual({ items: 0, verifiedItems: 0, lostReports: 0, total: 0 });
  });

  it('an item classified in the category is counted', async () => {
    const id = await makeCategory('ITEM');
    await makeItem(id);
    const counts = await db.getCategoryReferenceCounts(id);
    expect(counts.items).toBe(1);
    expect(counts.total).toBeGreaterThan(0);
  });

  it('an item whose VERIFIED category is this one is counted even after its current classification moved', async () => {
    const verifiedCategory = await makeCategory('VERIFIED');
    const otherCategory = await makeCategory('MOVED');
    const itemId = await makeItem(verifiedCategory);

    // The agent verifies the item into this category (writes both the verified
    // and the current classification), then an admin review moves the item's
    // CURRENT category elsewhere. The verified reference remains, and it must
    // still block deletion — otherwise the FK would reject the delete.
    const verification = await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: verifiedCategory, name: null, document_number: null, description: 'x', found_area: 'x' },
      '',
      null,
      true,
    );
    expect(verification.success).toBe(true);

    await db.adminUpdateItem(itemId, {
      category_id: otherCategory,
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      description: 'x',
      isDescriptionOnly: true,
      flaggedForReview: false,
    });

    const counts = await db.getCategoryReferenceCounts(verifiedCategory);
    expect(counts.items, 'no item is classified here any more').toBe(0);
    expect(counts.verifiedItems, 'the verified reference must still be seen').toBe(1);
    expect(counts.total).toBeGreaterThan(0);
  });

  it('a LOST REPORT referencing the category is counted — the case the old guard missed', async () => {
    const id = await makeCategory('LOSTREPORT');
    await db.createLostReport({
      id: `LR-B1${counter++}${RUN}`.slice(0, 40),
      customer_id: CUSTOMER_ID,
      category_id: id,
      status: 'active',
      county: 'Nairobi City',
      location_area: 'Westlands',
      location_landmark: null,
      lost_at_from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lost_at_to: null,
      brand: null,
      model: null,
      colour: null,
      material: null,
      description: null,
      distinctive_marks: null,
      document_type: null,
      document_number_hash: null,
    } as any);

    const counts = await db.getCategoryReferenceCounts(id);
    // Zero items — the old guard counted these and nothing else, so it reported
    // "safe to delete" and the DELETE then failed on lost_reports_category_id_fkey.
    expect(counts.items).toBe(0);
    expect(counts.lostReports).toBe(1);
    expect(counts.total).toBeGreaterThan(0);
  });
});

// ===========================================================================
// ROUTE WIRING — server.ts cannot be imported (it builds the app and starts
// listeners at import time and exports nothing), so the inline handlers are
// asserted against their real source. This is the repository's established
// pattern for exactly this constraint.
// ===========================================================================

describe('CAT-01 — every category WRITE validates the id before it touches the database', () => {
  it('POST /api/agents/verify-item resolves the category against the live list first', () => {
    const body = routeBody("app.post('/api/agents/verify-item'");
    // BATCH 2 CONTRACT UPDATE (CAT-04): the list this resolves against is now the
    // ACTIVE one, so a deactivated category cannot be chosen as a new
    // verification classification. The Batch 1 property under test — resolution
    // against the live category source, before any write — is unchanged.
    expect(body).toContain('resolveCategoryId(categoryId, await db.getActiveCategories())');
    expect(body).toMatch(/res\.status\(400\)/);
    // The value that gets stored is the resolved id, never the raw body field.
    expect(body).toContain('category_id: resolvedCategory.id as string');
  });

  it('POST /api/agents/verify-item rejects BEFORE any item/verification/audit write', () => {
    const body = routeBody("app.post('/api/agents/verify-item'");
    const guard = body.indexOf('resolveCategoryId(categoryId');
    const mutation = body.indexOf('db.recordItemVerification(');
    expect(guard).toBeGreaterThan(-1);
    expect(mutation).toBeGreaterThan(guard);
  });

  it('POST /api/admin/items/:id/review resolves the category before the item update', () => {
    const body = routeBody("app.post('/api/admin/items/:id/review'");
    expect(body).toContain('resolveCategoryId(categoryId, await db.getCategories())');
    expect(body).toMatch(/res\.status\(400\)/);
    expect(body).toContain('category_id: validatedCategoryId');

    const guard = body.indexOf('resolveCategoryId(categoryId');
    const update = body.indexOf('db.adminUpdateItem(');
    expect(guard).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(guard);
  });

  it('the verification write no longer echoes the database error text to the caller', () => {
    const body = databaseMethodBody('public async recordItemVerification(');
    // The route returns `result.message` straight to the agent, so the message
    // must not be built from the caught database error.
    expect(body).not.toContain('error.message');
    expect(body).not.toContain('String(error)');
    expect(body).toContain('Could not save the item verification');
  });
});

describe('CAT-05 — the DELETE route consults the reference counts before deleting', () => {
  it('counts every reference and answers the controlled conflict', () => {
    const body = routeBody("app.delete('/api/admin/categories/:id'");
    expect(body).toContain('db.getCategoryReferenceCounts(');
    expect(body).toMatch(/res\.status\(409\)/);
    // The items-only count that used to be the whole guard must no longer be the
    // guard — it cannot see lost_reports or verified-category references.
    expect(body).not.toContain('getItemsCountForCategory(');
  });

  it('the guard runs BEFORE the delete, so the FK is never the first defence', () => {
    const body = routeBody("app.delete('/api/admin/categories/:id'");
    const guard = body.indexOf('getCategoryReferenceCounts(');
    const del = body.indexOf('db.deleteCategory(');
    expect(guard).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(guard);
  });

  it('preserves the audit write and the admin authorization stack', () => {
    const body = routeBody("app.delete('/api/admin/categories/:id'");
    expect(body).toContain('authenticateJWT');
    expect(body).toContain('requireCurrentAdminSession');
    expect(body).toContain("req.user?.role !== 'admin'");
    expect(body).toContain("'CATEGORY_DELETED'");
  });
});

describe('CAT-07 — GET /api/items/search refuses an invalid category instead of returning nothing', () => {
  it('resolves the category against the live list and answers 400', () => {
    const body = routeBody("app.get('/api/items/search'");
    expect(body).toContain('resolveCategoryId(categoryId, await db.getCategories())');
    expect(body).toMatch(/res\.status\(400\)/);
  });

  it('requires the parameter to be a canonical id VERBATIM, so the filter cannot diverge', () => {
    const body = routeBody("app.get('/api/items/search'");
    // The two lines below are pinned by the pre-existing geography suite
    // (countyAwareSearchAndSurfacing.test.ts) and are deliberately unchanged.
    expect(body).toContain('const { q, categoryId, area, county } = req.query;');
    expect(body).toContain('item.category_id === categoryId');
    // ...so the boundary must reject anything that is not byte-identical to a
    // live canonical id, otherwise the filter would compare a padded/variant
    // value and silently return nothing.
    expect(body).toContain('!resolvedCategory.ok || resolvedCategory.id !== categoryId');
  });

  it('an ABSENT parameter still means "no constraint" (legacy behaviour preserved)', () => {
    const body = routeBody("app.get('/api/items/search'");
    expect(body).toContain('if (categoryId !== undefined)');
  });

  it('the county filter and the claimability-first ordering are untouched', () => {
    const body = routeBody("app.get('/api/items/search'");
    expect(body).toContain('resolveCountyName(county)');
    expect(body).toContain('FOUND_COUNTY_MESSAGES.invalid');
    expect(body).toContain('canCreateClaim');

    // Category and county remain independent AND-composed filters: neither
    // infers the other, and both are applied after the visibility filter.
    const claimability = body.indexOf('claimabilityChecks.filter');
    expect(claimability).toBeGreaterThan(-1);
    const categoryFilter = body.indexOf('item.category_id === categoryId');
    const countyFilter = body.indexOf('itemMatchesCanonicalCounty');
    expect(categoryFilter).toBeGreaterThan(claimability);
    expect(countyFilter).toBeGreaterThan(claimability);
  });
});

describe('CAT-08 — GET /api/categories contract', () => {
  it('is public (no authentication) and serialises the LIVE category list', () => {
    const body = categoryRouteBody("app.get('/api/categories'");
    expect(CATEGORY_ROUTES_RAW).toContain("app.get('/api/categories', async (req, res) =>");
    // BATCH 2 CONTRACT UPDATE (CAT-04 + CAT-09): the public list is now the ACTIVE
    // list, serialised through the explicit public DTO. The Batch 1 properties —
    // unauthenticated, served from the live category source — are unchanged.
    expect(body).toContain('db.getActiveCategories()');
    expect(body).toContain('toPublicCategoryView');
    expect(body).not.toContain('authenticateJWT');
  });

  it('answers 503 for a database-connection failure instead of a 500', () => {
    const body = categoryRouteBody("app.get('/api/categories'");
    expect(body).toContain('isDatabaseConnectionError(e)');
    expect(body).toMatch(/res\.status\(503\)/);
  });

  it('the payload is the same shape every consumer already reads', async () => {
    const categories = await db.getCategories();
    expect(categories.length).toBeGreaterThan(0);

    const sample = categories.find((c) => c.id === 'national-id') ?? categories[0];
    // F-6 — exercised through the REAL public transform (the function the route
    // actually maps with), not against the internal row: this is the exact shape
    // GET /api/categories serves, so a change to the public mapping fails here.
    const served = toPublicCategoryView(sample) as any;
    expect(served).toBeTruthy();

    for (const field of [
      'id', 'name_en', 'name_sw', 'total_fee', 'finder_share', 'agent_share',
      'platform_share', 'is_sensitive_document', 'sort_order',
    ]) {
      expect(Object.keys(served), `public field ${field} missing`).toContain(field);
    }
    expect(typeof served.id).toBe('string');
    expect(typeof served.name_en).toBe('string');
    expect(typeof served.name_sw).toBe('string');

    // ...and the operational configuration stays out of the public payload.
    for (const internal of [
      'is_admin_modified', 'elevated_review', 'public_clue_style', 'base_fee',
      'complexity_fee', 'delay_fee', 'ceiling_percent', 'finder_pct', 'agent_pct',
      'platform_pct', 'finder_reward_cap', 'is_active',
    ]) {
      expect(served, `${internal} must not be public`).not.toHaveProperty(internal);
    }
  });

  it('a category that appears only in the database still satisfies the contract', async () => {
    // "New categories can appear without breaking the contract": the payload is
    // whatever the table holds, so a row created through the DB layer must be
    // served, through the public transform, in the same shape as a seeded one.
    const id = `TEST-B1-CONTRACT-${testRunId}`;
    await db.createCategory({
      id,
      name_en: 'Batch 1 Contract Fixture',
      name_sw: 'Jaribio la Mkataba',
      total_fee: 500,
      finder_share: 125,
      agent_share: 175,
      platform_share: 200,
      is_sensitive_document: false,
    });

    const served = toPublicCategoryView((await db.getCategories()).find((c) => c.id === id)) as any;
    expect(served).toBeDefined();
    expect(served.name_en).toBe('Batch 1 Contract Fixture');
    expect(served.total_fee).toBe(500);
    expect(served.sort_order).toBeGreaterThan(0);
  });
});

describe('CAT-19 — the admin category routes validate their numeric inputs', () => {
  it('POST validates the id FORMAT and the VARCHAR(50) storage limit', () => {
    const body = categoryRouteBody("app.post('/api/admin/categories'");
    expect(body).toContain('validateCategoryIdFormat(id)');
    expect(body).not.toMatch(/!\/\^\[a-z0-9-\]\+\$\/\.test\(id\)/);
  });

  it('POST runs every engine fee field through the shared numeric rule', () => {
    const body = categoryRouteBody("app.post('/api/admin/categories'");
    expect(body).toContain('parseCategoryNumber(');
    for (const field of ['base_fee', 'complexity_fee', 'delay_fee', 'ceiling_percent', 'finder_pct', 'agent_pct', 'platform_pct', 'finder_reward_cap']) {
      expect(body, `${field} must be validated`).toContain(`['${field}', ${field},`);
    }
    // No bare Number() coercion of those fields survives.
    expect(body).not.toMatch(/base_fee: base_fee !== undefined \? Number\(base_fee\)/);
    expect(body).not.toMatch(/finder_reward_cap === '' \? null : Number\(finder_reward_cap\)/);
  });

  it('PUT validates the same fields and preserves its clear-an-optional-cap shape', () => {
    const body = routeBody("app.put('/api/admin/categories/:id'");
    expect(body).toContain('parseCategoryNumber(');
    for (const field of ['base_fee', 'complexity_fee', 'delay_fee', 'ceiling_percent', 'finder_pct', 'agent_pct', 'platform_pct']) {
      expect(body, `${field} must be validated`).toContain(`['${field}', ${field},`);
    }
    // undefined -> leave unchanged, null/'' -> clear, number -> validated value.
    expect(body).toContain("finder_reward_cap === null || finder_reward_cap === ''");
    expect(body).toContain('finderRewardCapUpdate = parsedCap.value as number');
    expect(body).toContain('finder_reward_cap: finderRewardCapUpdate');
    expect(body).not.toMatch(/base_fee: base_fee !== undefined \? Number\(base_fee\)/);
  });

  it('both routes answer invalid input with a 400, never a 500', () => {
    // PHASE 16.1 BATCH 1A — POST now lives in routes/categories.ts (extracted so
    // the create → public-read chain can be exercised over real HTTP); PUT is
    // still inline in server.ts. Each body is sliced from its own real source.
    const bodies: Array<[string, string]> = [
      ["app.post('/api/admin/categories'", categoryRouteBody("app.post('/api/admin/categories'")],
      ["app.put('/api/admin/categories/:id'", routeBody("app.put('/api/admin/categories/:id'")],
    ];
    for (const [anchor, body] of bodies) {
      expect(body, `${anchor} must answer 400`).toMatch(/res\.status\(400\)/);
      expect(body).not.toMatch(/res\.status\(500\)/);
    }
  });
});

describe('CAT-10 / CAT-11 — no misleading non-canonical category vocabulary remains', () => {
  const HOME = stripComments(read('src/components/HomeView.tsx'));
  const FINDER = stripComments(read('src/components/FinderView.tsx'));

  it('the dead, drifted homepage category-icon map is gone', () => {
    expect(HOME).not.toContain('getCategoryIcon');
    // Its exclusive icon imports went with it...
    for (const icon of ['PhoneCall', 'Luggage', 'Laptop', 'Gem']) {
      expect(HOME, `${icon} should no longer be imported`).not.toContain(icon);
    }
    // ...while the icons the live homepage still renders are untouched.
    for (const icon of ['Package', 'ShieldCheck', 'Smartphone', 'Search']) {
      expect(HOME, `${icon} is still used by the live homepage`).toContain(icon);
    }
  });

  it('the Finder no longer compares a category id against a literal "other"', () => {
    expect(FINDER).not.toContain("categoryId !== 'other'");
    expect(FINDER).not.toContain("=== 'other'");
  });

  it('the Finder keeps its fail-closed sensitivity rule from the live category record', () => {
    expect(FINDER).toContain('isSelectedCategorySensitive');
    expect(FINDER).toContain('selectedCat.is_sensitive_document !== false');
  });
});
