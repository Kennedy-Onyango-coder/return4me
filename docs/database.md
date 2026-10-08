# Database

PostgreSQL, accessed through Drizzle ORM. The schema is declared in
`src/db/schema.ts` and mirrored in `sql/schema.sql` and
`ensureSchemaUpToDate()` in `src/db/index.ts`, so a database created by either
path ends up with the same constraints.

This document covers the tables, relationships and constraints that carry
application correctness. It is not a column-by-column reference; the schema
file is that.

## Table groups

| Group | Tables |
|---|---|
| Identity | `customers`, `customer_sessions`, `customer_otps`, `account_activation_tokens`, `admin_users`, `otp_codes` |
| Agents | `agents` |
| Items | `items`, `categories`, `lost_reports`, `item_verification_changes` |
| Claims | `claims`, `claim_otps`, `claim_pickup_codes`, `customer_claim_links`, `disputes`, `dispute_evidence` |
| Money | `ledger`, `payment_sessions`, `claim_payment_auth`, `claim_payment_strikes` |
| Notifications | `notification_events`, `sms_rate_limit_buckets` |
| Platform | `platform_settings`, `social_publications`, `phone_reputations`, `audit_log` |

## Core relationships

```
categories 1--n items 1--n claims
                     items 1--1 lost_reports
                     items n--1 agents (items.assigned_agent_id)
                     items 1--n item_verification_changes
claims 1--1 claim_pickup_codes
claims 1--1 claim_otps
claims 1--1 claim_payment_auth
claims 1--n payment_sessions
claims 1--n ledger
claims n--1 disputes
customers 1--n customer_sessions
customers 1--n customer_otps
customers n--n claims (customer_claim_links)
```

`customer_claim_links` is a join table rather than a column on `claims`, because
a customer may hold several claims and the link is itself a navigational
surface — the customer dashboard reads it directly, and unlinking a claim is a
supported operation.

## Constraints that carry correctness

Most of the schema is ordinary columns. The constraints below are the ones where
weakening one would change what the application guarantees.

### One live claim per item

`uq_claims_one_active_per_item` is a partial unique index on `claims.item_id`,
excluding statuses in `CLAIM_SLOT_EXCLUDED_STATUSES`.

It excludes `disputed` and `refunding` because a dispute legitimately puts two
claims on one item, and a refunding loser coexists with the winner. Excluding
the full inactive set instead would make filing a dispute violate the index
outright.

This index exists because the application check cannot close the race. Two
near-simultaneous claim submissions could both pass a check-then-insert before
either commits; the index is what actually guarantees at most one.

### One unresolved dispute per item

`uq_disputes_one_unresolved_per_item` is a partial unique index on
`disputes.item_id` where `resolved_at IS NULL`. Same reasoning: the
application-level check narrows the window but cannot close it.

### One session per provider invoice

`uq_payment_sessions_provider_invoice` is a partial unique index on
`provider_invoice_id` where it is not null. It makes it impossible for one
provider invoice to be associated with two payment sessions, so a replayed or
misrouted webhook cannot pay a second claim.

### Notification idempotency

`uq_notification_events_idempotency` is a unique index on `idempotency_key`.

This is the duplicate-suppression guarantee, and it is enforced by the database
rather than by an application read-then-insert. Two concurrent requests carrying
the same key produce one row; the second fails at the database rather than in a
race between two application instances.


### Activation token scope

`account_activation_tokens_purpose_check` forces the purpose to
`email_activation`, and `account_activation_tokens_account_type_check` forces the
account type to `customer` or `agent`.

Together they mean a token cannot be filed under one account type or purpose and
later redeemed as something it was never issued for, independent of application
code being correct.

### Claim status vocabulary

`claims_status_check` restricts `claims.status` to the twelve legal values. The
transition table in `src/config/claimStatuses.ts` restricts which *moves* are
legal. Both are needed: the constraint stops an undefined status being stored,
and the table stops an illegal move — neither alone is sufficient, and a
concurrent writer can defeat an application check that the database would catch.

### Payout submission outcome

`ledger_payout_outcome_check` restricts `ledger.payout_outcome` to the payout
submission vocabulary listed in
[claims-and-payments.md](claims-and-payments.md). The predicate is generated from
`PAYOUT_OUTCOME_VALUES`, so the Drizzle definition, `sql/schema.sql` and the
runtime DDL cannot drift apart.

The column is nullable with no default, and every pre-existing row is left NULL.
NULL means "no submission history is recorded", which the settlement executor
treats as unresolved and never re-sends. That is deliberately different from
`not_submitted`, which is written positively when a payout is booked: "never
submitted" has to be a recorded fact, not an inference from a missing value,
because the two readings authorize opposite actions (send vs. do not send).
New payout rows are booked as `not_submitted`; the runtime migration adds the
column with `ADD COLUMN IF NOT EXISTS`, re-asserts the constraint by drop-then-add,
and performs no backfill.

### Social publication uniqueness

`uq_social_pub_item_platform_type` is a unique index on `item_id`, `platform` and
`publication_type`, so one item is not published twice to the same platform for
the same purpose.

### Customer uniqueness

`uq_customers_phone` and `uq_customers_email` make both the phone number and the
email address unique, so one person cannot hold two customer accounts and split
their claim history or their erasure across both.

### Claim links

`uq_customer_claim_links_pair` on `(customer_id, claim_id)` and
`uq_customer_claim_links_claim` on `claim_id` alone. The second is the stronger
constraint: a claim belongs to at most one customer, so a claim cannot be
simultaneously presented by two accounts.

## Notification events

`notification_events` is the durable record of every dispatched message, and its
columns and lifecycle are described in
[notifications.md](notifications.md). Two points belong here because they are
schema decisions.

`attempt_count` has always meant successful provider acceptances. The retry
counter is a separate column, `retry_attempt_count`. Redefining the original
column would have made historical values ambiguous.

The retry columns are nullable, so existing rows stay valid and nothing is
backfilled or resent when the retry lifecycle is introduced.

## Rate-limit buckets

`sms_rate_limit_buckets` holds a keyed hash of an identity, never a raw IP, user
ID or phone number. A row supports abuse investigation without becoming a log of
who visited from where.

A table is used because the in-process alternative cannot survive a restart and
cannot be shared between instances. See [notifications.md](notifications.md).

## Audit log

`audit_log` is written on privileged actions and is designed to be an unbroken
record. It is not anonymized on erasure, because its purpose is to be the proof
that erasure was honoured. See
[DATA_RETENTION_POLICY.md](DATA_RETENTION_POLICY.md).

## Financial records

`ledger`, `payment_sessions` and `claim_payment_strikes` are the financial and
behavioural record. They are preserved through erasure of the identity layer, for
the reasons in [data-and-privacy.md](data-and-privacy.md).

## Related

- [claims-and-payments.md](claims-and-payments.md) — the lifecycle these tables record
- [data-and-privacy.md](data-and-privacy.md) — what is stored and what is erased
- [notifications.md](notifications.md) — the `notification_events` lifecycle
- [architecture.md](architecture.md) — why constraints rather than application checks

The accompanying `CHECK` constraints on `notification_events` restrict `channel`
to `sms` or `email` and `status` to the known lifecycle vocabulary, so an
unknown channel or an undefined state cannot be recorded even by a bug. They are
declared identically in all three places the schema is defined.

`status` retains `failed` so pre-existing rows stay valid — it means "failed
before the retry lifecycle existed" and is treated as terminal. The `fallback_*`
values are retained for schema compatibility and are unused.
