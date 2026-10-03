# Data and privacy

This document describes how the application handles personal data. It does not
set retention periods.

[DATA_RETENTION_POLICY.md](DATA_RETENTION_POLICY.md) is the authoritative
retention document. Every period, category and legal caveat lives there, and it
is marked as a draft awaiting legal sign-off. Nothing in this document should be
read as a retention rule, and no retention period is restated here.

## Categories of personal data

| Category | Where it lives |
|---|---|
| Contact details | `customers.phone`, `customers.email`, `agents.contact_email`, `agents.phone`, `claims.owner_phone`, `claims.owner_email`, `items.finder_phone`, `items.finder_email` |
| Identity documents | `claims.owner_id_proof_url`, `agents.id_document_photo_url`, `agents.shop_photo_url` |
| Authentication secrets | `admin_users.password_hash`, `admin_users.totp_secret`, `customers.password_hash` |
| One-time codes | `otp_codes`, `customer_otps`, `claim_otps`, `claim_pickup_codes` — all stored as hashes |
| Activation tokens | `account_activation_tokens` — stored as hashes |
| Sessions | `customer_sessions` — cookie tokens stored as hashes |
| Financial records | `ledger`, `payment_sessions`, `claims.payment_reference` |
| Behavioural signals | `phone_reputations`, `claim_payment_strikes` |
| Activity records | `audit_log` |

## Hashing

Anything that is a credential is stored as a hash, never in plaintext:

- One-time codes, in all four tables that hold them.
- Pickup codes.
- Activation tokens.
- Customer session cookie tokens.
- Document numbers, via salted HMAC with `DOC_HASH_SALT`.

The consequences are worth stating plainly. A hashed code cannot be recovered,
only compared — which is why a failed activation email cannot be retried and
reconstructed, and why a code is re-requested rather than re-sent.

The session token hashing means a leaked `customer_sessions` row does not yield
usable sessions.

`DOC_HASH_SALT` also salts the SMS rate-limit bucket keys, falling back to
`JWT_SECRET`. It must be set in production both for the hashing to be stable
across restarts and for rate-limit buckets to be shared between instances.

## Never persisted

Some things are deliberately absent from the database rather than protected in
it:

- **Provider credentials.** API keys for Resend, Africa's Talking, IntaSend,
  storage, OCR and social platforms are read from the environment and never
  written to a row.
- **Rendered message bodies.** A notification row holds a template identifier and
  a reference to the authoritative record, not the text that was sent. This is
  what allows a retry to re-derive content without having stored it.
- **Plaintext recipient addresses in notification rows.** Recipients are
  referenced.
- **Raw IP addresses and phone numbers in the rate-limit table.** Bucket keys are
  salted hashes, and the `ip` and `user` namespaces are disjoint.
- **Raw one-time codes**, anywhere.
- **Raw document numbers.** Only the salted hash is stored.

## Notification privacy

The notification path is built so that a durable record of what was sent does not
become a durable record of what it said.

Recipients are referenced rather than copied, so an address change is reflected
when a retry re-derives the recipient rather than being frozen at first dispatch.
Provider error text is sanitized before storage, so provider responses do not
appear verbatim in `last_error`.

## Operational and financial records

Most rows in this system carry two different kinds of information at once: who
the person is, and what the transaction was. Retention and erasure treat those
differently.

Erasure operates on the identity layer. Financial and audit facts — amounts,
timestamps, claim identifiers, ledger entries, status transitions — are
preserved, because a payment record that has lost the fact of what it paid for
cannot answer a financial question or support an audit.

This is the same principle [DATA_RETENTION_POLICY.md](DATA_RETENTION_POLICY.md)
formalizes. It is implemented in `db.purgeUserData`.

## Erasure

`POST /api/auth/request-data-deletion` triggers `purgeUserData`, which removes or
anonymizes the caller's identity-layer data while preserving the financial and
audit facts described above.

Erasure also removes behavioural signals — `phone_reputations` and
`claim_payment_strikes` are deleted outright rather than anonymized, because a
scored identity with no identity attached has no remaining purpose.

The `audit_log` is an explicit exception and survives erasure. Its purpose is to
be the proof that erasure requests were honoured, so it cannot itself be removed
by the erasure it records. See
[DATA_RETENTION_POLICY.md](DATA_RETENTION_POLICY.md) for the reasoning.

## Audit records

`audit_log` records administrative actions, security events and erasure
requests with actor and timestamp. It is written on privileged actions so that
who-did-what remains answerable independently of the records those actions
changed.

Because it is designed to be an unbroken record, it is not anonymized on
erasure. This is a deliberate trade-off, not an oversight.

## Administrative views

`adminSafeViews.ts` produces redacted projections for administrator screens.
Projection is centralized so a field added to a row cannot leak into an
administrator view by default.

Administrator screens and claimant screens deliberately do not show the same
fields. Public-facing routes return a restricted DTO, and the public claim
lookup returns candidate data without the fields that would identify the owner.

## Related

- [DATA_RETENTION_POLICY.md](DATA_RETENTION_POLICY.md) — authoritative retention schedule
- [notifications.md](notifications.md) — what a notification record does and does not hold
- [authentication.md](authentication.md) — hashing and session handling
- [database.md](database.md) — where each category is stored
- [configuration.md](configuration.md) — secret handling
