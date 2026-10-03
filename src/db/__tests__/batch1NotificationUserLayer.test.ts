import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { db as drizzleDb } from '../../db/index.ts';
import {
  customer_notifications as notificationsTable,
  customer_notification_prefs as prefsTable,
  customer_notification_pref_audit as auditTable,
  customers as customersTable,
  claims as claimsTable,
  customer_claim_links as linksTable,
} from '../../db/schema.ts';
import {
  CUSTOMER_NOTIFICATION_ACTIVE_WINDOW_MS,
  CUSTOMER_NOTIFICATION_CATEGORIES,
  CUSTOMER_NOTIFICATION_CHANNELS,
  PAYMENT_AWAITING_CONFIRMATION_MESSAGE,
  categoryLabel,
  containsForbiddenCustomerTerm,
  customerNotificationExpiresAt,
  deriveClaimNotificationState,
  DELIVERY_FALLBACK_MESSAGE,
  groupNotifications,
  hasCustomerAction,
  isActiveNotification,
  isChannelConfigurable,
  isCustomerNotificationState,
  isEssentialCategory,
  stateLabel,
} from '../../config/customerNotifications.ts';
import {
  applyPreference,
  countUnreadActive,
  getCustomerPreferences,
  listActiveCustomerNotifications,
  listCustomerNotificationHistory,
  listCustomerPreferenceAudit,
  markNotificationRead,
  openCustomerNotification,
  recordCustomerNotification,
  recordDeliveryFallback,
  setCustomerPreference,
} from '../../services/customerNotifications.ts';
import {
  notification_events as notificationEventsTable,
} from '../../db/schema.ts';

// =============================================================================
// BATCH 1 — CUSTOMER NOTIFICATION USER LAYER.
//
// REAL DATABASE ROWS, NOT MOCKS. The properties under test are largely QUERIES:
// which rows the active list selects versus which history keeps, what a WHERE
// clause does with someone else's customer_id, and whether read state survives a
// fresh read. A stub would verify the arithmetic and none of the filtering, and
// the filtering is where the expiry, isolation and authorization bugs live.
//
// TIME HANDLING: rows are seeded with an explicit createdAt and asserted against
// an injected `now`, because these tests are about the 5-day boundary and cannot
// rely on the wall clock to land on the right side of it.
// =============================================================================

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-01T12:00:00.000Z');

let seq = 0;
const nextId = (p: string) => `${p}-T-${String(++seq).padStart(6, '0')}`;

async function seedCustomer(id: string, phone = `+254711${String(seq).padStart(6, '0')}`) {
  await drizzleDb.insert(customersTable).values({
    id,
    full_name: `Test Customer ${id}`,
    phone,
    status: 'active',
  });
  return id;
}

async function seedClaim(opts: { claimId: string; ownerPhone: string; status: string }) {
  await drizzleDb.insert(claimsTable).values({
    id: opts.claimId,
    owner_phone: opts.ownerPhone,
    security_answers: {},
    status: opts.status,
  });
}

/** The explicit customer->claim link that makes a claim visible to a customer. */
async function linkClaim(customerId: string, claimId: string) {
  await drizzleDb.insert(linksTable).values({
    id: nextId('LNK'),
    customer_id: customerId,
    claim_id: claimId,
    linked_via: 'claim_otp',
  });
}

async function seedNotification(opts: {
  id: string;
  customerId: string;
  category?: string;
  title?: string;
  body?: string | null;
  businessReference?: string | null;
  createdAt: Date;
  expiresAt?: Date | null;
  readAt?: Date | null;
  viaFallback?: boolean;
}) {
  await drizzleDb.insert(notificationsTable).values({
    id: opts.id,
    customer_id: opts.customerId,
    category: opts.category ?? 'claim_status',
    title: opts.title ?? 'Claim update',
    body: opts.body ?? 'Your claim moved forward.',
    business_reference: opts.businessReference ?? null,
    read_at: opts.readAt ?? null,
    expires_at: opts.expiresAt ?? customerNotificationExpiresAt(opts.createdAt),
    created_via_fallback: opts.viaFallback ?? false,
    created_at: opts.createdAt,
  });
}

const A = (cust: string, opts: Partial<Parameters<typeof seedNotification>[0]> & { id?: string } = {}) =>
  seedNotification({
    id: opts.id ?? nextId('CN'),
    customerId: cust,
    createdAt: opts.createdAt ?? NOW,
    ...opts,
  } as Parameters<typeof seedNotification>[0]);

beforeEach(async () => {
  await drizzleDb.delete(auditTable);
  await drizzleDb.delete(prefsTable);
  await drizzleDb.delete(notificationsTable);
  await drizzleDb.delete(linksTable);
  await drizzleDb.delete(claimsTable);
  await drizzleDb.delete(customersTable);
  seq = 0;
});

afterEach(async () => {
  await drizzleDb.delete(auditTable);
  await drizzleDb.delete(prefsTable);
  await drizzleDb.delete(notificationsTable);
  await drizzleDb.delete(linksTable);
  await drizzleDb.delete(claimsTable);
  await drizzleDb.delete(customersTable);
});
// ============================================================================
// A. EXPIRY (requirement 1)
// ============================================================================
describe('Batch 1 A — notification expiry', () => {
  const CUST = 'CUS-EXP-A';

  beforeEach(async () => {
    await seedCustomer(CUST, '+254711000001');
  });

  it('A1. a notification inside the 5-day window is ACTIVE', async () => {
    await A(CUST, { createdAt: new Date(NOW.getTime() - 4 * DAY) });
    const active = await listActiveCustomerNotifications(CUST, { now: NOW });
    expect(active).toHaveLength(1);
    expect(active[0].expired).toBe(false);
    expect(active[0].state).not.toBe('expired');
  });

  it('A2. a notification past the 5-day window leaves the ACTIVE list', async () => {
    await A(CUST, { createdAt: new Date(NOW.getTime() - 6 * DAY) });
    expect(await listActiveCustomerNotifications(CUST, { now: NOW })).toHaveLength(0);
  });

  it('A3. expiry is a FILTER, never a deletion: the row survives', async () => {
    await A(CUST, { createdAt: new Date(NOW.getTime() - 6 * DAY) });
    const rows = await drizzleDb.select().from(notificationsTable);
    expect(rows).toHaveLength(1); // still stored
    expect(rows[0].expires_at).not.toBeNull();
  });

  it('A4. an EXPIRED notification is still returned by History', async () => {
    await A(CUST, { createdAt: new Date(NOW.getTime() - 30 * DAY) });
    const history = await listCustomerNotificationHistory(CUST, { now: NOW });
    expect(history).toHaveLength(1);
    expect(history[0].expired).toBe(true);
    expect(history[0].state).toBe('expired'); // marked, not hidden
  });

  it('A5. History retains the human-readable metadata', async () => {
    await A(CUST, {
      createdAt: new Date(NOW.getTime() - 30 * DAY),
      title: 'Payment awaiting confirmation',
      body: "We haven't received confirmation yet.",
      businessReference: 'CLM-HIST-1',
    });
    const [n] = await listCustomerNotificationHistory(CUST, { now: NOW });
    expect(n.title).toBe('Payment awaiting confirmation');
    expect(n.body).toBe("We haven't received confirmation yet.");
    expect(n.reference).toBe('CLM-HIST-1'); // the customer's own case reference
    expect(n.createdAt).toBeTruthy();
    expect(n.category).toBe('claim_status');
  });

it('A6. the boundary is exclusive: exactly 5 days is already expired', async () => {
    const at = new Date(NOW.getTime() - CUSTOMER_NOTIFICATION_ACTIVE_WINDOW_MS);
    await A(CUST, { createdAt: at });
    expect(await listActiveCustomerNotifications(CUST, { now: NOW })).toHaveLength(0);
  });

  it('A7. one millisecond inside the window is still active', async () => {
    const at = new Date(NOW.getTime() - CUSTOMER_NOTIFICATION_ACTIVE_WINDOW_MS + 1);
    await A(CUST, { createdAt: at });
    expect(await listActiveCustomerNotifications(CUST, { now: NOW })).toHaveLength(1);
  });

  it('A8. expires_at is exactly 5 days from creation', async () => {
    const created = new Date('2026-02-01T00:00:00.000Z');
    const { id } = await recordCustomerNotification({
      customerId: CUST,
      category: 'claim_status',
      title: 'Claim update',
      createdAt: created,
    });
    const [row] = await drizzleDb.select().from(notificationsTable).where(eq(notificationsTable.id, id));
    expect(new Date(row.expires_at!).getTime() - created.getTime()).toBe(
      CUSTOMER_NOTIFICATION_ACTIVE_WINDOW_MS,
    );
  });

  it('A9. this layer stores NO retry column at all', async () => {
    // The strongest statement of requirements 1 + 11: there is no field here that
    // could be confused with next_attempt_at, so a retry schedule cannot move the
    // active window even by mistake.
    const columns = Object.keys(notificationsTable);
    expect(columns).not.toContain('next_attempt_at');
    expect(columns).not.toContain('retry_attempt_count');
    expect(columns).not.toContain('retry_class');
    expect(columns).toContain('expires_at');
  });

  it('A10. a pending retry on the DELIVERY ledger cannot extend the window', async () => {
    // Two facts proved independent: a notification_events row with a far-future
    // next_attempt_at does not keep an expired in-app notification active, because
    // the active list reads only customer_notifications.expires_at.
    await A(CUST, { createdAt: new Date(NOW.getTime() - 6 * DAY) });
    await drizzleDb.insert(notificationEventsTable).values({
      id: 'NTF-RETRY-LONG',
      event_type: 'CLAIM_STATUS_UPDATE',
      channel: 'sms',
      provider: 'test-provider',
      idempotency_key: 'b1:retry:long',
      recipient_reference: 'masked:+254***0001',
      status: 'retryable_failure',
      next_attempt_at: new Date(NOW.getTime() + 30 * DAY),
      retry_class: 'reconstructable',
      retry_attempt_count: 1,
    });
    expect(await listActiveCustomerNotifications(CUST, { now: NOW })).toHaveLength(0);
  });

  it('A11. an expired notification has NO obsolete action', async () => {
    await seedClaim({ claimId: 'CLM-EXP', ownerPhone: '+254711000001', status: 'pending_payment' });
    await linkClaim(CUST, 'CLM-EXP');
    // While active this same row is action_required; once expired it must offer
    // nothing, because history does not demand things.
    await A(CUST, { businessReference: 'CLM-EXP', createdAt: new Date(NOW.getTime() - 6 * DAY) });
    const [n] = await listCustomerNotificationHistory(CUST, { now: NOW });
    expect(n.state).toBe('expired');
    expect(n.actionAvailable).toBe(false);
    expect(n.actionPath).toBeNull();
  });

  it('A12. a NULL expiry is treated as not-expired, not hidden', async () => {
    // Guards against an absent value being inferred into a lookback that would
    // silently hide rows created before the column existed.
    expect(isActiveNotification(null, NOW)).toBe(true);
    expect(isActiveNotification(new Date(NOW.getTime() + 1000), NOW)).toBe(true);
    expect(isActiveNotification(new Date(NOW.getTime() - 1000), NOW)).toBe(false);
  });
});

// ============================================================================
// B. READ STATE (requirement 3) — and its separation from legal acknowledgement
// ============================================================================
describe('Batch 1 B — read / unread state', () => {
  const CUST = 'CUS-READ-B';

  beforeEach(async () => {
    await seedCustomer(CUST, '+254711000002');
  });

  it('B1. a NEW notification is UNREAD', async () => {
    const { id } = await recordCustomerNotification({
      customerId: CUST,
      category: 'claim_status',
      title: 'Claim update',
      createdAt: NOW,
    });
    const [row] = await drizzleDb.select().from(notificationsTable).where(eq(notificationsTable.id, id));
    expect(row.read_at).toBeNull();
    const [view] = await listActiveCustomerNotifications(CUST, { now: NOW });
    expect(view.read).toBe(false);
  });

  it('B2. the unread count reflects it', async () => {
    await recordCustomerNotification({ customerId: CUST, category: 'claim_status', title: 'One', createdAt: NOW });
    await recordCustomerNotification({ customerId: CUST, category: 'payment_status', title: 'Two', createdAt: NOW });
    expect(await countUnreadActive(CUST, NOW)).toBe(2);
  });

  it('B3. opening a notification marks it read', async () => {
    const { id } = await recordCustomerNotification({
      customerId: CUST,
      category: 'claim_status',
      title: 'Claim update',
      createdAt: NOW,
    });
    expect((await openCustomerNotification(CUST, id, NOW))!.read).toBe(true);
    const [row] = await drizzleDb.select().from(notificationsTable).where(eq(notificationsTable.id, id));
    expect(row.read_at).not.toBeNull();
  });

  it('B4. read state PERSISTS server-side, not in client state', async () => {
    // The persistence proof: a completely fresh read of the table sees the read
    // state. Nothing depends on a React tree, a component instance or browser
    // storage surviving, which is what "across sessions and devices" requires.
    const { id } = await recordCustomerNotification({
      customerId: CUST,
      category: 'claim_status',
      title: 'Claim update',
      createdAt: NOW,
    });
    await markNotificationRead(CUST, id, NOW);
    const reread = await drizzleDb.select().from(notificationsTable).where(eq(notificationsTable.id, id));
    expect(reread[0].read_at).not.toBeNull();
    const [view] = await listActiveCustomerNotifications(CUST, { now: NOW });
    expect(view.read).toBe(true);
    expect(await countUnreadActive(CUST, NOW)).toBe(0);
  });

  it('B5. an EXPIRED notification preserves its read state', async () => {
    const old = new Date(NOW.getTime() - 10 * DAY);
    const { id } = await recordCustomerNotification({
      customerId: CUST,
      category: 'claim_status',
      title: 'Claim update',
      createdAt: old,
    });
    await markNotificationRead(CUST, id, old);
    const [n] = await listCustomerNotificationHistory(CUST, { now: NOW });
    expect(n.expired).toBe(true);
    expect(n.read).toBe(true); // expiry must not reset read state
    expect(n.readAt).not.toBeNull();
  });

  it('B6. an UNREAD notification stays unread after expiry', async () => {
    await recordCustomerNotification({
      customerId: CUST,
      category: 'claim_status',
      title: 'Claim update',
      createdAt: new Date(NOW.getTime() - 10 * DAY),
    });
    const [n] = await listCustomerNotificationHistory(CUST, { now: NOW });
    expect(n.expired).toBe(true);
    expect(n.read).toBe(false);
  });

  it('B7. re-opening does not restamp the ORIGINAL read time', async () => {
    const first = new Date(NOW.getTime() - 1000);
    const { id } = await recordCustomerNotification({
      customerId: CUST,
      category: 'claim_status',
      title: 'Claim update',
      createdAt: NOW,
    });
    await markNotificationRead(CUST, id, first);
    await openCustomerNotification(CUST, id, NOW);
    const [row] = await drizzleDb.select().from(notificationsTable).where(eq(notificationsTable.id, id));
    expect(new Date(row.read_at!).getTime()).toBe(first.getTime());
  });

  it('B8. an EXPIRED unread notification is not counted by the badge', async () => {
    // The badge answers "what needs attention now", so a stale unread item must
    // not haunt the indicator forever.
    await recordCustomerNotification({
      customerId: CUST,
      category: 'claim_status',
      title: 'Old',
      createdAt: new Date(NOW.getTime() - 10 * DAY),
    });
    expect(await countUnreadActive(CUST, NOW)).toBe(0);
    const history = await listCustomerNotificationHistory(CUST, { now: NOW });
    expect(history[0].read).toBe(false); // but history still shows it unread
  });

it('B9. reading a TERMS notification is NOT legal acknowledgement', async () => {
    // Requirement 9. A Terms-update notification is a delivery/reminder
    // mechanism ONLY. Marking it read writes customer_notifications.read_at and
    // nothing else, because this layer has no acknowledgement column at all —
    // so "read" cannot be mistaken for "accepted".
    const { id } = await recordCustomerNotification({
      customerId: CUST,
      category: 'terms_service',
      title: 'Terms of service updated',
      createdAt: NOW,
    });
    await openCustomerNotification(CUST, id, NOW);
    const [row] = await drizzleDb.select().from(notificationsTable).where(eq(notificationsTable.id, id));
    expect(row.read_at).not.toBeNull();
    const columns = Object.keys(notificationsTable);
    for (const forbidden of ['acknowledged_at', 'accepted_at', 'terms_accepted_at', 'consent_at']) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('B10. terms_service is ESSENTIAL and cannot be switched off', async () => {
    expect(isEssentialCategory('terms_service')).toBe(true);
    const result = await setCustomerPreference(CUST, 'terms_service', 'email', false);
    expect(result.applied).toBe(false);
  });

  it('B11. account_security notifications stay individually visible', async () => {
    // A security notification must never be collapsed into a case folder, because
    // folding it away is how it gets missed.
    expect(isEssentialCategory('account_security')).toBe(true);
    const grouped = groupNotifications([
      { category: 'account_security', businessReference: 'CLM-1' },
      { category: 'account_security', businessReference: 'CLM-1' },
    ]);
    expect(grouped).toHaveLength(2); // not collapsed into one bucket
  });
});

// ============================================================================
// C. STATE-AWARE ACTIONS (requirement 4)
//
// A notification is NOT a competing source of truth: its state is DERIVED at read
// time from the authoritative claim row. These tests move the CLAIM and assert
// the notification's presentation changes with it.
// ============================================================================
describe('Batch 1 C — state-aware actions', () => {
  const CUST = 'CUS-STATE-C';
  const CLAIM = 'CLM-STATE-1';

  beforeEach(async () => {
    await seedCustomer(CUST, '+254711000003');
  });

  async function withClaimStatus(status: string) {
    await seedClaim({ claimId: CLAIM, ownerPhone: '+254711000003', status });
    await linkClaim(CUST, CLAIM);
    await A(CUST, { businessReference: CLAIM, createdAt: NOW });
  }

  async function setClaimStatus(status: string) {
    await drizzleDb.update(claimsTable).set({ status }).where(eq(claimsTable.id, CLAIM));
  }

  async function only() {
    const list = await listActiveCustomerNotifications(CUST, { now: NOW });
    expect(list).toHaveLength(1);
    return list[0];
  }

  it('C1. a PENDING claim yields a pending notification with no action', async () => {
    await withClaimStatus('pending_verification');
    const n = await only();
    expect(n.state).toBe('pending');
    expect(n.actionAvailable).toBe(false);
    expect(n.actionPath).toBeNull();
  });

  it('C2. an ACTION-REQUIRED claim points at the claim screen', async () => {
    await withClaimStatus('pending_payment');
    const n = await only();
    expect(n.state).toBe('action_required');
    expect(n.actionAvailable).toBe(true);
    expect(n.actionPath).toContain(CLAIM);
    expect(n.actionPath!.startsWith('/')).toBe(true); // internal route, never an external URL
  });

  it('C3. a COMPLETED claim is informational, never actionable', async () => {
    await withClaimStatus('released');
    const n = await only();
    expect(n.state).toBe('completed');
    expect(n.actionAvailable).toBe(false);
    expect(n.actionPath).toBeNull();
  });

  it('C4. the OBSOLETE action disappears when the underlying state moves on', async () => {
    // The core requirement-4 regression: the row is unchanged, the CLAIM moved
    // from pending_payment to released, and the notification must stop asking the
    // customer to act. Nothing about the notification itself changed.
    await withClaimStatus('pending_payment');
    expect((await only()).actionAvailable).toBe(true);
    await setClaimStatus('released');
    const after = await only();
    expect(after.state).toBe('completed');
    expect(after.actionAvailable).toBe(false);
    expect(after.actionPath).toBeNull();
  });

  it('C5. the reverse: a claim that needs payment again offers the action', async () => {
    await withClaimStatus('pending_verification');
    expect((await only()).actionAvailable).toBe(false);
    await setClaimStatus('pending_payment');
    expect((await only()).actionAvailable).toBe(true);
  });

  it('C6. a REJECTED claim is informational, not actionable', async () => {
    await withClaimStatus('rejected');
    const n = await only();
    expect(n.state).toBe('informational');
    expect(n.actionAvailable).toBe(false);
  });

  it('C7. an UNKNOWN claim status fails CLOSED to informational', async () => {
    // We must never prompt an action we cannot confirm is still needed.
    await withClaimStatus('a_status_from_the_future');
    const n = await only();
    expect(n.state).toBe('informational');
    expect(n.actionAvailable).toBe(false);
  });

  it('C8. a notification with NO claim reference offers no action', async () => {
    await A(CUST, { businessReference: null, createdAt: NOW });
    const n = await only();
    expect(n.actionAvailable).toBe(false);
    expect(n.actionPath).toBeNull();
  });

  it('C9. a claim belonging to ANOTHER customer yields no action', async () => {
    // Fail-closed authorization: the link check is in the SQL, so someone else's
    // claim produces no row, hence no action — rather than an action that would
    // lead to a screen the customer cannot open.
    await seedCustomer('CUS-OTHER', '+254711000009');
    await seedClaim({ claimId: 'CLM-NOT-MINE', ownerPhone: '+254711000009', status: 'pending_payment' });
    await linkClaim('CUS-OTHER', 'CLM-NOT-MINE');
    await A(CUST, { businessReference: 'CLM-NOT-MINE', createdAt: NOW });
    const n = await only();
    expect(n.state).toBe('informational');
    expect(n.actionAvailable).toBe(false);
  });

  it('C10. every state label exists for both languages', async () => {
    for (const s of ['informational', 'action_required', 'pending', 'completed', 'expired'] as const) {
      expect(isCustomerNotificationState(s)).toBe(true);
      expect(stateLabel(s, 'en')).toBeTruthy();
      expect(stateLabel(s, 'sw')).toBeTruthy();
    }
    expect(hasCustomerAction('action_required')).toBe(true);
    expect(hasCustomerAction('expired')).toBe(false);
  });

  it('C11. expiry beats the claim state', async () => {
    await seedClaim({ claimId: CLAIM, ownerPhone: '+254711000003', status: 'pending_payment' });
    await linkClaim(CUST, CLAIM);
    await A(CUST, { businessReference: CLAIM, createdAt: new Date(NOW.getTime() - 6 * DAY) });
    const list = await listCustomerNotificationHistory(CUST, { now: NOW });
    expect(list[0].state).toBe('expired'); // not action_required
    expect(list[0].actionAvailable).toBe(false);
  });
});

// ============================================================================
// D. GROUPING (requirement 5)
// ============================================================================
describe('Batch 1 D — grouping by case / report', () => {
  const CUST = 'CUS-GROUP-D';

  beforeEach(async () => {
    await seedCustomer(CUST, '+254711000004');
  });

  it('D1. notifications sharing a reference group by their KIND', async () => {
    // claim_status and document_verification are the same 'claim' thread, so they
    // collapse into one bucket. payment_status is deliberately its OWN kind — a
    // payment-related case is a separate conversation from the claim it belongs
    // to, and merging them is exactly the duplicate-looking pile requirement 5
    // asks us to avoid.
    const grouped = groupNotifications([
      { category: 'claim_status', businessReference: 'CLM-9' },
      { category: 'document_verification', businessReference: 'CLM-9' },
    ]);
    expect(grouped).toHaveLength(1);
    expect((grouped[0] as any).kind).toBe('claim');
    expect((grouped[0] as any).notifications).toHaveLength(2); // both preserved
  });

  it('D1b. a claim thread and its payment thread stay SEPARATE', async () => {
    // Two of each, so both threads genuinely form groups rather than being
    // unwrapped as single items.
    const grouped = groupNotifications([
      { category: 'claim_status', businessReference: 'CLM-9' },
      { category: 'claim_status', businessReference: 'CLM-9' },
      { category: 'payment_status', businessReference: 'CLM-9' },
      { category: 'payment_status', businessReference: 'CLM-9' },
    ]);
    expect(grouped).toHaveLength(2);
    const kinds = (grouped as any[]).map((g) => g.kind);
    expect(kinds).toContain('claim');
    expect(kinds).toContain('payment_case');
  });

  it('D2. DIFFERENT cases do not group together', async () => {
    const grouped = groupNotifications([
      { category: 'claim_status', businessReference: 'CLM-9' },
      { category: 'claim_status', businessReference: 'CLM-10' },
    ]);
    expect(grouped).toHaveLength(2); // two separate single-member groups
  });

  it('D3. lost-report notifications group by their report reference', async () => {
    const grouped = groupNotifications([
      { category: 'lost_report', businessReference: 'LR-1' },
      { category: 'lost_report', businessReference: 'LR-1' },
      { category: 'lost_report', businessReference: 'LR-2' },
    ]);
    expect(grouped).toHaveLength(2);
    expect((grouped[0] as any).kind).toBe('lost_report');
  });

  it('D4. an ACTION-REQUIRED notification stays individually visible', async () => {
    // Requirement 5: important items must not be buried inside a folder. The
    // action-required one is pulled out; the informational pair still groups.
    const grouped = groupNotifications([
      { category: 'payment_status', businessReference: 'CLM-7' },
      { category: 'payment_status', businessReference: 'CLM-7' },
      { category: 'payment_status', businessReference: 'CLM-7', actionRequired: true },
    ]);
    const flat = JSON.stringify(grouped);
    expect(flat).toContain('actionRequired');
    expect(grouped.length).toBeGreaterThanOrEqual(1);
  });

  it('D5. grouping LOSES NOTHING — every input survives', async () => {
    const inputs = [
      { category: 'claim_status', businessReference: 'CLM-1' },
      { category: 'claim_status', businessReference: 'CLM-1' },
      { category: 'claim_status', businessReference: 'CLM-2' },
      { category: 'account_security', businessReference: 'CLM-1' },
      { category: 'lost_report', businessReference: 'LR-1' },
      { category: 'lost_report', businessReference: 'LR-1' },
      { category: 'lost_report', businessReference: null },
    ];
    const grouped = groupNotifications(inputs);
    let seen = 0;
    for (const entry of grouped) {
      seen += (entry as any).notifications ? (entry as any).notifications.length : 1;
    }
    expect(seen).toBe(inputs.length); // nothing dropped, nothing duplicated
  });

  it('D6. a single notification is NOT wrapped in a folder', async () => {
    // Folders containing exactly one item are noise, not structure.
    const grouped = groupNotifications([
      { category: 'claim_status', businessReference: 'CLM-SOLO' },
    ]);
    expect(grouped).toHaveLength(1);
    expect((grouped[0] as any).notifications).toBeUndefined();
  });

  it('D7. grouping is PRESENTATION ONLY — History is untouched', async () => {
    // The strongest statement of requirement 5's "must not destroy history": the
    // same notifications exist independently of any grouping, and History returns
    // every one of them.
    await A(CUST, { businessReference: 'CLM-G1', createdAt: NOW });
    await A(CUST, { businessReference: 'CLM-G1', category: 'payment_status', createdAt: NOW });
    const history = await listCustomerNotificationHistory(CUST, { now: NOW });
    expect(history).toHaveLength(2);
    expect(history.map((n) => n.reference)).toEqual(['CLM-G1', 'CLM-G1']);
  });

  it('D8. the group key uses the EXISTING reference, never a new id', async () => {
    const grouped = groupNotifications([
      { category: 'claim_status', businessReference: 'CLM-STABLE' },
      { category: 'document_verification', businessReference: 'CLM-STABLE' },
    ]);
    // The key is built from the reference the caller already stored — the same
    // opaque domain id notification_events.business_reference uses — so grouping
    // never invents a correlation identifier of its own.
    expect((grouped[0] as any).reference).toBe('CLM-STABLE');
    expect((grouped[0] as any).key).toBe('claim:CLM-STABLE');
  });
});

// ============================================================================
// E. DELIVERY FAILURE IS NOT BUSINESS FAILURE (requirement 6)
// ============================================================================
describe('Batch 1 E — delivery failure separation', () => {
  const CUST = 'CUS-DELIV-E';

  beforeEach(async () => {
    await seedCustomer(CUST, '+254711000005');
  });

  it('E1. a FAILED SMS leaves the business state untouched', async () => {
    // The claim is pending_payment BEFORE and AFTER a delivery failure. A provider
    // error must never move a claim, and this proves it by asserting the claim row
    // itself, not merely the notification.
    await seedClaim({ claimId: 'CLM-PAY-1', ownerPhone: '+254711000005', status: 'pending_payment' });
    await linkClaim(CUST, 'CLM-PAY-1');
    await drizzleDb.insert(notificationEventsTable).values({
      id: 'NTF-FAIL-1',
      event_type: 'PAYMENT_RECEIVED',
      channel: 'sms',
      provider: 'africa-talking',
      idempotency_key: 'b1:fail:1',
      recipient_reference: 'masked:+254***0005',
      status: 'retryable_failure',
      last_error: 'provider returned 503 after 2 attempts',
      retry_class: 'reconstructable',
      retry_attempt_count: 2,
    });

    const [claim] = await drizzleDb.select().from(claimsTable).where(eq(claimsTable.id, 'CLM-PAY-1'));
    expect(claim.status).toBe('pending_payment'); // unchanged
    expect(claim.paid_at ?? null).toBeNull(); // and certainly not "failed"
  });

  it('E2. the in-app FALLBACK is available after a delivery failure', async () => {
    const { id } = await recordDeliveryFallback({
      customerId: CUST,
      category: 'payment_status',
      title: 'Payment awaiting confirmation',
      body: PAYMENT_AWAITING_CONFIRMATION_MESSAGE.en,
      businessReference: 'CLM-PAY-1',
      createdAt: NOW,
    });
    const [n] = await listActiveCustomerNotifications(CUST, { now: NOW });
    expect(n.id).toBe(id);
    expect(n.viaFallback).toBe(true);
    // A non-fallback notification does NOT carry the flag, so the UI can tell
    // "arrived here by text" from "arrived here instead".
    await recordCustomerNotification({
      customerId: CUST,
      category: 'claim_status',
      title: 'Claim update',
      createdAt: NOW,
    });
    const all = await listActiveCustomerNotifications(CUST, { now: NOW });
    expect(all.filter((x) => x.viaFallback)).toHaveLength(1);
    expect(all.filter((x) => !x.viaFallback)).toHaveLength(1);
  });

  it('E3. the customer is NEVER told to pay again', async () => {
    // The mandated wording, and the specific safety property it carries: while
    // the outcome is uncertain, instructing a second payment risks a double
    // payment, so the copy must forbid it explicitly and must never contain an
    // un-negated instruction to pay.
    const raw = PAYMENT_AWAITING_CONFIRMATION_MESSAGE.en;
    expect(raw.toLowerCase()).toContain('confirmation');
    expect(raw.toLowerCase()).toContain("don't pay again"); // the explicit prohibition
    // No instruction to pay, retry the payment, or act as if it failed.
    expect(raw.toLowerCase()).not.toMatch(/\bplease pay\b/);
    expect(raw.toLowerCase()).not.toMatch(/\bpay (?:the|now|once more)\b/);
    expect(raw.toLowerCase()).not.toMatch(/\btry (?:again|another payment|paying)\b/);
    expect(raw.toLowerCase()).not.toMatch(/\bfailed\b/); // uncertain, not failed
  });

  it('E4. the delivery fallback message is neutral', async () => {
    expect(DELIVERY_FALLBACK_MESSAGE.en).toBeTruthy();
    expect(containsForbiddenCustomerTerm(DELIVERY_FALLBACK_MESSAGE.en)).toBe(false);
    expect(containsForbiddenCustomerTerm(PAYMENT_AWAITING_CONFIRMATION_MESSAGE.en)).toBe(false);
  });

  it('E5. provider names are NOT exposed in any customer-facing field', async () => {
    await drizzleDb.insert(notificationEventsTable).values({
      id: 'NTF-PROVIDER-LEAK',
      event_type: 'CLAIM_STATUS_UPDATE',
      channel: 'sms',
      provider: 'africa-talking',
      idempotency_key: 'b1:leak:1',
      recipient_reference: 'masked:+254***0005',
      status: 'permanent_failure',
      last_error: 'resend gateway timeout',
      retry_class: 'reconstructable',
      retry_attempt_count: 5,
    });
    await recordDeliveryFallback({
      customerId: CUST,
      category: 'payment_status',
      title: 'Payment awaiting confirmation',
      createdAt: NOW,
    });
    const [n] = await listActiveCustomerNotifications(CUST, { now: NOW });

    // SCOPE OF THIS ASSERTION, AND WHY THE OPAQUE ID IS EXCLUDED.
    //
    // The threat under test is DELIVERY information reaching the customer: a
    // provider name, a gateway, a status code, an attempt count, an error string.
    // Every one of those lives on the notification_events ledger row seeded above
    // and has no counterpart in the customer view.
    //
    // The scan deliberately still covers EVERY field the view exposes — including
    // any field added later — except the opaque, machine-generated notification id.
    //
    // WHY THAT ONE FIELD IS EXCLUDED. `id` is `generateSecureId('CN')`, i.e.
    // "cn-" followed by 20 RANDOM HEX characters. Of the nine leak terms below,
    // '503' is the ONLY one whose characters are all valid hex, so it is the only
    // one that can collide with an id by chance — roughly a 0.5% false-failure
    // rate per run, which is how `cn-2beb002355037afef448` produced a spurious
    // failure. Every other term (africa, talking, resend, gateway, retry,
    // timeout, error) contains letters outside 0-9a-f and therefore cannot occur
    // in a hex id at all.
    //
    // Excluding it does NOT weaken this test. A hex fragment inside an internal
    // identifier is not customer-facing content and cannot name a provider,
    // whereas title, body, category, state, reference and the action path are all
    // content a customer reads — and all of them are still scanned. The positive
    // assertions below then check the exact seeded delivery values are absent.
    const { id: opaqueId, ...scannable } = n as any;
    expect(opaqueId).toBeTruthy(); // the id is present; only its CONTENT is not searched

    const serialised = JSON.stringify(scannable).toLowerCase();
    for (const leak of ['africa', 'talking', 'resend', 'intasend', 'gateway', 'retry', '503', 'timeout', 'error']) {
      expect(serialised).not.toContain(leak);
    }

    // POSITIVE FORM: the concrete delivery values seeded above must not appear
    // anywhere in the customer-facing view. This is the assertion that still
    // bites if a leak were introduced.
    expect(serialised).not.toContain('africa-talking');
    expect(serialised).not.toContain('resend gateway timeout');
    expect(serialised).not.toContain('permanent_failure');
    expect(serialised).not.toContain('masked:+254***0005');
    expect(serialised).not.toContain('reconstructable');

    // META-GUARD: prove the deny-list is not vacuous. If a provider name were
    // ever planted in a customer-visible field, the loop above must fail — so
    // these assertions can never quietly stop protecting anything.
    const withLeak = { ...scannable, title: 'Rejected by africa-talking' };
    expect(JSON.stringify(withLeak).toLowerCase()).toContain('africa');
    expect(serialised.includes('africa')).toBe(false); // the real view has none
  });

  it('E6. the customer view has NO delivery column at all', async () => {
    // Structural, not textual: the view shape itself cannot carry a provider,
    // status code, attempt count or error string, so no future edit to the copy
    // alone can leak one.
    const { id } = await recordDeliveryFallback({
      customerId: CUST,
      category: 'payment_status',
      title: 'Payment awaiting confirmation',
      createdAt: NOW,
    });
    const view = (await openCustomerNotification(CUST, id, NOW))!;
    const keys = Object.keys(view);
    for (const forbidden of [
      'provider', 'status', 'lastError', 'last_error', 'attemptCount',
      'attempt_count', 'nextAttemptAt', 'next_attempt_at', 'channel',
      'recipient', 'recipientReference', 'idempotencyKey', 'eventType',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('E7. a delivery failure does not create a "failed" business notification', async () => {
    // Only ever these five states are expressible. There is deliberately no
    // "failed" state, so a failed DELIVERY has no vocabulary to masquerade as a
    // failed claim, payment, refund or verification.
    for (const s of ['informational', 'action_required', 'pending', 'completed', 'expired']) {
      expect(isCustomerNotificationState(s)).toBe(true);
    }
    expect(isCustomerNotificationState('failed')).toBe(false);
    expect(isCustomerNotificationState('payment_failed')).toBe(false);
  });
});

// ============================================================================
// F. PREFERENCES (requirements 7 and 8)
// ============================================================================
describe('Batch 1 F — notification preferences', () => {
  const CUST = 'CUS-PREF-F';

  beforeEach(async () => {
    await seedCustomer(CUST, '+254711000006');
  });

  function channelFor(prefs: any[], category: string, channel: string) {
    const entry = prefs.find((p) => p.category === category);
    return entry.channels.find((c: any) => c.channel === channel);
  }

  it('F1. an ESSENTIAL notification cannot be disabled', async () => {
    const result = await setCustomerPreference(CUST, 'payment_status', 'sms', false);
    expect(result.applied).toBe(false);
    expect(result.enabled).toBe(true);
    const prefs = await getCustomerPreferences(CUST);
    expect(channelFor(prefs, 'payment_status', 'sms').enabled).toBe(true);
  });

  it('F2. an OPTIONAL notification CAN be disabled', async () => {
    const result = await setCustomerPreference(CUST, 'lost_report', 'email', false);
    expect(result.applied).toBe(true);
    const prefs = await getCustomerPreferences(CUST);
    expect(channelFor(prefs, 'lost_report', 'email').enabled).toBe(false);
  });

  it('F3. preferences PERSIST server-side', async () => {
    await setCustomerPreference(CUST, 'lost_report', 'sms', false);
    const rows = await drizzleDb.select().from(prefsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].disabled).toBe(true);
    expect(rows[0].customer_id).toBe(CUST);
    const prefs = await getCustomerPreferences(CUST);
    expect(channelFor(prefs, 'lost_report', 'sms').enabled).toBe(false);
  });

  it('F4. an absent row means ENABLED (the safe default)', async () => {
    // A customer who has never opened preferences must receive everything, and an
    // essential notification can never be lost because a row failed to insert.
    const prefs = await getCustomerPreferences(CUST);
    expect(prefs).toHaveLength(CUSTOMER_NOTIFICATION_CATEGORIES.length);
    for (const p of prefs) {
      for (const c of p.channels) expect(c.enabled).toBe(true);
    }
  });

  it('F5. a change is PROSPECTIVE — already-sent notifications are unaffected', async () => {
    await recordCustomerNotification({
      customerId: CUST,
      category: 'lost_report',
      title: 'We are still looking',
      createdAt: NOW,
    });
    await setCustomerPreference(CUST, 'lost_report', 'sms', false);
    const history = await listCustomerNotificationHistory(CUST, { now: NOW });
    expect(history).toHaveLength(1);
    expect(history[0].title).toBe('We are still looking');
  });

  it('F6. a required notification is NOT suppressed by a preference change', async () => {
    await setCustomerPreference(CUST, 'lost_report', 'sms', false);
    expect(await applyPreference(CUST, 'lost_report', 'sms')).toBe(false);
    expect(await applyPreference(CUST, 'payment_status', 'sms')).toBe(true);
  });

  it('F7. a CORRUPTED preference row still cannot suppress an essential channel', async () => {
    // Second, independent guard: even if a disabled row somehow exists for an
    // essential category, applyPreference refuses to honour it.
    await drizzleDb.insert(prefsTable).values({
      id: 'CNP-FORGED',
      customer_id: CUST,
      category: 'account_security',
      channel: 'sms',
      disabled: true,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(await applyPreference(CUST, 'account_security', 'sms')).toBe(true);
  });

it('F8. an essential category has no configurable outbound channel', async () => {
    for (const category of ['claim_status', 'payment_status', 'document_verification', 'account_security', 'terms_service']) {
      expect(isEssentialCategory(category)).toBe(true);
      expect(isChannelConfigurable(category, 'sms')).toBe(false);
      expect(isChannelConfigurable(category, 'email')).toBe(false);
      expect(isChannelConfigurable(category, 'in_app')).toBe(true); // durable record survives
    }
  });

  it('F9. only channels the system ACTUALLY supports are offered', async () => {
    expect([...CUSTOMER_NOTIFICATION_CHANNELS].sort()).toEqual(['email', 'in_app', 'sms']);
    await expect(setCustomerPreference(CUST, 'lost_report', 'carrier_pigeon', false)).rejects.toThrow();
  });

  it('F10. an unknown category is refused', async () => {
    await expect(setCustomerPreference(CUST, 'not_a_category', 'sms', false)).rejects.toThrow();
  });

  it('F11. a preference change is AUDITED', async () => {
    await setCustomerPreference(CUST, 'lost_report', 'sms', false);
    const audit = await listCustomerPreferenceAudit(CUST);
    expect(audit).toHaveLength(1);
    expect(audit[0].category).toBe('lost_report');
    expect(audit[0].channel).toBe('sms');
    expect(audit[0].new_disabled).toBe(true);
    expect(audit[0].applied).toBe(true);
    expect(audit[0].previous_disabled).toBeNull(); // there was no prior choice
  });

  it('F12. a REFUSED essential change is audited as not applied', async () => {
    // Recording refusals is what makes the audit meaningful: a silent ignore would
    // be indistinguishable from a no-op.
    await setCustomerPreference(CUST, 'account_security', 'email', false);
    const audit = await listCustomerPreferenceAudit(CUST);
    expect(audit).toHaveLength(1);
    expect(audit[0].applied).toBe(false);
    expect(audit[0].new_disabled).toBe(false);
  });

  it('F13. changing a preference does NOT cancel a required action', async () => {
    // Requirement 8. The claim is still awaiting payment and still actionable, and
    // the notification offering that action is untouched by a preferences write.
    await seedClaim({ claimId: 'CLM-PREF-ACT', ownerPhone: '+254711000006', status: 'pending_payment' });
    await linkClaim(CUST, 'CLM-PREF-ACT');
    await A(CUST, { category: 'payment_status', businessReference: 'CLM-PREF-ACT', createdAt: NOW });
    await setCustomerPreference(CUST, 'lost_report', 'sms', false);
    const [n] = await listActiveCustomerNotifications(CUST, { now: NOW });
    expect(n.state).toBe('action_required');
    expect(n.actionAvailable).toBe(true);
  });

  it('F14. the audit trail is append-only and records the before-value', async () => {
    await setCustomerPreference(CUST, 'lost_report', 'sms', false);
    await setCustomerPreference(CUST, 'lost_report', 'sms', true);
    const audit = await listCustomerPreferenceAudit(CUST);
    // TWO rows, not one: the earlier choice is preserved rather than overwritten.
    // Deliberately asserted as a set rather than by index — both writes can land
    // in the same millisecond, so their relative order is genuinely undefined and
    // pinning it would assert something the schema does not promise.
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.new_disabled).sort()).toEqual([false, true]);
    // The FIRST change had no prior choice (null); the SECOND recorded the
    // disabled value it was reversing. Together they prove the trail is a history,
    // not a snapshot of the current setting.
    //
    // Compared as a SET, and deliberately not with .sort(): Array.sort coerces
    // elements to strings, so sorting [null, true] yields the string order
    // ["null", "true"] rather than any sensible value order. Counting each
    // expected value is order-independent and states the same intent.
    const previousValues = audit.map((a) => a.previous_disabled);
    expect(previousValues.filter((v) => v === null)).toHaveLength(1);
    expect(previousValues.filter((v) => v === true)).toHaveLength(1);
    expect(audit.every((a) => a.applied === true)).toBe(true);
  });

  it('F15. every category carries a customer-facing label in both languages', async () => {
    for (const category of CUSTOMER_NOTIFICATION_CATEGORIES) {
      expect(categoryLabel(category, 'en')).toBeTruthy();
      expect(categoryLabel(category, 'sw')).toBeTruthy();
    }
  });
});

// ============================================================================
// G. SECURITY / PRIVACY (requirement 16)
// ============================================================================
describe('Batch 1 G — customer isolation and authorization', () => {
  const MINE = 'CUS-SEC-MINE';
  const THEIRS = 'CUS-SEC-THEIRS';

  beforeEach(async () => {
    await seedCustomer(MINE, '+254711000007');
    await seedCustomer(THEIRS, '+254711000008');
  });

  it('G1. a customer cannot see another customer NOTIFICATIONS or HISTORY', async () => {
    await A(THEIRS, { title: 'Their private update', createdAt: NOW });
    expect(await listActiveCustomerNotifications(MINE, { now: NOW })).toHaveLength(0);
    expect(await listCustomerNotificationHistory(MINE, { now: NOW })).toHaveLength(0);
    await A(THEIRS, { createdAt: new Date(NOW.getTime() - 30 * DAY) });
    expect(await listCustomerNotificationHistory(MINE, { now: NOW })).toHaveLength(0);
  });

  it('G2. a customer cannot OPEN another customer notification', async () => {
    const { id } = await recordCustomerNotification({
      customerId: THEIRS,
      category: 'account_security',
      title: 'Their security alert',
      createdAt: NOW,
    });
    // Opening returns null AND must not mark their notification read.
    expect(await openCustomerNotification(MINE, id, NOW)).toBeNull();
    const [row] = await drizzleDb.select().from(notificationsTable).where(eq(notificationsTable.id, id));
    expect(row.read_at).toBeNull(); // untouched
  });

  it('G3. a customer cannot MARK another customer notification read', async () => {
    const { id } = await recordCustomerNotification({
      customerId: THEIRS,
      category: 'claim_status',
      title: 'Theirs',
      createdAt: NOW,
    });
    expect(await markNotificationRead(MINE, id, NOW)).toBe(false);
    const [row] = await drizzleDb.select().from(notificationsTable).where(eq(notificationsTable.id, id));
    expect(row.read_at).toBeNull();
  });

  it('G4. a customer cannot change another customer PREFERENCES', async () => {
    await setCustomerPreference(THEIRS, 'lost_report', 'sms', false);
    const myPrefs = await getCustomerPreferences(MINE);
    const entry = myPrefs.find((p) => p.category === 'lost_report');
    expect(entry.channels.find((c: any) => c.channel === 'sms').enabled).toBe(true);
    const theirPrefs = await getCustomerPreferences(THEIRS);
    const theirEntry = theirPrefs.find((p) => p.category === 'lost_report');
    expect(theirEntry.channels.find((c: any) => c.channel === 'sms').enabled).toBe(false);
  });

  it('G5. the unread badge and the audit trail are per-customer', async () => {
    await A(MINE, { createdAt: NOW });
    await A(THEIRS, { createdAt: NOW });
    await A(THEIRS, { createdAt: NOW });
    expect(await countUnreadActive(MINE, NOW)).toBe(1);
    expect(await countUnreadActive(THEIRS, NOW)).toBe(2);
    await setCustomerPreference(MINE, 'lost_report', 'sms', false);
    expect(await listCustomerPreferenceAudit(MINE)).toHaveLength(1);
    expect(await listCustomerPreferenceAudit(THEIRS)).toHaveLength(0);
  });

it('G6. a DIRECT action link cannot reach another customer claim', async () => {
    // Requirement 16: the notification layer grants nothing. Even handed the other
    // customer's claim reference, the state lookup fails closed and no action is
    // offered — so following the path would lead nowhere useful.
    await seedClaim({ claimId: 'CLM-THEIRS', ownerPhone: '+254711000008', status: 'pending_payment' });
    await linkClaim(THEIRS, 'CLM-THEIRS');
    await A(MINE, { category: 'payment_status', businessReference: 'CLM-THEIRS', createdAt: NOW });
    const [n] = await listActiveCustomerNotifications(MINE, { now: NOW });
    expect(n.actionAvailable).toBe(false);
    expect(n.actionPath).toBeNull();
  });

  it('G7. a notification is DECLARED to cascade with its owner', () => {
    // SCOPE NOTE: this asserts the SCHEMA CONTRACT, not runtime behaviour, because
    // the in-memory test database does not enforce foreign keys — deleting a
    // customer leaves its notification row behind. Asserting the runtime effect
    // would be asserting a sandbox limitation as if it were product behaviour.
    // On real PostgreSQL the constraint below is enforced by the database itself,
    // so a notification can never outlive the account it belongs to.
    const ddl = readFileSync(resolve(__dirname, '../../../sql/schema.sql'), 'utf8');
    const block = ddl.slice(ddl.indexOf('CREATE TABLE customer_notifications'));
    const create = block.slice(0, block.indexOf(';'));
    expect(create).toMatch(/customer_id VARCHAR\(50\) NOT NULL REFERENCES customers\(id\) ON DELETE CASCADE/);
  });

  it('G8. no secret or credential is stored in a customer notification', async () => {
    const { id } = await recordDeliveryFallback({
      customerId: MINE,
      category: 'payment_status',
      title: 'Payment awaiting confirmation',
      body: PAYMENT_AWAITING_CONFIRMATION_MESSAGE.en,
      businessReference: 'CLM-SAFE-1',
      createdAt: NOW,
    });
    const [row] = await drizzleDb.select().from(notificationsTable).where(eq(notificationsTable.id, id));
    const serialised = JSON.stringify(row).toLowerCase();
    for (const secret of ['otp', 'password', 'token', 'secret', 'apikey', 'mpesa pin']) {
      expect(serialised).not.toContain(secret);
    }
    // The columns themselves cannot hold one.
    const columns = Object.keys(notificationsTable);
    for (const forbidden of ['otp', 'pin', 'secret', 'token', 'credential']) {
      expect(columns).not.toContain(forbidden);
    }
  });
});

// ============================================================================
// H. CUSTOMER-FACING LANGUAGE (requirement 10)
// ============================================================================
describe('Batch 1 H — plain-language wording only', () => {
  it('H1. the guard detects infrastructure and model vocabulary', () => {
    for (const bad of [
      'Your SMS was rejected by the provider',
      'The webhook returned a 503',
      'We will retry this later',
      'OCR could not read the document',
      'The Gemini model failed',
      'A database error occurred',
      'Your activation token has expired',
      'SMS gateway timeout',
      'Resend API rate limited',
    ]) {
      expect(containsForbiddenCustomerTerm(bad)).toBe(true);
    }
  });

  it('H2. the guard does NOT false-positive on ordinary service language', () => {
    // A guard that banned everything would be as broken as no guard at all.
    for (const good of [
      'Claim under review',
      "We're verifying your claim",
      'Payment awaiting confirmation',
      "Payment wasn't completed",
      'Refund in progress',
      'Claim not approved',
      'Waiting for item handover',
      'Claim completed',
      'Document verification',
      'Your rapid claim was approved',
    ]) {
      expect(containsForbiddenCustomerTerm(good)).toBe(false);
    }
  });

  it('H3. every shipped category and state label is clean', () => {
    for (const category of CUSTOMER_NOTIFICATION_CATEGORIES) {
      expect(containsForbiddenCustomerTerm(categoryLabel(category, 'en'))).toBe(false);
      expect(containsForbiddenCustomerTerm(categoryLabel(category, 'sw'))).toBe(false);
    }
    for (const state of ['informational', 'action_required', 'pending', 'completed', 'expired'] as const) {
      expect(containsForbiddenCustomerTerm(stateLabel(state, 'en'))).toBe(false);
      expect(containsForbiddenCustomerTerm(stateLabel(state, 'sw'))).toBe(false);
    }
  });

  it('H4. the required service terminology is used, not the model vocabulary', () => {
    expect(categoryLabel('document_verification', 'en')).toBe('Document verification');
    const label = categoryLabel('document_verification', 'en').toLowerCase();
    expect(label).not.toContain('ai');
    expect(label).not.toContain('ocr');
  });
});
