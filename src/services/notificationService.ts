// =============================================================================
// N5 — THE CANONICAL NOTIFICATION SERVICE.
//
// This is the reusable boundary the N5–N9 programme is built on:
//
//     application event → notification policy (config/notificationEvents.ts)
//     → channel selection (this file) → durable notification_events
//     → provider adapter (services/notificationProviders.ts) → SMS / Email
//
// WHAT CALLERS SUPPLY, AND WHY IT IS EXACTLY THIS
//
//   eventType      — from the closed vocabulary. Anything else is refused.
//   recipient      — the real address, used for delivery ONLY.
//   render()       — a FUNCTION, not a pre-rendered string.
//
// That last choice is the security design of this file, so it is worth stating
// plainly. A caller that passed `body: '<a href="…token=abc…">…</a>'` would be
// one careless `JSON.stringify(params)` away from writing a live activation link
// into a permanent database row. Because the body is produced by a callback the
// service invokes at the moment of sending, the rendered content is only ever in
// a local variable on the stack. There is no field to persist it into, and this
// service writes exactly five columns — none of which is the message.
//
// WHAT THIS SERVICE DELIBERATELY DOES NOT DO
//   * No retries. N9 owns fallback; a retry loop here would invent a delivery
//     policy nobody approved.
//   * No rate limiting. N6 owns it, per channel.
//   * No SMS call-site migration. N7 owns it.
//   * No claim about DELIVERY. It reports provider ACCEPTANCE, which is the only
//     thing either provider can actually prove.
// =============================================================================

import { db } from '../db/database.ts';
import { maskPhoneForLog, toE164Kenyan } from './auth.ts';
import { generateSecureId } from './customerAuth.ts';
import {
  getNotificationPolicy,
  type NotificationChannel,
} from '../config/notificationEvents.ts';
import { nextNotificationRetryAt } from '../config/notificationRetryPolicy.ts';
import {
  africaTalkingSmsProvider,
  resendEmailProvider,
  sanitizeProviderError,
  type EmailProvider,
  type ProviderDeliveryResult,
  type SmsProvider,
} from './notificationProviders.ts';

/**
 * The outcome a caller gets back.
 *
 * `accepted` is provider acceptance, not delivery — the same distinction the
 * `sent_at` column and the `accepted` provider field both preserve.
 */
export interface NotificationResult {
  accepted: boolean;
  /** False when policy refused the event or the channel before any send. */
  dispatched: boolean;
  /** The durable event row id, or null if it never reached the database. */
  eventId: string | null;
  status: 'sent' | 'failed' | 'rejected' | 'duplicate';
  /**
   * A short, safe reason. Never a provider payload, never a message body, never a
   * credential. Callers may surface this to an operator; they must not surface it
   * to an end user verbatim, because a refusal reason names the internal policy.
   */
  reason?: string | null;
}

export interface NotificationRequest {
  eventType: string;
  /**
   * The real address: an email or a phone. Normalized by this service, never by
   * the caller, so two call sites cannot normalize the same recipient
   * differently.
   */
  recipient: string;
  /**
   * Renders the message at send time. Optional for email, where a subject alone
   * is a legitimate (if unusual) notification.
   */
  render?: () => { subject?: string; body: string };
  /**
   * The OTP/code value, for SMS events whose live body is BUILT by the SMS seam
   * from the code itself rather than from `render()`.
   *
   * `sendCodeViaSms` ignores the caller's message and builds
   * "Your Return4me code is <code>…" — so for those events the code is the
   * only thing that makes the SMS correct, and it has to cross the boundary.
   *
   * This is deliberately a transient dispatch parameter and NOT a field the
   * service can persist, exactly like `render()`: it is read once, at the
   * provider call, and is never written to the event row, never logged and never
   * placed in an error message. The durable row stores the rendered content in
   * neither case.
   */
  smsCode?: string;
  /**
   * REQUIRED and caller-supplied. It must be DERIVED FROM THE LOGICAL EVENT —
   * e.g. `CUSTOMER_EMAIL_ACTIVATION:CUS-123` — and never from a timestamp, a
   * random value or the current time, because those would make every call unique
   * and silently defeat deduplication. N6 builds the per-event schemes.
   */
  idempotencyKey: string;
  /** Forwarded to the provider only for gateway logging, when supplied. */
  smsLabel?: string;
  /**
   * N9 — the opaque domain identifier this notification belongs to (a claim id,
   * an item id, a customer id or an agent id).
   *
   * NOT a recipient and NOT a credential. It exists so a FAILED notification can
   * be rebuilt later from the authoritative domain record instead of this table
   * having to store an address or a rendered body. Events whose content contains
   * a one-time secret simply leave it unset: they are never retryable anyway.
   */
  businessReference?: string | null;
}

/**
 * Recipient normalization, split by channel.
 *
 * Phone uses the application's EXISTING canonicalizer (toE164Kenyan), so a
 * notification row and an OTP row for the same number cannot disagree about who
 * the recipient is. Email uses the same trim + lowercase that N3/N4 apply at
 * every registration boundary, so the durable reference for an account matches
 * the one stored on it.
 *
 * This returns the REAL address; the durable `recipient_reference` is a
 * separate, MASKED value (see recipientReferenceFor). Keeping the two apart is
 * deliberate: the real address is needed to send and is never stored, and the
 * stored reference is never used to send.
 */
function normalizeRecipient(recipient: string, channel: NotificationChannel): string {
  const trimmed = String(recipient ?? '').trim();
  if (channel === 'sms') return toE164Kenyan(trimmed);
  return trimmed.toLowerCase();
}

/**
 * The OPAQUE handle written to `recipient_reference`.
 *
 * The N2 schema is explicit that this column holds "an opaque handle (masked
 * phone / masked email / hash), never a credential", and that it exists so a
 * notification can be correlated to a recipient without the row becoming a
 * contact list. Phone reuses the app's existing masker (maskPhoneForLog) so this
 * introduces no second masking convention. Email is masked to its domain —
 * `a***@example.com` — enough to tell two recipients apart in an operator view
 * without recording a deliverable address.
 *
 * This is the ONLY recipient-derived value N5 ever writes to the database.
 */
export function recipientReferenceFor(recipient: string, channel: NotificationChannel): string {
  if (channel === 'sms') return maskPhoneForLog(recipient);
  const at = recipient.lastIndexOf('@');
  if (at <= 0) return 'email:***';
  return `${recipient.slice(0, 1)}***@${recipient.slice(at + 1)}`;
}

/**
 * Provider seams, held as overridable module state.
 *
 * They default to the real adapters. Tests replace them, which is the seam the
 * existing suites already use by mocking `EmailService.send` — this adds a
 * second, coarser seam without removing the first.
 */
let emailProvider: EmailProvider = resendEmailProvider;
let smsProvider: SmsProvider = africaTalkingSmsProvider;

/** Replaces the email adapter. Test seam; production never calls this. */
export function __setEmailProvider(provider: EmailProvider): void {
  emailProvider = provider;
}

/** Replaces the SMS adapter. Test seam; production never calls this. */
export function __setSmsProvider(provider: SmsProvider): void {
  smsProvider = provider;
}

/**
 * N9 — reads the CURRENT email provider for the retry path.
 *
 * Retry must dispatch through the SAME adapter the original dispatch used, or
 * the two could diverge in how they classify a failure. This is a read accessor
 * rather than a second injection point: `__setEmailProvider` remains the only way
 * to replace the adapter, so a test that swapped it also swaps it for retries.
 */
export function __getEmailProviderForRetry(): EmailProvider {
  return emailProvider;
}

function rejected(reason: string): NotificationResult {
  return { accepted: false, dispatched: false, eventId: null, status: 'rejected', reason };
}

/**
 * THE ENTRY POINT. `NotificationService.notify(request)`.
 *
 * The order of the checks below is itself part of the contract, and each exists
 * to stop a specific mistake:
 *
 *   1. policy lookup   — an unknown event type is refused. Nothing is sent and
 *                        nothing is stored, so a typo can never produce an
 *                        un-audited message.
 *   2. idempotency key — required and non-empty. A missing key has no defined
 *                        identity, and generating one HERE (random or timestamp)
 *                        would silently defeat deduplication, which is the entire
 *                        point of the durable table.
 *   3. recipient       — normalized, then rejected if empty. A blank recipient
 *                        is EmailService's own silent-false case; refusing it
 *                        here makes it a visible rejection instead of a no-op.
 *   4. durable event   — created BEFORE the send, never after. If the process
 *                        dies mid-send the row still exists and says so.
 *   5. duplicate       — an already-recorded key is NOT re-sent. This is
 *                        idempotent deduplication, not an error.
 *   6. provider        — delegated, and the outcome persisted.
 */
export async function notify(request: NotificationRequest): Promise<NotificationResult> {
  // 1. Policy.
  const policy = getNotificationPolicy(request?.eventType);
  if (!policy) return rejected('unknown_event_type');

  // 2. Idempotency key. Deliberately NOT defaulted.
  const idempotencyKey = String(request?.idempotencyKey ?? '').trim();
  if (!idempotencyKey) return rejected('missing_idempotency_key');
  if (idempotencyKey.length > 255) return rejected('idempotency_key_too_long');
  // N6 — the key is a DURABLE, operator-readable column. It must identify the
  // logical event and nothing else, so a credential can never come to rest in
  // it. An OTP, a pickup code, a session token or a phone number all fail this
  // test, which means a future call site cannot accidentally write one even
  // under time pressure. The canonical shape produced by
  // buildNotificationIdempotencyKey (EVENT_TYPE:ACCOUNT_ID) passes it.
  if (idempotencyKeyLooksLikeSecret(idempotencyKey)) return rejected('idempotency_key_contains_secret');

  // 3. Recipient.
  const recipient = normalizeRecipient(request.recipient ?? '', policy.channel);
  if (!recipient) return rejected('missing_recipient');

  // 4. Durable event, written BEFORE any provider call.
  let event: any;
  let inserted: boolean;
  try {
    const created = await db.createNotificationEvent({
      eventType: policy.eventType,
      channel: policy.channel,
      provider: policy.channel === 'email' ? emailProvider.name : smsProvider.name,
      idempotencyKey,
      recipientReference: recipientReferenceFor(recipient, policy.channel),
      // N9. The retry class is frozen onto the row from the catalogue, so a retry
      // reads what THIS event was, not what policy might say later.
      businessReference: request.businessReference ?? null,
      retryClass: policy.retryClass,
    });
    event = created.event;
    inserted = created.inserted;
  } catch (error) {
    // A notification with no durable record is one nobody can audit. The caller
    // is told it failed and NOTHING is sent, rather than delivering a message
    // that leaves no trace.
    console.error('[NOTIFICATION] Failed to record notification event:', error);
    return rejected('event_record_failed');
  }

  // 5. Duplicate. `inserted: false` means this exact logical notification was
  //    already recorded — by this call, or by a concurrent one that won the race.
  //
  //    N6 RETRY SEMANTICS, stated explicitly because it is a real decision and
  //    not an accident:
  //
  //    * Duplicate after a SUCCESSFUL send  -> suppressed. This is the whole
  //      point of the durable key: the same logical event is delivered once.
  //    * Duplicate after a PROVIDER FAILURE -> ALSO suppressed, and
  //      `accepted` is false so the caller can tell the difference.
  //
  //    Suppressing the failed case is deliberate, and the reason is that a retry
  //    of the SAME logical event is the caller's mistake to make. A genuine
  //    resend ("send the code again, it never arrived") is a NEW logical event
  //    — a new code, a new token — and must therefore carry a NEW idempotency
  //    key. Reusing the old key would either be suppressed (today) or, if the
  //    suppression were relaxed, would send the SAME expired code again while
  //    claiming it was a fresh one. Keeping the key honest is what stops that.
  //
  //    This is also why a caller must never derive a key from a timestamp: a
  //    timestamped key would make every "retry" unique and silently convert this
  //    guarantee into no guarantee at all.
  if (!inserted) {
    return {
      accepted: event?.status === 'sent',
      dispatched: false,
      eventId: event?.id ?? null,
      status: 'duplicate',
      reason: 'already_recorded',
    };
  }

  // N9: mark the row as DISPATCHING before the provider is called. Without this
  // a crash during dispatch leaves 'pending', which is indistinguishable from a
  // row that was never sent — and resending that would risk a duplicate.
  // Best-effort: a failure here must not block the send, and the row simply
  // stays 'pending', which recovery treats conservatively as unknown.
  await db.markNotificationEventSending(event.id);

  // 6. Render + send. The rendered body exists only inside this function.
  let rendered: { subject?: string; body: string };
  try {
    rendered = request.render ? request.render() : { body: '' };
  } catch (error) {
    const safe = sanitizeProviderError(error);
    await db.markNotificationEventFailed(event.id, 'render_failed');
    return { accepted: false, dispatched: false, eventId: event.id, status: 'failed', reason: safe };
  }

  let result: ProviderDeliveryResult;
  try {
    result =
      policy.channel === 'email'
        ? await emailProvider.send(recipient, rendered.subject ?? '', rendered.body)
        : await smsProvider.send(recipient, rendered.body, request.smsLabel, request.smsCode);
  } catch (error) {
    // A provider that THROWS is an AMBIGUOUS outcome, not a definite failure: the
    // message may already have been delivered before the transport broke. N9
    // records that honestly as 'unknown' — which is never auto-retried — rather
    // than guessing 'failed' and risking a duplicate send.
    const safe = sanitizeProviderError(error);
    await db.markNotificationEventFailedWithClass(event.id, safe, 'unknown', null);
    return { accepted: false, dispatched: true, eventId: event.id, status: 'failed', reason: safe };
  }

  if (result.accepted) {
    await db.markNotificationEventAccepted(event.id, result.providerMessageId ?? null);
    return { accepted: true, dispatched: true, eventId: event.id, status: 'sent', reason: null };
  }

  // A provider refusal. Three distinguishable cases, and conflating them would be
// the single most dangerous simplification available here:
//
//  1. `retryable_failure` AND the event is reconstructable -> schedule a retry.
//  2. `retryable_failure` but the event is NOT reconstructable (PAYMENT_RECEIVED,
//     or any secret-bearing event) -> it is DEFINITELY undelivered, but we must
//     not rebuild it, so it is terminal. Recorded as the historical 'failed'.
//  3. no class at all, or 'unknown' -> the provider answered but we cannot tell
//     whether a resend is safe. Terminal, recorded as 'unknown'.
//
// 'failed' is retained in the vocabulary specifically so pre-N9 rows and
// definite-but-unrebuildable failures keep a truthful, queryable value.
const safe = sanitizeProviderError(result.error ?? 'provider_rejected');
const failureClass = result.failureClass;
if (failureClass === 'retryable_failure' && policy.retryClass === 'reconstructable') {
  await db.markNotificationEventFailedWithClass(
    event.id, safe, 'retryable_failure', nextNotificationRetryAt(1),
  );
} else if (failureClass === 'permanent_failure') {
  await db.markNotificationEventFailedWithClass(event.id, safe, 'permanent_failure', null);
} else if (failureClass === 'unknown') {
  await db.markNotificationEventFailedWithClass(event.id, safe, 'unknown', null);
} else {
  await db.markNotificationEventFailed(event.id, safe);
}
// The CALLER contract is unchanged: a failure is still reported as
// `status: 'failed'`. Recovery is an operational concern handled out of band.
return { accepted: false, dispatched: true, eventId: event.id, status: 'failed', reason: safe };
}

/**
 * The service as an object, matching the codebase's `SomethingService` naming
 * convention (AgentMatchingService, PaymentService, EmailService). Routes may
 * import either this object or the bare `notify` function.
 */
export const NotificationService = { notify };

/**
 * N6 — does this idempotency key look like it carries a CREDENTIAL?
 *
 * The key is written to a durable, operator-readable, unencrypted column that
 * survives in backups. A key that embedded an OTP, a pickup code, a session
 * token or a phone number would therefore turn that column into a credential
 * store, and a rotation of the one secret would orphan every row that used it.
 *
 * The rules are deliberately CONSERVATIVE and shape-based, not value-based —
 * there is no way to know what a given string "means" — so they must not reject
 * legitimate keys. The canonical form `EVENT_TYPE:ACCOUNT_ID` is
 * alphanumeric-with-underscores plus a colon, which no rule below matches.
 */
export function idempotencyKeyLooksLikeSecret(key: string): boolean {
  // A credential-shaped blob: a long unbroken run of hex (an activation token,
  // a session token, a signature) or of base64url characters.
  if (/[0-9a-f]{32,}/i.test(key)) return true;
  if (/[A-Za-z0-9_-]{40,}/.test(key)) return true;

  // A Kenya phone number in any common rendering. Operators use these keys to
  // find events, and a phone number is personal data the durable record has no
  // reason to hold — the masked recipient_reference already covers that need.
  //
  // The boundaries are essential and were added after a real false positive: an
  // ordinary key like `n5-basic-1790761731999-0` contains the digit run
  // "0761731999", which a bare pattern reads as a Kenyan mobile number. A real
  // number is a STANDALONE token, so it must not be flanked by alphanumerics.
  if (/(?:^|[^0-9A-Za-z])(?:\+?254|0)[17]\d{8}(?:[^0-9]|$)/.test(key)) return true;

  // An explicit credential assignment. TWO forms, because the naive single
  // regex this replaces produced a serious false positive: `PICKUP_CODE:CLM-1`
  // is a CANONICAL event key, and its `_CODE:` segment matched a rule that read
  // any `<word>code:` as a labelled secret. So:
  //   * `name=value` anywhere is a credential assignment; and
  //   * `name:value` is only a credential assignment when `name` begins the key
  //     or follows a ':' or '|' — i.e. it is a nested field, not a SCREAMING_CASE
  //     event-type segment followed by a colon.
  if (/(?:otp|code|token|secret|password|key|pin|passcode|auth)=/i.test(key)) return true;
  if (/(?:^|[:|])(?:otp|code|token|secret|password|key|pin|passcode|auth)[:=]/i.test(key)) return true;

  return false;
}

/**
 * Builds a canonical idempotency key for an event addressed to one account.
 *
 * EXPORTED so N6 and N7 compose keys the same way instead of each call site
 * inventing a delimiter. Deliberately not timestamped and not random: the key
 * must be a pure function of WHAT the event is, so the same logical event always
 * produces the same key and deduplication works.
 *
 * The ACCOUNT id is embedded, not the recipient address, so changing a contact
 * email does not create a second logical activation event for the same account.
 */
export function buildNotificationIdempotencyKey(eventType: string, accountId: string): string {
  return `${eventType}:${String(accountId ?? '').trim()}`;
}
