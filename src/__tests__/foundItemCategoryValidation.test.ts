import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P12 REGRESSION TEST — unknown category on the PUBLIC found-item route.
//
// POST /api/items/report destructured `categoryId` straight from the request
// and never validated it against the category list. The lookup
// `categories.find(c => c.id === categoryId)` produced `undefined`, and the
// very next line masked the miss instead of reporting it:
//
//     const isSensitive = cat ? (cat.is_sensitive_document !== false) : true;
//
// `isSensitive` then fell back to its fail-closed `true`, and execution carried
// on through AgentMatchingService.assignNearestAgent() and — critically —
// `await uploadBase64Image(photoBase64, 'items')`, a REAL storage write, before
// `db.createItem()` finally failed the `items_category_id_fkey` constraint.
// The route's catch turned that into a 500 "Failed to save found item."
//
// Observed live against a real PostgreSQL 18 instance:
//   POST /api/items/report {"categoryId":"not-a-real-category", ...valid photo...}
//   -> 500 {"error":"Failed to save found item."}
//   cause: error: insert or update on table "items" violates foreign key
//          constraint "items_category_id_fkey"
//   detail: 'Key (category_id)=(not-a-real-category) is not present in table "categories".'
//
// So a trivially malformed request on an unauthenticated public endpoint
// produced (a) a 5xx where a 4xx is correct, (b) a full constraint-violation
// stack trace in the error log for client input, and (c) an orphaned uploaded
// photo with no item row referencing it.
//
// The lost-report route has always rejected an unknown category up front
// (routes/lostReports.ts -> validateLostReportPayload -> MESSAGES.categoryInvalid).
// These tests pin the found-item route to that same standard, and — most
// importantly — pin the ORDER: the rejection must happen before any upload or
// insert, not after them.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

// P2-A1: the found-item report handler was extracted VERBATIM from server.ts into
// routes/finderReport.ts so it can be mounted for real HTTP integration testing.
// reportHandler() reads the body from whichever file now owns the route, so every
// ordering assertion below keeps testing exactly what it always tested — only
// the file the source is read from moved. No guarantee is weakened.
const finderReportTs = fs.readFileSync(path.resolve(__dirname, '../routes/finderReport.ts'), 'utf8');

/** The body of the public found-item report handler alone, comments stripped. */
function reportHandler(): string {
  const anchor = "app.post('/api/items/report'";
  const src = serverTs.includes(anchor) ? serverTs : finderReportTs;
  const start = src.indexOf(anchor);
  expect(start, 'found-item report route not found in server.ts or routes/finderReport.ts').toBeGreaterThan(-1);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n  app\.[a-z]+\(/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);

  // Comment-only lines are dropped before any ordering assertion is made: this
  // fix's own rationale comment quotes `uploadBase64Image()` and `db.createItem`,
  // which would otherwise be mistaken for the real call sites and invert the
  // comparison. Same convention as __tests__/errorDisclosure.test.ts.
  return body
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('POST /api/items/report rejects an unknown category before any side effect', () => {
  it('validates categoryId against the fetched category list', () => {
    const handler = reportHandler();
    const guard = handler.indexOf('if (!cat) {');
    expect(guard, 'expected an explicit `if (!cat)` category guard').toBeGreaterThan(-1);

    // The guard must be fed by a lookup over the real category list, not by a
    // truthiness check on the raw client string.
    expect(handler).toMatch(/categories\.find\(c => c\.id === categoryId\)/);
  });

  it('answers 400 (client error), never 500, for an unknown category', () => {
    const handler = reportHandler();
    const guard = handler.slice(handler.indexOf('if (!cat) {'), handler.indexOf('if (!cat) {') + 240);
    expect(guard).toMatch(/res\.status\(400\)/);
    expect(guard).not.toMatch(/res\.status\(500\)/);
  });

  it('uses the SAME wording as the lost-report route for an invalid category', () => {
    // Consistency: one phrase for "that category is not valid" across surfaces.
    const lostReportsTs = fs.readFileSync(path.resolve(__dirname, '../routes/lostReports.ts'), 'utf8');
    const shared = 'That item category is not valid.';
    expect(lostReportsTs).toContain(shared);
    expect(reportHandler()).toContain(shared);
  });

  it('rejects BEFORE uploading the photo and BEFORE inserting the item', () => {
    const handler = reportHandler();
    const guard = handler.indexOf('if (!cat) {');
    const upload = handler.indexOf('uploadBase64Image(');
    const insert = handler.indexOf('db.createItem(');

    expect(upload, 'expected an uploadBase64Image() call in the handler').toBeGreaterThan(-1);
    expect(insert, 'expected a db.createItem() call in the handler').toBeGreaterThan(-1);

    // Ordering is the actual defect: the old code reached both of these with an
    // undefined category, then failed at the database.
    expect(guard, 'category guard must run before the photo upload').toBeLessThan(upload);
    expect(guard, 'category guard must run before the item insert').toBeLessThan(insert);
  });

  it('fails CLOSED on sensitivity when there is genuinely no category', () => {
    const handler = reportHandler();
    // PHASE 16.1 (BATCH 1) changed the MEANING of a missing category: it is now
    // an explicit "unclassified" state rather than the symptom of a failed
    // lookup. A SUPPLIED-but-unknown id is still rejected by the `if (!cat)`
    // guard before any side effect, so the only way `cat` is null here is that
    // the finder supplied no category at all.
    //
    // With nothing to ask, sensitivity fails CLOSED (true): an unclassified item
    // is treated as a possible document until an administrator classifies it,
    // which is the privacy-safe direction. It is never derived from a missing
    // category record.
    expect(handler).toContain('const isSensitive = cat ? cat.is_sensitive_document !== false : true;');
    // The lookup only runs when a category was actually supplied, and its miss
    // path is still the authoritative 400.
    expect(handler).toMatch(/if \(categoryId\) \{\s*\n\s*cat = categories\.find\(c => c\.id === categoryId\);/);
    expect(handler.indexOf('if (!cat) {')).toBeGreaterThan(-1);
  });
});

// =============================================================================
// PHASE 16.1 (BATCH 1) — ITEM NAME REQUIRED, CATEGORY OPTIONAL, PHOTO REQUIRED
// =============================================================================
// The found side's half of the reporting foundation. These are source-level
// assertions on the REAL handler (the same `reportHandler()` slice used above),
// because each one is a validation-ORDER guarantee rather than a rendered value:
//   * the item name is required, trimmed, and bounded at 200 characters, and it
//     is checked before any paid/side-effecting work;
//   * the FOUND photo stays MANDATORY (only the lost-report photo became
//     optional);
//   * a missing category is stored as NULL, never as '' or a guess.
describe('16.1 Batch 1: POST /api/items/report — item name, category, photo', () => {
  it('requires a trimmed item name and enforces the 200-character ceiling', () => {
    const handler = reportHandler();
    expect(handler).toContain("typeof req.body.itemName === 'string' ? req.body.itemName.trim() : ''");
    expect(handler).toContain("return res.status(400).json({ error: 'Please enter the item name.' });");
    expect(handler).toContain('if (itemName.length > 200) {');
  });

  it('validates the item name BEFORE the county, agent matching, upload and insert', () => {
    const handler = reportHandler();
    const nameGuard = handler.indexOf('if (!itemName) {');
    expect(nameGuard, 'expected the required item-name guard').toBeGreaterThan(-1);
    for (const later of ['resolveFoundCountyInput(', 'uploadBase64Image(', 'db.createItem(']) {
      expect(handler.indexOf(later), `${later} must run after the item-name guard`).toBeGreaterThan(nameGuard);
    }
  });

  it('keeps the FOUND photo MANDATORY', () => {
    const handler = reportHandler();
    // Only the lost-report photo became optional. A found item must still carry
    // a photograph, and it is still part of the same required-field rejection.
    expect(handler).toContain("if (!photoBase64 || !locationDescription || !finderPhone) {");
    expect(handler).not.toMatch(/if \(!locationDescription \|\| !finderPhone\) \{/);
  });

  it('stores a missing category as NULL and persists the item name', () => {
    const handler = reportHandler();
    expect(handler).toContain('category_id: categoryId || null,');
    expect(handler).toContain('item_name: itemName,');
  });

  it('defers pricing when there is no category instead of pricing a guessed one', () => {
    const handler = reportHandler();
    // resolveItemLockedPricing must only ever be asked about a real record.
    expect(handler).toContain('if (cat) {');
    const guarded = handler.indexOf('if (cat) {');
    expect(handler.indexOf('resolveItemLockedPricing(cat, parsedDeclaredValue)')).toBeGreaterThan(guarded);
  });
});
