# Operations

Day-to-day running: what the server does on its own, how to read its logs, and
what to do when something has failed.

## Background sweeps

Five sweeps run on timers, started when the server begins listening. Each is
wrapped in its own try/catch so one failure does not stop the others or kill the
timer.

| Sweep | Interval | What it does |
|---|---|---|
| `expireStaleClaims` | 60 seconds | Moves unpaid, agent-confirmed claims past their 24-hour payment window to `payment_window_expired` and records a payment strike |
| `reconcilePendingPaymentSessions` | 60 seconds | Recovers a completed M-Pesa payment whose webhook was missed or delayed, via the authoritative IntaSend status API. It also repairs a payment session stranded in `confirmed` against an unpaid claim, a bounded number of times per process |
| `releaseDueSettlements` | 5 minutes | Pays the disbursement split for claims whose dispute window has closed |
| `socialRetrySweep` | 5 minutes | Retries failed found-notice social publications |
| `notificationRetrySweep` | 5 minutes | Re-dispatches due retryable notifications |
| `handoverEvidenceRetentionSweep` | 24 hours | Purges handover evidence photos past their retention window |

### Claim expiry

The sweep selects claims in `pending_payment` whose window has elapsed, then
calls `expirePendingPaymentClaim`, a conditional update guarded on the claim still
being in `pending_payment`. It returns whether the update happened; only then is
a payment strike recorded.

That guard exists because an earlier unconditional status write let the sweep
expire a claim at the same moment a webhook was confirming payment. The winner of
the conditional update is the only writer that acts.

### Settlement

The sweep selects claims due for settlement, then uses the CAS-guarded
`attemptSettlementRelease`, which asserts the `pending_settlement → releasing`
edge and conditionally updates. Only the instance that wins performs the payout.

Settlement is partial-tolerant. If one leg of the disbursement split fails, the
claim returns to `pending_settlement` and a message records which payout is
outstanding; the next sweep retries only that leg. A permanently failing leg
therefore does not block the other payouts, and an administrator can settle
manually through `POST /api/admin/claims/:id/release-settlement`.

### Notification retry

The sweep claims due rows with a conditional update, sets them to `sending`, then
dispatches. Claiming before dispatching is what stops two instances sending the
same message.

The claim does not re-run the business transaction that produced the
notification. See [notifications.md](notifications.md).

### Social retry

Automatic retry is implemented only for `found_notice` publications. Other
publication types are logged as skipped rather than retried, because each would
need its own scoped retry path, and an unreviewed sweep across every category at
once is the failure mode being avoided.

### Handover evidence retention

Purges handover photos past their retention window. This is the one retention
category in [DATA_RETENTION_POLICY.md](DATA_RETENTION_POLICY.md) with an

## Notification failure handling

`GET /api/admin/notifications` is the failure console. It lists notification
events with their status, retry class, attempt counts and last error.

| Status | Meaning | Action |
|---|---|---|
| `retryable_failure` | Scheduled for another attempt | Wait; no action unless it exhausts the budget |
| `permanent_failure` | Will not be retried | Determine why, then act by hand |
| `unknown` | Outcome undeterminable | Confirm with the recipient whether they received it, then decide |
| `failed` | Failed before the retry lifecycle existed | Treat as terminal; resend manually |

`unknown` is the one that needs judgement rather than a reflex. It means the
provider's response did not establish whether the message was accepted, so
retrying could double-send a code and not retrying could drop it. Asking the
recipient is the only way to resolve it.

Exhausting the retry budget also produces `permanent_failure`, with
`next_attempt_at` cleared. Five attempts over roughly a day and a half is the
current policy; see [notifications.md](notifications.md).

### Manual retry

`POST /api/admin/notifications/:id/retry` dispatches a single row. It refuses any
event outside the five retry-eligible ones, regardless of who asks, and leaves
the original idempotency key untouched.

The refusal is not a limitation to work around. The nine non-retryable events
carry a one-time secret stored only as a hash, so the message cannot be
reconstructed; regenerating the secret would invalidate a code the recipient may
already be using. To resend a code, request a new one through the relevant
endpoint rather than retrying the notification.

## Recovery procedures

### A claim is stuck in `releasing`

A settlement that died mid-flight can leave the claim in `releasing`. The release
operation is re-entrant from `releasing` back to `pending_settlement`, so the
next sweep pass picks it up and retries the outstanding payout. If it does not
clear, settle it manually through the admin route and check the settlement sweep
logs for the specific payout that is failing.

### A webhook reports a payment but the claim did not move

Check, in order: `INTASEND_WEBHOOK_CHALLENGE` is set and matches the value
configured in the IntaSend dashboard; the payload's `topic` is
`collection_event` and its `state` is `COMPLETE`; the amount matched the
persisted session; and the claim was still in `pending_payment` when the webhook
arrived. An amount mismatch is refused by design, and a claim already moved out
of `pending_payment` means the payment was already applied.

If a payment is confirmed at IntaSend but the claim is still `pending_payment`,
the reconciliation sweep should recover it within a minute (or immediately when
the claimant taps "check payment status"). Check the `[PAYMENT RECONCILE SWEEP]`
and `[INTASEND AUTHORITATIVE LOOKUP]` log lines for the reason. See
[claims-and-payments.md](claims-and-payments.md).

### A session is `confirmed` but the claim is still unpaid

The `[PAYMENT RECONCILE SWEEP] UNEXPECTED STATE COMBINATION` and
`[PAYMENT SESSION STATUS] UNEXPECTED STATE COMBINATION` lines mean exactly what
they say: the provider took the money, the session's single confirmation was
consumed, and the claim was never credited (`paid_at IS NULL`). The recovery
attempt is bounded per process, so the line appearing three times for one
session is the budget being spent, not a new failure each time — a refusal after
that is the canonical path declining to write on facts it could not positively
verify (see `[PAYMENT RECONCILE SWEEP] Confirmed-session recovery REFUSED`).
Restarting the process, or the claimant opening the payment status route,
re-arms the attempt.

### Notification rows are stuck in `sending`

A `sending` row means a worker claimed it and then did not finish — usually a
process terminated mid-dispatch. The row is not automatically returned to a
retryable state, because the dispatch may actually have reached the provider. Use
`GET /api/admin/notifications` to identify the rows, confirm with recipients
where the event is reconstructable, and retry or resend deliberately.

### No emails are arriving

Check, in order: `RESEND_API_KEY` is set; `EMAIL_FROM` (or the legacy
`RESEND_FROM_EMAIL`) is a verified sender and not Resend's test sender; and the
notification rows are `sent` rather than failed. The test sender restricts
delivery to the API key owner, so a deployment left on it will show successful
sends and deliver nothing. See [configuration.md](configuration.md).

### No SMS is arriving

Check `SMS_ENABLED` first. `"false"` — the recommended launch setting — is the
most common cause: SMS is skipped by design, the server prints a `[BOOT]` notice
saying Africa's Talking is optional, and email/Resend carries the notification
instead. If SMS is meant to be live, `SMS_ENABLED` must be exactly `"true"` and
the Africa's Talking credentials and sender ID must be real; with `"true"` the
production boot guard refuses to start without them, so a running server that has
`"true"` already holds them. In production a disabled or unconfigured SMS path
fails closed, so the affected request reports failure rather than appearing to
succeed.

Since the E1 migration this is a narrower class of incident than it used to be:
no one-time codes travel by SMS any more (signing in, registering, filing a
claim and linking a claim all deliver their code by email), so a customer
waiting on a code is never waiting on SMS. When a code does not arrive, check
the email path instead — the `RESEND_*` values, the verified sender, and the
notification rows covered above.

Note the durable limit: 3 SMS per 10 minutes per identity. A user testing several
flows in quick succession will hit it, and that is expected.

### Activation links point at localhost

`PUBLIC_APP_URL` is unset. It falls back to `http://localhost:3000`. It is listed
in `.env.example`, but the shipped value is that fallback, so a deployment
assembled only from that file still omits a real origin. See
[configuration.md](configuration.md).

## Pause controls

Administrators can pause the platform and social publishing independently:

- `GET /api/admin/settings/pause-status`
- `POST /api/admin/settings/pause`
- `POST /api/admin/settings/social-publishing-pause`

## What does not exist

Stating these plainly, so an operator does not go looking for them:

- There is no metrics endpoint and no instrumentation beyond the error reporting
  configured through Sentry.
- There is no alerting. Nothing pages anyone when a sweep fails or a notification
  exhausts its budget; someone has to look.
- There is no dead-letter queue. A `permanent_failure` row stays in the table
  until reviewed.
- There is no backfill or replay tooling for the notification system.
- There is no health check covering provider reachability. `GET /api/health`
  confirms the process is up and nothing more.

## Related

- [notifications.md](notifications.md) — the notification lifecycle
- [claims-and-payments.md](claims-and-payments.md) — settlement and dispute flow
- [database.md](database.md) — the constraints the sweeps rely on
- [configuration.md](configuration.md) — provider configuration
- [deployment.md](deployment.md) — running more than one instance

implemented sweep; the rest are documented but not automated. See section 4 of
that policy.

A record under an active legal hold is not purged.

## Reading the logs

Sweeps log one line per pass or per item, with a bracketed prefix identifying
them:

| Prefix | Meaning |
|---|---|
| `[NOTIFICATION RETRY SWEEP]` | Rows claimed and sent this pass |
| `[SETTLEMENT SWEEP]` | A claim settled, failed, or partially processed |
| `[SOCIAL RETRY SWEEP]` | A publication retried or skipped as unsupported |
| `[HANDOVER PHOTO RETENTION SWEEP]` | Photos purged, or a per-claim purge failure |
| `[SWEEP]` | A claim's payment window expired |

A line reporting `Sweep failed` means the whole pass threw; the timer continues
and the next pass retries the same work. A per-item error means that item failed
while the rest of the pass continued.

Phone numbers in sweep logs are masked. A masked number in a log is expected
behaviour, not redaction gone wrong.
