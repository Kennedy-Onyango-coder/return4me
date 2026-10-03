/**
 * N7 — the ONE place a production business flow may issue an SMS.
 *
 * Every pre-N7 SMS call site used to call the Africa's Talking seam directly
 * (`sendCodeViaSms` or `AuthService.sendSms`) and had no durable record, no
 * idempotency and no cross-restart rate limit. This module does NOT introduce a
 * second notification architecture: it is a thin, typed seam over the N5
 * `NotificationService`, whose job is to make the three decisions that all six
 * migrated flows must make identically, so they cannot drift apart:
 *
 *   1. WHICH IDENTITY a notification is deduplicated by (`issuanceId`).
 *   2. WHICH SEAM carries the text (`code` builds the live body; `message` is
 *      sent verbatim) — these are genuinely different provider calls.
 *   3. THAT the code never reaches the durable row.
 *
 * Why `issuanceId` is minted rather than derived from the recipient: every
 * migrated flow is an OTP/pickup-code flow, and in each of them issuing a code
 * OVERWRITES the previous one for that recipient. Two requests for the same
 * phone number are therefore two genuinely different notifications — the second
 * code invalidates the first, and suppressing it would leave the user holding a
 * code that was never sent. Deduplication has to bind to the specific issued
 * credential, not to the recipient, or "resend" would break.
 *
 * That does not weaken the anti-abuse guarantee, because abuse of an OTP
 * endpoint is bounded by N6's rolling, durable, per-IP/per-user rate limiter at
 * the request layer — a separate concern, applied before any code is generated.
 */
import {
  buildNotificationIdempotencyKey,
  NotificationService,
  type NotificationResult,
} from './notificationService.ts';
import { generateSecureId } from './customerAuth.ts';

/**
 * A reference to ONE issued code. Deliberately an opaque, non-secret id: it
 * never contains the OTP, the phone number or any credential, so it is safe to
 * use as an idempotency-key component and safe to store.
 */
export type SmsIssuanceId = string;

export function newSmsIssuanceId(prefix: string): SmsIssuanceId {
  return generateSecureId(prefix);
}

export interface SmsNotificationInput {
  /** Typed event from the N5 catalogue; decides recipient kind and channel. */
  eventType: string;
  /** Raw phone in any rendering. Normalized inside the service, never here. */
  recipient: string;
  /**
   * Identity of THIS notification. Use the id of the row that holds the code
   * when the store already minted one (e.g. a customer-OTP row id); otherwise
   * `newSmsIssuanceId()`.
   */
  issuanceId: SmsIssuanceId;
  /**
   * For `seam: 'code'` this is the dev/sandbox console line only — the provider
   * builds the live body from the code. For `seam: 'message'` it IS the live
   * body and is sent verbatim.
   */
  message: string;
  /** The OTP / pickup code. Required for `seam: 'code'`. Never persisted. */
  code?: string;
  /** Which of the two real SMS seams to use. */
  seam: 'code' | 'message';
  /** Provider label used in logs, e.g. 'OTP'. */
  label?: string;
  /** Authenticated actor, when the flow has one, for the durable record. */
  actorUserId?: string | null;
  actorRole?: string | null;
}

/**
 * Dispatches one SMS through the N5 notification boundary.
 *
 * `accepted` is the field callers should branch on: it is true only when the
 * provider actually accepted the message. A duplicate (`status: 'duplicate'`),
 * a policy rejection and a provider failure are all `accepted: false`, so no
 * caller can accidentally tell a user that a code was sent when it was not —
 * the single most important property of this migration.
 */
export async function sendSmsNotification(input: SmsNotificationInput): Promise<NotificationResult> {
  if (input.seam === 'code' && !input.code) {
    // Reaching here means a caller believed it was sending a code and did not
    // supply one. Failing here is far safer than dispatching the live body
    // "Msimbo wako wa Return4me ni ." to a paying, real handset.
    throw new Error('sendSmsNotification: seam "code" requires a code');
  }

  const idempotencyKey = buildNotificationIdempotencyKey(input.eventType, input.issuanceId);

  return NotificationService.notify({
    eventType: input.eventType,
    recipient: input.recipient,
    idempotencyKey,
    smsLabel: input.label,
    // Transient only — read at the provider call, never written to the event
    // row. `render()` is likewise evaluated inside the service and discarded.
    ...(input.seam === 'code' ? { smsCode: input.code } : {}),
    render: () => ({ body: input.message }),
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    ...(input.actorRole ? { actorRole: input.actorRole } : {}),
  });
}