import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P0 REGRESSION TEST — see src/db/index.ts, ensureSchemaUpToDate().
//
// The actual bug: `ALTER TABLE admin_users ADD COLUMN totp_secret` (and
// totp_enabled) ran BEFORE `CREATE TABLE IF NOT EXISTS admin_users` in the
// incremental migration statement list. On any database where admin_users
// didn't already exist — a genuinely fresh database not bootstrapped via
// sql/schema.sql, or an old database that predates this table — both
// ALTER statements would fail with "relation admin_users does not exist"
// before the statement that actually creates the table ever ran.
//
// This test doesn't just re-check admin_users specifically — it statically
// parses every CREATE TABLE and ALTER TABLE statement in the incremental
// migration's statement list and asserts that for every table, its CREATE
// TABLE appears before any ALTER TABLE targeting the same table. That
// catches this entire class of ordering bug for every table, including
// ones added after this test was written, not just the one that actually
// broke.

const indexTs = fs.readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8');

function extractMigrationStatementsSource(): string {
  const startMarker = 'export async function ensureSchemaUpToDate';
  const startIdx = indexTs.indexOf(startMarker);
  if (startIdx === -1) throw new Error('Could not find ensureSchemaUpToDate in src/db/index.ts');
  // The statement list ends at the closing `];` of the `const statements = [` array —
  // grab a generous slice and rely on the CREATE/ALTER regexes below to only
  // pick up real statement text, not unrelated code after the array.
  const arrayStart = indexTs.indexOf('const statements = [', startIdx);
  if (arrayStart === -1) throw new Error('Could not find the statements array in ensureSchemaUpToDate');
  const arrayEnd = indexTs.indexOf('\n  ];', arrayStart);
  if (arrayEnd === -1) throw new Error('Could not find the end of the statements array');
  const raw = indexTs.slice(arrayStart, arrayEnd);
  // Strip `//` line comments — without this, a comment merely MENTIONING
  // a table name (e.g. this codebase's own explanatory comments, which
  // frequently say things like "ALTER TABLE admin_users statement...")
  // would be indistinguishable from an actual SQL statement, producing
  // false positives. Only text inside the backtick-quoted SQL strings
  // should count.
  return raw
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('incremental migration: CREATE TABLE always precedes ALTER TABLE for the same table', () => {
  const statementsSource = extractMigrationStatementsSource();

  // Position (character offset within the extracted source) of each
  // table's CREATE TABLE statement, and every ALTER TABLE position for
  // that table.
  const createPositions: Record<string, number> = {};
  const alterPositions: Record<string, number[]> = {};

  const createRegex = /CREATE TABLE(?: IF NOT EXISTS)? (\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = createRegex.exec(statementsSource)) !== null) {
    const table = m[1];
    // If a table is CREATEd more than once in this list (shouldn't happen,
    // but if it did), keep the earliest occurrence for this check's purpose.
    if (!(table in createPositions)) createPositions[table] = m.index;
  }

  const alterRegex = /ALTER TABLE (\w+)/g;
  while ((m = alterRegex.exec(statementsSource)) !== null) {
    const table = m[1];
    if (!alterPositions[table]) alterPositions[table] = [];
    alterPositions[table].push(m.index);
  }

  it('found real CREATE TABLE and ALTER TABLE statements to check (sanity check the parser works)', () => {
    expect(Object.keys(createPositions).length).toBeGreaterThan(0);
    expect(Object.keys(alterPositions).length).toBeGreaterThan(0);
  });

  it('admin_users: CREATE TABLE precedes both TOTP ALTER TABLE statements (the actual bug this test exists for)', () => {
    expect(createPositions['admin_users']).toBeDefined();
    expect(alterPositions['admin_users']?.length).toBeGreaterThan(0);
    for (const alterPos of alterPositions['admin_users']) {
      expect(alterPos).toBeGreaterThan(createPositions['admin_users']);
    }
  });

  for (const table of Object.keys(alterPositions)) {
    it(`${table}: every ALTER TABLE statement comes after its CREATE TABLE statement (if one exists in this migration list)`, () => {
      // Some tables (e.g. categories, items, claims) are created directly
      // in sql/schema.sql at fresh-bootstrap time and never re-created
      // here — only altered, for databases that already have them from an
      // earlier version. That's fine and expected; this check only
      // applies to tables whose CREATE also appears in this same list.
      if (!(table in createPositions)) return;
      for (const alterPos of alterPositions[table]) {
        expect(alterPos).toBeGreaterThan(createPositions[table]);
      }
    });
  }
});
