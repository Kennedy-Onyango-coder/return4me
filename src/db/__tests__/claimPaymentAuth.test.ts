import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../database';
import { hashCode, timingSafeEqualHex } from '../../services/auth';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// Regression test for the claim payment-authorization token added to close
// a real gap: /api/claims/:id/pay used to accept a bare claim ID (with an
// optional, unenforced phone check) as sufficient to trigger a real M-Pesa
// STK push. Now /pay requires a short-lived token minted by
// /api/claims/:id/payment-auth, which itself requires a phone match. This
// test exercises the DB primitive directly (setClaimPaymentAuthToken /
// getClaimPaymentAuthToken) — the same level financialInvariants.test.ts
// and disputeCustody.test.ts test at — proving the storage/expiry/hash
// mechanics are correct regardless of which route calls them.

describe('claim payment authorization token store', () => {
  // claim_payment_auth_tokens.claim_id has a real FK to claims(id), which in
  // turn references items(id); the mock enforces neither. Create the parent
  // rows so the fixture is valid against real Postgres too.
  const PAYAUTH_CLAIMS = [
    `TEST-CLAIM-PAYAUTH-A-${testRunId}`,
    `TEST-CLAIM-PAYAUTH-B-${testRunId}`,
    `TEST-CLAIM-PAYAUTH-C-${testRunId}`,
    `TEST-CLAIM-PAYAUTH-D-${testRunId}`,
    `TEST-CLAIM-PAYAUTH-E-${testRunId}`,
  ];
  beforeAll(async () => {
    await ensureTestCategory('phone');
    await db.createItem({
      id: `TEST-ITEM-PAYAUTH-${testRunId}`,
      category_id: 'phone',
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'Test location',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000005',
      assigned_agent_id: null,
      status: 'at_agent',
      flaggedForReview: false,
      isDescriptionOnly: false,
      description: null,
      is_sensitive_document: false,
      rejection_reason: null,
    } as any);
    for (const claimId of PAYAUTH_CLAIMS) {
      await db.createClaim({
        id: claimId,
        item_id: `TEST-ITEM-PAYAUTH-${testRunId}`,
        owner_phone: '+254700000006',
        security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
        verification_tier: 1,
        status: 'pending_payment',
        owner_id_proof_url: null,
        payment_reference: null,
        owner_identifying_details: null,
      });
    }
  });

  it('round-trips a token hash and expiry for a claim', async () => {
    const claimId = `TEST-CLAIM-PAYAUTH-A-${testRunId}`;
    const rawToken = 'a'.repeat(64); // stand-in for crypto.randomBytes(32).toString('hex')
    const tokenHash = hashCode(rawToken);
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);

    await db.setClaimPaymentAuthToken(claimId, tokenHash, expiresAt);
    const record = await db.getClaimPaymentAuthToken(claimId);

    expect(record).toBeDefined();
    expect(record!.token_hash).toBe(tokenHash);
    expect(record!.expires_at.getTime()).toBe(expiresAt.getTime());
    // The stored value is a hash, never the raw token.
    expect(record!.token_hash).not.toBe(rawToken);
  });

  it('a correct raw token verifies against the stored hash via timingSafeEqualHex', async () => {
    const claimId = `TEST-CLAIM-PAYAUTH-B-${testRunId}`;
    const rawToken = 'b'.repeat(64);
    await db.setClaimPaymentAuthToken(claimId, hashCode(rawToken), new Date(Date.now() + 20 * 60 * 1000));

    const record = await db.getClaimPaymentAuthToken(claimId);
    expect(timingSafeEqualHex(hashCode(rawToken), record!.token_hash)).toBe(true);
  });

  it('a wrong raw token does NOT verify against the stored hash', async () => {
    const claimId = `TEST-CLAIM-PAYAUTH-C-${testRunId}`;
    const rawToken = 'c'.repeat(64);
    const wrongToken = 'd'.repeat(64);
    await db.setClaimPaymentAuthToken(claimId, hashCode(rawToken), new Date(Date.now() + 20 * 60 * 1000));

    const record = await db.getClaimPaymentAuthToken(claimId);
    expect(timingSafeEqualHex(hashCode(wrongToken), record!.token_hash)).toBe(false);
  });

  it('an expired token is stored as expired (route layer is responsible for rejecting it)', async () => {
    const claimId = `TEST-CLAIM-PAYAUTH-D-${testRunId}`;
    const rawToken = 'e'.repeat(64);
    const pastExpiry = new Date(Date.now() - 1000);
    await db.setClaimPaymentAuthToken(claimId, hashCode(rawToken), pastExpiry);

    const record = await db.getClaimPaymentAuthToken(claimId);
    expect(record!.expires_at.getTime()).toBeLessThan(Date.now());
  });

  it('re-authorizing the same claim overwrites the previous token (old token stops matching)', async () => {
    const claimId = `TEST-CLAIM-PAYAUTH-E-${testRunId}`;
    const firstToken = 'f'.repeat(64);
    const secondToken = 'g'.repeat(64);

    await db.setClaimPaymentAuthToken(claimId, hashCode(firstToken), new Date(Date.now() + 20 * 60 * 1000));
    await db.setClaimPaymentAuthToken(claimId, hashCode(secondToken), new Date(Date.now() + 20 * 60 * 1000));

    const record = await db.getClaimPaymentAuthToken(claimId);
    expect(timingSafeEqualHex(hashCode(firstToken), record!.token_hash)).toBe(false);
    expect(timingSafeEqualHex(hashCode(secondToken), record!.token_hash)).toBe(true);
  });

  it('returns undefined for a claim that never had a token issued', async () => {
    const record = await db.getClaimPaymentAuthToken('TEST-CLAIM-PAYAUTH-NEVER-ISSUED');
    expect(record).toBeUndefined();
  });
});
