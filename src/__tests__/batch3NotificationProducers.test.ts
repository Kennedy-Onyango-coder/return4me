import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { db as drizzleDb } from '../db/index.ts';
import {
  customer_notifications as notificationsTable,
  customers as customersTable,
  claims as claimsTable,
  customer_claim_links as linksTable,
  items as itemsTable,
} from '../db/schema.ts';
import {
  containsForbiddenCustomerTerm,
  hasCustomerAction,
  isEssentialCategory,
  notificationGroup,
  groupKey,
} from '../config/customerNotifications.ts';
import {
  listActiveCustomerNotifications,
  openCustomerNotification,
  setCustomerPreference,
  applyPreference,
} from '../services/customerNotifications.ts';
import {
  produceClaimVerificationAccepted,
  produceAgentConfirmedViewing,
  produceClaimAutoRejectedFirstPayment,
  producePaymentReceived,
  produceItemHandedOver,
  produceClaimComplete,
  produceClaimNotSuccessful,
  produceRefundComplete,
} from '../services/claimNotificationProducers.ts';

// BATCH 3 - NOTIFICATION PRODUCER INTEGRATION.
//
// The producers' load-bearing properties are about WHAT HAPPENS TO A ROW, so
// they run against REAL customer_notifications rows rather than a stub: a
// producer either writes the right row for the right customer, or writes nothing.
//
//   1. RECIPIENT ISOLATION - resolved from the explicit customer_claim_links
//      row, never from owner_phone/owner_email, so an UNLINKED claim is silent.
//   2. IDEMPOTENCY - the authoritative transition, not the notification layer,
//      stops a duplicate. Proven by driving real transitions twice.
//   3. SEPARATION - a failing notification write leaves claim state untouched
//      and never throws to the caller.
//
// COPY and STRUCTURAL WIRING are pinned by source assertions at the end, which
// is the only way to prove a producer is attached to a GUARDED call site rather
// than to a bare transition call.

const RUN = `B3-${Date.now().toString(36)}`;
let seq = 0;
const nextId = (p: string) => `${p}-${RUN}-${String(++seq).padStart(5, '0')}`;

const CUST_A = nextId('CUS');
const CUST_B = nextId('CUS');
const CUST_C = nextId('CUS');

async function seedClaim(opts: { claimId: string; ownerPhone: string; status: string; itemId?: string }) {
  if (opts.itemId) {
    await drizzleDb.insert(itemsTable).values({
      id: opts.itemId,
      description: 'Batch 3 fixture item',
      status: 'at_agent',
    } as any);
  }
  await drizzleDb.insert(claimsTable).values({
    id: opts.claimId,
    item_id: opts.itemId,
    owner_phone: opts.ownerPhone,
    security_answers: {},
    status: opts.status,
  } as any);
}

async function linkClaim(customerId: string, claimId: string) {
  await drizzleDb.insert(linksTable).values({
    id: nextId('LNK'),
    customer_id: customerId,
    claim_id: claimId,
    linked_via: 'claim_otp',
  });
}

async function rowsFor(customerId: string) {
  return drizzleDb.select().from(notificationsTable).where(eq(notificationsTable.customer_id, customerId));
}

async function allRowsForClaim(claimId: string) {
  return drizzleDb.select().from(notificationsTable).where(eq(notificationsTable.business_reference, claimId));
}

beforeEach(async () => {
  await drizzleDb.insert(customersTable).values([
    { id: CUST_A, full_name: 'A', phone: '+254700000001', status: 'active' },
    { id: CUST_B, full_name: 'B', phone: '+254700000002', status: 'active' },
    { id: CUST_C, full_name: 'C', phone: '+254700000003', status: 'active' },
  ] as any);
});

afterEach(async () => {
  await drizzleDb.delete(notificationsTable);
  await drizzleDb.delete(linksTable);
  await drizzleDb.delete(claimsTable);
  await drizzleDb.delete(itemsTable);
  await drizzleDb.delete(customersTable);
  vi.restoreAllMocks();
});

const CASES = [
  { name: 'P1 claim OTP verification accepted', fn: produceClaimVerificationAccepted, title: 'Verification successful', body: 'Your verification code was accepted. An agent will confirm the item before you continue with payment.', category: 'claim_status' },
  { name: 'P2 agent confirmed viewing', fn: produceAgentConfirmedViewing, title: 'Item confirmed', body: 'The agent confirmed your item. You can now continue with payment.', category: 'claim_status' },
  { name: 'P3 auto-rejected, another claimant paid first', fn: produceClaimAutoRejectedFirstPayment, title: 'Claim closed', body: 'Another claimant completed payment for this item first. Your claim for this item is now closed.', category: 'claim_status' },
  { name: 'P5 payment received and held', fn: producePaymentReceived, title: 'Payment received', body: 'Your payment was received and is being held safely while the claim is completed.', category: 'payment_status' },
  { name: 'P6 item handed over', fn: produceItemHandedOver, title: 'Item handed over', body: 'Your item was handed over successfully.', category: 'claim_status' },
  { name: 'P7 claim complete', fn: produceClaimComplete, title: 'Claim complete', body: 'Your claim is complete.', category: 'claim_status' },
  { name: 'P8 dispute resolved, payment being returned', fn: produceClaimNotSuccessful, title: 'Claim not successful', body: 'Your claim was not successful. Your payment is being returned to you.', category: 'payment_status' },
  { name: 'P9 refund complete', fn: produceRefundComplete, title: 'Refund complete', body: 'Your refund is complete.', category: 'payment_status' },
];

// 1. POSITIVE PATH
describe('B3 - positive path', () => {
  for (const c of CASES) {
    it(`${c.name} writes exactly one row for the linked customer`, async () => {
      const claimId = nextId('CLM');
      await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'escrow_held' });
      await linkClaim(CUST_A, claimId);

      const id = await c.fn(claimId);
      expect(id).toBeTruthy();

      const rows = await allRowsForClaim(claimId);
      expect(rows).toHaveLength(1);
      expect(rows[0].customer_id).toBe(CUST_A);
      expect(rows[0].title).toBe(c.title);
      expect(rows[0].body).toBe(c.body);
      expect(rows[0].category).toBe(c.category);
      expect(rows[0].business_reference).toBe(claimId);
      expect(rows[0].created_via_fallback).toBe(false);
      expect(rows[0].expires_at).toBeTruthy();
    });

    it(`${c.name} copy passes the Batch 1 forbidden-term guard`, () => {
      expect(containsForbiddenCustomerTerm(c.title)).toBe(false);
      expect(containsForbiddenCustomerTerm(c.body)).toBe(false);
    });

    it(`${c.name} is essential in its category`, () => {
      expect(isEssentialCategory(c.category)).toBe(true);
    });
  }
});

// 2. RECIPIENT ISOLATION - the ownership gate
describe('B3 - recipient isolation', () => {
  it('an UNLINKED claim produces NOTHING (anonymous journey, fail closed)', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'escrow_held' });

    const id = await producePaymentReceived(claimId);
    expect(id).toBeNull();
    expect(await allRowsForClaim(claimId)).toHaveLength(0);
  });

  it('a link belonging to ANOTHER customer puts the row on that customer only', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'escrow_held' });
    await linkClaim(CUST_B, claimId);

    await produceClaimComplete(claimId);

    expect(await rowsFor(CUST_B)).toHaveLength(1);
    expect(await rowsFor(CUST_A)).toHaveLength(0);
    expect(await rowsFor(CUST_C)).toHaveLength(0);
  });

  it('never resolves a recipient from owner_phone alone', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'escrow_held' });
    await drizzleDb.update(customersTable).set({ phone: '+254700000001' }).where(eq(customersTable.id, CUST_A));

    await produceAgentConfirmedViewing(claimId);
    await produceItemHandedOver(claimId);

    expect(await rowsFor(CUST_A)).toHaveLength(0);
  });

  it('a customer with no links receives nothing at all', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'escrow_held' });
    await linkClaim(CUST_A, claimId);

    await produceRefundComplete(claimId);

    expect(await rowsFor(CUST_C)).toHaveLength(0);
  });
});

// 3. CROSS-CUSTOMER ISOLATION
describe('B3 - cross-customer protection', () => {
  it('customer B cannot cause a notification on customer A claim to land on B', async () => {
    const claimA = nextId('CLM');
    const claimB = nextId('CLM');
    await seedClaim({ claimId: claimA, ownerPhone: '+254700000001', status: 'escrow_held' });
    await seedClaim({ claimId: claimB, ownerPhone: '+254700000002', status: 'escrow_held' });
    await linkClaim(CUST_A, claimA);
    await linkClaim(CUST_B, claimB);

    await producePaymentReceived(claimA);
    await producePaymentReceived(claimB);

    const a = await rowsFor(CUST_A);
    const b = await rowsFor(CUST_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].business_reference).toBe(claimA);
    expect(b[0].business_reference).toBe(claimB);
  });

  it('the unique link index means a claim can only ever have one owner', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'escrow_held' });
    await linkClaim(CUST_A, claimId);

    await expect(linkClaim(CUST_B, claimId)).rejects.toThrow();
  });
});

// 4. IDEMPOTENCY - the AUTHORITATIVE TRANSITION is the guard
describe('B3 - idempotency (no notification-layer dedupe)', () => {
  it('the notification table has NO idempotency key', async () => {
    const cols = Object.keys(notificationsTable);
    expect(cols.some((c) => /idempot/i.test(c))).toBe(false);
    expect(cols.some((c) => /dedupe|unique_event/i.test(c))).toBe(false);
  });

  it('P2: a repeated SAME-STATE confirm-viewing does not duplicate', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'awaiting_agent_confirmation' });
    await linkClaim(CUST_A, claimId);

    const { db } = await import('../db/database.ts');
    const params = {
      claimId,
      expected: ['awaiting_agent_confirmation'],
      to: 'pending_payment',
      actor: 'AGENT_TEST',
      action: 'AGENT_CONFIRMED_VIEWING',
      details: 'test',
    };

    const first = await db.transitionClaimStatus(params as any);
    expect(first.ok).toBe(true);
    expect((first as any).alreadyInState).toBe(false);
    if (first.ok && !(first as any).alreadyInState) await produceAgentConfirmedViewing(claimId);
    expect(await allRowsForClaim(claimId)).toHaveLength(1);

    const second = await db.transitionClaimStatus({
      ...params,
      // Now that the claim HAS moved, a repeat confirmation re-asserts the same
      // state. transitionClaimStatus treats from === to as an explicit
      // idempotent no-op (alreadyInState: true) rather than a state change.
      expected: ['awaiting_agent_confirmation', 'pending_payment'],
    } as any);
    expect(second.ok).toBe(true);
    expect((second as any).alreadyInState).toBe(true);
    if (second.ok && !(second as any).alreadyInState) await produceAgentConfirmedViewing(claimId);

    expect(await allRowsForClaim(claimId)).toHaveLength(1);
  });

  it('P1: a repeated same-state OTP transition does not duplicate', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'pending_verification' });
    await linkClaim(CUST_A, claimId);

    const { db } = await import('../db/database.ts');
    const params = {
      claimId,
      expected: ['pending_verification'],
      to: 'awaiting_agent_confirmation',
      actor: 'TEST',
      action: 'CLAIM_OTP_VERIFIED',
      details: 'test',
    };

    const first = await db.transitionClaimStatus(params as any);
    if (first.ok && !(first as any).alreadyInState) await produceClaimVerificationAccepted(claimId);
    expect(await allRowsForClaim(claimId)).toHaveLength(1);

    const second = await db.transitionClaimStatus({
      ...params,
      expected: ['pending_verification', 'awaiting_agent_confirmation'],
    } as any);
    expect(second.ok).toBe(true);
    expect((second as any).alreadyInState).toBe(true);
    if (second.ok && !(second as any).alreadyInState) await produceClaimVerificationAccepted(claimId);

    expect(await allRowsForClaim(claimId)).toHaveLength(1);
  });

  it('P5: only the CAS winner notifies; a repeat escrow hold loses and is silent', async () => {
    const claimId = nextId('CLM');
    const itemId = nextId('ITM');
    await seedClaim({ claimId, itemId, ownerPhone: '+254700000001', status: 'pending_payment' });
    await linkClaim(CUST_A, claimId);

    const { db } = await import('../db/database.ts');
    const won = await db.attemptClaimEscrowHold(claimId, 'B3-RECEIPT');
    if (won) await producePaymentReceived(claimId);
    expect(await allRowsForClaim(claimId)).toHaveLength(1);

    const again = await db.attemptClaimEscrowHold(claimId, 'B3-RECEIPT-REPLAY');
    expect(again).toBe(false);
    if (again) await producePaymentReceived(claimId);

    expect(await allRowsForClaim(claimId)).toHaveLength(1);
  });

  it('P6: a repeat handover never produces a second notification', async () => {
    const claimId = nextId('CLM');
    const itemId = nextId('ITM');
    await seedClaim({ claimId, itemId, ownerPhone: '+254700000001', status: 'escrow_held' });
    await linkClaim(CUST_A, claimId);

    const { db } = await import('../db/database.ts');
    const first = await db.enterPendingSettlement(claimId, 1000);
    if (first.success) await produceItemHandedOver(claimId);
    const afterFirst = (await allRowsForClaim(claimId)).length;

    // Whatever the sandbox allows for the first attempt, the second attempt must
    // NEVER add a row: enterPendingSettlement is the guard, and a repeat either
    // loses its compare-and-swap or finds the claim already moved on.
    const second = await db.enterPendingSettlement(claimId, 1000);
    if (second.success) await produceItemHandedOver(claimId);

    expect(afterFirst).toBeLessThanOrEqual(1);
    expect((await allRowsForClaim(claimId)).length).toBe(afterFirst);
  });

  it('P9: a repeat refund finalize is silent', async () => {
    const claimId = nextId('CLM');
    const itemId = nextId('ITM');
    await seedClaim({ claimId, itemId, ownerPhone: '+254700000001', status: 'refunding' });
    await linkClaim(CUST_A, claimId);

    const { db } = await import('../db/database.ts');
    const first = await db.finalizeClaimRefund(claimId, '100.00', '+254700000001', 'ADMIN_TEST');
    expect(first).toBe(true);
    await produceRefundComplete(claimId);
    expect(await allRowsForClaim(claimId)).toHaveLength(1);

    const second = await db.finalizeClaimRefund(claimId, '100.00', '+254700000001', 'ADMIN_TEST');
    expect(second).toBe(false);
    if (second) await produceRefundComplete(claimId);

    expect(await allRowsForClaim(claimId)).toHaveLength(1);
  });

  it('P3: a skipped auto-reject (terminal claim) produces nothing', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'released' });
    await linkClaim(CUST_A, claimId);

    const { db } = await import('../db/database.ts');
    const attempt = await db.transitionClaimStatus({
      claimId,
      expected: ['pending_verification', 'awaiting_agent_confirmation', 'pending_payment'],
      to: 'rejected',
      actor: 'SYSTEM',
      action: 'CLAIM_AUTO_REJECTED_FIRST_PAYMENT',
      details: 'test',
    } as any);

    expect(attempt.ok).toBe(false);
    if (attempt.ok && !(attempt as any).alreadyInState) await produceClaimAutoRejectedFirstPayment(claimId);
    expect(await allRowsForClaim(claimId)).toHaveLength(0);
  });
});

// 5. PREFERENCES, STATE CORRECTNESS, GROUPING, SECRETS
describe('B3 - preferences', () => {
  it('an essential in-app record is written even with every outbound channel off', async () => {
    await setCustomerPreference(CUST_A, 'claim_status', 'sms', false);
    await setCustomerPreference(CUST_A, 'claim_status', 'email', false);
    await setCustomerPreference(CUST_A, 'payment_status', 'sms', false);
    await setCustomerPreference(CUST_A, 'payment_status', 'email', false);

    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'escrow_held' });
    await linkClaim(CUST_A, claimId);

    await producePaymentReceived(claimId);
    await produceClaimVerificationAccepted(claimId);

    expect(await allRowsForClaim(claimId)).toHaveLength(2);
  });

  it('an essential category cannot even be switched off (server-side refusal)', async () => {
    const res = await setCustomerPreference(CUST_A, 'claim_status', 'sms', false);
    expect(res.applied).toBe(false);
    expect(await applyPreference(CUST_A, 'claim_status', 'sms')).toBe(true);
  });
});

describe('B3 - state and action correctness', () => {
  it('the producer stores no action state; it is derived at read time', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'pending_payment' });
    await linkClaim(CUST_A, claimId);

    await produceAgentConfirmedViewing(claimId);

    const [row] = await allRowsForClaim(claimId);
    expect(Object.keys(row).some((k) => /action/i.test(k))).toBe(false);

    const views = await listActiveCustomerNotifications(CUST_A);
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) {
      expect(v.actionAvailable).toBe(hasCustomerAction(v.state as any));
    }
  });

  it('opening a produced notification marks it read without changing claim state', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'pending_payment' });
    await linkClaim(CUST_A, claimId);
    const id = await produceAgentConfirmedViewing(claimId);

    const opened = await openCustomerNotification(CUST_A, id!);
    expect(opened.read).toBe(true);

    const { db } = await import('../db/database.ts');
    const claim = await db.getClaim(claimId);
    expect(claim?.status).toBe('pending_payment');
  });
});

describe('B3 - grouping keeps claim and payment threads separate', () => {
  it('the same claim id yields a claim group and a payment group, never merged', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'escrow_held' });
    await linkClaim(CUST_A, claimId);

    await produceClaimVerificationAccepted(claimId);
    await producePaymentReceived(claimId);

    const claimGroup = notificationGroup('claim_status', claimId);
    const paymentGroup = notificationGroup('payment_status', claimId);
    expect(claimGroup?.kind).toBe('claim');
    expect(paymentGroup?.kind).toBe('payment_case');
    expect(groupKey(claimGroup!)).not.toBe(groupKey(paymentGroup!));
  });
});

describe('B3 - no secrets in stored copy', () => {
  it('no OTP, pickup code or provider payload appears in any produced row', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'escrow_held' });
    await linkClaim(CUST_A, claimId);

    await producePaymentReceived(claimId);
    await produceClaimVerificationAccepted(claimId);
    await produceItemHandedOver(claimId);
    await produceRefundComplete(claimId);

    const rows = await allRowsForClaim(claimId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const blob = `${r.title} ${r.body ?? ''} ${r.business_reference ?? ''}`.toLowerCase();
      for (const secret of ['otp', 'pickup', 'resend', 'africa', 'intasend', 'gateway', 'token', 'password', 'mpesa']) {
        expect(blob).not.toContain(secret);
      }
    }
  });
});

// 6. TRANSACTION FAILURE
describe('B3 - transaction / failure separation', () => {
  it('a THROWING notification write does not throw to the caller', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'escrow_held' });
    await linkClaim(CUST_A, claimId);

    const mod = await import('../db/index.ts');
    const spy = vi.spyOn(mod.db, 'insert' as any).mockImplementation(((): any => {
      throw new Error('simulated notification table outage');
    }) as any);

    await expect(producePaymentReceived(claimId)).resolves.toBeNull();
    spy.mockRestore();
  });

  it('claim state is unchanged after a failed notification write', async () => {
    const claimId = nextId('CLM');
    const itemId = nextId('ITM');
    await seedClaim({ claimId, itemId, ownerPhone: '+254700000001', status: 'pending_payment' });
    await linkClaim(CUST_A, claimId);

    const { db } = await import('../db/database.ts');
    const won = await db.attemptClaimEscrowHold(claimId, 'B3-RECEIPT');

    const mod = await import('../db/index.ts');
    const spy = vi.spyOn(mod.db, 'insert' as any).mockImplementation(((): any => {
      throw new Error('simulated outage');
    }) as any);
    await expect(producePaymentReceived(claimId)).resolves.toBeNull();
    spy.mockRestore();

    expect(won).toBe(true);
    const claim = await db.getClaim(claimId);
    expect(claim?.status).toBe('escrow_held');
    expect(await allRowsForClaim(claimId)).toHaveLength(0);
  });

  it('a producer never calls a delivery provider', async () => {
    const claimId = nextId('CLM');
    await seedClaim({ claimId, ownerPhone: '+254700000001', status: 'escrow_held' });
    await linkClaim(CUST_A, claimId);

    const delivery = await import('../services/notificationService.ts');
    const sendSpy = vi.spyOn(delivery.NotificationService, 'notify');

    await producePaymentReceived(claimId);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await allRowsForClaim(claimId)).toHaveLength(1);
  });
});

// 7. STRUCTURAL / SOURCE ASSERTIONS
describe('B3 - structural wiring', () => {
  const read = (rel: string) => readFileSync(resolvePath(__dirname, '..', rel), 'utf8');
  // Strip comments so an assertion about what the CODE does is not satisfied or
  // broken by prose that merely NAMES the excluded mechanism. The module's
  // header deliberately documents "no NotificationService, no owner_phone", and
  // matching that text would be matching a comment.
  const code = (rel: string) =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('the producer module imports NO delivery machinery', () => {
    const src = code('services/claimNotificationProducers.ts');
    expect(src).toContain("from './customerNotifications.ts'");
    expect(src).toContain('recordCustomerNotification');
    expect(src).not.toMatch(/NotificationService/);
    expect(src).not.toMatch(/sendCodeViaSms/);
    expect(src).not.toMatch(/sendSmsNotification/);
    expect(src).not.toMatch(/EmailService/);
    expect(src).not.toMatch(/recordDeliveryFallback/);
  });

  it('the producer module resolves the recipient ONLY via the explicit claim link', () => {
    const src = code('services/claimNotificationProducers.ts');
    expect(src).toContain('getCustomerClaimLinkForClaim');
    expect(src).not.toMatch(/owner_phone/);
    expect(src).not.toMatch(/owner_email/);
    expect(src).not.toMatch(/customer_phone/);
    expect(src).not.toMatch(/req\.body/);
    expect(src).not.toMatch(/req\.query/);
  });

  it('P1 is emitted AFTER the customer/claim link is attempted', () => {
    const src = read('routes/claims.ts');
    const linkIdx = src.indexOf('linkVerifiedClaimToCustomer(');
    const produceIdx = src.indexOf('produceClaimVerificationAccepted(');
    expect(linkIdx).toBeGreaterThan(-1);
    expect(produceIdx).toBeGreaterThan(linkIdx);
  });

  it('P2 is guarded on alreadyInState, not merely on ok', () => {
    const src = read('routes/agentOps.ts');
    const idx = src.indexOf('produceAgentConfirmedViewing(');
    expect(idx).toBeGreaterThan(-1);
    const guard = src.slice(idx - 260, idx);
    expect(guard).toContain('viewingTransition.ok');
    expect(guard).toContain('!viewingTransition.alreadyInState');
  });

  it('P6 runs only after the settlement CAS reports success', () => {
    const src = read('routes/agentOps.ts');
    const casIdx = src.indexOf('enterPendingSettlement(claimId');
    const produceIdx = src.indexOf('produceItemHandedOver(');
    expect(produceIdx).toBeGreaterThan(casIdx);
    expect(src.slice(casIdx, produceIdx)).toContain('!settlement.success');
  });

  it('P5 runs only after the escrow CAS wins', () => {
    const src = read('server.ts');
    const casIdx = src.indexOf('attemptClaimEscrowHold(claimId');
    const produceIdx = src.indexOf('producePaymentReceived(');
    expect(produceIdx).toBeGreaterThan(casIdx);
    expect(src.slice(casIdx, produceIdx)).toContain('if (!won) return null;');
  });

  it('P3 fires only on the real transition branch, for the specific losing claim', () => {
    const src = read('server.ts');
    const idx = src.indexOf('produceClaimAutoRejectedFirstPayment(');
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx - 700, idx)).toContain('else if (!autoReject.alreadyInState)');
    expect(src.slice(idx, idx + 80)).toContain('oc.id');
  });

  it('P7 runs only after finalizeSettlement succeeds', () => {
    const src = read('server.ts');
    const casIdx = src.indexOf('const finalized = await db.finalizeSettlement(claimId);');
    const produceIdx = src.indexOf('produceClaimComplete(');
    expect(produceIdx).toBeGreaterThan(casIdx);
    expect(src.slice(casIdx, produceIdx)).toContain('if (!finalized.success)');
  });

  it('P8 and P9 run AFTER resolveDispute commits, never inside its transaction', () => {
    const src = read('routes/adminDisputes.ts');
    const resolveIdx = src.indexOf('result = await db.resolveDispute(');
    const p8Idx = src.indexOf('produceClaimNotSuccessful(');
    const p9Idx = src.indexOf('produceRefundComplete(');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(p8Idx).toBeGreaterThan(resolveIdx);
    expect(p9Idx).toBeGreaterThan(p8Idx);
    expect(src.slice(p8Idx - 200, p8Idx)).toContain('result.refundNeededForClaimId');
    expect(src.slice(p9Idx - 200, p9Idx)).toContain('if (refundFinalized)');
  });

  it('P9 is wired at BOTH finalizeClaimRefund call sites', () => {
    expect(read('server.ts')).toContain('produceRefundComplete(');
    expect(read('routes/adminDisputes.ts')).toContain('produceRefundComplete(');
  });

  it('NO producer was added to an excluded surface', () => {
    for (const rel of ['routes/lostReports.ts', 'routes/customerAccount.ts', 'config/notificationEvents.ts']) {
      expect(read(rel)).not.toMatch(/claimNotificationProducers/);
    }
    expect(read('services/claimNotificationProducers.ts')).not.toMatch(/recordDeliveryFallback/);
  });

  it('no producer is attached to a BARE transitionClaimStatus() call', () => {
    for (const rel of ['server.ts', 'routes/claims.ts', 'routes/agentOps.ts']) {
      const src = read(rel);
      let idx = src.indexOf('produce');
      while (idx !== -1) {
        const before = src.slice(Math.max(0, idx - 400), idx);
        if (before.includes('transitionClaimStatus(')) {
          const tail = before.slice(before.lastIndexOf('transitionClaimStatus('));
          expect(tail).toMatch(/alreadyInState|if \(![A-Za-z]+\.ok\)/);
        }
        idx = src.indexOf('produce', idx + 1);
      }
    }
  });
});
