# Payment and payout launch readiness

This document records what has actually been verified about the collection and
payout lifecycle after Batches 1.1, 2 and 3, and what has not. It is written for
an operator deciding whether the money path may be declared operational.

**No production money movement was performed to produce this document.** No real
payout, refund, wallet transfer or settlement was initiated, no production data was
mutated and no production configuration was changed. Everything below is either an
automated test, a static inspection of this repository, or an explicitly labelled
gap.

## The five categories

| Category | Meaning |
| --- | --- |
| **Automated test** | An executable assertion in this repository passed on the exact committed bytes. |
| **Static inspection** | The behaviour was read in the source and is pinned by a source-contract test; no runtime exercised it. |
| **Sandbox** | Verified against an IntaSend sandbox account. **Nothing in this repository has been** — see below. |
| **Production configuration only** | The code's handling of configuration was inspected; the live deployment's values were not read by this work. |
| **Unverified / blocked** | Needs provider support, credentials, a dashboard action or a production observation. |

## 1. Verified by automated tests

- Collection → webhook → escrow, including amount reconciliation, duplicate and
  out-of-order delivery, and the payment-window expiry race
  (`lifecycleHttpE2E`, `paymentReconciliation`, `webhookAmountReconciliation`,
  `paymentConfirmationOrdering`).
- Payout initiation contract: documented endpoint, per-leg idempotency key,
  BP103 "Preview and approve" handling, ambiguous (5xx/408) outcomes
  (`payoutInitiationContract`).
- Pre-submission gates and their ordering — destination policy, booked-ledger
  amount/destination integrity, approval snapshot, simulation refusal, wallet
  routing — all before the per-row submission markers and the provider call
  (`payoutGateOrdering`, `settlementAuthorizationEnforcement`).
- Approval durability: CAS-guarded approval, snapshot written in the same
  transaction, repeat approval cannot rewrite who/when/what, ineligible claims
  report their real reason (`settlementAuthorizationSnapshot` db suite,
  `settlementReconciliation`).
- Payout integrity: an attempt that does not match its booked ledger row, or the
  approval's total/rows, sends nothing, marks nothing submitted and returns the
  claim to `pending_settlement` (`settlementPayoutAuthorization`, including the
  ledger-row drift case).
- Wallet routing: a missing/placeholder payout wallet and a payout wallet that
  equals the settlement wallet both refuse before any provider request
  (`walletRouting`, `walletRoutingEnforcement`, `payoutInitiationContract`).
- Schema parity: the new approval-snapshot columns are declared in the drizzle
  schema, the bootstrap SQL and the idempotent migration
  (`settlementAuthorizationEnforcement`, `schemaSyncIdempotency`).


### Full-suite result (the strongest available run)

`node node_modules/vitest/vitest.mjs run` — **286 files: 250 passed / 36 failed;
5,480 tests: 5,310 passed / 170 failed**, exit 1.

- **None of the 170 failures is in a payment, payout, wallet or settlement suite.**
  Every `FAIL` line was matched against `settlement|wallet|payout|payment` and
  produced no matches.
- All failing files are outside the files this queue changed: `git diff --name-only
  6857bc3..HEAD` lists 23 files, and none of them is a failing suite.
- The failures are concentrated in unrelated Admin Console copy/2FA, public
  recognition/masking and navigation/accessibility suites — the area with a
  documented history of pre-existing copy failures in this repository.
- **Honest limit:** the full suite was not baselined before this queue, so this
  report does not claim those 170 failures pre-date it. It claims only what is
  evidenced: they are in files these commits did not touch and outside the audited
  money lifecycle. The money-path suites listed above were run directly and pass.

## 2. Verified by static inspection

- **No second money path.** There is no wallet-balance read, wallet-list call or
  intra-wallet transfer anywhere in `src/`; the only money-moving calls are the
  STK collection, the payout batch and the refund, each in one place
  (`walletRoutingEnforcement`).
- **Wallet routing cannot silently fall back.** In production, a missing,
  blank or placeholder-shaped working-wallet ID refuses the payout, and a
  declared settlement-wallet identity that equals the payout wallet refuses it
  too — before any marker and before the request body exists.
- **Approval and initiation are separate operations.** The approval route writes
  no money and calls no provider; initiation requires the durable approval plus an
  elapsed `settle_at` plus a release CAS. `approve-and-pay` is a wrapper over the
  same two steps, not a third path.
- **No PII in the new records.** Approval audit rows carry the total and ledger
  row ids; wallet refusals carry masked wallet IDs; payout attempts carry masked
  destinations. No full phone number or wallet ID is written to `audit_log`.
- **Unknown provider outcomes are not retried.** A 5xx/408 is recorded as
  `unknown`, a non-2xx refusal as `rejected`, acceptance as `accepted`; none is
  reported as paid, and a row that may have moved money is never resubmitted
  automatically.
- **The Admin Console does not overclaim.** The confirmation steps say the action
  *starts* payout processing, that nothing has been sent yet, and that the
  provider's result is reported separately; the locked figure is now labelled a
  **claim fee** rather than an amount "released" (it includes the platform share).


## 3. Verified in sandbox

**Nothing.** No IntaSend sandbox credentials were used in this work, and no
sandbox request was made. Every provider interaction described above was exercised
against a stubbed `fetch` (mocked tests), not against the provider.

## 4. Verified in production configuration only

- The boot log reports whether a payout wallet is configured and whether a
  settlement-wallet identity is declared, without printing either value.
- Production payouts require `INTASEND_DISBURSEMENT_WALLET_ID`; the placeholder
  value shipped in `.env.example` is rejected by the same convention as every other
  credential.
- The live deployment's actual environment values were **not** inspected by this
  work; whether they are configured correctly is an operator verification.


## 5. Still unverified or blocked

| Item | Why it is unverified | What would verify it |
| --- | --- | --- |
| `POST /send-money/initiate/` against this merchant account | The path is documented, but no request has ever been made with real credentials | A sandbox payout to a controlled number, then a production observation |
| Whether collections can settle into the working wallet | The STK request has no wallet field; provider-side configurability is unknown | An answer from IntaSend support / dashboard confirmation, then a test collection |
| Settlement→working-wallet transfer | Documented but never executed against this account; no documented idempotency key | A sandbox `intra_transfer` with balance checks before and after |
| Wallet balances and statements | The application never reads them | An authenticated wallet list/statement read |
| Webhook delivery semantics under provider retry | Modelled and tested locally; provider retry behaviour is not observed | A sandbox webhook replay |
| Rate limiting across instances | `express-rate-limit`'s default store is process-local | A shared store or a deployment-level control |
| Approval-time destination snapshot | Destinations are bound via the immutable ledger row, not copied onto `claims` | Accepted design; no further verification needed |
| Admin Console display of the approved total | Shown as who/when only | A UI change (the backend already refuses mismatches) |

## 6. Required manual configuration and deployment steps

1. Apply the Batch 3 migration before deploying its code:
   ```sql
   ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_authorized_total NUMERIC(10,2);
   ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_authorized_ledger_ids TEXT;
   ```
2. Confirm `INTASEND_DISBURSEMENT_WALLET_ID` is a real KES working wallet with
   `can_disburse: true`.
3. Optionally declare `INTASEND_SETTLEMENT_WALLET_ID` so the payout/settlement
   identity check is active; leave it empty if the ID is unknown.
4. Keep the working wallet funded through the documented operator procedure; no
   code path moves collected float.

## 7. Remaining risks

- **Approvals recorded before Batch 3** carry no snapshot and are paid bound to
  their booked ledger rows (`SETTLEMENT_AUTHORIZATION_SNAPSHOT_MISSING`). That is
  deliberate (approval is immutable), but it is a weaker guarantee than a new
  approval.
- **Refused payouts require operator remediation.** A destination/ledger/approval
  mismatch leaves the claim in `pending_settlement` with nothing sent; correcting
  the underlying data is a database/provider action, not a console control.
- **The provider contract remains the largest unverified dependency.** Until a
  sandbox payout succeeds, "the payout works end to end" is not a claim this
  repository can make.
