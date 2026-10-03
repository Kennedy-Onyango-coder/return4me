# Phase 16.1 Batch 4 — Structural Extraction REPAIR Report
## `AgentView -> AgentHub` single authoritative Hub, reverse dependency removed

**Workspace:** `d:\Return4me\return4me-main`
**Branch:** `main`
**HEAD (short):** `4909d91`
**Report date:** 24 Sep 2026
**Status:** FINAL — all three validation gates green. The single verdict is stated in section 12.

---

### 1. Purpose and scope

Batch 4 is a **structural extraction**: the live Agent Hub JSX that used to be inline in
`src/components/AgentView.tsx` now lives in `src/components/agent/AgentHub.tsx`, and
`AgentView` renders it exactly once. This report covers the **repair and completion pass** over
that extraction:

1. finish the extraction so the dependency graph is strictly one-directional;
2. keep the extracted Hub a **single authoritative copy** (no leftover duplicate markup, no
   duplicated DOM ids);
3. preserve every **Batch 3** contract (operational error channel, queue-failure truthfulness,
   accessible alerts/labels, truthful claim badge) and re-point the Batch 3 suite at the code's
   new home instead of at a file name;
4. repair **encoding damage** found in the extracted file;
5. prove all of the above with the three gates: typecheck, full test suite, production build.

Out of scope (deliberately not done): no commit, no push, no staging, no refactor beyond the
extraction boundary, no new dependencies, no DOM test harness added.

---

### 2. What was inherited at the start of this pass

| Item | State found |
|---|---|
| `src/components/agent/AgentHub.tsx` | Present (untracked), holds the Hub markup, imports `../claimStatus` (reverse import already fixed) |
| `src/components/AgentView.tsx` | Hub JSX removed; single `<AgentHub ... />` in the active-agent branch; `agentClaimBadge` re-exported |
| `src/components/claimStatus.ts` | Neutral home of `agentClaimBadge` + `CLAIM_STATUS_VALUES`/`getClaimStatusDisplay` |
| `src/__tests__/agentHubExtractionBatch4.test.ts` | New spec, **1 failing** test (asserted Hub section markers on a comment-stripped copy) |
| `src/__tests__/agentHubReliabilityBatch3.test.ts` | Repointed to a composed surface, **1 failing** test (`{queueError && (` literal could no longer match) |
| `src/__tests__/claimStatusVocabulary.test.ts` | 11/11 green already |
| Whole-tree encoding of `AgentHub.tsx` | **Damaged**: 22 cp1252 round-trip sequences (see section 6) |

#### 2.1 Report-versus-tree discrepancy (recorded because it misleads)

`reports/phase16-batch4-forensic-report.md` (22 Sep 2026) describes an `AgentHub.tsx` that does
not exist in this repository. Recorded here so the document is not mistaken for a description of
the shipped code:

| Claim in that report | Actual repository fact |
|---|---|
| `AgentHub.tsx` imports `react-i18next`, `react-redux`, `react-router-dom`, `../../store/agentSlice` | None of these are dependencies (`package.json` has no react-redux / react-i18next / react-router-dom); `AgentHub.tsx` imports only `react`, `../ClaimVerificationEvidence`, `../claimStatus`, `lucide-react` |
| Child components `StatusBadge.tsx`, `AgentMetricsCard.tsx`, `AgentDropoffList.tsx`, `AgentPickupList.tsx` | Do not exist anywhere in the tree |
| Test files `AgentHub.test.tsx`, `AgentMetricsCard.test.tsx`, `AgentDropoffList.test.tsx`, `AgentPickupList.test.tsx` (50 cases) | Do not exist. `vitest.config.ts` includes only `src/**/*.test.ts`; there are no `.test.tsx` files in this repo |
| Prop renamed `expectedDropoffs` -> `expectedDropups`; `t.props.expectedDropups` fixed | This is the **origin of the typo**: production code and `src/types.ts` translation keys use `expectedDropoffs`; the extracted Hub keeps `expectedDropoffs` |
| Environment `vitest 1.2.2`, `vite 4.5.2`, Node `v20.11.1` | `vitest 4.1.10`, `vite 6.2.3` (see Appendix B) |

The only claims in that report that match the tree are the intent (extract the Hub) and the
artifact path. The Batch 4 spec therefore pins the **real** prop name (`expectedDropoffs`) and
asserts that `expectedDropups` appears in no production file.

---

### 3. The structural contract: dependency direction

**Required:** `App -> AgentView -> AgentHub -> shared leaf utilities`, with **no** reverse edge
`AgentHub -> AgentView`.

| Edge | Evidence | Result |
|---|---|---|
| `App -> AgentView` | `src/App.tsx` lazy-imports `./components/AgentView` (2 render sites); `App.tsx` does **not** mention `AgentHub` | holds |
| `AgentView -> AgentHub` | `AgentView.tsx:5  import AgentHub from './agent/AgentHub';` and exactly one call site (`<AgentHub ... />`, 1 occurrence) inside the `{token && agentStatus === 'active' && agentProfile && (...)}` branch | holds |
| `AgentHub -> AgentView` | No `from '../AgentView'` import; no `AgentView` token in the import table | **removed** |
| `AgentHub -> neutral leaf` | `AgentHub.tsx:3  import { agentClaimBadge } from '../claimStatus';` | holds |
| `claimStatus -> either view` | comment-stripped `claimStatus.ts` mentions neither `AgentView` nor `AgentHub`; only its doc comment (which records the move) names them | holds |
| Consumer fan-in | A walk of every `.ts`/`.tsx` under `src/` (excluding `__tests__`) with an import specifier ending in `agent/AgentHub` returns **exactly** `['src/components/AgentView.tsx']` | holds |

The fan-in assertion is deliberately a **set equality**, not a `toContain`, so a second consumer
re-introducing a coupling to the Hub fails the suite.

---

### 4. Single-copy audit (no duplicate Hub markup, no duplicate ids)

Read on the **raw** source, because the Hub's own section headers are JSX comments
(`{/* Drop-offs Queue */}`) and stripping comments would erase the evidence being audited.

| Marker / unique copy | in `AgentView.tsx` | in `AgentHub.tsx` |
|---|---|---|
| `{/* Hub Profile Banner */}` | 0 | 1 |
| `{/* Total Earnings Card` | 0 | 1 |
| `{/* Processing Queues */}` | 0 | 1 |
| `{/* Drop-offs Queue */}` | 0 | 1 |
| `{/* Handover / Pickups Queue */}` | 0 | 1 |
| `space-y-8 fade-in` (the Hub root wrapper) | 0 | 1 |
| `No pending physical drops scheduled currently.` | 0 | 1 |
| `Your physical inventory is currently empty.` | 0 | 1 |
| `Hub Handover Golden Rule:` | 0 | 1 |
| `Verified Return4me Partner Point` | 0 | 1 |
| `Total Earned (your commission share)` | 0 | 1 |
| `agentProfile.business_name` | 0 | 1 |
| `expectedDropoffs.map(` | 0 | 1 |
| `holdingPickups.map(` | 0 | 1 |

**DOM id uniqueness** across the composed surface (`AgentView` + `AgentHub`, comment-stripped,
static `id="..."` attributes):

- 21 distinct ids, **0 duplicated** (a duplicate would be invalid HTML and would break every
  `htmlFor`/`aria-*` reference that points at one of them);
- the 8 verification-panel ids (`agent-verify-*`) now exist only in `AgentHub.tsx`;
- the 13 auth/form/modal ids (`agent-phone`, `agent-confirm-modal-title`, ...) remained only in
  `AgentView.tsx`.

**Known, benign overlap** (recorded for honesty, not asserted away): 6 generic, hub-neutral
lines are byte-identical after whitespace normalisation and `props.` stripping --
`refreshCategories?: () => void;`, `disabled={actionProcessing}`, `aria-busy={actionProcessing}`,
`<div className="space-y-2">`, `<div className="space-y-1">`,
`verifyFoundArea !== (item.location_description || '')`. None of them is Hub identity or markup,
so the audit is expressed with the identity-bearing strings above instead of a raw line-diff.

---

### 5. Interface audit: `AgentHubProps` <-> `AgentView` invocation

The suite parses the declared prop names out of the interface block and asserts each one is
passed at the real call site (a vacuity guard asserts the parse found >= 48 props, so the loop
cannot silently pass on an empty list).

| Fact | Value |
|---|---|
| Declared props in `AgentHubProps` | 50 |
| Props passed by the single `<AgentHub ... />` site | 50 / 50 |
| Optional props | exactly 1 (`refreshCategories?: () => void;`) |
| `t` typing | `t: any;` (kept loose: the nested verification-label object is not expressible in the shared `translations` type) |
| Hooks inside `AgentHub` | **0** (`useState`/`useEffect`/`useRef`/`useCallback`/`useMemo`/`useReducer`/`useContext` all absent) -> the Hub is presentational; `AgentView` remains the single owner of the Hub's state and callbacks |
| React import | `import React from 'react';` retained (used by the `React.FormEvent` prop type) |

Wiring direction in one line: **state and effects stay in AgentView; rendering and props-reading
live in AgentHub.**

---

### 6. Encoding integrity: 22 cp1252 mojibake sequences repaired

Defect found during this pass: `src/components/agent/AgentHub.tsx` had been round-tripped through
**cp1252** while being written (UTF-8 bytes read as cp1252, then re-encoded as UTF-8). Each
affected character therefore occupied 2-3 code points in the file.

A full non-ASCII census of the file found exactly 65 non-ASCII code points, and all 65 were
accounted for by three sequences - there was no fourth, unaccounted-for defect:

| UTF-8 bytes of the intended character | Intended character | cp1252 rendering found | Count | Where |
|---|---|---|---|---|
| `E2 80 94` | `—` (U+2014 em dash) | `U+00E2 U+20AC U+201D` | 19 | comments **and** user-visible copy (F-4 disclosure sentences) |
| `E2 80 A6` | `…` (U+2026 ellipsis) | `U+00E2 U+20AC U+00A6` | 2 | Hub copy (e.g. the loading string, the removed dead-input note) |
| `C3 97` | `×` (U+00D7 multiplication sign) | `U+00C3 U+2014` | 1 | the dismiss glyph inside the operational-error alert's close button |

Repair method: exact-sequence reverse mapping (asserting the expected count of each sequence
before writing), then a post-write census that **fails closed** if any non-ASCII code point other
than the three intended ones remains.

Verification of the repair:

| Check | Result |
|---|---|
| Sequences rewritten | 19 + 2 + 1 = 22 |
| Remaining non-ASCII code points | only `U+2014 x19`, `U+2026 x2`, `U+00D7 x1` - all intended |
| Line-count delta | 0 (no line was added or lost) |
| Byte delta | -106 bytes (the expected shrink from collapsing 3 chars into 1) |
| BOM | none added; CRLF line endings preserved (605 CRLF) |
| Regression guard | new spec test `AgentHub carries no cp1252 round-trip damage (mojibake) in its copy` matches the cp1252 leading/trailing pairs, so the three correct characters never trip it, and it covers `AgentHub.tsx`, `AgentView.tsx` and `claimStatus.ts` |

Same-shaped damage was **not** present in `AgentView.tsx` (0 hits), `claimStatus.ts` (0 hits) or
any of the touched spec files (0 hits). It **is** present, pre-existing and untouched, in
`src/services/__tests__/refundOutcome.test.ts` (5 hits, file unmodified in this pass) - recorded
as a known, out-of-scope observation rather than silently repaired.

---

### 7. Batch 3 contract preservation and test repointing

The extraction moved markup, not behaviour. To keep Batch 3 meaningful the suite now judges the
**composed surface** (`HUB = AgentView + AgentHub`) instead of one file name, and the two
assertions that legitimately changed meaning were re-pointed at the code's new home:

| Batch 3 contract | Before | After | Why |
|---|---|---|---|
| `agentClaimBadge` import | `../components/AgentView` | `../components/claimStatus` | the helper's neutral home; `AgentView` still re-exports it for compatibility |
| Hub markup anchors (op-error block, queue-error block, modal, video, busy anchors, label/`htmlFor` pairs, exact-place association) | `AGENTVIEW` | `HUB` (= `AGENTVIEW + '\n' + AGENTHUB`) | the markup moved; the contract did not |
| `{queueError && (` occurrence counted | on `AGENTVIEW` | on `AGENTHUB` as `{props.queueError && (`, exactly 1 | the inline queue-error render now lives in the Hub and reads props |
| `'Awaiting Payment'` fallback / badge call site | `AGENTVIEW` | `HUB` / `AGENTHUB` | the badge is rendered in the Hub |
| Standalone queue-failure panel `{token && !queueLoading && queueError && !agentProfile && (` | `AGENTVIEW` | unchanged (`AGENTVIEW`) | that branch genuinely stayed in `AgentView` |

All 38 Batch 3 cases pass, and the Batch 4 spec additionally pins the suite's own import
direction, so the neutral home cannot silently drift back into a view.

Beyond the repointing, the Batch 4 spec re-asserts the Batch 3 *behavioural* anchors on the Hub
text itself: `role="alert"` + `aria-live="assertive"` on the operational-error block, the
`agentClaimBadge(item.associatedClaim?.status, ...)` call, the F-4 `disputed` / `released`
branches with their informational-only English and Swahili copy (`Do NOT release the item` /
`USITOE bidhaa`, `This claim is complete` / `Dai hili limekamilika`), and the composed
`aria-busy={` count (9: 6 in the Hub, 3 in `AgentView`).

---

### 8. Ripple repointing outside Batches 3 and 4

One earlier suite pinned the verification selector to a file rather than to a contract. The full
suite run found it; it was re-pointed, and the assertion was **strengthened** rather than relaxed:

| Test | Change |
|---|---|
| `src/__tests__/categoryPropagationHttp.test.ts` > `10-D: AgentView reads the App-level category source and refreshes it on use` > `the refresh runs through the EXISTING App callback, at the moment of use` | The failing assertion `expect(AGENT_VIEW).toContain('{categories.map((c: any) => (')` became: the Hub renders it as `{props.categories.map((c: any) => (`; the **composed surface** contains `categories.map((c: any) => (` **exactly once** (no second owner - the exact guarantee sec. 10-D exists to protect); and `AgentView` still forwards `categories={categories}` to the Hub |

Everything else in that block is unchanged and still passes: the private category fetch and its
state are still asserted **gone** from `AgentView` (comment-stripped), the single
`refreshCategories?.()` call site must still precede `setVerifyingItemId(item.id)` inside
`openVerificationPanel`, and `App` must still pass `categories={categories}` to both `<AgentView>`
sites. File result: 21/21.

No other test in the repository needed a change: the full-suite failure list contained this one
test and nothing else, and the final run is green (section 10).

---

### 9. Validation gate 1 - typecheck

```text
Command: npx tsc --noEmit --pretty false
Exit code: 0
Output: (empty - no diagnostics)
```

Captured by redirecting stdout+stderr to a log file and asserting the log is empty, so an
"exit 0 with warnings on stderr" would still have been caught. This is the same gate as
`npm run lint`.

---

### 10. Validation gates 2 and 3 - full test suite and production build

**Gate 2 - tests** (`npx vitest run`, the exact `npm test` script), run over the whole tree:

```text
Test Files  134 passed (134)
     Tests  2053 passed (2053)
   Start at  15:13:00
   Duration  68.79s (transform 2.89s, setup 787ms, import 88.81s, tests 16.54s, environment 23ms)
```

Zero `FAIL` lines. The run immediately before the final ripple fix reported
`1 failed | 133 passed (134)` / `2052 passed (2053)` - i.e. exactly the one assertion in
section 8, now fixed.

Test-count reconciliation (proves nothing was deleted or skipped to get to green):

| | Files | Tests |
|---|---|---|
| Baseline before this pass (recorded in `reports/batch4-summary-raw.txt`) | 133 | 2032 |
| Final after this pass | 134 | 2053 |
| Delta | +1 (the new Batch 4 spec) | +21 (the 21 cases in it) |

Focused suites re-run after every edit (`4 passed (4)` files / `91 passed (91)` tests):

| Suite | Cases |
|---|---|
| `src/__tests__/agentHubReliabilityBatch3.test.ts` | 38 |
| `src/__tests__/agentHubExtractionBatch4.test.ts` | 21 |
| `src/__tests__/claimStatusVocabulary.test.ts` | 11 |
| `src/__tests__/categoryPropagationHttp.test.ts` | 21 |

**Gate 3 - production build** (`npm run build` = `vite build && esbuild src/server.ts ...`):

```text
Exit code: 0
vite:  built in 8.47s
dist/assets/AgentView-Dl-O3Wqa.js   83.35 kB | gzip: 14.01 kB
dist/assets/vendor-B9PUvu1F.js     838.29 kB | gzip: 261.97 kB
esbuild: dist/server.cjs 7.6mb, dist/server.cjs.map 15.9mb  (Done in 3049ms)
```

Note for the extraction's cost profile: `AgentHub` does **not** appear as a separate chunk - it is
folded into the lazy `AgentView` chunk, so the extraction adds no extra network round trip for an
agent opening the Hub. (The pre-existing "some chunks are larger than 500 kB" warning is
unchanged and belongs to `vendor`.)

---

### 11. Git state and preservation guarantees

```text
git rev-parse --short HEAD : 4909d91
git rev-parse --abbrev-ref HEAD : main
git stash list : (empty)
git status --short : 46 modified paths, 18 untracked paths, 0 deletions
git diff --stat    : 45 files changed, 2787 insertions(+), 1165 deletions(-)
```

The 46th status entry is `package-lock.json`, which `git status` flags only because of the
CRLF/LF notice: its content diff is empty (`git diff --numstat -- package-lock.json` prints
nothing). All 46 modified paths are pre-existing dirty state from Batches 1-3; this repair pass
edited **no tracked file** - only untracked material (`AgentHub.tsx`, the three spec files) and
this report.

Untracked paths relevant to this batch (the same set as the previous pass, plus this report):

```text
?? src/components/agent/                 (AgentHub.tsx)
?? src/__tests__/agentHubExtractionBatch4.test.ts
?? src/__tests__/agentHubReliabilityBatch3.test.ts
?? src/__tests__/categoryPropagationHttp.test.ts   (modified in place; still untracked)
?? reports/                                        (contains this report)
```

Actions intentionally **not** performed: no `git commit`, no `git push`, no `git add`/staging, no
`git reset`/`clean`/`restore`/`stash`, no changes to `.gitignore`, no dependency changes
(`package.json` and `package-lock.json` untouched in this pass).

Scratch-artifact hygiene: every temporary file created while diagnosing this pass (encoding
probes, mojibake dump/repair scripts, structure and id audit scripts, a `git show` dump of HEAD's
`AgentView.tsx`, and the `.tsc*` / `.vitest*` / `.build*` logs) was deleted before emitting this
report. A directory listing confirms only `.env`, `.env.example` and `.gitignore` remain as
dotfiles at the repo root, and `dist/` is covered by the existing `.gitignore` entry. The tree is
therefore the previous dirty tree plus exactly the intended source/test/report edits.

---

### 12. Verdict

**COMPLETE**

Rationale, in the order the requirements were posed:

1. **Reverse dependency removed.** `AgentHub` imports only `react`, `../ClaimVerificationEvidence`,
   `../claimStatus` and `lucide-react`. `AgentView` is provably the only module under `src/` that
   imports the Hub (set-equality assertion, not `toContain`), and `App` never mentions it. The
   neutral leaf `claimStatus.ts` depends on neither view.
2. **Single authoritative Hub.** All five Hub section markers, the Hub root wrapper and eight
   further Hub-unique copy strings occur **0 times in `AgentView.tsx` and exactly once in
   `AgentHub.tsx`**; all 21 static element ids across the composed surface are unique.
3. **Batch 3 contracts preserved.** 38/38 Batch 3 cases pass on the composed surface, with the two
   meaning-changed anchors re-pointed (badge import home, inline `props.queueError` render) and
   every behavioural anchor (alert semantics, F-4 disclosure copy, `aria-busy`, badge call site)
   re-asserted against the extracted text.
4. **Interface complete.** 50/50 declared `AgentHubProps` are passed by the one call site; only
   `refreshCategories` is optional; the Hub holds no hooks, so `AgentView` keeps sole ownership of
   state and effects.
5. **Encoding defect repaired** (22 cp1252 sequences; no unaccounted non-ASCII code point remains;
   0 line delta) and guarded by a regression test.
6. **All three gates green:** `tsc --noEmit` exit 0 with empty output; `vitest run` 134/134 files
   and 2053/2053 tests, reconciled as +1 file / +21 tests against the prior baseline;
   `npm run build` exit 0.

Residual risk / not done (stated explicitly so it is not mistaken for complete):

- **No browser/visual verification.** `vitest.config.ts` runs `environment: 'node'` and this
  repository has no jsdom/RTL installed; this batch deliberately did not add one. Structural
  correctness is proven; rendered equivalence between the pre-extraction inline Hub and the
  extracted Hub is argued from the single-copy and id audits, not from a screenshot diff.
- **`src/services/__tests__/refundOutcome.test.ts` still contains 5 pre-existing mojibake
  sequences** (out of scope: untouched file, no assertion depends on them).
- **`reports/phase16-batch4-forensic-report.md` remains in the tree unchanged** and still
  misdescribes this repository (section 2.1); it should be treated as superseded by this report.
- **Nothing was committed or pushed**, by instruction; the work lives in the working tree.

---

### Appendix A - artefact index

| Artefact | Path | Lines | Bytes | Status |
|---|---|---|---|---|
| Extracted Hub component | `src/components/agent/AgentHub.tsx` | 606 | 37,867 | untracked (new); mojibake repaired |
| Hub consumer / state owner | `src/components/AgentView.tsx` | 1379 | 67,229 | modified: `450 insertions / 494 deletions` vs HEAD |
| Neutral badge + status vocabulary | `src/components/claimStatus.ts` | 116 | 5,823 | modified: `35 insertions / 0 deletions` vs HEAD |
| Extraction contract spec | `src/__tests__/agentHubExtractionBatch4.test.ts` | 284 | 13,907 | untracked; 21 cases, all green |
| Batch 3 reliability spec | `src/__tests__/agentHubReliabilityBatch3.test.ts` | 506 | 28,797 | untracked; 38 cases, all green (repointed) |
| Vocabulary spec | `src/__tests__/claimStatusVocabulary.test.ts` | 190 | 10,031 | untracked; 11 cases, all green |
| Category propagation spec (ripple) | `src/__tests__/categoryPropagationHttp.test.ts` | 412 | 22,263 | untracked; 21 cases, all green (1 assertion re-pointed and strengthened) |
| This report | `reports/phase16-batch4-structural-extraction-repair-report.md` | - | - | FINAL |

### Appendix B - environment and reproduction

```text
Host: Windows (win32), PowerShell
vitest: 4.1.10       (package.json devDependencies)
vite: 6.2.3          (package.json dependencies / devDependencies)
typescript: 5.8.2    (package.json devDependencies)
react: 19.0.1, react-dom: 19.0.1
```

Reproduction of every gate in this report:

```powershell
npx tsc --noEmit --pretty false          # expects exit 0 and no output
npx vitest run                           # expects 134/134 files, 2053/2053 tests
npm run build                            # expects exit 0 (vite build + esbuild server bundle)
git status --short                       # expects the dirty tree, no scratch files
```

Evidence commands used for the audits in sections 3-5 (all read-only):

```powershell
# reverse-edge / fan-in
Select-String -Path src/components/agent/AgentHub.tsx -Pattern "AgentView"
# single-copy audit (raw source, comments included)
Select-String -Path src/components/agent/AgentHub.tsx -Pattern "Hub Profile Banner|Drop-offs Queue|Handover / Pickups Queue"
# element-id uniqueness across the composed surface
Select-String -Path src/components/AgentView.tsx,src/components/agent/AgentHub.tsx -Pattern 'id="[^"]+"'
```

FINAL REPORT COMPLETE
