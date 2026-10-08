// =============================================================================
// N5 — PROVIDER ABSTRACTION (email and SMS).
//
// WHY THIS EXISTS
//   The application has two working providers — Resend for email (services/email.ts)
//   and Africa's Talking for SMS (services/auth.ts sendCodeViaSms) — and both
//   work today. N5 does NOT replace them, reconfigure them, or change how they
//   fail. What they lack is a NEUTRAL interface: the notification service would
//   otherwise need to know that email is a boolean-returning `EmailService.send`
//   and SMS is a `{success, message}` object, and every future channel would add
//   another branch.
//
//   These two interfaces are that seam. They are deliberately the NARROWEST
//   possible shape:
//
//   * `accepted`, never `delivered`. Neither provider can prove handset or inbox
//     delivery, and the N2 schema's own comment says the same about `sent_at`.
//     Naming it `accepted` makes it impossible for a caller to believe
//     otherwise.
//   * `providerMessageId` when the provider returns one, null otherwise.
//   * NO raw provider response object. Resend's error payload and Africa's
//     Talking's status codes are provider implementation detail; letting one
//     escape into a durable row or a log is how provider internals start leaking
//     into operator tooling. A short, already-sanitised `error` string is the
//     whole contract.
//
// WHAT IS DELIBERATELY PRESERVED
//   The two concrete adapters below call the EXACT existing functions, so every
//   production safety guard in them still runs unchanged — the fail-closed
//   behaviour when RESEND_API_KEY is missing in production, and the
//   simulation-vs-live branch in sendCodeViaSms. N5 adds a seam; it does not
//   become a second delivery path.
// =============================================================================

import { EmailService } from './email.ts';
import { AuthService, sendCodeViaSms, SMS_UNAVAILABLE_MESSAGE } from './auth.ts';

/** What a provider can actually tell us, and no more. */
export interface ProviderDeliveryResult {
  /**
   * The provider ACCEPTED the message for delivery. This is NOT proof the
   * recipient received it.
   */
  accepted: boolean;
  /** The provider's own handle, for traceability. Null when it offers none. */
  providerMessageId?: string | null;
  /**
   * N9 — WHAT KIND of failure this is, which is a different question from
   * whether it failed at all.
   *
   *   retryable_failure  the provider gave a DEFINITE transient refusal (outage,
   *                      5xx, throttling). A later attempt can plausibly succeed.
   *   permanent_failure  the provider gave a DEFINITE refusal that will never
   *                      succeed (invalid recipient, malformed content).
   *   unknown            the outcome cannot be established — a thrown transport
   *                      error, or a crash between dispatch and the durable
   *                      update. NEVER auto-retried: the message may already have
   *                      been delivered, and resending could duplicate it.
   *
   * Null when `accepted` is true. This is deliberately carried as an enum rather
   * than inferred from error TEXT, because message wording is not a contract.
   */
  failureClass?: 'retryable_failure' | 'permanent_failure' | 'unknown';
  /**
   * A short, already-safe description for an operator. Never a provider
   * response object, never a stack trace, never anything containing a secret or
   * a credential.
   */
  error?: string | null;
}

export interface EmailProvider {
  readonly name: string;
  send(to: string, subject: string, html: string): Promise<ProviderDeliveryResult>;
}

export interface SmsProvider {
  readonly name: string;
  /**
   * `code` is a first-class parameter, and omitting it would silently corrupt
   * every OTP message.
   *
   * The platform has TWO genuine SMS seams and they build their live body
   * differently:
   *
   *   code present  -> sendCodeViaSms(), which builds the live body ITSELF from
   *                    the code ("Your Return4me code is <code>…"). The
   *                    caller's `message` is only a dev/sandbox log line.
   *   code absent   -> AuthService.sendSms(), which sends `message` verbatim as
   *                    the live body. Used by the pickup-code notification,
   *                    whose text is a full sentence rather than a bare code.
   *
   * N5's original adapter hard-coded `code: ''`, which is correct only for the
   * second seam. Routing a code-bearing OTP through it would have produced a
   * live SMS reading "Your Return4me code is." — an SMS that costs money,
   * is accepted by the provider, and reaches the handset with no code in it.
   * The distinction has to be carried across the boundary, not guessed at.
   */
  send(phone: string, message: string, label?: string, code?: string): Promise<ProviderDeliveryResult>;
}

/**
 * A SAFE, BOUNDED description of a failure.
 *
 * Length-capped and stripped of anything token-shaped on purpose. A provider
 * exception can carry a request body, and for these providers that body can
 * contain a recipient, a subject line or — for an activation email — a live
 * activation link. `last_error` is a durable column an operator can read for
 * years, so it must not become a place a credential comes to rest.
 */
export function sanitizeProviderError(error: unknown): string {
  let text: string;
  if (error instanceof Error) text = error.message;
  else if (typeof error === 'string') text = error;
  // Never JSON.stringify an unknown object: it can hold an API key.
  else text = 'provider_error';

  // Remove anything that looks like a credential in a URL query, then cap the
  // length so `last_error` cannot become an unbounded payload store.
  const redacted = text.replace(
    /([?&](?:token|code|otp|key|secret|api_key|password)=)[^&\s"']+/gi,
    '$1[redacted]'
  );
  return redacted.slice(0, 200);
}

// -----------------------------------------------------------------------------
// ADAPTER: EMAIL -> the existing EmailService.
//
// N9 uses `sendWithId` so the Resend message id survives into
// notification_events.provider_message_id — the only evidence that could later
// resolve an ambiguous send via the Resend lookup API. `EmailService.send`
// remains `Promise<boolean>` for every other consumer, untouched.
// -----------------------------------------------------------------------------

/**
 * N9 — classify an email provider failure.
 *
 * Only the Resend STATUS CODE is treated as a contract, never the message text:
 * 5xx (and 429) are the provider saying "try later", 4xx are it saying "this will
 * never work". A transport-level throw is genuinely unknown — the request may
 * have been accepted before the socket died.
 */
export function classifyEmailFailure(providerError: unknown): 'retryable_failure' | 'permanent_failure' | 'unknown' {
  if (!providerError) return 'unknown';
  const statusCode = (providerError as any)?.statusCode;
  if (typeof statusCode === 'number') {
    if (statusCode >= 500 || statusCode === 429) return 'retryable_failure';
    if (statusCode >= 400) return 'permanent_failure';
  }
  // A thrown transport error, or an error shape we do not recognise.
  return 'unknown';
}

export const resendEmailProvider: EmailProvider = {
  name: 'resend',
  async send(to, subject, html): Promise<ProviderDeliveryResult> {
    // A blank recipient is EmailService's own contract, so it is passed through
    // rather than re-implemented here.
    const result = await EmailService.sendWithId(to, subject, html);
    if (result.accepted) {
      return {
        accepted: true,
        // Previously hard-coded null. The id was available all along and was only
        // being logged; capturing it is what makes an ambiguous email
        // reconcilable after the fact.
        providerMessageId: result.providerMessageId ?? null,
        error: null,
      };
    }
    // A blank recipient can never succeed, whatever the provider says.
    if (!to || to.trim() === '') {
      return { accepted: false, providerMessageId: null, error: 'missing_recipient', failureClass: 'permanent_failure' };
    }
    const failureClass = classifyEmailFailure(result.providerError);
    return {
      accepted: false,
      providerMessageId: null,
      error: failureClass === 'unknown' ? 'email_provider_outcome_unknown' : 'email_provider_rejected',
      failureClass,
    };
  },
};

// -----------------------------------------------------------------------------
// ADAPTER: SMS -> the existing sendCodeViaSms.
//
// The signature difference is handled here and nowhere else. sendCodeViaSms takes
// a `label` used in its own gateway logging; the notification vocabulary already
// has a canonical event type, so the caller's own label is passed through when
// supplied, keeping today's gateway log output byte-identical for every existing
// call site.
//
// CALL SITES ARE NOT MIGRATED IN N5. N7 owns the SMS migration; N6 owns SMS
// idempotency and rate limiting. This adapter exists so the service boundary is
// complete and N7 has a seam to migrate onto.
// -----------------------------------------------------------------------------

/**
 * N9 — classify an SMS failure.
 *
 * Africa's Talking exposes NO message-status lookup in the installed SDK
 * (node_modules/africastalking/lib/sms.js offers `send` and nothing else) and
 * this application implements no delivery-report webhook. So a SMS outcome that
 * is not an explicit acceptance can never be independently confirmed, and the
 * honest classification is:
 *
 *   retryable_failure  only when the gateway itself reports a DEFINITE, transient
 *                      refusal (it is not deliverable right now — e.g. SMS not
 *                      enabled, provider rejected the request up front). That
 *                      means the message was definitely NOT accepted.
 *   unknown            every other non-acceptance, including a transport throw.
 *                      The request may have reached the provider before the
 *                      failure, so it may already have been delivered.
 *
 * `unknown` is never automatically retried. That conservatism is the whole point:
 * with no status lookup there is no way to know whether a user already received
 * the OTP, and a duplicate OTP message is a worse outcome than a missing one.
 */
export function classifySmsFailure(message: string | undefined): 'retryable_failure' | 'permanent_failure' | 'unknown' {
  // The gateway's own "not deliverable in this configuration" refusal is
  // definitive: nothing was sent, and it can be resolved by fixing configuration.
  if (message && message === SMS_UNAVAILABLE_MESSAGE) return 'retryable_failure';
  return 'unknown';
}

export const africaTalkingSmsProvider: SmsProvider = {
  name: 'africas_talking',
  async send(phone, message, label = 'R4M', code): Promise<ProviderDeliveryResult> {
    if (code) {
      // The CODE seam. sendCodeViaSms builds the live body from `code` and uses
      // `message` only for the dev/sandbox console line — exactly the behaviour
      // every pre-N7 caller relied on, so the live SMS text is unchanged by the
      // migration.
      const result = await sendCodeViaSms(phone, code, label, message);
      return {
        accepted: result.success,
        providerMessageId: null,
        // sendCodeViaSms already returns a safe, generic message on failure
        // (see its own P1 fix); it is still bounded here because this is a
        // durable column, not a response body.
        error: result.success ? null : sanitizeProviderError(result.message),
        failureClass: result.success ? undefined : classifySmsFailure(result.message),
      };
    }

    // The MESSAGE seam, used by notifications whose text is a full sentence
    // rather than a bare code. Kept as a separate call rather than a flag on
    // the other, because the two have different simulation logs and different
    // failure behaviour and must both stay exactly as they were before N7.
    const delivered = await AuthService.sendSms(phone, message);
    return {
      accepted: delivered,
      providerMessageId: null,
      error: delivered ? null : 'sms_provider_rejected',
      // AuthService.sendSms reports only a boolean, so nothing about the outcome
      // can be established: it is unknown, and therefore never auto-retryable.
      failureClass: delivered ? undefined : 'unknown',
    };
  },
};
