// =============================================================================
// PHASE 3 — READ-ONLY SETTLEMENT READINESS
// =============================================================================
// The Pending Settlement checklist asks the SAME questions the settlement
// executor asks immediately before it marks a payout as submitted:
//
//   claim state, elapsed review window, durable approval, the approval snapshot,
//   the booked payout rows, each row's payout outcome, destination policy,
//   booked-vs-planned integrity, payout pause, simulation policy and wallet
//   configuration.
//
// It is PURE and READ-ONLY: no provider call, no wallet-balance read, no write.
// The server still re-decides every condition on the real initiation request;
// this module exists so an operator can see WHY initiation would be refused
// before clicking, not to replace the server's authority.
// =============================================================================

import {
  PERSONAL_MPESA_PAYOUT_METHOD,
  resolvePayoutLegEligibility,
} from './payoutDestinations';
import { isPayoutSubmittable } from './payoutOutcomes';
import { compareSettlementAuthorization } from './settlementAuthorizationSnapshot';
import { resolveSettlementPayoutIntegrity } from './settlementPayoutIntegrity';
import { describeSettlementRefusal, type SettlementRefusalCode } from './settlementRefusal';

export interface SettlementReadinessCondition {
  code: SettlementRefusalCode;
  ok: boolean;
  label: string;
  detail: string;
  next_action: string;
}

export interface SettlementReadinessInput {
  claim: any | null;
  item: any | null;
  agent: any | null;
  category: any | null;
  ledgerRows: readonly any[];
  payoutsPaused: boolean;
  simulation: { required: boolean; permitted: boolean };
  wallet: { disbursementConfigured: boolean; routingOk: boolean; routingCode: string | null };
  now?: Date;
}

export interface SettlementReadinessResult {
  ready: boolean;
  conditions: SettlementReadinessCondition[];
  blockers: SettlementRefusalCode[];
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function plannedShare(item: any, category: any, role: 'finder' | 'agent'): number | null {
  const locked =
    role === 'finder'
      ? positiveNumber(item?.locked_finder_share)
      : positiveNumber(item?.locked_agent_share);
  if (locked !== null) return locked;
  return positiveNumber(role === 'finder' ? category?.finder_share : category?.agent_share);
}

function condition(
  code: SettlementRefusalCode,
  ok: boolean,
  label: string,
  detail?: string | null,
): SettlementReadinessCondition {
  const refusal = describeSettlementRefusal(code, detail);
  return {
    code,
    ok,
    label,
    detail: ok ? '' : refusal.operator_message,
    next_action: ok ? '' : refusal.next_action,
  };
}

function finish(conditions: SettlementReadinessCondition[]): SettlementReadinessResult {
  const blockers = conditions.filter((item) => !item.ok).map((item) => item.code);
  return { ready: blockers.length === 0, conditions, blockers };
}

/**
 * Evaluate every precondition. An `ok: false` condition is a blocker; there is
 * no "unknown means ready" path anywhere in this function.
 */
export function evaluateSettlementReadiness(
  input: SettlementReadinessInput,
): SettlementReadinessResult {
  const now = input?.now ?? new Date();
  const conditions: SettlementReadinessCondition[] = [];
  const claim = input?.claim ?? null;
  const item = input?.item ?? null;
  const agent = input?.agent ?? null;
  const category = input?.category ?? null;
  const rows = Array.isArray(input?.ledgerRows) ? input.ledgerRows : [];

  const claimFound = Boolean(claim);
  conditions.push(condition('claim_not_found', claimFound, 'Claim record is readable'));
  if (!claimFound) return finish(conditions);

  const dataComplete = Boolean(item && agent && category);
  conditions.push(
    condition(
      'claim_data_unreadable',
      dataComplete,
      'Item, assigned agent and category are readable',
      [item ? null : 'item missing', agent ? null : 'agent missing', category ? null : 'category missing']
        .filter(Boolean)
        .join(', '),
    ),
  );

  const statusOk = claim.status === 'pending_settlement';
  conditions.push(
    condition(
      'claim_not_pending_settlement',
      statusOk,
      'Claim is in pending settlement',
      statusOk ? null : `status is '${String(claim.status ?? 'unknown')}'`,
    ),
  );

  const settleAt = claim.settle_at ? new Date(claim.settle_at).getTime() : NaN;
  const windowElapsed = Number.isFinite(settleAt) && settleAt <= now.getTime();
  conditions.push(
    condition(
      'settlement_window_open',
      windowElapsed,
      'Dispute review window has elapsed',
      windowElapsed
        ? null
        : claim.settle_at
          ? `settle_at is ${String(claim.settle_at)}`
          : 'no settle_at is recorded',
    ),
  );

  conditions.push(
    condition(
      'durable_approval_missing',
      claim.settlement_approved_at != null,
      'A durable settlement approval is on file',
    ),
  );

  const finderRow = rows.find((row) => row?.type === 'finder_payout');
  const agentRow = rows.find((row) => row?.type === 'agent_payout');
  const requiredRowsPresent = Boolean(finderRow && agentRow);
  conditions.push(
    condition(
      'payout_rows_missing',
      requiredRowsPresent,
      'Finder and agent payout rows are booked',
      requiredRowsPresent ? null : 'one or both required payout rows are absent',
    ),
  );

  const payoutRows = rows.filter(
    (row) => row?.type === 'finder_payout' || row?.type === 'agent_payout',
  );
  const readableRows =
    payoutRows.length > 0 && payoutRows.every((row) => positiveNumber(row?.amount) !== null);
  conditions.push(
    condition(
      'payout_rows_unreadable',
      readableRows,
      'Booked payout amounts are readable',
      readableRows ? null : 'a payout row carries an unreadable amount',
    ),
  );

  const outstanding = payoutRows.filter((row) => row?.status !== 'completed');
  const submittable = outstanding.filter((row) => isPayoutSubmittable(row));
  // No outstanding leg is NOT a blocker: the initiation path then finalizes a
  // claim whose money has already gone out. It is stated, never silently ready.
  const allOutstandingSubmittable =
    outstanding.length === 0 || submittable.length === outstanding.length;
  conditions.push(
    condition(
      outstanding.length === 0 ? 'payout_already_sent' : 'payout_outcome_unresolved',
      allOutstandingSubmittable,
      outstanding.length === 0
        ? 'All payout legs are already completed'
        : 'Every outstanding payout leg is eligible for submission',
      allOutstandingSubmittable
        ? null
        : `${outstanding.length - submittable.length} outstanding row(s) are not submittable`,
    ),
  );

  const candidates = [
    finderRow
      ? {
          row: finderRow,
          recipientType: 'finder' as const,
          destination: item?.finder_phone,
          payoutMethodType: PERSONAL_MPESA_PAYOUT_METHOD,
          plannedAmount: plannedShare(item, category, 'finder'),
        }
      : null,
    agentRow
      ? {
          row: agentRow,
          recipientType: 'agent' as const,
          destination: agent?.mpesa_till_or_paybill,
          payoutMethodType: agent?.payout_method_type || 'Till Number',
          plannedAmount: plannedShare(item, category, 'agent'),
        }
      : null,
  ].filter(Boolean) as Array<{
    row: any;
    recipientType: 'finder' | 'agent';
    destination: any;
    payoutMethodType: string;
    plannedAmount: number | null;
  }>;

  const outstandingCandidates = candidates.filter(
    (candidate) => candidate.row?.status !== 'completed',
  );
  const destinationRefusals = outstandingCandidates
    .map((candidate) =>
      resolvePayoutLegEligibility({
        recipientType: candidate.recipientType,
        destination: candidate.destination,
        payoutMethodType: candidate.payoutMethodType,
      }),
    )
    .filter((leg) => !leg.eligible);
  const destinationsOk =
    dataComplete && outstandingCandidates.length > 0 && destinationRefusals.length === 0;
  conditions.push(
    condition(
      'destination_not_eligible',
      destinationsOk,
      'Outstanding destinations are Personal M-Pesa phones',
      destinationsOk
        ? null
        : dataComplete
          ? destinationRefusals
              .map((leg) => `${leg.recipientType}: ${leg.reason} (${leg.maskedDestination})`)
              .join('; ')
          : 'destination data could not be read',
    ),
  );


  const integrity = resolveSettlementPayoutIntegrity(
    outstandingCandidates.map((candidate) => ({
      recipientType: candidate.recipientType,
      ledgerEntryId: String(candidate.row?.id ?? ''),
      bookedAmount: candidate.row?.amount,
      bookedDestination: candidate.row?.phone_or_till,
      plannedAmount: candidate.plannedAmount,
      plannedDestination: candidate.destination,
    })),
  );
  conditions.push(
    condition(
      'ledger_amount_mismatch',
      integrity.amountMismatches.length === 0,
      'Planned amounts equal the booked ledger amounts',
      integrity.amountMismatches.join('; ') || null,
    ),
  );
  conditions.push(
    condition(
      'ledger_destination_mismatch',
      integrity.destinationMismatches.length === 0,
      'Planned destinations equal the booked destinations',
      integrity.destinationMismatches.join('; ') || null,
    ),
  );

  const authorization = compareSettlementAuthorization(
    {
      authorizedTotal: claim.settlement_authorized_total ?? null,
      authorizedLedgerIds: claim.settlement_authorized_ledger_ids ?? null,
    },
    payoutRows.map((row) => ({
      ledgerEntryId: String(row?.id ?? ''),
      recipientType: row?.type === 'agent_payout' ? ('agent' as const) : ('finder' as const),
      amount: row?.amount,
    })),
  );
  // A legacy approval (both snapshot columns NULL) is REPORTED, never refused:
  // initiate accepts it too and stays bound to the booked rows.
  const authorizationOk = authorization.ok || authorization.code === 'legacy_approval';
  const authorizationUnreadable =
    !authorization.ok &&
    [
      'incomplete_snapshot',
      'unparseable_snapshot',
      'unreadable_authorized_total',
      'current_legs_unreadable',
    ].includes(authorization.code);
  conditions.push(
    condition(
      authorizationUnreadable ? 'approval_snapshot_unreadable' : 'approval_snapshot_mismatch',
      authorizationOk,
      'Approval snapshot covers exactly these payout rows',
      authorizationOk ? null : ((authorization as any).message ?? authorization.code),
    ),
  );

  conditions.push(condition('payout_paused', input?.payoutsPaused !== true, 'Payouts are not paused'));
  conditions.push(
    condition(
      'simulation_not_permitted',
      !(input?.simulation?.required === true && input?.simulation?.permitted !== true),
      'A real provider submission is permitted in this environment',
    ),
  );
  conditions.push(
    condition(
      'disbursement_wallet_missing',
      input?.wallet?.disbursementConfigured === true,
      'Disbursement wallet is configured for this environment',
    ),
  );
  conditions.push(
    condition(
      'wallet_routing_refused',
      input?.wallet?.routingOk === true,
      'Payout wallet routing guard passed',
      input?.wallet?.routingCode ?? null,
    ),
  );

  return finish(conditions);
}
