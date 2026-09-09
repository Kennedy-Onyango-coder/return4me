import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// REGRESSION TEST — finalizeClaimRefund concurrency guard.
//
// The in-memory test DB is single-threaded, so a true interleaving of two
// concurrent finalize requests (or finalize-vs-revert) cannot be simulated
// here. The thing that prevents that race in real PostgreSQL is the SHAPE of
// the SQL: finalize must be an atomic compare-and-swap
//   UPDATE claims SET status='refunded' WHERE id=? AND status='refunding' RETURNING ...
// and NOT a SELECT-guard followed by an UNCONDITIONAL UPDATE (which would let
// two concurrent finalizes both write a ledger 'refund' row + audit, or let a
// finalize overwrite a concurrent revert). This static source-audit test (the
// repo's established convention for asserting SQL shape without a live
// database) locks that shape so it cannot regress to the unsafe form.
//
// The runtime state-machine behaviour (guarded + idempotent finalize/revert,
// discoverability, audit, no cross-state mutation) is covered behaviourally in
// src/db/__tests__/refundReconciliation.test.ts.

const databaseTs = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');

function finalizeBody(): string {
  const start = databaseTs.indexOf('public async finalizeClaimRefund');
  const end = databaseTs.indexOf('  // Reverts a claim', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return databaseTs.slice(start, end);
}

describe('finalizeClaimRefund uses an atomic guarded transition (concurrency-safe)', () => {
  const body = finalizeBody();

  it('transitions to refunded with a guarded WHERE status = "refunding" + RETURNING (compare-and-swap)', () => {
    expect(body).toMatch(
      /\.update\(claimsTable\)[\s\S]*?\.set\(\{ status: "refunded", updated_at: new Date\(\) \}\)[\s\S]*?\.where\(and\(eq\(claimsTable\.id, claimId\), eq\(claimsTable\.status, "refunding"\)\)\)[\s\S]*?\.returning\(\);/
    );
  });

  it('does NOT use a SELECT-guard followed by an unconditional status UPDATE (the duplicate-ledger race)', () => {
    // The old unsafe pattern: read 'refunding' via .select() then a blind
    // UPDATE .where(id) with no status condition.
    expect(body).not.toMatch(/const claimRows = await tx[\s\S]*?\.where\(and\(eq\(claimsTable\.id, claimId\), eq\(claimsTable\.status, "refunding"\)\)\)/);
    expect(body).not.toMatch(/\.set\(\{ status: "refunded", updated_at: new Date\(\) \}\)\.where\(eq\(claimsTable\.id, claimId\)\);/);
    // .select() must not be the guard; only the conditional UPDATE is.
    expect(body).toMatch(/\.returning\(\)/);
  });

  it('writes the ledger refund row and audit only after the guarded transition wins', () => {
    expect(body).toMatch(/if \(updatedRows\.length === 0\) return false;/);
    expect(body).toMatch(/tx\.insert\(ledgerTable\)/);
    expect(body).toMatch(/type: "refund"/);
  });
});
