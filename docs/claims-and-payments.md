# Claims and payments

This document describes the claim lifecycle and the money that moves along it.
The distinction it maintains throughout is between *a request was made* and *the
persisted record says the money moved*. Only the latter is treated as true.

## Claim status vocabulary

Twelve values, constrained by `claims_status_check` in the database:

`pending_verification`, `awaiting_agent_confirmation`, `pending_payment`,
`payment_window_expired`, `escrow_held`, `pending_settlement`, `releasing`,
`released`, `disputed`, `rejected`, `refunding`, `refunded`.

Three derived sets exist, and they answer three different questions. Conflating
them is the most common source of confusion in this area.

| Set | Question |
|---|---|
| `INACTIVE_CLAIM_STATUSES` | Is this claim still a live attempt? |
| `CLAIM_SLOT_EXCLUDED_STATUSES` | May these two claims coexist on one item? |
| `PICKUP_ELIGIBLE_CLAIM_STATUSES` | Is this claim entitled to pickup instructions? |

`disputed` is inactive in the dashboard sense and excluded from the item slot,
but a dispute legitimately puts two claims on one item — so it must not occupy
the single claim slot. `released` is inactive for the dashboard but still
occupies the slot, because a completed handover is an achieved outcome.

The pickup-eligible set is derived from the vocabulary by subtracting an explicit
ineligible list, so a status added to the `CHECK` constraint cannot silently
default into being eligible.

## Legal transitions

`CLAIM_ALLOWED_TRANSITIONS` in `src/config/claimStatuses.ts` is the only
definition of a legal status edge. Anything absent is rejected, including every
backward move out of a terminal status.

| From | To |
|---|---|
| `pending_verification` | `awaiting_agent_confirmation`, `rejected` |
| `awaiting_agent_confirmation` | `pending_payment`, `rejected` |
| `pending_payment` | `escrow_held`, `payment_window_expired`, `rejected` |
| `escrow_held` | `pending_settlement`, `disputed` |
| `pending_settlement` | `releasing`, `disputed` |
| `releasing` | `released`, `pending_settlement` |

## Lifecycle

### Filing

A claim is filed against an item. The claimant's registered phone number is the
ownership anchor for the rest of the lifecycle: claim-scoped routes verify the
caller is the owner of the registered number rather than trusting an identifier
in the request body.

Filing is refused when the item already has an active claim, or when the item has
an unresolved dispute. The second rule is enforced by a partial unique index, not
only by the application check — two simultaneous submissions could both pass an
application-level check before either commits.

### Verification

The claimant receives a one-time code by email, at the verified email address on
the claim. Until it is redeemed the claim is
`pending_verification`, and the claimant is not entitled to pickup instructions.

The code is stored only as a hash. This is what makes the claim and pickup codes
non-retryable as notifications: the exact message cannot be rebuilt. See
[notifications.md](notifications.md).

### Agent confirmation

An agent assigned to the item confirms the item is physically present. This
moves the claim to `pending_payment` and opens the claim's payment window,
recorded as `agent_confirmed_at` plus a 24-hour window (`CLAIM_PAYMENT_WINDOW_MS`
in `config/paymentWindows.ts`). The window is server-authoritative and is
deliberately distinct from a single M-Pesa prompt's short session window: an
individual prompt may expire within minutes, but the CLAIM remains payable for
the whole day and the claimant can request a fresh prompt at any point.

### Payment

The owner initiates payment. Nothing is true about the money at this point: the
application has requested an M-Pesa STK push and the customer has not yet
approved it on their handset.

The persisted payment truth is the `payment_sessions` row plus the provider
webhook. `provider_invoice_id` carries a partial unique index, so a provider
invoice can be tied to at most one session.

Once the provider ACCEPTS an STK request, that attempt books its own
`payment_received` ledger row with status `pending`, stamped with the attempt's
provider invoice id. That row records that a prompt was sent — not that money was
collected — so it is not revenue in that state. It is completed only by the
authoritative confirmation of its own reference, in the same atomic transaction
that moves the claim to `escrow_held` (`attemptClaimEscrowHold`). An abandoned,
expired or superseded attempt therefore keeps its own pending row: it is not
revenue, and an unapproved prompt is not proof of failure, so it is left
unresolved rather than marked `failed`. Settlement never completes a receipt row
— its sweep is scoped to the payout rows it books itself.

### Escrow

The claim becomes `escrow_held` only when the webhook confirms payment. That move
is a compare-and-swap, `attemptClaimEscrowHold`, and it re-asserts that the edge
is in the transition table before executing.

The CAS exists because the provider can deliver a webhook more than once. Without
it, a duplicate delivery would re-run the escrow side effects: a second pickup
code, duplicate confirmation emails, and a claim that no longer matches its own
payment record. A `false` return means another worker won the race and the caller
must not proceed.

The CAS also covers the payment reference, so a claim cannot be moved into escrow
against a different payment reference than the one already recorded.

### Amount reconciliation

The webhook amount is compared against the persisted payment session. A mismatch
is refused, not accepted and not adjusted. The webhook is authenticated against
`INTASEND_WEBHOOK_CHALLENGE` before any of this.

A completed payment that the webhook misses is not lost: the claimant's
"check payment status" action and a background reconciliation sweep both ask the
authoritative IntaSend payment-status API, and a COMPLETE, amount-reconciled
response is confirmed through the SAME canonical confirmation path the webhook
uses.

#### Late payment after the window

The claim window (24h) and a single M-Pesa prompt's session window (minutes)
differ, and the expiry sweep runs every 60 seconds, so a genuine approval can
land after the claim has already been moved to `payment_window_expired`. That
status is otherwise terminal — it has no entry in the transition table and
`isAllowedClaimTransition` refuses every edge out of it — but that blanket
refusal is for workflow callers, not for a money fact. The canonical
confirmation path therefore carries exactly one gated exception: when, on facts
freshly re-read immediately before the atomic CAS, the claim is still
`payment_window_expired`, carries no `paid_at`, the amount is positively
reconciled, the provider invoice is bound to this claim, and the session's single
confirmation was won, the claim is recovered to `escrow_held` through the same
single-statement compare-and-swap. No session is consumed until the payment is
positively verified.

The gate is a predicate, `canRecoverExpiredClaimPayment`
(`config/claimStatuses.ts`); the edge is recorded as data,
`EXPIRED_CLAIM_PAYMENT_RECOVERY_EDGE`, so it is auditable; and each recovery is
written to the audit log (`CLAIM_PAYMENT_RECOVERY_EXPIRED`). Every other path — a
legacy direct payment with no payment session, a replayed webhook, or any other
claim status — falls through to the ordinary refusing behaviour, so the default
in-window path is unchanged.

A mismatch is evidence of either a provider fault or something the application
does not understand, and quietly reconciling the difference would move money on
the basis of a record the application cannot vouch for.

#### A confirmed session whose claim was never credited

Both recovery entry points used to hand-write the same allow-list of session
statuses — `pending` or `expired` — so a session already in `confirmed` was
invisible to both. That is right for the ordinary case, because the canonical
path confirms the session in the same transaction that moves the claim, so a
`confirmed` session normally co-exists with a paid claim. It is wrong for the
stranded case: a session can exist as `confirmed` while its claim is still
unpaid and has already been swept to `payment_window_expired`. The provider had
genuinely taken the money, and no code path would ever look at that session
again.

That selection decision is now one module, `config/paymentReconciliation.ts`,
imported by both the on-demand status route and the background sweep so the two
cannot drift apart:

| Export | Meaning |
|---|---|
| `RECONCILABLE_SESSION_STATUSES` | `pending`, `expired`, `confirmed` |
| `RECONCILABLE_CLAIM_STATUSES` | `pending_payment`, `payment_window_expired` |
| `isPaymentReconciliationEligible` | Whether this session is worth a provider lookup |
| `paymentReconciliationRefusal` | The one implementation, plus the non-sensitive reason it was refused |

The refusal reasons are `no_provider_invoice`, `claim_already_paid`,
`claim_status_not_reconcilable` and `session_status_not_reconcilable`, and they
exist for structured logging rather than for the user.

This is a selection predicate, not an authorisation, and it is deliberately
permissive: widening it cannot confirm anything by itself, because every
selected session is handed to the canonical confirmation path, which still
refuses a session bound to a different claim, a session in no confirmable state
and an amount that is not positively reconciled. The atomic
`attemptClaimEscrowHold` remains the only writer of `paid_at`.

A session in `confirmed` is a terminal provider fact — re-asking cannot change
the provider's answer — so the sweep attempts that repair a bounded number of
times per process (`RECONCILE_CONFIRMED_REPAIR_MAX_ATTEMPTS`) instead of
polling forever. Repair attempts, and only repair attempts, are logged; the
ordinary `pending`/`expired` cycle stays silent.

None of this changes the underlying rule: `claims.paid_at IS NOT NULL` is the
only proof a claim was paid. A session marked `confirmed` is not proof by
itself, so it must stay reachable by recovery while the CAS keeps deciding
whether anything is written.


### Pickup code

Once escrow is held, a pickup code is issued to the owner and a confirmation is
emailed. The code is stored in `claim_pickup_codes` as a hash. It is a
single-use credential read aloud at the counter by the agent.

### Viewing and handover

The agent confirms the owner viewed the item, then confirms handover. Handover is
the operational end of the claim and the trigger for settlement.

### Settlement

After the dispute window closes, the claim enters `pending_settlement`. That is as
far as anything automatic goes: reaching `releasing` and paying the disbursement
split requires a durable administrator approval, an elapsed `settle_at` window,
and the guarded initiation path described next.

Settlement is a durable, human-gated process. A claim does not leave
`pending_settlement` because of a timer or a shared "escrow" that a second
button can release. The operator must first record a **durable approval**
(POST /api/admin/claims/:id/settlement/approve) and then deliberately **initiate**
the payout (POST /api/admin/claims/:id/settlement/initiate). Each step is a
separate, permissioned action with its own eligibility checks. The combined
`POST /api/admin/claims/:id/settlement/approve-and-pay` performs those two steps
in that order for a single operator decision — it is a wrapper over them, not a
third money path.

- **Approval** does not change claim status and never touches the provider.
  It records who approved and when (settlement_approved_at /
  settlement_approved_by) plus the required reason in the approval's own
  `CLAIM_SETTLEMENT_APPROVED` audit row, which commits in the same transaction
  as the approval itself. The approval is CAS-guarded: the claim must still be
  unapproved, still in `pending_settlement`, and still inside an elapsed
  settle_at window at the moment of the write, so two concurrent approvals
  produce exactly one approval and a claim that has already been approved cannot
  be re-approved.
- **Initiated payout** requires the durable approval to already exist in the
  database and the settle_at deadline to have elapsed — both as write-time
  conditions of the release itself. Global payout pause, an item
  suspected-stolen/legal-hold review and any per-recipient payout row that has
  already been submitted are enforced by the executor, which re-reads the claim,
  the approval and the item from the database immediately before it calls the
  provider. If all conditions hold the route atomically claims the release lock
  and calls executeClaimSettlement(). On success the claim moves to `released`
  and the ledger rows are completed. On failure the lock is reverted and the
  claim returns to `pending_settlement`; no money moves.

  **The payout must match the ledger it was booked against.** Before any
  submission marker is written, the executor compares each planned leg with its
  own booked ledger row: the amount at `NUMERIC(10,2)` precision and the
  destination in canonical phone form. Any difference — an edited category for an
  item booked before shares were locked, or a payout destination activated after
  the booking — refuses the **whole** claim payout. No leg is sent, no ledger
  amount is rewritten, and the claim returns to `pending_settlement`, so a later
  initiation can pay once the data agrees with the ledger again.

  **And it must be the payout an administrator approved.** The approval write
  records *what* it authorized, in the same transaction as the sign-off: the
  payout total (`settlement_authorized_total`) and the exact payout ledger rows
  it covers (`settlement_authorized_ledger_ids`, canonical `role:id` pairs).
  Before submission the executor compares that snapshot with the claim's payout
  rows. A changed amount, a different/re-booked row, a half-written snapshot or
  unreadable rows refuses the whole payout (`SETTLEMENT_AUTHORIZATION_MISMATCH`)
  through the same `abandonRelease()` path: nothing is sent, nothing is marked as
  submitted and no provider request is made. Approvals recorded before this
  snapshot existed carry neither column; they are audited as
  `SETTLEMENT_AUTHORIZATION_SNAPSHOT_MISSING` and remain bound to their booked
  ledger rows rather than being refused (approval is immutable, so refusing would
  strand a legitimately approved payout forever). Destinations are not copied
  onto `claims`: each leg is bound to its ledger row, whose `phone_or_till` is
  the immutable booking-time destination snapshot.

  **Initiation re-authenticates.** The operator supplies their own password in
  the request body; it is bcrypt-compared against the authenticated
  administrator's stored hash *before* the release lock is attempted, so a wrong
  password takes no lock, writes nothing and reaches no provider. A missing
  password is `400 password_required`, an over-long one `400 password_too_long`
  (the ceiling is 200 characters), and a mismatch `401 password_incorrect`.
  Failed confirmations are rate-limited per administrator account, not per IP
  address, so one operator cannot lock colleagues out behind a shared NAT. That
  bucket is process-local (`express-rate-limit`'s default store): the ceiling is
  per instance, not per deployment, and a restart clears it — see
  [deployment.md](deployment.md).


- **Combined approval + payout** (POST
  /api/admin/claims/:id/settlement/approve-and-pay) is offered in the admin
  console as "Approve & pay" for a due settlement that has no approval on file.
  It requires **both** settlement permissions and the operator's own password,
  which is bcrypt-compared before anything is written and is never logged,
  echoed back, or stored. It then takes exactly the two steps above in order:
  the same approval CAS, then the same release CAS and executor. Consequences
  worth knowing:

  - it cannot shortcut a claim that is already approved (the approval reads as
    `already_on_file` and the payout proceeds), cannot pay inside the settle_at
    window, and cannot stand in for the separate `initiate` route's checks;
  - a fee/pause/eligibility refusal *after* the approval row committed is
    reported as a partial outcome — `recoverable: true` with `reasons[]` and
    `next: { initiate }` — because the approval is durable and the payout is
    still outstanding;
  - a wrong password, a missing reason, or a caller lacking either permission
    writes nothing at all.

  **Refusals are specific, stable and actionable.** A settlement failure carries
  `reason_code` from one closed catalog (for example `submission_history_unknown`,
  `provider_refused`, `provider_accepted_unconfirmed`,
  `provider_outcome_ambiguous`, `payout_already_sent`,
  `approval_snapshot_mismatch`, `ledger_amount_mismatch`,
  `ledger_destination_mismatch`, `destination_not_eligible`,
  `simulation_not_permitted`, `disbursement_wallet_missing`,
  `wallet_routing_refused`, `item_on_hold`, `payout_paused`) plus
  `operator_message`, `next_action` and `automatic_retry: false`. A legacy row
  with no submission history is never described as "failed" and never
  "resubmitted automatically": it is a reconciliation item until positive
  evidence of non-execution is obtained through the audited repair process.

  The console also reads
  `GET /api/admin/claims/:id/settlement-readiness` before initiation. That
  endpoint is strictly local: claim state, ledger rows, approval snapshot,
  destination policy, payout pause and wallet configuration only. It performs no
  provider call and reads no wallet balance. Its checklist disables the
  initiation control while a condition fails, and the initiation route re-checks
  every condition independently.

The legacy `POST /api/admin/claims/:id/release-settlement` route is retained for
compatibility and delegates to exactly the same rule. It cannot force anything:
there is no `force`/override parameter left in the data layer, so a claim with
no durable approval, or one still inside its settle_at window, is refused with a
clear non-success response that points at the two supported actions.

The settlement sweep does not call the provider and moves no money. It is a
reporting sweep: it counts the claims past their settle_at deadline (split into
"approved, awaiting an explicit initiation" and "awaiting review") and flags any
claim stranded in `releasing` for manual reconciliation. Recovering a stranded
claim is deliberately left to an operator, because its provider outcome may be
unknown — the sweep never resets or retries a payout.

For the ledger outcome model and the payment_received / finder_payout /
agent_payout / platform_fee row types, see [claims-and-payments.md](claims-and-payments.md#ledger-outcomes).

## Where collections land, and which wallet pays out

Two provider wallets are involved and they are **not interchangeable**.

- **Collections.** By default the STK request the platform sends
  (`POST /payment/mpesa-stk-push/`) carries exactly four fields — `public_key`,
  `phone_number`, `amount`, `api_ref` — and IntaSend credits the KES
  **settlement** wallet for the merchant account. The optional, default-off
  `INTASEND_COLLECTION_WALLET_ID` can append one fifth field, `wallet_id`, but
  **only in production and only when the value is real**; unset or blank leaves
  the four-field request unchanged, and a placeholder refuses the collection
  before any provider call. Outside production the value is never sent. Whether
  IntaSend honours `wallet_id` on this endpoint for this merchant account has
  **not been verified**, and the code makes no claim that it does.
- **Payouts.** A settlement payout debits the wallet named by
  `INTASEND_DISBURSEMENT_WALLET_ID` via the documented `wallet_id` field of
  `POST /send-money/initiate/`. That variable is required in production (a
  missing, blank or placeholder value refuses the payout before any provider
  request) and is never sent outside production.

Because collected money and payout float sit in different wallets, a payout can
fail for want of float while the account as a whole holds funds. Moving that float
is an **operator-run provider operation** — it is not implemented in this
application, by design (see [operations.md](operations.md)). The application reads
no wallet balance, so a settlement balance is never treated as available
working-wallet money.

**The routing guard (Batch 2).** If the deployment declares the settlement
wallet's identity in the optional `INTASEND_SETTLEMENT_WALLET_ID`, the payout path
requires the two wallet IDs to differ. A production deployment whose payout wallet
**is** the settlement wallet refuses to initiate: the settlement executor returns
the release lock (`abandonRelease`), every payout row is still `not_submitted`, no
provider request is made, and the refusal is recorded as
`PAYOUT_WALLET_ROUTING_REFUSED` with **masked** wallet IDs. An undeclared
settlement wallet does not block payouts; the identity check is simply reported as
unavailable rather than guessed.

## Disputes

A dispute can be filed from `escrow_held`, `pending_settlement` or `disputed`, and
from any non-terminal status via the wildcard edge. In practice it is raised
against a claim whose money is already held or already due for release, which is
what makes it meaningful.

Dispute evidence is stored separately in `dispute_evidence`. A dispute
participating claimant is identified as `original` or `contesting`.

A partial unique index on `disputes` guarantees at most one unresolved dispute
per item. This is the actual concurrency guarantee: the application-level check
narrows the window but cannot close it, because two near-simultaneous filings
could both pass before either commits.

Resolution is an administrator action. The losing claim can move to `rejected`; a
refund moves the claim to `refunding` and then `refunded`.

| Endpoint | Purpose |
|---|---|
| `GET /api/disputes/:disputeId/evidence` | Evidence for a dispute |
| `POST /api/disputes/:disputeId/evidence` | Submit evidence |
| `GET /api/admin/disputes/:disputeId/evidence` | Administrator evidence view |
| `POST /api/admin/disputes/resolve` | Resolve |

## Refunds

A refund is a business decision by an administrator; it is not automatic on
rejection. The claim moves to `refunding` while the provider processes the
refund, and to `refunded` when it completes.

Because a real provider refund is in flight, a `refunding` claim legitimately
coexists with the winning claim on the same item. That is why `refunding` is
excluded from the single-claim slot even though it is not "inactive" in the
dashboard sense.

Reconciliation endpoints exist because a provider refund is asynchronous and can
fail:

- `GET /api/admin/refund-reconciliation` — claims awaiting refund finalization
- `POST /api/admin/refund-reconciliation/:claimId/finalize` — mark refunded
- `POST /api/admin/refund-reconciliation/:claimId/revert` — return to the previous
  state

## Payment endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/claims/:id/payment-session` | Create a payment session |
| `POST /api/claims/:id/payment-session/:sessionId/initiate` | Issue the STK push |
| `GET /api/claims/:id/payment-session/:sessionId/status` | Session status |
| `POST /api/claims/:id/payment-auth` | Record payment authorisation |
| `POST /api/claims/:id/pay` | Legacy payment entry point |
| `POST /api/claims/:id/rate` | Rate the completed transaction |
| `POST /api/claims/:id/pickup-details` | Submit pickup information |
| `GET /api/claims/:id/status` | Claim status for the owner |
| `POST /api/webhooks/intasend` | Provider webhook |

Initiating a session records intent. It is not a payment, and no code should read
an initiated session as money received.

## Development simulation

`POST /api/dev/simulate-payment/:claimId` and `GET /api/dev/test-mode` exist to
exercise the lifecycle without a provider. They are guarded by
`ENABLE_DEV_PAYMENT_SIMULATION` and by `NODE_ENV`. In production the routes
refuse.

Simulated payment is not a payment and produces no settlement. It exists to drive
state transitions in a test environment.

It also does not invent a payment reference. The simulation stands for the claim's
own newest confirmable payment attempt — the provider invoice already persisted on
that attempt's payment session — and drives the same canonical confirmation path
the provider webhook uses, so it completes exactly that attempt's
`payment_received` row and consumes exactly that session. A claim with no
confirmable attempt is refused (`409`) instead of being confirmed under a reference
that exists nowhere. The amount confirmed is the session's own
server-authoritative amount, so the same amount controls run; only the provider
lookup is absent, which is the point.

## Concurrency summary

| Operation | Mechanism | Prevents |
|---|---|---|
| `attemptClaimEscrowHold` | CAS with transition assertion | Duplicate webhook re-running escrow |
| `attemptSettlementRelease` | CAS with transition assertion | Two concurrent settlement initiations both acquiring the release lock |
| `uq_claims_one_active_per_item` | Partial unique index | Two live claims on one item |
| `uq_disputes_one_unresolved_per_item` | Partial unique index | Two concurrent dispute filings |
| `uq_payment_sessions_provider_invoice` | Partial unique index | One provider invoice paying two claims |

## Related

- [agent-workflows.md](agent-workflows.md) — the agent steps that drive this lifecycle
- [architecture.md](architecture.md) — payment architecture
- [database.md](database.md) — the constraints above in schema form
- [notifications.md](notifications.md) — codes and confirmations
- [operations.md](operations.md) — the expiry and settlement sweeps


Settlement initiation requires two things to hold at write time: a durable
approval is already recorded on the claim, and the `settle_at` window has
elapsed. Both are conditions of the compare-and-swap
`attemptSettlementRelease`, which asserts the `pending_settlement → releasing`
edge before the payout executor runs, and the executor re-reads the claim, the
approval and the item from the database immediately before it calls the
provider. The periodic sweep does not execute payouts — it reports only — so it
is the conditional database update plus the single payout executor that protect
initiation against duplicate submission: two concurrent initiations cannot both
take the lock, and a claim that is not both approved and due is refused.

### Payout submission outcome

Every payout row carries its own `payout_outcome`, the durable record of what the
provider did with that attempt. It is written before the provider is called
(`submitting`) and again from the response:

| Outcome | Meaning | Resubmitted automatically? |
|---|---|---|
| `not_submitted` | Booked, never sent to a provider | Yes — this is the normal first attempt |
| `submitting` | A pre-submission marker was written; no result was recorded (the process may have died mid-call) | No |
| `accepted` | The provider took the batch; the individual transfer is not confirmed | No |
| `unknown` | Timeout, transport failure or provider 5xx — the request may have been executed | No |
| `rejected` | The provider refused the request before execution (a 4xx, not 408) | No |
| `completed` | Authoritative confirmation that the transfer completed | No — already paid |
| no value (NULL) | No submission history is recorded at all (every row written before this column existed) | No — fail closed |

Only a row that positively says `not_submitted` is ever sent, so an ambiguous
row can never be re-sent merely because a claim was retried. A non-2xx provider
response is not treated as one fact either: a 4xx refusal is recorded as
`rejected`, while a 5xx or a 408 is recorded as `unknown`, because the provider
may already have executed the transfer. Unresolved rows stay visible through
`GET /api/admin/payout-reconciliation`.

Settlement is not all-or-nothing, but "partially processed" no longer means
"retry the rest". If a leg is unresolved, the claim returns to
`pending_settlement` and the unresolved leg is recorded for provider
reconciliation instead of being resent; an administrator can still settle
manually through `POST /api/admin/claims/:id/release-settlement`, which applies
the same eligibility rule.

### Payment window expiry

A claim that is confirmed but not paid within its window is swept every 60
seconds and moved to `payment_window_expired`, and a payment strike is recorded
against the phone number. The window is 24 hours from `agent_confirmed_at`
(`CLAIM_PAYMENT_WINDOW_MS`), so a claimant who logs out or closes the browser
does not lose the claim. Expiry is abandonment, not a rival claim, which is why
that status is inactive and does not block a new claim on the item.

Strikes accumulate in `claim_payment_strikes` and inform abuse decisions.
`phone_reputations` holds the broader behavioural signal. An administrator can
clear either. See [data-and-privacy.md](data-and-privacy.md) for how these are
treated on erasure.

| `disputed` | `pending_verification`, `escrow_held`, `refunding`, `rejected` |
| `refunding` | `refunded`, `rejected` |
| any non-terminal | `disputed` |

Terminal statuses, with no outgoing edges: `released`, `refunded`, `rejected`,
`payment_window_expired`.

`payment_window_expired` has exactly one gated exception, and it is a payment
fact rather than a workflow edge: a genuinely verified, amount-reconciled late
payment may be recovered to `escrow_held` by the canonical confirmation path
alone (see "Late payment after the window"). The edge is deliberately absent from
the table above, so every generic caller still refuses it.

A transition from a status to itself is permitted as an explicit idempotent
no-op, so a retried request that re-asserts the current state is not an error.
`*` is honoured only as a source, never as a destination.
