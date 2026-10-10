// THE DEV PAYMENT-SIMULATION GATE (Phase 10, F-4)
// ===============================================
// POST /api/dev/simulate-payment/:claimId fabricates an AUTHORITATIVE payment
// confirmation: it drives the same confirmation path the real M-Pesa webhook uses
// and moves a claim to `escrow_held`, stamping `paid_at` — with no money moving
// at all. Because the effect is indistinguishable from a real payment to every
// downstream reader, the gate in front of it must never be loosened by accident.
//
// It requires ALL THREE of:
//   1. NODE_ENV explicitly 'development' or 'test' — NOT unset, NOT production.
//      An unset NODE_ENV is the classic configuration mistake, so it must not
//      count as "not production".
//   2. ALLOW_MOCK_OTP_BYPASS === 'true'          (the existing dev convenience)
//   3. ENABLE_DEV_PAYMENT_SIMULATION === 'true'  (dedicated, money-specific)
// Condition 3 is deliberately separate from condition 2 so that a NON-money
// convenience switch can never, on its own, expose a money-faking endpoint.
//
// WHY THIS PREDICATE WAS EXTRACTED (Phase 10, F-4)
// The logic previously lived in a private function inside server.ts, which boots
// the whole application on import and therefore cannot be imported by a test —
// so the gate had NO regression coverage at all. The extraction is
// behaviour-preserving: server.ts keeps its `isDevPaymentSimulationEnabled()`
// call sites exactly as they were and simply delegates to this function with the
// same three process.env values. Nothing about payment amounts, escrow,
// webhooks, authorisation or production behaviour changes; only the gate's
// location, so that "under which conditions can this endpoint run?" is testable.
//
// The production boot refusal that pairs with this gate lives in server.ts
// (it throws when NODE_ENV=production and condition 3 is set, rather than merely
// ignoring it) and is asserted in the accompanying test.

import { isPaymentReconciliationEligible } from './paymentReconciliation';

/** NODE_ENV values that count as explicitly non-production. */
export const DEV_SIMULATION_ENVS = ['development', 'test'] as const;

/**
 * Whether the money-faking dev payment simulator may run in this configuration.
 *
 * Pure: takes the three values explicitly. Every operand is compared with `===`
 * against a literal, so any absent/undefined/other value fails closed.
 */
export function resolveDevPaymentSimulationEnabled(
  nodeEnv: string | undefined,
  allowMockOtpBypass: string | undefined,
  enableDevPaymentSimulation: string | undefined,
): boolean {
  const isExplicitNonProductionEnv =
    nodeEnv === 'development' || nodeEnv === 'test';

  return (
    isExplicitNonProductionEnv &&
    allowMockOtpBypass === 'true' &&
    enableDevPaymentSimulation === 'true'
  );
}

// ---------------------------------------------------------------------------
// D-2A-H — WHICH ATTEMPT MAY A SIMULATED CONFIRMATION STAND FOR?
// ---------------------------------------------------------------------------
//
// The endpoint above the gate fabricates an AUTHORITATIVE payment confirmation,
// and the canonical confirmation path (server.ts processClaimPaymentConfirmed)
// turns it into real writes: the claim becomes `escrow_held` with `paid_at` set,
// the attempt's own payment session is consumed, and — since D-2A — exactly the
// receipt row whose `provider_transaction_id` equals the confirming invoice is
// completed.
//
// It used to confirm under `TEST-SIMULATED-<now>`: a reference belonging to no
// attempt, no session and no provider record. Nothing could be correlated by
// it. The claim moved, a reference that never existed was stamped into
// `claims.payment_reference` (the column payment-truth readers treat as "this
// claimant actually paid" — see the SC-4/SC-6 note on the claim-level pay
// route), and the attempt's real receipt row stayed 'pending' forever even
// though the claim then read as paid.
//
// The invoice that DOES identify the attempt is already persisted: the
// initiate route stores the provider invoice id — the same value the booking
// code stamped on that attempt's receipt row — as the session's
// `provider_invoice_id` (db.finalizePaymentSessionInitiated). So the simulator
// stands for the claim's newest CONFIRMABLE session, i.e. the same
// claim/session/invoice correlation the background reconciliation sweep uses
// (server.ts reconcilePendingPaymentSessions) and the same set of states the
// production recovery paths accept (config/paymentReconciliation.ts).
//
// It never invents a reference: when no attempt can be identified, the caller
// must refuse the request, and no receipt row, no session and no claim may move.
//
// WHY THIS SELECTOR WAS EXTRACTED
// The same reason the gate above was: server.ts boots the whole application on
// import and cannot be imported by a test, so a selection rule living inside the
// route would have no regression coverage at all. This function is pure — it
// reads only the rows it is handed and returns a value; the caller performs
// every write, and the canonical path plus the atomic claim/session CAS still
// decide whether any write happens.

/** The existing payment attempt a simulated confirmation is allowed to stand for. */
export interface SimulatedAttemptReference {
  /** The payment session that owns the attempt. */
  sessionId: string;
  /** The provider invoice id that attempt's receipt row is stamped with. */
  invoiceId: string;
  /** The session's authoritative amount, in KES. */
  amount: number | string | null;
  /** The session status the attempt was found in. */
  sessionStatus: string;
}

/**
 * The claim's newest confirmable payment attempt, or null when there is none.
 *
 * "Confirmable" is deliberately the SAME decision the production recovery paths
 * make (a reconcilable claim, a session in `pending`/`expired`/`confirmed`, and
 * a persisted provider invoice), so the simulator cannot drift into confirming
 * an attempt production would refuse. It authorises nothing on its own.
 *
 * Deterministic: the newest `created_at` wins and ties are broken by session id,
 * so the choice can never depend on the row order the database returned.
 */
export function resolveSimulatedAttemptReference(
  sessions: ReadonlyArray<any> | null | undefined,
  claim: { claimId: string; claimStatus?: string | null; paidAt?: string | Date | null },
): SimulatedAttemptReference | null {
  const eligible = (sessions ?? []).filter((session) => {
    if (!session) return false;
    // Defence in depth: the caller lists ONE claim's sessions, but an invoice
    // bound to another claim must never be usable here even so.
    if (claim.claimId != null && session.claim_id !== claim.claimId) return false;
    const invoice =
      typeof session.provider_invoice_id === 'string' ? session.provider_invoice_id.trim() : '';
    // Without a provider invoice there is no identity to correlate, so the
    // attempt cannot be confirmed and must not be guessed at.
    if (invoice === '') return false;
    return isPaymentReconciliationEligible({
      claimStatus: claim.claimStatus ?? null,
      paidAt: claim.paidAt ?? null,
      sessionStatus: session.status,
      hasProviderInvoice: true,
    });
  });
  if (eligible.length === 0) return null;

  const newest = eligible.reduce((best: any, session: any) => {
    const candidateAt = new Date(session.created_at ?? 0).getTime() || 0;
    const bestAt = new Date(best.created_at ?? 0).getTime() || 0;
    if (candidateAt !== bestAt) return candidateAt > bestAt ? session : best;
    return String(session.id) > String(best.id) ? session : best;
  });

  return {
    sessionId: String(newest.id),
    invoiceId: String(newest.provider_invoice_id).trim(),
    amount: newest.amount ?? null,
    sessionStatus: String(newest.status),
  };
}
