import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { hashCode, timingSafeEqualHex, toE164Kenyan } from '../../services/auth';

// Runtime tests for the customer-account foundation primitives (same level
// claimPaymentAuth.test.ts / disputeCustody.test.ts test at). These exercise
// the real DB layer against the in-memory mock (no DATABASE_URL in CI) so the
// storage/hash/expiry/replay mechanics are proven, not merely asserted from
// source text.

// Valid, unique +254 numbers per run so a persistent local Postgres does not
// collide across repeated runs.
const base = Math.floor(10000000 + Math.random() * 89999999); // 8 digits
const national = '7' + base.toString();                        // 9 digits incl. leading 7
const PHONE_A = '+254' + national;                             // +2547XXXXXXXX
const PHONE_A_LOCAL = '0' + national;                          // 07XXXXXXXX (10 digits)
const PHONE_B = '+2547' + (base + 1).toString().slice(-8);
const PHONE_C = '+2547' + (base + 2).toString().slice(-8);
const RUN = national;

describe('customer accounts: identity and duplicates', () => {
  it('creates a customer and reads it back by normalized phone', async () => {
    const id = 'TEST-CUS-A-' + RUN;
    await db.createCustomer(id, 'Test Owner A', PHONE_A);
    const found = await db.getCustomerByPhone(PHONE_A);
    expect(found).toBeDefined();
    expect(found!.id).toBe(id);
    expect(found!.status).toBe('active');
  });

  it('duplicate normalized phone variants resolve to the SAME account (no second row)', async () => {
    const id = 'TEST-CUS-B-' + RUN;
    const created = await db.createCustomer(id, 'Test Owner B', PHONE_A);
    // '+2547XXXXXXXX' and '07XXXXXXXX' normalize to the identical value.
    expect(toE164Kenyan(PHONE_A_LOCAL)).toBe(PHONE_A);
    const viaLocal = await db.getCustomerByPhone(toE164Kenyan(PHONE_A_LOCAL));
    expect(viaLocal).toBeDefined();
    expect(viaLocal!.id).toBe(created.id);
    // A second create for the same normalized phone must NOT add an account.
    const again = await db.createCustomer('TEST-CUS-B-DUPE-' + RUN, 'Other Name', PHONE_A);
    expect(again.id).toBe(created.id);
  });

  it('reflects account status changes server-side', async () => {
    const id = 'TEST-CUS-STATUS-' + RUN;
    await db.createCustomer(id, 'Test Owner Status', PHONE_B);
    await db.updateCustomerStatus(id, 'suspended');
    const found = await db.getCustomerById(id);
    expect(found!.status).toBe('suspended');
  });
});

describe('customer OTP challenges: hash-only, expiry, attempts, replay', () => {
  it('stores only a hash of the code, never the plaintext', async () => {
    const otpId = 'TEST-COTP-HASH-' + RUN;
    const code = '123456';
    await db.createCustomerOtp(otpId, PHONE_A, 'registration', hashCode(code), new Date(Date.now() + 5 * 60 * 1000));
    const otp = await db.getActiveCustomerOtp(PHONE_A, 'registration');
    expect(otp).toBeDefined();
    expect(otp!.id).toBe(otpId);
    expect(otp!.code_hash).not.toBe(code);
    expect(otp!.code_hash).toBe(hashCode(code));
    expect(otp!.code_hash).toHaveLength(64);
  });

  it('a correct code verifies against the stored hash; a wrong one does not', async () => {
    const otpId = 'TEST-COTP-MATCH-' + RUN;
    await db.createCustomerOtp(otpId, PHONE_B, 'registration', hashCode('654321'), new Date(Date.now() + 5 * 60 * 1000));
    const otp = await db.getActiveCustomerOtp(PHONE_B, 'registration');
    expect(timingSafeEqualHex(otp!.code_hash, hashCode('654321'))).toBe(true);
    expect(timingSafeEqualHex(otp!.code_hash, hashCode('000000'))).toBe(false);
  });

  it('records the expiry window (route layer rejects an expired code)', async () => {
    const otpId = 'TEST-COTP-EXPIRY-' + RUN;
    const past = new Date(Date.now() - 1000);
    await db.createCustomerOtp(otpId, PHONE_A, 'login', hashCode('111111'), past);
    const otp = await db.getActiveCustomerOtp(PHONE_A, 'login');
    expect(otp!.expires_at.getTime()).toBeLessThan(Date.now());
  });

  it('a consumed challenge is never returned as active', async () => {
    const otpId = 'TEST-COTP-CONSUMED-' + RUN;
    await db.createCustomerOtp(otpId, PHONE_B, 'login', hashCode('222222'), new Date(Date.now() + 5 * 60 * 1000));
    expect(await db.getActiveCustomerOtp(PHONE_B, 'login')).toBeDefined();
    const consumed = await db.consumeCustomerOtp(otpId);
    expect(consumed).toBe(true);
    expect(await db.getActiveCustomerOtp(PHONE_B, 'login')).toBeUndefined();
  });

  it('is one-time use: a second consume can never win (replay protection)', async () => {
    const otpId = 'TEST-COTP-REPLAY-' + RUN;
    await db.createCustomerOtp(otpId, PHONE_A, 'login', hashCode('333333'), new Date(Date.now() + 5 * 60 * 1000));
    expect(await db.consumeCustomerOtp(otpId)).toBe(true);
    expect(await db.consumeCustomerOtp(otpId)).toBe(false);
  });

  it('enforces the attempt ceiling by burning the challenge at the limit', async () => {
    const otpId = 'TEST-COTP-ATTEMPTS-' + RUN;
    await db.createCustomerOtp(otpId, PHONE_B, 'registration', hashCode('444444'), new Date(Date.now() + 5 * 60 * 1000));
    expect(await db.incrementCustomerOtpAttempts(otpId, 5)).toBe(1);
    expect(await db.incrementCustomerOtpAttempts(otpId, 5)).toBe(2);
    expect(await db.incrementCustomerOtpAttempts(otpId, 5)).toBe(3);
    expect(await db.incrementCustomerOtpAttempts(otpId, 5)).toBe(4);
    // Still usable below the ceiling.
    expect(await db.getActiveCustomerOtp(PHONE_B, 'registration')).toBeDefined();
    expect(await db.incrementCustomerOtpAttempts(otpId, 5)).toBe(5);
    // At the ceiling the challenge is burned.
    expect(await db.getActiveCustomerOtp(PHONE_B, 'registration')).toBeUndefined();
  });

  it('binds purpose: a registration challenge is not usable for login and vice-versa', async () => {
    const otpId = 'TEST-COTP-PURPOSE-' + RUN;
    await db.createCustomerOtp(otpId, PHONE_A, 'registration', hashCode('555555'), new Date(Date.now() + 5 * 60 * 1000));
    expect(await db.getActiveCustomerOtp(PHONE_A, 'registration')).toBeDefined();
    expect(await db.getActiveCustomerOtp(PHONE_A, 'login')).toBeUndefined();
  });

  it('issuing a new challenge invalidates the previous unconsumed one', async () => {
    const phone = PHONE_C;
    const first = 'TEST-COTP-OLD-' + RUN;
    const second = 'TEST-COTP-NEW-' + RUN;
    await db.createCustomerOtp(first, phone, 'login', hashCode('666666'), new Date(Date.now() + 5 * 60 * 1000));
    await db.createCustomerOtp(second, phone, 'login', hashCode('777777'), new Date(Date.now() + 5 * 60 * 1000));
    const active = await db.getActiveCustomerOtp(phone, 'login');
    expect(active).toBeDefined();
    expect(active!.id).toBe(second);
    // The superseded challenge can no longer be consumed.
    expect(await db.consumeCustomerOtp(first)).toBe(false);
  });
});

describe('customer sessions: hash-only storage, lookup, revocation, expiry', () => {
  it('stores only the hash of the session token, never the raw token', async () => {
    const custId = 'TEST-CUS-SESS-' + RUN;
    await db.createCustomer(custId, 'Session Owner', PHONE_B);
    const rawToken = 'a'.repeat(64);
    const sessionId = 'TEST-CSESS-A-' + RUN;
    await db.createCustomerSession(sessionId, custId, hashCode(rawToken), new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    // The raw token must not resolve to a session...
    expect(await db.getCustomerSessionByTokenHash(rawToken)).toBeUndefined();
    // ...only its hash does.
    const session = await db.getCustomerSessionByTokenHash(hashCode(rawToken));
    expect(session).toBeDefined();
    expect(session!.id).toBe(sessionId);
    expect(session!.token_hash).not.toBe(rawToken);
    expect(session!.customer_id).toBe(custId);
  });

  it('belongs to exactly one customer', async () => {
    const custId = 'TEST-CUS-SESS2-' + RUN;
    await db.createCustomer(custId, 'Session Owner Two', PHONE_A);
    const rawToken = 'b'.repeat(64);
    await db.createCustomerSession('TEST-CSESS-B-' + RUN, custId, hashCode(rawToken), new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    const session = await db.getCustomerSessionByTokenHash(hashCode(rawToken));
    expect(session!.customer_id).toBe(custId);
  });

  it('records an expiry the middleware can enforce', async () => {
    const custId = 'TEST-CUS-SESS3-' + RUN;
    await db.createCustomer(custId, 'Session Owner Three', PHONE_B);
    const rawToken = 'c'.repeat(64);
    const past = new Date(Date.now() - 1000);
    await db.createCustomerSession('TEST-CSESS-C-' + RUN, custId, hashCode(rawToken), past);
    const session = await db.getCustomerSessionByTokenHash(hashCode(rawToken));
    expect(session!.expires_at.getTime()).toBeLessThan(Date.now());
  });

  it('logout revokes the stored session server-side (not just the cookie)', async () => {
    const custId = 'TEST-CUS-SESS4-' + RUN;
    await db.createCustomer(custId, 'Session Owner Four', PHONE_A);
    const rawToken = 'd'.repeat(64);
    const sessionId = 'TEST-CSESS-D-' + RUN;
    await db.createCustomerSession(sessionId, custId, hashCode(rawToken), new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    const before = await db.getCustomerSessionByTokenHash(hashCode(rawToken));
    expect(before!.revoked_at == null).toBe(true);

    const revoked = await db.revokeCustomerSession(sessionId);
    expect(revoked).toBe(true);

    const after = await db.getCustomerSessionByTokenHash(hashCode(rawToken));
    expect(after).toBeDefined();
    expect(after!.revoked_at).not.toBeNull();
    // Revocation is idempotent — a second call is a no-op, not an error.
    expect(await db.revokeCustomerSession(sessionId)).toBe(false);
  });

  it('touching last_seen_at does not invalidate the session', async () => {
    const custId = 'TEST-CUS-SESS5-' + RUN;
    await db.createCustomer(custId, 'Session Owner Five', PHONE_B);
    const rawToken = 'e'.repeat(64);
    const sessionId = 'TEST-CSESS-E-' + RUN;
    await db.createCustomerSession(sessionId, custId, hashCode(rawToken), new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    await db.touchCustomerSession(sessionId);
    const session = await db.getCustomerSessionByTokenHash(hashCode(rawToken));
    expect(session!.revoked_at == null).toBe(true);
    expect(session!.last_seen_at).toBeTruthy();
  });
});
