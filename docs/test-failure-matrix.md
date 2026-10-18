# Full-suite failure matrix (Gate 4)

This is the per-file categorisation of the **historical full-suite run** recorded in
[`payment-launch-readiness.md`](payment-launch-readiness.md): 286 files,
**250 passed / 36 failed**, 5,480 tests, **5,310 passed / 170 failed**, exit 1.

## How the numbers were produced

- Counts are **measured**, not derived from the aggregate: every `FAIL` block in
  `r4m-review-logs/b4-full.log` was parsed and grouped by file
  (`g4-perfile.txt`, `g4-fail-titles.txt`). The 36 per-file counts sum to exactly
  **170**, and the 170 parsed error lines sum to exactly **170** — so no count below
  is an inference from the totals.
- Category is assigned from the assertion text of each failure
  (`g4-fail-errors.txt`). It is an interpretation of evidence, not a separate test
  run.
- The run was captured on the Batch 4 working tree recorded as commit `786525e`
  (`b4-head.txt`). The ledger already notes that the run predates two console-copy
  edits in that batch and that the affected components were re-tested afterwards.
- **It has not been re-run at HEAD.** HEAD is `d3e1660`; nothing below claims a
  post-G2 full-suite result.

## Categories

| Code | Category | What the assertion shows |
| --- | --- | --- |
| `COPY` | Bilingual / localization copy drift | Source is expected to contain a `t('en','sw')`, `en ? … : …` or `lang`-selected string that is absent. |
| `MASK` | Public-recognition masking policy | The masked output differs from the expected policy (e.g. `'Kennedy O******'` vs `'K****** O******'`). |
| `CONTRACT` | Component contract / export shape | A prop, export, default export or type is expected and missing. |
| `WINDOW` | Stale source-slice assertion | The test slices a fixed number of characters from a function start; the slice no longer contains the statement it asserts. |
| `UI-STATE` | UI state / markup assertion | A state string, badge text or bounded-loading rule is asserted. |
| `ESCAPE` | Content escaping | Rendered HTML must escape a value (`&lt;a href=`). |
| `ROUTE` | Route / rate-limit copy | A route's export shape or the user-visible 429 branch is asserted. |

## Matrix

| # | Test file | Fail | Category | Reproduced at baseline? | Touches changed money/admin code? | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `src/__tests__/adminConsoleUx15Closure.test.ts` | 2 | COPY | **Yes** — `12a3c20` worktree, same 2 failures | No — reads `DisputeClaimantPanel` copy; admin *console* only, not money path | Open, baseline-attributed | `expected 'function DisputeClaimantPanel({…' to contain 'aria-label={en ? 'View…` |
| 2 | `src/__tests__/adminConsoleUx15F.test.ts` | 2 | COPY | **Yes** — same 2 | No — agent-warning copy | Open, baseline-attributed | `expected 'open={agentWarnPrompt !== null}…' to contain 'title={lang === 'en' ?…` |
| 3 | `src/__tests__/adminLostReportsUi.test.ts` | 3 | COPY | **Yes** — same 3 | No — lost-reports admin copy / county labels | Open, baseline-attributed | `expected 'import React, { useCallback…' to contain …`, `'All Counties'` |
| 4 | `src/__tests__/adminTwoFactorEnrollmentUx.test.ts` | 13 | COPY | **Yes** — same 13 | **Admin code, but not the payment path** — 2FA enrollment copy/QR/recovery strings | Open, baseline-attributed | `to contain 'en ? 'Enable 2FA' : …'`, `to match /Kunakili hakupatikani/` |
| 5 | `src/__tests__/phase16ProductRemediation.test.ts` | 2 | COPY | **Yes** — same 2 | No — "Track My Claim" / signed-out copy | Open, baseline-attributed | `to contain 'Kufuatilia claim…'`, `'Hujaingia.'` |
| 6 | `src/components/admin/claims/__tests__/claimsPresentation.test.ts` | 1 | COPY | Not re-run at baseline. Documented as pre-existing by the string-absence check in the completion ledger (`HEAD=0`, `WORK=0`); its sources are unchanged by this ladder | No — claim presentation label | Open, **documented** pre-existing (not test-reproduced here) | `expected 'Unknown — historical snapshot unavailable…' to contain 'Haijulikani'` |
| 7 | `src/__tests__/agentEmailActivationFrontendN4.test.ts` | 3 | COPY | Not established | No — reads `AgentRegistrationView.tsx` (unchanged) | Open, origin unclassified | `to contain 'const t = (en: string,…'`, `expected ['agentEmailHelp:'] to have a length of 2 but got 1` |
| 8 | `src/__tests__/agentHubComprehensionBatch4B1.test.ts` | 3 | COPY | Not established | No | Open, origin unclassified | `to contain 'label: lang === 'en' ?…`; `'agentPendingPaymentNote:` absent` |
| 9 | `src/__tests__/agentHubExtractionBatch4.test.ts` | 6 | CONTRACT + COPY | Not established | No | Open, origin unclassified | `AgentHubProps is … to include 'lang'`; `expected 'No Claim Information' to be 'Hakuna Taarifa ya Dai'` |
| 10 | `src/__tests__/agentHubModernizationBatch4B3.test.ts` | 2 | CONTRACT + COPY | Not established | No | Open, origin unclassified | `expected 1 to be 2`; `expected 'import React from 'react';…' to contain …` |
| 11 | `src/__tests__/agentHubReliabilityBatch3.test.ts` | 4 | COPY | Not established | No | Open, origin unclassified | `missing operational sink: setOperationError(lang === 'en' ?…`; badge label mismatch |
| 12 | `src/__tests__/agentRegistrationUx12.test.ts` | 10 | COPY | Not established | No | Open, origin unclassified | `to contain 'tr('Continue',…`; `expected 0 to be greater than 0` (live guards) |
| 13 | `src/__tests__/agentSignInUx11.test.ts` | 12 | COPY | Not established | No | Open, origin unclassified | Bilingual sign-in strings absent (`t(…)`/`en ? …` forms) |
| 14 | `src/__tests__/becomeAgentUx10.test.ts` | 13 | COPY | Not established | No | Open, origin unclassified | Bilingual onboarding strings absent |
| 15 | `src/__tests__/categoryPropagationHttp.test.ts` | 1 | ROUTE | Not established | No — `AgentView` default export shape | Open, origin unclassified | `expected 'import React, { useState…' to match /export default function …/` |
| 16 | `src/__tests__/claimStatusPollingRateLimit.test.ts` | 1 | ROUTE | Not established | No — reads `src/routes/claimPayments.ts` (unchanged) | Open, origin unclassified | `a 429 branch must surface a user-visible message` |
| 17 | `src/__tests__/claimStatusVocabulary.test.ts` | 3 | COPY | Not established. Reads `server.ts`/`db/*` (changed by this ladder), but the asserted labels are **untouched** (`0` diff hits) and live in `src/components/claimStatus.ts` (unchanged) | Reads changed files; asserted behaviour is unrelated to the snapshot work | Open, origin unclassified | `expected 'Awaiting Payout Release' to be 'Inasubiri Malipo Kutolewa'` |
| 18 | `src/__tests__/countyAwareSearchAndSurfacing.test.ts` | 1 | COPY | Not established | No | Open, origin unclassified | `to match /aria-label=\{lang === 'en' …/` |
| 19 | `src/__tests__/countySelectorExactPlace.test.ts` | 3 | COPY | Not established | No | Open, origin unclassified | `to contain 'locLabel: 'Mahali…`; `label={t('Exact…` |
| 20 | `src/__tests__/customerAuthUx07.test.ts` | 6 | COPY | Not established | No | Open, origin unclassified | `to contain 'hint={t('We emailed the…`; `account gate: expected 0 to be greater than 0` |
| 21 | `src/__tests__/customerDashboardUx09.test.ts` | 13 | COPY | Not established | No | Open, origin unclassified | `expected 'const CLAIM_STEPS: { en: string }[] =…' to contain '{ en: 'Confirm', sw:…` |
| 22 | `src/__tests__/customerEmailActivationFrontendN3.test.ts` | 2 | COPY | Not established | No | Open, origin unclassified | `to contain 'const t = (en: string,…'`, `'label={t('` |
| 23 | `src/__tests__/emailOtpFinalReview.test.ts` | 3 | COPY | Not established | No | Open, origin unclassified | `to contain 'barua pepe…'`, `'Hauthibitishi umiliki wa…'`, `'Nambari ya Simu…'` |
| 24 | `src/__tests__/lostReportWizardUx04.test.ts` | 17 | COPY + UI-STATE | Not established | No | Open, origin unclassified | `missing copy: What did you lose?`; `expected 5 to be 3` (submit actions); `to contain 't('Submit lost…` |
| 25 | `src/__tests__/ownerDashboardWorkspaces.test.ts` | 1 | COPY | Not established | No | Open, origin unclassified | `to contain 't('Active claims',…` |
| 26 | `src/__tests__/ownerPickupDetailsState.test.ts` | 1 | UI-STATE | Not established | No | Open, origin unclassified | `no unbounded "Fetching..."` assertion fails to match |
| 27 | `src/__tests__/publicClueStyleConfig.test.ts` | 2 | MASK | Not established | No — masking module unchanged | Open, origin unclassified | `expected null to be 'K****** O******'`; `expected '•••• 5678' to be '12******'` |
| 28 | `src/__tests__/publicHelpBatch13.test.ts` | 4 | COPY | Not established | No — mentions `payments.ts` only in comments; reads view copy | Open, origin unclassified | `to contain 't('Your one-time code…`; `expected 0 to be greater than or equal to 30` |
| 29 | `src/__tests__/publicItemDetailUx06.test.ts` | 15 | COPY | Not established | No | Open, origin unclassified | `missing Swahili copy: Bidhaa haipatikani`; `expected 1 to be greater than or equal to 24` |
| 30 | `src/__tests__/publicNavigation.test.ts` | 2 | COPY | Not established | No | Open, origin unclassified | `to match /signin: \{ en: '[^']+',…`; `expected 1 to be greater than or equal to 2` |
| 31 | `src/components/customer/__tests__/lostReportUxBoundary.test.ts` | 2 | COPY | Not established | No | Open, origin unclassified | `to contain 't('Report something…`; `'t('recorded',…` |
| 32 | `src/config/__tests__/verificationProfiles.test.ts` | 1 | CONTRACT | Not established | No — profile config, not payments | Open, origin unclassified | `TypeError: Cannot read properties of undefined (reading 'verify')` |
| 33 | `src/services/__tests__/logMasking.test.ts` | 1 | WINDOW | **Yes, by source invariance** — the test file is unchanged and its assertion slice covers the refund function, no hunk of which was touched by `6857bc3..HEAD` (hunks at 9/112/122/921 only) | **Reads `payments.ts` and `server.ts`**, but not the changed regions | Open, pre-existing with source-level proof; **masking itself is present** | `refund disbursement log statement not found`; the 2,000-char slice ends before the statement's closing `);` (log sits 1,921 chars in, statement spans past 2,000) |
| 34 | `src/services/__tests__/publicRecognition.test.ts` | 13 | MASK | Not established | No — `publicRecognition.ts` unchanged | Open, origin unclassified | `expected 'Kennedy O******' to be 'K****** O******'`; `expected '********' to be 'A*******'` |
| 35 | `src/services/__tests__/socialPostContent.test.ts` | 1 | ESCAPE | Not established | No | Open, origin unclassified | `expected '<b>RETURN4ME — FOUND ITEM</b>…' to contain '&lt;a href='` |
| 36 | `src/utils/__tests__/publicRouteAddressability.test.ts` | 1 | COPY | Not established | No | Open, origin unclassified | `expected 'import React, { useState…' to match …` (route/console copy) |

## Totals

| Category | Files | Failures |
| --- | --- | --- |
| `COPY` (bilingual/localization drift) | 25 | 124 |
| `COPY` + `UI-STATE` | 1 | 17 |
| `CONTRACT` + `COPY` | 2 | 8 |
| `MASK` | 2 | 15 |
| `ROUTE` | 2 | 2 |
| `UI-STATE` | 1 | 1 |
| `CONTRACT` | 1 | 1 |
| `WINDOW` | 1 | 1 |
| `ESCAPE` | 1 | 1 |
| **Total** | **36** | **170** |

The two large clusters are the same class the ledger already described: a test
expects the bilingual (`t('en','sw')`, `en ? … : …`, `lang`-selected) form of a
string and the shipped source has a single-language or differently-worded form
(149 failures across 28 files, of which 8 failures in two files also assert
component contracts), and public-recognition masking where the shipped mask no
longer matches the policy the test pins (15 failures across 2 files).

## Scope and limits of the baseline attribution

**What is actually established.**

- **5 files / 22 failures are baseline-attributed with a measured comparison.**
  `adminConsoleUx15Closure` (2), `adminConsoleUx15F` (2), `adminLostReportsUi` (3),
  `adminTwoFactorEnrollmentUx` (13) and `phase16ProductRemediation` (2) were run in
  an eight-file set **at `12a3c20` and at HEAD**, and both runs reported the same
  file list and the same total: `22 failed | 182 passed (204)` with
  `5 failed | 3 passed (8)` files
  (`g2-worktree-8files-summary.txt`, `g2-final-state.txt`). The per-file counts above
  are independently consistent with that total (2+2+3+13+2 = 22).
- **1 file is documented as pre-existing by static evidence.**
  `claimsPresentation` — the expected strings are absent from both HEAD and the
  working tree (`HEAD=0`, `WORK=0` in the completion ledger) and the Programme 1
  diff removes no matching line. That is string-level evidence, **not** a test run
  at baseline.
- **1 file is pre-existing by source invariance.** `logMasking` — the test file is
  unchanged and the only hunk of `payments.ts` this ladder touched are at lines
  9/112/122/921; the refund function the assertion slices (and its masking call,
  `maskPhoneForLog(t.account)`) is byte-identical. The failure is the test's fixed
  2,000-character window, not a masking regression.
- **No failing suite exercises the changed money path.** None of the 36 files imports
  `services/payments`, `config/settlementAuthorizationSnapshot`,
  `config/walletRouting`, `config/settlementApprovalDisplay` or `payoutOutcomes`
  (grep across all 36; `publicHelpBatch13` mentions `payments.ts` only in comments).
  Two suites read changed files at all, and both are addressed above.

**What is NOT established.**

- **30 files / 147 failures have no baseline evidence.** They are marked "origin
  unclassified". An untouched test file is *not* proof that its failure predates
  this work; it only means the failure was not caused by a change to that file.
- **The full suite was never run at HEAD.** It was also never run at the baseline
  commit. Only eight files have been compared across the two trees.
- Category assignment is an interpretation of assertion text, not a second
  execution. Two files (`agentHubExtractionBatch4`,
  `agentHubModernizationBatch4B3`) mix contract and copy assertions, and
  `lostReportWizardUx04` mixes copy and state assertions.

**Missing evidence, stated exactly.**

1. A full-suite result at `12a3c20` (baseline) — never captured.
2. A full-suite result at `d3e1660` (HEAD) — never captured.
3. Per-file baseline results for the 30 unclassified files.
4. A complete test-file → source-file import graph; only `readFileSync` targets and
   money-path imports were inspected.

**How to close it** (a separate, explicitly authorised task): create a worktree at
`12a3c20` with a usable `node_modules`, run the 30 unclassified files there, run the
same 30 at HEAD, and record both exit codes and both per-file counts. Do not infer
the result from this document.

## What this audit did not do

- No failure was fixed, skipped, re-pinned or silenced.
- No UI, 2FA, modal, photo-remediation or recognition test was touched.
- No payment, payout, wallet or settlement code was changed.
- No full-suite run was started merely to reproduce a number already recorded.

## Post-G2 targeted results (for contrast only)

These are the runs that *were* performed after the G2 changes, and they are not a
full-suite substitute:

| Run | Result | Exit |
| --- | --- | --- |
| `g2-tests4` — G2 suites plus guards (10 files) | 184/184 tests passed | 0 |
| `g2-tests5` — settlement/payout guards (7 files) | 118/118 tests passed, 0 `FAIL` lines | 0 |
| `g2-worktree-8files` at baseline `12a3c20` and at HEAD | 22 failed / 182 passed (204), same 5 files both times | 1 |
| `tsc --noEmit` | no diagnostics | 0 |

The 22 failures in the third row are the baseline-attributed cluster above; they are
**not** a regression and they remain open.
