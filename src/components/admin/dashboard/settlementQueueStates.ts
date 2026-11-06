// =============================================================================
// STAGE 4B (F-04) — THE SETTLEMENT QUEUE, CLASSIFIED FROM THE FACTS THE PAYLOAD
// ALREADY PUBLISHES.
// =============================================================================
//
// THE DEFECT
//   The Overview's settlement card counted `pendingSettlements.length` — every
//   claim in `pending_settlement`, whether its review window was still open,
//   whether an approval was already on file, or whether a payout leg had already
//   been submitted. Under D6 (the platform approves automatically once
//   `claims.settle_at` elapses; payout initiation stays a separate, manual,
//   administrator-authorised step) that single number overstates the work in
//   front of an operator and cannot say which settlements need them NOW.
//
// WHY NO SERVER CHANGE IS NEEDED
//   `GET /api/admin/dashboard` already publishes everything the split needs, per
//   row (src/server.ts, pendingSettlements map):
//     settleAt                     the elapsed/not-elapsed fact
//     hasSettlementApproval        the persisted approval column, fail-closed
//     settlementApprovalSource     'system_auto_review_window' | 'administrator'
//                                  | 'unknown' | null  (D6, derived from the two
//                                  persisted columns only)
//     settlementApproval.state      'not_approved' | 'authorized' | 'legacy'
//                                  | 'incomplete' | 'unreadable'
//     payoutRecipients[].status / .payoutOutcome
//                                  the per-leg submission history
//
// THE FIVE BUCKETS, AND THE PRECEDENCE BETWEEN THEM
//   A row lands in EXACTLY ONE bucket, decided in this order:
//
//     1. advancing            — at least one payout leg proves an attempt or a
//                               completion. This outranks everything: a row that
//                               is both approved and moving is NOT "approved, not
//                               initiated", because saying so would invite a
//                               second initiation of money that may already be
//                               moving.
//     2. undetermined         — the legs were not published (a row that publishes
//                               no leg at all included), a leg's state cannot be
//                               read, `settleAt` cannot be dated, the approval
//                               record contradicts itself, or the approval on file
//                               cannot be verified against the booked rows. Never
//                               presented as actionable, never guessed at.
//     3. approved_not_initiated — a durable approval is on file and nothing has
//                               been submitted. Approval is NOT payment: this
//                               bucket exists precisely because the initiation
//                               step is still outstanding.
//     4. ready_now            — the review window has elapsed and no approval is
//                               on file yet. The window no longer blocks
//                               anything; the approval does.
//     5. in_window            — the review window has not elapsed. Nothing to do.
//
//   `ready_now + in_window + approved_not_initiated + advancing + undetermined
//   === pendingSettlements.length` is an invariant enforced by test.
//
// WHY "undetermined" EXISTS AT ALL
//   Missing is not zero and unknown is not a state: a legacy payout leg with no
//   recorded submission history cannot be proven never-submitted, so it can
//   neither be called "not initiated" (that implies initiation is available) nor
//   "advancing" (that claims an attempt happened). Rows like that are named as
//   unclassified and count for nothing actionable.
//
// WHAT THIS MODULE CANNOT DO
//   It is PURE and READ-ONLY. It approves nothing, initiates nothing, retries
//   nothing, releases nothing and reconciles nothing — it has no I/O at all. The
//   server re-decides every condition on any real initiation request; the
//   console's classification is a reading of the current payload, never an
//   authority.
// =============================================================================

import { isPayoutOutcome, isPayoutSubmittable, isUnresolvedPayoutOutcome } from '../../../config/payoutOutcomes';

/**
 * How a claim came to be approved for settlement.
 *
 * Declared here, not imported, so that this module's dependency closure is closed
 * within the published tree: the console's settlement-queue classification must not
 * depend on the settlement auto-approval policy module. The three members are the
 * settlement approval contract —
 *   * `system_auto_review_window` — the platform recorded it (reserved actor on file);
 *   * `administrator`            — a named administrator recorded it;
 *   * `unknown`                  — an approval IS on file but carries no usable actor
 *                                  (a legacy row). Reported as such, never assumed
 *                                  to be either of the above.
 *
 * The members are structurally identical to that policy module's own declaration, so
 * the two are interchangeable by assignment; they are to be unified when the policy
 * module itself is published.
 */
export type SettlementApprovalSource =
  | 'system_auto_review_window'
  | 'administrator'
  | 'unknown';

/** The five buckets a `pendingSettlements` row can land in. */
export type SettlementQueueState =
  | 'ready_now'
  | 'in_window'
  | 'approved_not_initiated'
  | 'advancing'
  | 'undetermined';

/** Every bucket, in precedence order (advancing first, undetermined last). */
export const SETTLEMENT_QUEUE_STATES: readonly SettlementQueueState[] = [
  'advancing',
  'approved_not_initiated',
  'ready_now',
  'in_window',
  'undetermined',
];

/**
 * Operator-facing group names. The breakdown sentence reads these exactly, so the
 * words an operator sees are the words this module's tests pin — no second
 * vocabulary is invented in the JSX.
 *
 * `advancing` is worded "payout activity recorded", NOT "already started". The
 * bucket holds every row where a leg proves an attempt or a completion, and that
 * includes 'rejected' (a local classification that does not prove the transfer
 * failed to execute) and 'completed' (the money has already moved). "Started"
 * reads as "in progress" and is false for both, while the neutral phrase is true
 * of all five outcomes and still keeps these rows out of the actionable figure.
 */
export const SETTLEMENT_QUEUE_STATE_LABELS: Record<SettlementQueueState, string> = {
  ready_now: 'ready now',
  in_window: 'in window',
  approved_not_initiated: 'approved, not initiated',
  advancing: 'payout activity recorded',
  undetermined: 'need review',
};

/** How an approval came to exist, in operator-facing words (the D6 distinction). */
export const SETTLEMENT_APPROVAL_SOURCE_LABELS: Record<SettlementApprovalSource, string> = {
  system_auto_review_window: 'automatic',
  administrator: 'by an administrator',
  unknown: 'unknown source',
};

/** The card's existing sentence, kept verbatim for a genuinely empty queue. */
export const SETTLEMENT_QUEUE_EMPTY_DESCRIPTION =
  'Claims in the dispute window awaiting settlement action.';

/**
 * What the card says when this server build did not publish the array at all.
 * Missing is not empty: an unreported queue is "not reported", never "0".
 */
export const SETTLEMENT_QUEUE_UNREPORTED_DESCRIPTION =
  'This server build did not report the settlement queue — read it as unknown, not as empty.';

/** One row's classification. */
export interface SettlementQueueEntry {
  /** The row's own claim id, or null when the payload did not carry one. */
  claimId: string | null;
  state: SettlementQueueState;
  /**
   * How the approval came to exist — set only for `approved_not_initiated`, null
   * everywhere else. 'system_auto_review_window' and 'administrator' are NEVER
   * collapsed into one another: an automatic approval is not a human sign-off.
   */
  approvalSource: SettlementApprovalSource | null;
  /** Why this row could not be classified. Null for every classified row. */
  undeterminedReason: string | null;
}

/** The whole queue, counted once. */
export interface SettlementQueueSummary {
  /** False when the payload carried no array — "not reported", not "empty". */
  reported: boolean;
  total: number;
  counts: Record<SettlementQueueState, number>;
  /** Approved-not-initiated rows by approval source (the D6 distinction). */
  approvalSources: Record<SettlementApprovalSource, number>;
  rows: SettlementQueueEntry[];
}

const emptyCounts = (): Record<SettlementQueueState, number> => ({
  ready_now: 0,
  in_window: 0,
  approved_not_initiated: 0,
  advancing: 0,
  undetermined: 0,
});

const emptyApprovalSources = (): Record<SettlementApprovalSource, number> => ({
  system_auto_review_window: 0,
  administrator: 0,
  unknown: 0,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `claims.settle_at` as a comparable instant, or NULL when the payload did not
 * carry a readable one. A missing/unparseable time is never "0" and therefore
 * never "elapsed": the fail-closed default the server itself applies to the same
 * column.
 */
function readSettleAt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The D6 approval source, normalised to the three-value vocabulary. */
function readApprovalSource(value: unknown): SettlementApprovalSource | null {
  return value === 'system_auto_review_window' || value === 'administrator' || value === 'unknown'
    ? value
    : null;
}

/**
 * One payout leg, read through the EXISTING vocabulary — no status string is
 * invented here.
 *
 *   'untouched'  the authoritative retry rule (isPayoutSubmittable) says this row
 *                may still be sent: it is booked, pending, and positively
 *                recorded as never submitted. Nothing has begun.
 *   'advancing'  the row records an attempt or a completion: the unresolved
 *                outcomes (submitting | accepted | unknown), a provider refusal
 *                classified locally ('rejected' — which cannot prove the transfer
 *                did not execute), or a 'completed' row (the money moved).
 *   'unreadable' no submission history is readable, so the leg can neither be
 *                called untouched nor advancing.
 */
function legState(leg: unknown): 'untouched' | 'advancing' | 'unreadable' {
  if (!isRecord(leg)) return 'unreadable';
  const status = typeof leg.status === 'string' ? leg.status : null;
  const outcome = leg.payoutOutcome;
  if (!isPayoutOutcome(outcome)) return 'unreadable';
  if (isUnresolvedPayoutOutcome(outcome)) return 'advancing';
  if (outcome === 'not_submitted') {
    // A completed row is paid whatever its history says; anything else must be
    // positively submittable to count as "nothing has begun".
    if (status === 'completed') return 'advancing';
    return isPayoutSubmittable({ status, payout_outcome: outcome }) ? 'untouched' : 'unreadable';
  }
  return 'advancing';
}

/**
 * Classify ONE `pendingSettlements` row in the precedence order documented at the
 * top of this file. Pure and total: every input, including a malformed one,
 * produces exactly one state and never throws.
 */
export function classifySettlementQueueRow(
  row: unknown,
  now: number = Date.now(),
): SettlementQueueEntry {
  const record = isRecord(row) ? row : null;
  const claimId = record && typeof record.claimId === 'string' ? record.claimId : null;
  const result = (
    state: SettlementQueueState,
    approvalSource: SettlementApprovalSource | null = null,
    undeterminedReason: string | null = null,
  ): SettlementQueueEntry => ({ claimId, state, approvalSource, undeterminedReason });

  if (record === null) return result('undetermined', null, 'the settlement row could not be read');

  // 1. A leg that has been submitted outranks every other fact about the row.
  const legs = record.payoutRecipients;
  if (!Array.isArray(legs)) {
    return result('undetermined', null, 'the payout legs were not published for this claim');
  }
  // F3 — an array that carries no leg is not "nothing has begun": there is nothing
  // to read, and inferring "untouched" from an empty list would offer the row for
  // initiation on the strength of legs the payload never published. Zero legs is
  // unclassifiable, exactly like a missing array.
  if (legs.length === 0) {
    return result('undetermined', null, 'no payout recipient legs were reported');
  }
  const legStates = legs.map(legState);
  if (legStates.includes('advancing')) return result('advancing');
  if (legStates.includes('unreadable')) {
    return result('undetermined', null, 'a payout leg has no readable submission history');
  }

  // 2. A time that cannot be read is never "elapsed", so it can never be "ready".
  const settleAt = readSettleAt(record.settleAt);
  if (settleAt === null) {
    return result('undetermined', null, 'the settlement time could not be read');
  }

  // 3. The approval on file, checked against the snapshot's OWN state.
  const approved = record.hasSettlementApproval === true;
  const approval = isRecord(record.settlementApproval) ? record.settlementApproval : null;
  const approvalState = approval && typeof approval.state === 'string' ? approval.state : null;

  if (!approved) {
    if (approvalState !== null && approvalState !== 'not_approved') {
      return result('undetermined', null, 'an approval snapshot is present but no approval is on file');
    }
    return settleAt <= now ? result('ready_now') : result('in_window');
  }

  // F5 — the approval column says an approval is on file, so the payload must have
  // published the snapshot object with it. An ABSENT object is not a legacy
  // approval: `legacy` is an explicit `state: 'legacy'` snapshot, and the payload
  // always carries one. With no object there is no state to check and nothing to
  // compare, so the row fails closed rather than being guessed at.
  if (approval === null) {
    return result('undetermined', null, 'an approval is on file but the approval snapshot was not published');
  }

  if (approvalState !== null && approvalState !== 'authorized' && approvalState !== 'legacy') {
    const reason = approvalState === 'not_approved'
      ? 'the approval column and the approval snapshot disagree'
      : `the approval on file cannot authorize a payout (${approvalState})`;
    return result('undetermined', null, reason);
  }

  // F4 — the snapshot's OWN verdict on whether today's booked rows still match the
  // rows that were approved. `false` is a mismatch; `null` (and an absent field)
  // means the comparison could not be made at all — a covered ledger row is
  // missing or unreadable (config/settlementApprovalDisplay.ts). Neither may be
  // read as agreement: an `authorized` snapshot passes only on a literal `true`.
  // A `legacy` approval recorded no rows to compare, so it is exempt from the
  // `true` requirement and keeps its existing handling; only a literal `false`
  // blocks it.
  if (approval.bookedRowsAgreeWithApproval === false) {
    return result('undetermined', null, 'the booked payout rows no longer match the approved rows');
  }
  if (approvalState !== 'legacy' && approval.bookedRowsAgreeWithApproval !== true) {
    return result('undetermined', null, 'the approved payout rows could not be verified against the booked rows');
  }

  // 4. Approval is NOT payment: the initiation step is still outstanding, whether
  //    or not the review window has elapsed. An approval with no recorded actor is
  //    'unknown' — never guessed to be automatic.
  return result('approved_not_initiated', readApprovalSource(record.settlementApprovalSource) ?? 'unknown');
}

/**
 * The order the breakdown sentence READS in — the actionable group first, exactly
 * as the audit's example does ("3 ready · 7 in window · 2 approved"). This is a
 * presentation order only; the classification precedence is the one above.
 */
export const SETTLEMENT_QUEUE_BREAKDOWN_ORDER: readonly SettlementQueueState[] = [
  'ready_now',
  'in_window',
  'approved_not_initiated',
  'advancing',
  'undetermined',
];

/**
 * Classify the whole queue. `reported` is FALSE when the payload carried no array
 * at all — a different fact from an empty array: the card renders an em dash for
 * "not reported" and a genuine `0` for "empty".
 */
export function classifySettlementQueue(
  rows: unknown,
  now: number = Date.now(),
): SettlementQueueSummary {
  const reported = Array.isArray(rows);
  const list = reported ? (rows as unknown[]) : [];
  const counts = emptyCounts();
  const approvalSources = emptyApprovalSources();
  const entries = list.map((row) => classifySettlementQueueRow(row, now));

  for (const entry of entries) {
    counts[entry.state] += 1;
    if (entry.state === 'approved_not_initiated' && entry.approvalSource !== null) {
      approvalSources[entry.approvalSource] += 1;
    }
  }

  return { reported, total: entries.length, counts, approvalSources, rows: entries };
}

/** ` (1 automatic, 2 by an administrator)` — empty when no source is on file. */
function approvalSourceBreakdown(sources: Record<SettlementApprovalSource, number>): string {
  const parts: string[] = [];
  for (const source of ['system_auto_review_window', 'administrator', 'unknown'] as const) {
    const count = sources[source];
    if (count > 0) parts.push(`${count} ${SETTLEMENT_APPROVAL_SOURCE_LABELS[source]}`);
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * The card's secondary line: the NON-ZERO groups in operator-facing words, with
 * the approval source kept distinct ("2 approved, not initiated (1 automatic,
 * 1 by an administrator)"). A genuinely empty queue keeps the card's existing
 * sentence; an unreported queue says so rather than showing a reassuring 0.
 */
export function settlementQueueBreakdownText(summary: SettlementQueueSummary): string {
  if (!summary.reported) return SETTLEMENT_QUEUE_UNREPORTED_DESCRIPTION;
  if (summary.total === 0) return SETTLEMENT_QUEUE_EMPTY_DESCRIPTION;

  const parts: string[] = [];
  for (const state of SETTLEMENT_QUEUE_BREAKDOWN_ORDER) {
    const count = summary.counts[state];
    if (count <= 0) continue;
    const label = SETTLEMENT_QUEUE_STATE_LABELS[state];
    parts.push(
      state === 'approved_not_initiated'
        ? `${count} ${label}${approvalSourceBreakdown(summary.approvalSources)}`
        : `${count} ${label}`,
    );
  }
  return parts.join(' · ');
}
