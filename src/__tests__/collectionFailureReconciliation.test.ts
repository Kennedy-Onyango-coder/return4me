import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  COLLECTION_FAILURE_REASON_CODES,
  collectionFailureReasonCode,
  normalizeCollectionFailureState,
  normalizeCollectionStateToken,
} from '../config/collectionFailureStates';
import {
  reconcileCollectionFailureEvent,
  type CollectionFailureReconciliationDeps,
  type CollectionFailureSessionFacts,
} from '../services/collectionFailureReconciliation';

// =============================================================================
// COLLECTION FAILURE RECONCILIATION.
//
// THE DEFECT. The IntaSend collection webhook answered
//
//     if (state !== 'COMPLETE') return res.json({ status: 'ignored' });
//
// so a TERMINAL provider verdict (FAILED / CANCELLED) was dropped on the floor.
// The payment session stayed `pending` with no recorded reason, the customer's
// screen kept promising a prompt that would never be answered, and nothing
// anywhere explained what happened - so the customer either abandoned the claim
// or paid a second time.
//
// WHAT IS PINNED HERE.
//   * FAILED/CANCELLED are recognised tolerantly (casing, spaces, hyphens and
//     the common `*_failed` / `*_cancelled` spellings) - vocabulary block.
//   * A session is marked failed ONLY after the provider authority corroborates
//     it, so a wrong callback can never strand real money on an unconfirmable
//     attempt.
//   * A contradicting COMPLETE answer runs the ONE canonical confirmation path,
//     so money is RECOVERED rather than written off.
//   * PENDING / unknown / unverifiable events write NOTHING, and a settled
//     session is never re-interpreted.
//
// The decision table is exercised with injected dependencies: no database, no
// network, no webhook. The final block pins the production wiring, because a
// decision table nobody calls would be an inert feature.
// =============================================================================

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
const webhooksTs = fs.readFileSync(path.resolve(__dirname, '../routes/webhooks.ts'), 'utf8');
const serviceTs = fs.readFileSync(
  path.resolve(__dirname, '../services/collectionFailureReconciliation.ts'),
  'utf8'
);

describe('collection failure vocabulary: tolerant, closed, and never a guess', () => {
  it('recognises the FAILED family regardless of casing, spacing or separators', () => {
    for (const state of [
      'FAILED',
      'failed',
      ' Failed ',
      'PAYMENT_FAILED',
      'payment-failed',
      'payment failed',
      'TRANSACTION_FAILED',
      'DECLINED',
      'REJECTED',
      'INSUFFICIENT_FUNDS',
      'error',
    ]) {
      expect(normalizeCollectionFailureState(state), state).toBe('failed');
    }
  });

  it('recognises the CANCELLED family, including the American spelling', () => {
    for (const state of [
      'CANCELLED',
      'canceled',
      'CANCELED_BY_USER',
      'cancelled by user',
      'USER_CANCELLED',
      'abandoned',
    ]) {
      expect(normalizeCollectionFailureState(state), state).toBe('cancelled');
    }
  });

  it('treats in-flight, success, absent and unknown states as NOT a failure', () => {
    for (const state of [
      'COMPLETE',
      'PENDING',
      'PROCESSING',
      'INITIATED',
      'SOMETHING_NEW_FROM_THE_PROVIDER',
      '',
      '   ',
      null,
      undefined,
      0,
      123,
      {},
      [],
      true,
    ]) {
      expect(normalizeCollectionFailureState(state), String(state)).toBeNull();
    }
  });

  it('does NOT classify an expired/timed-out prompt as a terminal failure', () => {
    // This is a MONEY-SAFETY decision, not an oversight. An `expired` session
    // stays confirmable on purpose, because a payer can approve the prompt after
    // this process gave up. Marking the session `failed` from an EXPIRED hint
    // would refuse that late approval, turning a real payment into stranded
    // money. The local expiry path owns prompts that ran out of time.
    for (const state of ['EXPIRED', 'TIMEOUT', 'TIMED_OUT']) {
      expect(normalizeCollectionFailureState(state), state).toBeNull();
    }
  });

  it('normalises the token without inventing characters', () => {
    expect(normalizeCollectionStateToken('  payment--failed  ')).toBe('PAYMENT_FAILED');
    expect(normalizeCollectionStateToken(null)).toBe('');
    expect(normalizeCollectionStateToken({ a: 1 })).toBe('');
  });

  it('persists a stable, closed reason vocabulary per kind', () => {
    expect(collectionFailureReasonCode('failed')).toBe('provider_reported_failed');
    expect(collectionFailureReasonCode('cancelled')).toBe('provider_reported_cancelled');
    // No provider spelling, punctuation or amount may appear in a stored code:
    // it has to be groupable by an operator and comparable by a future reader.
    for (const code of Object.values(COLLECTION_FAILURE_REASON_CODES)) {
      expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});

// -----------------------------------------------------------------------------
// Decision table. Every dependency is a spy, so each case can assert not only
// the verdict but WHAT IT TOUCHED: the safety property is "wrote nothing", which
// an outcome alone cannot prove.
// -----------------------------------------------------------------------------
const CLAIM = 'CLM-1';
const INVOICE = 'INV-1';
const SESSION: CollectionFailureSessionFacts = {
  id: 'PS-1',
  claim_id: CLAIM,
  status: 'pending',
  amount: 200,
};

function makeDeps(overrides: {
  session?: CollectionFailureSessionFacts | null;
  verdict?: {
    verified: boolean;
    reason: string;
    providerState?: string | null;
    providerAmount?: number | string | null;
  };
  confirmResult?: string | null;
  markResult?: boolean;
} = {}) {
  const calls: Array<{ name: string; args: any[] }> = [];
  const record = (name: string, args: any[]) => {
    calls.push({ name, args });
  };
  const deps: CollectionFailureReconciliationDeps = {
    getSessionByProviderInvoice: async (invoiceId) => {
      record('getSessionByProviderInvoice', [invoiceId]);
      return overrides.session === undefined ? SESSION : overrides.session;
    },
    fetchAuthoritativeStatus: async (invoiceId, expectedAmount, expectedApiRef) => {
      record('fetchAuthoritativeStatus', [invoiceId, expectedAmount, expectedApiRef]);
      const verdict = overrides.verdict ?? { verified: false, reason: 'provider_unused' };
      return {
        verified: verdict.verified,
        reason: verdict.reason,
        providerState: verdict.providerState ?? null,
        providerAmount: verdict.providerAmount ?? null,
      };
    },
    confirmPayment: async (claimId, invoiceId, confirmedAmount) => {
      record('confirmPayment', [claimId, invoiceId, confirmedAmount]);
      return overrides.confirmResult === undefined ? 'PICK-1' : overrides.confirmResult;
    },
    markSessionFailed: async (sessionId, reasonCode) => {
      record('markSessionFailed', [sessionId, reasonCode]);
      return overrides.markResult === undefined ? true : overrides.markResult;
    },
    audit: async (action, message) => {
      record('audit', [action, message]);
    },
  };
  const named = (name: string) => calls.filter((c) => c.name === name);
  return { deps, calls, named };
}

describe('a non-COMPLETE event that is not a terminal failure changes nothing', () => {
  it('PENDING is a no-op and touches no dependency at all', async () => {
    const { deps, calls } = makeDeps();
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'PENDING' },
      deps
    );
    expect(result.outcome).toBe('not_a_failure_state');
    expect(result.kind).toBeNull();
    // Not even a session read: an in-flight prompt is not this module's business.
    expect(calls).toHaveLength(0);
  });

  it('refuses an event with no identity instead of guessing which attempt it means', async () => {
    const { deps, calls } = makeDeps();
    const result = await reconcileCollectionFailureEvent(
      { claimId: '', invoiceId: INVOICE, reportedState: 'FAILED' },
      deps
    );
    expect(result.outcome).toBe('invalid_event_identity');
    expect(result.kind).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('does nothing when no payment session owns the invoice', async () => {
    const { deps, named } = makeDeps({ session: null });
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'FAILED' },
      deps
    );
    expect(result.outcome).toBe('no_payment_session');
    expect(named('fetchAuthoritativeStatus')).toHaveLength(0);
    expect(named('markSessionFailed')).toHaveLength(0);
    expect(named('confirmPayment')).toHaveLength(0);
  });

  it('refuses an invoice that belongs to a DIFFERENT claim and audits the refusal', async () => {
    const { deps, named } = makeDeps({ session: { ...SESSION, claim_id: 'CLM-OTHER' } });
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'CANCELLED' },
      deps
    );
    expect(result.outcome).toBe('cross_claim_refused');
    // Neither claim may be changed by an event about the other.
    expect(named('markSessionFailed')).toHaveLength(0);
    expect(named('confirmPayment')).toHaveLength(0);
    const audits = named('audit');
    expect(audits).toHaveLength(1);
    expect(audits[0].args[0]).toBe('COLLECTION_FAILURE_CROSS_CLAIM_REFUSED');
  });
});

describe('a settled session is never re-interpreted', () => {
  it('a confirmed (paid) session is left alone: a failure hint cannot un-pay money', async () => {
    const { deps, named } = makeDeps({ session: { ...SESSION, status: 'confirmed' } });
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'FAILED' },
      deps
    );
    expect(result.outcome).toBe('session_already_confirmed');
    expect(named('fetchAuthoritativeStatus')).toHaveLength(0);
    expect(named('markSessionFailed')).toHaveLength(0);
  });

  it('a redelivered failure is idempotent and costs no provider request', async () => {
    const { deps, named } = makeDeps({ session: { ...SESSION, status: 'failed' } });
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'FAILED' },
      deps
    );
    expect(result.outcome).toBe('session_already_failed');
    expect(named('fetchAuthoritativeStatus')).toHaveLength(0);
    expect(named('markSessionFailed')).toHaveLength(0);
  });
});

describe('the provider is re-verified BEFORE any write (the money guard)', () => {
  it('asks the provider about THIS invoice with the amount the payer was prompted for', async () => {
    const { deps, named } = makeDeps({
      verdict: { verified: false, reason: 'provider_state_not_complete', providerState: 'PENDING' },
    });
    await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'FAILED' },
      deps
    );
    // The amount matters: verifying against the wrong amount would either fail
    // every real payment or bless an underpayment.
    expect(named('fetchAuthoritativeStatus')[0].args).toEqual([INVOICE, 200, CLAIM]);
  });

  it('a hint of failure over a provider COMPLETE RECOVERS the money instead of writing it off', async () => {
    const { deps, named } = makeDeps({
      verdict: {
        verified: true,
        reason: 'verified',
        providerState: 'COMPLETE',
        providerAmount: 200,
      },
    });
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'FAILED' },
      deps
    );
    expect(result.outcome).toBe('provider_reports_complete_confirmed');
    // The ONE canonical confirmation path runs, so a pickup code is issued and
    // the claim is settled exactly as a COMPLETE callback would have done.
    expect(named('confirmPayment')[0].args).toEqual([CLAIM, INVOICE, 200]);
    // The failed stamp is never applied to a paid attempt.
    expect(named('markSessionFailed')).toHaveLength(0);
  });

  it('recovers a CANCELLED hint the same way: a wrong cancel callback is not a refund', async () => {
    const { deps, named } = makeDeps({
      verdict: { verified: true, reason: 'verified', providerState: 'COMPLETE', providerAmount: 200 },
    });
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'CANCELLED' },
      deps
    );
    expect(result.outcome).toBe('provider_reports_complete_confirmed');
    expect(named('confirmPayment')).toHaveLength(1);
    expect(named('markSessionFailed')).toHaveLength(0);
  });

  it('reports the recovery as UNCONFIRMED when the claim CAS refuses it, and still writes no failure', async () => {
    // A concurrent COMPLETE delivery may have taken the claim first. That is a
    // success at the system level (the money is recorded); losing the CAS must
    // never be translated into "so mark the attempt failed".
    const { deps, named } = makeDeps({
      verdict: { verified: true, reason: 'verified', providerState: 'COMPLETE', providerAmount: 200 },
      confirmResult: null,
    });
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'FAILED' },
      deps
    );
    expect(result.outcome).toBe('provider_reports_complete_unconfirmed');
    expect(named('markSessionFailed')).toHaveLength(0);
  });

  it('a still-open prompt writes nothing at all: the payer may yet approve it', async () => {
    const { deps, named } = makeDeps({
      verdict: { verified: false, reason: 'provider_state_not_complete', providerState: 'PENDING' },
    });
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'FAILED' },
      deps
    );
    expect(result.outcome).toBe('provider_still_open');
    expect(named('markSessionFailed')).toHaveLength(0);
    expect(named('confirmPayment')).toHaveLength(0);
    expect(named('audit')).toHaveLength(0);
  });

  it('an UNVERIFIABLE provider answer leaves the session alone and audits it for an operator', async () => {
    for (const reason of [
      'provider_lookup_failed',
      'provider_credentials_missing',
      'provider_amount_mismatch',
      'provider_invoice_mismatch',
      'provider_unexpected_response',
    ]) {
      const { deps, named } = makeDeps({ verdict: { verified: false, reason } });
      const result = await reconcileCollectionFailureEvent(
        { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'FAILED' },
        deps
      );
      expect(result.outcome, reason).toBe('provider_unverifiable');
      expect(named('markSessionFailed'), reason).toHaveLength(0);
      expect(named('confirmPayment'), reason).toHaveLength(0);
      const audits = named('audit');
      expect(audits, reason).toHaveLength(1);
      expect(audits[0].args[0]).toBe('COLLECTION_FAILURE_UNVERIFIED');
      // The diagnostic names the reason, so an operator can tell "no API key"
      // from "the provider said 500" without re-deriving it.
      expect(audits[0].args[1]).toContain(reason);
    }
  });

  it('verifies before writing - a provider call cannot come after the CAS', async () => {
    const { deps, calls } = makeDeps({
      verdict: { verified: false, reason: 'provider_state_not_complete', providerState: 'FAILED' },
    });
    await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'FAILED' },
      deps
    );
    const order = calls.map((c) => c.name);
    expect(order).toEqual([
      'getSessionByProviderInvoice',
      'fetchAuthoritativeStatus',
      'markSessionFailed',
      'audit',
    ]);
  });
});

describe('corroborated failure: the session is marked failed with a CLOSED reason code', () => {
  it('marks THIS session failed, with the stored code rather than the provider spelling', async () => {
    const { deps, named } = makeDeps({
      verdict: {
        verified: false,
        reason: 'provider_state_not_complete',
        providerState: 'PAYMENT_FAILED',
      },
    });
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'payment-failed' },
      deps
    );
    expect(result.outcome).toBe('session_marked_failed');
    expect(named('markSessionFailed')[0].args).toEqual(['PS-1', 'provider_reported_failed']);
    // No confirmation may follow a corroborated failure.
    expect(named('confirmPayment')).toHaveLength(0);
    // ... and the audit records BOTH states, so the decision is reproducible.
    const message = named('audit')[0].args[1];
    expect(named('audit')[0].args[0]).toBe('COLLECTION_FAILURE_CONFIRMED');
    expect(message).toMatch(/payment-failed/i);
    expect(message).toMatch(/PAYMENT_FAILED/);
  });

  it('uses the cancellation code when both sides agree it was cancelled', async () => {
    const { deps, named } = makeDeps({
      verdict: {
        verified: false,
        reason: 'provider_state_not_complete',
        providerState: 'CANCELLED',
      },
    });
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'CANCELLED' },
      deps
    );
    expect(result.outcome).toBe('session_marked_failed');
    expect(named('markSessionFailed')[0].args).toEqual(['PS-1', 'provider_reported_cancelled']);
  });

  it('a CAS loser reports session_not_markable and does not retry or confirm', async () => {
    // A concurrent COMPLETE delivery confirmed the attempt between the read and
    // the write. The database wins; this module must not force the failure.
    const { deps, named } = makeDeps({
      verdict: { verified: false, reason: 'provider_state_not_complete', providerState: 'FAILED' },
      markResult: false,
    });
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'FAILED' },
      deps
    );
    expect(result.outcome).toBe('session_not_markable');
    expect(named('markSessionFailed')).toHaveLength(1);
    expect(named('confirmPayment')).toHaveLength(0);
    // No "confirmed failure" audit is written for a write that did not happen.
    expect(named('audit')).toHaveLength(0);
  });
});

describe('an expired attempt keeps its money-safe status', () => {
  it('cannot be marked failed by the session CAS, so a late approval still lands', async () => {
    const { deps, named } = makeDeps({
      session: { ...SESSION, status: 'expired' },
      verdict: { verified: false, reason: 'provider_state_not_complete', providerState: 'FAILED' },
      // db.markPaymentSessionFailed only transitions created/payment_initiated/
      // pending, so an expired attempt loses this CAS on purpose.
      markResult: false,
    });
    const result = await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'FAILED' },
      deps
    );
    expect(result.outcome).toBe('session_not_markable');
    // An expired session is still verified (a late approval is the case the
    // confirmable-expired rule exists for) and the write is still attempted -
    // the refusal is the database's, not a silent skip.
    expect(named('fetchAuthoritativeStatus')).toHaveLength(1);
    expect(named('markSessionFailed')[0].args).toEqual(['PS-1', 'provider_reported_failed']);
  });
});

describe('audit hygiene: enough to investigate, nothing to leak', () => {
  it('never writes a phone number or a raw payload into the audit trail', async () => {
    const { deps, named } = makeDeps({
      verdict: { verified: false, reason: 'provider_state_not_complete', providerState: 'FAILED' },
    });
    await reconcileCollectionFailureEvent(
      { claimId: CLAIM, invoiceId: INVOICE, reportedState: 'FAILED' },
      deps
    );
    const message = named('audit')[0].args[1];
    // Claim + invoice are the join keys an operator needs to investigate.
    expect(message).toContain(CLAIM);
    expect(message).toContain(INVOICE);
    // No MSISDN, no provider API reference, no money amount in prose.
    expect(message).not.toMatch(/\+?254\d{9}/);
    expect(message).not.toMatch(/07\d{8}/);
  });
});

// -----------------------------------------------------------------------------
// PRODUCTION WIRING. A decision table that nothing calls is an inert feature,
// and a route that made the decision itself would give the payment lifecycle two
// sources of truth. These assertions pin the split: the route ASKS, this module
// DECIDES, server.ts SUPPLIES the financial primitives.
// -----------------------------------------------------------------------------
describe('production wiring: the route asks, the decision is made outside it', () => {
  it('delegates every non-COMPLETE collection state instead of dropping it', () => {
    // The pre-existing defect was `if (state !== 'COMPLETE') return ignored`.
    expect(webhooksTs).toMatch(/reconcileCollectionFailureEvent\(\{/);
    // Only the states the decision table calls non-terminal are still ignored.
    expect(webhooksTs).toMatch(/outcome === 'not_a_failure_state'/);
    // The route owns neither the write nor the provider lookup on this path.
    expect(webhooksTs).not.toContain('markPaymentSessionFailed');
    expect(webhooksTs).not.toContain('fetchAuthoritativeCollectionStatus');
    // A classification failure is surfaced, not swallowed: the provider retries.
    expect(webhooksTs).toMatch(/INTASEND_WEBHOOK_COLLECTION_FAILURE_ERROR/);
  });

  it('composes the reconciler from the real store, provider lookup, canonical confirmation and audit sink', () => {
    expect(serverTs).toMatch(
      /import \{ reconcileCollectionFailureEvent as reconcileCollectionFailure \} from '\.\/services\/collectionFailureReconciliation'/
    );
    for (const fragment of [
      'getSessionByProviderInvoice',
      'db.getPaymentSessionByProviderInvoice(invoiceId)',
      'PaymentService.fetchAuthoritativeCollectionStatus(invoiceId, expectedAmount, expectedApiRef)',
      'db.markPaymentSessionFailed(sessionId, reasonCode)',
      "db.logAudit('SYSTEM', action, message)",
    ]) {
      expect(serverTs, fragment).toContain(fragment);
    }
    // Recovery must route through the ONE canonical confirmation path rather
    // than a second, private "mark it paid" implementation.
    expect(serverTs).toMatch(
      /confirmPayment:[\s\S]{0,120}processClaimPaymentConfirmed\(claimId, invoiceId,/
    );
  });

  it('re-verifies with the provider before the one session write, in the module itself', () => {
    // ORDERING, not mere presence: a verification placed after the CAS would be
    // theatre, because the session would already be failed.
    const verifyAt = serviceTs.indexOf('await deps.fetchAuthoritativeStatus(');
    const markAt = serviceTs.indexOf('await deps.markSessionFailed(');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(verifyAt);
    // The failure write and the recovery confirmation each exist in exactly one
    // place, inside their own corroborated branch.
    expect(serviceTs.split('deps.markSessionFailed(').length - 1).toBe(1);
    expect(serviceTs.split('deps.confirmPayment(').length - 1).toBe(1);
    // ... and both are downstream of the verification.
    const confirmAt = serviceTs.indexOf('await deps.confirmPayment(');
    expect(confirmAt).toBeGreaterThan(verifyAt);
  });
});
