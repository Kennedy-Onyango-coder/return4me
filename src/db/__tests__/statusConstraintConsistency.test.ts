import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
// E3A — the single source of the ledger payout submission-outcome vocabulary,
// imported so the three representations below are asserted against the real
// generated list rather than a hand-copied one.
import { PAYOUT_OUTCOME_VALUES, PAYOUT_OUTCOME_SQL_LIST } from '../../config/payoutOutcomes';

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
// E3A — the Drizzle schema definition is the third place the ledger's payout
// outcome vocabulary is declared, so the cross-representation suite below reads
// it directly rather than trusting sql/schema.sql alone.
const schemaTs = fs.readFileSync(path.join(repoRoot, 'src/db/schema.ts'), 'utf8');
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

// ===========================================================================
// E3A — THE LEDGER'S PAYOUT SUBMISSION-OUTCOME VOCABULARY
// ===========================================================================
// Why this belongs in THIS file: it is the same class of defect the two suites
// above exist for. `ledger.payout_outcome` decides whether a payout may be sent
// to the provider again, and it is declared in three independent places (the
// Drizzle schema, the fresh-bootstrap SQL, and the runtime incremental DDL). If
// any one of them drifted from `PAYOUT_OUTCOME_VALUES`, a database created one
// way could accept a value the others reject — or, worse, a value the retry rule
// does not recognize, which would fail closed silently and strand a legitimate
// payout. The predicate is therefore generated from the single list and pinned
// here in every representation.
// ===========================================================================
describe('E3A — ledger.payout_outcome is declared identically in all three schema representations', () => {
  const predicate = `CHECK (payout_outcome IS NULL OR payout_outcome IN (${PAYOUT_OUTCOME_SQL_LIST}))`;

  it('the vocabulary itself is closed, and NULL is deliberately NOT a member', () => {
    expect(PAYOUT_OUTCOME_VALUES).toEqual([
      'not_submitted', 'submitting', 'accepted', 'unknown', 'rejected', 'completed',
    ]);
    // NULL means "no submission history recorded" and must stay outside the
    // enumerated list: it is the value every pre-existing row carries, and the
    // retry rule treats it as unresolved (fail closed), never as "never
    // submitted".
    expect(PAYOUT_OUTCOME_VALUES as readonly string[]).not.toContain('null');
    expect(predicate).toContain('payout_outcome IS NULL OR');
  });

  it('sql/schema.sql (fresh bootstrap) declares it as an UNNAMED inline column CHECK', () => {
    // Unnamed is what makes Postgres name the constraint
    // ledger_payout_outcome_check — the exact name the incremental migration
    // drops and re-adds. Naming it differently in one place is the documented
    // startup-failure class (see schemaSyncIdempotency.test.ts).
    const block = schemaSql.slice(
      schemaSql.indexOf('CREATE TABLE ledger ('),
      schemaSql.indexOf('-- 7. AUDIT LOG'),
    ).replace(/\s+/g, ' ');
    expect(block).toContain(predicate);
    // Never NOT NULL, and never a bare column with no vocabulary constraint at
    // all: existing rows must stay valid AND an invalid value must be refused.
    expect(block).not.toContain('payout_outcome VARCHAR(20) NOT NULL');
    expect(block).not.toMatch(/payout_outcome VARCHAR\(20\),/);
  });

  it('src/db/index.ts (incremental migration) re-asserts the same predicate after a matching DROP', () => {
    const statements = indexTs.replace(/\s+/g, ' ');
    expect(statements).toContain(
      'ALTER TABLE ledger ADD COLUMN IF NOT EXISTS payout_outcome VARCHAR(20)',
    );
    expect(statements).toContain(
      'ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_payout_outcome_check',
    );
    expect(statements).toContain(
      `ALTER TABLE ledger ADD CONSTRAINT ledger_payout_outcome_check ${predicate}`,
    );
  });

  it('src/db/schema.ts (Drizzle) generates its named CHECK from the same single list', () => {
    expect(schemaTs).toContain('ledger_payout_outcome_check');
    expect(schemaTs).toContain('PAYOUT_OUTCOME_SQL_LIST');
    expect(schemaTs).toMatch(/payout_outcome: varchar\("payout_outcome", \{ length: 20 \}\)/);
  });

  it('no representation ever BACKFILLS a historical row into a submittable state', () => {
    // A backfill of 'not_submitted' (or any value) onto existing rows would
    // re-authorize a transfer that may already have been executed. The column
    // is additive and nullable for exactly that reason.
    expect(indexTs).not.toMatch(/UPDATE ledger SET payout_outcome/i);
    expect(schemaSql).not.toMatch(/UPDATE ledger SET payout_outcome/i);
  });
});
