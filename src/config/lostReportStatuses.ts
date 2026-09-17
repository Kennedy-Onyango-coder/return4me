// LOST-REPORT LIFECYCLE VOCABULARY — Phase 9A.
//
// A lost report is its OWN domain object, not a claim and not a found item.
// This module is the single source of truth for its status vocabulary, kept
// deliberately out of any component/service so the backend (routes, DB) and a
// future frontend label map cannot drift into two copies.
//
// WHY THIS IS NOT A COPY OF THE SUGGESTED NAMES
// ---------------------------------------------
// The Phase 9A brief suggested ACTIVE / MATCH_REVIEW / RESOLVED / CANCELLED /
// EXPIRED. Existing repository convention is lowercase snake_case status
// strings (config/claimStatuses.ts for claims, items.status for found items),
// so the casing is adapted. More importantly, a HARD requirement of this
// phase is that a lost-report status can never be confused with a claim status
// or a found-item status. A bare `expired` is already an ITEM status, so it is
// replaced here with `lapsed` — which keeps this vocabulary PROVABLY disjoint
// from both existing vocabularies (asserted by
// src/config/__tests__/lostReportStatuses.test.ts). `lapsed` means "aged out
// without being recovered", which is exactly what `expired` would have meant.
//
// FORWARD COMPATIBILITY WITH MATCHING (Phase 9B)
// ----------------------------------------------
// `match_review` is part of the vocabulary from day one because a future
// matcher must be able to park a report while a candidate is reviewed WITHOUT
// inventing a new status then. Nothing in Phase 9A sets it: creation always
// produces `active`, and no matching engine exists yet.

export const LOST_REPORT_STATUS_VALUES = [
  'active',       // open and eligible to be considered by a future matcher
  'match_review', // reserved: a candidate match is under review (Phase 9B)
  'resolved',     // the item was recovered
  'cancelled',    // the reporter withdrew the report
  'lapsed',       // aged out without recovery
] as const;

export type LostReportStatus = (typeof LOST_REPORT_STATUS_VALUES)[number];

/** The status every newly created lost report gets. Never client-selectable. */
export const DEFAULT_LOST_REPORT_STATUS: LostReportStatus = 'active';

/** Machine-checkable membership test for the closed vocabulary. */
export function isLostReportStatus(value: string): value is LostReportStatus {
  return (LOST_REPORT_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * Statuses from which no further transition is expected. Declared now so a
 * future matching/resolution phase has an explicit terminal set rather than
 * re-deriving one ad hoc (mirrors TERMINAL_CLAIM_STATUSES).
 */
export const TERMINAL_LOST_REPORT_STATUSES: ReadonlySet<string> = new Set<string>([
  'resolved',
  'cancelled',
  'lapsed',
]);

/**
 * The exact SQL predicate fragment for the `lost_reports.status` CHECK
 * constraint, generated from the single canonical list above so the Drizzle
 * definition, sql/schema.sql and the runtime DDL cannot silently drift apart
 * (the same SC-7 pattern used for CLAIM_SLOT_EXCLUDED_SQL_LIST).
 */
export const LOST_REPORT_STATUS_SQL_LIST = LOST_REPORT_STATUS_VALUES
  .map((s) => `'${s}'`)
  .join(', ');
