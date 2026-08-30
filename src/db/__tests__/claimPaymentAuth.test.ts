import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { hashCode, timingSafeEqualHex } from '../../services/auth';

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
  it('round-trips a token hash and expiry for a claim', async () => {
    const claimId = 'TEST-CLAIM-PAYAUTH-A';
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
    const claimId = 'TEST-CLAIM-PAYAUTH-B';
    const rawToken = 'b'.repeat(64);
    await db.setClaimPaymentAuthToken(claimId, hashCode(rawToken), new Date(Date.now() + 20 * 60 * 1000));

    const record = await db.getClaimPaymentAuthToken(claimId);
    expect(timingSafeEqualHex(hashCode(rawToken), record!.token_hash)).toBe(true);
  });

  it('a wrong raw token does NOT verify against the stored hash', async () => {
    const claimId = 'TEST-CLAIM-PAYAUTH-C';
    const rawToken = 'c'.repeat(64);
    const wrongToken = 'd'.repeat(64);
    await db.setClaimPaymentAuthToken(claimId, hashCode(rawToken), new Date(Date.now() + 20 * 60 * 1000));

    const record = await db.getClaimPaymentAuthToken(claimId);
    expect(timingSafeEqualHex(hashCode(wrongToken), record!.token_hash)).toBe(false);
  });

  it('an expired token is stored as expired (route layer is responsible for rejecting it)', async () => {
    const claimId = 'TEST-CLAIM-PAYAUTH-D';
    const rawToken = 'e'.repeat(64);
    const pastExpiry = new Date(Date.now() - 1000);
    await db.setClaimPaymentAuthToken(claimId, hashCode(rawToken), pastExpiry);

    const record = await db.getClaimPaymentAuthToken(claimId);
    expect(record!.expires_at.getTime()).toBeLessThan(Date.now());
  });

  it('re-authorizing the same claim overwrites the previous token (old token stops matching)', async () => {
    const claimId = 'TEST-CLAIM-PAYAUTH-E';
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
