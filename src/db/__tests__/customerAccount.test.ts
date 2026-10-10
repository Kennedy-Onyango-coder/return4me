import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../database';
import { db as drizzleDb } from '../index.ts';
import { customer_otps as customerOtpsTable, customer_identity_changes as identityChangesTable } from '../schema.ts';
import { hashCode, timingSafeEqualHex, toE164Kenyan } from '../../services/auth';
import { IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS } from '../../config/customerAccountPolicy';

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

  it('charges CONCURRENT wrong codes exactly once each and never past the ceiling', async () => {
    // D-1B. The counter used to be a read-modify-write: the value was read, one
    // was added in JavaScript and the absolute result written back, so guesses
    // arriving together could overwrite one another's increment and the ceiling
    // could be walked past without it ever firing. Twelve simultaneous failures
    // against a ceiling of five must therefore:
    //   * charge every round exactly once (a lost increment would show up as more
    //     than one caller reporting the same completed round),
    //   * never store a count above the ceiling, and
    //   * leave the challenge burned and unusable.
    const otpId = 'TEST-COTP-CONC-' + RUN;
    const phone = PHONE_C;
    await db.createCustomerOtp(otpId, phone, 'registration', hashCode('888888'), new Date(Date.now() + 5 * 60 * 1000));

    const results = await Promise.all(
      Array.from({ length: 12 }, () => db.incrementCustomerOtpAttempts(otpId, 5)),
    );

    // Exactly one caller completed the first round: with a lost update, several
    // would report 1 and the challenge would still be alive below the ceiling.
    expect(results.filter((r) => r === 1)).toHaveLength(1);
    // Nothing may ever report more than the ceiling.
    expect(Math.max(...results)).toBe(5);

    const [row] = await drizzleDb.select().from(customerOtpsTable).where(eq(customerOtpsTable.id, otpId));
    expect(Number(row.attempt_count)).toBe(5);
    // At the ceiling the challenge is burned, so it can no longer be spent.
    expect(await db.getActiveCustomerOtp(phone, 'registration')).toBeUndefined();
  });

  it('counts a challenge whose attempt counter was never written (legacy row)', async () => {
    // `attempt_count` is NOT NULL with a default of 0, so this is only reachable
    // for a row written before the column existed. The compare-and-swap must
    // still match it (IS NULL), otherwise the first wrong guess against such a
    // row would report the ceiling without ever charging anything — leaving the
    // code guessable for as long as it lives.
    const otpId = 'TEST-COTP-LEGACY-' + RUN;
    const phone = PHONE_A;
    await drizzleDb.insert(customerOtpsTable).values({
      id: otpId,
      phone,
      purpose: 'legacy_probe',
      code_hash: hashCode('999999'),
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
    } as any);

    expect(await db.incrementCustomerOtpAttempts(otpId, 5)).toBe(1);
    expect(await db.incrementCustomerOtpAttempts(otpId, 5)).toBe(2);
    const [row] = await drizzleDb.select().from(customerOtpsTable).where(eq(customerOtpsTable.id, otpId));
    expect(Number(row.attempt_count)).toBe(2);
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

// -----------------------------------------------------------------------------
// D-1F — IDENTITY-CHANGE ATTEMPT COUNTER: THE SAME CONCURRENCY GUARANTEE AS THE
// CUSTOMER-OTP COUNTER ABOVE, for the counter that bounds guesses at the code
// which repoints an account's email or phone.
//
// That counter used to be a read-modify-write: the total was read, one was added
// in JavaScript and the absolute result written back unconditionally, so guesses
// arriving together overwrote one another's increment — and the five-guess ceiling
// is the whole defence against walking a six-digit space inside the 30-minute TTL,
// so a ceiling a parallel burst can outrun is not a ceiling. These tests pin the
// bounded compare-and-swap that replaced it. They run against the same in-memory
// mock as the OTP tests above (no DATABASE_URL in CI), which evaluates UPDATE
// WHERE predicates and returns the matched rows, and whose every statement is
// awaited — so overlapping calls genuinely interleave and a lost update shows up
// here rather than only in production.
//
// The retry loop's own BOUND is pinned statically instead (finalEmailAuthGate,
// which reads database.ts as source): a single-threaded test double cannot be made
// to lose CUSTOMER_IDENTITY_CHANGE_ATTEMPT_CAS_ROUNDS swaps in a row without
// arbitrary sleeps, which would be a flaky test. What the loop GUARANTEES is
// observable here: a charge that lands is counted exactly once, the total never
// passes the ceiling, it is never reset or reduced, and every path that cannot
// charge fails CLOSED by reporting the ceiling.
// -----------------------------------------------------------------------------
describe('customer identity changes: atomic attempt ceiling', () => {
  const CEILING = IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS;

  /**
   * A fresh owner per scenario. `createCustomerIdentityChange` retires any other
   * LIVE change for the same (customer, kind), so two scenarios sharing an owner
   * would burn one another's rows and prove nothing.
   */
  let ownerScenario = 400;
  async function seedOwner() {
    ownerScenario += 1;
    const id = 'TEST-CICH-OWNER' + ownerScenario + '-' + RUN;
    const phone = '+2547' + (base + ownerScenario).toString().slice(-8);
    await db.createCustomer(id, 'Identity Change Owner ' + ownerScenario, phone);
    return id;
  }

  async function seedChange(owner: string, label: string) {
    const id = 'TEST-CICH-' + label + '-' + RUN;
    await db.createCustomerIdentityChange({
      id,
      customerId: owner,
      kind: 'phone',
      targetValue: '+2547' + '9'.repeat(8),
      codeHash: hashCode('424242'),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    return id;
  }

  const charge = (id: string, customerId: string, maxAttempts = CEILING) =>
    db.incrementCustomerIdentityChangeAttempts({ id, customerId, maxAttempts });

  it('charges CONCURRENT wrong codes exactly once each and burns the change at the ceiling', async () => {
    const owner = await seedOwner();
    const id = await seedChange(owner, 'CONC');

    const results = await Promise.all(Array.from({ length: 12 }, () => charge(id, owner)));

    // Exactly one caller completed the first round. Under the old read-modify-write
    // many of them reported 1, because each overwrote the others' increment.
    expect(results.filter((r) => r === 1)).toHaveLength(1);
    // No caller may ever be told the total is above the ceiling.
    expect(Math.max(...results)).toBe(CEILING);

    const row = await db.getIdentityChangeById(id, owner);
    // Every landed charge is counted: a lost update would leave this BELOW the
    // ceiling, with the change still alive and still guessable.
    expect(Number(row.attempt_count)).toBe(CEILING);
    // The charge that reached the ceiling burned the change...
    expect(row.consumed_at).not.toBeNull();
    // ...so it can never be redeemed again, by anyone, even with the correct code.
    expect(await db.consumeCustomerIdentityChange({ id, customerId: owner })).toBe(false);
  });

  it('burns only in the write that reaches the ceiling and never stores more', async () => {
    const owner = await seedOwner();
    const id = await seedChange(owner, 'CEIL');

    // Below the ceiling the change is still alive, with its budget reduced.
    for (let i = 1; i < CEILING; i++) {
      expect(await charge(id, owner)).toBe(i);
    }
    const alive = await db.getIdentityChangeById(id, owner);
    expect(Number(alive.attempt_count)).toBe(CEILING - 1);
    expect(alive.consumed_at == null).toBe(true);

    // The charge that reaches the ceiling burns the change in the SAME statement.
    expect(await charge(id, owner)).toBe(CEILING);
    const burned = await db.getIdentityChangeById(id, owner);
    expect(Number(burned.attempt_count)).toBe(CEILING);
    expect(burned.consumed_at).not.toBeNull();

    // A further wrong code is refused at the sentinel, and cannot push the stored
    // total past the ceiling.
    expect(await charge(id, owner)).toBe(CEILING);
    expect(Number((await db.getIdentityChangeById(id, owner)).attempt_count)).toBe(CEILING);
  });

  it('counts a change whose attempt counter was never written (legacy row)', async () => {
    // `attempt_count` is NOT NULL DEFAULT 0, so this row shape is only reachable
    // for a row written before the column existed (the mock does not enforce NOT
    // NULL; Postgres fills in the default). The compare-and-swap must still match
    // such a row (IS NULL), otherwise the first wrong guess against it would report
    // the ceiling without charging anything — leaving the code guessable for as
    // long as it lives.
    const owner = await seedOwner();
    const id = 'TEST-CICH-LEGACY-' + RUN;
    await drizzleDb.insert(identityChangesTable).values({
      id,
      customer_id: owner,
      kind: 'phone',
      target_value: '+2547' + '8'.repeat(8),
      code_hash: hashCode('999999'),
      expires_at: new Date(Date.now() + 30 * 60 * 1000),
      consumed_at: null,
      created_at: new Date(),
    } as any);

    expect(await charge(id, owner)).toBe(1);
    expect(await charge(id, owner)).toBe(2);
    const [row] = await drizzleDb
      .select()
      .from(identityChangesTable)
      .where(eq(identityChangesTable.id, id));
    expect(Number(row.attempt_count)).toBe(2);
  });

  it('fails CLOSED when it cannot charge, and never resets or lowers the stored total', async () => {
    const owner = await seedOwner();
    const other = await seedOwner();

    // (1) An id that does not resolve for this customer reports the CEILING, not
    // zero. Zero was the old answer on this path, and it is the one value the
    // route does NOT treat as a lockout.
    expect(await charge('TEST-CICH-NOPE-' + RUN, owner)).toBe(CEILING);

    // (2) A change belonging to ANOTHER customer resolves to nothing at all — the
    // cross-customer rule the rest of this batch uses — and is charged nothing.
    const foreign = await seedChange(owner, 'FOREIGN');
    expect(await charge(foreign, other)).toBe(CEILING);
    // The row was charged NOTHING. `|| 0` normalizes this suite's in-memory double,
    // whose INSERT path does not apply the column's DEFAULT 0 the way Postgres does,
    // so an untouched counter reads back as undefined there — and it still catches a
    // charge, because any positive total survives the `|| 0`.
    expect(Number((await db.getIdentityChangeById(foreign, owner)).attempt_count) || 0).toBe(0);

    // (3) A change already burned by a successful redemption can never be charged
    // again, and the total it had reached is not reset or reduced by the attempt.
    const burned = await seedChange(owner, 'BURNED');
    expect(await charge(burned, owner)).toBe(1);
    expect(await charge(burned, owner)).toBe(2);
    expect(await db.consumeCustomerIdentityChange({ id: burned, customerId: owner })).toBe(true);
    expect(await charge(burned, owner)).toBe(CEILING);
    expect(Number((await db.getIdentityChangeById(burned, owner)).attempt_count)).toBe(2);
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
