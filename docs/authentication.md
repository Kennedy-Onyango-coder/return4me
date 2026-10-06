# Authentication and authorization

This document covers two things the codebase keeps deliberately separate:
authentication, which establishes who is making a request, and authorization,
which decides what that principal may do.

## Two session models

| | Agent and administrator | Customer |
|---|---|---|
| Credential | JWT bearer token | Server-side session cookie |
| Carried in | `Authorization` header | `r4m_customer_session` cookie |
| Server state | None; the token is self-contained | A row in `customer_sessions` |
| Lifetime | Token expiry | 7 days |
| Revocation | `token_version` on the admin row | Delete the session row |

The customer session cookie is `httpOnly`, and the token it carries is hashed
before it is looked up, so a stolen database row does not yield a usable
session. A customer is never issued a role-bearing JWT.

## Roles

The JWT role is one of:

| Role | Meaning |
|---|---|
| `owner` | A claimant acting on their own claim |
| `finder` | A reporter acting on their own item |
| `agent` | A registered agent acting on their assigned items |
| `admin` | A full administrator session |
| `admin_pending_2fa` | Password verified, second factor not yet presented |

`admin_pending_2fa` is a separate role value rather than a flag on `admin`, and
that distinction does the work. Every admin route checks `role === 'admin'`
exactly, so a pending token fails all of them automatically without any route
needing to know that two-factor authentication exists. If it were a flag, every
route would need a second condition, and one that was forgotten would be a
privilege escalation.

The repository has exactly one administrator role. There is no reviewer,
support, finance or super-admin role, and no permissions column. See
[archive/ROLE_SEPARATION_PLAN.md](archive/ROLE_SEPARATION_PLAN.md) for the
recorded analysis and the proposed tiering, which is not implemented.

## Administrator login

1. `POST /api/auth/admin-login` verifies the username and password.
2. If the administrator has no TOTP enrolled, a full `admin` token is issued.
3. If TOTP is enrolled, a short-lived (5 minute) `admin_pending_2fa` token is
   issued instead, along with the account's identity.
4. `POST /api/auth/admin-login/verify-2fa` exchanges that pending token plus a
   valid TOTP code for a real `admin` session. A missing, expired or
   already-consumed pending token is rejected with a bilingual message asking the
   user to start over.

TOTP is implemented with the `otpauth` library. See
[data-and-privacy.md](data-and-privacy.md) for how the secret is stored.

## Administrator session revocation

Admin sessions carry a `token_version` from the `admin_users` row, and
`requireCurrentAdminSession` compares the token's value against the current one.
Deactivating an administrator or incrementing the version therefore invalidates
issued tokens without waiting for expiry.

## Agent authentication

An agent authenticates by phone number and a one-time code:

1. `POST /api/auth/request-otp` — emails a one-time code to the agent's address:
   the verified contact address on the account, or the address given at the
   onboarding step when no agent row holds the phone yet. The destination is
   resolved server-side in both cases.
2. `POST /api/auth/verify-otp` — verifies the code and issues a bearer token.

Agent operational routes additionally require that the agent is currently active
and approved. Checking the JWT role alone is not sufficient: a suspended agent
whose token still had hours of validity left would otherwise be able to act.

Agent registration additionally requires email activation before the agent can

## Customer authentication

| Endpoint | Purpose |
|---|---|
| `POST /api/customer/register` | Create an account, send activation email |
| `POST /api/customer/activate` | Redeem an activation token |
| `POST /api/customer/login` | Request an email OTP |
| `POST /api/customer/login/verify` | Redeem the OTP and set the session cookie |
| `POST /api/customer/logout` | Delete the session row, clear the cookie |
| `GET /api/customer/me` | Current customer |
| `POST /api/auth/request-data-deletion` | Erasure request |

Customer OTP parameters: 5 minute lifetime, 5 attempts before the code is
deleted, and a 30 second resend floor to control repeated sends. (`CUSTOMER_OTP_RESEND_MS`
in `src/services/customerAuth.ts`; it predates the E1 email migration and is now a
send-volume floor rather than an SMS-cost one.)

A customer may file a claim without an account, using the claim-scoped OTP
instead. Account sessions and claim OTPs are separate credential systems; the
claim OTP deliberately uses the same generation, hashing and expiry rules as the
customer OTP so there is one OTP implementation to reason about.

## Email activation

Customer and agent activation share a shape but not a token store. Each has its
own token TTL constant and its own URL builder, because a shared "kind"
argument would invite one account type's token being redeemed as the other's.

| | Customer | Agent |
|---|---|---|
| Token | 32 bytes from `crypto.randomBytes` | same |
| Stored as | Hash only | Hash only |
| TTL | 24 hours | 24 hours |
| URL path | `/activate-email` | `/activate-agent-email` |
| Notification event | `CUSTOMER_EMAIL_ACTIVATION` | `AGENT_EMAIL_ACTIVATION` |

Two database `CHECK` constraints back this up. `account_activation_tokens_purpose_check`
forces the purpose to `email_activation`, and
`account_activation_tokens_account_type_check` forces the account type to
`customer` or `agent`. Together they mean a token cannot be filed under one
account type or purpose and later redeemed as something it was never issued for,
even if application code were wrong.

If the activation email cannot be sent, registration returns 503. See
[notifications.md](notifications.md).

Activation links are built from `PUBLIC_APP_URL`, falling back to
`http://localhost:3000` when it is unset. In production an unset value produces
activation links pointing at localhost, which cannot be followed by the
recipient. This is the most consequential configuration gap in the application.
See [configuration.md](configuration.md).

## One-time codes

Every one-time code in the system — customer login, agent login, claim
verification, claim linking, customer registration — is stored as a hash and
compared by hash. No code is persisted in plaintext, and no code appears in a
notification row, a log line or an administrator view.

Codes are generated with `crypto.randomInt(1000, 10000)`, giving a four digit
code.

Attempt ceilings:

| Flow | Max attempts | Lifetime |
|---|---|---|
| Customer OTP | 5 | 5 minutes |
| Claim OTP | 5 | 5 minutes |
| Claim link OTP | 5 | 5 minutes |

Reaching the ceiling deletes the code rather than merely refusing further
attempts, so a new code must be requested.

`ALLOW_MOCK_OTP_BYPASS` allows a code to be bypassed without dispatching any
message. It
is read only when `NODE_ENV` is not production, and it does not cover email
activation, which has no bypass path. See [configuration.md](configuration.md).

## Authorization boundaries

Authentication is applied by the JWT middleware and the customer session
resolver. Authorization is applied separately, at the route.

- **Admin routes** require `role === 'admin'` inline, plus a current session
  check, plus a named permission for some areas.
- **Agent routes** require the `agent` role, and separately require the agent to
  be currently active.
- **Claim-scoped routes** require the caller to be the registered owner of the
  claim, identified by the registered phone number. A mismatch is refused by a
  single shared ownership check rather than per-route logic.
- **Customer routes** require a valid customer session, and customer claim routes
  additionally verify the claim is linked to that customer.

`adminPermissions.ts` maps the admin role to a set of named permissions. Every
non-admin role, including `admin_pending_2fa`, holds none — by construction,
because the grant table only names `admin`. The permission check independently
re-asserts `role === 'admin'`, so the grant table cannot be misread as authority
in its own right.

## Failure behaviour

Authentication failures return 401 and authorization failures 403, and the
distinction is deliberate: a 403 tells a caller the request was understood and
refused, while a 401 means the credential was not accepted.

A pending-2FA admin token on an admin route returns 403, not 401. The token is
validly signed and unexpired; it simply is not authorized. This is covered by
tests on the claims and lost-report admin routes.

User-facing authentication failure messages are bilingual (English and Swahili).

## Related

- [architecture.md](architecture.md) — where the session boundaries sit
- [agent-workflows.md](agent-workflows.md) — agent approval and activation
- [notifications.md](notifications.md) — how codes and activation emails are sent
- [data-and-privacy.md](data-and-privacy.md) — hashing and erasure
- [configuration.md](configuration.md) — secret and bypass configuration

operate. See [agent-workflows.md](agent-workflows.md).
