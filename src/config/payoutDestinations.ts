// BATCH 1 — PHONE-ONLY PAYOUT DESTINATION POLICY (PURE, IMPORTABLE, NO I/O).
// ===========================================================================
//
// WHAT THIS MODULE DECIDES
// ------------------------
// Whether a finder or agent payout leg is ELIGIBLE to be submitted to the
// disbursement provider at launch:
//
//   * the destination must be a Kenyan personal M-Pesa phone number — after
//     normalisation, exactly `254` followed by nine digits; and
//   * the leg's payout method must be exactly the one supported method,
//     `Personal M-Pesa`.
//
// Every other shape is refused: Pochi la Biashara, Till Number, Paybill Number,
// an unknown or differently-cased method string, a missing destination, a
// malformed/too-short/too-long/non-Kenyan number, and any value that cannot be
// normalised to the canonical form.
//
// WHAT THIS MODULE DOES **NOT** DO
// --------------------------------
// It does not verify that the number is registered with M-Pesa, that it is
// reachable, that it belongs to the person it is meant for, or that the
// provider will accept it for a B2C transfer. It establishes FORMAT and
// PERMITTED METHOD ONLY. No result from this module may be described as
// "verified", "validated" or "confirmed" to a user, an operator or a log: a
// well-formed number that belongs to a stranger is still well-formed.
//
// WHY IT LIVES HERE (and not inside the settlement executor)
// ---------------------------------------------------------
// The executor is `executeClaimSettlement()` in server.ts — a module that boots
// the whole application on import and therefore cannot be imported by a test
// (the same constraint that produced config/devPaymentSimulation.ts,
// config/paymentReconciliation.ts and config/payoutOutcomes.ts). Keeping the
// decision pure and here means "which destinations may ever be paid?" is
// exhaustively unit-testable, and the executor can only ever ask this module
// rather than re-deriving the rule locally.
//
// WHY A FAIL-CLOSED ALLOW-LIST RATHER THAN A DENY-LIST
// ---------------------------------------------------
// The platform's agent registration form has offered four payout methods
// (Till Number, Paybill Number, Pochi la Biashara, Personal M-Pesa), and the
// stored value is free-form text. A deny-list of the three unwanted strings
// would fail OPEN on any new option, any casing drift ('till number') and any
// value written before the rule existed. The check below is therefore a
// positive allow-list: exactly one method string and exactly one destination
// shape are eligible, and everything else — including strings this code has
// never seen — is refused.

/** The ONE payout method a launch payout leg may use. Exact, case-sensitive. */
export const PERSONAL_MPESA_PAYOUT_METHOD = 'Personal M-Pesa';

/** The canonical Kenyan personal M-Pesa destination shape: 254 + nine digits. */
export const CANONICAL_KENYAN_MSISDN_PATTERN = /^254\d{9}$/;

/**
 * Why a payout leg was refused. A closed vocabulary of CODES — no destination,
 * phone number or account ever appears in a reason, so a reason is always safe
 * to log, audit and return to an administrator.
 */
export type PayoutDestinationRefusalReason =
  | 'destination_missing'
  | 'destination_not_a_personal_mpesa_phone'
  | 'unsupported_payout_method';

export interface PayoutDestinationLeg {
  recipientType: 'finder' | 'agent';
  destination: unknown;
  payoutMethodType?: unknown;
}

export interface PayoutLegEligibility {
  recipientType: 'finder' | 'agent';
  /** True only when this leg may be submitted to the provider. */
  eligible: boolean;
  /**
   * The canonical `254` + nine digits form, or null when the leg is not
   * eligible. This is the value a caller may submit; it is never a guess at a
   * partially-normalised number.
   */
  canonicalDestination: string | null;
  /** Null when eligible, a code from the closed vocabulary when not. */
  reason: PayoutDestinationRefusalReason | null;
  /** The observed destination, masked for logs and error surfaces. */
  maskedDestination: string;
}

export interface PayoutBatchEligibility {
  /** True ONLY when every leg in the batch is eligible. */
  eligible: boolean;
  /** One entry per leg, in the order supplied — the audit evidence. */
  legs: PayoutLegEligibility[];
  /** The refused legs only, in the order supplied. */
  ineligible: PayoutLegEligibility[];
}

/**
 * The digits of a destination, with every non-digit removed — the SAME
 * normalisation services/payments.ts:formatMpesaPhone() applies before a value
 * is sent to the provider. Keeping the two identical matters: a destination
 * that this module accepts must be submitted as the value this module
 * canonicalised, never as some other string the transport layer would produce.
 */
function destinationDigits(destination: unknown): string {
  if (destination === null || destination === undefined) return '';
  if (typeof destination !== 'string' && typeof destination !== 'number') return '';
  return String(destination).replace(/\D/g, '');
}

/**
 * The canonical `254` + nine digits form of a Kenyan personal M-Pesa
 * destination, or null.
 *
 * Accepted inputs are the documented national and international shapes:
 *   '0712345678'  -> '254712345678'   (national, leading zero)
 *   '712345678'   -> '254712345678'   (national, no zero)
 *   '+254712345678' / '254712345678'  -> '254712345678'
 *   '0110000000'  -> '254110000000'   (the 01x range is equally valid)
 *   spaced/dashed/parenthesised forms of the above ('+254 712 345 678')
 *
 * Everything else returns null rather than a best guess: a non-Kenyan country
 * code ('+255…'), a value with no digits at all ('E2E-TILL'), anything whose
 * canonical form is not exactly twelve digits, and any digit string whose
 * leading digit is not 0, 7, 1 or 254. The final shape check requires the
 * subscriber part to begin 7 or 1, because that is the only range a Kenyan
 * mobile (personal M-Pesa) destination can occupy — `254` followed by nine
 * arbitrary digits is not, by itself, a Kenyan mobile number.
 */
export function normalizePersonalMpesaPhoneDestination(destination: unknown): string | null {
  const digits = destinationDigits(destination);
  if (digits === '') return null;

  let canonical: string;
  if (digits.startsWith('254')) {
    canonical = digits;
  } else if (digits.startsWith('0')) {
    canonical = `254${digits.slice(1)}`;
  } else if (digits.startsWith('7') || digits.startsWith('1')) {
    canonical = `254${digits}`;
  } else {
    return null;
  }

  if (!CANONICAL_KENYAN_MSISDN_PATTERN.test(canonical)) return null;
  // After the country code the national significant number must be a mobile
  // range: 7 (07xx) or 1 (01x). Nothing else is a personal M-Pesa handset.
  if (!/^[71]/.test(canonical.slice(3))) return null;

  return canonical;
}

/**
 * The destination rendered for a log, an audit row or an error message: the
 * leading digits and the last three only, exactly like the phone-masking helper
 * the payment services use. A short or empty value is masked completely.
 */
export function maskPayoutDestinationForLog(destination: unknown): string {
  const compact = destination === null || destination === undefined ? '' : String(destination).replace(/\s+/g, '');
  if (compact === '') return '(none)';
  if (compact.length < 7) return '***';
  return `${compact.slice(0, -6)}***${compact.slice(-3)}`;
}

/**
 * Whether ONE payout leg is eligible under the launch policy.
 *
 * Order matters and is deliberate: a missing destination and a malformed one
 * are different, actionable facts for an operator, so they are reported
 * separately from an unsupported payout method.
 *
 * The method rule applies to BOTH legs. A finder leg is by definition a
 * personal M-Pesa leg (the platform sets its method, never the recipient), so a
 * finder leg carrying any other method is a caller defect and is refused rather
 * than paid.
 */
export function resolvePayoutLegEligibility(leg: PayoutDestinationLeg): PayoutLegEligibility {
  const recipientType = leg?.recipientType === 'agent' ? 'agent' : 'finder';
  const maskedDestination = maskPayoutDestinationForLog(leg?.destination);

  const refuse = (reason: PayoutDestinationRefusalReason): PayoutLegEligibility => ({
    recipientType,
    eligible: false,
    canonicalDestination: null,
    reason,
    maskedDestination,
  });

  const rawDestination = leg?.destination;
  // ABSENT means absent: undefined, null, or an empty/whitespace-only string. A
  // value that is PRESENT but holds no digits is a different (and equally
  // actionable) fact — it is reported as a malformed destination below, not as a
  // missing one, because the operator's fix is different.
  if (rawDestination === null || rawDestination === undefined) return refuse('destination_missing');
  if (typeof rawDestination !== 'string' && typeof rawDestination !== 'number') {
    return refuse('destination_not_a_personal_mpesa_phone');
  }
  if (String(rawDestination).trim() === '') return refuse('destination_missing');

  const canonicalDestination = normalizePersonalMpesaPhoneDestination(leg?.destination);
  if (canonicalDestination === null) return refuse('destination_not_a_personal_mpesa_phone');

  // Exact, case-sensitive equality against the single supported literal. A
  // differently-cased, differently-spaced or unknown method is NOT the
  // supported one, and is refused rather than coerced.
  if (leg?.payoutMethodType !== PERSONAL_MPESA_PAYOUT_METHOD) return refuse('unsupported_payout_method');

  return {
    recipientType,
    eligible: true,
    canonicalDestination,
    reason: null,
    maskedDestination,
  };
}

/**
 * Whether a WHOLE batch may be submitted, and why not when it may not.
 *
 * A batch is eligible only when every leg in it is. This is what makes a
 * "partial or mixed batch" unrepresentable: the caller asks about the legs it
 * intends to send, and refuses to send ANY of them when one is refused — a
 * valid finder leg is never paid alongside an agent leg pointing at a Till
 * number.
 */
export function resolvePayoutBatchEligibility(
  legs: readonly PayoutDestinationLeg[] | null | undefined,
): PayoutBatchEligibility {
  const supplied = Array.isArray(legs) ? legs : [];
  const resolved = supplied.map(resolvePayoutLegEligibility);
  const ineligible = resolved.filter((leg) => !leg.eligible);

  return {
    // An empty batch is NOT eligible: there is nothing legitimate to submit,
    // and treating "no legs" as "no objections" is exactly the shape of
    // fail-open defect this module exists to prevent.
    eligible: supplied.length > 0 && ineligible.length === 0,
    legs: resolved,
    ineligible,
  };
}

/**
 * PII-FREE description of a refused leg, for an audit row and an
 * operator-facing message. Codes and the MASKED destination only: never the
 * number itself, and never a claim that the number was verified.
 */
export function describePayoutDestinationRefusal(eligibility: PayoutLegEligibility): string {
  const subject = eligibility.recipientType === 'agent' ? 'agent' : 'finder';
  switch (eligibility.reason) {
    case 'destination_missing':
      return `the ${subject} payout has no destination recorded (observed: ${eligibility.maskedDestination})`;
    case 'destination_not_a_personal_mpesa_phone':
      return (
        `the ${subject} payout destination is not a personal M-Pesa phone number ` +
        `(it must normalise to exactly 254 followed by nine digits; nothing else is sent) ` +
        `(observed: ${eligibility.maskedDestination})`
      );
    case 'unsupported_payout_method':
      return (
        `the ${subject} payout method is not the supported "${PERSONAL_MPESA_PAYOUT_METHOD}" method ` +
        `(Till Number, Paybill Number and Pochi la Biashara are all refused at launch)`
      );
    default:
      return `the ${subject} payout destination is not eligible`;
  }
}
