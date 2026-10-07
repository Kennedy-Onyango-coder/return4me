# Architecture

Return4me is a single Node.js process that serves an HTTP API and the frontend
from the same origin, backed by PostgreSQL and a set of external providers. This
document covers the structure a maintainer needs in order to change it safely.
It is not a module index.

## Process shape

`src/server.ts` is the entry point. Under `npm run dev` it runs through `tsx`
and mounts Vite as middleware, so the frontend and API share one port and one
origin. Under `npm start` it runs as a bundled CommonJS file with the frontend
prebuilt into `dist/`.

The server is deliberately constructible without a listening socket. Route
handlers are registered against an app instance that tests can mount directly,
which is why the test suite exercises real routing rather than a parallel
implementation.

## Layers

| Layer | Location | Responsibility |
|---|---|---|
| Routes | `src/server.ts`, `src/routes/*` | HTTP concerns: parse input, authorize, call a service, shape a response |
| Services | `src/services/*` | Domain behaviour, provider calls, notification dispatch |
| Config | `src/config/*` | Pure policy and vocabulary with no database or network dependency |
| Persistence | `src/db/*` | Schema, queries, compare-and-swap operations |
| Frontend | `src/components/*` | React views |
| Shared vocabulary | `src/config/claimStatuses.ts` | Imported by both backend and frontend |

The `src/config` boundary is load-bearing. Pure policy modules are why the
claim lifecycle can be imported by a React component and a route without the
backend depending on the frontend, and why the notification event catalogue is
testable without a database or a provider.

## Route boundaries

Routes are split between `server.ts` and domain files under `src/routes/`. The
split is partial rather than complete: account, authentication, administration,
item review, dispute and location routes remain in `server.ts`, while claims,
payments, agent operations, categories, lost reports, public items, search and
the payment webhook live in their own modules.

Every route under `/api/admin/*` is authenticated and then checks
`req.user.role === 'admin'` inline. This is not decoration. The JWT middleware
authenticates but does not authorize, so without the inline role check a token
with any other role — including the intermediate `admin_pending_2fa` token —
would pass. A test audits this invariant across the route files.

Routes are listed in [api.md](api.md).

## Authentication boundaries

There are two independent session models, and they are not interchangeable.

**Agent and administrator requests use bearer authentication.** A JWT carries
the role and is sent in the `Authorization` header. Roles are `owner`, `finder`,
`agent`, `admin`, and `admin_pending_2fa`.

**Customer requests use a separate session cookie.** The session is a
server-side row in `customer_sessions`; the cookie carries a token that is
hashed before lookup. The cookie is `httpOnly`.

The separation is deliberate. A customer is not an agent and does not receive
an agent role, and folding the two into one role field would have meant granting
a customer the ability to present a token that a route reads as an agent. See
[authentication.md](authentication.md).

## Services

| Service | Responsibility |
|---|---|
| `auth.ts` | Agent/admin sessions, phone-keyed OTP, password verification |
| `customerAuth.ts` | Customer registration, login, activation tokens, session cookies |
| `notificationService.ts` | Event validation, idempotency, dispatch, outcome recording |
| `notificationRetry.ts` | Retry eligibility, reconstruction, CAS claiming |
| `notificationProviders.ts` | Provider boundary, failure classification, error sanitization |
| `email.ts` | Email templates |
| `smsRateLimit.ts` | Durable rolling-window SMS limit |
| `payments.ts` | IntaSend STK push and disbursements |
| `ocr.ts` | Document image analysis |
| `storage.ts` | S3-compatible object storage |
| `social.ts` | Telegram, Facebook and X publication |
| `geocoding/` | Forward and reverse geocoding, cache, provider off-switch |
| `adminPermissions.ts` | Role-to-permission grants |
| `adminSafeViews.ts` | Redacted projections for administrator views |


## Persistence

PostgreSQL through Drizzle ORM. The schema is declared in `src/db/schema.ts`
and mirrored in `sql/schema.sql` and `ensureSchemaUpToDate()`.

Correctness is carried by database constraints wherever a constraint can express
it, rather than by application checks alone. A check-then-insert in application
code loses to concurrency; a unique index does not. The three partial unique
indexes described in [database.md](database.md) each exist because the
application-level check they were paired with could not close a race.

`db/database.ts` is a data-access class over Drizzle, and its
`attempt*`-prefixed methods are compare-and-swap operations: they perform a
conditional update and return whether they won. A false return means another
worker got there first, and the caller must not proceed as if it succeeded.

## State machines

Two state machines carry most of the domain's correctness.

**Claim status** is governed by `CLAIM_ALLOWED_TRANSITIONS` in
`src/config/claimStatuses.ts`, a closed table of every legal edge. Anything not
listed is rejected, including every backward move out of a terminal status. The
`claims_status_check` constraint restricts which values may be stored at all, so
an undefined status cannot be written even by a bug.

**Notification event status** is a smaller machine with a `CHECK` constraint
covering `pending`, `sending`, `sent`, the three failure classes, and the
retained compatibility values. See [notifications.md](notifications.md).

Both machines are enforced in two places — the transition table in application
code and the constraint in the database — because a single check can be bypassed
by a concurrent writer.

## Notification architecture

`NotificationService` is the dispatch boundary; `notificationRetry.ts` is a
deliberately separate retry boundary. They share the durable row, the provider
boundary and the templates, but not the entry point, because `notify()` returns
early on an existing idempotency key and would therefore report a retry as a
duplicate.

Event names, channels and retry eligibility are declared once in
`src/config/notificationEvents.ts` and looked up, never duplicated at call
sites. See [notifications.md](notifications.md).

## Payment architecture

IntaSend issues an M-Pesa STK push; the customer approves on their handset. A
webhook from the provider is the only authority on whether money moved, and a
completed payment that the webhook misses is recovered through IntaSend's
authoritative payment-status API (on demand and via a background sweep). The
application never treats an initiated request as a payment, never trusts a
browser, and never marks a claim paid merely because an invoice exists.

The `pending_payment → escrow_held` move is a compare-and-swap. The provider can
deliver a webhook more than once, and without the CAS a duplicate delivery would
re-run the escrow side effects. Amounts are reconciled against the persisted
payment session, and a mismatch is refused rather than accepted. The claim's
payment window is 24 hours from agent confirmation; each individual STK attempt
has its own short session window and can be retried while the claim window stays
open.

Settlement is likewise a CAS, so an automatic sweep and an administrator's
manual release cannot both pay out.

See [claims-and-payments.md](claims-and-payments.md).

## External service boundaries

| Service | Purpose | Behaviour when unconfigured |
|---|---|---|
| PostgreSQL | Persistence | Required; the application cannot start |
| Resend | Email | Fails closed in production; sandbox console in development |
| Africa's Talking | SMS | Optional channel, off unless `SMS_ENABLED="true"`; when off it is not required to boot and no SMS is attempted |
| IntaSend | Payment | Payment routes refuse; the webhook still verifies |
| S3-compatible storage | Images and documents | Uploads fail; the request does not silently succeed |
| Google GenAI | OCR | Analysis is skipped; the item is still recorded |
| Geocoding provider | Location resolution | Disabled by default; no outbound request is made |
| Sentry | Error reporting | Disabled when the DSN is absent or a placeholder |
| Telegram / Facebook / X | Public notices | Skipped; publication rows record the failure |

The geocoding boundary is worth noting: `GEOCODING_PROVIDER` defaults to
disabled, and an unrecognised provider name disables rather than falling back to
a live provider someone meant to switch off.

## Related

- [api.md](api.md) — route reference
- [authentication.md](authentication.md) — the two session models in detail
- [claims-and-payments.md](claims-and-payments.md) — lifecycle and CAS operations
- [notifications.md](notifications.md) — the notification subsystem
- [database.md](database.md) — schema and constraints
- [configuration.md](configuration.md) — external service configuration

`adminSafeViews.ts` exists because administrator screens and claimant screens
must not show the same fields. Projection is done in one place so a field added
to a row cannot leak into an admin view by default.
