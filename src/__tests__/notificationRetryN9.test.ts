// =============================================================================
// N9 — NOTIFICATION FAILURE RECOVERY.
//
// The properties under test, in order of how badly a regression would hurt:
//
//   1. NEVER RESEND WHAT WE CANNOT REBUILD. Nine events carry a one-time secret
//      that exists only as a hash. A retry that regenerated one would invalidate
//      a code the user is mid-way through typing, so every one of them — plus
//      PAYMENT_RECEIVED — must be refused with zero provider calls.
//   2. NEVER RESEND WHAT WE CANNOT PROVE FAILED. An ambiguous outcome may
//      already have been delivered; 'unknown' is terminal and never scheduled.
//   3. RETRY THE MESSAGE, NEVER THE TRANSACTION. A retry re-renders and
//      re-dispatches; it must never re-run a payment, handover or claim
//      transition.
//   4. EXACTLY ONE DISPATCH UNDER CONCURRENCY, via a database CAS.
//   5. NO NEW SECRETS. Recipient and content are re-derived from domain records,
//      so no plaintext address or rendered body is ever persisted.
//
// Providers are capture adapters; no email is ever sent.
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import {
  NotificationService,
  __setEmailProvider,
  __setSmsProvider,
} from '../services/notificationService';
import { getNotificationPolicy } from '../config/notificationEvents';
import {
  NOTIFICATION_RETRY_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_BASE_DELAY_MS,
  NOTIFICATION_RETRY_MAX_DELAY_MS,
  notificationRetryDelayMs,
} from '../config/notificationRetryPolicy';
import {
  RETRYABLE_EVENT_TYPES,
  isRetryableEventType,
  retryNotificationEvent,
  runNotificationRetrySweep,
  PAYMENT_RECEIVED_NOT_RETRYABLE,
} from '../services/notificationRetry';
import {
  classifyEmailFailure,
  classifySmsFailure,
} from '../services/notificationProviders';

const dispatched: Array<{ to: string; subject: string; body: string }> = [];
let accept = true;
let failureClass: 'retryable_failure' | 'permanent_failure' | 'unknown' | undefined;

const captureEmail = {
  name: 'capture-email',
  async send(to: string, subject: string, body: string) {
    dispatched.push({ to, subject, body });
    return {
      accepted: accept,
      providerMessageId: accept ? 'resend-msg-0001' : null,
      error: accept ? null : 'capture_rejected',
      failureClass: accept ? undefined : failureClass,
    };
  },
};

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

let n = 0;
const key = (label: string) => `n9-${label}-${n++}`;

// Fixed fixtures throughout — no random values, so nothing here can flake.
const CLAIM_ID = 'CLM-N9-FIXED-01';
const ITEM_ID = 'ITM-N9-FIXED-02';
const OWNER_EMAIL = 'owner.n9@example.com';
const AGENT_EMAIL = 'agent.n9@example.com';
const FINDER_EMAIL = 'finder.n9@example.com';
const ADMIN_EMAIL = 'admin.n9@example.com';
const OWNER_PHONE = '+254712000999';

beforeEach(async () => {
  dispatched.length = 0;
  accept = true;
  failureClass = undefined;
  process.env.ADMIN_NOTIFICATION_EMAIL = ADMIN_EMAIL;
  const { db: rawDb } = await import('../db/index');
  const { notification_events } = await import('../db/schema');
  await rawDb.delete(notification_events);
  __setEmailProvider(captureEmail as any);
  __setSmsProvider({ name: 'capture-sms', async send() {
    return { accepted: true, providerMessageId: 'sms-1', error: null };
  } } as any);
});

/**
 * REAL domain fixtures.
 *
 * Reconstruction reads the authoritative claim/item/agent/category records, so
 * testing it against a non-existent claim would only prove that a missing record
 * fails closed. These are real rows precisely so the retry path is exercised
 * end to end, and so ADMIN_TRANSACTION_LOG's amount derivation (which reads
 * `items.locked_total_fee` and `categories.total_fee`) is genuinely verified.
 */
async function seedDomain() {
  await db.createCategory({
    id: 'CAT-N9-1', name_en: 'N9 Test Wallet', name_sw: 'Pochi', total_fee: '1500',
    is_sensitive_document: false,
  } as any);
  await db.createAgent({
    id: 'AGT-N9-1', phone_number: '+254711000222', business_name: 'N9 Hub',
    contact_phone: '+254711000222', contact_email: AGENT_EMAIL,
    county: 'Nairobi', location_address: 'Test', payout_method_type: 'Till Number',
  } as any);
  await db.createItem({
    id: ITEM_ID, category_id: 'CAT-N9-1', name: 'N9 wallet', description: null,
    status: 'awaiting_dropoff', finder_phone: '+254711000333', finder_email: FINDER_EMAIL,
    location_description: 'Nairobi CBD, near the post office',
    declared_value: null, assigned_agent_id: 'AGT-N9-1', locked_total_fee: '1500',
  } as any);
  await db.createClaim({
    id: CLAIM_ID, item_id: ITEM_ID, owner_phone: OWNER_PHONE,
    owner_email: OWNER_EMAIL, status: 'escrow_held',
    security_answers: [{ q: 'colour', a: 'blue' }], verification_tier: 1,
  } as any);
}

/** Insert a row directly, so a test can construct any lifecycle state. */
async function seedEvent(overrides: Record<string, any> = {}): Promise<string> {
  const { db: rawDb } = await import('../db/index');
  const { notification_events } = await import('../db/schema');
  const id = overrides.id ?? `NTF-N9-${n++}`;
  await rawDb.insert(notification_events).values({
    id,
    event_type: 'ITEM_HANDED_OVER',
    channel: 'email',
    provider: 'capture-email',
    idempotency_key: key('seed'),
    recipient_reference: 'o***@example.com',
    status: 'retryable_failure',
    attempt_count: 0,
    retry_attempt_count: 0,
    // Default to the value notify() would freeze onto a reconstructable event,
    // so a seeded row differs from a real one only where a test says so.
    retry_class: 'reconstructable',
    // Due in the past so it is immediately retryable.
    next_attempt_at: new Date(Date.now() - 60_000),
    ...overrides,
  } as any);
  return id;
}

// PLACEHOLDER_A
// =============================================================================
// A — REGISTRY AND ELIGIBILITY
// =============================================================================

describe('N9-A — retry registry', () => {
  it('contains EXACTLY the five reconstructable events', () => {
    expect([...RETRYABLE_EVENT_TYPES].sort()).toEqual([
      'ADMIN_REASSIGNMENT',
      'ADMIN_TRANSACTION_LOG',
      'AGENT_PAYMENT_CONFIRMED',
      'FINDER_ITEM_COLLECTED',
      'ITEM_HANDED_OVER',
    ]);
  });

  it('the catalogue agrees with the registry for all fourteen events', () => {
    const events = [
      'CUSTOMER_EMAIL_ACTIVATION', 'AGENT_EMAIL_ACTIVATION', 'PHONE_VERIFICATION_OTP',
      'CUSTOMER_LOGIN_OTP', 'AGENT_LOGIN_OTP', 'OWNER_CLAIM_VERIFICATION_CODE',
      'PICKUP_CODE', 'CLAIM_LINK_OTP', 'PAYMENT_RECEIVED',
      'AGENT_PAYMENT_CONFIRMED', 'ITEM_HANDED_OVER', 'FINDER_ITEM_COLLECTED',
      'ADMIN_TRANSACTION_LOG', 'ADMIN_REASSIGNMENT',
    ];
    expect(events).toHaveLength(14);
    for (const ev of events) {
      const policy = getNotificationPolicy(ev);
      expect(policy, ev).toBeTruthy();
      // Catalogue and registry can never disagree.
      expect(policy!.retryClass === 'reconstructable', `${ev} catalogue`).toBe(isRetryableEventType(ev));
    }
  });

  it('PAYMENT_RECEIVED is explicitly NOT retryable', () => {
    expect(isRetryableEventType('PAYMENT_RECEIVED')).toBe(false);
    expect(getNotificationPolicy('PAYMENT_RECEIVED')!.retryClass).toBe('not_retryable');
  });
});

// =============================================================================
// B — FAILURE CLASSIFICATION
// =============================================================================

describe('N9-B — failure classification', () => {
  it('an email 5xx or 429 is a DEFINITE transient refusal -> retryable', () => {
    expect(classifyEmailFailure({ statusCode: 503 })).toBe('retryable_failure');
    expect(classifyEmailFailure({ statusCode: 429 })).toBe('retryable_failure');
  });

  it('an email 4xx is a DEFINITE permanent refusal -> permanent', () => {
    expect(classifyEmailFailure({ statusCode: 422 })).toBe('permanent_failure');
    expect(classifyEmailFailure({ statusCode: 400 })).toBe('permanent_failure');
  });

  it('an email outcome with no usable status code is UNKNOWN, not guessed', () => {
    expect(classifyEmailFailure(new Error('socket hang up'))).toBe('unknown');
    expect(classifyEmailFailure(null)).toBe('unknown');
    expect(classifyEmailFailure({ message: 'weird' })).toBe('unknown');
  });

  it('an SMS is only retryable when the gateway itself says it is undeliverable', () => {
    // Africa's Talking has no status lookup, so anything else is unknowable.
    expect(classifySmsFailure(undefined)).toBe('unknown');
    expect(classifySmsFailure('some other message')).toBe('unknown');
  });
it('a definite retryable failure schedules a retry for a reconstructable event', async () => {
    accept = false;
    failureClass = 'retryable_failure';
    const k = key('class-retryable');
    const result = await NotificationService.notify({
      eventType: 'ITEM_HANDED_OVER',
      recipient: OWNER_EMAIL,
      idempotencyKey: k,
      businessReference: CLAIM_ID,
      render: () => ({ subject: 's', body: 'b' }),
    });
    expect(result.accepted).toBe(false);
    const row = await db.getNotificationEventByIdempotencyKey(k);
    expect(row.status).toBe('retryable_failure');
    expect(row.next_attempt_at).toBeTruthy();
  });

  it('a retryable failure on a NON-reconstructable event is terminal, never scheduled', async () => {
    // The provider blipped, but the pickup code cannot be rebuilt — so N9 must
    // NOT schedule a retry it could never perform.
    accept = false;
    failureClass = 'retryable_failure';
    const k = key('class-payreceived');
    await NotificationService.notify({
      eventType: 'PAYMENT_RECEIVED',
      recipient: OWNER_EMAIL,
      idempotencyKey: k,
      businessReference: CLAIM_ID,
      render: () => ({ subject: 's', body: 'b' }),
    });
    const row = await db.getNotificationEventByIdempotencyKey(k);
    expect(row.status).not.toBe('retryable_failure');
    expect(row.next_attempt_at).toBeNull();
  });

  it('a provider THROW is recorded as UNKNOWN, never as retryable', async () => {
    __setEmailProvider({
      name: 'throwing',
      async send() { throw new Error('socket hang up'); },
    } as any);
    const k = key('class-throw');
    await NotificationService.notify({
      eventType: 'ITEM_HANDED_OVER',
      recipient: OWNER_EMAIL,
      idempotencyKey: k,
      businessReference: CLAIM_ID,
      render: () => ({ subject: 's', body: 'b' }),
    });
    const row = await db.getNotificationEventByIdempotencyKey(k);
    expect(row.status).toBe('unknown');
    expect(row.next_attempt_at).toBeNull();
  });

  it('a persistence failure sends nothing and records nothing', async () => {
    const original = (db as any).createNotificationEvent;
    (db as any).createNotificationEvent = async () => { throw new Error('db down'); };
    try {
      const result = await NotificationService.notify({
        eventType: 'ITEM_HANDED_OVER',
        recipient: OWNER_EMAIL,
        idempotencyKey: key('persist-fail'),
        businessReference: CLAIM_ID,
        render: () => ({ subject: 's', body: 'b' }),
      });
      expect(result.accepted).toBe(false);
      expect(result.dispatched).toBe(false);
      expect(dispatched).toHaveLength(0);
    } finally {
      (db as any).createNotificationEvent = original;
    }
  });

  it('a successful dispatch is recorded as sent WITH the provider message id', async () => {
    const k = key('class-success');
    const result = await NotificationService.notify({
      eventType: 'ITEM_HANDED_OVER',
      recipient: OWNER_EMAIL,
      idempotencyKey: k,
      businessReference: CLAIM_ID,
      render: () => ({ subject: 's', body: 'b' }),
    });
    expect(result.accepted).toBe(true);
    const row = await db.getNotificationEventByIdempotencyKey(k);
    expect(row.status).toBe('sent');
    // N9: the provider id now survives into the durable row instead of being
    // logged and discarded, which is what later makes an ambiguous send
    // resolvable through the provider lookup API.
    expect(row.provider_message_id).toBe('resend-msg-0001');
  });
});
// =============================================================================
// C — RETRY
// =============================================================================

describe('N9-C — retry', () => {
  it('the backoff is finite, capped, and clamped', () => {
    expect(notificationRetryDelayMs(0)).toBe(NOTIFICATION_RETRY_BASE_DELAY_MS);
    expect(notificationRetryDelayMs(1)).toBe(NOTIFICATION_RETRY_BASE_DELAY_MS * 4);
    expect(notificationRetryDelayMs(2)).toBe(NOTIFICATION_RETRY_BASE_DELAY_MS * 16);
    expect(notificationRetryDelayMs(50)).toBe(NOTIFICATION_RETRY_MAX_DELAY_MS);
    // Clamped, so a corrupted counter can never produce Infinity/NaN.
    expect(Number.isFinite(notificationRetryDelayMs(1e9))).toBe(true);
    expect(notificationRetryDelayMs(-5)).toBe(NOTIFICATION_RETRY_BASE_DELAY_MS);
  });

  it('refuses a retry for EVERY secret-bearing event, with zero provider calls', async () => {
    const secretEvents = [
      'CUSTOMER_EMAIL_ACTIVATION', 'AGENT_EMAIL_ACTIVATION', 'PHONE_VERIFICATION_OTP',
      'CUSTOMER_LOGIN_OTP', 'AGENT_LOGIN_OTP', 'OWNER_CLAIM_VERIFICATION_CODE',
      'PICKUP_CODE', 'CLAIM_LINK_OTP', 'PAYMENT_RECEIVED',
    ];
    for (const eventType of secretEvents) {
      const id = await seedEvent({
        event_type: eventType,
        // Even a row deliberately mislabelled must still be refused, which is
        // why the guard checks the event type itself and not just the label.
        retry_class: 'reconstructable',
        business_reference: CLAIM_ID,
      });
      const result = await retryNotificationEvent(id);
      expect(result.ok, eventType).toBe(false);
      expect(result.outcome, eventType).toBe('not_retryable_event');
      expect(dispatched, eventType).toHaveLength(0);
    }
  });

  it('PAYMENT_RECEIVED is refused with its own specific reason', async () => {
    const id = await seedEvent({
      event_type: 'PAYMENT_RECEIVED',
      retry_class: 'reconstructable',
      business_reference: CLAIM_ID,
    });
    const result = await retryNotificationEvent(id);
    expect(result.outcome).toBe('not_retryable_event');
    expect(result.detail).toBe(PAYMENT_RECEIVED_NOT_RETRYABLE);
    expect(dispatched).toHaveLength(0);
  });

  it('refuses a retry that is NOT YET DUE', async () => {
    const id = await seedEvent({ next_attempt_at: new Date(Date.now() + 3_600_000) });
    const result = await retryNotificationEvent(id);
    expect(result.outcome).toBe('not_due_yet');
    expect(dispatched).toHaveLength(0);
  });

  it('refuses a row that is not in retryable_failure', async () => {
    for (const status of ['pending', 'sending', 'sent', 'unknown', 'permanent_failure', 'cancelled', 'failed']) {
      const id = await seedEvent({ status });
      const result = await retryNotificationEvent(id);
      expect(result.ok, status).toBe(false);
      expect(dispatched, status).toHaveLength(0);
    }
  });

  it('refuses a reconstructable event whose row is not marked reconstructable', async () => {
    const id = await seedEvent({ retry_class: 'not_retryable' });
    const result = await retryNotificationEvent(id);
    expect(result.outcome).toBe('not_retryable_event');
    expect(dispatched).toHaveLength(0);
  });
it('refuses a row with no business reference, rather than guessing', async () => {
    const id = await seedEvent({ business_reference: null });
    const result = await retryNotificationEvent(id);
    expect(result.outcome).toBe('missing_business_reference');
    expect(dispatched).toHaveLength(0);
    const row = await db.getNotificationEventById(id);
    expect(row.status).toBe('permanent_failure');
    expect(row.next_attempt_at).toBeNull();
  });

  it('an unresolvable domain record is terminal, never dispatched', async () => {
    const id = await seedEvent({ business_reference: 'CLM-DOES-NOT-EXIST' });
    const result = await retryNotificationEvent(id);
    expect(result.outcome).toBe('reconstruction_unavailable');
    expect(dispatched).toHaveLength(0);
    const row = await db.getNotificationEventById(id);
    expect(row.status).toBe('permanent_failure');
  });

  it('the retry budget is finite and ends in permanent_failure', async () => {
    const id = await seedEvent({ retry_attempt_count: NOTIFICATION_RETRY_MAX_ATTEMPTS });
    const result = await retryNotificationEvent(id);
    expect(result.outcome).toBe('retry_budget_exhausted');
    expect(dispatched).toHaveLength(0);
    const row = await db.getNotificationEventById(id);
    expect(row.status).toBe('permanent_failure');
    expect(row.next_attempt_at).toBeNull();
  });

  it('an AMBIGUOUS retry outcome is terminal and never rescheduled', async () => {
    await seedDomain();
    const id = await seedEvent({ business_reference: CLAIM_ID });
    accept = false;
    failureClass = 'unknown';
    const result = await retryNotificationEvent(id);
    expect(result.outcome).toBe('dispatch_unknown');
    const row = await db.getNotificationEventById(id);
    expect(row.status).toBe('permanent_failure');
    expect(row.next_attempt_at).toBeNull();
  });

  it('a RETRYABLE retry failure re-schedules with backoff', async () => {
    await seedDomain();
    const id = await seedEvent({ business_reference: CLAIM_ID });
    accept = false;
    failureClass = 'retryable_failure';
    const result = await retryNotificationEvent(id);
    expect(result.outcome).toBe('dispatch_failed');
    const row = await db.getNotificationEventById(id);
    expect(row.status).toBe('retryable_failure');
    // Backoff advanced, and the retry budget was consumed.
    expect(row.next_attempt_at).toBeTruthy();
    expect(row.retry_attempt_count).toBe(1);
    // attempt_count (successful acceptances) is untouched by a failure.
    expect(row.attempt_count).toBe(0);
  });

  it('the sweep never claims an unknown, pending or failed row', async () => {
    await seedEvent({ status: 'unknown', next_attempt_at: new Date(Date.now() - 60_000) });
    await seedEvent({ status: 'pending', next_attempt_at: new Date(Date.now() - 60_000) });
    await seedEvent({ status: 'failed', next_attempt_at: new Date(Date.now() - 60_000) });
    const claimed = await db.claimDueNotificationRetries(25);
    expect(claimed).toHaveLength(0);
  });

  it('the sweep never claims a historical row (next_attempt_at NULL)', async () => {
    // The migration leaves next_attempt_at NULL on every pre-existing row and
    // `lte` can never match NULL, so legacy rows are structurally unreachable
    // rather than excluded by a filter someone could forget.
    await seedEvent({ next_attempt_at: null });
    const claimed = await db.claimDueNotificationRetries(25);
    expect(claimed).toHaveLength(0);
  });

  it('the sweep processes rows and never leaves one claimed', async () => {
    await seedDomain();
    const okId = await seedEvent({ business_reference: CLAIM_ID });
    const badId = await seedEvent({ business_reference: null });
    const outcome = await runNotificationRetrySweep();
    expect(outcome.claimed).toBeGreaterThanOrEqual(1);
    // Neither row may be left mid-flight in 'sending' — that is the state that
    // would otherwise strand a notification with no owner.
    for (const id of [okId, badId]) {
      expect((await db.getNotificationEventById(id)).status).not.toBe('sending');
    }
    expect((await db.getNotificationEventById(badId)).status).toBe('permanent_failure');
  });
});
// =============================================================================
// D — CONCURRENCY AND IDEMPOTENCY
// =============================================================================

describe('N9-D — concurrency and idempotency', () => {
  it('two workers racing the same row: exactly ONE wins the CAS', async () => {
    const id = await seedEvent({ business_reference: CLAIM_ID });
    const [a, b] = await Promise.all([
      db.claimNotificationRetry(id),
      db.claimNotificationRetry(id),
    ]);
    // The multi-instance guarantee, and it comes from the database rather than
    // from any in-process lock.
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('concurrent retries of one row produce at most ONE provider dispatch', async () => {
    const id = await seedEvent({ business_reference: CLAIM_ID });
    const results = await Promise.all([
      retryNotificationEvent(id),
      retryNotificationEvent(id),
      retryNotificationEvent(id),
    ]);
    expect(dispatched.length).toBeLessThanOrEqual(1);
    // No caller reports success without an actual dispatch.
    expect(results.filter((r) => r.ok)).toHaveLength(dispatched.length);
  });

  it('the sweep and an operator retry racing produce at most ONE dispatch', async () => {
    const id = await seedEvent({ business_reference: CLAIM_ID });
    await Promise.all([
      retryNotificationEvent(id),
      (async () => {
        const claimed = await db.claimNotificationRetry(id);
        if (claimed) await retryNotificationEvent(id, { alreadyClaimed: true });
      })(),
    ]);
    expect(dispatched.length).toBeLessThanOrEqual(1);
  });

  it('a duplicate ORIGINAL request is still suppressed and never re-sent', async () => {
    // N5/N6 idempotency must be untouched by N9.
    const k = key('dupe-original');
    const first = await NotificationService.notify({
      eventType: 'ITEM_HANDED_OVER',
      recipient: OWNER_EMAIL,
      idempotencyKey: k,
      businessReference: CLAIM_ID,
      render: () => ({ subject: 's', body: 'b' }),
    });
    const second = await NotificationService.notify({
      eventType: 'ITEM_HANDED_OVER',
      recipient: OWNER_EMAIL,
      idempotencyKey: k,
      businessReference: CLAIM_ID,
      render: () => ({ subject: 's', body: 'b' }),
    });
    expect(first.accepted).toBe(true);
    expect(second.dispatched).toBe(false);
    expect(second.status).toBe('duplicate');
    expect(dispatched).toHaveLength(1);
  });

  it('a retry does NOT create a second notification identity', async () => {
    await seedDomain();
    const k = key('retry-identity');
    await NotificationService.notify({
      eventType: 'ITEM_HANDED_OVER',
      recipient: OWNER_EMAIL,
      idempotencyKey: k,
      businessReference: CLAIM_ID,
      render: () => ({ subject: 's', body: 'b' }),
    });
    const before = await db.getNotificationEventByIdempotencyKey(k);

    // Put that same logical event into a retryable state and retry it.
    await db.markNotificationEventFailedWithClass(before.id, 'n9', 'retryable_failure', new Date(Date.now() - 1000));
    const result = await retryNotificationEvent(before.id);

    const after = await db.getNotificationEventByIdempotencyKey(k);
    // The SAME row was updated — retry must never mint a second notification
    // identity for one logical event.
    expect(after.id).toBe(before.id);
    expect(result.ok).toBe(true);
    // And the original idempotency key was never rewritten.
    expect(after.idempotency_key).toBe(k);
  });
});
// =============================================================================
// E — SECURITY
// =============================================================================

describe('N9-E — security', () => {
  it('the durable row never gains a plaintext recipient, body or secret', async () => {
    const k = key('sec-row');
    await NotificationService.notify({
      eventType: 'ITEM_HANDED_OVER',
      recipient: OWNER_EMAIL,
      idempotencyKey: k,
      businessReference: CLAIM_ID,
      render: () => ({ subject: 'SECRET SUBJECT 999888', body: '<div>OTP 424242 to 254712000999</div>' }),
    });
    const serialized = JSON.stringify(await db.getNotificationEventByIdempotencyKey(k));
    for (const forbidden of [OWNER_EMAIL, OWNER_PHONE, '999888', '424242', '<div', 'SECRET SUBJECT']) {
      expect(serialized, `durable row leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the business reference is an opaque domain id, not a secret', async () => {
    const k = key('sec-ref');
    await NotificationService.notify({
      eventType: 'ITEM_HANDED_OVER',
      recipient: OWNER_EMAIL,
      idempotencyKey: k,
      businessReference: CLAIM_ID,
      render: () => ({ subject: 's', body: 'b' }),
    });
    const row = await db.getNotificationEventByIdempotencyKey(k);
    expect(row.business_reference).toBe(CLAIM_ID);
    // A domain primary key, never a phone, token or code.
    expect(row.business_reference).not.toMatch(/254\d{9}/);
  });

  it('the retry module can neither mint secrets nor re-run a transaction', () => {
    const src = read('../services/notificationRetry.ts');
    expect(src).not.toMatch(/setOtp|createCustomerOtp|createPickupCode|randomInt|randomBytes/);
    // Call syntax specifically: the module's own comments explain that retry must
    // NOT re-run these, and saying so in prose is not calling them.
    expect(src).not.toMatch(/attemptClaimEscrowHold\s*\(|attemptSettlementRelease\s*\(/);
    expect(src).not.toMatch(/sendCodeViaSms\s*\(|AuthService\./);
    // No executable-code surface: a closed registry, never a serialized callback.
    expect(src).not.toMatch(/eval\(|new Function/);
  });

  it('the retryable set contains no secret-bearing event', () => {
    for (const ev of RETRYABLE_EVENT_TYPES) {
      expect(ev, `${ev} must not be retryable`).not.toMatch(/OTP|PICKUP|ACTIVATION/);
    }
  });

  it('the operator list selects only safe columns', () => {
    const src = read('../db/database.ts');
    const at = src.indexOf('public async listNotificationEventsByStatus');
    const block = src.slice(at, at + 1500);
    expect(block).toContain('recipient_reference');
    expect(block).not.toMatch(/\bsubject\b|\bbody\b|otp|token/i);
  });

  it('the admin retry endpoints are behind the existing admin boundary', () => {
    const src = read('../server.ts');
    expect(src).toMatch(/app\.post\('\/api\/admin\/notifications\/:id\/retry', authenticateJWT, requireCurrentAdminSession/);
    expect(src).toMatch(/app\.get\('\/api\/admin\/notifications', authenticateJWT, requireCurrentAdminSession/);
  });
});

// =============================================================================
// F — EMAIL PROVIDER-ID COMPATIBILITY
// =============================================================================

describe('N9-F — email provider id', () => {
  it('EmailService.send() still returns a boolean', async () => {
    const { EmailService } = await import('../services/email');
    // The compatibility requirement, asserted directly rather than assumed.
    expect(typeof EmailService.send).toBe('function');
    const ok = await EmailService.send('', 'Subject', '<p>Hi</p>');
    expect(typeof ok).toBe('boolean');
    expect(ok).toBe(false);
  });

  it('the durable row captures the provider message id', async () => {
    const k = key('provider-id');
    await NotificationService.notify({
      eventType: 'ITEM_HANDED_OVER',
      recipient: OWNER_EMAIL,
      idempotencyKey: k,
      businessReference: CLAIM_ID,
      render: () => ({ subject: 's', body: 'b' }),
    });
    expect((await db.getNotificationEventByIdempotencyKey(k)).provider_message_id)
      .toBe('resend-msg-0001');
  });

  it('the adapter remains the only caller of the email transport', () => {
    for (const rel of ['../server.ts', '../routes/agentOps.ts', '../routes/finderReport.ts',
      '../routes/claims.ts', '../routes/customerClaims.ts', '../services/notificationRetry.ts']) {
      expect(read(rel), rel).not.toContain('EmailService.send(');
    }
    expect(read('../services/notificationProviders.ts')).toContain('EmailService.sendWithId(');
  });
});