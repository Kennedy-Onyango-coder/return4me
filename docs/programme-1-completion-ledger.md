# Programme 1 — Payout Integrity & Admin Financial Ops: completion ledger

Status as at the working tree this ledger was written in (no commit, no push).
This is the requirement-by-requirement record for WS1–WS5: what was required, where
it lives, what proves it, and anything deliberately deferred.

## Workstreams

| WS | Requirement | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- |
| WS1 | Classify every legacy hub by whether its stored payout destination can be paid at all | `src/services/agentPayoutEligibility.ts` (`resolveAgentPayoutEligibility`, `summarizeAgentPayoutRisk`, `countAgentPayoutIneligible`), re-using the executor's own `resolvePayoutLegEligibility` | `src/components/admin/payouts/__tests__/payoutIntegrityPresentation.test.ts`; `src/__tests__/adminProgramme1Sections.test.ts` | Done |
| WS2 | Surface that verdict per hub, and one Overview figure | `PayoutIntegrityHubsTable.tsx` + `payoutIntegrityPresentation.ts`; new **Payout Integrity** console section; Overview card **Hubs That Cannot Be Paid**; server publishes `stats.payoutIneligibleAgentsCount` | `payoutIntegrityHubsRendering.test.ts`; `adminProgramme1Sections.test.ts`; `adminConsoleShell.test.ts`; `adminConsoleUx15.test.ts` | Done |
| WS3 | Console financial-ops wiring (sidebar, section chrome, section copy) | `adminNavRegistry.ts` extended to 12 sections; `AdminView.tsx` sidebar, `activeTab` union, title band via `describeAdminSectionCopy` | `adminConsoleShell.test.ts`, `adminConsoleUx15.test.ts` (both extended for the 12-section contract) | Done |
| WS4 | A bounded, read-only admin audit trail an operator can actually read | `src/config/auditLogWindow.ts`, `src/services/adminAuditLogApi.ts`, `src/components/admin/audit/AuditLogPanel.tsx` + `AuditLogWindowTable.tsx`, `db.getAuditLogsWindow`, `GET /api/admin/audit-logs`, `toAdminSafeAuditLogWindow`; new **Audit Log** console section | `adminProgramme1Sections.test.ts` (window refusal, wire-name agreement, redaction, route authorization, deterministic ordering) | Done, with one deferral (see below) |
| WS5 | "Earned but not yet paid" and "missing is never zero" on every money figure | `computeAgentPendingEarnings`; `pending_earnings` / `pending_earnings_count` in the agent DTO; Agents Hub badge + owed share; expanded-row earnings no longer zero-defaulted; `pendingPayoutCount` is a whole number or NULL | `payoutIntegrityPresentation.test.ts`; `adminProgramme1Sections.test.ts`; `adminDashboardMetricIntegrity.test.ts` | Done |

## Defects found and fixed inside this programme's own surfaces

1. **`formatRecordedAt` was imported but never re-exported** by
   `src/services/adminAuditLogApi.ts`, so `AuditLogPanel.tsx` did not compile
   (TS2459). The re-export was added at the import site; the formatting rule still
   lives in `adminPayoutReconciliationApi.ts`.
2. **The audit client read the wrong wire names.** `mapAuditLogItem` read
   `adminUser`/`createdAt` while the server DTO (`toAdminSafeAuditLog`) sends
   `admin_user`/`created_at`, so every window row would have rendered
   "Not recorded" and an unknown time for an actor the server HAD sent.
   `AdminAuditLogItemDto` and the mapper were aligned to the server's names, and
   `adminProgramme1Sections.test.ts` now pins the agreement (including a negative
   case proving the assertion is live).
3. **Two remaining zero-defaulted money figures in the Agents Hub**:
   `KES {(agent.total_earned || 0).toLocaleString()}` in the expanded row (and the
   `completed_payouts_count || 0` beside it) read "KES 0" for a figure the server
   reported as NULL. Both now go through the shared read-out module.
4. **A fractional row count was passed through** by the payout-integrity read
   model. A count of rows is a whole, non-negative number or it is not a count
   (the same rule the Overview's `isReportedCountField` applies), so
   `pendingPayoutCount` is now `number | null` and the table says the number of
   rows could not be read instead of printing a rounded or zero figure.

## Pre-existing baseline defects (NOT introduced here) — recorded, not hidden

- **`adminConsoleUx15.test.ts` was already failing at HEAD** before any edit in
  this session: HEAD `73187ec` ("fix: retain categories without Swahili labels")
  dropped the nav's bilingual ternaries (agents / found items / claims / lost
  reports) without updating that test's label list, so it failed on
  `Agents Hub`. The pin has been aligned to the English-only copy that ships, and
  the test now passes; the guarantee it carries (exact rendered label per section,
  unchanged state key) is intact.
- `.kilo/p1d_reqsearch.txt` is a 45.7 GB runaway capture left by an earlier
  session's recursive directory listing. `.kilo/` is git-excluded, so it is
  invisible to git, but it consumes disk. It has been left untouched and must
  not be deleted as part of this batch; any separate cleanup decision requires
  explicit authorization.
- **21 further admin-scoped failures are pre-existing**, in five files this
  programme does not touch: `adminConsoleUx15Closure.test.ts` (2),
  `adminConsoleUx15F.test.ts` (2), `adminLostReportsUi.test.ts` (3),
  `adminTwoFactorEnrollmentUx.test.ts` (13) and
  `src/components/admin/claims/__tests__/claimsPresentation.test.ts` (1). Every
  one of them expects a **bilingual (`lang`/`en`) form** of a string — e.g.
  `aria-label={en ? 'View evidence photograph' …}`,
  `title={lang === 'en' ? 'Issue agent warning' …}`,
  `<LostReportsAdministration lang={lang} …>`, `en ? 'Copy setup key' : …`,
  `en ? 'Enable 2FA' : 'Washa 2FA'`. Those exact strings are absent from **both**
  HEAD and the working tree (`HEAD=0`, `WORK=0` for each), and the Programme 1
  diff removes no line mentioning any of them, so they were already failing
  before this work. They are left alone deliberately: restoring or re-pinning
  another batch's bilingual copy is not this programme's decision.

## Deferred (explicitly, with the reason)

1. **Audit-log pagination.** WS4 reads a BOUNDED, newest-first window
   (`limit` ≤ `AUDIT_LOG_WINDOW_MAX` = 500, optional exact `action` filter,
   `ORDER BY created_at DESC, id DESC`). There is no offset/cursor paging and no
   "next page" control: the audit table is read newest-first in bounded windows
   and narrowed with the action filter. True pagination needs a server-side cursor
   plus a matching client change.
2. **Closing out an unresolved payout.** There is still no endpoint that marks a
   payout completed or re-issues one; those rows stay visible and unresent. The
   Payout Integrity section states the rows and the verdicts, and cannot change
   either — by design.
3. **A payout row whose `pending` amount cannot be read** makes that hub's owed
   total NULL (stated in words, never as a smaller sum). There is no repair path
   for such a row from the console; it is a ledger-level investigation.
4. **`sanitizeAuditDetails` redacts PII patterns but does not strip control
   characters** — that normalisation happens in the client before rendering
   (`safeAuditDetailsText`). Both layers are pinned by tests.
5. **No route-level HTTP test for `GET /api/admin/audit-logs`.** This repository
   has no server harness (`src/server.ts` boots the whole application on import),
   so the guarantee is pinned at source level plus the executed
   window/mapping/redaction functions — the technique the other route-audit
   suites use.

## Verification commands (as run)

```
npx vitest run src/__tests__/adminProgramme1Sections.test.ts \
  src/components/admin/payouts/__tests__/payoutIntegrityPresentation.test.ts \
  src/components/admin/payouts/__tests__/payoutIntegrityHubsRendering.test.ts \
  src/__tests__/adminConsoleShell.test.ts src/__tests__/adminConsoleUx15.test.ts \
  src/__tests__/adminPayoutReconciliationUi.test.ts \
  src/__tests__/adminDashboardMetricIntegrity.test.ts \
  src/components/admin/dashboard/__tests__/adminOverviewMetrics.test.ts
node node_modules/typescript/bin/tsc --noEmit
git diff --check
```

---

## Queued Batch 2 — collection routing, settlement wallet and reconciliation

Scope: establish what the money flow actually does between the two IntaSend
wallets, make the payout wallet routing explicit and fail-closed, and record
honestly which parts of the intended operating model the provider contract does
not (yet) support.

### Audit findings (evidence, not assumption)

| Fact | Where it is proven |
| --- | --- |
| A collection request carries **no wallet selector**. It is `POST /payment/mpesa-stk-push/` with exactly `public_key`, `phone_number`, `amount`, `api_ref`. | `src/services/payments.ts`, `triggerMpesaStkPush()` |
| Collections therefore settle into IntaSend's KES **settlement** wallet, and the application cannot route them elsewhere. | Provider contract as recorded in `docs/operations.md`; **not** re-verified against the merchant account |
| Payouts debit `INTASEND_DISBURSEMENT_WALLET_ID` via the documented `wallet_id` field, **production only**, and fail closed when it is missing/blank/placeholder. | `triggerIntasendPayout()` + the settlement executor gate in `src/server.ts` |
| No wallet balance read, wallet list call or intra-wallet transfer exists anywhere in `src/`. | Pinned by `src/__tests__/walletRoutingEnforcement.test.ts` |
| Moving collected float into the working wallet is an operator-run provider procedure. | `docs/operations.md`, "The working wallet has no float" |
| The intra-wallet transfer endpoint has never been executed against this merchant account. | Stated in the same runbook, "Verification status" |

### What was implemented

1. **`src/config/walletRouting.ts`** — one pure resolver used by *both* payout
   seams: `payout_wallet_missing` (the pre-existing production refusal) and
   `payout_wallet_is_settlement_wallet` (new). Comparison is exact after trimming
   outer whitespace; wallet IDs are opaque and case-sensitive.
2. **`INTASEND_SETTLEMENT_WALLET_ID`** — an optional, identity-only variable.
   It routes nothing, is never sent to the provider, is never used to move money,
   and appears in every log/audit/refusal only in masked form (4 leading and 4
   trailing characters, or a full mask for short values). Undeclared means
   "identity not checked", never "identity verified".
3. **Fail-closed enforcement at both seams** — `triggerIntasendPayout()` refuses
   before the request body is built; `executeClaimSettlement()` refuses before
   any durable pre-submission marker, returns the release lock through
   `abandonRelease()`, and audits `PAYOUT_WALLET_ROUTING_REFUSED`.
4. **Boot visibility** — one name-only line reports whether the settlement wallet
   identity is declared, and an explicit warning when the two IDs are equal.
5. **Documentation** — `.env.example`, `docs/configuration.md` (new "Wallet
   routing" section), `docs/claims-and-payments.md` (where collections land vs
   which wallet pays out) and `docs/operations.md` (what the code now checks).
6. **Tests** — `src/config/__tests__/walletRouting.test.ts` (37 cases),
   `src/__tests__/walletRoutingEnforcement.test.ts` (10 source-contract cases),
   plus collision/identity cases added to `payoutInitiationContract.test.ts` and
   a re-pinned service-gate assertion in `paymentProviderContract.test.ts`.

### Deliberately NOT implemented, with the reason

- **Collection routing to the working wallet.** The request has no wallet field
  and the provider-side capability is unverified. External dependency:
  IntaSend account/dashboard configuration; no code-side change is supportable.
- **Settlement → working wallet transfer.** The endpoint is documented but has
  never been executed against this account, has no documented idempotency key,
  and the existing runbook explicitly forbids adding a second money path. A
  blind implementation would be an unaudited route to the same funds.
- **Wallet balance reads.** None exist, so a settlement balance can never be
  mistaken for available payout float.

### Verification

```
node node_modules/vitest/vitest.mjs run \
  src/config/__tests__/walletRouting.test.ts \
  src/__tests__/walletRoutingEnforcement.test.ts \
  src/services/__tests__/payoutInitiationContract.test.ts \
  src/__tests__/envExampleCompleteness.test.ts \
  src/__tests__/paymentProviderContract.test.ts \
  src/services/__tests__/payments.test.ts \
  src/__tests__/settlementPayoutAuthorization.test.ts
# 7/7 files, 161/161 tests passed, exit 0

node node_modules/typescript/bin/tsc --noEmit   # exit 0, no diagnostics
```

### Outstanding

- Provider-side confirmation that collections can (or cannot) be settled into a
  working wallet for this merchant account — dashboard action / provider support.
- The float top-up remains a manual, verified operator procedure.

---

## Queued Batch 3 — approve & pay and durable payout recovery

Scope: make the durable approval record WHAT it authorized, enforce that the payout
matches it, and keep approval and initiation separate, explicit operations.

### Audit findings (evidence)

| Fact | Where it is proven |
| --- | --- |
| Approval is a CAS-guarded write of `settlement_approved_at` / `_by` plus a `CLAIM_SETTLEMENT_APPROVED` audit row in one transaction. | `db.approveSettlement`, `src/db/database.ts` |
| Before this batch the approval recorded **who** and **when**, not **what**: no approved amount, no approved payout rows. | `src/config/settlementAuthorizationSnapshot.ts` header; the previous text in `docs/operations.md` |
| Initiation re-reads the claim/approval and requires `pending_settlement`, a durable approval and an elapsed `settle_at`, then wins a release CAS. | `db.attemptSettlementRelease`, `executeClaimSettlement` |
| The payout rows are booked at handover (immutable amounts + `phone_or_till` snapshot), and Batch 1.1 already refuses a planned leg that differs from its booked row. | `enterPendingSettlement`; `config/settlementPayoutIntegrity.ts` |
| There is one payout state machine (`pending_settlement` → `releasing` → `released`, with `abandonRelease` on refusal); no second one was added. | `src/config/claimStatuses.ts`, the executor |
| Approval is immutable (`already_approved` is final), so a pre-snapshot approval cannot be "re-created". | `db.approveSettlement` CAS; the HTTP E2E duplicate-approval tests |

### What was implemented

1. **`src/config/settlementAuthorizationSnapshot.ts`** — one pure rule: build the
   approved snapshot (total in minor units + canonical `role:id` pairs), parse it,
   and compare it with the payout rows an attempt would submit. Every ambiguity
   (missing/duplicate/unreadable id, unreadable amount, half-written snapshot,
   changed row set, changed total) is a REFUSAL. A pre-snapshot approval is
   `legacy_approval` — reported, not refused. Money parsing is string-based
   (half-up at the second decimal) so `250.005` cannot round DOWN through binary
   floating point.
2. **Two new `claims` columns** (reviewed migration, idempotent):
   `settlement_authorized_total NUMERIC(10,2)` and
   `settlement_authorized_ledger_ids TEXT`. Declared in `src/db/schema.ts`,
   `sql/schema.sql` and the incremental `ALTER TABLE ... IF NOT EXISTS` list in
   `src/db/index.ts`; pinned by a parity test. **Not applied to production.**
3. **The approval write captures the snapshot in the same transaction** — only
   after the approval CAS wins, so an ineligible claim still reports its real
   reason (`not_pending_settlement`, `outside_review_window`, …). If the payout
   rows cannot be described unambiguously, the transaction is ABORTED
   (`SettlementAuthorizationSnapshotUnreadable`), so no approval exists without
   its snapshot; both approval routes report `409 payout_ledger_unreadable`.
4. **The executor compares the snapshot before any durable marker.**
   `SETTLEMENT_AUTHORIZATION_MISMATCH` + `abandonRelease()` on any difference;
   `SETTLEMENT_AUTHORIZATION_SNAPSHOT_MISSING` (informational) for a legacy
   approval. Nothing is sent, nothing is marked submitted, and the claim returns
   to `pending_settlement`.

5. **A pre-existing Batch 1.1 ordering defect, found by re-running the HTTP E2E
   suite.** The ledger-integrity destination check ran BEFORE the phone-only
   payout policy, so a Till/Paybill leg was refused as a
   `PAYOUT_DESTINATION_MISMATCH` ("booked destination unreadable") and the
   operator-facing `PAYOUT_DESTINATION_NOT_ELIGIBLE` audit was never written. The
   policy gate now runs first; the integrity check still runs for every
   policy-eligible leg, before any marker. This repairs `lifecycleHttpE2E` stage
   8.9 (which Batch 1.1 did not re-run) without weakening either check.
6. **Documentation** — `docs/claims-and-payments.md` (what an approval records and
   how it is enforced), `docs/operations.md` (audit vocabulary + the replaced
   "not recorded" paragraph), `docs/api.md` (`payout_ledger_unreadable`).
7. **Tests** — `config/__tests__/settlementAuthorizationSnapshot.test.ts` (15),
   `db/__tests__/settlementAuthorizationSnapshot.test.ts` (3, real write path),
   `__tests__/settlementAuthorizationEnforcement.test.ts` (9, seams + schema
   parity), a ledger-row-drift case in `settlementPayoutAuthorization.test.ts`,
   plus the re-pinned order in `paymentProviderContract.test.ts`.

### Migration status

Reviewed and idempotent, **not applied** to any database by this batch:

```sql
ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_authorized_total NUMERIC(10,2);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_authorized_ledger_ids TEXT;
```

Both are nullable with no default, so existing rows read as legacy approvals and
no backfill is required or performed. Reads tolerate the columns being absent
(legacy path), but approval WRITES require them — apply the migration before
deploying Batch 3.

### Verification

```
node node_modules/vitest/vitest.mjs run \
  src/config/__tests__/settlementAuthorizationSnapshot.test.ts \
  src/db/__tests__/settlementAuthorizationSnapshot.test.ts \
  src/__tests__/settlementAuthorizationEnforcement.test.ts \
  src/__tests__/settlementPayoutAuthorization.test.ts \
  src/__tests__/lifecycleHttpE2E.test.ts \
  src/db/__tests__/settlementReconciliation.test.ts \
  src/db/__tests__/settlementEarnings.test.ts \
  src/db/__tests__/paymentConfirmedSessionRecovery.test.ts \
  src/db/__tests__/financialInvariants.test.ts \
  src/__tests__/paymentProviderContract.test.ts \
  src/db/__tests__/schemaSyncIdempotency.test.ts
# 11/11 files, 296/296 tests passed, exit 0

node node_modules/typescript/bin/tsc --noEmit   # exit 0, no diagnostics
```

### Outstanding

- The Admin Console still shows who approved and when; the approved TOTAL is not
  rendered separately (the ledger rows it covers are). The backend refuses any
  mismatch regardless of what the console displays.
- No production migration has been run; that is a deployment action, not part of
  this batch.

---

## Queued Batch 4 — end-to-end verification and launch readiness

Scope: verify the combined result of Batches 2 and 3 across the lifecycle, add a
regression net for the combined gate ordering, review the admin payment screens for
misleading copy, and produce an honest launch-readiness report.

### What was verified

1. **Every pre-submission gate precedes the durable markers and the provider call.**
   New `src/__tests__/payoutGateOrdering.test.ts` pins the COMBINED ordering:
   `PAYOUT_DESTINATION_NOT_ELIGIBLE` (Batch 1), `PAYOUT_AMOUNT_MISMATCH` and
   `PAYOUT_DESTINATION_MISMATCH` (Batch 1.1), `SETTLEMENT_AUTHORIZATION_MISMATCH`
   (Batch 3), `PAYOUT_SIMULATION_REFUSED` (Batch 1) and
   `PAYOUT_WALLET_ROUTING_REFUSED` (Batch 2) are all written before
   `db.markPayoutSubmissionStarted`, and the provider call follows the markers.
   It also asserts every failure inside the submission block returns through
   `abandonRelease()`.
2. **The full suite was run** and its result is recorded in
   `docs/payment-launch-readiness.md`, including the honest limit that it was not
   baselined before this queue. 170 failures exist in 36 files; **none is a
   payment/payout/wallet/settlement suite**, and none is a file this queue changed.
3. **Admin console copy review.** `SettlementApproveAndPayConfirmation` and
   `SettlementPayoutConfirmation` described the locked total as an amount
   "released". That total includes the platform share, so it is not the amount paid
   to the recipients. Both now label it the **claim fee**, state that each
   recipient is paid the amount booked on its payout row (verified against the
   ledger before submission), and the rendering suite still passes.
4. **Launch-readiness report** — `docs/payment-launch-readiness.md` separates
   automated-test evidence, static inspection, sandbox (nothing), production
   configuration inspection, and unverified/blocked items, plus required manual
   configuration, migration steps and remaining risks.

### Verification

```
node node_modules/vitest/vitest.mjs run
# 286 files: 250 passed / 36 failed; 5,480 tests: 5,310 passed / 170 failed
# no payment/payout/wallet/settlement suite among the failures

node node_modules/vitest/vitest.mjs run \
  src/__tests__/payoutGateOrdering.test.ts \
  src/components/admin/settlement/__tests__/settlementPayoutConfirmationRendering.test.ts \
  src/__tests__/adminSettlementLifecycleUx.test.ts \
  src/config/__tests__/settlementAuthorizationSnapshot.test.ts \
  src/db/__tests__/settlementAuthorizationSnapshot.test.ts \
  src/__tests__/settlementAuthorizationEnforcement.test.ts
# 6/6 files, 83/83 tests passed, exit 0

node node_modules/typescript/bin/tsc --noEmit
# exit 0
```

### Launch status

The full-suite run above predates the two console-copy edits; the delta run beneath
it covers those components (and the new gate-ordering test) on the final bytes.

**Not declared production-ready.** The money-path defences are tested and the
provider contract is the remaining unverified dependency: no sandbox payout, wallet
transfer or balance read has been performed. See
[`payment-launch-readiness.md`](payment-launch-readiness.md).
