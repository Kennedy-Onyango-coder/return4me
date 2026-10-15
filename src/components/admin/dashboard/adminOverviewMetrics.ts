// BATCH 3 — ADMIN OVERVIEW METRIC READ-OUT
// =======================================
//
// The admin Overview (`activeTab === 'stats'`) is the one screen in this product
// used for financial oversight. Two properties of it had to hold and did not.
//
// 1. A FIGURE THE SERVER DID NOT SEND IS NOT ZERO.
//    `fetchDashboardData()` accepted any JSON body and stored it verbatim, so an
//    incomplete or corrupt payload reached the cards:
//      * `stats` absent  -> `dashboardData.stats.escrowHeldAmount` threw while
//        rendering, taking the whole console tab down (a blank screen, not an
//        error message);
//      * a field absent  -> the old unguarded cards rendered the literal text
//        "KES undefined" — not a zero, but a figure-shaped lie;
//      * a string where a number belongs -> rendered as text.
//    Every one of those is a *failed or incomplete response*, and the Overview
//    must say so. This module makes that structural: the payload is VALIDATED
//    before it is rendered, and a required field that is missing or not a number
//    makes the payload invalid rather than making any figure zero.
//
// 2. A FIGURE THAT IS REPORTED MUST READ THE SAME WAY EVERYWHERE.
//    The Overview's grid rendered money three different ways (`KES ${value}`,
//    `KES {value}`, and `KES 1500.00` in the Batch 2 payout panel). Currency
//    semantics are now one function: KES, exactly two decimal places — the scale
//    of every NUMERIC(10,2) money column in sql/schema.sql — and UNGROUPED. The
//    ungrouped choice is deliberate and is the SAME convention Batch 2 uses in
//    formatPayoutAmount() (services/adminPayoutReconciliationApi.ts), so the two
//    admin surfaces cannot disagree about how a shilling amount looks.
//
// CURRENCY AND COUNT SEMANTICS
//   * Money here is KES held/settled by THIS platform. There is no per-currency
//     column and no FX model anywhere in this codebase, so no conversion and no
//     currency code is inferred: the figures are labelled KES because that is
//     what the payment path (services/payments.ts) and the ledger charge.
//   * A COUNT is a whole, non-negative number of ROWS. A fractional or negative
//     count is a server defect, not a figure, and is rejected below rather than
//     rounded into looking plausible.
//   * Negative AMOUNTS are rendered exactly as reported (never silently clamped
//     to zero or made absolute): this module does not rewrite financial values.
//     The aggregates that feed it only ever add positive locked fees
//     (services/escrowFunds.ts), so a negative amount can only mean the payload
//     itself is wrong — and hiding that would be the worse failure.
//
// This module is PURE: no React, no I/O, no import from AdminView.tsx. It is the
// single place these read-out rules live, so tests execute them instead of
// asserting that comments about them exist.

/** The result of turning one reported (or missing) figure into display text. */
export interface MetricReadout {
  /** The display text, or the em dash when the figure was not reported. */
  text: string;
  /** True only when a genuinely reported, finite number produced this text. */
  reported: boolean;
}

/**
 * What a card shows for a figure this server build did not report. It is
 * deliberately NOT "0", "N/A" or an empty string: an operator must be able to
 * tell "no money is held" (a real zero) from "this build did not say".
 */
export const METRIC_NOT_REPORTED = '—';

/** True only for a genuinely reported, finite number. `0` IS reported. */
export function isReportedNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A KES amount at the scale of the underlying NUMERIC(10,2) column. A figure
 * that was not reported is '—', never 'KES 0.00'.
 */
export function formatKesAmount(value: unknown): MetricReadout {
  if (!isReportedNumber(value)) return { text: METRIC_NOT_REPORTED, reported: false };
  return { text: `KES ${value.toFixed(2)}`, reported: true };
}

/**
 * A count of rows. A genuine 0 is '0'; a value that was not reported is '—'.
 */
export function formatMetricCount(value: unknown): MetricReadout {
  if (!isReportedNumber(value)) return { text: METRIC_NOT_REPORTED, reported: false };
  return { text: String(value), reported: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A count field must be a whole, non-negative number of rows. */
function isReportedCountField(value: unknown): boolean {
  return isReportedNumber(value) && Number.isInteger(value) && value >= 0;
}

/**
 * The statistics the Overview's headline cards READ. Every one of these is
 * published by the current `GET /api/admin/dashboard` handler (src/server.ts),
 * so their absence means the response is not the response this console was built
 * against — a failed request in every sense that matters here, and therefore an
 * ERROR, never a zero.
 *
 * Definitions (see the Batch 3 report for the full metric-by-metric trace):
 *   pendingAgentsCount  - agents whose business-approval status is 'pending'
 *                         (sql/schema.sql: agents.status IN ('pending','active',
 *                         'suspended') — there is no second pending-ish status).
 *   itemsAtAgentCount   - items whose status is 'at_agent', i.e. physically held
 *                         by an agent awaiting claimant collection. It is the
 *                         ONLY item status that means that (the item vocabulary
 *                         is awaiting_dropoff | at_agent | claimed | expired |
 *                         rejected | suspected_stolen | legal_hold).
 *   escrowHeldAmount    - SUM(items.locked_total_fee) over claims in escrow_held.
 *   escrowHeldCount     - COUNT of claims in escrow_held.
 *   totalRevenue        - SUM(ledger.amount) over platform_fee rows already
 *                         marked 'completed'. This is the ONLY confirmed revenue
 *                         figure: nothing in-flight is added to it.
 */
export const OVERVIEW_REQUIRED_STATS_FIELDS = [
  'pendingAgentsCount',
  'itemsAtAgentCount',
  'escrowHeldAmount',
  'escrowHeldCount',
  'totalRevenue',
] as const;

/**
 * Statistics the Overview reads but that a compatible older build may simply not
 * publish. Their ABSENCE is a legitimate "this build does not report it" (the
 * Batch 1 cards already render '—' for exactly that case); their PRESENCE with a
 * non-numeric or fractional/negative value is corruption and is rejected below.
 *
 * Absence and corruption are different facts and must not collapse into one:
 * "not reported" is honestly unknown, whereas a garbage value is a broken
 * response that must not be dressed up as unknown.
 */
export const OVERVIEW_OPTIONAL_STATS_FIELDS = [
  'settlementPendingAmount',
  'settlementPendingCount',
  'releasingAmount',
  'releasingCount',
  'fundsInFlightAmount',
  'fundsInFlightCount',
  'unresolvedPayoutsCount',
  'unresolvedPayoutsAmount',
  /**
   * PROGRAMME 1 / WS2 — hubs the launch payout policy would refuse at settlement
   * time (a stored Till, Paybill, Pochi la Biashara or free-form destination, or
   * a method other than Personal M-Pesa). Optional on the same terms as every
   * other field above: a build that does not publish it reads as "not reported"
   * — never as 0, which would claim every hub can be paid.
   */
  'payoutIneligibleAgentsCount',
] as const;

export interface OverviewStatsReadout {
  /** True only when the payload may be rendered as the Overview's statistics. */
  ok: boolean;
  /** Operator-facing explanation of the first problem found. Present iff !ok. */
  reason?: string;
  /** The validated statistics block. Present iff ok. */
  stats?: Record<string, unknown>;
}

/**
 * Decide whether a dashboard payload may be rendered, BEFORE any of it is.
 *
 * The rule is deliberately asymmetric and fail-closed:
 *   * the body must be a JSON object carrying an object `stats` block;
 *   * every REQUIRED field must be a finite number (counts whole and >= 0);
 *   * every OPTIONAL field must be a finite number IF THE KEY IS PRESENT;
 *   * a missing optional key is "not reported" and is allowed through.
 *
 * Nothing here invents, defaults or repairs a value. A payload that fails is
 * reported so the console can show an error and offer a retry, and the figures
 * already on screen stay on screen, marked stale — they are not replaced by
 * zeros.
 */
export function readOverviewStats(payload: unknown): OverviewStatsReadout {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'The dashboard returned an unexpected response instead of a JSON object.' };
  }

  const stats = payload.stats;
  if (!isPlainObject(stats)) {
    return { ok: false, reason: 'The dashboard response did not include its statistics. Reload to try again.' };
  }

  for (const field of OVERVIEW_REQUIRED_STATS_FIELDS) {
    if (!(field in stats)) {
      return { ok: false, reason: `The dashboard response omitted ${field}. Reload to try again.` };
    }
    const value = stats[field];
    const valid = field.endsWith('Count') ? isReportedCountField(value) : isReportedNumber(value);
    if (!valid) {
      return { ok: false, reason: `The dashboard reported ${field} as a value this console cannot display. Reload to try again.` };
    }
  }

  for (const field of OVERVIEW_OPTIONAL_STATS_FIELDS) {
    if (!(field in stats)) continue;
    const value = stats[field];
    const valid = field.endsWith('Count') ? isReportedCountField(value) : isReportedNumber(value);
    if (!valid) {
      return { ok: false, reason: `The dashboard reported ${field} as a value this console cannot display. Reload to try again.` };
    }
  }

  return { ok: true, stats };
}
