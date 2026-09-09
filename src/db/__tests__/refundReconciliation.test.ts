import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// REGRESSION TESTS — A1 refund reconciliation operational workflow.
//
// Background: a refund whose provider outcome is UNKNOWN (network/timeout on the
// IntaSend call) is deliberately left with claim.status='refunding' and is NEVER
// automatically retried (money-duplication safe). But it was operationally
// orphaned: no query surfaced refunding claims, and only the dispute-resolve
// automatic path could finalize/revert them. These tests pin down the new admin
// reconciliation primitives:
//   * getRefundReconciliationClaims lists ONLY 'refunding' claims (the ones that
//     need a manual provider check) and never refunded/rejected/other states.
//   * finalizeClaimRefund is guarded on 'refunding' and idempotent (a second
//     finalize, or a finalize on a non-refunding claim, is a no-op returning
//     false) and records a REFUND_FINALIZED audit entry with the acting admin.
//   * revertClaimRefundLock is guarded on 'refunding' and idempotent (reverting
//     a non-refunding claim returns false) and records REFUND_REVERTED.
//   * a finalized/reverted claim disappears from the outstanding list.
// All behavioral (exercise the real DB layer), matching the repo's DB tests.

function claimFixtureId(label: string) {
  return `TEST-CLAIM-RECON-${label}-${testRunId}`;
}

describe('refund reconciliation: refunding claims are discoverable and safely finalizable/revertible', () => {
  const refundingFinalize = claimFixtureId('FINALIZE');
  const refundingRevert = claimFixtureId('REVERT');
  const alreadyRefunded = claimFixtureId('ALREADYREFUNDED');
  const alreadyRejected = claimFixtureId('ALREADYREJECTED');

  beforeAll(async () => {
    await ensureTestCategory('phone');

    const mk = async (itemLabel: string, claimId: string, status: string) => {
      await db.createItem({
        id: `TEST-ITEM-RECON-${itemLabel}-${testRunId}`,
        category_id: 'phone',
        photo_url: 'test-photo.jpg',
        ocr_extracted_number: null,
        ocr_extracted_name: null,
        document_number_hash: null,
        document_name_fuzzy: null,
        location_description: 'Test location',
        latitude: null,
        longitude: null,
        finder_phone: '+254700000009',
        assigned_agent_id: null,
        status: 'at_agent',
        flaggedForReview: false,
        isDescriptionOnly: false,
        description: null,
        is_sensitive_document: false,
        rejection_reason: null,
        locked_total_fee: '500',
      } as any);
      await db.createClaim({
        id: claimId,
        item_id: `TEST-ITEM-RECON-${itemLabel}-${testRunId}`,
        owner_phone: '+254700000099',
        security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
        verification_tier: 1,
        owner_id_proof_url: null,
        payment_reference: status === 'refunding' ? 'MPX-RECON-REF' : null,
        owner_identifying_details: null,
        status: status as any,
      });
    };

    await mk('FINALIZE', refundingFinalize, 'refunding');
    await mk('REVERT', refundingRevert, 'refunding');
    await mk('DONE', alreadyRefunded, 'refunded');
    await mk('REJ', alreadyRejected, 'rejected');
  });

  it('lists only claims currently in refunding (unknown-outcome refunds), never refunded/rejected ones', async () => {
    const list = await db.getRefundReconciliationClaims();
    const ids = list.map((c) => c.claimId);
    expect(ids).toContain(refundingFinalize);
    expect(ids).toContain(refundingRevert);
    expect(ids).not.toContain(alreadyRefunded);
    expect(ids).not.toContain(alreadyRejected);
    for (const item of list) {
      expect(parseFloat(item.refundAmount)).toBeGreaterThan(0);
      expect(item.ownerPhone).toBeTruthy();
      expect(item.waitingSince).toBeTruthy();
    }
  });

  it('finalize (provider confirmed EXECUTED) transitions refunding -> refunded, writes audit, and disappears from the list; a second finalize is a no-op', async () => {
    expect((await db.getClaim(refundingFinalize))?.status).toBe('refunding');

    // The server re-derives amount/recipient from the reconciliation registry,
    // then finalizes with the acting admin recorded.
    const entry = (await db.getRefundReconciliationClaims()).find((c) => c.claimId === refundingFinalize);
    expect(entry).toBeDefined();
    const finalized = await db.finalizeClaimRefund(entry!.claimId, entry!.refundAmount, entry!.ownerPhone, 'audit-admin');
    expect(finalized).toBe(true);

    expect((await db.getClaim(refundingFinalize))?.status).toBe('refunded');
    const list = await db.getRefundReconciliationClaims();
    expect(list.some((c) => c.claimId === refundingFinalize)).toBe(false);

    // Idempotency / state guard: finalizing a claim no longer refunding is a
    // no-op (returns false) — never a duplicate ledger/audit write.
    const second = await db.finalizeClaimRefund(refundingFinalize, entry!.refundAmount, entry!.ownerPhone, 'audit-admin');
    expect(second).toBe(false);

    const logs = await db.getAuditLogs();
    expect(logs.some((l) => l.action === 'REFUND_FINALIZED' && l.admin_user === 'audit-admin' && l.details.includes(refundingFinalize))).toBe(true);
  });

  it('revert (provider confirmed NOT EXECUTED) transitions refunding -> rejected, writes audit, disappears from the list; a second revert is a no-op', async () => {
    expect((await db.getClaim(refundingRevert))?.status).toBe('refunding');

    const reverted = await db.revertClaimRefundLock(refundingRevert, 'Provider confirmed not executed', 'audit-admin');
    expect(reverted).toBe(true);
    expect((await db.getClaim(refundingRevert))?.status).toBe('rejected');
    const list = await db.getRefundReconciliationClaims();
    expect(list.some((c) => c.claimId === refundingRevert)).toBe(false);

    const second = await db.revertClaimRefundLock(refundingRevert, 'Provider confirmed not executed', 'audit-admin');
    expect(second).toBe(false);

    const logs = await db.getAuditLogs();
    expect(logs.some((l) => l.action === 'REFUND_REVERTED' && l.admin_user === 'audit-admin' && l.details.includes(refundingRevert))).toBe(true);
  });

  it('finalize and revert are impossible on a claim that is not in the refunding state (no cross-state mutation)', async () => {
    const fin = await db.finalizeClaimRefund(alreadyRejected, '500', '+254700000000', 'audit-admin');
    expect(fin).toBe(false);
    const rev = await db.revertClaimRefundLock(alreadyRefunded, 'should not happen', 'audit-admin');
    expect(rev).toBe(false);
    expect((await db.getClaim(alreadyRejected))?.status).toBe('rejected');
    expect((await db.getClaim(alreadyRefunded))?.status).toBe('refunded');
  });
});
