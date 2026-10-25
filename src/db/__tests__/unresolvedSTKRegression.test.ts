
import { afterEach, describe, it, expect, vi } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

let counter = 0;

async function makeClaimItem(suffix: string) {
  const itemId = `TEST-ITEM-STK-${suffix}-${testRunId}-${counter++}`;
  await ensureTestCategory('phone');
  return itemId;
}

async function makeClaim(itemId: string, suffix: string, status: string) {
  const claimId = `TEST-CLAIM-STK-${suffix}-${testRunId}-${counter++}`;

  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: '+254700000001',
    security_answers: {
      lastDigits: '0000',
      color: 'black',
      lostDetails: 'fixture',
    },
    verification_tier: 1,
    status: status as any,
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
  } as any);

  return claimId;
}

async function makeUnresolvedSession(claimId: string, amount: number) {
  const sessionId = `TEST-PS-STK-${testRunId}-${counter++}`;

  await db.createPaymentSession({
    id: sessionId,
    claimId,
    amount,
    payerPhone: '+254700000001',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });

  return { sessionId };
}

describe('Unresolved-STK Regression Tests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('1. Initial payment-session state', () => {
    it('creates a session without fabricating a provider invoice ID', async () => {
      const itemId = await makeClaimItem('MISSING-INV-1');
      const claimId = await makeClaim(
        itemId,
        'MISSING-INV-1',
        'pending_payment',
      );
      const { sessionId } = await makeUnresolvedSession(claimId, 500);

      const session = await db.getPaymentSessionById(sessionId);

      expect(session).toBeTruthy();
      expect(session?.status).toBe('created');
      expect(session?.provider_invoice_id).toBeUndefined();
      expect(session?.status).not.toBe('failed');
    });

    it('allows the first reservation of a newly created session', async () => {
      const itemId = await makeClaimItem('RESERVE-FIRST');
      const claimId = await makeClaim(
        itemId,
        'RESERVE-FIRST',
        'pending_payment',
      );
      const { sessionId } = await makeUnresolvedSession(claimId, 500);

      const reserved = await db.reservePaymentSession(sessionId, claimId);

      expect(reserved).toBe(true);

      const session = await db.getPaymentSessionById(sessionId);
      expect(session?.status).toBe('payment_initiated');
    });
  });

  describe('2. Invoice correlation defaults', () => {
    it('does not assign an invoice ID before a provider invoice is recorded', async () => {
      const itemId = await makeClaimItem('NO-INVOICE');
      const claimId = await makeClaim(
        itemId,
        'NO-INVOICE',
        'pending_payment',
      );
      const { sessionId } = await makeUnresolvedSession(claimId, 500);

      const session = await db.getPaymentSessionById(sessionId);

      expect(session).toBeTruthy();
      expect(session?.provider_invoice_id).toBeUndefined();
    });

    it('does not turn an uninitiated session into a failed session during creation', async () => {
      const itemId = await makeClaimItem('NO-FAKE-FAILURE');
      const claimId = await makeClaim(
        itemId,
        'NO-FAKE-FAILURE',
        'pending_payment',
      );
      const { sessionId } = await makeUnresolvedSession(claimId, 500);

      const session = await db.getPaymentSessionById(sessionId);

      expect(session?.status).toBe('created');
      expect(session?.provider_invoice_id).toBeUndefined();
    });
  });

  describe('3. Session-level retry prevention', () => {
    it('transitions a created session to payment_initiated on reservation', async () => {
      const itemId = await makeClaimItem('RETRY-FIRST');
      const claimId = await makeClaim(
        itemId,
        'RETRY-FIRST',
        'pending_payment',
      );
      const { sessionId } = await makeUnresolvedSession(claimId, 500);

      expect(await db.reservePaymentSession(sessionId, claimId)).toBe(true);

      const session = await db.getPaymentSessionById(sessionId);
      expect(session?.status).toBe('payment_initiated');
    });

    it('does not reserve the same session twice', async () => {
      const itemId = await makeClaimItem('RETRY-DUP');
      const claimId = await makeClaim(
        itemId,
        'RETRY-DUP',
        'pending_payment',
      );
      const { sessionId } = await makeUnresolvedSession(claimId, 500);

      // First reservation wins
      expect(await db.reservePaymentSession(sessionId, claimId)).toBe(true);

      // Concurrent retries on the same session: all must fail because the
      // session was already reserved above (status = 'payment_initiated').
      // The compare-and-swap UPDATE only matches status='created', so every
      // retry returns false. This is the intended 'does not reserve twice' behavior.
      const results = await Promise.all([
        db.reservePaymentSession(sessionId, claimId),
        db.reservePaymentSession(sessionId, claimId),
        db.reservePaymentSession(sessionId, claimId),
      ]);
      expect(results.filter(r => r).length).toBe(0);

      const session = await db.getPaymentSessionById(sessionId);
      expect(session?.status).toBe('payment_initiated');
    });
  });

  describe('4. Concurrent reservations', () => {
    it('allows exactly one concurrent reservation winner for the same session', async () => {
      const itemId = await makeClaimItem('CONCURRENT-SAME');
      const claimId = await makeClaim(
        itemId,
        'CONCURRENT-SAME',
        'pending_payment',
      );
      const { sessionId } = await makeUnresolvedSession(claimId, 500);

      const results = await Promise.all([
        db.reservePaymentSession(sessionId),
        db.reservePaymentSession(sessionId),
        db.reservePaymentSession(sessionId),
      ]);

      expect(results.filter((result) => result === true)).toHaveLength(1);
      expect(results.filter((result) => result === false)).toHaveLength(2);

      const session = await db.getPaymentSessionById(sessionId);
      expect(session?.status).toBe('payment_initiated');
    });
  });

  describe('5. Claim-level duplicate-dispatch prevention', () => {
    it('blocks a second session reservation while the first session is unresolved', async () => {
      const itemId = await makeClaimItem('CLAIM-LOCK-1');
      const claimId = await makeClaim(
        itemId,
        'CLAIM-LOCK-1',
        'pending_payment',
      );

      const { sessionId: firstSessionId } =
        await makeUnresolvedSession(claimId, 500);
      const { sessionId: secondSessionId } =
        await makeUnresolvedSession(claimId, 500);

      // First session wins the reservation
      expect(await db.reservePaymentSession(firstSessionId, claimId)).toBe(true);

      // This assertion tests claim-level coordination, not just the
      // session-level compare-and-swap. If it fails, the implementation
      // still permits a second session to reserve the same claim.
      expect(await db.reservePaymentSession(secondSessionId, claimId)).toBe(false);

      const firstSession = await db.getPaymentSessionById(firstSessionId);
      const secondSession = await db.getPaymentSessionById(secondSessionId);

      expect(firstSession?.status).toBe('payment_initiated');
      expect(secondSession?.status).toBe('created');
    });

    it('does not allow an unresolved payment_initiated attempt to be bypassed by creating another session', async () => {
      const itemId = await makeClaimItem('CLAIM-LOCK-2');
      const claimId = await makeClaim(
        itemId,
        'CLAIM-LOCK-2',
        'pending_payment',
      );

      const { sessionId: firstSessionId } =
        await makeUnresolvedSession(claimId, 500);

      expect(await db.reservePaymentSession(firstSessionId, claimId)).toBe(true);

      // Session creation and reservation are separate operations.
      // Creating another row must not grant permission to dispatch another
      // STK request while the first attempt may still complete.
      const { sessionId: secondSessionId } =
        await makeUnresolvedSession(claimId, 500);

      expect(await db.reservePaymentSession(secondSessionId, claimId)).toBe(false);

      expect(await db.reservePaymentSession(secondSessionId)).toBe(false);

      const firstSession = await db.getPaymentSessionById(firstSessionId);
      const secondSession = await db.getPaymentSessionById(secondSessionId);

      expect(firstSession?.status).toBe('payment_initiated');
      expect(secondSession?.status).toBe('created');
    });
  });

  describe('6. Provider outcome and callback safety requirements', () => {
    it('does not treat session creation alone as proof of provider non-acceptance', async () => {
      const itemId = await makeClaimItem('AMBIGUOUS-OUTCOME');
      const claimId = await makeClaim(
        itemId,
        'AMBIGUOUS-OUTCOME',
        'pending_payment',
      );
      const { sessionId } = await makeUnresolvedSession(claimId, 500);

      const session = await db.getPaymentSessionById(sessionId);

      expect(session?.status).toBe('created');
      expect(session?.provider_invoice_id).toBeUndefined();

      // This is a database-state assertion only. Route/service tests must
      // separately verify that an ambiguous provider outcome cannot release
      // claim-level protection or be correlated to a different session.
    });

    it('does not fabricate callback correlation for a session without an invoice ID', async () => {
      const itemId = await makeClaimItem('NO-CALLBACK-CORRELATION');
      const claimId = await makeClaim(
        itemId,
        'NO-CALLBACK-CORRELATION',
        'pending_payment',
      );
      const { sessionId } = await makeUnresolvedSession(claimId, 500);

      const session = await db.getPaymentSessionById(sessionId);

      expect(session?.provider_invoice_id).toBeUndefined();
      expect(session?.status).toBe('created');

      // This test does not invoke the webhook handler. Verify actual callback
      // correlation in a route-level test using the real handler and mocks.
    });
  });
});


describe('Ambiguous STK null-invoice persistence', () => {
  it('finalizePaymentSessionInitiated(..., null, ...) persists SQL NULL and reads back as null/undefined', async () => {
    const itemId = await makeClaimItem('NULL-PERSIST');
    const claimId = await makeClaim(itemId, 'NULL-PERSIST', 'pending_payment');
    const { sessionId } = await makeUnresolvedSession(claimId, 500);

    const reserved = await db.reservePaymentSession(sessionId, claimId);
    expect(reserved).toBe(true);

    const finalized = await db.finalizePaymentSessionInitiated(sessionId, null, '');
    expect(finalized).toBe(true);

    const session = await db.getPaymentSessionById(sessionId);
    expect(session).toBeTruthy();
    expect(session?.status).toBe('pending');
    expect(session?.provider_invoice_id == null).toBe(true);
  });

  it('keeps the claim locked against an unsafe duplicate STK attempt after an ambiguous outcome', async () => {
    const itemId = await makeClaimItem('AMB-LOCK');
    const claimId = await makeClaim(itemId, 'AMB-LOCK', 'pending_payment');
    const { sessionId: firstSessionId } = await makeUnresolvedSession(claimId, 500);
    const { sessionId: secondSessionId } = await makeUnresolvedSession(claimId, 500);

    expect(await db.reservePaymentSession(firstSessionId, claimId)).toBe(true);
    await db.finalizePaymentSessionInitiated(firstSessionId, null, '');

    expect(await db.reservePaymentSession(secondSessionId, claimId)).toBe(false);

    const first = await db.getPaymentSessionById(firstSessionId);
    const second = await db.getPaymentSessionById(secondSessionId);
    expect(first?.status).toBe('pending');
    expect(first?.provider_invoice_id == null).toBe(true);
    expect(second?.status).toBe('created');
  });
});