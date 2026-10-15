// PROGRAMME 1 / WS1 + WS2 + WS5 — PAYOUT-INTEGRITY READ MODEL (PURE, REACT-FREE)
// =============================================================================
// The Payout Integrity section answers two questions the console could not
// answer, from ONE payload it already holds (the bulk dashboard's agent rows):
//
//   WS1/WS2 — CAN THIS HUB BE PAID AT ALL?
//     Settlement refuses a payout whose stored destination is a Till, a
//     Paybill, a Pochi la Biashara number or a free-form value
//     (config/payoutDestinations.ts). The verdict rendered here is the server's
//     own `payout_eligibility` object, which services/agentPayoutEligibility.ts
//     builds by asking the executor's own resolver — so this screen cannot
//     disagree with the refusal that actually happens at settlement time. This
//     module does NOT re-derive it.
//
//   WS5 — HOW MUCH DOES THE PLATFORM STILL OWE THIS HUB?
//     `pending_earnings` is money recorded as owed but not yet paid out. Its
//     NULL is a real state: at least one pending row carried an amount this
//     build could not read, so no total can be stated. NULL becomes the missing
//     marker — never 0, and never a partial sum.
//
// FAIL CLOSED ON A VERDICT THIS CONSOLE DOES NOT RECOGNISE
//     A row whose `payout_eligibility` is absent (an older server build, or a
//     payload that lost the field) is NOT rendered as payable and NOT rendered
//     as refused-with-a-guess: it is reported as a verdict this console cannot
//     read, and grouped with the rows that need a human. Unknown must never
//     masquerade as the safe answer.
//
// WHY THIS IS A MODULE AND NOT JSX LOGIC
//     The mapping is the part that can be wrong in a way nobody sees (a null
//     read as 0, an unknown class read as eligible). Kept pure and typed, a test
//     in this repository's node-only vitest environment can execute it; the
//     table beside it only formats what this module decided.
//
// PRIVACY
//     The destination arrives ALREADY MASKED from the server DTO and is copied
//     verbatim. Nothing here can un-mask: the row this module reads has no raw
//     destination field, and a value that is not a string becomes a fully masked
//     marker rather than being forwarded.

import { formatKesAmount } from '../dashboard/adminOverviewMetrics';
import type { AgentPayoutRiskClass } from '../../../services/agentPayoutEligibility';

/** The operator-facing sentence for each launch-policy class. */
export const PAYOUT_RISK_CLASS_LABELS: Record<AgentPayoutRiskClass, string> = {
  eligible: 'Payable',
  refused_destination_missing: 'Refused — no payout destination recorded',
  refused_destination_not_a_personal_mpesa_phone:
    'Refused — destination is not a personal M-Pesa number',
  refused_unsupported_payout_method: 'Refused — unsupported payout method',
};

/**
 * The label for a class this console may or may not know. An unrecognised token
 * is stated as unreadable rather than mapped onto the nearest known class: the
 * operator then treats the row as needing a human, which is the safe answer.
 */
export function describePayoutRiskClass(value: unknown): string {
  if (typeof value === 'string' && value in PAYOUT_RISK_CLASS_LABELS) {
    return PAYOUT_RISK_CLASS_LABELS[value as AgentPayoutRiskClass];
  }
  return 'Verdict not readable by this console — treat as not payable';
}

/** One hub row, as the Payout Integrity table renders it. */
export interface PayoutIntegrityHubRow {
  agentId: string | null;
  /** The hub name, or the explicit missing marker. Never blank. */
  businessName: string;
  /** The server's MASKED destination, or its '(none)' / '***' marker. */
  destinationMasked: string;
  /** True only when the server said, in so many words, that this hub is payable. */
  eligible: boolean;
  /** True when the console could not read a verdict at all (fail closed). */
  verdictUnreadable: boolean;
  /** The raw class token, or null. Shown so an operator can grep it. */
  riskClass: string | null;
  riskLabel: string;
  /** The verdict's own sentence. '' when the server sent none. */
  summary: string;
  /** 'KES 120.00', or the em-dash missing marker. */
  pendingEarningsLabel: string;
  /** True only when a genuine figure produced the label above. */
  pendingEarningsReported: boolean;
  /**
   * How many not-yet-paid payout rows this hub has — a real 0 when there are
   * none — or NULL when the payload carried something that is not a whole,
   * non-negative number of rows. NULL means "this build cannot state the row
   * count", and the table says so rather than rounding a fractional count into
   * looking plausible or printing 0, which would claim nothing is owed. The same
   * rule the Overview applies to its own count fields (adminOverviewMetrics.ts,
   * isReportedCountField).
   */
  pendingPayoutCount: number | null;
}

/** Where the destination text came from, or the fully-masked fallback. */
function readMaskedDestination(raw: unknown): string {
  if (typeof raw !== 'string') return '***';
  const value = raw.trim();
  if (!value) return '***';
  // Idempotent: a value that already carries a mask (or the explicit "no
  // destination" marker) is copied as-is; anything else is masked HERE too, so
  // this module cannot render a number the server forgot to mask.
  return value === '(none)' || value.includes('*') ? value : '***';
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * One dashboard agent row -> one hub row. Returns null only when the input is
 * not an object (a row this module cannot describe at all), so a malformed entry
 * is dropped instead of becoming a plausible-looking empty row.
 */
export function readPayoutIntegrityHubRow(agent: unknown): PayoutIntegrityHubRow | null {
  if (!agent || typeof agent !== 'object') return null;
  const row = agent as Record<string, any>;
  const verdict = row.payout_eligibility && typeof row.payout_eligibility === 'object'
    ? (row.payout_eligibility as Record<string, any>)
    : null;

  // The ONLY way to be payable is an explicit `eligible: true` on a verdict the
  // server actually sent. Everything else — an absent verdict, a missing key, a
  // string, a number — is not payable.
  const eligible = verdict?.eligible === true;
  const riskClass = eligible ? 'eligible' : optionalText(verdict?.risk_class) ?? null;
  const pending = formatKesAmount(row.pending_earnings);
  const rawCount = row.pending_earnings_count;
  // A COUNT of rows is a whole, non-negative number or it is not a count: a
  // fractional or negative value is a server defect, not a figure (the same rule
  // the Overview applies to its count fields). `null` therefore means "the number
  // of rows could not be read", and the table states that rather than 0.
  const count =
    typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : null;

  return {
    agentId: optionalText(row.id),
    businessName: optionalText(row.business_name) ?? 'Hub name not recorded',
    destinationMasked: readMaskedDestination(verdict?.masked_destination),
    eligible,
    verdictUnreadable: !eligible && riskClass === null,
    riskClass,
    riskLabel: eligible ? PAYOUT_RISK_CLASS_LABELS.eligible : describePayoutRiskClass(riskClass),
    summary: typeof verdict?.summary === 'string' ? verdict.summary : '',
    pendingEarningsLabel: pending.text,
    pendingEarningsReported: pending.reported,
    pendingPayoutCount: count,
  };
}

/** Every describable hub row, in the order the payload supplied them. */
export function readPayoutIntegrityHubs(agents: unknown): PayoutIntegrityHubRow[] {
  if (!Array.isArray(agents)) return [];
  return agents
    .map(readPayoutIntegrityHubRow)
    .filter((row): row is PayoutIntegrityHubRow => row !== null);
}

/**
 * REVIEW FIX (F3) — WHETHER THE HUB LIST ITSELF WAS READ.
 *
 * `readPayoutIntegrityHubs` returns `[]` for a payload that never carried a list,
 * and `[]` for a real, successfully read list that happens to contain no hubs.
 * Those are different facts and the console must not print the same sentence for
 * both: "no hub rows were read" under an unread payload claims this build learned
 * something it did not.
 *
 *   'read'       — the payload carried an array (possibly empty). Every row in it
 *                  was mapped, so `[]` here genuinely means "no hubs".
 *   'unreadable' — the list is absent, not an array, or not yet loaded. NOT zero:
 *                  the number of hubs, and therefore every count derived from it,
 *                  is UNKNOWN.
 *
 * No other shape is reported: a payload this cannot classify is 'unreadable',
 * which is the safe answer, because the caller renders no figure for it.
 */
export type PayoutIntegritySourceState = 'read' | 'unreadable';

export function readPayoutIntegritySourceState(agents: unknown): PayoutIntegritySourceState {
  return Array.isArray(agents) ? 'read' : 'unreadable';
}

/**
 * The statement for a hub list this build could not read. It REPLACES the counts
 * sentence rather than sitting beside it, so no figure is ever shown next to it:
 * a count of 0 printed under an unread payload would be the very claim F3 removes.
 */
export const PAYOUT_INTEGRITY_SOURCE_UNREADABLE_TEXT =
  'The dashboard payload did not carry a readable list of hubs, so no per-hub verdict could be read. Read this as unknown, not as zero: the table below is empty because nothing was read, which is not a statement that no hubs exist or that every hub is payable.';

/**
 * The sentence printed under the table, chosen from the LIST'S OWN STATE.
 *
 * Unreadable  -> the unavailable statement above, and NO count: the number of
 *                hubs is unknown, so stating "0 hub row(s) read" would be a
 *                figure this build never learned.
 * Read        -> the counts, derived from the rows actually rendered, so the
 *                sentence can never disagree with the table above it. A read
 *                EMPTY list is the one case where a zero count is the truth.
 */
export function describePayoutIntegritySourceSentence(
  state: PayoutIntegritySourceState,
  summary?: PayoutIntegritySummary,
): string {
  if (state === 'unreadable') return PAYOUT_INTEGRITY_SOURCE_UNREADABLE_TEXT;
  const counted = summary ?? { total: 0, payable: 0, notPayable: 0, unreadable: 0 };
  return `${counted.total} hub row(s) read: ${counted.payable} payable, ${counted.notPayable} not payable, of which ${counted.unreadable} carry a verdict this console cannot read.`;
}

export interface PayoutIntegritySummary {
  /** How many hub rows were readable at all. */
  total: number;
  /** Hubs the launch policy would pay. */
  payable: number;
  /** Hubs it would refuse, or whose verdict this console could not read. */
  notPayable: number;
  /** Of those, the ones whose verdict could not be read (needs a human). */
  unreadable: number;
}

/**
 * Counts for the section header. Derived from the rows actually rendered, so a
 * figure stated above a table can never disagree with the table below it.
 */
export function summarizePayoutIntegrity(rows: readonly PayoutIntegrityHubRow[]): PayoutIntegritySummary {
  let payable = 0;
  let unreadable = 0;
  for (const row of rows) {
    if (row.eligible) payable += 1;
    else if (row.verdictUnreadable) unreadable += 1;
  }
  return {
    total: rows.length,
    payable,
    notPayable: rows.length - payable,
    unreadable,
  };
}
