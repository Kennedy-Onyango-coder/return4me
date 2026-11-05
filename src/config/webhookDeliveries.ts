// GATE C / STAGE C2 — DURABLE WEBHOOK DELIVERY RECORDS: the vocabulary.
//
// WHAT THIS MODULE IS, AND WHAT IT IS DELIBERATELY NOT
// ---------------------------------------------------
// The IntaSend callback route is the only thing that can move a claim into
// escrow_held, and until this stage it left NO durable trace of a delivery that
// it refused: a provider-confirmed collection the application declined to
// reconcile existed only as a console line, and recovery depended on the
// 60-second sweep. This module defines the vocabulary for recording each DELIVERY
// ATTEMPT and its processing outcome so an operator can answer, after the fact:
//
//   when did the delivery arrive, did authentication succeed, what event
//   category was it, what did the application decide, what HTTP status did the
//   provider actually receive, was the refusal retryable, and was the underlying
//   payment session resolved later by a different delivery or the sweep.
//
// It is an OBSERVABILITY vocabulary. Nothing here grants, authorises or performs
// a financial operation, and no value defined here can be used as proof that a
// collection is confirmed.
//
// WHY THE OUTCOME MAPPING LIVES HERE AND NOT IN A SECOND CATALOGUE
// ---------------------------------------------------------------
// Stage C1 already established the ONE payment-confirmation outcome contract
// (./paymentConfirmationOutcome): `reconciled` | `already_reconciled` |
// `refused(code, retryable)`, plus its HTTP mapping. This stage must not
// recreate that catalogue, so `deliveryOutcomeForPaymentConfirmation()` is a
// pure TRANSLATION of an outcome the route already received into the delivery
// vocabulary. The refusal CODES are not restated: they are taken from the
// outcome itself (`outcome.code`), so a code added to the C1 catalogue in future
// needs no change here and cannot be silently dropped.
//
// DELIVERY ATTEMPT vs LOGICAL EVENT
// ---------------------------------
// A delivery attempt is one HTTP POST the provider made. IntaSend does not
// supply a stable unique event id (the payload carries `invoice_id`,
// `api_ref`, `provider_ref` and `state`), so:
//
//   * the PRIMARY KEY is an application-generated id (`WHD-…`), never a
//     provider value;
//   * there is NO uniqueness constraint on provider invoice/reference or on the
//     payload fingerprint, because repeated deliveries of the same logical event
//     are exactly the thing that must be RECORDABLE (a duplicate must produce a
//     second attempt row, not be rejected by a constraint);
//   * the fingerprint is a CORRELATION AID only. Two callbacks whose observable
//     fields match are very probably the same logical event, and that is all the
//     fingerprint is allowed to mean.
import crypto from 'crypto';
import type { PaymentConfirmationOutcome } from './paymentConfirmationOutcome';

// ---------------------------------------------------------------------------
// PROVIDER
// ---------------------------------------------------------------------------
// One provider today. Named rather than hard-coded in the DDL so a second
// provider is a vocabulary change, not a column change.
export const WEBHOOK_DELIVERY_PROVIDERS = ['intasend'] as const;

export type WebhookDeliveryProvider = (typeof WEBHOOK_DELIVERY_PROVIDERS)[number];

export const WEBHOOK_DELIVERY_PROVIDER_SQL_LIST = WEBHOOK_DELIVERY_PROVIDERS.map((v) => `'${v}'`).join(', ');

// ---------------------------------------------------------------------------
// EVENT CATEGORY — "which event category was received"
// ---------------------------------------------------------------------------
// Derived from the payload's topic (and, for collections, its state) by the ONE
// classifier below, so the stored category is an internal, closed vocabulary and
// never an attacker-supplied string. `collection_non_complete` is what the route
// hands to services/collectionFailureReconciliation.ts; `unrouted` is an
// authenticated payload whose topic this application has no handler for.
export const WEBHOOK_DELIVERY_EVENT_CATEGORIES = [
  'collection_complete',
  'collection_non_complete',
  'collection_other',
  'payout_batch',
  'unrouted',
] as const;

export type WebhookDeliveryEventCategory = (typeof WEBHOOK_DELIVERY_EVENT_CATEGORIES)[number];

export const WEBHOOK_DELIVERY_EVENT_CATEGORY_SQL_LIST = WEBHOOK_DELIVERY_EVENT_CATEGORIES.map(
  (v) => `'${v}'`,
).join(', ');

/**
 * Classifies a delivery from the two payload fields the route actually uses.
 * Pure, total, and safe with untrusted input: an unknown/absent topic is
 * `unrouted`, and a collection event is only `collection_complete` when the
 * state is exactly `COMPLETE` — the same test the route makes.
 */
export function eventCategoryForDelivery(
  topic: unknown,
  state: unknown,
): WebhookDeliveryEventCategory {
  const t = typeof topic === 'string' ? topic.trim() : '';
  if (t === 'send_money_event') return 'payout_batch';
  if (t !== '' && t !== 'collection_event') return 'unrouted';
  // No topic at all: the route treats a topic-less payload as a collection event
  // (the pre-routing contract), so the category must agree with that.
  if (state === 'COMPLETE') return 'collection_complete';
  if (typeof state === 'string' && state.trim() !== '') return 'collection_non_complete';
  return 'collection_other';
}

// ---------------------------------------------------------------------------
// PROCESSING STATUS — the delivery lifecycle
// ---------------------------------------------------------------------------
// Adapted from the stage brief's suggested list. Three categories are added to
// it, and each addition is justified rather than convenient:
//
//   * `ignored` — an authenticated delivery this application acknowledges but
//     takes no action on (a non-collection topic, or a collection event with no
//     action to take). Without it, "we saw it and did nothing" would have to be
//     recorded as a refusal, which would be a false accusation against the
//     provider, or as success, which would be a lie.
//   * `collection_failure_recorded` and `payout_verification_routed` — a
//     collection FAILED/CANCELLED event and a payout callback are both
//     PROCESSED, but neither is a collection reconciliation. Recording them as
//     `reconciled` would imply a payment was confirmed; recording them as
//     `ignored` would hide that a durable local write happened (a corroborated
//     terminal failure) or that provider verification was triggered. Neither
//     status makes any statement about money.
//
// NOTHING HERE IS A FINANCIAL STATE. `reconciled` means the canonical
// confirmation path itself reported a reconciliation; it can never be written by
// anything else.
export const WEBHOOK_DELIVERY_STATUSES = [
  /** Row created on arrival; the request has not finished yet. */
  'received',
  /** Authenticated + validated; the financial path has been entered. */
  'processing',
  /** Challenge/authentication failed. No payload value was trusted. */
  'authentication_rejected',
  /** Authentication passed but a required identity field was unusable. */
  'validation_rejected',
  /** The canonical confirmation path reconciled the collection (C1). */
  'reconciled',
  /** Duplicate delivery of an already-reconciled collection (C1, idempotent). */
  'already_reconciled',
  /** Transient refusal: the provider could not corroborate the event (C1). */
  'refused_retryable',
  /** Permanent refusal: verified facts disagree with local truth (C1). */
  'refused_permanent',
  /** Acknowledged, no action taken. */
  'ignored',
  /** A non-complete collection event recorded a corroborated terminal failure. */
  'collection_failure_recorded',
  /** A payout callback was routed to provider re-verification (trigger only). */
  'payout_verification_routed',
  /** Unexpected exception on this request. Never a success. */
  'internal_error',
] as const;

export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const WEBHOOK_DELIVERY_STATUS_VALUES: readonly string[] = WEBHOOK_DELIVERY_STATUSES;

export const WEBHOOK_DELIVERY_STATUS_SQL_LIST = WEBHOOK_DELIVERY_STATUSES.map((v) => `'${v}'`).join(', ');

export function isWebhookDeliveryStatus(value: unknown): value is WebhookDeliveryStatus {
  return typeof value === 'string' && (WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(value);
}

/**
 * NON-TERMINAL statuses. A row in one of these states means the request had not
 * finished — including the case where the process died mid-flight. Such a row is
 * reported as INCOMPLETE and is never presented as a success.
 */
export const WEBHOOK_DELIVERY_OPEN_STATUSES = ['received', 'processing'] as const;

export const WEBHOOK_DELIVERY_OPEN_STATUS_SQL_LIST = WEBHOOK_DELIVERY_OPEN_STATUSES.map(
  (v) => `'${v}'`,
).join(', ');

export function isOpenWebhookDeliveryStatus(value: unknown): boolean {
  return typeof value === 'string' && (WEBHOOK_DELIVERY_OPEN_STATUSES as readonly string[]).includes(value);
}

/** Terminal statuses: the request completed and `processed_at` is set. */
export const WEBHOOK_DELIVERY_TERMINAL_STATUSES: readonly WebhookDeliveryStatus[] =
  WEBHOOK_DELIVERY_STATUSES.filter((s) => !isOpenWebhookDeliveryStatus(s));

// ---------------------------------------------------------------------------
// SESSION RESOLUTION — "was the underlying payment session resolved later?"
// ---------------------------------------------------------------------------
// DERIVED AT READ TIME, NEVER PERSISTED ON THE ORIGINAL DELIVERY ROW. The
// historical result of an HTTP delivery (status, code, http_status) must stay
// frozen; what happened to the PAYMENT SESSION afterwards is a different fact and
// is reported as a separate field. See db.listAdminWebhookDeliveries().
export const WEBHOOK_SESSION_RESOLUTIONS = [
  /** No payment session could be safely associated with this delivery. */
  'no_payment_session',
  /** The associated session is not confirmed (pending/created/failed/…). */
  'unresolved',
  /** THIS delivery is the one that reconciled the session. */
  'resolved_by_this_delivery',
  /** The session was already confirmed by an EARLIER delivery (duplicate). */
  'already_resolved_before_this_delivery',
  /** A LATER delivery reconciled it after this one was refused/failed. */
  'resolved_by_later_delivery',
  /**
   * The session is confirmed but no delivery accounts for it: the 60-second
   * `reconcilePendingPaymentSessions` sweep or the on-demand payment-session
   * status route resolved it. Both are recovery paths outside this table, and
   * this application cannot tell them apart from delivery records alone — so it
   * does not pretend to.
   */
  'resolved_by_other_recovery',
] as const;

export type WebhookSessionResolution = (typeof WEBHOOK_SESSION_RESOLUTIONS)[number];

// ---------------------------------------------------------------------------
// BOUNDED FIELDS
// ---------------------------------------------------------------------------
// Every one of these is also a column width in schema.ts / sql/schema.sql. They
// are declared once here and imported by all three schema sources, so a value
// that fits the validator always fits the column.
export const WEBHOOK_DELIVERY_ID_MAX = 50;
export const WEBHOOK_DELIVERY_TOPIC_MAX = 60;
export const WEBHOOK_DELIVERY_EVENT_CATEGORY_MAX = 40;
export const WEBHOOK_DELIVERY_STATUS_MAX = 30;
export const WEBHOOK_DELIVERY_OUTCOME_CODE_MAX = 60;
export const WEBHOOK_DELIVERY_CLAIM_ID_MAX = 50;
export const WEBHOOK_DELIVERY_SESSION_ID_MAX = 64;
export const WEBHOOK_DELIVERY_PROVIDER_INVOICE_MAX = 100;
export const WEBHOOK_DELIVERY_PROVIDER_REFERENCE_MAX = 100;
export const WEBHOOK_DELIVERY_FINGERPRINT_MAX = 64;
export const WEBHOOK_DELIVERY_DIAGNOSTIC_MAX = 200;

// ---------------------------------------------------------------------------
// PAGINATION BOUNDS (read-only administrative inspection)
// ---------------------------------------------------------------------------
export const WEBHOOK_DELIVERY_PAGE_DEFAULT = 25;
export const WEBHOOK_DELIVERY_PAGE_MAX = 100;

// ---------------------------------------------------------------------------
// SANITISERS
// ---------------------------------------------------------------------------
// Everything persisted is validated through these first. The character class is
// the same conservative one the admin claim routes use for repository ids: it
// admits `.`, `_`, `:` and `-` (real identifier shapes) and refuses whitespace,
// quotes, semicolons, backslashes and slashes — the characters that make a
// stored string interesting in a log, a shell or a LIKE pattern.
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]+$/;

/**
 * Returns the value only when it is a non-empty bounded identifier; otherwise
 * `null`. It never truncates: a truncated identifier is a DIFFERENT identifier,
 * and storing half of an attacker-supplied string is worse than storing nothing.
 */
export function safeWebhookIdentifier(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || value.length > maxLength) return null;
  if (!SAFE_IDENTIFIER.test(value)) return null;
  return value;
}

/** Convenience wrappers for the fields the route actually persists. */
export const safeWebhookTopic = (raw: unknown) =>
  safeWebhookIdentifier(raw, WEBHOOK_DELIVERY_TOPIC_MAX);

export const safeWebhookInvoiceId = (raw: unknown) =>
  safeWebhookIdentifier(raw, WEBHOOK_DELIVERY_PROVIDER_INVOICE_MAX);

export const safeWebhookProviderReference = (raw: unknown) =>
  safeWebhookIdentifier(raw, WEBHOOK_DELIVERY_PROVIDER_REFERENCE_MAX);

/** Claim ids are repository ids (`CLM-…`/`CLAIM-…`), bounded by claims.id. */
export const safeWebhookClaimId = (raw: unknown) =>
  safeWebhookIdentifier(raw, WEBHOOK_DELIVERY_CLAIM_ID_MAX);

export const safeWebhookSessionId = (raw: unknown) =>
  safeWebhookIdentifier(raw, WEBHOOK_DELIVERY_SESSION_ID_MAX);

/**
 * A refusal/error code is stored for an operator to read, so it is validated
 * against the same identifier class rather than accepted verbatim: a code that
 * arrived from a provider payload must never become a free-text column.
 * (`unknown_confirmation_outcome`, the C1 codes and the route's own
 * `INTASEND_WEBHOOK_*` contexts all satisfy this.)
 */
export function safeWebhookOutcomeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || value.length > WEBHOOK_DELIVERY_OUTCOME_CODE_MAX) return null;
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) return null;
  return value;
}

/** Sanitised, bounded internal diagnostic text (never a payload fragment). */
export function safeWebhookDiagnostic(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.replace(/\s+/g, ' ').trim();
  if (value === '') return null;
  if (value.length > WEBHOOK_DELIVERY_DIAGNOSTIC_MAX) return null;
  if (!/^[A-Za-z0-9_.:,() -]+$/.test(value)) return null;
  return value;
}

// ---------------------------------------------------------------------------
// PAYLOAD FINGERPRINT
// ---------------------------------------------------------------------------
// A sha256 over the FEW observable fields that identify a callback, in a fixed
// canonical order. Deliberate exclusions:
//
//   * `challenge` — a shared secret; it must never influence a stored value and
//     must never be persisted;
//   * `phone_number` — personal data this table has no use for;
//   * every other body field — nothing else is needed to correlate.
//
// The result is a correlation AID: it can show that two attempts carried the
// same observable identity. It is NOT a primary key, NOT unique, and never
// evidence that two callbacks are the same logical event.
export function buildWebhookDeliveryFingerprint(input: {
  topic?: unknown;
  invoiceId?: unknown;
  state?: unknown;
  apiRef?: unknown;
  providerRef?: unknown;
  value?: unknown;
}): string | null {
  const norm = (raw: unknown): string | null => {
    if (typeof raw === 'string') {
      const v = raw.trim();
      return v === '' ? null : v.slice(0, 120);
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    return null;
  };

  const parts = [
    norm(input.topic),
    norm(input.invoiceId),
    norm(input.state),
    norm(input.apiRef),
    norm(input.providerRef),
    norm(input.value),
  ];
  // Nothing observable at all: no fingerprint rather than a fingerprint of
  // nothing (which would collide across every empty payload).
  if (parts.every((p) => p === null)) return null;

  return crypto.createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// C1 OUTCOME -> DELIVERY OUTCOME (the ONE translation)
// ---------------------------------------------------------------------------
export interface WebhookDeliveryOutcome {
  readonly status: WebhookDeliveryStatus;
  /** The safe refusal/error code, or null for a non-refusal status. */
  readonly code: string | null;
  /**
   * Whether a redelivery could help. NULL when the status is not a refusal, so
   * "not applicable" is never confused with "no".
   */
  readonly retryable: boolean | null;
}

/**
 * Translates the Stage C1 outcome contract into the delivery vocabulary.
 *
 * A value that is not the C1 union (an older `string | null` shape, a future
 * shape, a swallowed exception) is an INTERNAL ERROR, never a success — the same
 * fail-closed rule the route applies to the response.
 */
export function deliveryOutcomeForPaymentConfirmation(
  outcome: PaymentConfirmationOutcome | unknown,
): WebhookDeliveryOutcome {
  if (!outcome || typeof outcome !== 'object') {
    return { status: 'internal_error', code: 'unknown_confirmation_outcome', retryable: null };
  }
  const kind = (outcome as any).kind;
  if (kind === 'reconciled') {
    return { status: 'reconciled', code: null, retryable: null };
  }
  if (kind === 'already_reconciled') {
    return { status: 'already_reconciled', code: null, retryable: null };
  }
  if (kind === 'refused') {
    const retryable = (outcome as any).retryable === true;
    return {
      status: retryable ? 'refused_retryable' : 'refused_permanent',
      // The code comes from the C1 catalogue entry carried by the outcome; it is
      // NOT restated here and NOT re-derived.
      code: safeWebhookOutcomeCode((outcome as any).code),
      retryable,
    };
  }
  return { status: 'internal_error', code: 'unknown_confirmation_outcome', retryable: null };
}
