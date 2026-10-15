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
| `releaseDueSettlements` | 5 minutes | Reports settlement-review status for claims whose dispute window has closed (who is approved and awaiting an explicit initiation, and what is stranded in `releasing`). It submits no payout and moves no money |
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

The sweep is reporting-only. It selects the claims in `pending_settlement` whose
`settle_at` deadline has passed and reports the ones that need attention: those
already carrying a durable approval and awaiting an explicit initiation, those
still awaiting review, and any claim stranded in `releasing`. It never calls the
provider, writes no claim status, ledger row or audit row, and submits no payout.

Payout initiation therefore happens only through an authorized administrator
action — `POST /api/admin/claims/:id/settlement/initiate`, or the legacy
`POST /api/admin/claims/:id/release-settlement` that delegates to the same rule —
and only subject to a durable settlement approval already on file, an elapsed
`settle_at` window, and the server-side safeguards described below (the global
payout pause, an item legal hold, and per-recipient payout submission state).

A recipient is submitted to the provider only when its ledger row positively
records that it has never been submitted (`ledger.payout_outcome =
'not_submitted'`). Before the provider is called, each row is marked
`submitting` by a compare-and-swap, so two workers cannot submit the same payout
attempt and a process that dies mid-call cannot cause a duplicate on restart.
See [claims-and-payments.md](claims-and-payments.md) for the outcome model.

Settlement is partial-tolerant, but only for payouts that were never submitted.
If one leg succeeds and the other is accepted by the provider but not confirmed,
or its outcome is unknown, or the provider refuses it, the claim returns to
`pending_settlement` and the unresolved leg is **not** resubmitted
automatically. An administrator can either record a durable, queryable approval
(POST /api/admin/claims/:id/settlement/approve) and then deliberately initiate
the payout (POST /api/admin/claims/:id/settlement/initiate), or mask the claim
back to a non-review state through the normal lifecycle transitions. Either way,
the same durable eligibility rule applies: a payout that may already have moved
money is never re-sent. Unresolved payouts are listed by `GET
/api/admin/payout-reconciliation`.

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
lock is given back to `pending_settlement` only by the payout path itself, while
that process is still alive to do it: the global payout pause, a local failure
such as a missing claim, item, agent or category, and an unresolved payout row all
return it deliberately. Nothing returns it on a timer. The next sweep pass only
reports the stranded claim (`[SETTLEMENT SWEEP] ... locked in 'releasing' need
manual reconciliation`) — it neither resets the payout state nor retries the
payout — and initiating a payout for a claim that is still in `releasing` is
refused with `settlement_already_in_flight`. Clearing it is an operator decision,
taken with `GET /api/admin/payout-reconciliation` in hand.

Releasing the claim does **not** re-authorize a payout. Eligibility is decided by
the payout row's own outcome, so a row that may already have moved money
(`submitting`, `accepted`, `unknown`) or was refused (`rejected`) is never sent
again, however many times the claim is released. Those rows are the ones listed
by `GET /api/admin/payout-reconciliation`, and the `[SETTLEMENT SWEEP]` line plus
the `PAYOUT_NOT_CONFIRMED` / `PAYOUT_RECONCILIATION_REQUIRED` audit rows name
them.

### A payout is unresolved (accepted, unknown or refused)

`GET /api/admin/payout-reconciliation` lists every finder/agent payout that is
not confirmed complete and is not eligible for another automatic submission. For
each row it returns the claim, the type, the amount, the recorded
`payoutOutcome`, and any provider batch/transaction reference captured from the
provider's own response. Check those references against the IntaSend dashboard:

- `accepted` — the provider took the batch; the transfer itself was not
  confirmed. If IntaSend shows the transfer completed, the claim can be settled
  once a confirmation path exists (see below); if it did not, the row needs a
  human decision.
- `unknown` — the request may or may not have been executed. Do not re-send
  until IntaSend says which.
- `rejected` — the provider refused the request before execution, so no money
  moved. Re-issuing it is a policy decision, and no automatic retry exists.
- `No submission history recorded` (no outcome value) — a row written before the
  outcome column existed. It is deliberately treated as unresolved rather than
  re-sent, because whether it was ever submitted cannot be proven from the data.

There is currently no endpoint that marks a payout completed or re-issues one:
both need evidence this system does not yet obtain on its own, and neither is
automatic. A payout an operator has verified as completed therefore cannot yet
be closed out from the console — that reconciliation workflow is the next piece
of work, and until it exists these rows stay visible and unresent rather than
being guessed either way.

### A hub cannot be paid: the stored payout destination fails the launch policy

Settlement refuses an agent payout leg whose stored destination does not normalise
to a Kenyan personal M-Pesa number (`254` + nine digits) and whose stored method is
not exactly `Personal M-Pesa` — see `config/payoutDestinations.ts`. Every hub that
registered before that policy existed still carries a Till Number, a Paybill, a
Pochi la Biashara number or a free-form method string, and the refusal was
otherwise discoverable ONLY by attempting the payout, at settlement time, with the
claim already in `releasing`.

Where to see it BEFORE any money is attempted:

- The console's **Payout Integrity** section lists every hub in the dashboard
  payload with the launch-policy verdict produced by the SETTLEMENT EXECUTOR's own
  resolver (`services/agentPayoutEligibility.ts` re-uses
  `resolvePayoutLegEligibility`), the destination in MASKED form only, and how much
  that hub is recorded as owed but not yet paid (`pending_earnings`).
- The **Agents Hub** rows carry the same verdict as a badge, and the expanded row
  states the hub's lifetime earnings and its owed-but-unpaid figure.
- The Overview's **Hubs That Cannot Be Paid** card counts the same set. An em dash
  means this build did not report the figure — read it as unknown, NOT as zero.

The four classes the console prints verbatim (the dashboard publishes the verdict
under `payout_eligibility`):

- `refused_destination_missing` — no destination is recorded for the hub at all.
- `refused_destination_not_a_personal_mpesa_phone` — a Till, a Paybill, a Pochi la
  Biashara number, or anything else that is not `254` + nine digits.
- `refused_unsupported_payout_method` — the destination may be usable, but the
  stored method is not `Personal M-Pesa`.
- `eligible` — the format and the method pass. This is deliberately NOT described
  as "verified": nothing in this platform proves the number is registered,
  reachable, or owned by that hub.

**What fixes it — and what does not exist.** The console can identify an ineligible
destination and explain the verdict; it cannot repair it. **This build provides no
destination-correction control anywhere in the Admin Console**, so an operator must
not assume the stored value can be changed here. There is no manual database-edit
procedure in this runbook and no correction endpoint in the codebase. Retrying a
refused payout is not a correction: the same stored value is refused again. The
verdict changes only when the stored destination or method is changed by a process
outside this build; the Payout Integrity section itself is read-only by construction
and has no control that can change a destination, a method or a payout state, and it
re-reads the verdict on the next dashboard read. A payout the executor refused was
refused BEFORE submission, so no money moved and no resend is involved.

**What the console will not do.** It will not retry, resubmit or re-issue a payout,
and it will not mark one paid. Where a verdict could not be read at all (an older
server build, or a payload that lost the `payout_eligibility` field), the console
says so — `Verdict not readable by this console — treat as not payable` — and the
hub is grouped with the ones needing a human rather than being shown as payable.

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
