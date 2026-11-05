import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { registerWebhookRoutes } from '../routes/webhooks';
import {
  alreadyReconciledPaymentConfirmation,
  reconciledPaymentConfirmation,
  refusePaymentConfirmation,
  type PaymentConfirmationOutcome,
} from '../config/paymentConfirmationOutcome';

// =============================================================================
// GATE C / STAGE C1 - THE COLLECTION CALLBACK'S ACKNOWLEDGEMENT, OVER REAL HTTP.
//
// THE DEFECT THIS FILE PINS THE FIX FOR
//
// routes/webhooks.ts answered `200 {"status":"ok"}` for EVERY collection callback
// that did not throw. Because the canonical confirmation path expressed eleven
// DIFFERENT refusals as `null`, a provider-confirmed collection that the
// application refused to reconcile was acknowledged to IntaSend as successfully
// handled - no retry, no operator, no audit trail naming the refusal. Recovery
// depended entirely on the 60-second sweep (which is why a real KES 200 payment
// stayed unresolved for 17h46m in the audited window).
//
// WHAT IS MOUNTED, AND WHY THAT IS ENOUGH
//
// The REAL route is mounted on a REAL Express app over a real TCP socket; only
// the canonical confirmation path is doubled. The thing under test is the
// ACKNOWLEDGEMENT BOUNDARY - "does a refusal look like success to the provider?"
// - and that decision lives entirely in this route plus the pure outcome module.
// The financial gates, the compare-and-swap and the provider re-read are pinned
// elsewhere (paymentConfirmationOrdering, webhookAmountReconciliation,
// db/__tests__/paymentConfirmationRecovery, __tests__/lifecycleHttpE2E).
//
// No database, no provider call, no money.
// =============================================================================

const PREVIOUS_CHALLENGE = process.env.INTASEND_WEBHOOK_CHALLENGE;
const CHALLENGE = 'C1-TEST-CHALLENGE-' + Math.random().toString(36).slice(2);

let server: Server;
let baseUrl = '';

const RECONCILED = reconciledPaymentConfirmation({
  claimId: 'CLAIM-C1',
  invoiceId: 'INV-C1',
  pickupCode: '482913',
  recoveredExpiredClaim: false,
});
const DUPLICATE = alreadyReconciledPaymentConfirmation('CLAIM-C1', 'INV-C1');

const processClaimPaymentConfirmed = vi.fn(async (): Promise<PaymentConfirmationOutcome> => RECONCILED);
const reconcilePayoutBatchStatus = vi.fn(async () => ({
  handled: true,
  reason: 'provider_status_retrieved',
  confirmedLegIds: [],
  unresolvedLegIds: [],
  skipped: [],
}));
const reconcileCollectionFailureEvent = vi.fn(async () => ({ outcome: 'not_a_failure_state' }));
const sendServerError = vi.fn((res: any, _error: any, context: string) =>
  res.status(500).json({ error: 'server error', context }),
);

const COLLECTION_OK = {
  topic: 'collection_event',
  challenge: CHALLENGE,
  invoice_id: 'INV-C1',
  state: 'COMPLETE',
  api_ref: 'CLAIM-C1',
  value: 500,
};

async function post(body: unknown) {
  return fetch(baseUrl + '/api/webhooks/intasend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  processClaimPaymentConfirmed.mockResolvedValue(RECONCILED);
  reconcileCollectionFailureEvent.mockResolvedValue({ outcome: 'not_a_failure_state' });
});

describe('C1 - a real reconciliation is acknowledged as success', () => {
  it('answers the unchanged 200 success body and calls the canonical path once', async () => {
    const res = await post(COLLECTION_OK);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(processClaimPaymentConfirmed).toHaveBeenCalledTimes(1);
    expect(processClaimPaymentConfirmed).toHaveBeenCalledWith('CLAIM-C1', 'INV-C1', 500);
    // The collection path never triggers a payout verification.
    expect(reconcilePayoutBatchStatus).not.toHaveBeenCalled();
    expect(sendServerError).not.toHaveBeenCalled();
  });

  it('also accepts a callback with no amount (the canonical path escalates to the provider)', async () => {
    const res = await post({ ...COLLECTION_OK, value: undefined });
    expect(res.status).toBe(200);
    expect(processClaimPaymentConfirmed).toHaveBeenCalledWith('CLAIM-C1', 'INV-C1', undefined);
  });
});

describe('C1 - a duplicate delivery stays an idempotent success', () => {
  it('answers 200 but marks it as already reconciled, not as a new payment', async () => {
    processClaimPaymentConfirmed.mockResolvedValue(DUPLICATE);
    const res = await post(COLLECTION_OK);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', outcome: 'already_reconciled' });
    expect(sendServerError).not.toHaveBeenCalled();
  });

  it('a REPEATED identical callback confirms nothing a second time locally', async () => {
    // The route itself must never write: it invokes the canonical path (whose
    // compare-and-swap is the single winner) and reports what it decided. The
    // second delivery is answered as a duplicate, and no other dependency runs.
    processClaimPaymentConfirmed
      .mockResolvedValueOnce(RECONCILED)
      .mockResolvedValueOnce(DUPLICATE);

    const first = await post(COLLECTION_OK);
    const second = await post(COLLECTION_OK);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'ok' });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'ok', outcome: 'already_reconciled' });

    expect(processClaimPaymentConfirmed).toHaveBeenCalledTimes(2);
    expect(reconcilePayoutBatchStatus).not.toHaveBeenCalled();
    expect(reconcileCollectionFailureEvent).not.toHaveBeenCalled();
    expect(sendServerError).not.toHaveBeenCalled();
  });
});

describe('C1 - a refusal is NEVER acknowledged as success', () => {
  it('a provider-verification failure is 424, retryable, and says escrow is withheld', async () => {
    processClaimPaymentConfirmed.mockResolvedValue(
      refusePaymentConfirmation('CLAIM-C1', 'INV-C1', 'provider_verification_unavailable'),
    );
    const res = await post(COLLECTION_OK);
    expect(res.status).toBe(424);
    const body: any = await res.json();
    expect(body).toEqual({
      status: 'refused',
      outcome: 'refused',
      code: 'provider_verification_unavailable',
      retryable: true,
    });
    // The critical assertion: this is NOT a success acknowledgement.
    expect(body.status).not.toBe('ok');
    expect(sendServerError).not.toHaveBeenCalled();
  });

  it('an amount mismatch is 409 and names itself', async () => {
    processClaimPaymentConfirmed.mockResolvedValue(
      refusePaymentConfirmation(
        'CLAIM-C1',
        'INV-C1',
        'claim_amount_mismatch',
        'amount 1 != expected fee 500',
      ),
    );
    const res = await post(COLLECTION_OK);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      status: 'refused',
      outcome: 'refused',
      code: 'claim_amount_mismatch',
      retryable: false,
    });
  });

  it('a cross-claim invoice is 409 and leaks neither claim', async () => {
    processClaimPaymentConfirmed.mockResolvedValue(
      refusePaymentConfirmation('CLAIM-C1', 'INV-C1', 'cross_claim_invoice', 'invoice belongs to claim OTHER'),
    );
    const res = await post(COLLECTION_OK);
    expect(res.status).toBe(409);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('cross_claim_invoice');
    // No claim identity, no amount, no phone, no payload echo.
    expect(text).not.toContain('CLAIM-C1');
    expect(text).not.toContain('OTHER');
  });

  it('a claim that is no longer payable is 409, not a silent success', async () => {
    processClaimPaymentConfirmed.mockResolvedValue(
      refusePaymentConfirmation('CLAIM-C1', 'INV-C1', 'claim_not_payable', 'claim status=rejected'),
    );
    const res = await post(COLLECTION_OK);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('claim_not_payable');
  });

  it('a session that cannot be confirmed is 409', async () => {
    processClaimPaymentConfirmed.mockResolvedValue(
      refusePaymentConfirmation('CLAIM-C1', 'INV-C1', 'session_not_confirmable'),
    );
    const res = await post(COLLECTION_OK);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('session_not_confirmable');
  });
});


describe('C1 - the paths that must stay exactly as they were', () => {
  it('a non-COMPLETE state never reaches the confirmation path', async () => {
    const res = await post({ ...COLLECTION_OK, state: 'PENDING' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ignored' });
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('a failed failure-event reconciliation is an ERROR, not a success', async () => {
    reconcileCollectionFailureEvent.mockRejectedValue(new Error('provider unreachable'));
    const res = await post({ ...COLLECTION_OK, state: 'FAILED' });
    expect(res.status).toBe(500);
    expect(sendServerError).toHaveBeenCalledTimes(1);
    expect(sendServerError.mock.calls[0][2]).toBe('INTASEND_WEBHOOK_COLLECTION_FAILURE_ERROR');
  });

  it('a missing invoice_id is 400 and confirms nothing', async () => {
    for (const body of [
      { ...COLLECTION_OK, invoice_id: undefined },
      { ...COLLECTION_OK, invoice_id: '' },
      { ...COLLECTION_OK, invoice_id: 42 },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: 'Missing invoice_id' });
    }
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('a missing api_ref is 400 and confirms nothing', async () => {
    for (const body of [
      { ...COLLECTION_OK, api_ref: undefined },
      { ...COLLECTION_OK, api_ref: '' },
      { ...COLLECTION_OK, api_ref: {} },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: 'Missing api_ref' });
    }
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('a wrong challenge is refused BEFORE anything is confirmed', async () => {
    const res = await post({ ...COLLECTION_OK, challenge: 'not-the-configured-challenge' });
    expect(res.status).toBe(401);
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('a payout callback still cannot reach the collection path', async () => {
    const res = await post({ topic: 'send_money_event', challenge: CHALLENGE, tracking_id: 'TRK-C1' });
    expect(res.status).toBe(200);
    expect(reconcilePayoutBatchStatus).toHaveBeenCalledWith('TRK-C1');
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });
});

describe('C1 - unexpected conditions fail closed', () => {
  it('an exception out of the confirmation path is a 500, never a 200', async () => {
    processClaimPaymentConfirmed.mockRejectedValue(new Error('db exploded'));
    const res = await post(COLLECTION_OK);
    expect(res.status).toBe(500);
    expect(sendServerError).toHaveBeenCalledTimes(1);
    expect(sendServerError.mock.calls[0][2]).toBe('INTASEND_WEBHOOK_CLAIM_UPDATE_ERROR');
    const body: any = await res.json();
    expect(body.status).not.toBe('ok');
  });

  it('an outcome the route cannot interpret is refused, not treated as success', async () => {
    // Guards the contract itself: the pre-C1 `string | null` return shape (a
    // bare pickup code, or null) must never silently become a 200 again.
    for (const bogus of ['482913', null, undefined, {}, { kind: 123 }]) {
      processClaimPaymentConfirmed.mockResolvedValue(bogus as any);
      const res = await post(COLLECTION_OK);
      expect(res.status, JSON.stringify(bogus)).toBe(500);
      expect(sendServerError.mock.calls.at(-1)![2]).toBe(
        'INTASEND_WEBHOOK_CONFIRMATION_OUTCOME_UNKNOWN',
      );
    }
  });
});
