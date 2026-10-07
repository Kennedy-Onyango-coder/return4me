import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';
import {
  COORDINATE_SOURCES,
  isCoordinateSource,
  AUTHORITATIVE_LOCATION_SOURCES,
  isAuthoritativeLocationSource,
} from '../services/locationProvenance';
import { toPublicItemView } from '../services/publicItemView';
import { toOwnerSafeAgentView, toOwnerSafeItemView } from '../services/ownerSafeViews';
import { toCustomerSafeLostReportView } from '../services/lostReportView';
import { toAdminSafeAgentView, toAdminSafeItemView } from '../services/adminSafeViews';

// =============================================================================
// GEO-D+ — ADDITIVE LOCATION PROVENANCE.
//
// The read-only audit established that the platform keeps TWO independent
// provenance axes, and this batch persists them additively:
//
//   location_source   = how the SERVICE / found geography was established
//                       (today only 'user_selected'; NULL for legacy rows).
//   coordinate_source = how the stored latitude/longitude PAIR was established
//                       (agents only): 'browser_gps' | 'forward_geocoder' |
//                       'admin_corrected'; NULL for legacy rows.
//
// A CRITICAL non-change is also pinned here: items.latitude/longitude are an
// optional device/ROUTING position, NOT the found-item location, so items get
// NO coordinate_source and no reinterpretation of those coordinates.
//
// This suite follows the repository's two established patterns: it drives the
// REAL writers through db.* (the in-memory mock stores every INSERT column and
// applies every UPDATE SET column), and it asserts the SCHEMA DEFINITION across
// its three synchronised representations by reading the source (running real
// DDL needs live PostgreSQL).
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

const SCHEMA_TS = read('src/db/schema.ts');
const INDEX_TS = read('src/db/index.ts');
const SQL_SCHEMA = read('sql/schema.sql');
const FINDER_REPORT = read('src/routes/finderReport.ts');
const LOST_REPORTS = read('src/routes/lostReports.ts');
const SERVER_TS = read('src/server.ts');
const DATABASE_TS = read('src/db/database.ts');

const count = (source: string, re: RegExp) => (source.match(re) ?? []).length;

let counter = 0;
const uid = (kind: string) => `TEST-GEOD-${kind}-${testRunId}-${counter++}`;

async function makeItem(extra: Record<string, unknown> = {}) {
  await ensureTestCategory('phone');
  const id = uid('ITEM');
  await db.createItem({
    id,
    category_id: 'phone',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Test place',
    latitude: -1.2921,
    longitude: 36.8219,
    found_county: 'Nairobi City',
    administrative_unit_id: null,
    finder_phone: '+254700000088',
    assigned_agent_id: null,
    status: 'awaiting_dropoff',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: 'Test item',
    is_sensitive_document: false,
    rejection_reason: null,
    ...extra,
  } as any);
  return id;
}

async function makeLostReport(extra: Record<string, unknown> = {}) {
  await ensureTestCategory('phone');
  const id = uid('LR');
  const customerId = uid('CUST');
  await db.createLostReport({
    id,
    customer_id: customerId,
    category_id: 'phone',
    status: 'active',
    county: 'Nairobi City',
    administrative_unit_id: null,
    location_area: 'Test area',
    location_landmark: null,
    lost_at_from: new Date().toISOString(),
    lost_at_to: null,
    brand: null,
    model: null,
    colour: null,
    material: null,
    description: null,
    distinctive_marks: null,
    document_type: null,
    document_number_hash: null,
    ...extra,
  } as any);
  return { id, customerId };
}

async function makeAgent(extra: Record<string, unknown> = {}) {
  const id = uid('AGENT');
  await db.createAgent({
    id,
    business_name: `Test Agent ${id}`,
    contact_phone: `+2547${counter}00000${counter}`,
    location_address: 'Test Location',
    latitude: -1.2921,
    longitude: 36.8219,
    mpesa_till_or_paybill: '654321',
    payout_method_type: 'Till Number',
    status: 'pending',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-geod',
    needs_manual_geocoding: false,
    ...extra,
  } as any);
  return id;
}

// ---------------------------------------------------------------------------
// 1. SCHEMA — the four nullable columns exist, with no default and no NOT NULL.
// ---------------------------------------------------------------------------
describe('GEO-D+ schema: four nullable, default-less provenance columns', () => {
  const LOC_DRIZZLE = /location_source: varchar\("location_source", \{ length: 30 \}\)/g;
  const COORD_DRIZZLE = /coordinate_source: varchar\("coordinate_source", \{ length: 30 \}\)/g;

  it('declares location_source on items, lost_reports and agents (drizzle)', () => {
    expect(count(SCHEMA_TS, LOC_DRIZZLE)).toBe(3);
    expect(count(SCHEMA_TS, COORD_DRIZZLE)).toBe(1);
  });

  it('marks none of them NOT NULL and gives none a default', () => {
    expect(SCHEMA_TS).not.toMatch(/location_source: varchar\("location_source", \{ length: 30 \}\)\.notNull/);
    expect(SCHEMA_TS).not.toMatch(/coordinate_source: varchar\("coordinate_source", \{ length: 30 \}\)\.notNull/);
    expect(SCHEMA_TS).not.toMatch(/location_source: varchar\("location_source", \{ length: 30 \}\)\.default/);
    expect(SCHEMA_TS).not.toMatch(/coordinate_source: varchar\("coordinate_source", \{ length: 30 \}\)\.default/);
  });

  it('declares the same four columns in sql/schema.sql, nullable and default-less', () => {
    expect(count(SQL_SCHEMA, /location_source VARCHAR\(30\),/g)).toBe(3);
    expect(count(SQL_SCHEMA, /coordinate_source VARCHAR\(30\),/g)).toBe(1);
    expect(SQL_SCHEMA).not.toMatch(/location_source VARCHAR\(30\) NOT NULL/);
    expect(SQL_SCHEMA).not.toMatch(/coordinate_source VARCHAR\(30\) NOT NULL/);
    expect(SQL_SCHEMA).not.toMatch(/location_source VARCHAR\(30\) DEFAULT/);
    expect(SQL_SCHEMA).not.toMatch(/coordinate_source VARCHAR\(30\) DEFAULT/);
  });
});

// ---------------------------------------------------------------------------
// 2. SCHEMA SYNCHRONISATION — all three representations carry the same columns.
// ---------------------------------------------------------------------------
describe('GEO-D+ schema synchronisation across the three representations', () => {
  it('ensureSchemaUpToDate() adds every column with ADD COLUMN IF NOT EXISTS', () => {
    expect(count(INDEX_TS, /ALTER TABLE agents ADD COLUMN IF NOT EXISTS location_source VARCHAR\(30\)/g)).toBe(1);
    expect(count(INDEX_TS, /ALTER TABLE agents ADD COLUMN IF NOT EXISTS coordinate_source VARCHAR\(30\)/g)).toBe(1);
    expect(count(INDEX_TS, /ALTER TABLE items ADD COLUMN IF NOT EXISTS location_source VARCHAR\(30\)/g)).toBe(1);
    expect(count(INDEX_TS, /ALTER TABLE lost_reports ADD COLUMN IF NOT EXISTS location_source VARCHAR\(30\)/g)).toBe(1);
  });

  it('every target table and column appears in all three representations', () => {
    for (const table of ['items', 'lost_reports', 'agents']) {
      expect(SCHEMA_TS).toContain(`pgTable("${table}"`);
    }
    expect(SQL_SCHEMA).toContain('location_source VARCHAR(30)');
    expect(SQL_SCHEMA).toContain('coordinate_source VARCHAR(30)');
    expect(INDEX_TS).toContain('ALTER TABLE agents ADD COLUMN IF NOT EXISTS coordinate_source VARCHAR(30)');
  });

  it('introduces no NOT NULL and no DEFAULT in the migration path', () => {
    const provenanceAdds = (INDEX_TS.match(/ADD COLUMN IF NOT EXISTS (location_source|coordinate_source)[^`]*/g) ?? []);
    expect(provenanceAdds.length).toBe(4);
    for (const stmt of provenanceAdds) {
      expect(stmt).not.toMatch(/NOT NULL/i);
      expect(stmt).not.toMatch(/DEFAULT/i);
      expect(stmt).not.toMatch(/ENUM/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. NEW FOUND ITEM — geography provenance is 'user_selected'.
// ---------------------------------------------------------------------------
describe('GEO-D+ new found item', () => {
  it('stores location_source = user_selected for a validated finder report', async () => {
    const id = await makeItem({ location_source: 'user_selected' });
    const item = await db.getItem(id);
    expect(item?.location_source).toBe('user_selected');
  });

  it('the finder report route writes location_source = user_selected and leaves coordinates alone', () => {
    expect(FINDER_REPORT).toContain("location_source: 'user_selected'");
    expect(FINDER_REPORT).toContain('latitude: numericLat,');
    expect(FINDER_REPORT).not.toContain('coordinate_source');
  });
});

// ---------------------------------------------------------------------------
// 4. NEW LOST REPORT — geography provenance is 'user_selected'.
// ---------------------------------------------------------------------------
describe('GEO-D+ new lost report', () => {
  it('stores location_source = user_selected for a validated report', async () => {
    const { id, customerId } = await makeLostReport({ location_source: 'user_selected' });
    const report = await db.getLostReportByIdForCustomer(id, customerId);
    expect(report?.location_source).toBe('user_selected');
  });

  it('the lost-report draft carries location_source = user_selected and no GPS/coordinate', () => {
    expect(LOST_REPORTS).toContain("location_source: 'user_selected'");
    expect(LOST_REPORTS).not.toContain('coordinate_source');
    expect(LOST_REPORTS).not.toContain('latitude');
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. NEW AGENT — coordinate provenance names the code path that produced it.
// ---------------------------------------------------------------------------
describe('GEO-D+ new agent coordinate provenance', () => {
  it('records browser_gps when the request supplied browser GPS (and user_selected geography)', async () => {
    const id = await makeAgent({ location_source: 'user_selected', coordinate_source: 'browser_gps' });
    const agent = await db.getAgent(id);
    expect(agent?.location_source).toBe('user_selected');
    expect(agent?.coordinate_source).toBe('browser_gps');
  });

  it('records forward_geocoder when the server forward-geocoded the address', async () => {
    const id = await makeAgent({ location_source: 'user_selected', coordinate_source: 'forward_geocoder' });
    const agent = await db.getAgent(id);
    expect(agent?.coordinate_source).toBe('forward_geocoder');
  });

  it('the signup route derives coordinate_source from the actual producing branch', () => {
    expect(SERVER_TS).toContain("? 'browser_gps'");
    expect(SERVER_TS).toContain("? 'forward_geocoder'");
    expect(SERVER_TS).toContain('coordinate_source: agentCoordinateSource');
    expect(SERVER_TS).toContain("location_source: 'user_selected'");
  });
});

// ---------------------------------------------------------------------------
// 7. ADMIN AGENT COORDINATE CORRECTION — coordinate_source = 'admin_corrected',
//    and the SERVICE geography (location_source) is NOT touched.
// ---------------------------------------------------------------------------
describe('GEO-D+ admin agent coordinate correction', () => {
  it('sets coordinate_source = admin_corrected while preserving location_source', async () => {
    const id = await makeAgent({ location_source: 'user_selected', coordinate_source: 'forward_geocoder' });
    const updated = await db.updateAgentLocation(id, -1.3, 36.9);
    expect(updated?.coordinate_source).toBe('admin_corrected');
    expect(updated?.location_source).toBe('user_selected');

    const reloaded = await db.getAgent(id);
    expect(reloaded?.coordinate_source).toBe('admin_corrected');
    expect(reloaded?.location_source).toBe('user_selected');
  });

  it('preserves the existing AGENT_LOCATION_MANUALLY_SET audit event and route behaviour', () => {
    expect(SERVER_TS).toContain('AGENT_LOCATION_MANUALLY_SET');
    expect(SERVER_TS).toContain("app.post('/api/admin/agents/:id/location'");
    expect(DATABASE_TS).toContain('coordinate_source: "admin_corrected"');
  });
});

// ---------------------------------------------------------------------------
// 8. LEGACY ROWS stay NULL — no backfill, no inference.
// ---------------------------------------------------------------------------
describe('GEO-D+ legacy rows remain NULL', () => {
  it('an item created with no provenance reads back NULL', async () => {
    const id = await makeItem();
    const item = await db.getItem(id);
    expect(item?.location_source).toBeNull();
  });

  it('a lost report created with no provenance reads back NULL', async () => {
    const { id, customerId } = await makeLostReport();
    const report = await db.getLostReportByIdForCustomer(id, customerId);
    expect(report?.location_source).toBeNull();
  });

  it('an agent created with no provenance reads back NULL on BOTH axes', async () => {
    const id = await makeAgent();
    const agent = await db.getAgent(id);
    expect(agent?.location_source).toBeNull();
    expect(agent?.coordinate_source).toBeNull();
  });

  it('the migration contains NO data-update/backfill statement for the new columns', () => {
    for (const source of [INDEX_TS, SQL_SCHEMA]) {
      expect(source).not.toMatch(/UPDATE\s+items\s+SET[^;]*location_source/i);
      expect(source).not.toMatch(/UPDATE\s+agents\s+SET[^;]*location_source/i);
      expect(source).not.toMatch(/UPDATE\s+agents\s+SET[^;]*coordinate_source/i);
      expect(source).not.toMatch(/UPDATE\s+lost_reports\s+SET[^;]*location_source/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. DTO PRIVACY — internal metadata never leaks to public/owner/customer.
// ---------------------------------------------------------------------------
describe('GEO-D+ DTO privacy', () => {
  it('the public item view never exposes provenance', () => {
    const view = toPublicItemView({ id: 'i', category_id: 'phone', is_sensitive_document: false, location_source: 'user_selected' });
    expect(view).not.toHaveProperty('location_source');
    expect(view).not.toHaveProperty('coordinate_source');
  });

  it('the owner-safe item/agent views never expose provenance', () => {
    const item = toOwnerSafeItemView({ id: 'i', category_id: 'phone', is_sensitive_document: false, location_source: 'user_selected' });
    expect(item).not.toHaveProperty('location_source');
    const agent = toOwnerSafeAgentView({ id: 'a', business_name: 'Hub', location_source: 'user_selected', coordinate_source: 'browser_gps' });
    expect(agent).not.toHaveProperty('location_source');
    expect(agent).not.toHaveProperty('coordinate_source');
  });

  it('the customer lost-report view never exposes provenance', () => {
    const view = toCustomerSafeLostReportView({ id: 'LR', status: 'active', county: 'Nairobi City', location_source: 'user_selected' });
    expect(view).not.toHaveProperty('location_source');
    expect(view).not.toHaveProperty('coordinate_source');
  });

  it('the admin-safe DTOs DO expose provenance, deliberately', () => {
    const item = toAdminSafeItemView({ id: 'i', category_id: 'phone', location_source: 'user_selected' });
    expect(item).toHaveProperty('location_source', 'user_selected');
    expect(item).not.toHaveProperty('coordinate_source');

    const agent = toAdminSafeAgentView({ id: 'a', business_name: 'Hub', location_source: 'user_selected', coordinate_source: 'admin_corrected' });
    expect(agent).toHaveProperty('location_source', 'user_selected');
    expect(agent).toHaveProperty('coordinate_source', 'admin_corrected');
  });
});

// ---------------------------------------------------------------------------
// 10. ITEM COORDINATE SEMANTICS — unchanged; no coordinate axis on items.
// ---------------------------------------------------------------------------
describe('GEO-D+ item coordinate semantics are unchanged', () => {
  const itemsBlock = SCHEMA_TS.slice(SCHEMA_TS.indexOf('export const items = pgTable'), SCHEMA_TS.indexOf('export const claims = pgTable'));

  it('the items table has NO coordinate_source column', () => {
    expect(itemsBlock).not.toContain('coordinate_source');
    expect(itemsBlock).toContain('location_source');
  });

  it('createItem() never writes a coordinate provenance', () => {
    const createItemBlock = DATABASE_TS.slice(DATABASE_TS.indexOf('public async createItem'), DATABASE_TS.indexOf('public async updateItemStatus'));
    expect(createItemBlock).not.toContain('coordinate_source');
  });

  it('the finder report route never labels items.latitude/longitude with a provenance', () => {
    expect(FINDER_REPORT).not.toContain('coordinate_source');
    expect(FINDER_REPORT).toContain('latitude: numericLat,');
  });
});

// ---------------------------------------------------------------------------
// VALIDATION — focused, non-permissive writers-side guards.
// ---------------------------------------------------------------------------
describe('GEO-D+ provenance vocabulary and guards', () => {
  it('names exactly the three coordinate sources', () => {
    expect([...COORDINATE_SOURCES]).toEqual(['browser_gps', 'forward_geocoder', 'admin_corrected']);
    expect(isCoordinateSource('browser_gps')).toBe(true);
    expect(isCoordinateSource('forward_geocoder')).toBe(true);
    expect(isCoordinateSource('admin_corrected')).toBe(true);
    expect(isCoordinateSource('reverse_geocoder')).toBe(false);
    expect(isCoordinateSource('nonsense')).toBe(false);
    expect(isCoordinateSource(42)).toBe(false);
    expect(isCoordinateSource(null)).toBe(false);
  });

  it('allows only user_selected as an authoritative geography source', () => {
    expect([...AUTHORITATIVE_LOCATION_SOURCES]).toEqual(['user_selected']);
    expect(isAuthoritativeLocationSource('user_selected')).toBe(true);
    expect(isAuthoritativeLocationSource('browser_gps')).toBe(false);
    expect(isAuthoritativeLocationSource('reverse_geocoder')).toBe(false);
    expect(isAuthoritativeLocationSource('forward_geocoder')).toBe(false);
    expect(isAuthoritativeLocationSource('admin_corrected')).toBe(false);
  });

  it('rejects an advisory geography value at the write boundary (stored as NULL)', async () => {
    const id = await makeItem({ location_source: 'browser_gps' });
    const item = await db.getItem(id);
    expect(item?.location_source).toBeNull();
  });

  it('rejects an unrecognised coordinate source at the write boundary (stored as NULL)', async () => {
    const id = await makeAgent({ location_source: 'user_selected', coordinate_source: 'reverse_geocoder' });
    const agent = await db.getAgent(id);
    expect(agent?.coordinate_source).toBeNull();
  });
});




