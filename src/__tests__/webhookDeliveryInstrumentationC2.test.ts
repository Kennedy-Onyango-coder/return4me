import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import type { Server } from 'http';
import { registerWebhookRoutes } from '../routes/webhooks';
import { createWebhookDeliveryLog, type WebhookDeliveryStore } from '../services/webhookDeliveryLog';
import {
  alreadyReconciledPaymentConfirmation,
  reconciledPaymentConfirmation,
  refusePaymentConfirmation,
  type PaymentConfirmationOutcome,
} from '../config/paymentConfirmationOutcome';

// =============================================================================
// GATE C / STAGE C2 — EVERY EXIT PATH RECORDS WHAT THE PROVIDER ACTUALLY GOT
//
// C1 established that a refusal must never be acknowledged as success. C2 makes
// that decision DURABLE: each delivery attempt leaves a row saying how it was
// authenticated, what the application decided, the HTTP status IntaSend actually
// received, and whether a redelivery could help.
//
// WHAT IS REAL HERE
//   * the REAL route (registerWebhookRoutes) on a REAL Express app over a real
//     TCP socket, with the REAL C1 pure outcome module;
//   * the REAL recorder (createWebhookDeliveryLog) — the glue is what is under
//     test, so only the STORE is doubled, exactly as a database would be.
//
// WHAT IS DOUBLED
//   * the data store (an in-memory object), the canonical confirmation path, the
//     payout re-verification trigger and the collection-failure reconciler.
//
// The properties asserted are the ones a wrong implementation would break:
//   1. the arrival is recorded BEFORE authentication, so a refused delivery - the
//      case that used to vanish - still leaves a row;
//   2. the settlement carries `res.statusCode`, i.e. the code the provider
//      received (including a 5xx chosen by sendServerError);
//   3. a store failure changes NOTHING about the response, in either direction;
//   4. nothing from the payload that must not be persisted (the challenge, the
//      payer's phone number) ever reaches the store.
// =============================================================================

const PREVIOUS_CHALLENGE = process.env.INTASEND_WEBHOOK_CHALLENGE;
const CHALLENGE = 'C2-TEST-CHALLENGE-' + Math.random().toString(36).slice(2);
const PHONE = '+254712345678';

let server: Server;
let baseUrl = '';
let idSequence = 0;

interface Settlement {
  status: string;
  httpStatus: number;
  outcomeCode?: string | null;
  retryable?: boolean | null;
  claimId?: string | null;
  paymentSessionId?: string | null;
  authenticated?: boolean | null;
  diagnostic?: string | null;
}

const arrivals: any[] = [];
const settlements = new Map<string, Settlement>();
const sessionByInvoice = new Map<string, unknown>();

const store: WebhookDeliveryStore & {
  failArrival: boolean;
  failSettlement: boolean;
  failCorrelation: boolean;
} = {
  failArrival: false,
  failSettlement: false,
  failCorrelation: false,
  async recordWebhookDelivery(input: any) {
    if (store.failArrival) throw new Error('insert failed');
    arrivals.push(input);
  },
  async markWebhookDeliveryProcessing() {
    return true;
  },
  async finishWebhookDelivery(id: string, settlement: any) {
    if (store.failSettlement) throw new Error('update failed');
    settlements.set(id, settlement as Settlement);
    return true;
  },
  async getPaymentSessionByProviderInvoice(invoiceId: string) {
    if (store.failCorrelation) throw new Error('read failed');
    return sessionByInvoice.get(invoiceId) as any;
  },
};

const RECONCILED = reconciledPaymentConfirmation({
  claimId: 'CLAIM-C2',
  invoiceId: 'INV-C2',
  pickupCode: '998877',
  recoveredExpiredClaim: false,
});

const processClaimPaymentConfirmed = vi.fn(async (): Promise<PaymentConfirmationOutcome> => RECONCILED);
const reconcilePayoutBatchStatus = vi.fn(async () => ({ handled: true, confirmedLegIds: [] }));
const reconcileCollectionFailureEvent = vi.fn(async () => ({ outcome: 'not_a_failure_state' }));
const sendServerError = vi.fn((res: any, _error: any, context: string) =>
  res.status(500).json({ error: 'server error', context }),
);

const COLLECTION = {
  topic: 'collection_event',
  challenge: CHALLENGE,
  invoice_id: 'INV-C2',
  state: 'COMPLETE',
  api_ref: 'CLAIM-C2',
  value: 500,
  phone_number: PHONE,
};

async function post(body: unknown) {
  return fetch(baseUrl + '/api/webhooks/intasend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The settlement recorded for the single delivery this request produced. */
function onlySettlement(): Settlement {
  expect(settlements.size).toBe(1);
  return [...settlements.values()][0] as Settlement;
}

beforeAll(async () => {
  process.env.INTASEND_WEBHOOK_CHALLENGE = CHALLENGE;
  const app = express();
  app.use(express.json());
  registerWebhookRoutes(app, {
    processClaimPaymentConfirmed: processClaimPaymentConfirmed as any,
    sendServerError: sendServerError as any,
    reconcilePayoutBatchStatus: reconcilePayoutBatchStatus as any,
    reconcileCollectionFailureEvent: reconcileCollectionFailureEvent as any,
    // The REAL recorder: only its store is in memory.
    webhookDeliveryLog: createWebhookDeliveryLog({
      store,
      newId: () => `WHD-C2-TEST-${++idSequence}`,
    }),
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = 'http://127.0.0.1:' + port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (PREVIOUS_CHALLENGE === undefined) delete process.env.INTASEND_WEBHOOK_CHALLENGE;
  else process.env.INTASEND_WEBHOOK_CHALLENGE = PREVIOUS_CHALLENGE;
});

beforeEach(() => {
  vi.clearAllMocks();
  arrivals.length = 0;
  settlements.clear();
  sessionByInvoice.clear();
  store.failArrival = false;
  store.failSettlement = false;
  store.failCorrelation = false;
  processClaimPaymentConfirmed.mockResolvedValue(RECONCILED);
  reconcilePayoutBatchStatus.mockResolvedValue({ handled: true, confirmedLegIds: [] });
  reconcileCollectionFailureEvent.mockResolvedValue({ outcome: 'not_a_failure_state' });
});
describe('C2 — the arrival is recorded before anything is decided', () => {
  it('records a delivery the challenge REFUSES — the case that used to vanish', async () => {
    const res = await post({ ...COLLECTION, challenge: 'WRONG' });
    expect(res.status).toBe(401);

    // ONE arrival, recorded before authentication ran.
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].eventCategory).toBe('collection_complete');
    expect(arrivals[0].providerInvoiceId).toBe('INV-C2');
    expect(arrivals[0].claimId).toBe('CLAIM-C2');
    // No verdict is claimed at arrival time.
    expect(arrivals[0].authenticated).toBeNull();

    const settlement = onlySettlement();
    expect(settlement.status).toBe('authentication_rejected');
    expect(settlement.outcomeCode).toBe('challenge_mismatch');
    expect(settlement.httpStatus).toBe(401);
    expect(settlement.authenticated).toBe(false);
    expect(settlement.retryable).toBe(false);
  });

  it('never stores the challenge or the payer phone number', async () => {
    await post(COLLECTION);
    const stored = JSON.stringify([...arrivals, ...settlements.values()]);
    expect(stored).not.toContain(CHALLENGE);
    expect(stored).not.toContain(PHONE);
    // Only a digest of the identifying fields is kept, for correlation.
    expect(arrivals[0].payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('C2 — a collection decision is recorded as the status the provider received', () => {
  it('records a real reconciliation as `reconciled` with HTTP 200', async () => {
    const res = await post(COLLECTION);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });

    const settlement = onlySettlement();
    expect(settlement.status).toBe('reconciled');
    expect(settlement.httpStatus).toBe(200);
    expect(settlement.authenticated).toBe(true);
    expect(settlement.claimId).toBe('CLAIM-C2');
    expect(settlement.retryable).toBeNull();
  });

  it('records a duplicate as `already_reconciled`, distinct from a fresh reconciliation', async () => {
    processClaimPaymentConfirmed.mockResolvedValue(
      alreadyReconciledPaymentConfirmation('CLAIM-C2', 'INV-C2'),
    );
    const res = await post(COLLECTION);
    expect(res.status).toBe(200);

    const settlement = onlySettlement();
    expect(settlement.status).toBe('already_reconciled');
    expect(settlement.httpStatus).toBe(200);
  });

  it('records a PERMANENT refusal with its own code and 409 — not a handled collection', async () => {
    processClaimPaymentConfirmed.mockResolvedValue(
      refusePaymentConfirmation('CLAIM-C2', 'INV-C2', 'cross_claim_invoice'),
    );
    const res = await post(COLLECTION);
    expect(res.status).toBe(409);

    const settlement = onlySettlement();
    expect(settlement.status).toBe('refused_permanent');
    expect(settlement.outcomeCode).toBe('cross_claim_invoice');
    expect(settlement.retryable).toBe(false);
    expect(settlement.httpStatus).toBe(409);
  });

  it('records a TRANSIENT refusal as retryable with 424, so an operator knows a retry may help', async () => {
    processClaimPaymentConfirmed.mockResolvedValue(
      refusePaymentConfirmation('CLAIM-C2', 'INV-C2', 'provider_verification_unavailable'),
    );
    const res = await post(COLLECTION);
    expect(res.status).toBe(424);

    const settlement = onlySettlement();
    expect(settlement.status).toBe('refused_retryable');
    expect(settlement.retryable).toBe(true);
    expect(settlement.httpStatus).toBe(424);
  });

  it('records a 5xx from the confirmation path as `internal_error` with the REAL 500', async () => {
    processClaimPaymentConfirmed.mockRejectedValue(new Error('boom'));
    const res = await post(COLLECTION);
    expect(res.status).toBe(500);

    const settlement = onlySettlement();
    expect(settlement.status).toBe('internal_error');
    expect(settlement.outcomeCode).toBe('INTASEND_WEBHOOK_CLAIM_UPDATE_ERROR');
    expect(settlement.retryable).toBe(true);
    // THE point of reading res.statusCode after the response: the record shows the
    // code the provider actually got, not an assumption that it was a 200.
    expect(settlement.httpStatus).toBe(500);
  });

  it('fails closed on an outcome it cannot interpret', async () => {
    processClaimPaymentConfirmed.mockResolvedValue('reconciled' as any);
    const res = await post(COLLECTION);
    expect(res.status).toBe(500);

    const settlement = onlySettlement();
    expect(settlement.status).toBe('internal_error');
    expect(settlement.outcomeCode).toBe('INTASEND_WEBHOOK_CONFIRMATION_OUTCOME_UNKNOWN');
    expect(settlement.httpStatus).toBe(500);
  });
});



describe('C2 — a delivery refused before any financial work is still recorded', () => {
  it('records a missing invoice_id as a validation rejection with 400', async () => {
    const res = await post({ ...COLLECTION, invoice_id: undefined });
    expect(res.status).toBe(400);
    const settlement = onlySettlement();
    expect(settlement.status).toBe('validation_rejected');
    expect(settlement.outcomeCode).toBe('missing_invoice_id');
    expect(settlement.httpStatus).toBe(400);
    expect(settlement.retryable).toBe(false);
    // The challenge WAS verified before this exit, and the record says so.
    expect(settlement.authenticated).toBe(true);
  });

  it('records a missing api_ref as a validation rejection with 400', async () => {
    const res = await post({ ...COLLECTION, api_ref: undefined });
    expect(res.status).toBe(400);
    const settlement = onlySettlement();
    expect(settlement.status).toBe('validation_rejected');
    expect(settlement.outcomeCode).toBe('missing_api_ref');
    expect(settlement.httpStatus).toBe(400);
  });

  it('records an unrouted topic as `ignored`, which is neither a refusal nor a success', async () => {
    const res = await post({ ...COLLECTION, topic: 'payment_link_event' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ignored' });
    const settlement = onlySettlement();
    expect(settlement.status).toBe('ignored');
    expect(settlement.outcomeCode).toBe('topic_not_routed');
    expect(settlement.httpStatus).toBe(200);
  });

  it('records a non-COMPLETE state with no failure as `ignored`', async () => {
    const res = await post({ ...COLLECTION, state: 'PENDING' });
    expect(res.status).toBe(200);
    const settlement = onlySettlement();
    expect(settlement.status).toBe('ignored');
    expect(settlement.outcomeCode).toBe('not_a_failure_state');
  });

  it('records a corroborated terminal failure as `collection_failure_recorded`, not success', async () => {
    reconcileCollectionFailureEvent.mockResolvedValue({ outcome: 'failure_recorded' } as any);
    const res = await post({ ...COLLECTION, state: 'FAILED' });
    expect(res.status).toBe(200);
    const settlement = onlySettlement();
    expect(settlement.status).toBe('collection_failure_recorded');
    // The provider's own state is echoed as the safe outcome code.
    expect(settlement.outcomeCode).toBe('FAILED');
  });

  it('records a failure-reconciliation error as retryable `internal_error` with the REAL 500', async () => {
    reconcileCollectionFailureEvent.mockRejectedValue(new Error('nope'));
    const res = await post({ ...COLLECTION, state: 'FAILED' });
    expect(res.status).toBe(500);
    const settlement = onlySettlement();
    expect(settlement.status).toBe('internal_error');
    expect(settlement.outcomeCode).toBe('INTASEND_WEBHOOK_COLLECTION_FAILURE_ERROR');
    expect(settlement.retryable).toBe(true);
    expect(settlement.httpStatus).toBe(500);
  });
});

describe('C2 — a payout callback is recorded as a ROUTED verification, never as money', () => {
  const PAYOUT = { topic: 'send_money_event', challenge: CHALLENGE, tracking_id: 'BATCH-C2' };

  it('records a missing tracking_id as a validation rejection with 400', async () => {
    const res = await post({ topic: 'send_money_event', challenge: CHALLENGE });
    expect(res.status).toBe(400);
    const settlement = onlySettlement();
    expect(settlement.status).toBe('validation_rejected');
    expect(settlement.outcomeCode).toBe('missing_tracking_id');
    expect(settlement.httpStatus).toBe(400);
  });

  it('records a successfully routed batch as `payout_verification_routed` with 200', async () => {
    const res = await post(PAYOUT);
    expect(res.status).toBe(200);
    expect(reconcilePayoutBatchStatus).toHaveBeenCalledWith('BATCH-C2');
    const settlement = onlySettlement();
    expect(settlement.status).toBe('payout_verification_routed');
    expect(settlement.httpStatus).toBe(200);
    // Nothing was confirmed here, so retryability is not applicable — NULL, not
    // false, and never a claim of success.
    expect(settlement.retryable).toBeNull();
  });

  it('records a failed verification as retryable `internal_error`', async () => {
    reconcilePayoutBatchStatus.mockRejectedValue(new Error('provider down'));
    const res = await post(PAYOUT);
    expect(res.status).toBe(500);
    const settlement = onlySettlement();
    expect(settlement.status).toBe('internal_error');
    expect(settlement.outcomeCode).toBe('INTASEND_WEBHOOK_PAYOUT_VERIFY_ERROR');
    expect(settlement.retryable).toBe(true);
    expect(settlement.httpStatus).toBe(500);
  });
});


describe('C2 — bookkeeping can never change what the provider is told', () => {
  it('answers normally when the arrival insert fails (and records no outcome)', async () => {
    store.failArrival = true;
    const res = await post({ ...COLLECTION, challenge: 'WRONG' });

    // The financial code path's response is unchanged...
    expect(res.status).toBe(401);
    // ...and nothing was fabricated to cover the failed insert.
    expect(settlements.size).toBe(0);
  });

  it('answers normally when the settlement update fails', async () => {
    store.failSettlement = true;
    const res = await post(COLLECTION);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    // The row stays OPEN in the store (the write never landed), which the admin
    // read path reports as INCOMPLETE — never as a success.
    expect(settlements.size).toBe(0);
  });

  it('answers normally when the correlation read fails', async () => {
    store.failCorrelation = true;
    sessionByInvoice.set('INV-C2', { id: 'PS-C2-1' });
    const res = await post(COLLECTION);

    expect(res.status).toBe(200);
    const settlement = onlySettlement();
    // Uncorrelated rather than guessed: no session id is invented.
    expect(settlement.paymentSessionId ?? null).toBeNull();
    expect(settlement.status).toBe('reconciled');
  });

  it('correlates a collection delivery to the session bound to its invoice', async () => {
    sessionByInvoice.set('INV-C2', { id: 'PS-C2-1' });
    const res = await post(COLLECTION);
    expect(await res.json()).toEqual({ status: 'ok' });
    // READ-ONLY correlation: the recorder only READS the session, and the id it
    // learns is what makes "was this collection resolved" answerable later.
    expect(onlySettlement().paymentSessionId).toBe('PS-C2-1');
  });

  it('works with NO recorder injected at all (the route stays usable without a DB)', async () => {
    // The no-op handle exists so every exit path is instrumented identically
    // whether or not a database is wired; here nothing is wired, and the callback
    // contract must be byte-identical.
    const bareApp = express();
    bareApp.use(express.json());
    const bareProcess = vi.fn(async () => RECONCILED);
    registerWebhookRoutes(bareApp, {
      processClaimPaymentConfirmed: bareProcess as any,
      sendServerError: sendServerError as any,
      reconcilePayoutBatchStatus: reconcilePayoutBatchStatus as any,
      reconcileCollectionFailureEvent: reconcileCollectionFailureEvent as any,
    });
    const bareServer: Server = await new Promise((resolve) => {
      const s = bareApp.listen(0, () => resolve(s as Server));
    });
    const address = bareServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const ok = await fetch(`http://127.0.0.1:${port}/api/webhooks/intasend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(COLLECTION),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ status: 'ok' });

      const refused = await fetch(`http://127.0.0.1:${port}/api/webhooks/intasend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...COLLECTION, challenge: 'WRONG' }),
      });
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: 'Challenge verification failed' });
    } finally {
      await new Promise<void>((resolve) => bareServer.close(() => resolve()));
    }
  });

describe('C2 — the production wiring exists (server.ts)', () => {
  const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

  it('injects the real recorder into the webhook route', () => {
    // Without this line the route silently falls back to the no-op handle and
    // NOTHING is ever recorded — the failure mode this stage exists to prevent,
    // and one no route-level test can catch.
    expect(serverSource).toContain('createWebhookDeliveryLog');
    expect(serverSource).toContain('webhookDeliveryLog:');
    expect(serverSource).toMatch(/store:\s*db/);
  });
});

});
