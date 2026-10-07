// Pure presentation logic for the Claims Administration UI (Phase 6F).
//
// Every function here is a TOTAL FUNCTION of explicit inputs — no React, no
// fetch, no globals. That is deliberate: this repository runs vitest in a
// `node` environment with no jsdom / React Testing Library, so the only way to
// regression-test how claim data is PRESENTED is to keep the presentation rules
// in plain functions and let the components be thin renderers of them.
//
// The three rules this module exists to enforce:
//
//   1. PAID means paid_at is set. Nothing else. `has_paid` is the server's
//      derived boolean and is trusted only because the server derives it from
//      paid_at; there is no fallback to status, financial_state, dispute state
//      or any provider reference (none of which is even available here).
//   2. NOTHING FINANCIAL IS INVENTED. This system has no escrow-balance record
//      and no authoritative amount, so no function here returns money. Labels
//      are lifecycle words, never figures.
//   3. HISTORICAL SNAPSHOT UNKNOWN IS NOT UNPAID. A legacy dispute without a
//      6C snapshot (R1) renders as "Unknown", never as "not paid".
import { getClaimStatusDisplay } from '../../claimStatus';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface Labelled {
  label: string;
  tone: Tone;
}

const NA_EN = 'Not available';

/** Human label + semantic tone for a raw claim status. Delegates to the shared
 *  claim-status vocabulary so the console can never drift from the customer
 *  surfaces or show a raw snake_case token. */
export function presentClaimStatus(status: string): Labelled {
  const display = getClaimStatusDisplay(status);
  return { label: display.label, tone: display.variant as Tone };
}

/**
 * Payment presentation. `paidAt` is the ONLY input that decides whether money is
 * shown as received; `hasPaid` is used only to stay consistent with the server's
 * own derived value and can never disagree with it.
 */
export function presentPayment(
      _hasPaid: boolean,
  paidAt: string | null,
): Labelled & { at: string | null; paid: boolean } {
      const paid = paidAt !== null;
  return {
    paid,
    at: paid ? paidAt : null,
    label: paid ? 'Paid' : 'Not paid',
    tone: paid ? 'success' : 'neutral',
  };
}

/**
 * Lifecycle bucket from the DTO's `financial_state` (itself derived from the
 * claim STATUS). Words only — this is not an amount and must never be rendered
 * next to a currency symbol.
 */
export function presentFinancialState(state: string): Labelled {
  switch (state) {
    case 'escrow_held':
      return { label: 'Escrow held', tone: 'success' };
    case 'settling':
      return { label: 'Settling', tone: 'success' };
    case 'settled':
      return { label: 'Settled', tone: 'success' };
    case 'refunding':
      return { label: 'Refund in progress', tone: 'warning' };
    case 'refunded':
      return { label: 'Refunded', tone: 'info' };
    case 'rejected':
      return { label: 'Rejected', tone: 'danger' };
    default:
      return { label: 'Unpaid', tone: 'neutral' };
  }
}

export function presentDisputeState(state: string): Labelled {
  switch (state) {
    case 'open':
      return { label: 'Open', tone: 'warning' };
    case 'resolved':
      return { label: 'Resolved', tone: 'success' };
    default:
      return { label: 'None', tone: 'neutral' };
  }
}

/** Applies to the current claim or to a dispute participant. */
export function presentRole(role: string | null): string {
  if (role === 'original') return 'Original claimant';
  if (role === 'contesting') return 'Contesting claimant';
  return NA_EN;
}

export function presentVerificationTier(tier: number | null): string {
  if (tier === 1) return 'Tier 1 — document check';
  if (tier === 2) return 'Tier 2 — questions + ID';
  if (tier === 3) return 'Tier 3 — agent handover';
  if (typeof tier === 'number') return `Tier ${tier}`;
  return NA_EN;
}

export function presentPresence(present: boolean): Labelled {
  return present
    ? { label: 'Provided', tone: 'success' }
    : { label: 'Not provided', tone: 'neutral' };
}

export function presentBoolean(value: boolean): string {
  return value ? 'Yes' : 'No';
}

/**
 * Historical (at-dispute) claim state. Distinguishing UNKNOWN from UNPAID is the
 * whole point: for a pre-6C dispute the snapshot columns are null and
 * `snapshot_incomplete` is true, which means the system genuinely does not know
 * what the claimant's state was — it must never be rendered as "not paid".
 */
export function presentHistoricalClaim(
  claim: { status_at_dispute: string | null; paid_at_dispute: string | null },
  snapshotIncomplete: boolean,
): { status: string; payment: string; unknown: boolean } {
  const unknown =
    snapshotIncomplete === true || (claim.status_at_dispute === null && claim.paid_at_dispute === null);
  if (unknown) {
    const unknownText = 'Unknown — historical snapshot unavailable';
    return { status: unknownText, payment: unknownText, unknown: true };
  }
  const status = claim.status_at_dispute ? presentClaimStatus(claim.status_at_dispute).label : NA_EN;
  const payment =
    claim.paid_at_dispute !== null
      ? 'Paid'
      : 'Not paid';
  return { status, payment, unknown: false };
}

/**
 * Timestamp rendering. Returns the product's "Not available" wording for a
 * missing or unparseable value — a null `paid_at` is NEVER a date. The stored
 * value is an absolute timestamp rendered in the viewer's locale; no timezone
 * semantics are altered.
 */
export function formatTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return NA_EN;
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return NA_EN;
  return parsed.toLocaleString('en-KE', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Page position label. Deliberately states only what the API actually
 * guarantees — an offset window and whether more rows exist. There is no
 * authoritative total in the contract, so none is implied.
 */
export function describePageRange(offset: number, shown: number): string {
  if (shown <= 0) return 'No claims on this page';
  const first = offset + 1;
  const last = offset + shown;
  return first === last ? `Claim ${first}` : `Claims ${first}–${last}`;
}
