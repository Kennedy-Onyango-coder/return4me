// ============================================================================
// COLLECTION FAILURE STATES — the ONE vocabulary for "this M-Pesa collection
// will never be paid".
// ============================================================================
//
// THE DEFECT THIS MODULE EXISTS TO PREVENT
//
// The IntaSend collection webhook used to treat every state other than
// `COMPLETE` as a safe no-op:
//
//     if (state !== 'COMPLETE') { return res.json({ status: 'ignored' }); }
//
// That is correct for `PENDING` (the prompt is still open) but it is WRONG for
// `FAILED` / `CANCELLED`. Those are TERMINAL provider verdicts: no money will
// ever arrive for that invoice, yet nothing local recorded the fact. The
// payment session stayed `pending` until a short attempt window elapsed, the
// customer's screen kept saying "waiting for M-Pesa", and the only visible
// trace was a callback the server had thrown away. The customer then either
// abandoned the claim or paid AGAIN with a second session, and there was no
// record explaining either.
//
// WHAT THIS MODULE IS
//
// A pure, dependency-free accept-set that answers exactly one question:
//
//     "does this provider state mean the collection attempt is DEAD?"
//
// It is deliberately tolerant about spelling, because the exact casing and
// separators of the provider's terminal states are not something this codebase
// can pin down from the payloads it has seen (`FAILED`, `failed`, `CANCELLED`,
// `canceled`, `TIMEOUT`, `INSUFFICIENT_FUNDS`, ... all describe the same
// business fact). Tolerating the spelling is safe precisely BECAUSE this module
// never writes anything: a state it classifies as a failure is still
// RE-VERIFIED against the authoritative provider lookup before any local row is
// marked failed (see services/collectionFailureReconciliation.ts). A wrong
// guess therefore costs one provider request, never a payment row's truth.
//
// WHAT THIS MODULE IS NOT
//
// It is NOT authorisation to mark anything failed, and it is NOT a substitute
// for `PaymentService.fetchAuthoritativeCollectionStatus`. `PENDING`,
// `PROCESSING`, `INITIATED`, an absent state and any unknown value all return
// null ("not a terminal failure") so that ordinary in-flight events keep their
// existing silently-ignored behaviour.

/**
 * The terminal failure shapes Return4me distinguishes.
 *
 * `failed`    — the attempt was refused (declined, insufficient funds, error).
 * `cancelled` — the attempt was abandoned or timed out (the payer never
 *               approved the prompt, or the prompt was cancelled).
 *
 * The distinction is kept because it is the only difference an operator or a
 * customer can act on: a decline is "try another number / top up", a cancel is
 * usually "you did not approve the prompt in time". Both mean the same thing
 * financially: nothing was collected for that invoice.
 */
export type CollectionFailureKind = 'failed' | 'cancelled';

/**
 * The provider spellings that mean "refused".
 *
 * Every entry is a state observed (or plausibly emitted) by an M-Pesa
 * collection provider. Matching is done on a normalized token, so casing,
 * surrounding whitespace, spaces, hyphens and repeated underscores in the
 * incoming value do not matter.
 */
const FAILED_STATES: readonly string[] = [
  'FAILED',
  'FAIL',
  'FAILURE',
  'PAYMENT_FAILED',
  'TRANSACTION_FAILED',
  'COLLECTION_FAILED',
  'DECLINED',
  'REJECTED',
  'INSUFFICIENT_FUNDS',
  'ERROR',
];

/**
 * The provider spellings that mean "abandoned / never approved".
 *
 * `EXPIRED`, `TIMEOUT` and `TIMED_OUT` are deliberately NOT here. They describe
 * the STK prompt running out of time, which is the same fact the LOCAL session
 * status `expired` already records — and an `expired` session is deliberately
 * still confirmable, because a payer can approve a prompt after this process
 * gave up on it. Classifying those spellings as terminal failures here would
 * turn a late approval into a refused confirmation: exactly the lost-money
 * failure this whole lifecycle is being hardened against. A prompt that timed
 * out therefore keeps its existing behaviour (the expiry path owns it) and only
 * an explicit cancellation or abandonment from the provider marks a session
 * failed.
 */
const CANCELLED_STATES: readonly string[] = [
  'CANCELLED',
  'CANCELED',
  'CANCEL',
  'CANCELLED_BY_USER',
  'CANCELED_BY_USER',
  'USER_CANCELLED',
  'USER_CANCELED',
  'ABANDONED',
];

const FAILED_SET: ReadonlySet<string> = new Set(FAILED_STATES);
const CANCELLED_SET: ReadonlySet<string> = new Set(CANCELLED_STATES);

/**
 * Normalizes a provider state into a comparable token.
 *
 * Returns '' for anything that is not a non-empty string/number, so the
 * classifiers below fall through to "not a failure" instead of guessing.
 */
export function normalizeCollectionStateToken(state: unknown): string {
  if (state === null || state === undefined) return '';
  if (typeof state !== 'string' && typeof state !== 'number') return '';
  return String(state)
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Classifies a provider state.
 *
 * Returns the failure kind, or null when the state is NOT a terminal failure
 * (in flight, complete, absent, or unrecognised). Null is the safe answer: the
 * caller keeps its pre-existing "ignore this event" behaviour and nothing is
 * written.
 */
export function normalizeCollectionFailureState(state: unknown): CollectionFailureKind | null {
  const token = normalizeCollectionStateToken(state);
  if (!token) return null;
  if (FAILED_SET.has(token)) return 'failed';
  if (CANCELLED_SET.has(token)) return 'cancelled';
  return null;
}

/**
 * The stable reason code persisted in `payment_sessions.failure_reason` (and
 * quoted in the audit log) for each kind.
 *
 * These are deliberately NOT the raw provider string: a stored reason must be a
 * closed vocabulary an operator can group by, while the actual provider state
 * is recorded alongside it in the audit message. Snake_case, lowercase, no
 * provider-specific punctuation, so it can be compared literally by a future
 * reader, a report or an admin filter.
 */
export const COLLECTION_FAILURE_REASON_CODES: Readonly<Record<CollectionFailureKind, string>> = {
  failed: 'provider_reported_failed',
  cancelled: 'provider_reported_cancelled',
};

/** The persisted reason code for a classified failure kind. */
export function collectionFailureReasonCode(kind: CollectionFailureKind): string {
  return COLLECTION_FAILURE_REASON_CODES[kind];
}
