import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { registerWebhookRoutes } from '../routes/webhooks';

// =============================================================================
// BATCH 1 — THE PAYOUT CALLBACK ENTRY POINT, OVER REAL HTTP.
// =============================================================================
// routes/webhooks.ts is mounted on a REAL Express app and driven over a real TCP
// socket, because the thing under test is the AUTHORIZATION boundary plus the
// topic routing — neither of which a source-text assertion can demonstrate.
//
// What this pins:
//   * the challenge gate runs BEFORE anything is dispatched, for BOTH topics, so
//     an unauthenticated payout event can never trigger a verification;
//   * `send_money_event` is a TRIGGER ONLY: it calls the injected verification
//     path and NEVER the collection confirmation path, and a status field in the
//     payload is ignored entirely;
//   * the collection path is unchanged for `collection_event`;
//   * a missing batch id, or a verification failure, confirms nothing and is
//     reported to the provider so it can retry.
//
// The verification path itself is a stub here. Its behaviour is pinned in
// services/__tests__/payoutReconciliation.test.ts and
// db/__tests__/payoutVerifiedConfirmation.test.ts.
// =============================================================================

const PREVIOUS_CHALLENGE = process.env.INTASEND_WEBHOOK_CHALLENGE;
const CHALLENGE = 'BATCH1-TEST-CHALLENGE-' + Math.random().toString(36).slice(2);

let server: Server;
let baseUrl = '';

const processClaimPaymentConfirmed = vi.fn(async () => 'PICK-B1');
const reconcilePayoutBatchStatus = vi.fn();
const sendServerError = vi.fn((res: any, _error: any, context: string) =>
  res.status(500).json({ error: 'server error', context }),
);

const VERIFIED_REPORT = {
  handled: true,
  reason: 'provider_status_retrieved',
  providerTrackingId: 'TRK-B1',
  confirmedLegIds: [],
  unresolvedLegIds: [],
  skipped: [],
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
  processClaimPaymentConfirmed.mockClear();
  reconcilePayoutBatchStatus.mockClear();
  sendServerError.mockClear();
  reconcilePayoutBatchStatus.mockResolvedValue(VERIFIED_REPORT);
});

const COLLECTION_OK = {
  topic: 'collection_event',
  challenge: CHALLENGE,
  invoice_id: 'INV-B1',
  state: 'COMPLETE',
  api_ref: 'CLAIM-B1',
  value: 200,
};

describe('BATCH 1 — the payout callback is authenticated before it can trigger anything', () => {
  it('rejects a payout event with the WRONG challenge (401) and dispatches nothing', async () => {
    const res = await post({ topic: 'send_money_event', challenge: 'wrong', tracking_id: 'TRK-B1' });
    expect(res.status).toBe(401);
    expect(reconcilePayoutBatchStatus).not.toHaveBeenCalled();
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('rejects a payout event with NO challenge (401)', async () => {
    const res = await post({ topic: 'send_money_event', tracking_id: 'TRK-B1' });
    expect(res.status).toBe(401);
    expect(reconcilePayoutBatchStatus).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated COLLECTION event too (the gate is untouched)', async () => {
    const res = await post({ ...COLLECTION_OK, challenge: 'wrong' });
    expect(res.status).toBe(401);
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });
});

describe('BATCH 1 — send_money_event is a verification TRIGGER, never proof', () => {
  it('asks the verification path for the exact batch, and confirms nothing itself', async () => {
    const res = await post({ topic: 'send_money_event', challenge: CHALLENGE, tracking_id: 'TRK-B1-TRIGGER' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(reconcilePayoutBatchStatus).toHaveBeenCalledTimes(1);
    expect(reconcilePayoutBatchStatus).toHaveBeenCalledWith('TRK-B1-TRIGGER');
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('IGNORES a status field in the payload (the provider lookup is the evidence)', async () => {
    // A callback that CLAIMS success must not be believed: only the injected
    // verification path — which re-reads the provider — may confirm anything.
    const res = await post({
      topic: 'send_money_event',
      challenge: CHALLENGE,
      tracking_id: 'TRK-B1-CLAIMED',
      status: 'TS100',
      transactions: [{ transaction_id: 'TX-FAKE', status: 'TS100' }],
    });
    expect(res.status).toBe(200);
    expect(reconcilePayoutBatchStatus).toHaveBeenCalledWith('TRK-B1-CLAIMED');
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('refuses an event with no usable batch id (400) and triggers no lookup', async () => {
    const bodies = [
      { topic: 'send_money_event', challenge: CHALLENGE },
      { topic: 'send_money_event', challenge: CHALLENGE, tracking_id: '' },
      { topic: 'send_money_event', challenge: CHALLENGE, tracking_id: '   ' },
      { topic: 'send_money_event', challenge: CHALLENGE, tracking_id: 12345 },
      { topic: 'send_money_event', challenge: CHALLENGE, tracking_id: null },
    ];
    for (const body of bodies) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(reconcilePayoutBatchStatus).not.toHaveBeenCalled();
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('reports a verification failure to the provider and confirms nothing', async () => {
    reconcilePayoutBatchStatus.mockRejectedValue(new Error('provider lookup failed'));
    const res = await post({ topic: 'send_money_event', challenge: CHALLENGE, tracking_id: 'TRK-B1-FAIL' });
    expect(res.status).toBe(500);
    expect(sendServerError).toHaveBeenCalledTimes(1);
    expect(sendServerError.mock.calls[0][2]).toBe('INTASEND_WEBHOOK_PAYOUT_VERIFY_ERROR');
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('ignores any other unknown topic without dispatching', async () => {
    const res = await post({ topic: 'some_other_event', challenge: CHALLENGE, tracking_id: 'TRK-B1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ignored' });
    expect(reconcilePayoutBatchStatus).not.toHaveBeenCalled();
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });
});

describe('BATCH 1 — the collection path is unchanged', () => {
  it('still confirms a completed collection through the ONE canonical path', async () => {
    const res = await post(COLLECTION_OK);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(processClaimPaymentConfirmed).toHaveBeenCalledTimes(1);
    expect(processClaimPaymentConfirmed).toHaveBeenCalledWith('CLAIM-B1', 'INV-B1', 200);
    expect(reconcilePayoutBatchStatus).not.toHaveBeenCalled();
  });

  it('still ignores a non-COMPLETE collection', async () => {
    const res = await post({ ...COLLECTION_OK, state: 'PENDING' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ignored' });
    expect(processClaimPaymentConfirmed).not.toHaveBeenCalled();
  });
});
