import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';
import type { WebhookDeliveryEventCategory } from '../../config/webhookDeliveries';

// =============================================================================
// GATE C / STAGE C2 — THE DELIVERY RECORD'S DATABASE FACTS
//
// The recorder is a diagnostic table, and a diagnostic table that lies is worse
// than none. This file proves, against the same in-memory double the rest of the
// suite uses, the properties an operator's decision depends on:
//
//   1. an arrival is recorded OPEN — no status code, no processed_at — so a
//      delivery abandoned mid-request reads as INCOMPLETE, never as success;
//   2. the open-only compare-and-swap is real: a settled row cannot be re-opened
//      or re-settled, so a redelivery cannot rewrite history;
//   3. the writer refuses an unknown status, a non-terminal status and an
//      impossible HTTP status BEFORE the write, because the in-memory double does
//      not enforce the DDL's CHECK constraints;
//   4. duplicates are recordable (no uniqueness anywhere) and the read path
//      derives "was the collection eventually resolved" from history rather than
//      storing it.
//
// No provider call, no money.
// =============================================================================

let counter = 0;
const nextId = () => `WHD-C2-${testRunId}-${counter++}`;
const nextInvoice = (tag: string) => `INV-C2-${tag}-${testRunId}-${counter++}`;

interface ArrivalOptions {
  id?: string;
  invoice?: string | null;
  claimId?: string | null;
  sessionId?: string | null;
  category?: WebhookDeliveryEventCategory;
  receivedAt?: Date;
  fingerprint?: string | null;
}

/** Records an arrival exactly as services/webhookDeliveryLog.begin() does. */
async function arrival(options: ArrivalOptions = {}) {
  const id = options.id ?? nextId();
  await db.recordWebhookDelivery({
    id,
    eventCategory: options.category ?? 'collection_complete',
    eventTopic: 'collection_event',
    authenticated: null,
    claimId: options.claimId ?? null,
    paymentSessionId: options.sessionId ?? null,
    providerInvoiceId: options.invoice ?? null,
    providerReference: null,
    payloadFingerprint: options.fingerprint ?? null,
    diagnostic: null,
    receivedAt: options.receivedAt ?? new Date(),
  });
  return id;
}

/** Locates one row through the operator-facing read path. */
async function rowFor(id: string, invoice?: string | null) {
  // The read path deliberately has no id filter (an operator pages; it does not
  // probe by primary key), so the row is located inside a bounded page, narrowed
  // by its own unique invoice where the caller has one.
  const page = await db.listAdminWebhookDeliveries({
    providerInvoiceId: invoice ?? undefined,
    limit: 100,
  });
  const match = page.rows.find((row: any) => row.id === id);
  expect(match, `delivery ${id} should be readable`).toBeTruthy();
  return match as any;
}

describe('C2 — an arrival is recorded OPEN and is never a success', () => {
  it('records the arrival with no status code, no processed_at and is_open = true', async () => {
    const invoice = nextInvoice('ARRIVAL');
    const id = await arrival({ invoice });

    const row = await rowFor(id, invoice);
    expect(row.status).toBe('received');
    expect(row.http_status).toBeNull();
    expect(row.processed_at).toBeNull();
    expect(row.outcome_code).toBeNull();
    expect(row.retryable).toBeNull();
    // The single derived flag the console reads: INCOMPLETE, not "fine".
    expect(row.is_open).toBe(true);
    // An arrival has no session association yet, so it cannot claim a resolution.
    expect(row.session_resolution).toBe('no_payment_session');
  });

  it('marks a delivery processing exactly once (open-only CAS)', async () => {
    const invoice = nextInvoice('PROCESSING');
    const id = await arrival({ invoice });

    expect(await db.markWebhookDeliveryProcessing(id)).toBe(true);
    expect((await rowFor(id, invoice)).status).toBe('processing');
    // A second caller loses: the row already moved on, which is what stops two
    // requests both claiming the work.
    expect(await db.markWebhookDeliveryProcessing(id)).toBe(false);
    expect((await rowFor(id, invoice)).status).toBe('processing');
  });

  it('does not mark an unknown delivery id as processing', async () => {
    expect(await db.markWebhookDeliveryProcessing(`WHD-MISSING-${testRunId}`)).toBe(false);
  });
});

describe('C2 — settlement records the status the provider ACTUALLY received', () => {
  it('settles a delivery with its status code, outcome code and processed_at', async () => {
    const invoice = nextInvoice('SETTLE');
    const id = await arrival({ invoice, claimId: 'CLAIM-C2-SETTLE' });

    expect(
      await db.finishWebhookDelivery(id, {
        status: 'refused_permanent',
        httpStatus: 409,
        outcomeCode: 'cross_claim_invoice',
        retryable: false,
        claimId: 'CLAIM-C2-SETTLE',
        authenticated: true,
      }),
    ).toBe(true);

    const row = await rowFor(id, invoice);
    expect(row.status).toBe('refused_permanent');
    expect(row.http_status).toBe(409);
    expect(row.outcome_code).toBe('cross_claim_invoice');
    expect(row.retryable).toBe(false);
    expect(row.authenticated).toBe(true);
    expect(row.processed_at).not.toBeNull();
    expect(row.is_open).toBe(false);
  });

  it('refuses to re-settle a settled delivery, so a redelivery cannot rewrite history', async () => {
    const invoice = nextInvoice('RESETTLE');
    const id = await arrival({ invoice });
    expect(await db.finishWebhookDelivery(id, { status: 'ignored', httpStatus: 200 })).toBe(true);

    expect(await db.finishWebhookDelivery(id, { status: 'reconciled', httpStatus: 200 })).toBe(false);

    const row = await rowFor(id, invoice);
    expect(row.status).toBe('ignored');
    expect(row.http_status).toBe(200);
  });

  it('does not settle an unknown delivery id', async () => {
    expect(
      await db.finishWebhookDelivery(`WHD-MISSING-${testRunId}`, {
        status: 'ignored',
        httpStatus: 200,
      }),
    ).toBe(false);
  });

  it('keeps `authenticated` NULL when no verdict was reached', async () => {
    // NULL is not FALSE: "no challenge was configured, so nothing was checked" is
    // a different fact from "a challenge was checked and failed", and collapsing
    // them would make the record assert a verification that never happened.
    const invoice = nextInvoice('NULLAUTH');
    const id = await arrival({ invoice });
    await db.finishWebhookDelivery(id, { status: 'validation_rejected', httpStatus: 400 });
    const row = await rowFor(id, invoice);
    expect(row.authenticated).toBeNull();
  });
});

describe('C2 — the writer rejects what the vocabulary rejects, before writing', () => {
  it('refuses an unknown status', async () => {
    const invoice = nextInvoice('BADSTATUS');
    const id = await arrival({ invoice });
    await expect(
      db.finishWebhookDelivery(id, { status: 'definitely_not_a_status' as any, httpStatus: 200 }),
    ).rejects.toThrow();
    // The row is untouched — a refused write must never half-apply.
    const row = await rowFor(id, invoice);
    expect(row.status).toBe('received');
    expect(row.is_open).toBe(true);
  });

  it('refuses to settle into a non-terminal status', async () => {
    const invoice = nextInvoice('OPENSTATUS');
    const id = await arrival({ invoice });
    await expect(
      db.finishWebhookDelivery(id, { status: 'processing' as any, httpStatus: 200 }),
    ).rejects.toThrow();
    await expect(
      db.finishWebhookDelivery(id, { status: 'received' as any, httpStatus: 200 }),
    ).rejects.toThrow();
    expect((await rowFor(id, invoice)).status).toBe('received');
  });

  it('refuses a settlement with no real HTTP status', async () => {
    // The DDL says a settled row carries the code the provider received. An
    // invented 0/999/NaN would make the column meaningless, so it is refused here
    // as well as in services/webhookDeliveryLog.settle().
    const invoice = nextInvoice('BADHTTP');
    const id = await arrival({ invoice });
    for (const httpStatus of [0, 99, 600, NaN, 200.5]) {
      await expect(
        db.finishWebhookDelivery(id, { status: 'ignored', httpStatus: httpStatus as any }),
      ).rejects.toThrow();
    }
    expect((await rowFor(id, invoice)).status).toBe('received');
  });
});

describe('C2 — duplicates are recordable; the read path is bounded and honest', () => {
  it('records two deliveries of the same logical event as two rows', async () => {
    const invoice = nextInvoice('DUP');
    const fingerprint = 'f'.repeat(64);
    const first = await arrival({ invoice, fingerprint, receivedAt: new Date(Date.now() - 2000) });
    const second = await arrival({ invoice, fingerprint, receivedAt: new Date(Date.now() - 1000) });

    const page = await db.listAdminWebhookDeliveries({ providerInvoiceId: invoice });
    expect(page.rows.map((row: any) => row.id).sort()).toEqual([first, second].sort());
    // Same observable identity, two attempts: the fingerprint is a correlation
    // aid, NOT an identity, so it must not collapse them.
    expect(new Set(page.rows.map((row: any) => row.payload_fingerprint))).toEqual(
      new Set([fingerprint]),
    );
  });

  it('returns the newest delivery first', async () => {
    const invoice = nextInvoice('ORDER');
    const older = await arrival({ invoice, receivedAt: new Date(Date.now() - 5000) });
    const newer = await arrival({ invoice, receivedAt: new Date(Date.now() - 1000) });

    const page = await db.listAdminWebhookDeliveries({ providerInvoiceId: invoice });
    expect(page.rows.map((row: any) => row.id)).toEqual([newer, older]);
  });

  it('bounds the page and reports hasMore instead of silently truncating', async () => {
    const invoice = nextInvoice('PAGE');
    for (let i = 0; i < 3; i += 1) {
      await arrival({ invoice, receivedAt: new Date(Date.now() - (10 - i) * 1000) });
    }

    const firstPage = await db.listAdminWebhookDeliveries({ providerInvoiceId: invoice, limit: 2 });
    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await db.listAdminWebhookDeliveries({
      providerInvoiceId: invoice,
      limit: 2,
      offset: 2,
    });
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
  });

  it('clamps the page size to the vocabulary maximum', async () => {
    // A caller cannot ask for the whole table: the read is diagnostic, and an
    // unbounded page is how a console quietly becomes a table export.
    const page = await db.listAdminWebhookDeliveries({ limit: 10_000 });
    expect(page.rows.length).toBeLessThanOrEqual(100);
  });



  it('filters by status, and an out-of-vocabulary status yields an empty page, not everything', async () => {
    const invoice = nextInvoice('STATUSFILTER');
    const settled = await arrival({ invoice });
    await db.finishWebhookDelivery(settled, { status: 'ignored', httpStatus: 200 });
    const open = await arrival({ invoice });

    const ignored = await db.listAdminWebhookDeliveries({
      providerInvoiceId: invoice,
      statuses: ['ignored'],
    });
    expect(ignored.rows.map((row: any) => row.id)).toEqual([settled]);

    const openRows = await db.listAdminWebhookDeliveries({
      providerInvoiceId: invoice,
      statuses: ['received'],
    });
    expect(openRows.rows.map((row: any) => row.id)).toEqual([open]);

    // THE dangerous default: an unknown filter must NARROW to nothing, never widen
    // to the whole table (which would read as "no refusals happened").
    const unknown = await db.listAdminWebhookDeliveries({
      providerInvoiceId: invoice,
      statuses: ['not_a_status'],
    });
    expect(unknown.rows).toEqual([]);
    expect(unknown.hasMore).toBe(false);
  });

  it('filters by claim id and by event category', async () => {
    const claimId = `CLAIM-C2-FILTER-${testRunId}`;
    const invoice = nextInvoice('CLAIMFILTER');
    await arrival({ invoice, claimId, category: 'collection_complete' });

    const byClaim = await db.listAdminWebhookDeliveries({ claimId, limit: 100 });
    expect(byClaim.rows.every((row: any) => row.claim_id === claimId)).toBe(true);
    expect(byClaim.rows.length).toBeGreaterThan(0);

    const byCategory = await db.listAdminWebhookDeliveries({
      providerInvoiceId: invoice,
      eventCategory: 'payout_batch',
    });
    expect(byCategory.rows).toEqual([]);
  });

  it('filters by arrival window', async () => {
    const invoice = nextInvoice('WINDOW');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    const id = await arrival({ invoice, receivedAt: longAgo });

    const recent = await db.listAdminWebhookDeliveries({
      providerInvoiceId: invoice,
      receivedFrom: new Date(Date.now() - 5 * 60 * 1000),
    });
    expect(recent.rows).toEqual([]);

    const broad = await db.listAdminWebhookDeliveries({
      providerInvoiceId: invoice,
      receivedFrom: new Date(Date.now() - 2 * 60 * 60 * 1000),
      receivedTo: new Date(),
    });
    expect(broad.rows.map((row: any) => row.id)).toEqual([id]);
  });
});


// -----------------------------------------------------------------------------
// SESSION CORRELATION — the derived half of the record
// -----------------------------------------------------------------------------
// `session_resolution` is DERIVED at read time, never stored (see
// deriveWebhookSessionResolution). These tests use real claims and real payment
// sessions so the derivation runs against the rows the reconciliation path writes.
// -----------------------------------------------------------------------------

async function makeInvoicedSession(tag: string) {
  const itemId = `TEST-ITEM-C2-${tag}-${testRunId}-${counter++}`;
  await ensureTestCategory('phone');
  await db.createItem({
    id: itemId, category_id: 'phone', photo_url: 'test-photo.jpg', ocr_extracted_number: null,
    ocr_extracted_name: null, document_number_hash: null, document_name_fuzzy: null,
    location_description: 'x', latitude: null, longitude: null, finder_phone: '+254700000012',
    assigned_agent_id: null, status: 'at_agent', flaggedForReview: false, isDescriptionOnly: true,
    description: 'x', is_sensitive_document: false, rejection_reason: null, locked_total_fee: '500',
  } as any);
  const claimId = `TEST-CLAIM-C2-${tag}-${testRunId}-${counter++}`;
  await db.createClaim({
    id: claimId, item_id: itemId, owner_phone: `+2547003${String(counter).padStart(5, '0')}`,
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'fixture' },
    verification_tier: 1, status: 'pending_payment', owner_id_proof_url: null,
    payment_reference: null, owner_identifying_details: null,
  } as any);
  const sessionId = `TEST-PS-C2-${testRunId}-${counter++}`;
  const invoiceId = `INV-C2-SESSION-${testRunId}-${counter++}`;
  await db.createPaymentSession({
    id: sessionId, claimId, amount: 500, payerPhone: '+254700000002',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  expect(await db.reservePaymentSession(sessionId, claimId)).toBe(true);
  expect(await db.finalizePaymentSessionInitiated(sessionId, invoiceId, 'MPESA-C2-REF')).toBe(true);
  return { claimId, sessionId, invoiceId };
}

describe('C2 — the invoice → session correlation read is read-only and misses safely', () => {
  it('finds the session bound to an invoice', async () => {
    const { sessionId, invoiceId } = await makeInvoicedSession('CORRELATE');
    const session: any = await db.getPaymentSessionByProviderInvoice(invoiceId);
    expect(session?.id).toBe(sessionId);
  });

  it('returns nothing for an unknown invoice instead of inventing a session', async () => {
    const session: any = await db.getPaymentSessionByProviderInvoice(`INV-UNKNOWN-${testRunId}`);
    expect(session?.id ?? null).toBeNull();
  });

  it('does not confirm or otherwise change the session it reads', async () => {
    const { sessionId, invoiceId } = await makeInvoicedSession('READONLY');
    await db.getPaymentSessionByProviderInvoice(invoiceId);
    const session: any = await db.getPaymentSessionById(sessionId);
    expect(session.status).toBe('pending');
    expect(session.confirmed_at ?? null).toBeNull();
  });
});


describe('C2 — session resolution is derived from history, and silence is never success', () => {
  it('reports `unresolved` when the session exists but was never confirmed', async () => {
    const { sessionId, invoiceId } = await makeInvoicedSession('UNRESOLVED');
    const id = await arrival({ invoice: invoiceId, sessionId });
    await db.finishWebhookDelivery(id, {
      status: 'refused_permanent',
      httpStatus: 409,
      outcomeCode: 'claim_not_payable',
    });

    const row = await rowFor(id, invoiceId);
    expect(row.session_resolution).toBe('unresolved');
  });

  it('reports `resolved_by_this_delivery` only for a delivery that reconciled', async () => {
    const { sessionId, invoiceId } = await makeInvoicedSession('BYTHIS');
    const id = await arrival({ invoice: invoiceId, sessionId });
    await db.finishWebhookDelivery(id, { status: 'reconciled', httpStatus: 200 });

    expect((await rowFor(id, invoiceId)).session_resolution).toBe('resolved_by_this_delivery');
  });

  it('reports `resolved_by_other_recovery` when the sweep confirmed the session afterwards', async () => {
    const { claimId, sessionId, invoiceId } = await makeInvoicedSession('BYOTHER');
    // The delivery arrived while the collection was still unconfirmed, and this
    // delivery itself refused. The sweep then settled it.
    const id = await arrival({
      invoice: invoiceId,
      sessionId,
      claimId,
      receivedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    await db.finishWebhookDelivery(id, {
      status: 'refused_retryable',
      httpStatus: 424,
      outcomeCode: 'provider_verification_unavailable',
      retryable: true,
    });

    expect((await rowFor(id, invoiceId)).session_resolution).toBe('unresolved');

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);

    // The delivery never claimed a reconciliation, so the credit belongs to the
    // other recovery path — and the naming must say exactly that.
    const row = await rowFor(id, invoiceId);
    expect(row.session_resolution).toBe('resolved_by_other_recovery');
    // HISTORY IS NOT REWRITTEN: the row still reports the refusal it answered with.
    expect(row.status).toBe('refused_retryable');
    expect(row.http_status).toBe(424);
  });

  it('reports `no_payment_session` for an id that has no local session row', async () => {
    const invoice = nextInvoice('NOSESSION');
    const id = await arrival({ invoice, sessionId: `TEST-PS-UNKNOWN-${testRunId}` });
    await db.finishWebhookDelivery(id, { status: 'ignored', httpStatus: 200 });
    expect((await rowFor(id, invoice)).session_resolution).toBe('no_payment_session');
  });
});
