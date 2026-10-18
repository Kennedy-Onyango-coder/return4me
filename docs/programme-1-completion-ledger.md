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
