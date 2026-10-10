import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  reconcilePayoutBatchStatus,
  type PayoutReconciliationPorts,
  type PayoutBatchStatusView,
} from '../payoutReconciliation';

// =============================================================================
// BATCH 1 — PAYOUT VERIFICATION ORCHESTRATION, WITH STUBBED PORTS.
// =============================================================================
// This is the layer that decides, from a provider status report, which local
// ledger legs (if any) may be completed. Every collaborator is injected, so this
// file performs NO network call and touches NO database: the provider lookup,
// the local leg read, the compare-and-swap and the audit write are all stubs.
//
// The behaviours pinned here are the fail-closed ones:
//   * an unverifiable lookup confirms nothing;
//   * a verified batch with no per-transaction detail confirms nothing;
//   * a transaction with no id, or one that does not match EXACTLY ONE leg,
//     confirms nothing;
//   * a non-completed verdict never confirms, and never touches retry state;
//   * a duplicate/out-of-order delivery is a no-op because the CAS refuses it;
//   * a provider transport failure surfaces as an error and confirms nothing.
// =============================================================================

const LEG_FINDER = {
  id: 'TXN-F',
  provider_batch_id: 'TRK-1',
  provider_transaction_id: 'TX-F',
  status: 'pending',
  payout_outcome: 'accepted',
};
const LEG_AGENT = {
  id: 'TXN-A',
  provider_batch_id: 'TRK-1',
  provider_transaction_id: 'TX-A',
  status: 'pending',
  payout_outcome: 'accepted',
};

type ProviderTxn = PayoutBatchStatusView['transactions'][number];

function txn(transactionId: string | null, verdict: ProviderTxn['verdict'], providerStatus: string | null = null): ProviderTxn {
  return { transactionId, providerStatus, verdict };
}

function verified(transactions: ProviderTxn[]): PayoutBatchStatusView {
  return { verified: true, reason: 'provider_status_retrieved', providerTrackingId: 'TRK-1', transactions };
}

function stubPorts() {
  const lookupBatchStatus = vi.fn();
  const listLegsByBatchId = vi.fn();
  const confirmVerified = vi.fn();
  const audit = vi.fn();
  const ports: PayoutReconciliationPorts = {
    lookupBatchStatus: lookupBatchStatus as unknown as PayoutReconciliationPorts['lookupBatchStatus'],
    listLegsByBatchId: listLegsByBatchId as unknown as PayoutReconciliationPorts['listLegsByBatchId'],
    confirmVerified: confirmVerified as unknown as PayoutReconciliationPorts['confirmVerified'],
    audit: audit as unknown as PayoutReconciliationPorts['audit'],
  };
  return { ports, lookupBatchStatus, listLegsByBatchId, confirmVerified, audit };
}

describe('BATCH 1 — reconcilePayoutBatchStatus confirms only proven transfers', () => {
  it('refuses a blank tracking id without asking anyone', async () => {
    const { ports, lookupBatchStatus, audit } = stubPorts();
    const result = await reconcilePayoutBatchStatus('   ', ports);
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('missing_tracking_id');
    expect(lookupBatchStatus).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(result.confirmedLegIds).toEqual([]);
  });

  it('confirms NOTHING when the provider status cannot be verified', async () => {
    const { ports, lookupBatchStatus, listLegsByBatchId, confirmVerified, audit } = stubPorts();
    lookupBatchStatus.mockResolvedValue({
      verified: false,
      reason: 'provider_http_500',
      providerTrackingId: null,
      transactions: [],
    });
    const result = await reconcilePayoutBatchStatus('TRK-1', ports);
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('provider_http_500');
    expect(listLegsByBatchId).not.toHaveBeenCalled();
    expect(confirmVerified).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toBe('PAYOUT_VERIFICATION_UNVERIFIED');
  });

  it('completes exactly the leg the provider reports completed, and leaves the rest', async () => {
    const { ports, lookupBatchStatus, listLegsByBatchId, confirmVerified } = stubPorts();
    lookupBatchStatus.mockResolvedValue(verified([
      txn('TX-F', 'completed', 'TS100'),
      txn('TX-A', 'in_progress', 'TP'),
    ]));
    listLegsByBatchId.mockResolvedValue([LEG_FINDER, LEG_AGENT]);
    confirmVerified.mockResolvedValue(true);

    const result = await reconcilePayoutBatchStatus('TRK-1', ports);

    expect(confirmVerified).toHaveBeenCalledTimes(1);
    expect(confirmVerified).toHaveBeenCalledWith('TXN-F', {
      providerBatchId: 'TRK-1',
      providerTransactionId: 'TX-F',
    });
    expect(result.confirmedLegIds).toEqual(['TXN-F']);
    expect(result.unresolvedLegIds).toEqual(['TXN-A']);
    expect(result.skipped).toEqual([
      { transactionId: 'TX-A', verdict: 'in_progress', reason: 'provider_verdict_not_completed' },
    ]);
  });

  it('confirms nothing when the batch is verified but carries no per-transaction detail', async () => {
    // "The batch completed" is NOT "these transfers completed": batch-level
    // status (or a bare HTTP 2xx) can never substitute for per-leg evidence.
    const { ports, lookupBatchStatus, listLegsByBatchId, confirmVerified } = stubPorts();
    lookupBatchStatus.mockResolvedValue(verified([]));
    listLegsByBatchId.mockResolvedValue([LEG_FINDER, LEG_AGENT]);

    const result = await reconcilePayoutBatchStatus('TRK-1', ports);

    expect(confirmVerified).not.toHaveBeenCalled();
    expect(result.confirmedLegIds).toEqual([]);
    expect(result.unresolvedLegIds).toEqual(['TXN-F', 'TXN-A']);
  });

  it('refuses a "completed" transaction that carries no transaction id', async () => {
    const { ports, lookupBatchStatus, listLegsByBatchId, confirmVerified } = stubPorts();
    lookupBatchStatus.mockResolvedValue(verified([txn(null, 'completed', 'TS100')]));
    listLegsByBatchId.mockResolvedValue([LEG_FINDER, LEG_AGENT]);

    const result = await reconcilePayoutBatchStatus('TRK-1', ports);

    expect(confirmVerified).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      { transactionId: null, verdict: 'completed', reason: 'unmatched_provider_transaction' },
    ]);
  });

  it('never confirms from a failed or cancelled verdict (and never touches retry state)', async () => {
    const { ports, lookupBatchStatus, listLegsByBatchId, confirmVerified } = stubPorts();
    lookupBatchStatus.mockResolvedValue(verified([
      txn('TX-F', 'failed', 'TF103'),
      txn('TX-A', 'cancelled', 'TC108'),
    ]));
    listLegsByBatchId.mockResolvedValue([LEG_FINDER, LEG_AGENT]);

    const result = await reconcilePayoutBatchStatus('TRK-1', ports);

    expect(confirmVerified).not.toHaveBeenCalled();
    expect(result.confirmedLegIds).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'provider_verdict_not_completed',
      'provider_verdict_not_completed',
    ]);
    expect(result.unresolvedLegIds).toEqual(['TXN-F', 'TXN-A']);
  });

  it('confirms nothing when no local leg carries the batch id (legacy rows)', async () => {
    const { ports, lookupBatchStatus, listLegsByBatchId, confirmVerified, audit } = stubPorts();
    lookupBatchStatus.mockResolvedValue(verified([txn('TX-F', 'completed', 'TS100')]));
    listLegsByBatchId.mockResolvedValue([]);

    const result = await reconcilePayoutBatchStatus('TRK-1', ports);

    expect(result.handled).toBe(true);
    expect(confirmVerified).not.toHaveBeenCalled();
    expect(result.confirmedLegIds).toEqual([]);
    expect(audit.mock.calls.some((c) => c[0] === 'PAYOUT_VERIFICATION_NO_LOCAL_LEGS')).toBe(true);
  });

  it('refuses two legs that share the same (batch, transaction) pair', async () => {
    const { ports, lookupBatchStatus, listLegsByBatchId, confirmVerified } = stubPorts();
    lookupBatchStatus.mockResolvedValue(verified([txn('TX-F', 'completed', 'TS100')]));
    listLegsByBatchId.mockResolvedValue([
      { ...LEG_FINDER },
      { ...LEG_AGENT, provider_transaction_id: 'TX-F' },
    ]);

    const result = await reconcilePayoutBatchStatus('TRK-1', ports);

    expect(confirmVerified).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      { transactionId: 'TX-F', verdict: 'completed', reason: 'unmatched_provider_transaction' },
    ]);
  });

  it('a duplicate delivery is a no-op because the CAS has already resolved the leg', async () => {
    const { ports, lookupBatchStatus, listLegsByBatchId, confirmVerified } = stubPorts();
    lookupBatchStatus.mockResolvedValue(verified([txn('TX-F', 'completed', 'TS100')]));
    listLegsByBatchId.mockResolvedValue([LEG_FINDER]);
    // The row is already 'completed', so the compare-and-swap matches no row.
    confirmVerified.mockResolvedValue(false);

    const result = await reconcilePayoutBatchStatus('TRK-1', ports);

    expect(confirmVerified).toHaveBeenCalledTimes(1);
    expect(result.confirmedLegIds).toEqual([]);
    expect(result.skipped).toEqual([
      { transactionId: 'TX-F', verdict: 'completed', reason: 'leg_not_confirmable' },
    ]);
  });

  it('surfaces a provider transport failure as an error and confirms nothing', async () => {
    const { ports, lookupBatchStatus, confirmVerified } = stubPorts();
    lookupBatchStatus.mockRejectedValue(new Error('socket hang up'));
    await expect(reconcilePayoutBatchStatus('TRK-1', ports)).rejects.toThrow('socket hang up');
    expect(confirmVerified).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// STRUCTURAL INVARIANTS — these do NOT replace the behavioural tests above.
// They pin the NEGATIVE: this module has no vocabulary in which to submit,
// retry, approve, cancel or finalise anything, so a later edit cannot quietly
// give the webhook trigger that power.
//
// Comments are stripped first, because the module's own documentation NAMES the
// functions it must never call (that is how the boundary is explained to a
// reader), and a raw substring match would flag its own explanation.
// ---------------------------------------------------------------------------
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('BATCH 1 — the verification path cannot submit, approve or settle', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../payoutReconciliation.ts'), 'utf8');
  const code = stripComments(source);

  it('names no submission, approval, cancellation or settlement call', () => {
    for (const forbidden of [
      'triggerIntasendPayout',
      'triggerIntasendRefund',
      'executeClaimSettlement',
      'finalizeSettlement',
      'approveSettlement',
      'attemptSettlementRelease',
      'revertSettlementRelease',
      'recordPayoutAttempt',
      'markPayoutSubmissionStarted',
    ]) {
      expect(code, `${forbidden} must not appear in the verification path`).not.toContain(forbidden);
    }
  });

  it('contains no direct write of its own (every write goes through a port)', () => {
    expect(code).not.toContain('paid_at');
    expect(code).not.toContain('.insert(');
    expect(code).not.toContain('.update(');
    expect(code).not.toContain('.delete(');
  });

  it('delegates to the injected production ports rather than re-implementing them', () => {
    // The provider lookup, the scoped leg read, the CAS and the audit write must
    // be the real implementations, in exactly one place each.
    expect(code).toContain('PaymentService.fetchIntasendPayoutBatchStatus');
    expect(code).toContain('db.getPayoutLegsByProviderBatchId');
    expect(code).toContain('db.confirmPayoutVerified');
    expect(code).toContain("db.logAudit('SYSTEM', action, details)");
  });
});
