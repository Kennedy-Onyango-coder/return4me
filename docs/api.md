# API reference

An internal reference for the HTTP surface, grouped by actor rather than by
file, because the question a maintainer usually has is "who can do this".

It is not a public API contract and carries no stability guarantee for external
integrators. Response shapes are described where a caller depends on a specific
field; they are not enumerated.

## Conventions

| | |
|---|---|
| Base path | `/api` |
| Auth, agents and admins | `Authorization: Bearer <jwt>` |
| Auth, customers | `r4m_customer_session` cookie |
| Claim-scoped routes | Caller must be the registered owner of the claim |
| Errors | JSON `{ "error": string }`; user-facing messages are bilingual |

Authentication failure is 401, authorization failure is 403, and the two are
used consistently. See [authentication.md](authentication.md).

## Public

No authentication required.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness |
| GET | `/api/stats` | Public counts |
| GET | `/api/categories` | Active categories |
| GET | `/api/items/search` | Search public items; location and county aware |
| GET | `/api/items/:id/public` | Public item view |
| POST | `/api/items/report` | Report a found item |
| POST | `/api/items/analyze` | Analyse a document image |
| GET | `/api/lost-reports` | List lost reports |
| POST | `/api/lost-reports` | File a lost report |
| GET | `/api/lost-reports/:id` | Lost report detail |
| GET | `/api/lost-reports/:id/matches` | Candidate matches for a lost report |
| POST | `/api/location/reverse` | Reverse geocode a coordinate |

The search and lost-report routes are rate limited. Public item and lost-report
responses use a restricted DTO that omits finder and owner identity fields.

The lost-report routes accept an optional customer session: a signed-out
visitor is handed through the account boundary before the form renders, and the
server enforces the same rule rather than relying on the client.

## Customer

Requires a valid `r4m_customer_session` cookie.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/customer/register` | Create an account; sends the activation email |
| POST | `/api/customer/activate` | Redeem an activation token |
| POST | `/api/customer/login` | Request an email OTP |
| POST | `/api/customer/login/verify` | Redeem the OTP; sets the session cookie |
| POST | `/api/customer/logout` | End the session |
| GET | `/api/customer/me` | Current customer |
| GET | `/api/customer/claims` | The customer's claims, grouped active and history |
| GET | `/api/customer/claims/:id` | One claim; requires the claim to be linked |
| DELETE | `/api/customer/claims/:id/link` | Unlink a claim from the account |

Registration returns **503** if the activation email cannot be sent, rather than
reporting success for an account that cannot be activated. There is no
activation resend endpoint.

`GET /api/customer/claims` groups by the same inactive-status predicate the
server uses to decide whether a claim counts as a competing claimant, so the
dashboard and the claim logic cannot drift apart.

## Authentication

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/request-otp` | Public | Request an agent email OTP |
| POST | `/api/auth/verify-otp` | Public | Redeem the agent OTP, or the agent activation token |
| POST | `/api/auth/admin-login` | Public | Administrator password step |
| POST | `/api/auth/admin-login/verify-2fa` | `admin_pending_2fa` | Administrator TOTP step |
| POST | `/api/auth/request-data-deletion` | Authenticated | Erasure request |
| POST | `/api/agents/activate` | Bearer | Redeem an agent activation token |

`/api/auth/admin-login/verify-2fa` is the only route that accepts a pending-2FA
token. Every other admin route rejects it with 403. See
[authentication.md](authentication.md).

## Claims

Claim-scoped routes require the caller to be the owner of the claim's registered
phone number, checked in one shared place.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/claims/submit` | File a claim |
| POST | `/api/claims/lookup` | Recover a claim by reference, using the customer session |
| POST | `/api/claims/:id/request-otp` | Send the claim verification code |

## Payments

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/webhooks/intasend` | Webhook secret | Provider callback |

The webhook is the only authority on whether money moved. It is authenticated
against `INTASEND_WEBHOOK_CHALLENGE` (the challenge value IntaSend sends in the
collection payload), its amount is reconciled against the persisted payment
session, and the escrow transition is a compare-and-swap so a repeated delivery
cannot pay twice. A completed payment that was missed by the webhook is also
recovered through the authoritative IntaSend status API (on demand and by a
background sweep). See [claims-and-payments.md](claims-and-payments.md).

## Agents

All require the `agent` role and an agent who is currently active.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/agents/queue` | Items assigned to the agent's location |
| POST | `/api/agents/verify-item` | Record an inspection and any field corrections |
| POST | `/api/agents/confirm-dropoff` | Item received at the counter |
| POST | `/api/agents/reject-dropoff` | Item refused |
| POST | `/api/agents/claims/:claimId/confirm-viewing` | Owner has viewed the item |
| POST | `/api/agents/confirm-handover` | Handover completed |

Confirmation routes additionally require the agent to be assigned to the claim's
item. See [agent-workflows.md](agent-workflows.md).

### Agent payout settings

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/agents/payout-settings` | Agent | Current (masked) destination, verification availability, live/latest request |
| POST | `/api/agents/payout-settings/change-request` | Agent | Propose a Personal M-Pesa phone destination (format check only) |
| POST | `/api/agents/payout-settings/change-request/:changeId/verify-phone` | Agent | Always refuses with `503` while no delivery adapter exists; never claims a code was sent |
| GET | `/api/admin/agent-payout-destination-changes` | Admin | List requests with the masked destination and the admin timeline |
| GET | `/api/admin/agent-payout-destination-changes/:changeId` | Admin | One request with its timeline and attestation evidence |
| POST | `/api/admin/agent-payout-destination-changes/:changeId/attest` | Admin + password | Record a **phone-call attestation**: `note` required (max 500); `method` is fixed to `admin_phone_call` |
| POST | `/api/admin/agent-payout-destination-changes/:changeId/approve` | Admin + password | Record approval. Requires a complete attestation and a DIFFERENT administrator |
| POST | `/api/admin/agent-payout-destination-changes/:changeId/reject` | Admin | Reject with a required reason |

An attestation is **not** phone verification: it never writes `phone_verified_at`
and is never shown as "verified". Activation requires format eligibility, a
complete phone-call attestation and an approval by a different administrator.
`AGENT_PAYOUT_PHONE_VERIFICATION_ADAPTER_IMPLEMENTED` remains `false`; the
SMS/WhatsApp adapter interface is a disabled boundary only.

## Disputes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/disputes/:disputeId/evidence` | Participant | Dispute evidence |
| POST | `/api/disputes/:disputeId/evidence` | Participant | Submit evidence |

Evidence routes are restricted to dispute participants. A participant is
identified as `original` or `contesting`.

## Administration

All require `role === 'admin'` inline, a current admin session, and where
applicable a named permission.

### Agents

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/admin/agents/:id/approve` | Approve |
| POST | `/api/admin/agents/:id/location` | Assign a location |
| POST | `/api/admin/agents/:id/suspend` | Suspend |
| POST | `/api/admin/agents/:id/warn` | Record a warning |
| GET | `/api/admin/agents/:id/documents` | Review submitted documents |

### Items and categories

### Claims, disputes and money

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/claims` | List claims (`claims.read`) |
| GET | `/api/admin/claims/:claimId` | Claim detail (`claims.detail`) |
| GET | `/api/admin/claims/:id/settlement-readiness` | **Read-only** Pending Settlement checklist (`claims.detail`). Uses existing claim/ledger/approval/wallet-configuration state and pure policy functions only: **no provider call and no wallet-balance read**. Returns `ready`, `blockers[]`, and one `conditions[]` entry per check with `code`, `label`, `ok`, `detail` and `next_action`. The initiation route re-decides everything |
| POST | `/api/admin/claims/:id/settlement/approve` | Record durable settlement approval (`claims.settlement_approve`) |
| POST | `/api/admin/claims/:id/settlement/initiate` | Initiate the payout (`claims.settlement_initiate`). **Requires the caller's own password** in `password` (bcrypt-reauthenticated before the release lock is attempted; never logged or echoed). Answers `400 password_required` / `400 password_too_long` / `401 password_incorrect`, `409 { error, code: 'payout_not_eligible', reasons }` when the durable approval or the settle_at window is missing, and `500 { error, code: 'payout_not_confirmed', recoverable: true, next: { initiate } }` when the provider outcome is not confirmed. Success reports `payout: 'submitted'`, never "paid" |
| POST | `/api/admin/claims/:id/settlement/approve-and-pay` | Combined approve **and** initiate for one due settlement. Requires **both** `claims.settlement_approve` and `claims.settlement_initiate`, and the caller's own password in `password` (bcrypt-reauthenticated, never logged or echoed). It runs the same approval CAS and the same release CAS + executor as the two routes above — no second money path — so it reports `payout: 'submitted'`, never "paid"; an approval that is already on file is treated as met and the payout proceeds; a refusal *after* the approval committed answers `recoverable: true` with `next: { initiate }` and the server's own `reasons[]`. A successful body also carries `destination_changed` (true when a stored payout destination changed between the approval this action recorded and the attempt) |
| POST | `/api/admin/claims/:id/release-settlement` | Legacy manual settlement. Delegates to the same rule as `initiate` (`claims.settlement_initiate`) and **also requires `password`** (same codes and statuses); it cannot bypass the durable approval or the settle_at window, and answers `409 { error, next: { approve, initiate } }` when they are missing — that legacy body carries **no `code` and no `reasons[]`** (unlike `initiate`), so a client must branch on the status and on `next` |
| GET | `/api/admin/payout-reconciliation` | Finder/agent payouts whose provider outcome is unresolved (read-only) |
| GET | `/api/admin/disputes/:disputeId/evidence` | Evidence view |
| POST | `/api/admin/disputes/resolve` | Resolve a dispute |
| GET | `/api/admin/payment-strikes` | Payment strikes |
| POST | `/api/admin/payment-strikes/:phone/clear` | Clear strikes |
| GET | `/api/admin/refund-reconciliation` | Refunds awaiting finalization |
| POST | `/api/admin/refund-reconciliation/:claimId/finalize` | Mark refunded |
| POST | `/api/admin/refund-reconciliation/:claimId/revert` | Revert |
| POST | `/api/admin/reputations/:phone/clear` | Clear a reputation record |

#### Settlement response contracts

Every settlement mutation returns one of four shapes. The `code` field is stable
and is what the console branches on; `error` is human-readable and may change.

| Status | `code` | Meaning | Recoverable? |
|---|---|---|---|
| 400 | `reason_required` | The approval reason is missing or blank | No — resend with a reason |
| 400 | `password_required` | No `password` in the body | No — resend with the password |
| 400 | `password_too_long` | `password` exceeds 200 characters | No — resend with the real password |
| 401 | `password_incorrect` | bcrypt mismatch against the authenticated admin's own hash | Yes — retry with the correct password (rate-limited per account) |
| 404 | `claim_not_found` | No such claim | No |
| 404 | `admin_not_found` | The token names an account that no longer exists. Defence in depth only: `requireCurrentAdminSession` refuses such a token with 401 before the handler runs, so this body is not reachable over HTTP | No |
| 409 | `not_pending_settlement` / `outside_review_window` / `no_review_window` | The approval CAS refused (`approve-and-pay` only) | No until the claim state changes |
| 409 | `payout_ledger_unreadable` | The claim's payout rows could not be described unambiguously (none, duplicated ids, unreadable amounts), so no approval was recorded at all (the approval transaction is rolled back) and no payout was attempted | No — a data review of the claim's ledger rows is required first |
| 409 | `payout_not_eligible` | The **release CAS** refused: the claim is no longer `pending_settlement`, is already `releasing`, has no durable approval, or its `settle_at` window has not elapsed. Carries `code`/`reason_code`, `operator_message`, `next_action`, `automatic_retry: false`, `reasons[]`, `reason_details[]`, `approval`, `approved_by`, `approved_at`, `recoverable: true` and `next: { initiate }` | Yes — the approval (if `approval: 'recorded'`) is durable; retry only the payout step once the condition clears. No automatic retry |
| 500 | `payout_not_confirmed` | The release lock was won (the payout was authorized) but the attempt did not complete. This covers BOTH an executor refusal before submission (payouts paused, item legal hold, destination policy, a payout amount or destination that does not match the booked ledger row, missing simulation configuration, wallet configuration/routing) AND a provider outcome that is not confirmed (rejected, accepted-but-unconfirmed, ambiguous, or a legacy row with no submission history). Carries `reason_code` (specific and stable), `operator_message`, `next_action`, `automatic_retry: false`, `recoverable: true` and `next: { initiate }` | Yes, but **verify with the provider first** — the leg is never resubmitted automatically. 500 is the established status for this on all three money routes, including the legacy one |
| 200 | — | `payout: 'submitted'`, never "paid" | — |

`reasons[]` on a 409 is the *server's own* vocabulary for the durable condition
that failed: `claim_not_found`, `settlement_already_in_flight`,
`not_in_pending_settlement:<status>`, `no_durable_approval`,
`settle_at_not_elapsed`, `release_lock_lost`. The console renders these verbatim
and never invents a translation.

`reason_code` is the stable PHASE 3 catalog entry for the refusal, and
`operator_message` / `next_action` are its actionable text. The catalog includes
(at least): `claim_not_found`, `claim_data_unreadable`, `item_missing`,
`agent_missing`, `category_missing`, `payout_paused`,
`claim_not_pending_settlement`, `settlement_already_in_flight`,
`durable_approval_missing`, `settlement_window_open`, `release_lock_lost`,
`release_state_changed`, `approval_snapshot_mismatch`,
`approval_snapshot_unreadable`, `payout_rows_missing`,
`payout_rows_unreadable`, `ledger_amount_mismatch`,
`ledger_destination_mismatch`, `destination_not_eligible`,
`payout_outcome_unresolved`, `submission_history_unknown`, `provider_refused`,
`provider_accepted_unconfirmed`, `provider_outcome_ambiguous`,
`payout_already_sent`, `no_submittable_payout`, `simulation_not_permitted`,
`disbursement_wallet_missing`, `wallet_routing_refused`, `item_on_hold`,
`payout_recording_failed`, `internal_error`. `automatic_retry` is always
`false`: nothing in this system retries a payout on a timer.


### Notifications and social

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/notifications` | Notification failure console |
| POST | `/api/admin/notifications/:id/retry` | Retry one row |
| POST | `/api/admin/social/:id/retry` | Retry a social publication |

The notification retry route refuses any event outside the retry-eligible list.
See [notifications.md](notifications.md).

### Dashboard, settings and reports

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/dashboard` | Dashboard aggregates |
| GET | `/api/admin/lost-reports` | Lost report administration |
| GET | `/api/admin/settings/pause-status` | Current pause state |
| POST | `/api/admin/settings/pause` | Pause the platform |
| POST | `/api/admin/settings/social-publishing-pause` | Pause social publishing |

## Development only

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dev/test-mode` | Report whether simulation is enabled |
| POST | `/api/dev/simulate-payment/:claimId` | Drive a payment without a provider |

Guarded by `ENABLE_DEV_PAYMENT_SIMULATION` and `NODE_ENV`; both refuse in
production. Simulated payment is not a payment and produces no settlement.

## Related

- [architecture.md](architecture.md) — where the route boundaries sit
- [authentication.md](authentication.md) — the two session models
- [claims-and-payments.md](claims-and-payments.md) — payment semantics
- [agent-workflows.md](agent-workflows.md) — agent operations
- [operations.md](operations.md) — the administrator-facing recovery routes


| Method | Path | Purpose |
|---|---|---|
| POST | `/api/admin/items/:id/review` | Review a reported item |
| POST | `/api/admin/items/:id/reject` | Reject |
| POST | `/api/admin/items/:id/flag-stolen` | Flag as stolen |
| POST | `/api/admin/items/:id/legal-hold` | Place a legal hold |
| POST | `/api/admin/items/:id/clear-hold` | Clear a hold |
| GET | `/api/admin/categories` | List |
| POST | `/api/admin/categories` | Create |
| PUT | `/api/admin/categories/:id` | Update |
| PUT | `/api/admin/categories/:id/active` | Toggle active |
| DELETE | `/api/admin/categories/:id` | Delete |

A legal hold prevents a retention sweep from purging the record.

| POST | `/api/claims/:id/verify-otp` | Redeem the claim verification code |
| GET | `/api/claims/:id/status` | Claim status for the owner |
| POST | `/api/claims/:id/payment-session` | Create a payment session |
| POST | `/api/claims/:id/payment-session/:sessionId/initiate` | Issue the STK push |
| GET | `/api/claims/:id/payment-session/:sessionId/status` | Session status |
| POST | `/api/claims/:id/payment-auth` | Record payment authorisation |
| POST | `/api/claims/:id/pay` | Legacy payment entry point |
| POST | `/api/claims/:id/rate` | Rate the completed transaction |
| POST | `/api/claims/:id/pickup-details` | Submit pickup information |

Claim status polling is rate limited separately from the write routes.

Initiating a payment session records intent, not payment. See
[claims-and-payments.md](claims-and-payments.md).
