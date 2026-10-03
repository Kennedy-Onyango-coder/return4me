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
| POST | `/api/customer/login` | Request an SMS OTP |
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
| POST | `/api/auth/request-otp` | Public | Request an agent SMS OTP |
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

The webhook is the only authority on whether money moved. It is verified against
`INTASEND_WEBHOOK_SECRET`, its amount is reconciled against the persisted
payment session, and the escrow transition is a compare-and-swap so a repeated
delivery cannot pay twice. See [claims-and-payments.md](claims-and-payments.md).

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
| POST | `/api/admin/claims/:id/release-settlement` | Manual settlement |
| GET | `/api/admin/disputes/:disputeId/evidence` | Evidence view |
| POST | `/api/admin/disputes/resolve` | Resolve a dispute |
| GET | `/api/admin/payment-strikes` | Payment strikes |
| POST | `/api/admin/payment-strikes/:phone/clear` | Clear strikes |
| GET | `/api/admin/refund-reconciliation` | Refunds awaiting finalization |
| POST | `/api/admin/refund-reconciliation/:claimId/finalize` | Mark refunded |
| POST | `/api/admin/refund-reconciliation/:claimId/revert` | Revert |
| POST | `/api/admin/reputations/:phone/clear` | Clear a reputation record |

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
