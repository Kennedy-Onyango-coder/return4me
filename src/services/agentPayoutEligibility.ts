// PROGRAMME 1 / WS2 + WS5 — AGENT PAYOUT ELIGIBILITY, RISK CLASS AND EARNINGS
// ==========================================================================
// PURE. No React, no I/O, no import of server.ts or db/database.ts, so every
// rule below is executed by tests rather than asserted about in a comment.
//
// WHY THIS MODULE EXISTS
// ----------------------
// 1. THE AGENT PAYOUT PATH HAS A LAUNCH POLICY, AND THE CONSOLE COULD NOT SEE
//    IT. A payout leg is submittable only when its destination normalises to a
//    Kenyan personal M-Pesa number (254 + nine digits) AND its method is
//    exactly `Personal M-Pesa` (config/payoutDestinations.ts). Every agent
//    registered before that policy existed still carries a Till Number,
//    Paybill, Pochi la Biashara or free-form method string. The executor
//    refuses those legs at settlement time, so the refusal was discoverable
//    ONLY by attempting a payout — the worst possible moment. This module turns
//    that stored state into a per-agent eligibility VERDICT the console can
//    show, and into the inventory WS1 classifies legacy agents by.
//
// 2. IT RE-STATES NOTHING. The verdict is produced by calling
//    resolvePayoutLegEligibility() — the SAME function the settlement executor
//    asks — so the console and the money path cannot drift. The reason codes
//    are that module's closed vocabulary, never a local re-derivation.
//
// 3. IT IS NOT A VERIFICATION. This says FORMAT and PERMITTED METHOD only. No
//    result may be described as "verified", "validated" or "confirmed": a
//    well-formed number that belongs to a stranger is still well-formed, and
//    nothing here proves the number is registered, reachable or owned by this
//    hub. The operator-facing sentence below says exactly that.
//
// 4. AN EARNINGS FIGURE THE SERVER DID NOT SEND IS NOT ZERO. The Agents Hub
//    rendered `agent.total_earned || 0`, so a missing figure read as "KES 0
//    earned" — a figure-shaped lie about money. computeAgentPendingEarnings()
//    returns null for a total it cannot honestly state (any row whose amount is
//    unreadable), and the console renders "Not recorded" for null. `null` and
//    `0` are different facts and stay different here.
//
// NO PII LEAVES THIS MODULE. The only destination value ever returned is the
// MASKED one produced by maskPayoutDestinationForLog(). There is no function
// here that returns a destination in the clear.

import {
  PERSONAL_MPESA_PAYOUT_METHOD,
  describePayoutDestinationRefusal,
  resolvePayoutLegEligibility,
  type PayoutDestinationRefusalReason,
} from '../config/payoutDestinations';

// ---------------------------------------------------------------------------
// THE RISK CLASSES (one closed vocabulary, shared by the console and the runbook)
// ---------------------------------------------------------------------------

/**
 * The class a stored agent payout destination falls into.
 *
 * `eligible`                                  — the launch policy accepts it.
 * `refused_destination_missing`               — no destination is recorded.
 * `refused_destination_not_a_personal_mpesa_phone`
 *                                             — the destination is present but
 *                                               is not (and does not normalise
 *                                               to) 254 + nine digits: a Till,
 *                                               Paybill, Pochi or malformed
 *                                               number.
 * `refused_unsupported_payout_method`         — the destination may be fine, but
 *                                               the stored method is not the one
 *                                               supported method.
 *
 * These map 1:1 onto PayoutDestinationRefusalReason (plus the eligible case) on
 * purpose: the console groups, counts and navigates by class, and the executor
 * refuses by reason, and the two must never disagree about a given agent.
 */
export type AgentPayoutRiskClass =
  | 'eligible'
  | 'refused_destination_missing'
  | 'refused_destination_not_a_personal_mpesa_phone'
  | 'refused_unsupported_payout_method';

/** Every class, in report order. Iterating this (not Object.keys) keeps the
 *  inventory's shape deterministic even on a JSON round-trip. */
export const AGENT_PAYOUT_RISK_CLASSES: readonly AgentPayoutRiskClass[] = [
  'eligible',
  'refused_destination_missing',
  'refused_destination_not_a_personal_mpesa_phone',
  'refused_unsupported_payout_method',
];

/** The class a refusal reason belongs to. `null` (no refusal) is eligible. */
export function classifyAgentPayoutRisk(
  reason: PayoutDestinationRefusalReason | null | undefined,
): AgentPayoutRiskClass {
  switch (reason) {
    case 'destination_missing':
      return 'refused_destination_missing';
    case 'destination_not_a_personal_mpesa_phone':
      return 'refused_destination_not_a_personal_mpesa_phone';
    case 'unsupported_payout_method':
      return 'refused_unsupported_payout_method';
    default:
      // No reason means no refusal. A reason this build does not recognise is
      // NOT treated as eligible: it fails closed to the method class. This build
      // provides no control that corrects a stored method, so the class is a
      // statement of the refusal only — never an implied repair step.
      return reason == null ? 'eligible' : 'refused_unsupported_payout_method';
  }
}

// ---------------------------------------------------------------------------
// THE PER-AGENT VERDICT (what the console renders; no PII inside)
// ---------------------------------------------------------------------------

export interface AgentPayoutEligibilityView {
  /** True only when the stored destination and method pass the launch policy. */
  eligible: boolean;
  /** The executor's own refusal code, or null when eligible. Never a phone. */
  reason: PayoutDestinationRefusalReason | null;
  /** The class the inventory counts this agent under. */
  risk_class: AgentPayoutRiskClass;
  /** The destination, MASKED. Safe to render and to log. Never in the clear. */
  masked_destination: string;
  /**
   * One operator-facing sentence. PII-free, and it never claims the destination
   * was verified — only that its FORMAT and METHOD pass the launch policy.
   */
  summary: string;
}

/** The sentence shown for an eligible agent. Deliberately not "verified". */
export const AGENT_PAYOUT_ELIGIBLE_SUMMARY =
  'This payout destination is a personal M-Pesa phone number and the method is the one supported method. ' +
  'That is a format and method check only: it does not confirm the number is registered, reachable, or owned by this hub.';

/**
 * Classify one stored agent row.
 *
 * The row is read as UNKNOWN on purpose (a whitelisted DTO row, a raw database
 * row, or a partially-populated fixture all produce a verdict here), and only
 * the two fields the policy actually decides on are read:
 * `mpesa_till_or_paybill` (the destination) and `payout_method_type` (the
 * method). Nothing else on the row can change the verdict.
 */
export function resolveAgentPayoutEligibility(agent: any): AgentPayoutEligibilityView {
  const eligibility = resolvePayoutLegEligibility({
    recipientType: 'agent',
    destination: agent?.mpesa_till_or_paybill,
    payoutMethodType: agent?.payout_method_type,
  });

  if (eligibility.eligible) {
    return {
      eligible: true,
      reason: null,
      risk_class: 'eligible',
      // The masked form, never the canonical one: the canonical value is the
      // unmasked number and has no business in a console payload.
      masked_destination: eligibility.maskedDestination,
      summary: AGENT_PAYOUT_ELIGIBLE_SUMMARY,
    };
  }

  return {
    eligible: false,
    reason: eligibility.reason,
    risk_class: classifyAgentPayoutRisk(eligibility.reason),
    masked_destination: eligibility.maskedDestination,
    summary:
      `This hub cannot be paid: ${describePayoutDestinationRefusal(eligibility)}. ` +
      `A payout with this destination is refused before it is submitted, so no money was sent. ` +
      `This build provides no control that corrects a stored destination or method, so the value cannot be fixed here, ` +
      `and retrying a refused payout does not correct the destination: the same stored value is refused again. ` +
      `${PERSONAL_MPESA_PAYOUT_METHOD} is the only supported method.`,
  };
}

// ---------------------------------------------------------------------------
// THE INVENTORY (WS1 — how many agents are at risk, and why)
// ---------------------------------------------------------------------------

export interface AgentPayoutRiskInventory {
  /** Agents examined. */
  total: number;
  /** Agents whose destination and method pass the launch policy. */
  eligible: number;
  /** Agents refused by the launch policy (total - eligible). */
  refused: number;
  /** Refused agents per class. Every class is present, even at 0, so a missing
   *  key can never be read as "no such problem". */
  by_risk_class: Record<AgentPayoutRiskClass, number>;
  /** The masked-destination verdicts, one per input row, in input order. Used by
   *  the console list and by the inventory report. */
  verdicts: AgentPayoutEligibilityView[];
}

/** How many agents the launch policy refuses. The Overview's one figure (WS2). */
export function countAgentPayoutIneligible(agents: any): number {
  if (!Array.isArray(agents)) return 0;
  return agents.reduce((count, agent) => (resolveAgentPayoutEligibility(agent).eligible ? count : count + 1), 0);
}

/** The full inventory, per class. Pure; reads the rows it is given. */
export function summarizeAgentPayoutRisk(agents: any): AgentPayoutRiskInventory {
  const rows: any[] = Array.isArray(agents) ? agents : [];
  const verdicts = rows.map(resolveAgentPayoutEligibility);

  const by_risk_class = AGENT_PAYOUT_RISK_CLASSES.reduce(
    (acc, cls) => { acc[cls] = 0; return acc; },
    {} as Record<AgentPayoutRiskClass, number>,
  );
  for (const verdict of verdicts) by_risk_class[verdict.risk_class] += 1;

  return {
    total: verdicts.length,
    eligible: by_risk_class.eligible,
    refused: verdicts.length - by_risk_class.eligible,
    by_risk_class,
    verdicts,
  };
}

// ---------------------------------------------------------------------------
// WS5 — AGENT EARNINGS THAT DO NOT INVENT A ZERO
// ---------------------------------------------------------------------------

export interface AgentPendingEarnings {
  /**
   * SUM of this agent's ledger rows that are recorded as `agent_payout` and
   * still `pending` (i.e. earned but not yet paid out), or NULL when at least
   * one such row carries an amount this build cannot read. NULL means "this
   * total cannot be stated", and the console renders the missing marker for it;
   * it is never rendered as 0.
   */
  amount: number | null;
  /** How many pending payout rows this agent has. A genuine 0 when there are none. */
  count: number;
}

/** Sum rounded to cents, matching the NUMERIC(10,2) scale of `ledger.amount`. */
function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * This agent's pending (earned, not yet paid) payout figure, computed from the
 * ledger rows and the agent's own item ids — both already loaded by the caller,
 * so this adds no query.
 *
 * `pending` is the ledger status the money path writes for a share that is owed
 * but not yet sent; `completed` rows are deliberately excluded (they are what
 * `total_earned` counts), so the two figures cannot double-count a shilling.
 */
export function computeAgentPendingEarnings(
  ledger: any,
  agentItemIds: ReadonlySet<string> | readonly string[] | null | undefined,
): AgentPendingEarnings {
  const ids = agentItemIds instanceof Set
    ? agentItemIds
    : new Set(Array.isArray(agentItemIds) ? agentItemIds : []);
  const rows: any[] = Array.isArray(ledger) ? ledger : [];
  if (ids.size === 0) return { amount: 0, count: 0 };

  let total = 0;
  let count = 0;
  for (const row of rows) {
    if (row?.type !== 'agent_payout' || row?.status !== 'pending') continue;
    if (!row?.item_id || !ids.has(row.item_id)) continue;
    count += 1;
    const value = typeof row.amount === 'string'
      ? (row.amount.trim() ? Number(row.amount) : NaN)
      : row.amount;
    // An unreadable amount on a row we are counting makes the TOTAL unstatable.
    // Returning a partial sum here would understate money owed, which is the
    // worse failure, so the whole figure becomes null and says so.
    if (typeof value !== 'number' || !Number.isFinite(value)) return { amount: null, count };
    total += value;
  }

  return { amount: roundToCents(total), count };
}
