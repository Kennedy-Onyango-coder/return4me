# IntaSend provider verification checklist

This document is the operational checklist for verifying the IntaSend contract that
Return4me's money path depends on. It records **what is documented, what this
repository proves, and what is still unverified** — and it is deliberately not a
claim that the provider has been verified.

**Nothing in this review contacted IntaSend.** No API request was made, no balance
was read, no transfer, payout, refund or collection was initiated, no sandbox
credentials were exercised and no production configuration was read or changed.
The evidence below is static inspection of this repository plus the provider
contract already recorded in [`operations.md`](operations.md) (retrieved from
IntaSend's published OpenAPI document). Retrieving the provider's documentation
online returned empty results during this work; that is recorded as a **gap**, not
as verification.

Credential values, full wallet identifiers and customer data are never reproduced
here. Wallet IDs appear only as masked forms, as in the application's own logs.

## Evidence vocabulary

| Label | Meaning |
| --- | --- |
| **In-repo proven** | An executable test or a pinned source contract in this repository proves the *application's* behaviour. |
| **Documented** | IntaSend's published contract says so. This is the provider's claim, not this account's observed behaviour. |
| **Account-confirmed** | Observed against Return4me's own merchant account. **Nothing in this document is in this class.** |
| **Unverified** | No evidence either way for this merchant account. |
| **Blocked** | Verification cannot start without something only the account owner or IntaSend can supply. |
| **Operator action** | A dashboard/account step, not a code change. |

## Status summary

| # | Checklist item | Status | Evidence | Next action |
| --- | --- | --- | --- | --- |
| 1 | Merchant account and production wallet identity | **Blocked / operator action** | No account read was performed. The code never verifies a wallet's existence, currency or capability; it only refuses a missing/placeholder/duplicate ID (`src/config/walletRouting.ts`, `walletRoutingEnforcement.test.ts`). | Account owner confirms the merchant entity and the KES settlement + working wallets in the IntaSend dashboard. |
| 2 | Can collections select the working wallet? | **Unverified (selector coded, provider acceptance unconfirmed)** | By default the STK request body is exactly `public_key`, `phone_number`, `amount`, `api_ref` (`src/services/payments.ts`, `triggerMpesaStkPush`). The optional, default-off `INTASEND_COLLECTION_WALLET_ID` appends a fifth `wallet_id` field only when `NODE_ENV` is exactly `production` and the value is real; a placeholder refuses the collection before any provider call (`src/config/walletRouting.ts`, `resolveCollectionWalletRouting`). Whether IntaSend honours `wallet_id` on this endpoint for this merchant account is unknown. | Support question Q2/Q3, then a controlled collection before enabling the variable. |
| 3 | Settlement / working-wallet capabilities and balance visibility | **Documented (capabilities) + unverified (account)** | `wallets/?currency=KES&wallet_type=…` returns `WalletSer` with `wallet_type`, `can_disburse`, `current_balance`, `available_balance` (`docs/operations.md`). The application performs **no** balance or wallet-list read anywhere in `src/` (pinned by `walletRoutingEnforcement.test.ts`). | Operator reads balances during the sandbox rehearsal; record masked IDs only. |
| 4 | Settlement→working-wallet transfer mechanism | **Documented + unverified** | `POST {base}/wallets/{id}/intra_transfer/`, `{id}` = **source (debited)**, body `wallet_id` = **destination (credited)**, body also needs `amount`, `narrative` (`docs/operations.md`). Never executed against this account; the field names read backwards and a reversed pair still returns 200. | Sandbox rehearsal with a deliberately small amount and before/after balance reads. |
| 5 | Transfer fees, limits, processing times, transaction references | **Blocked** | Not documented in this repository and not retrievable during this review (web fetch returned empty). | Support questions Q7–Q9. **Do not assume zero fees or instant settlement.** |
| 6 | Payout initiation, idempotency, status lookup, finality | **Documented + in-repo proven (client side); account-unverified** | `POST /send-money/initiate/` with per-transaction `idempotency_key` documented as "a repeat request with the same key is rejected"; status via `POST /send-money/status/` with `tracking_id`; `BP103` = "Preview and approve" means the batch pays nothing until approved out of band. Client behaviour pinned by `payoutInitiationContract`, `payoutGateOrdering`. | Sandbox payout to a controlled number; observe duplicate-key rejection and a `BP103` batch. |
| 7 | Webhook signatures, retries, duplicates, ambiguous outcomes | **In-repo proven (receiver) + unverified (provider)** | The collection route authenticates a **challenge** value, not an HMAC signature (`src/routes/webhooks.ts`, `challengeMatches`); `INTASEND_WEBHOOK_SECRET` is deprecated and unread. Duplicate/out-of-order delivery is safe locally (amount reconciliation + compare-and-swap, `paymentConfirmationOrdering`, `webhookAmountReconciliation`). The payout webhook is treated as a hint and re-read from the API. Provider retry schedule/signing is unknown. | Support questions Q14–Q15; sandbox replay of a webhook. |
| 8 | Sandbox credentials and required capabilities | **Blocked** | No sandbox account was used. A local `.env` exists containing `INTASEND_PUBLISHABLE_KEY`, `INTASEND_SECRET_KEY` and the deprecated `INTASEND_WEBHOOK_SECRET` **names**; values were not read, printed or used, and whether they are sandbox keys is unknown. `INTASEND_WEBHOOK_CHALLENGE` and `INTASEND_DISBURSEMENT_WALLET_ID` are absent from that local file. | Account owner supplies a sandbox merchant account with a funded KES working wallet, `can_disburse: true`, and an approved test recipient. |
| 9 | Evidence to retain before production activation | **Operator action** | Checklist below. | Collect and store each item before go-live. |
| 10 | Questions for IntaSend support | **Ready to send** | Questionnaire below. | Submit; attach the answers to the release record. |

## 1. Merchant account and production wallet identity

**What the code does and does not do.** `getDisbursementWalletId()` reads
`INTASEND_DISBURSEMENT_WALLET_ID`; `isDisbursementWalletConfigured()` rejects an
absent, blank or placeholder-shaped value using the repository-wide
`isPlaceholderKey` convention. In production, `resolveConfiguredPayoutWalletRouting()`
additionally refuses a payout wallet that equals the declared
`INTASEND_SETTLEMENT_WALLET_ID` (`PAYOUT_WALLET_ROUTING_REFUSED`, masked IDs in the
audit row).

**What the code cannot tell you.** That the configured ID exists, belongs to this
merchant account, is KES-denominated, or has `can_disburse: true`. Those are
provider-side facts and are checked only when a request is made.

**Verification steps (operator, read-only).**

1. Confirm the merchant entity, the KES settlement wallet and the KES working
   wallet in the IntaSend dashboard.
2. Record each wallet's `wallet_type`, `currency`, `can_disburse` and masked ID
   (first 4 + last 4 characters).
3. Confirm the working-wallet ID equals `INTASEND_DISBURSEMENT_WALLET_ID` in the
   production environment byte for byte (no whitespace, no placeholder).
4. Confirm the settlement-wallet ID, if declared, differs from the working wallet.

**Status: blocked** until an account owner performs steps 1–4.

## 2. Can the collection integration select the working wallet?

The application sends `POST {base}/payment/mpesa-stk-push/` with exactly
`public_key`, `phone_number`, `amount`, `api_ref`. There is **no** wallet field, so
the application cannot route a collection regardless of how the account is
configured. Consequences:

- collections land wherever IntaSend puts them (documented as the KES settlement
  wallet);
- moving funds into the working wallet is an out-of-band operator step
  (`docs/operations.md`), not an application behaviour;
- if the provider supports a dashboard-level "settle into working wallet"
  setting, the application neither knows nor depends on it — but the operator's
  float procedure does.

**Status: unverified.** The code-side fact (no selector) is proven; the
provider-side configurability is not.

## 3. Settlement and working-wallet capabilities, and balance visibility

Documented `WalletSer` fields include `wallet_id`, `label`, `currency`,
`wallet_type`, `can_disburse`, `current_balance`, `available_balance`,
`updated_at`. A working wallet with `can_disburse: false` cannot pay out however
much float it holds (`docs/operations.md`).

The application reads **none** of these. There is no wallet-balance read,
wallet-list call or intra-wallet transfer in `src/`; a source-invariant test fails
if one is added. This is a deliberate control: the console can never present a
settlement balance as available payout float.

**Status: documented (fields) / unverified (this account).**

## 4. Settlement→working-wallet transfer

Documented as `POST {base}/wallets/{id}/intra_transfer/`:

| Element | Documented meaning |
| --- | --- |
| `{id}` in the path | the wallet being **debited** (source) |
| `wallet_id` in the body | the wallet being **credited** (destination) |
| `amount` | decimal string, ≤ 9 integer digits, 2 decimal places |
| `narrative` | string; must not contain `<`, `>`, `%`, `;`, `$`, `?` |

Two hazards are recorded in the runbook: the pair reads backwards, and **no
idempotency key is documented anywhere in the specification**, so a timeout or 5xx
leaves the outcome genuinely unknown and a blind retry can move money twice.
`ConfirmTransferOTP` / `ResendTransferOTP` operations exist, but whether an
internal transfer is challenged is **unverified**.

**Status: documented, never executed against this account.** No transfer was
performed by this review.

## 5. Fees, limits, processing times, transaction references

**Nothing is recorded in this repository** about intra-wallet transfer fees,
per-transaction or daily limits, cut-off times, weekend behaviour, or which
provider reference is authoritative for an internal transfer. This review could
not retrieve provider documentation (web fetch returned empty), and inventing a
value here would be worse than leaving the gap visible.

**Status: blocked.** Treat all four as unknown until answered in writing
(Q7–Q9). Do not size float, pricing or payout SLAs on an assumption.

## 6. Payout initiation, idempotency, status lookup and finality

**Documented and implemented.**

- `POST {base}/send-money/initiate/` is the initiation path
  (`INTASEND_SEND_MONEY_INITIATE_PATH`). The legacy bare `/send-money/` path is
  gone; a 404 there was indistinguishable from a refusal.
- The request carries `wallet_id` **in production only**, from the single
  accessor; a production payout without a usable wallet refuses before the body
  is built.
- Each leg carries a documented per-transaction `idempotency_key`
  (`buildPayoutLegIdempotencyKey(claimId, recipientType)`), stable across retries
  of the same leg and distinct per role. The provider documents that a repeat with
  the same key is rejected.
- `BP103` ("Preview and approve") means the batch pays **nothing** until approved
  out of band; it is never read as success.
- Status is `POST {base}/send-money/status/` with `{ tracking_id }`; per
  transaction the machine-readable `status_code` is the authority (`TS100` =
  success) with the human label only as a documented fallback. An unrecognised
  code is `unknown`, never `completed`.
- **Finality:** a 2xx on initiation means the batch was *accepted*, not that an
  M-Pesa B2C transfer settled. Only an authoritative per-transaction `TS100`
  reached through the status lookup can complete a leg.
- Ambiguous outcomes (5xx/408/429/timeout) are recorded as unresolved (`unknown`)
  and never auto-retried; a row that may have moved money is never resubmitted.

**Not account-confirmed:** that this merchant account accepts the request shape,
that duplicate-key rejection behaves as documented, whether the account is put
into "preview and approve" mode, and whether `wallet_id` is honoured as expected.

**Status: client behaviour in-repo proven; provider behaviour unverified.**

## 7. Webhooks: signatures, retries, duplicate events and ambiguous outcomes

- **Authentication is a challenge, not a signature.** The collection route
  compares `payload.challenge` with `INTASEND_WEBHOOK_CHALLENGE` using a
  constant-time digest comparison. `INTASEND_WEBHOOK_SECRET` (HMAC) is no longer
  read and is retained only as a documented deprecation. In production a missing
  challenge refuses to boot and the route returns 401.
- **Duplicates and reordering are safe locally.** The amount is reconciled against
  the persisted payment session and the escrow transition is a compare-and-swap, so
  a repeated delivery cannot pay twice (`paymentConfirmationOrdering`,
  `webhookAmountReconciliation`).
- **A payout callback is a hint.** `send_money_event` carries no authority: the
  handler extracts `tracking_id` and re-reads the batch from the status API; a
  missing ID is 400, a verification failure surfaces an error so the provider
  retries, and nothing about settlement is released by the callback alone.
- **Unknown outcomes are not fabricated.** An unreadable callback amount triggers
  the authoritative `POST /payment/status/` lookup; an unrecognised response shape
  is `unverified`, and escrow is not entered.

**Unverified provider-side:** retry count/schedule, whether deliveries are signed
at all in the current account configuration, delivery ordering, replay window, and
whether a webhook can arrive for a batch this account did not create.

**Status: receiver in-repo proven; provider delivery semantics unverified.**

## 8. Sandbox credentials and required capabilities

A sandbox rehearsal needs, at minimum:

1. A sandbox merchant account (not the production account) and its secret key.
2. A sandbox KES **working** wallet with `can_disburse: true` and test float.
3. A sandbox KES settlement wallet.
4. An approved B2C test recipient (a controlled MSISDN) permitted in sandbox.
5. The sandbox webhook challenge value configured for the test endpoint.
6. A test STK number that can complete a sandbox collection.
7. Permission to read wallets/balances and to create one small intra-transfer.

**Current state: blocked.** No sandbox credentials were used. A local `.env` exists
and contains IntaSend key *names*; values were not read or printed and their
environment (sandbox vs production) is unknown. The local file does not contain
`INTASEND_WEBHOOK_CHALLENGE` or `INTASEND_DISBURSEMENT_WALLET_ID`, but a local file
is not the production environment and must not be treated as one.

## 9. Evidence to retain before production activation

Store each item in the release record, with a timestamp and the operator's name.
Mask wallet IDs and phone numbers in anything retained.

- [ ] Merchant/account identity confirmation and the KES wallet inventory
      (`wallet_type`, `currency`, `can_disburse`, masked ID) for both wallets.
- [ ] Production `INTASEND_DISBURSEMENT_WALLET_ID` confirmed to match the working
      wallet (record only "matched", never the value).
- [ ] Whether `INTASEND_SETTLEMENT_WALLET_ID` is declared, and that it differs.
- [ ] Whether `INTASEND_COLLECTION_WALLET_ID` is deliberately left empty (the
      default), or set only after IntaSend confirms in writing that `wallet_id` is
      honoured on `POST /payment/mpesa-stk-push/` for this merchant account.
- [ ] IntaSend support's written answers to Q1–Q15.
- [ ] Sandbox collection: request reference and the resulting state.
- [ ] Sandbox payout: batch `tracking_id`, per-transaction `transaction_id`,
      observed status codes, and the duplicate-key rejection response.
- [ ] Sandbox intra-transfer: before/after balances, amount, reference, fee and
      settlement time (or "not charged" if that is the written answer).
- [ ] Sandbox webhook deliveries: how many arrived for one event, any duplicate,
      and whether a replayed payload was accepted.
- [ ] A signed statement of the final production wallet pair and the float
      procedure owner.
- [ ] Confirmation that no production payout was used to obtain any of the above.

## 10. Questions to submit to IntaSend support

Send as one ticket; quote the merchant account ID, never a secret key.

**Wallets and collection routing**

1. For this merchant account, which KES wallet receives M-Pesa collections by
   default, and can that destination be changed?
2. Can collections be settled directly into a **working** wallet (per account,
   per integration, or per request)? If per request, which field?
3. Does `POST /payment/mpesa-stk-push/` accept any wallet or sub-account selector
   today? If not, is one planned?
4. What are the exact `wallet_type` values and the meaning of `can_disburse`,
   `current_balance` and `available_balance` for a KES account?
5. Is there a recommended procedure to move collected funds from settlement to
   working, and does the dashboard expose it?

**Transfers between wallets**

6. Confirm the direction convention of `POST /wallets/{id}/intra_transfer/`:
   is `{id}` the debited wallet and body `wallet_id` the credited wallet?
7. Are there fees for settlement→working transfers? Flat, percentage, or free?
   Are they deducted from the amount or billed separately?
8. What are the minimum/maximum per transfer, daily limits, processing time, and
   cut-off behaviour (weekends/holidays)?
9. **Is there any idempotency mechanism for `intra_transfer`?** If a request times
   out, how do we determine whether it executed, and which reference should we
   reconcile against? Is an OTP challenge required for internal transfers, and
   which operation confirms it?

**Payouts**

10. For `POST /send-money/initiate/`: confirm `idempotency_key` scope (per
    transaction vs per batch), the exact duplicate rejection, and the retention
    period after which a key may be reused.
11. Under what conditions is a batch created in `BP103` "Preview and approve", and
    how is it approved (dashboard, API, approval user)? Can it be disabled?
12. For `POST /send-money/status/`: is `tracking_id` the batch identity, and is the
    per-transaction array guaranteed to contain every submitted transaction,
    including failures? Which status codes are terminal, and is `TS100` the only
    success code?
13. After a terminal success, can a transaction still reverse? What is the
    reconciliation reference for a reversal?

**Webhooks**

14. Which authentication does the current collection webhook use for this
    account — the configured challenge value, an HMAC signature, or both? What are
    the retry policy, timeout, ordering guarantees, duplicate-delivery behaviour
    and replay window, and is there a documented way to fetch missed events?
15. Which events are emitted for payouts (batch created / approved / per
    transaction), and what identity do they carry?

## What would change the verdict

The provider moves from **unverified** to **account-confirmed** only when the
sandbox rehearsal above has been executed and its artefacts retained — and the
production wallet pair has been confirmed by the account owner. Documentation
answers alone move items 2, 5 and 7 to **documented**, not to **confirmed**; item 4
is already documented and stays **unconfirmed** until the rehearsal runs; item 8
stays **blocked** until sandbox access exists.

Until then, the statements this repository may make are exactly the ones in
[`payment-launch-readiness.md`](payment-launch-readiness.md): the application's
own gates are tested; the provider contract is the largest unverified dependency;
and "the payout works end to end" is not a claim it can make.
