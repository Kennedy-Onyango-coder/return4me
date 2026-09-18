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

/** The body of the public found-item report handler alone, comments stripped. */
function reportHandler(): string {
  const start = serverTs.indexOf("app.post('/api/items/report'");
  expect(start).toBeGreaterThan(-1);
  const rest = serverTs.slice(start);
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
    const shared = 'Aina ya kitu haikubaliki. / That item category is not valid.';
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

  it('no longer derives isSensitive from a possibly-undefined category', () => {
    const handler = reportHandler();
    // The `cat ? (...) : true` fallback is what silently concealed the miss.
    expect(handler).not.toMatch(/const isSensitive = cat \? \(cat\.is_sensitive_document !== false\) : true;/);
    expect(handler).toMatch(/const isSensitive = cat\.is_sensitive_document !== false;/);
  });
});
