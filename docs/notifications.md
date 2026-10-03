# Notifications

Return4me sends two kinds of message: SMS, for codes a person must read out at
a counter, and email, for asynchronous transactional notices. Every message is
recorded in `notification_events` before and after dispatch, and every failure is
classified so that only messages which can be safely rebuilt are ever retried.

This document describes the implemented system. Where a behaviour is deliberately
absent, that is stated rather than left to be inferred.

## Event catalogue

`src/config/notificationEvents.ts` is the single source of truth. It is a pure
module with no database, provider, or Express dependency, so the vocabulary is
unit-testable in isolation. Routes never decide a channel themselves; they name
an event and the policy decides.

An event type outside this catalogue is refused. That is deliberate: an
undefined event must be a rejected request rather than a message sent with no
durable record.

| Event | Channel | Priority | Recipient | Retry class |
|---|---|---|---|---|
| `CUSTOMER_EMAIL_ACTIVATION` | email | transactional | customer | not retryable |
| `AGENT_EMAIL_ACTIVATION` | email | transactional | agent | not retryable |
| `PHONE_VERIFICATION_OTP` | sms | urgent | customer | not retryable |
| `CUSTOMER_LOGIN_OTP` | sms | urgent | customer | not retryable |
| `AGENT_LOGIN_OTP` | sms | urgent | agent | not retryable |
| `OWNER_CLAIM_VERIFICATION_CODE` | sms | urgent | owner | not retryable |
| `PICKUP_CODE` | sms | urgent | owner | not retryable |
| `CLAIM_LINK_OTP` | sms | urgent | customer | not retryable |
| `PAYMENT_RECEIVED` | email | transactional | owner | not retryable |
| `AGENT_PAYMENT_CONFIRMED` | email | transactional | agent | retryable |
| `ITEM_HANDED_OVER` | email | transactional | owner | retryable |
| `FINDER_ITEM_COLLECTED` | email | transactional | finder | retryable |
| `ADMIN_TRANSACTION_LOG` | email | transactional | admin | retryable |
| `ADMIN_REASSIGNMENT` | email | transactional | admin | retryable |

Priority describes what the recipient must do next, not how the message is
styled. `urgent` means the human is blocked until the message arrives, which is
why it is SMS only.

The module also records, in `ABSENT_EVENTS`, events that were considered and
deliberately not defined because the application does not emit them. Defining an
event with no trigger would create vocabulary that reads as supported but can
never fire. `FINDER_DROPOFF_CODE` is in that list because the code exists but is
read aloud in person at the counter, not sent.

## Dispatch

`NotificationService.notify()` in `src/services/notificationService.ts`:

1. Validates the event type against the catalogue. Unknown types are refused.
2. Builds an idempotency key from the event type and the account reference.
3. Returns early if a row already exists for that key, before rendering and

## Provider boundary

Providers are reached through `src/services/notificationProviders.ts`, which
returns a structured result rather than throwing into route handlers:

- a definite acceptance,
- a definite failure carrying a classification, or
- an ambiguous outcome.

Provider error text is sanitized before it is stored or logged, so provider
responses do not end up verbatim in the `last_error` column.

### Acceptance is not delivery

`sent_at` on a notification row records that the **provider accepted the
request**. It is not a delivery receipt. Neither Africa's Talking nor Resend
returns per-recipient delivery confirmation through this integration, so the
system has no basis on which to claim a message reached a handset or an inbox.

Anything downstream of the provider — a code the owner is waiting on, a payment
confirmation — should be read as "the provider accepted this", not "the
recipient has it". An operator seeing a `sent` row knows the message was
handed off and nothing more.

### Ambiguous outcomes

Some failures cannot be classified. A network timeout after the provider may
already have accepted the message is the canonical case: retrying could
double-send a code, and not retrying could drop it. These outcomes are recorded
as `unknown`, which is terminal and never automatically retried, because guessing
wrong is worse than losing a message that an operator can resend manually.

## Idempotency and recipient handling

Idempotency is enforced by a unique index on
`notification_events.idempotency_key`, not by application-level
check-then-insert. Two concurrent requests carrying the same key produce one row;
the second loses at the database rather than in a race between two application
instances.

Recipients are referenced, not embedded. A row stores a `recipient_reference`
pointing at the authoritative domain record, not a rendered address. Phone
numbers are normalized to E.164 Kenyan format before use, so the same person
cannot consume two rate-limit slots by writing their number two ways.

## SMS rate limiting

`src/services/smsRateLimit.ts` enforces a limit of **3 SMS per 10 minutes**, a
true rolling window backed by the `sms_rate_limit_buckets` table.

A table is used rather than `express-rate-limit`'s default in-process store

## Retry

Retry lives in `src/services/notificationRetry.ts`, deliberately separate from
the dispatch path.

### What retry does

It re-renders and re-dispatches a message. Recipient and content are both
re-derived from the authoritative domain record at retry time, so neither a
plaintext address nor a rendered body is ever persisted or logged to enable it.

### What retry does not do

It never re-runs the business transaction that produced the notification. No
payment confirmation, no handover settlement, no claim transition, no
reassignment. Those already happened and are already guarded by their own
compare-and-swap claims. Re-running one because an email failed is precisely the
duplication those CAS updates exist to prevent.

### Retry eligibility

Exactly five events are retryable:

- `AGENT_PAYMENT_CONFIRMED`
- `ITEM_HANDED_OVER`
- `FINDER_ITEM_COLLECTED`
- `ADMIN_TRANSACTION_LOG`
- `ADMIN_REASSIGNMENT`

This is a closed, statically typed allow-list. A request for any other event is
refused before any database or provider call, regardless of who asks.

The nine non-retryable events are non-retryable for one concrete reason: their
one-time secret — an OTP, a pickup code, an activation token — is persisted only
as a hash, so the exact message that failed cannot be reproduced. Minting a
replacement would invalidate a code the user may be mid-way through typing.
That is a security decision, not a scheduling one.

`PAYMENT_RECEIVED` is the sharpest case and has its own refusal constant. It is
the most operationally important email in the product and is still not retryable,
because the pickup code it exists to deliver is stored only as a hash.
Regenerating that code is out of scope: it would invalidate a code the owner is
on their way to use.

### Retry policy

From `src/config/notificationRetryPolicy.ts`:

| Parameter | Value |
|---|---|
| First retry delay | 5 minutes |
| Growth factor | 4× |
| Maximum single delay | 24 hours |
| Maximum attempts | 5 |
| Sweep batch size | 25 |

The resulting schedule is approximately 5 minutes, 20 minutes, 80 minutes,
5 hours 20 minutes, then 21 hours 20 minutes. Once the budget is exhausted the row
becomes `permanent_failure` with `next_attempt_at` cleared.

These values are notification-specific and are deliberately not inherited from
the social-publication retry sweep. An email arriving hours late to an owner
waiting on a handover confirmation is close to worthless, so the cap is tight and
the budget is finite.

The delay exponent is clamped before use, so a corrupted counter in the database
cannot produce an `Infinity` or `NaN` timestamp that would then be persisted and

## Administrative handling

Two administrator endpoints:

- `GET /api/admin/notifications` — the failure console. Lists notification
  events with their status, class, attempt counts, and last error, so an
  operator can find messages that did not reach their provider.
- `POST /api/admin/notifications/:id/retry` — dispatches a single row. The row
  must be a retryable event type; anything else is refused with the same
  constant the automatic path uses. The original idempotency key is left
  untouched, so a manual retry does not consume the key that suppresses
  duplicates.

Both require a full `admin` session. See [authentication.md](authentication.md).

## Activation email behaviour

Customer and agent activation are the two events routed through the service, and
they are the class where a mistake has security consequences.

Both activation tokens are 32-byte values from `crypto.randomBytes`, persisted
only as a hash, and valid for 24 hours. Because the token is stored only as a
hash, the activation email is not retryable.

If the activation email cannot be sent, the endpoint returns **503** rather than
reporting a successful registration. An account whose activation email was
silently dropped is worse than a visible failure, because the user waits for a
message that will never arrive. There is no activation resend endpoint;
`ALLOW_MOCK_OTP_BYPASS` does not cover activation.

Activation link construction reads `PUBLIC_APP_URL` and falls back to
`http://localhost:3000` when it is unset. See [configuration.md](configuration.md)
for the operational consequence.

## Security model

- No provider credential is ever persisted, logged, or written into a
  notification row.
- No rendered message body is persisted. A retry re-derives content from the
  domain record, so the durable row contains neither the address nor the text.
- No one-time secret is persisted in plaintext, which is what makes those events
  non-retryable.
- Recipient addresses are referenced, not copied, so an address change is
  reflected on a retry rather than frozen at first dispatch.
- Error text from providers is sanitized before storage.

## Known limitations

- Provider acceptance is not delivery confirmation, and the integration returns
  no delivery receipts. See above.
- The durable SMS rate limit is keyed per identity per request. Two different
  send paths that resolve the same phone number to different identity keys are
  not reconciled against a single shared budget.
- `PHONE_VERIFICATION_OTP` is dispatched through the pre-existing
  `AuthService.requestOTP` path rather than the notification service, so it does
  not produce a `notification_events` row. Its dispatch is therefore not
  reconciled against the durable notification record.

Neither of the last two is resolved in the current code. They are recorded here
so that the notification system is not read as covering more than it does.

## Related

- [architecture.md](architecture.md) — where the notification boundary sits
- [database.md](database.md) — the `notification_events` constraints
- [operations.md](operations.md) — the retry sweep and failure console
- [authentication.md](authentication.md) — activation and OTP flows
- [configuration.md](configuration.md) — SMS and email configuration

break the sweep's date comparison.

### Concurrency

The sweep claims rows with a compare-and-swap update, not a read-then-write
select. Without it, two instances running the sweep would claim the same rows and
send duplicates. See [operations.md](operations.md).

## Notification events table

`notification_events` columns that carry behaviour:

| Column | Purpose |
|---|---|
| `event_type`, `channel` | What was sent and over which channel; constrained by a `CHECK` to the known vocabulary |
| `idempotency_key` | Unique; the duplicate-suppression mechanism |
| `recipient_reference` | Pointer to the authoritative record, never a rendered address |
| `status` | Lifecycle state, constrained by a `CHECK` |
| `provider_message_id` | The provider's own identifier, captured for support and reconciliation |
| `attempt_count` | Successful provider acceptances. **Not** the retry counter |
| `retry_attempt_count` | Retry attempts made |
| `next_attempt_at` | When the sweep should next consider this row |
| `business_reference` | The claim, item, or order the notification is about, used to re-derive content on retry |
| `last_error` | Sanitized provider error text |

`attempt_count` is not repurposed for retries. It has always meant successful
acceptances, and silently redefining it would make historical values ambiguous.

The `status` vocabulary is: `pending`, `sending`, `sent`, `failed`,
`retryable_failure`, `permanent_failure`, `unknown`, `cancelled`,
`fallback_available`, `fallback_requested`, `fallback_sent`. `failed` is retained
so pre-existing rows stay valid; it means "failed before the retry work existed"
and is treated as terminal. The `fallback_*` states are retained for schema
compatibility and are unused: no provider or channel fallback is implemented.

because the default store is a process-local `Map`. That is acceptable for
generic abuse throttling, but it is not a production guarantee for SMS: a
restart empties it, and N instances behind a load balancer each hold a private
counter, so the effective limit becomes 3 × N and a rolling restart grants a
fresh budget.

Bucket keys are a salted hash of the identity, never a raw IP address, user ID,
or phone number, and the `ip` and `user` namespaces are disjoint. A row
therefore supports abuse investigation without turning the table into a log of
who requested what from where. The salt comes from `DOC_HASH_SALT`, falling back
to `JWT_SECRET`, so the salt must be set in production for the bucket keys to be
stable across restarts and instances.

Requests are limited against every identity that can be resolved for them, and
all of those buckets must permit the send.

## Failure classification

Every failure is recorded as exactly one of three classes.

| Class | Meaning | Outcome |
|---|---|---|
| `retryable_failure` | The provider definitively refused, and a resend could succeed | Scheduled for retry if the event is retryable |
| `permanent_failure` | The provider definitively refused, and a resend cannot succeed | Terminal |
| `unknown` | The outcome cannot be determined | Terminal, never auto-retried |

`retryable_failure` only schedules a retry when **both** conditions hold: the
provider failure was retryable, **and** the event's `retryClass` is
`reconstructable`. A retryable provider failure on a non-reconstructable event
is recorded as a terminal `permanent_failure`, because the message cannot be
rebuilt.

   before any provider call. This is what makes duplicate suppression correct
   when a request is retried by a client or a route.
4. Inserts the `notification_events` row and dispatches through the provider
   boundary.
5. Records the outcome, including the provider's message ID when one is
   returned.

The early return in step 3 is why retry is a separate code path rather than a
call back into `notify()`. A retry through `notify()` would find the existing
row and report a duplicate instead of sending.
