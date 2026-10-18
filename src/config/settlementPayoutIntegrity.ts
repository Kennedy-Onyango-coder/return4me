// =============================================================================
// BATCH 1.1 — THE PAYOUT MUST MATCH THE LEDGER IT WAS BOOKED AGAINST.
// =============================================================================
//
// WHAT THIS MODULE DECIDES
// ------------------------
// Whether the payout legs an attempt is about to submit to the disbursement
// provider are the legs the ledger BOOKED for that claim:
//
//   * AMOUNT — the planned amount must equal the `amount` booked on the claim's
//     own `finder_payout` / `agent_payout` row, compared as currency (two
//     decimal places, the scale of `ledger.amount`, NUMERIC(10,2)).
//   * DESTINATION — the planned destination must be the same recipient
//     destination recorded in that row's `phone_or_till`, compared after the
//     SAME phone normalisation the payout policy uses, so '0712345678',
//     '+254712345678' and '254712345678' are one destination while any real
//     change of number is a change.
//
// WHY THIS EXISTS
// ---------------
// The settlement executor does not read the amounts it pays from the ledger. It
// recomputes the split from the item's locked shares, falling back to the
// category's CURRENT flat shares for an item reported before shares were locked
// (`executeClaimSettlement()` in server.ts). The booked ledger rows keep the
// amounts that were computed at handover. For a legacy item whose locked shares
// are NULL and whose category was edited after booking, the two disagree: the
// ledger says one thing and the transfer would send another, while
// `finalizeSettlement()` would happily mark the booked row completed.
//
// The same shape of gap exists for the destination: the ledger's
// `phone_or_till` is an immutable booking-time snapshot, while the executor
// sends the CURRENTLY stored `items.finder_phone` / `agents.mpesa_till_or_paybill`.
// An agent who activates a new payout destination after booking (a supported
// flow) would be paid at the new number while the booked row records the old
// one.
//
// This module makes both comparisons explicit, total and FAIL-CLOSED, so the
// executor can refuse the whole all-or-nothing claim payout instead of paying
// something the ledger does not record.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
//   * It does not recalculate, normalise or rewrite any ledger amount. A
//     mismatch is a REFUSAL, never a silent correction: the booked row is the
//     record of what was owed, and quietly "fixing" it would erase the evidence.
//   * It does not touch claim state, the ledger, the provider or the database.
//     It is pure, so the rule can be unit-tested exhaustively (the repository
//     runs vitest in a `node` environment and cannot import server.ts).
//   * It does not verify that a number is registered with M-Pesa or belongs to
//     the intended person. It answers only "is this the booked recipient?".
//
// WHAT IS NOT COMPARABLE, AND WHY THAT IS A REFUSAL
// ------------------------------------------------
// `ledger` has no payout-METHOD column (see src/db/schema.ts). The method is
// therefore enforced by the launch policy instead: both legs must be
// `Personal M-Pesa` (config/payoutDestinations.ts), and a destination that is
// not a personal M-Pesa phone can never equal a canonical phone destination.
// A booked Till/Paybill value is consequently reported as a destination
// mismatch when the attempt would pay a phone — which is exactly the case an
// operator must review, because the payout target changed shape after booking.
// A NULL/blank booked destination is never treated as "no objection": it is
// unverifiable and refuses.
// =============================================================================

import {
  maskPayoutDestinationForLog,
  normalizePersonalMpesaPhoneDestination,
} from './payoutDestinations.ts';

/** The scale of `ledger.amount` (NUMERIC(10,2)) — the currency precision every
 *  amount comparison and rendering here uses. */
export const SETTLEMENT_AMOUNT_SCALE = 2;

/**
 * A currency amount as an integer number of minor units (cents), or null when
 * the value cannot be read as a non-negative, finite amount.
 *
 * Rounding is half-up on the currency scale, matching `roundToCents()` in
 * services/agentPayoutEligibility and services/escrowFunds and `round2()` in
 * feeEngine. Values are added to `Number.EPSILON` before rounding so that a
 * decimal represented a hair below its exact value (1.005 ->
 * 1.00499999999999989) still rounds the way the decimal literal reads.
 *
 * null is a REFUSAL, never a zero: an unreadable amount must not be treated as
 * "nothing to pay" or as "matches anything".
 */
export function settlementAmountToMinorUnits(value: unknown): number | null {
  let numeric: number;
  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    numeric = Number(trimmed);
  } else {
    return null;
  }
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const factor = 10 ** SETTLEMENT_AMOUNT_SCALE;
  return Math.round((numeric + Number.EPSILON) * factor);
}

/** Render minor units back as a fixed-scale currency string (e.g. 15050 ->
 *  '150.50'), for messages and audit rows. */
export function formatSettlementAmountFromMinorUnits(minorUnits: number): string {
  return (minorUnits / 10 ** SETTLEMENT_AMOUNT_SCALE).toFixed(SETTLEMENT_AMOUNT_SCALE);
}

/** One payout leg as booked, and as it would be submitted. */
export interface SettlementIntegrityLeg {
  readonly recipientType: 'finder' | 'agent';
  /** The ledger row this leg pays — the unit of submission idempotency. */
  readonly ledgerEntryId: string;
  /** `ledger.amount` of that row (a numeric string in Postgres). */
  readonly bookedAmount: unknown;
  /** `ledger.phone_or_till` of that row: the destination snapshot taken at
   *  booking time. Never rendered; only masked in a refusal. */
  readonly bookedDestination: unknown;
  /** The amount the executor would put in the provider payload. */
  readonly plannedAmount: unknown;
  /** The destination the executor would put in the provider payload. */
  readonly plannedDestination: unknown;
}

export type SettlementAmountVerdict =
  | { readonly ok: true; readonly bookedMinorUnits: number; readonly plannedMinorUnits: number }
  | {
      readonly ok: false;
      readonly reason:
        | 'booked_amount_unreadable'
        | 'planned_amount_unreadable'
        | 'amount_mismatch';
      readonly bookedMinorUnits: number | null;
      readonly plannedMinorUnits: number | null;
    };

/**
 * Does the planned amount equal the booked amount AT CURRENCY PRECISION?
 *
 * Both sides are converted to minor units first, so '100.00' (the way Postgres
 * returns NUMERIC(10,2)) equals 100 (the way the executor computes it), and
 * floating-point noise below one cent cannot masquerade as a difference.
 */
/**
 * True when the amount verdict is a REFUSAL.
 *
 * Written as an explicit predicate on purpose: this project compiles without
 * `strict`, and with `strictNullChecks` off TypeScript does NOT narrow a
 * `true`/`false` discriminant. A type predicate narrows in both modes, so the
 * caller can read `reason` without a cast and without `any`.
 */
export const isSettlementAmountRefusal = (
  verdict: SettlementAmountVerdict,
): verdict is Extract<SettlementAmountVerdict, { ok: false }> => verdict.ok === false;

export function compareSettlementAmount(
  bookedAmount: unknown,
  plannedAmount: unknown,
): SettlementAmountVerdict {
  const bookedMinorUnits = settlementAmountToMinorUnits(bookedAmount);
  if (bookedMinorUnits === null) {
    return {
      ok: false,
      reason: 'booked_amount_unreadable',
      bookedMinorUnits: null,
      plannedMinorUnits: null,
    };
  }
  const plannedMinorUnits = settlementAmountToMinorUnits(plannedAmount);
  if (plannedMinorUnits === null) {
    return {
      ok: false,
      reason: 'planned_amount_unreadable',
      bookedMinorUnits,
      plannedMinorUnits: null,
    };
  }
  if (bookedMinorUnits !== plannedMinorUnits) {
    return {
      ok: false,
      reason: 'amount_mismatch',
      bookedMinorUnits,
      plannedMinorUnits,
    };
  }
  return { ok: true, bookedMinorUnits, plannedMinorUnits };
}

export type SettlementDestinationVerdict =
  | { readonly ok: true; readonly canonicalDestination: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'booked_destination_unreadable'
        | 'planned_destination_unreadable'
        | 'destination_changed';
    };

/**
 * True when the destination verdict is a REFUSAL. Same explicit-predicate reason
 * as isSettlementAmountRefusal above: this project compiles without `strict`.
 */
export const isSettlementDestinationRefusal = (
  verdict: SettlementDestinationVerdict,
): verdict is Extract<SettlementDestinationVerdict, { ok: false }> => verdict.ok === false;

/**
 * Is the planned destination the SAME RECIPIENT DESTINATION as the one booked
 * in the ledger row?
 *
 * Both sides go through `normalizePersonalMpesaPhoneDestination()`, so a
 * booking-time '0712345678' still matches today's '+254 712 345 678' — the same
 * handset, written differently — while a different number, a different country
 * code, a Till/Paybill value, a blank value, or a value that cannot be
 * normalised at all is a MISMATCH. Nothing is rewritten and nothing is
 * "best-guessed": the comparison either proves equality in canonical form or
 * refuses.
 */
export function compareSettlementDestination(
  bookedDestination: unknown,
  plannedDestination: unknown,
): SettlementDestinationVerdict {
  const bookedCanonical = normalizePersonalMpesaPhoneDestination(bookedDestination);
  if (bookedCanonical === null) {
    return { ok: false, reason: 'booked_destination_unreadable' };
  }
  const plannedCanonical = normalizePersonalMpesaPhoneDestination(plannedDestination);
  if (plannedCanonical === null) {
    return { ok: false, reason: 'planned_destination_unreadable' };
  }
  if (bookedCanonical !== plannedCanonical) {
    return { ok: false, reason: 'destination_changed' };
  }
  return { ok: true, canonicalDestination: plannedCanonical };
}

export interface SettlementLegIntegrity {
  readonly recipientType: 'finder' | 'agent';
  readonly ledgerEntryId: string;
  readonly amount: SettlementAmountVerdict;
  readonly destination: SettlementDestinationVerdict;
}

export interface SettlementPayoutIntegrityResult {
  /** True only when EVERY supplied leg matches on both amount and destination. */
  readonly ok: boolean;
  readonly legs: readonly SettlementLegIntegrity[];
  /**
   * PII-free refusal sentences for the amount side, one per offending leg.
   * Amounts and ledger row ids only — never a phone number.
   */
  readonly amountMismatches: readonly string[];
  /**
   * PII-free refusal sentences for the destination side, one per offending leg.
   * Destinations are MASKED with the same helper the payout policy uses.
   */
  readonly destinationMismatches: readonly string[];
}

const subjectOf = (leg: SettlementIntegrityLeg): string =>
  leg.recipientType === 'agent' ? 'agent' : 'finder';

const describeAmountRefusal = (
  leg: SettlementIntegrityLeg,
  verdict: Extract<SettlementAmountVerdict, { ok: false }>,
): string => {
  const subject = subjectOf(leg);
  switch (verdict.reason) {
    case 'booked_amount_unreadable':
      return (
        `the ${subject} payout row ${leg.ledgerEntryId} has no readable booked amount, ` +
        `so this attempt cannot be proven to pay what was booked`
      );
    case 'planned_amount_unreadable':
      return (
        `the ${subject} payout row ${leg.ledgerEntryId} would be submitted with an ` +
        `unreadable amount`
      );
    case 'amount_mismatch':
      return (
        `the ${subject} payout row ${leg.ledgerEntryId} was booked for KES ` +
        `${formatSettlementAmountFromMinorUnits(verdict.bookedMinorUnits ?? 0)} but this ` +
        `attempt would submit KES ${formatSettlementAmountFromMinorUnits(verdict.plannedMinorUnits ?? 0)}`
      );
  }
};

const describeDestinationRefusal = (
  leg: SettlementIntegrityLeg,
  verdict: Extract<SettlementDestinationVerdict, { ok: false }>,
): string => {
  const subject = subjectOf(leg);
  const booked = maskPayoutDestinationForLog(leg.bookedDestination);
  const planned = maskPayoutDestinationForLog(leg.plannedDestination);
  switch (verdict.reason) {
    case 'booked_destination_unreadable':
      return (
        `the ${subject} payout row ${leg.ledgerEntryId} carries a booked destination ` +
        `that is not a personal M-Pesa phone (booked ${booked}), so the attempt's ` +
        `destination (${planned}) cannot be proven to be the booked one`
      );
    case 'planned_destination_unreadable':
      return (
        `the ${subject} payout row ${leg.ledgerEntryId} would be submitted with a ` +
        `destination that is not a payable personal M-Pesa phone (${planned})`
      );
    case 'destination_changed':
      return (
        `the ${subject} payout row ${leg.ledgerEntryId} booked destination ${booked} ` +
        `no longer matches the destination this attempt would submit ${planned}`
      );
  }
};

/**
 * Resolve the integrity of a whole payout batch.
 *
 * ALL-OR-NOTHING is the caller's rule and this result is shaped for it: a
 * single offending leg makes `ok` false, and the caller must then submit NO leg
 * of the claim — never the matching ones only. A partially paid claim cannot be
 * corrected afterwards, because the money for it has already left.
 *
 * An empty list resolves to `ok: true` ("every supplied leg matched" —
 * vacuously) and is documented as such: the CALLER decides whether there is
 * anything to submit, and the executor only asks this question when at least one
 * leg is submittable.
 */
export function resolveSettlementPayoutIntegrity(
  legs: readonly SettlementIntegrityLeg[] | null | undefined,
): SettlementPayoutIntegrityResult {
  const supplied = Array.isArray(legs) ? legs : [];
  const resolved: SettlementLegIntegrity[] = [];
  const amountMismatches: string[] = [];
  const destinationMismatches: string[] = [];

  for (const leg of supplied) {
    const amount = compareSettlementAmount(leg?.bookedAmount, leg?.plannedAmount);
    const destination = compareSettlementDestination(
      leg?.bookedDestination,
      leg?.plannedDestination,
    );
    const normalisedLeg: SettlementIntegrityLeg = {
      recipientType: leg?.recipientType === 'agent' ? 'agent' : 'finder',
      ledgerEntryId: String(leg?.ledgerEntryId ?? ''),
      bookedAmount: leg?.bookedAmount,
      bookedDestination: leg?.bookedDestination,
      plannedAmount: leg?.plannedAmount,
      plannedDestination: leg?.plannedDestination,
    };
    resolved.push({
      recipientType: normalisedLeg.recipientType,
      ledgerEntryId: normalisedLeg.ledgerEntryId,
      amount,
      destination,
    });
    if (isSettlementAmountRefusal(amount)) {
      amountMismatches.push(describeAmountRefusal(normalisedLeg, amount));
    }
    if (isSettlementDestinationRefusal(destination)) {
      destinationMismatches.push(describeDestinationRefusal(normalisedLeg, destination));
    }
  }

  return {
    ok: amountMismatches.length === 0 && destinationMismatches.length === 0,
    legs: resolved,
    amountMismatches,
    destinationMismatches,
  };
}
