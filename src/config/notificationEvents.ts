// =============================================================================
// N5 — CANONICAL NOTIFICATION EVENT VOCABULARY AND POLICY.
//
// WHY THIS FILE EXISTS
//   Before N5, notification decisions were scattered string literals across
//   routes: `EmailService.sendPaymentReceivedEmail(...)`, `sendCodeViaSms(...,
//   'CLAIM OTP', ...)`, `AuthService.sendSms(...)`. Each call site decided its
//   own channel, its own recipient shape and its own error handling, and NONE of
//   them recorded that a notification had happened at all — the N2
//   `notification_events` table existed with no production writer anywhere in
//   the codebase.
//
//   This file is the single place an event is NAMED and its CHANNEL decided.
//   It is deliberately PURE: no imports from db, email, auth or express, so it
//   is unit-testable without a database, a provider or a socket. The service
//   (services/notificationService.ts) consults it; routes never duplicate it.
//
// SOURCE-DERIVED, NOT INVENTED
//   Every event below corresponds to a notification call site that EXISTS in
//   the current source. The audit that produced this list is recorded on each
//   entry as `origin`, so a future reader can verify the claim rather than trust
//   it. Where the N5 brief suggested an event the application does not actually
//   emit, it is NOT defined here — see ABSENT_EVENTS at the bottom, which is as
//   much a part of this file as the vocabulary itself.
// =============================================================================

/** The two channels the N2 schema constrains. Not extensible without N2. */
export type NotificationChannel = 'sms' | 'email';

/**
 * Delivery urgency, derived from what the RECIPIENT must do next, not from how
 * the message is styled.
 *
 *   urgent        — the human is standing at a counter and blocked until this
 *                   arrives (a code they must read out). SMS only, because it
 *                   is the only channel read in seconds in the field.
 *   transactional — asynchronous, asset-heavy, or read at a desk. Email only.
 */
export type NotificationPriority = 'urgent' | 'transactional';

/**
 * What the recipient is, for an operator reading a notification_events row.
 * Purely descriptive — it is NOT a routing input and never looks up an address.
 */
export type NotificationRecipientKind =
  | 'customer'
  | 'agent'
  | 'owner'
  | 'finder'
  | 'admin';

/** Which stage of the programme owns actually ROUTING this event. */
export type NotificationMigrationStage = 'N5' | 'N6' | 'N7' | 'N8' | 'N9';

/**
 * N9 — whether a FAILED delivery of this event may be retried later.
 *
 * The distinction is not about importance; it is about whether the message can
 * be rebuilt. Every secret-bearing notification is 'not_retryable' for one
 * concrete reason: its one-time secret (an OTP, a pickup code, an activation
 * token) is persisted ONLY as a hash, so the exact message that failed cannot be
 * reproduced, and minting a replacement would invalidate a code the user may be
 * mid-way through typing. That is a security decision, not a scheduling one.
 */
export type NotificationRetryClass = 'reconstructable' | 'not_retryable';

export interface NotificationEventDefinition {
  readonly eventType: string;
  readonly channel: NotificationChannel;
  readonly priority: NotificationPriority;
  readonly recipientKind: NotificationRecipientKind;
  /** Stable template identifier. No message body is stored in the event row. */
  readonly templateId: string;
  /**
   * N9 retry policy. 'reconstructable' events are the ONLY ones a retry worker
   * may ever dispatch; every other event is refused, server-side, regardless of
   * who asks.
   */
  readonly retryClass: NotificationRetryClass;
  /**
   * Where the event is DELIVERED FROM TODAY. N5 routes only the two account
   * activation events; everything else is defined here so the vocabulary is
   * complete and testable, while the call site stays exactly as it is.
   */
  readonly stage: NotificationMigrationStage;
  /**
   * The current production call site(s) as of the N5 audit. Retained so the
   * "defined but not yet routed" state is auditable rather than a claim.
   */
  readonly origin: string;
}

// -----------------------------------------------------------------------------
// ACCOUNT LIFECYCLE — transactional email.
//
// Both were introduced by N3/N4 and are the only events N5 actually routes
// (stage: 'N5'). They are here because the brief identifies them as the
// account-lifecycle notification class, and because routing them proves the
// service boundary on the one class of message where getting it wrong has
// security consequences.
// -----------------------------------------------------------------------------
const EVENT_DEFINITIONS: readonly NotificationEventDefinition[] = [
  {
    eventType: 'CUSTOMER_EMAIL_ACTIVATION',
    channel: 'email',
    priority: 'transactional',
    recipientKind: 'customer',
    templateId: 'customer_email_activation',
    retryClass: 'not_retryable',
    stage: 'N5',
    origin: 'server.ts POST /api/customer/register (N3)',
  },
  {
    eventType: 'AGENT_EMAIL_ACTIVATION',
    channel: 'email',
    priority: 'transactional',
    recipientKind: 'agent',
    templateId: 'agent_email_activation',
    retryClass: 'not_retryable',
    stage: 'N5',
    origin: 'server.ts POST /api/auth/verify-otp agent branch (N4)',
  },
  // ---------------------------------------------------------------------------
  // HIGH-URGENCY COUNTER INTERACTIONS — SMS.
  //
  // Each is a code a person must READ ALOUD or type within minutes. N1's routing
  // decision reserved SMS for exactly this class, and none may be moved to email
  // in N5: N7 owns that migration, N6 owns their idempotency and rate limiting.
  // ---------------------------------------------------------------------------
  {
    eventType: 'PHONE_VERIFICATION_OTP',
    channel: 'sms',
    priority: 'urgent',
    recipientKind: 'customer',
    templateId: 'phone_verification_otp',
    retryClass: 'not_retryable',
    stage: 'N7',
    // N10-C RECONCILIATION. This annotation previously read
    // `services/auth.ts AuthService.requestOTP (pre-existing)`, which the live
    // call graph does not support. auth.ts never emits this event type: its
    // requestOTP transport is INJECTED by its only production caller, and that
    // caller (server.ts POST /api/auth/request-otp) injects an `AGENT_LOGIN_OTP`
    // dispatcher. The single live emitter of PHONE_VERIFICATION_OTP is the
    // customer identity-change seam in server.ts, which is where a customer
    // re-verifies a NEW phone number on their own account.
    origin: 'server.ts customer identity-change sendVerificationCode (POST /api/customer/profile/identity, kind=phone)',
  },
  {
    eventType: 'CUSTOMER_LOGIN_OTP',
    channel: 'sms',
    priority: 'urgent',
    recipientKind: 'customer',
    templateId: 'customer_login_otp',
    retryClass: 'not_retryable',
    stage: 'N7',
    origin: 'server.ts POST /api/customer/login (N3, pre-existing send)',
  },
  {
    eventType: 'AGENT_LOGIN_OTP',
    channel: 'sms',
    priority: 'urgent',
    recipientKind: 'agent',
    templateId: 'agent_login_otp',
    retryClass: 'not_retryable',
    stage: 'N7',
    origin: 'server.ts POST /api/auth/request-otp (pre-existing)',
  },
  {
    eventType: 'OWNER_CLAIM_VERIFICATION_CODE',
    channel: 'sms',
    priority: 'urgent',
    recipientKind: 'owner',
    templateId: 'owner_claim_verification_code',
    retryClass: 'not_retryable',
    stage: 'N7',
    origin: 'routes/claims.ts claim OTP resend (pre-existing)',
  },
  {
    eventType: 'PICKUP_CODE',
    channel: 'sms',
    priority: 'urgent',
    recipientKind: 'owner',
    templateId: 'pickup_code',
    retryClass: 'not_retryable',
    stage: 'N7',
    origin: 'routes/customerClaims.ts + server.ts payment webhook (pre-existing)',
  },
  {
    eventType: 'CLAIM_LINK_OTP',
    channel: 'sms',
    priority: 'urgent',
    recipientKind: 'customer',
    templateId: 'claim_link_otp',
    retryClass: 'not_retryable',
    stage: 'N7',
    origin: 'routes/customerClaims.ts claim-link OTP (pre-existing)',
  },
  // ---------------------------------------------------------------------------
  // TRANSACTIONAL EMAIL — asset-heavy, asynchronous, read at a desk.
  //
  // Defined but NOT routed by N5. These are the events N8 migrates; the channel
  // decision is recorded now so it exists in exactly one place BEFORE any call
  // site is touched.
  // ---------------------------------------------------------------------------
  {
    eventType: 'PAYMENT_RECEIVED',
    channel: 'email',
    priority: 'transactional',
    recipientKind: 'owner',
    templateId: 'payment_received',
    retryClass: 'not_retryable',
    stage: 'N8',
    origin: 'server.ts payment webhook EmailService.sendPaymentReceivedEmail (pre-existing)',
  },
  {
    eventType: 'AGENT_PAYMENT_CONFIRMED',
    channel: 'email',
    priority: 'transactional',
    recipientKind: 'agent',
    templateId: 'agent_payment_confirmed',
    retryClass: 'reconstructable',
    stage: 'N8',
    origin: 'server.ts payment webhook EmailService.sendAgentPaymentConfirmedEmail (pre-existing)',
  },
  {
    eventType: 'ITEM_HANDED_OVER',
    channel: 'email',
    priority: 'transactional',
    recipientKind: 'owner',
    templateId: 'item_handed_over',
    retryClass: 'reconstructable',
    stage: 'N8',
    origin: 'routes/agentOps.ts confirm-handover sendItemHandedOverEmail (pre-existing)',
  },
  {
    eventType: 'FINDER_ITEM_COLLECTED',
    channel: 'email',
    priority: 'transactional',
    recipientKind: 'finder',
    templateId: 'finder_item_collected',
    retryClass: 'reconstructable',
    stage: 'N8',
    origin: 'routes/agentOps.ts confirm-handover sendFinderItemCollectedEmail (pre-existing)',
  },
  {
    eventType: 'ADMIN_TRANSACTION_LOG',
    channel: 'email',
    priority: 'transactional',
    recipientKind: 'admin',
    templateId: 'admin_transaction_log',
    retryClass: 'reconstructable',
    stage: 'N8',
    origin: 'server.ts webhook + routes/agentOps.ts sendAdminTransactionLogEmail (pre-existing)',
  },
  {
    eventType: 'ADMIN_REASSIGNMENT',
    channel: 'email',
    priority: 'transactional',
    recipientKind: 'admin',
    templateId: 'admin_reassignment',
    retryClass: 'reconstructable',
    stage: 'N8',
    origin: 'routes/finderReport.ts sendAdminNewReassignmentRequestEmail (pre-existing)',
  },
];

// -----------------------------------------------------------------------------
// THE POLICY
//
// A lookup table built once at module load, not a `switch`. That matters for one
// specific reason: it makes the vocabulary CLOSED at the type level, so a typo
// in an event type is a compile error or a rejected request rather than a
// notification that is silently sent with no event record.
// -----------------------------------------------------------------------------
const EVENT_BY_TYPE: ReadonlyMap<string, NotificationEventDefinition> = new Map(
  EVENT_DEFINITIONS.map((definition) => [definition.eventType, definition])
);

/** Every event type the system recognises, in declaration order. */
export const NOTIFICATION_EVENT_TYPES: readonly string[] = EVENT_DEFINITIONS.map(
  (definition) => definition.eventType
);

/**
 * THE POLICY LOOKUP. Answers "given this event, which channel is permitted?"
 * and returns null for anything not in the vocabulary.
 *
 * It returns the definition, not a boolean, so the service can also read the
 * priority, recipient kind and template id without a second lookup — and so a
 * caller cannot accidentally consult a DIFFERENT source for the channel than
 * the one that validated the event.
 *
 * It sends nothing. Policy is a decision; delivery is the service's job.
 */
export function getNotificationPolicy(eventType: string): NotificationEventDefinition | null {
  if (typeof eventType !== 'string' || eventType === '') return null;
  return EVENT_BY_TYPE.get(eventType) ?? null;
}

/** Type guard: is this a known event type? */
export function isKnownNotificationEvent(eventType: unknown): eventType is string {
  return typeof eventType === 'string' && EVENT_BY_TYPE.has(eventType);
}

/**
 * The channel a given event is PERMITTED to use. A convenience wrapper for
 * callers that only need the routing decision.
 */
export function getPermittedChannel(eventType: string): NotificationChannel | null {
  return getNotificationPolicy(eventType)?.channel ?? null;
}

// -----------------------------------------------------------------------------
// EVENTS THE BRIEF SUGGESTED THAT THE SOURCE DOES NOT SUPPORT.
//
// Recording these is as important as recording the ones that exist. Each was
// checked against the current codebase and NOT defined, because defining an
// event with no trigger would create vocabulary that reads as supported but can
// never fire — the exact "invented event" failure the N5 brief forbids.
//
//   ITEM_REPORTED           no notification is emitted when a found item is
//                           reported; the finder already holds the item and has
//                           nothing to be told. Any future "your report is live"
//                           message would be a NEW product decision.
//   CLAIM_STATUS_UPDATED    the claim status surface is a dashboard the user
//                           polls; there is no outbound status email today.
//   EVIDENCE_UPLOADED       evidence is stored and shown in-app only.
//   FINAL_RECEIPT           there is no final legal/financial receipt message.
//   PAYMENT_REDIRECT_LINK   the M-Pesa STK push is issued by the payment
//                           provider itself, not by this application, so there
//                           is no link for us to send.
//   FINDER_DROPOFF_CODE     this DOES exist as a concept but is delivered
//                           in PERSON at the counter (the agent reads the code
//                           to the owner); it is not an outbound message, so it
//                           is deliberately absent rather than modelled as SMS.
//
// Should any of these become real, they are added HERE with an `origin` — not
// at the call site.
// -----------------------------------------------------------------------------
export const ABSENT_EVENTS: readonly string[] = [
  'ITEM_REPORTED',
  'CLAIM_STATUS_UPDATED',
  'EVIDENCE_UPLOADED',
  'FINAL_RECEIPT',
  'PAYMENT_REDIRECT_LINK',
  'FINDER_DROPOFF_CODE',
];
