import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P0 REGRESSION TEST — see src/db/index.ts and sql/schema.sql comments.
//
// The actual bug this pins down: sql/schema.sql (used to bootstrap a brand
// new database) allowed 'pending_settlement' in the claims.status CHECK
// constraint, but the incremental migration path in src/db/index.ts (used
// to bring an ALREADY-bootstrapped database up to date) dropped and
// recreated that same constraint WITHOUT 'pending_settlement'. A fresh
// database and an upgraded database would silently end up with two
// different sets of allowed statuses — and on the upgraded one, every
// escrow_held -> pending_settlement transition (i.e. every successful
// item handover) would be rejected by Postgres with a CHECK violation.
//
// This sandbox has no live Postgres instance available, so this test
// cannot execute a real `UPDATE claims SET status = 'pending_settlement'`
// against Postgres and confirm the engine accepts it — that would need an
// actual database connection this environment doesn't have. What it CAN
// do, and does, is parse the three independent sources of truth for the
// allowed status set (the two raw-SQL CHECK constraint definitions, and
// the TypeScript Claim/FoundItem status union types) and assert they
// describe the exact same set. That is precisely the property that broke
// here — the three definitions drifted apart from each other — so a test
// that would have caught it is a genuine regression test, even without a
// live database. Running the actual statements against a real Postgres
// instance (e.g. in CI, or manually against a disposable database) is the
// natural follow-up verification this test cannot replace.

function extractCheckValues(sql: string, constraintMarker: string): string[] {
  const idx = sql.indexOf(constraintMarker);
  if (idx === -1) throw new Error(`Could not find constraint marker: ${constraintMarker}`);
  const afterMarker = sql.slice(idx);
  const checkMatch = afterMarker.match(/CHECK\s*\(\s*status\s+IN\s*\(([^)]+)\)\s*\)/i);
  if (!checkMatch) throw new Error(`Could not find CHECK (status IN (...)) after marker: ${constraintMarker}`);
  return checkMatch[1]
    .split(',')
    .map(s => s.trim().replace(/^'/, '').replace(/'$/, ''))
    .sort();
}

function extractTsUnionValues(ts: string, fieldMarker: string): string[] {
  const markerIdx = ts.indexOf(fieldMarker);
  if (markerIdx === -1) throw new Error(`Could not find field marker: ${fieldMarker}`);
  const statusIdx = ts.indexOf('status:', markerIdx + fieldMarker.length);
  if (statusIdx === -1) throw new Error(`Could not find a 'status:' field after marker: ${fieldMarker}`);
  const line = ts.slice(statusIdx, ts.indexOf(';', statusIdx));
  const matches = line.match(/"([a-z_]+)"/g);
  if (!matches) throw new Error(`Could not extract union values from: ${line}`);
  return matches.map(m => m.replace(/"/g, '')).sort();
}

const repoRoot = path.resolve(__dirname, '../../..');
const schemaSql = fs.readFileSync(path.join(repoRoot, 'sql/schema.sql'), 'utf8');
const indexTs = fs.readFileSync(path.join(repoRoot, 'src/db/index.ts'), 'utf8');
const databaseTs = fs.readFileSync(path.join(repoRoot, 'src/db/database.ts'), 'utf8');

describe('claims.status definitions are consistent across all sources of truth', () => {
  it('sql/schema.sql (fresh bootstrap) and src/db/index.ts (incremental migration) allow the exact same claim statuses', () => {
    const fromFreshBootstrap = extractCheckValues(schemaSql, 'CREATE TABLE claims');
    const fromIncrementalMigration = extractCheckValues(indexTs, 'claims_status_check CHECK');
    expect(fromIncrementalMigration).toEqual(fromFreshBootstrap);
  });

  it('sql/schema.sql includes pending_settlement (the actual P0 bug this test exists for)', () => {
    const fromFreshBootstrap = extractCheckValues(schemaSql, 'CREATE TABLE claims');
    expect(fromFreshBootstrap).toContain('pending_settlement');
  });

  it('src/db/index.ts incremental migration includes pending_settlement', () => {
    const fromIncrementalMigration = extractCheckValues(indexTs, 'claims_status_check CHECK');
    expect(fromIncrementalMigration).toContain('pending_settlement');
  });

  it('the TypeScript Claim["status"] union type matches both SQL definitions exactly (no drift, no dead values)', () => {
    const fromFreshBootstrap = extractCheckValues(schemaSql, 'CREATE TABLE claims');
    const fromTsType = extractTsUnionValues(databaseTs, 'verification_tier: 1 | 2 | 3;');
    expect(fromTsType).toEqual(fromFreshBootstrap);
  });
});

describe('items.status definitions are consistent across all sources of truth', () => {
  it('sql/schema.sql and src/db/index.ts allow the exact same item statuses', () => {
    const fromFreshBootstrap = extractCheckValues(schemaSql, 'CREATE TABLE items');
    const fromIncrementalMigration = extractCheckValues(indexTs, 'items_status_check CHECK');
    expect(fromIncrementalMigration).toEqual(fromFreshBootstrap);
  });

  it('both include the stolen-property review states', () => {
    const fromFreshBootstrap = extractCheckValues(schemaSql, 'CREATE TABLE items');
    expect(fromFreshBootstrap).toContain('suspected_stolen');
    expect(fromFreshBootstrap).toContain('legal_hold');
  });
});
