import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// BATCH 3 — APPROVAL AND PAYOUT ARE SEPARATE, AND THE PAYOUT MUST BE THE
// APPROVED ONE.
// =============================================================================
// The pure rule is exhaustively unit-tested in
// config/__tests__/settlementAuthorizationSnapshot.test.ts and the persistence is
// covered by db/__tests__/settlementAuthorizationSnapshot.test.ts. This file
// pins the SEAMS and the SCHEMA PARITY, which a unit test cannot:
//
//   * the executor compares the approval snapshot with the claim's payout rows
//     BEFORE any durable pre-submission marker, and refuses through
//     abandonRelease();
//   * the approval write captures the snapshot inside the SAME transaction, only
//     after the approval CAS wins, and a snapshot that cannot be built aborts
//     the transaction (so no approval exists without one);
//   * all three schema declarations carry the same two columns.
//
// A future change that removes the comparison, moves it after the markers, or
// writes the approval without its snapshot fails here first.
// =============================================================================

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const SERVER = read('src/server.ts');
const DATABASE = read('src/db/database.ts');
const DRIZZLE = read('src/db/schema.ts');
const SQL = read('sql/schema.sql');
const MIGRATIONS = read('src/db/index.ts');

const EXECUTOR = (() => {
  const start = SERVER.indexOf('async function executeClaimSettlement');
  expect(start, 'executeClaimSettlement must exist').toBeGreaterThan(-1);
  return SERVER.slice(start);
})();

const APPROVAL = (() => {
  const start = DATABASE.indexOf('public async approveSettlement(');
  expect(start, 'approveSettlement must exist').toBeGreaterThan(-1);
  const end = DATABASE.indexOf('public async getClaimsEligibleForSettlementReview(', start);
  expect(end, 'the method after approveSettlement must exist').toBeGreaterThan(start);
  return DATABASE.slice(start, end);
})();

describe('the executor pays only what the approval covered', () => {
  it('compares the snapshot before any durable submission marker', () => {
    const compareAt = EXECUTOR.indexOf('compareSettlementAuthorization(');
    const markerAt = EXECUTOR.indexOf('await db.markPayoutSubmissionStarted(');
    expect(compareAt, 'the approval comparison must exist in the executor').toBeGreaterThan(-1);
    expect(markerAt, 'the pre-submission marker must exist').toBeGreaterThan(-1);
    expect(compareAt).toBeLessThan(markerAt);
  });

  it('refuses through abandonRelease() and records the refusal', () => {
    const compareAt = EXECUTOR.indexOf('compareSettlementAuthorization(');
    const refusal = EXECUTOR.slice(compareAt, compareAt + 2200);
    expect(refusal).toContain("'SETTLEMENT_AUTHORIZATION_MISMATCH'");
    expect(refusal).toContain('return await abandonRelease(');
    // A legacy approval is REPORTED, never silently treated as a match.
    expect(refusal).toContain("'SETTLEMENT_AUTHORIZATION_SNAPSHOT_MISSING'");
    expect(refusal).toContain("authorizationVerdict.code === 'legacy_approval'");
  });

  it('compares against every payout row of the claim, not only the outstanding ones', () => {
    const compareAt = EXECUTOR.indexOf('compareSettlementAuthorization(');
    const block = EXECUTOR.slice(compareAt, compareAt + 900);
    expect(block).toContain('claimLedgerRows');
    expect(block).toContain("row.type === 'finder_payout' || row.type === 'agent_payout'");
  });
});

describe('the approval write captures the snapshot transactionally', () => {
  it('writes both snapshot columns', () => {
    expect(APPROVAL).toContain('settlement_authorized_total:');
    expect(APPROVAL).toContain('settlement_authorized_ledger_ids:');
  });

  it('captures the snapshot only AFTER the approval CAS wins', () => {
    const cas = APPROVAL.indexOf('.update(claimsTable)');
    const ifWon = APPROVAL.indexOf('if (rows.length > 0) {');
    const build = APPROVAL.indexOf('buildSettlementAuthorizationSnapshot(');
    expect(cas).toBeGreaterThan(-1);
    expect(ifWon).toBeGreaterThan(cas);
    expect(build).toBeGreaterThan(ifWon);
  });

  it('aborts the transaction when the snapshot cannot be built', () => {
    const build = APPROVAL.indexOf('buildSettlementAuthorizationSnapshot(');
    const throwAt = APPROVAL.indexOf('throw new SettlementAuthorizationSnapshotUnreadable(');
    expect(throwAt).toBeGreaterThan(build);
    // ...and the catch turns that rollback into a refusal the route can report.
    expect(DATABASE).toContain("code: 'payout_ledger_unreadable'");
    expect(DATABASE).toContain('class SettlementAuthorizationSnapshotUnreadable extends Error');
  });
});

describe('the snapshot columns are declared in all three schema sources', () => {
  it('drizzle schema', () => {
    expect(DRIZZLE).toContain('settlement_authorized_total: numeric(');
    expect(DRIZZLE).toContain('settlement_authorized_ledger_ids: text(');
  });

  it('bootstrap SQL', () => {
    expect(SQL).toContain('settlement_authorized_total NUMERIC(10, 2)');
    expect(SQL).toContain('settlement_authorized_ledger_ids TEXT');
  });

  it('idempotent incremental migration', () => {
    expect(MIGRATIONS).toContain(
      'ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_authorized_total NUMERIC(10,2)',
    );
    expect(MIGRATIONS).toContain(
      'ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_authorized_ledger_ids TEXT',
    );
  });
});
