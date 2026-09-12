import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static-analysis test suite (same convention as paymentSessionSecurity.test.ts
// — server.ts has no exports and heavy top-level side effects, so it cannot be
// imported; instead we assert on its actual source). This suite pins the
// CLAIM EXPIRY LIFECYCLE fix: a payment-window-expired claim is an audit
// record, NOT a competing claimant, and must never trigger a dispute for a
// later legitimate claimant.

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverTs = readFileSync(resolve(__dirname, '../server.ts'), 'utf8');
const databaseTs = readFileSync(resolve(__dirname, '../db/database.ts'), 'utf8');

// Locate the claim-submission competing-claim detection block.
function submissionBlock(): string {
  const i = serverTs.indexOf('Check if there is already an active (non-disputed, non-rejected) claim');
  expect(i, 'claim-submission duplicate-detection block not found').toBeGreaterThan(-1);
  return serverTs.slice(i, i + 5000);
}

describe('claim expiry lifecycle: payment expiry != dispute', () => {
  it('defines INACTIVE_CLAIM_STATUSES with payment_window_expired (abandonment)', () => {
    expect(serverTs).toMatch(/INACTIVE_CLAIM_STATUSES\s*=\s*new Set<string>\(/);
    const setStart = serverTs.indexOf('const INACTIVE_CLAIM_STATUSES');
    expect(setStart).toBeGreaterThan(-1);
    const setBlock = serverTs.slice(setStart, setStart + 900);
    for (const status of ['payment_window_expired', 'disputed', 'rejected', 'refunded', 'released']) {
      expect(setBlock, `INACTIVE_CLAIM_STATUSES must include '${status}'`).toContain(`'${status}'`);
    }
  });

  it('same-owner resume check ignores closed (inactive) claims — an owner can retry after expiry', () => {
    const block = submissionBlock();
    const sameOwnerIdx = block.indexOf('const sameOwnerClaim');
    const existingIdx = block.indexOf('const existingClaims');
    expect(sameOwnerIdx).toBeGreaterThan(-1);
    expect(existingIdx).toBeGreaterThan(sameOwnerIdx);
    const sameOwnerFilter = block.slice(sameOwnerIdx, existingIdx);
    // The resume path must use the active-claim filter, not a bare 'disputed' check.
    expect(sameOwnerFilter).toContain('isActiveClaim(c)');
    expect(sameOwnerFilter).not.toMatch(/status !== 'disputed'/);
  });

  it('competing-claim detection ignores closed claims — an expired claim of ANOTHER phone cannot create a dispute', () => {
    const block = submissionBlock();
    const existingIdx = block.indexOf('const existingClaims');
    expect(existingIdx).toBeGreaterThan(-1);
    const filter = block.slice(existingIdx, existingIdx + 400);
    expect(filter).toContain('isActiveClaim(c)');
    expect(filter).not.toMatch(/status !== 'disputed'/);
    // Dispute creation must remain downstream of the active-only filter.
    const disputeIdx = block.indexOf('db.createDispute');
    expect(disputeIdx).toBeGreaterThan(existingIdx);
  });

  it('genuine conflict protection is intact: an ACTIVE claim from another claimant still triggers dispute creation', () => {
    const block = submissionBlock();
    // The dispute creation block and the 409 competing-claimant response must
    // still exist (we only changed WHICH claims count as competitors).
    expect(block).toMatch(/status: 'disputed'/);
    expect(block).toContain('claimant_1_claim_id: existingClaim.id');
    expect(block).toMatch(/409/);
  });

  it('canCreateClaim still blocks new claims while an unresolved dispute exists', () => {
    const i = serverTs.indexOf('async function canCreateClaim');
    expect(i).toBeGreaterThan(-1);
    const body = serverTs.slice(i, i + 3000);
    expect(body).toMatch(/hasUnresolvedDispute/);
    expect(body).toMatch(/reason: 'unresolved_dispute'/);
  });

  it('expiry is a CAS on pending_payment only — it cannot downgrade an escrowed/confirmed claim', () => {
    const i = databaseTs.indexOf('expirePendingPaymentClaim(');
    expect(i).toBeGreaterThan(-1);
    const body = databaseTs.slice(i, i + 900);
    expect(body).toContain('status: "payment_window_expired"');
    expect(body).toMatch(/eq\(claimsTable\.status, "pending_payment"\)/);
    expect(body).not.toMatch(/escrow_held|pending_settlement|released/);
  });

  it('expiry does not touch the item status — the item stays at_agent and claimable', () => {
    const i = databaseTs.indexOf('expirePendingPaymentClaim(');
    const body = databaseTs.slice(i, i + 900);
    expect(body).not.toMatch(/itemsTable|updateItemStatus|item_status/);
  });

  it('expiry creates no dispute and deletes no historical claims', () => {
    const i = databaseTs.indexOf('expirePendingPaymentClaim(');
    const body = databaseTs.slice(i, i + 900);
    expect(body).not.toContain('createDispute');
    expect(body).not.toMatch(/delete/i);
  });

  it('the item remains claimable after expiry: canCreateClaim only gates on item.status === at_agent (item is never moved by claim expiry)', () => {
    // Chain assertion: expirePendingPaymentClaim leaves items alone, and
    // canCreateClaim admits anything with item.status 'at_agent' that has no
    // unresolved dispute — so an expired payment attempt can never block a
    // legitimate retry via the item itself.
    const i = databaseTs.indexOf('expirePendingPaymentClaim(');
    expect(databaseTs.slice(i, i + 900)).not.toMatch(/itemsTable/);
    const j = serverTs.indexOf("if (item.status !== 'at_agent')");
    expect(j).toBeGreaterThan(-1);
  });
});
