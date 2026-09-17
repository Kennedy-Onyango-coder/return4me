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
