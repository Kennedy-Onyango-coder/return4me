// ESCROW FUNDS AGGREGATE (Phase 10, F-2)
// ======================================
// THE DEFECT THIS CLOSES
// The admin console rendered a card labelled "Escrow Funds Held" whose value was
// `escrowHeldCount` — `claims.filter(c => c.status === 'escrow_held').length`,
// i.e. a COUNT OF CLAIMS. It sat directly beside a genuinely monetary card
// ("Total Revenue", rendered as `KES {totalRevenue}`), so an operator reading
// the dashboard would take the escrow figure to be money. A count of claims is
// not a measure of financial exposure, and labelling it as held funds is a
// truthfulness defect on the one screen used for financial oversight.
//
// THE AUTHORITATIVE SOURCE — ESTABLISHED, NOT ASSUMED
// `items.locked_total_fee` is the fee locked onto an item at report time from
// the fee engine (`computeRecoveryFee(...).totalFee`, written in the
// POST /api/items/report handler). It is the SAME field the money path charges:
// `resolveAuthoritativePaymentFee()` prefers `item.locked_total_fee` and only
// falls back to `category.total_fee`. So for a claim in `escrow_held` — a status
// that is only ever entered by the guarded CAS in attemptClaimEscrowHold(),
// after payment confirmation — the amount held for that claim is exactly its
// item's `locked_total_fee`. `claims` itself carries NO amount column (its
// money-truth marker is `paid_at`), so the item column is the only authoritative
// per-claim monetary figure, and the ledger has no escrow-hold entry type.
//
// This changes NO financial semantics: it reads an existing column with its
// existing meaning and adds it up. It does not write, transition, authorise,
// refund, or reconcile anything.
//
// MONEY REPRESENTATION — MATCHING THE EXISTING CONVENTION
// There is no decimal library in this project and no integer-minor-unit
// representation. Established convention (database.ts, server.ts) is: NUMERIC
// arrives as a string, is converted with parseFloat/Number, and is summed as a
// plain JS number — e.g. `totalRevenue` is computed with
// `reduce((sum, l) => sum + l.amount, 0)`. This module follows that convention
// exactly rather than introducing a second money model, and only rounds the
// final total to the column's own scale (NUMERIC(10,2)) so the UI cannot show
// float artefacts such as 123.45000000000002.

// Batch 1 (money-in-flight) — the ONE authoritative retry/reconciliation rule for
// a payout row (src/config/payoutOutcomes.ts), imported rather than re-expressed
// so the figure the console shows and the rows the reconciliation endpoint lists
// can never disagree about what "unresolved" means.
import { isUnresolvedPayoutRow } from '../config/payoutOutcomes';

/** The claim status whose held funds this module sums. */
export const ESCROW_HELD_STATUS = 'escrow_held';

/**
 * Convert a stored fee value to a usable number, or null when it cannot
 * represent money.
 *
 * Mirrors the existing defensive conversions in the codebase (a NUMERIC column
 * is a string on the wire but a number once parsed) and treats anything
 * non-finite by convention: callers must not add NaN/Infinity to a total.
 * Zero and negatives are returned as-is so the CALLER decides their meaning;
 * this function does not silently rewrite financial values.
 */
export function toFeeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/** Round to the NUMERIC(10,2) scale of the underlying column. */
function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export interface EscrowFundsHeld {
  /** Total KES currently held for claims in escrow_held. 0 when there are none. */
  amount: number;
  /** How many claims are in escrow_held. */
  count: number;
}

/**
 * The money actually held in escrow right now.
 *
 *   amount = SUM(items.locked_total_fee)
 *              WHERE the claim for that item has status = 'escrow_held'
 *
 * A claim whose item cannot be resolved, whose locked fee is absent/null, or
 * whose locked fee is non-finite or not positive contributes 0 to the total (it
 * is still counted in `count`, because the claim genuinely is in escrow — the
 * count and the amount are independent facts and neither is fabricated from the
 * other). No claims and no items both yield { amount: 0, count: 0 }.
 *
 * Pure: takes the already-loaded rows, queries nothing, mutates nothing.
 */
export function computeEscrowFundsHeld(
  claims: ReadonlyArray<any> | null | undefined,
  items: ReadonlyArray<any> | null | undefined,
): EscrowFundsHeld {
  const claimRows = Array.isArray(claims) ? claims : [];
  const itemRows = Array.isArray(items) ? items : [];

  const feeByItemId = new Map<string, number>();
  for (const item of itemRows) {
    if (!item || item.id === null || item.id === undefined) continue;
    const fee = toFeeNumber(item.locked_total_fee);
    // Only a positive, finite fee represents money held. A 0/absent/negative
    // locked fee adds nothing and must never subtract from the total.
    if (fee !== null && fee > 0) feeByItemId.set(String(item.id), fee);
  }

  let amount = 0;
  let count = 0;
  for (const claim of claimRows) {
    if (!claim || claim.status !== ESCROW_HELD_STATUS) continue;
    count += 1;
    const fee = claim.item_id === null || claim.item_id === undefined
      ? undefined
      : feeByItemId.get(String(claim.item_id));
    if (fee !== undefined) amount += fee;
  }

  return { amount: roundToCents(amount), count };
}

// ============================================================================
// MONEY IN FLIGHT (Batch 1 — the admin overview's in-flight read-out)
// ============================================================================
// THE DEFECT THIS CLOSES
// Both financial figures the admin overview published were TERMINAL-STATE
// figures:
//   * escrowHeldAmount -> claims in 'escrow_held' ONLY, and
//   * totalRevenue     -> 'platform_fee' rows already marked 'completed'.
// Every other state the platform's money can be sitting in was invisible. A claim
// whose handover has been confirmed waits in 'pending_settlement' for the whole
// dispute window holding the customer's money; a claim whose payout was submitted
// and whose provider outcome came back unknown or refused is rolled BACK to
// 'pending_settlement' (rollbackSettlementToPending) rather than being silently
// re-sent; a claim mid-payout is in 'releasing'. In all three the money is still
// held by the platform — and the console showed zero, because none of them is
// 'escrow_held'. The overview gave no way to see money in flight at all.
//
// This is the same class of defect the Agent Hub already closed for agent earnings
// ('pending settlement' vs 'completed' — see the getAgentEarnings note in
// db/database.ts) and that Phase 10 (F-2) closed for the escrow card (a claim
// COUNT rendered as money). The remedy is identical and deliberately narrow:
// publish each state as its OWN, explicitly labelled fact.
//
// WHAT IS NOT DONE HERE, ON PURPOSE
// No "available funds", "clearing balance" or "account balance" figure is
// produced. Nothing in this codebase models a float, a clearing account or a
// provider balance, so any such number would be invented rather than computed.
//
// WHY THE SAME FEE FIELD
// items.locked_total_fee is the fee locked at report time and the SAME field the
// money path charges (resolveAuthoritativePaymentFee), so it is the authoritative
// figure for the money attached to a claim in ANY live state — exactly the basis
// computeEscrowFundsHeld above already uses.
//
// WHY THE TOTAL CANNOT DOUBLE-COUNT
// A claim has exactly ONE status at a time, and the three statuses summed here are
// mutually exclusive, so each claim's locked fee is added at most once. The total
// is published as the SUM OF THREE PUBLISHED FACTS, never as an independent source
// of truth.
//
// PURE: takes already-loaded rows, queries nothing, mutates nothing.

/** Claim statuses whose money the platform is still holding. Mutually exclusive. */
export const SETTLEMENT_PENDING_STATUS = 'pending_settlement';
export const RELEASING_STATUS = 'releasing';

/**
 * The ledger row types a settlement payout can be. Kept in lockstep with the
 * `inArray(ledgerTable.type, [...])` filter inside getUnresolvedPayouts()
 * (db/database.ts) — pinned by a test so the two lists cannot drift apart.
 */
export const PAYOUT_LEDGER_TYPES: readonly string[] = ['finder_payout', 'agent_payout'];

export interface MoneyInFlight {
  /** Claims still in escrow_held (payment confirmed, dispute window not reached). */
  escrowHeldAmount: number;
  escrowHeldCount: number;
  /** Claims whose dispute window has closed and which are awaiting payout. */
  settlementPendingAmount: number;
  settlementPendingCount: number;
  /** Claims whose payout is in flight (submitted, outcome not yet confirmed). */
  releasingAmount: number;
  releasingCount: number;
  /** escrowHeld + settlementPending + releasing — three published facts, summed. */
  heldAmount: number;
  heldCount: number;
}

/** Sum the locked fees of the claims carrying exactly one status. */
function sumLockedFeesForStatus(
  claims: ReadonlyArray<any>,
  feeByItemId: Map<string, number>,
  status: string,
): { amount: number; count: number } {
  let amount = 0;
  let count = 0;
  for (const claim of claims) {
    if (!claim || claim.status !== status) continue;
    count += 1;
    const fee = claim.item_id === null || claim.item_id === undefined
      ? undefined
      : feeByItemId.get(String(claim.item_id));
    if (fee !== undefined) amount += fee;
  }
  return { amount, count };
}

/**
 * The money the platform is holding right now, split by the state holding it. A
 * claim in none of these states (already released, refunded, rejected, still
 * unpaid) contributes nothing — it is not held money.
 */
export function computeMoneyInFlight(
  claims: ReadonlyArray<any> | null | undefined,
  items: ReadonlyArray<any> | null | undefined,
): MoneyInFlight {
  const claimRows = Array.isArray(claims) ? claims : [];
  const itemRows = Array.isArray(items) ? items : [];

  const feeByItemId = new Map<string, number>();
  for (const item of itemRows) {
    if (!item || item.id === null || item.id === undefined) continue;
    const fee = toFeeNumber(item.locked_total_fee);
    // Only a positive, finite fee represents money held (same rule as above).
    if (fee !== null && fee > 0) feeByItemId.set(String(item.id), fee);
  }

  const escrowHeld = sumLockedFeesForStatus(claimRows, feeByItemId, ESCROW_HELD_STATUS);
  const settlementPending = sumLockedFeesForStatus(claimRows, feeByItemId, SETTLEMENT_PENDING_STATUS);
  const releasing = sumLockedFeesForStatus(claimRows, feeByItemId, RELEASING_STATUS);

  return {
    escrowHeldAmount: roundToCents(escrowHeld.amount),
    escrowHeldCount: escrowHeld.count,
    settlementPendingAmount: roundToCents(settlementPending.amount),
    settlementPendingCount: settlementPending.count,
    releasingAmount: roundToCents(releasing.amount),
    releasingCount: releasing.count,
    heldAmount: roundToCents(escrowHeld.amount + settlementPending.amount + releasing.amount),
    heldCount: escrowHeld.count + settlementPending.count + releasing.count,
  };
}

export interface UnresolvedPayouts {
  /** Finder/agent payout rows that are neither confirmed paid nor safe to resend. */
  count: number;
  /**
   * The money those rows represent. It is not known to have been disbursed, and
   * not proven NOT to have been either — it is precisely the amount under
   * investigation, which is why it is reported as its own figure and never added
   * into a "held" or "earned" total.
   */
  amount: number;
}

/**
 * The finder/agent payouts an operator must reconcile against the provider.
 *
 * The predicate is isUnresolvedPayoutRow() — the SAME rule getUnresolvedPayouts()
 * applies in db/database.ts and the settlement executor uses to decide whether a
 * row may be re-sent — so the figure shown on the overview and the rows listed by
 * GET /api/admin/payout-reconciliation can never disagree about what "unresolved"
 * means. Computed from the ledger rows a caller has already loaded: no extra
 * query, and no second definition of the word.
 */
export function computeUnresolvedPayouts(
  ledger: ReadonlyArray<any> | null | undefined,
): UnresolvedPayouts {
  const rows = Array.isArray(ledger) ? ledger : [];
  let count = 0;
  let amount = 0;
  for (const row of rows) {
    if (!row) continue;
    if (!PAYOUT_LEDGER_TYPES.includes(String(row.type))) continue;
    if (!isUnresolvedPayoutRow(row)) continue;
    count += 1;
    const rowAmount = toFeeNumber(row.amount);
    if (rowAmount !== null && rowAmount > 0) amount += rowAmount;
  }
  return { count, amount: roundToCents(amount) };
}
