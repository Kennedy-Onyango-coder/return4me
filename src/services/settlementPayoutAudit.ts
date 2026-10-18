// =============================================================================
// BATCH 1 (E) — THE SETTLEMENT PAYOUT SNAPSHOT, AS ONE PURE VALUE.
// =============================================================================
// WHY THIS EXISTS
//   A settlement payout is authorized in one request and executed in another
//   (approval + initiation), or in the same request but through a compare-and-
//   swap chain (approve-and-pay). Between those moments the two facts that
//   decide WHERE money goes — the finder's stored phone and the agent's stored
//   payout target — are ordinary editable columns. Nothing about paying the
//   claim re-reads them against what the operator actually approved.
//
//   This module makes the "what was authorized" and "what is about to be paid"
//   facts comparable, and renders them in a form that is safe to write to the
//   audit log:
//
//     * buildSettlementPayoutPlan()          — the legs an attempt will send
//                                              (row id, recipient, destination,
//                                              method, amount) plus the claim's
//                                              payment reference.
//     * formatSettlementPayoutPlanForAudit() — ONE audit-safe line. Destinations
//                                              are MASKED; the raw value never
//                                              leaves this process.
//     * settlementDestinationFacts()         — the destinations + methods alone,
//                                              for comparing two moments.
//     * describeSettlementDestinationDrift() — what changed between them,
//                                              described without the values.
//
// WHY IT IS PURE (AND WHY THAT MATTERS HERE)
//   This repository runs vitest in a `node` environment. Money-path rules that
//   live only inside a route handler can only be asserted by reading the source.
//   Keeping the snapshot/format/compare rules here means the audit trail's
//   CONTENT is decided by ordinary functions a test can call.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//   It does not persist anything and does not decide eligibility. It is a
//   presentation + comparison layer over state the caller already resolved from
//   the database, so it can never become a second source of truth for a payout.
//
//   It also cannot compare against an APPROVAL-TIME snapshot: `claims` carries no
//   durable record of the destination or amount a particular approval authorized,
//   and adding one is a schema migration — reported separately rather than bolted
//   on here (see the Batch 1 report). Drift ACROSS REQUESTS is nevertheless closed
//   on the money path, by the executor rather than here:
//   config/settlementPayoutIntegrity.ts compares every planned leg with the
//   destination and amount BOOKED in its own ledger row before submission, and
//   refuses the whole payout on a difference.
// =============================================================================

import { maskPhoneForLog } from './auth.ts';

/** One recipient leg of a settlement payout. */
export interface SettlementPayoutLeg {
  /** The ledger row this leg pays. The row, not the recipient, is the unit of
   *  submission idempotency (see config/payoutOutcomes.ts). */
  readonly ledgerEntryId: string;
  readonly recipientType: 'finder' | 'agent';
  /** The FULL stored destination. Never rendered; used only to build the masked
   *  form and (in memory) to compare two moments. */
  readonly destination: string;
  readonly payoutMethodType: string;
  readonly amount: number;
}

/** What one settlement attempt will submit, and for which claim. */
export interface SettlementPayoutPlan {
  readonly claimId: string;
  /** The claim's payment reference, when the row carries one. Omitted rather
   *  than invented when it does not. */
  readonly paymentReference: string | null;
  /** Settlement is KES-only; stated rather than assumed by a reader. */
  readonly currency: 'KES';
  readonly legs: readonly SettlementPayoutLeg[];
  readonly totalAmount: number;
}

/** The two editable facts that decide where a leg's money goes. */
export interface SettlementDestinationSide {
  readonly destination: string | null;
  readonly payoutMethodType: string;
}

export interface SettlementDestinationFacts {
  readonly finder: SettlementDestinationSide | null;
  readonly agent: SettlementDestinationSide | null;
}

/** The repository's ONE masking rule (services/auth.ts), re-exported so a
 *  caller building audit text has no reason to reach for the raw value. */
export const maskSettlementDestination = (destination: string | null | undefined): string =>
  maskPhoneForLog(destination);

/** Renders an amount without binary-float noise, and says "unknown" rather than
 *  printing NaN into an audit row. */
function formatAmount(amount: number): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return 'unknown';
  return String(Math.round(amount * 100) / 100);
}


/**
 * Builds the plan from legs the caller resolved from the database.
 *
 * `totalAmount` is the SUM of the legs, so a caller cannot accidentally report
 * a headline figure that disagrees with what is actually being sent.
 */
export function buildSettlementPayoutPlan(input: {
  claimId: string;
  paymentReference?: string | null;
  legs: readonly SettlementPayoutLeg[];
}): SettlementPayoutPlan {
  const legs = input.legs.map((leg) => ({ ...leg }));
  const totalAmount = legs.reduce(
    (sum, leg) => sum + (typeof leg.amount === 'number' && Number.isFinite(leg.amount) ? leg.amount : 0),
    0,
  );
  return {
    claimId: input.claimId,
    paymentReference: input.paymentReference ?? null,
    currency: 'KES',
    legs,
    totalAmount: Math.round(totalAmount * 100) / 100,
  };
}

/**
 * ONE audit-safe line describing what an attempt is about to submit.
 *
 * Every destination is masked with the repository's own phone masker, so this
 * string can be written to `audit_log.details` (and read by an operator) without
 * disclosing a full phone number or payout target. The ledger row id is included
 * because that — not the claim — is what the provider submission is keyed to.
 */
export function formatSettlementPayoutPlanForAudit(plan: SettlementPayoutPlan): string {
  const legs = plan.legs.map((leg) =>
    `${leg.recipientType} ${maskSettlementDestination(leg.destination)} ` +
    `(${leg.payoutMethodType}) KES ${formatAmount(leg.amount)} row=${leg.ledgerEntryId}`,
  );
  const reference = plan.paymentReference ? ` payment_reference=${plan.paymentReference}` : '';
  return (
    `claim=${plan.claimId}${reference} total=${plan.currency} ${formatAmount(plan.totalAmount)} ` +
    `legs=[${legs.join('; ')}]`
  );
}

/**
 * The destination facts of a claim, as read at ONE moment. A missing destination
 * is represented as null rather than '' so "not set" and "empty string" cannot
 * be confused with each other in a comparison.
 */
export function settlementDestinationFacts(input: {
  finderPhone?: string | null;
  agentDestination?: string | null;
  agentPayoutMethodType?: string | null;
}): SettlementDestinationFacts {
  const finder =
    typeof input.finderPhone === 'string' && input.finderPhone.length > 0
      ? { destination: input.finderPhone, payoutMethodType: 'Personal M-Pesa' }
      : null;
  const agent =
    typeof input.agentDestination === 'string' && input.agentDestination.length > 0
      ? {
          destination: input.agentDestination,
          payoutMethodType: input.agentPayoutMethodType || 'Till Number',
        }
      : null;
  return { finder, agent };
}

/**
 * What changed between two moments, described WITHOUT the destination values.
 *
 * An empty array means nothing that decides where money goes has changed. Each
 * entry names the leg and the FIELDS that moved, so an operator reading the
 * audit trail knows whether to re-verify a recipient or merely re-check the
 * payout method.
 */
export function describeSettlementDestinationDrift(
  before: SettlementDestinationFacts,
  after: SettlementDestinationFacts,
): string[] {
  const drift: string[] = [];
  for (const side of ['finder', 'agent'] as const) {
    const was = before[side];
    const now = after[side];
    if (!was && !now) continue;
    if (!was || !now) {
      drift.push(`${side} destination ${was ? 'removed' : 'added'}`);
      continue;
    }
    if (was.destination !== now.destination) drift.push(`${side} destination changed`);
    if (was.payoutMethodType !== now.payoutMethodType) {
      drift.push(`${side} payout method changed (${was.payoutMethodType} -> ${now.payoutMethodType})`);
    }
  }
  return drift;
}
