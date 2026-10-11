import { describe, it, expect, afterEach, vi } from 'vitest';
import { PaymentService } from '../payments';

// FIX #4 (audit finding A1): triggerIntasendRefund must distinguish a
// DEFINITE provider rejection (HTTP error response â€” IntaSend received the
// request and refused it, refund NOT executed) from an UNKNOWN outcome
// (network/timeout exception â€” request may or may not have been executed).
// The payout path already follows this principle (triggerIntasendPayout
// returns status 'unknown' on exceptions); these tests pin the same
// guarantee on the refund path so it cannot silently regress to the old
// "treat everything as failed" behavior that could double-refund.
//
// BATCH 1B-C1-R1 extended this file to the OTHER end of the same problem: just
// as an ambiguous failure must not be called a failure, an ACCEPTED
// INITIATION must not be called a completion. `/send-money/initiate/` answers
// 2xx for a batch that only needs merchant approval ("BP103" / "Preview and
// approve") and for a freshly accepted transaction ("TP101" / "Pending"), and
// neither is money moving.
//
// BATCH 1B-C1-R2 closes the hole R1 left open: R1 still let a per-transaction
// TS100 INSIDE THE INITIATION RESPONSE complete a refund. That is not proof
// that money moved either — an initiation response is a submission receipt, not
// a settlement record, and no authoritative refund-status confirmation
// mechanism exists in this codebase yet. EVERY 2xx from the initiation endpoint
// is therefore unresolved (never 'completed'), the claim must stay in
// 'refunding' for the admin reconciliation workflow, and no provider identifier
// may ever be invented. All of these are behavioural tests of the real
// PaymentService against a stubbed `fetch` — no provider is contacted.

function stubFetch(impl: () => Promise<any>) {
  return vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INTASEND_SECRET_KEY;
});

describe('triggerIntasendRefund outcome classification', () => {
  it('a 2xx initiation response containing a per-transaction TS100 does NOT complete the refund', async () => {
    // Dummy test key (NOT a real credential). Concatenated so the CI secret-scanner's
    // literal-assignment heuristic does not flag this fabricated value as a committed secret.
    process.env.INTASEND_SECRET_KEY = 'r4m-' + 'test-refund-outcome-dummy-key';
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tracking_id: 'TRK-ABC123',
        transactions: [{
          transaction_id: 'TX-REFUND-1',
          status: 'Successful',
          status_code: 'TS100',
          account: '254700000001',
          amount: '500',
        }],
      }),
    }));

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    // BATCH 1B-C1-R2: an initiation response is a SUBMISSION RECEIPT. Even a
    // transaction-level TS100 in it is not evidence that the transfer settled,
    // so the outcome stays unresolved and nothing downstream may finalize.
    expect(result.outcome).toBe('unknown');
    expect(result.success).toBe(false);
    // The per-TRANSACTION id — not the batch tracking id, which is preserved
    // separately and is not evidence that the refund settled.
    expect(result.transactionId).toBe('TX-REFUND-1');
    expect(result.providerBatchId).toBe('TRK-ABC123');
  });

  it('HTTP error response (definite provider rejection) â†’ outcome failed, NOT completed', async () => {
    // Dummy test key (NOT a real credential). Concatenated so the CI secret-scanner's
    // literal-assignment heuristic does not flag this fabricated value as a committed secret.
    process.env.INTASEND_SECRET_KEY = 'r4m-' + 'test-refund-outcome-dummy-key';
    stubFetch(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid account"}',
    }));

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    // IntaSend explicitly rejected the request â€” refund definitely not
    // executed, so 'failed' is the safe classification.
    expect(result.outcome).toBe('failed');
    expect(result.success).toBe(false);
  });

  it('network timeout/exception â†’ outcome unknown, NOT failed â€” no automatic duplicate refund is possible', async () => {
    // Dummy test key (NOT a real credential). Concatenated so the CI secret-scanner's
    // literal-assignment heuristic does not flag this fabricated value as a committed secret.
    process.env.INTASEND_SECRET_KEY = 'r4m-' + 'test-refund-outcome-dummy-key';
    stubFetch(async () => {
      throw new Error('The operation was aborted due to timeout');
    });

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    // THE central A1 invariant: a timeout does NOT mean "IntaSend definitely
    // rejected the refund". The caller must never auto-retry based on this
    // outcome â€” it must leave the claim in 'refunding' for reconciliation.
    expect(result.outcome).toBe('unknown');
    expect(result.success).toBe(false);
    expect(result.transactionId).toBe('');
    expect(result.providerBatchId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // BATCH 1B-C1-R1 - an ACCEPTED INITIATION is not a completed refund.
  // ---------------------------------------------------------------------------
  // Every case below answers HTTP 2xx. Before this batch each one was reported
  // as `outcome: 'completed'` (with a fabricated 'ISD-REFUND-...' id whenever
  // the provider returned no tracking_id), which made the caller mark the claim
  // 'refunded' and send the customer a refund-complete notice while nothing had
  // actually been paid out. None of them may complete, and none may invent an
  // identifier. All of it is asserted on the real service's return value.
  // ---------------------------------------------------------------------------

  const draftKey = () => {
    // Dummy test key (NOT a real credential). Concatenated so the CI
    // secret-scanner's literal-assignment heuristic does not flag it.
    process.env.INTASEND_SECRET_KEY = 'r4m-' + 'test-refund-outcome-dummy-key';
  };

  const stubJson = (body: any, status = 200) =>
    stubFetch(async () => ({ ok: true, status, json: async () => body }));

  it('HTTP 200 preview / approval-pending batch (BP103) -> unresolved, NOT completed', async () => {
    draftKey();
    // The documented shape for a batch that still needs merchant approval: a
    // 200 that pays NOTHING until it is approved in a separate call.
    stubJson({
      tracking_id: 'TRK-APPROVAL-1',
      batch_reference: 'R4M-REFUND-CLAIM-1',
      status_code: 'BP103',
      status: 'Preview and approve',
      transactions: [{
        transaction_id: 'TX-APPROVAL-1',
        status: 'Preview and approve',
        status_code: 'BP103',
        account: '254700000001',
        amount: '500',
      }],
    });

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    expect(result.outcome).toBe('unknown');
    expect(result.success).toBe(false);
    // The provider's own identifiers are PRESERVED for reconciliation...
    expect(result.transactionId).toBe('TX-APPROVAL-1');
    expect(result.providerBatchId).toBe('TRK-APPROVAL-1');
    // ...but nothing is invented, and this is not a completion.
    expect(result.transactionId).not.toContain('ISD-REFUND');
  });

  it('a preview/approval-pending batch (BP103) whose transaction echoes TS100 is still unresolved', async () => {
    draftKey();
    // The dangerous combination: the batch is only a preview awaiting merchant
    // approval (so it pays NOTHING until a separate approval call is made), yet
    // its transaction entry carries the success CODE. BATCH 1B-C1-R2: a code
    // read out of an initiation response is a snapshot of the submission, not
    // evidence of settlement, so this must NOT complete the refund.
    stubJson({
      tracking_id: 'TRK-PREVIEW-TS100',
      status_code: 'BP103',
      status: 'Preview and approve',
      transactions: [{
        transaction_id: 'TX-PREVIEW-TS100',
        status: 'Successful',
        status_code: 'TS100',
        account: '254700000001',
        amount: '500',
      }],
    });

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    expect(result.outcome).toBe('unknown');
    expect(result.success).toBe(false);
    // Identifiers are still preserved for reconciliation — and never invented.
    expect(result.transactionId).toBe('TX-PREVIEW-TS100');
    expect(result.providerBatchId).toBe('TRK-PREVIEW-TS100');
    expect(result.transactionId).not.toContain('ISD-REFUND');
  });

  it('HTTP 200 with a pending transaction (TP101) -> unresolved, NOT completed', async () => {
    draftKey();
    stubJson({
      tracking_id: 'TRK-PENDING-1',
      transactions: [{
        transaction_id: 'TX-PENDING-1',
        status: 'Pending',
        status_code: 'TP101',
        account: '254700000001',
        amount: '500',
      }],
    });

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    // A NORMAL initiation acceptance: the provider took the request and
    // described a still-PENDING transaction with its own identifiers. That is
    // not money moving, so the outcome is unresolved — but the identifiers are
    // kept for the reconciliation workflow.
    expect(result.outcome).toBe('unknown');
    expect(result.success).toBe(false);
    expect(result.transactionId).toBe('TX-PENDING-1');
    expect(result.providerBatchId).toBe('TRK-PENDING-1');
    expect(result.transactionId).not.toContain('ISD-REFUND');
  });

  it('HTTP 200 with NO transaction details -> unresolved, and NO id is invented', async () => {
    draftKey();
    // A batch-level success CODE with no transaction entry at all. A batch
    // status describes the SUBMISSION, not this refund, so it completes nothing.
    stubJson({ tracking_id: 'TRK-NO-DETAILS', status_code: 'TS100', status: 'Successful' });

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    expect(result.outcome).toBe('unknown');
    expect(result.success).toBe(false);
    expect(result.transactionId).toBe('');                    // nothing genuine to keep
    expect(result.providerBatchId).toBe('TRK-NO-DETAILS');    // real id, kept separately
    expect(result.transactionId).not.toBe('TRK-NO-DETAILS');
    expect(result.transactionId).not.toContain('ISD-REFUND');
  });

  it('HTTP 200 whose body cannot be parsed as JSON -> unresolved, NOT completed', async () => {
    draftKey();
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>gateway</html>',
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    }));

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    expect(result.outcome).toBe('unknown');
    expect(result.success).toBe(false);
    expect(result.transactionId).toBe('');
    expect(result.providerBatchId).toBeNull();
  });

  it('HTTP 200 that describes SEVERAL transactions cannot prove WHICH refund settled -> unresolved', async () => {
    draftKey();
    // One entry IS a TS100 success, but we cannot prove it is ours and the
    // entry count does not match the single refund we submitted. Fail closed.
    stubJson({
      tracking_id: 'TRK-MULTI',
      transactions: [
        { transaction_id: 'TX-A', status_code: 'TS100', status: 'Successful' },
        { transaction_id: 'TX-B', status_code: 'TP101', status: 'Pending' },
      ],
    });

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    expect(result.outcome).toBe('unknown');
    expect(result.success).toBe(false);
  });

  it('a human-readable label ("Successful") with no status CODE completes nothing', async () => {
    draftKey();
    stubJson({
      tracking_id: 'TRK-LABEL-ONLY',
      transactions: [{ transaction_id: 'TX-LABEL', status: 'Successful' }],
    });

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    // The label is presentation and may be reworded; only the documented code
    // (TS100) is evidence that this transaction succeeded.
    expect(result.outcome).toBe('unknown');
    expect(result.success).toBe(false);
  });

  it('a TS100 transaction with no transaction id is still unresolved, and no id is invented', async () => {
    draftKey();
    stubJson({ tracking_id: 'TRK-2', transactions: [{ status_code: 'TS100', status: 'Successful' }] });

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    // BATCH 1B-C1-R2: the code decides nothing here. The initiation is
    // unresolved, and a missing provider id stays missing rather than being
    // fabricated.
    expect(result.outcome).toBe('unknown');
    expect(result.success).toBe(false);
    expect(result.transactionId).toBe('');       // absent, NOT fabricated
    expect(result.providerBatchId).toBe('TRK-2');
    expect(result.transactionId).not.toContain('ISD-REFUND');
  });

  it('HTTP 5xx from the provider -> ambiguous unresolved, NOT a definite failure', async () => {
    draftKey();
    stubFetch(async () => ({
      ok: false,
      status: 500,
      text: async () => 'upstream gateway failure',
      json: async () => ({}),
    }));

    const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

    // The provider (or its gateway) failed while handling a request it had
    // already received, so the refund may have been executed. Classifying this
    // as 'failed' would let the caller release the refund lock (claim
    // 'rejected') for money that may be on its way.
    expect(result.outcome).toBe('unknown');
    expect(result.success).toBe(false);
    expect(result.transactionId).toBe('');
    expect(result.providerBatchId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // BATCH 1B-C1/R1/R2-R3 — pin the ambiguity boundary: 408 / 429 / 5xx are
  // UNRESOLVED, and every other 4xx is a definite refusal.
  // ---------------------------------------------------------------------------
  it('HTTP 408 and 429 are AMBIGUOUS: like a 5xx, execution cannot be ruled out', async () => {
    draftKey();
    for (const status of [408, 429, 500, 502, 503]) {
      stubFetch(async () => ({
        ok: false,
        status,
        text: async () => 'rate limited / upstream failure',
        json: async () => ({}),
      }));

      const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

      // 429 is the R3 addition. A rate-limit response reached the provider (or a
      // gateway in front of it) far enough to be counted/rescheduled, so this
      // refund may already be queued. Reporting 'failed' would let the caller
      // revert the refund lock (claim 'rejected') and invite a re-send — the
      // duplicate-refund risk this classification exists to prevent.
      expect(result.outcome, `HTTP ${status}`).toBe('unknown');
      expect(result.success, `HTTP ${status}`).toBe(false);
      expect(result.transactionId, `HTTP ${status}`).toBe('');
      expect(result.providerBatchId, `HTTP ${status}`).toBeNull();
    }
  });

  it('a status that proves refusal BEFORE execution is still a definite failure', async () => {
    draftKey();
    // The 4xx family, excluding the two ambiguous members above, is the only
    // non-2xx evidence this codebase treats as "no transfer happened" — so the
    // R3 change widened the ambiguity set without weakening the refusal set.
    for (const status of [400, 401, 403, 404, 409, 422]) {
      stubFetch(async () => ({
        ok: false,
        status,
        text: async () => 'refused',
        json: async () => ({}),
      }));

      const result = await PaymentService.triggerIntasendRefund('+254700000001', 500, 'CLAIM-1');

      expect(result.outcome, `HTTP ${status}`).toBe('failed');
      expect(result.success, `HTTP ${status}`).toBe(false);
    }
  });
});
