// =============================================================================
// STAGE 3B-3 — THE ADMINISTRATOR REASON POLICY FOR MANUAL ASSIGNMENT WORK.
//
// WHY THIS MODULE EXISTS
// ----------------------
// A manual assignment, reassignment or unassignment is an administrator's
// decision about someone else's property, and the reason is the only part of the
// record a human wrote. It is therefore:
//
//   * REQUIRED — a blank or whitespace-only reason is not a reason. The route
//     already refused one for an assignment; this module makes that rule one
//     function instead of three copies, and applies it to unassignment too.
//   * MEANINGFUL — a one-character placeholder (".") is refused, because a
//     history row whose reason says nothing is indistinguishable from one that
//     was never asked for.
//   * FREE OF UNAVOIDABLE PERSONAL DATA — the reason is written to
//     `item_agent_assignments.reason` (append-only, seven-year retention
//     candidate) and copied into the audit trail. That makes it a place where a
//     claimant's phone number, email address or ID number could come to rest
//     permanently, outside every field-level redaction path the account-erasure
//     flow knows about. The product decision for this stage is explicit:
//     reasons must not contain unnecessary claimant/finder personal
//     information, and the server must refuse the CLEARLY IDENTIFIABLE forms.
//
// WHAT THIS DELIBERATELY DOES NOT DO — AND MUST NOT CLAIM TO DO
// ------------------------------------------------------------
// It does not detect a person's NAME. There is no reliable, false-positive-free
// way to tell "Jane Wanjiku Mwangi" from "Owner of the black phone" in free
// text, and a name-shaped regex would reject perfectly good operational reasons
// ("previous holder was the agent on duty"). The product decision explicitly
// declines to claim that detection. The check below is narrow BY DESIGN: it
// looks for shapes that are unambiguously contact or identification data —
//
//   * an email address;
//   * a Kenyan mobile number in any ordinary rendering (07…, 01…, +254…, 254…);
//   * another international number written with a leading '+';
//   * an identification number that is LABELLED as one ("ID 12345678",
//     "passport no. A1234567", "national ID: 12345678").
//
// A bare seven- or eight-digit run is NOT treated as an ID number: dates
// (20260312), counts and internal references share that shape, so flagging them
// would reject honest reasons. The labelling requirement is what keeps the rule
// "clearly identifiable" rather than "possibly a number".
//
// The validator is a guard-rail, not a guarantee. An administrator who types a
// name still writes a name; that is why the field's help text asks for the
// operational reason only, and why the same text is reviewed by a human.
// =============================================================================

/** Minimum useful length, after trimming. Refuses "." / "x" / "n/a". */
export const ADMIN_REASON_MIN_LENGTH = 10;

/** Upper bound, so one reason cannot become an essay in an append-only table. */
export const ADMIN_REASON_MAX_LENGTH = 500;

/** The message the admin API has always used for a missing assignment reason. */
export const ADMIN_REASON_REQUIRED_MESSAGE = 'A reason is required to assign an Agent.';

export const ADMIN_REASON_TOO_SHORT_MESSAGE =
  `Give a reason of at least ${ADMIN_REASON_MIN_LENGTH} characters explaining the decision.`;

export const ADMIN_REASON_TOO_LONG_MESSAGE =
  `Keep the reason under ${ADMIN_REASON_MAX_LENGTH} characters.`;


/**
 * The personal-data shapes this policy refuses.
 *
 * Each pattern is anchored on a shape that cannot plausibly be part of an
 * ordinary operational sentence, and the boundaries are deliberate: a number
 * inside a longer alphanumeric token (an item code, an id reference) is not a
 * phone number, and refusing it would make the validator unusable.
 */
const PERSONAL_DATA_PATTERNS: ReadonlyArray<{ kind: 'email' | 'phone' | 'identification'; pattern: RegExp }> = [
  // user@example.com — including the common 'name@sub.domain.co.ke' shape.
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/ },
  // 0712 345 678 / 0712345678 / +254 712 345 678 / 254-712-345-678
  // Only the Kenyan mobile prefixes (07/01) are matched in the local form; the
  // country-code form requires 254 followed by 7 or 1.
  { kind: 'phone', pattern: /(?:\+?254|0)[\s-]?[17]\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/ },
  // +44 20 7946 0958 — any other international number written with a '+'.
  { kind: 'phone', pattern: /\+\d[\d\s-]{8,}\d/ },
  // ID 12345678 / national id: 12345678 / passport no. A1234567 / N.I.D #12345678
  {
    kind: 'identification',
    pattern:
      /\b(?:national\s+id|nat\.?\s*id|n\.?i\.?d|id|passport|dl|driving\s+licen[cs]e|licen[cs]e)\b[\s.:#-]*(?:no\.?|number|num\.?)?[\s.:#-]*[A-Z]{0,2}\d{5,}[A-Z0-9]*/i,
  },
];

/**
 * Does this text contain a clearly identifiable phone number, email address or
 * labelled identification number? Exported so a future caller (an audit-text
 * redaction pass, for example) can reuse the same shapes rather than inventing
 * a second, weaker set.
 */
export function detectPersonalDataInReason(text: unknown): 'email' | 'phone' | 'identification' | null {
  if (typeof text !== 'string' || text === '') return null;
  for (const candidate of PERSONAL_DATA_PATTERNS) {
    if (candidate.pattern.test(text)) return candidate.kind;
  }
  return null;
}

/**
 * The one validator every manual assignment surface uses.
 *
 * Order matters: a missing reason is reported as missing (the historically
 * stable message), then length, then personal data. A caller that receives
 * `ok: false` must write NOTHING — no item update, no history row, no audit
 * line, no notification.
 */
export function validateAdminAssignmentReason(raw: unknown): AdminReasonValidation {
  const reason = typeof raw === 'string' ? raw.trim() : '';

  if (!reason) {
    return { ok: false, reason: '', error: ADMIN_REASON_REQUIRED_MESSAGE, kind: 'missing' };
  }
  if (reason.length < ADMIN_REASON_MIN_LENGTH) {
    return { ok: false, reason: '', error: ADMIN_REASON_TOO_SHORT_MESSAGE, kind: 'too_short' };
  }
  if (reason.length > ADMIN_REASON_MAX_LENGTH) {
    return { ok: false, reason: '', error: ADMIN_REASON_TOO_LONG_MESSAGE, kind: 'too_long' };
  }
  if (detectPersonalDataInReason(reason)) {
    return { ok: false, reason: '', error: ADMIN_REASON_PERSONAL_DATA_MESSAGE, kind: 'personal_data' };
  }

  return { ok: true, reason, error: '', kind: null };
}

export const ADMIN_REASON_PERSONAL_DATA_MESSAGE =
  'Remove claimant or finder personal details (phone number, email address or ID number) from the reason. Describe the operational decision instead.';

export type AdminReasonFailureKind = 'missing' | 'too_short' | 'too_long' | 'personal_data';

/**
 * The validator's verdict.
 *
 * DELIBERATELY A FLAT OBJECT rather than a discriminated union of
 * `{ok: true, ...}` / `{ok: false, ...}`: this repository compiles with
 * `strictNullChecks` off, where a boolean literal discriminant does NOT narrow a
 * union, so every caller would have to assert the shape it had just checked. A
 * single object with an always-present `reason` and `error` is just as
 * unambiguous for callers (`ok` decides, `error` is safe to return verbatim) and
 * cannot be mis-narrowed.
 */
export interface AdminReasonValidation {
  ok: boolean;
  /** The accepted, TRIMMED reason. An empty string when `ok` is false. */
  reason: string;
  /** An operator-safe refusal message. An empty string when `ok` is true. */
  error: string;
  /** Machine-readable refusal kind, or null when `ok` is true. */
  kind: AdminReasonFailureKind | null;
}
