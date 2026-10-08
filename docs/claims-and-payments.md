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

After the dispute window closes, the claim enters `pending_settlement` and then
`releasing`, and the disbursement split is paid out.

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

## Concurrency summary

| Operation | Mechanism | Prevents |
|---|---|---|
| `attemptClaimEscrowHold` | CAS with transition assertion | Duplicate webhook re-running escrow |
| `attemptSettlementRelease` | CAS with transition assertion | Sweep and manual release both paying out |
| `uq_claims_one_active_per_item` | Partial unique index | Two live claims on one item |
| `uq_disputes_one_unresolved_per_item` | Partial unique index | Two concurrent dispute filings |
| `uq_payment_sessions_provider_invoice` | Partial unique index | One provider invoice paying two claims |

## Related

- [agent-workflows.md](agent-workflows.md) — the agent steps that drive this lifecycle
- [architecture.md](architecture.md) — payment architecture
- [database.md](database.md) — the constraints above in schema form
- [notifications.md](notifications.md) — codes and confirmations
- [operations.md](operations.md) — the expiry and settlement sweeps


Settlement is a compare-and-swap, `attemptSettlementRelease`, which asserts the
`pending_settlement → releasing` edge before executing. It exists so that the
automatic sweep and an administrator's manual release cannot both pay out.

Settlement is not all-or-nothing. If part of the split fails, the claim returns to
`pending_settlement` and a message records which payout is still outstanding; the
next sweep retries only that payout rather than the whole split. An
administrator can also settle manually through
`POST /api/admin/claims/:id/release-settlement`.

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
