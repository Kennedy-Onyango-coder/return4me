import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// D-2B-B — MANUAL SETTLEMENT IS TWO DELIBERATE ACTIONS, NOT ONE.
// =============================================================================
// The ledger panel used to offer ONE control per pending settlement, "Release
// Now", under copy promising that a claim "settles automatically", or could be
// released "now to override" the review window. Neither half is true after
// D-2B-B: the server pays only a claim that ALREADY carries a durable
// administrator approval AND whose settle_at review window has elapsed, and no
// flag waives either.
//
// Source-level tripwires in the established style of this repository (there is no
// jsdom / React Testing Library harness here — see adminConsoleShell.test.ts and
// adminRouteAudit.test.ts). They pin the contract that route tests cannot see:
//   1. the two actions are SEPARATE — approving records an audit-logged reason
//      and moves no money; initiating pays, and carries NO approval, because the
//      approval is the claim's own persisted state and never a request body;
//   2. neither action can stand in for the other (no chaining in either
//      direction), so an approval recorded early disburses nothing;
//   3. the reason is REQUIRED, trimmed, and enforced BEFORE the mutation is
//      reachable;
//   4. the console FAILS CLOSED on both preconditions — a missing or unparseable
//      settle_at and an approval absent from the payload both read as "not met";
//   5. a refusal is reported in the SERVER's own words, reasons[] included,
//      never in a sentence the browser invents;
//   6. no new dialog carries the reason; the legacy release HANDLER stays
//      declared and wired to its own route, while its UI control is gone
//      (Batch 3) — the endpoint's retention is pinned by the API-level tests;
//   7. a submitted payout is reported as SUBMITTED, never as a completed payout.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const adminView = read('src/components/AdminView.tsx');

/** De-comment: these assertions are about shipped code, never about the prose
 *  that explains it. The D-2B-B comments quote the endpoints, the old copy and
 *  the server's refusal vocabulary, so a comment must not satisfy a pin. */
const code = adminView
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

/** The slice of `src` from `start` up to (not including) the next `end`. */
const sliceBetween = (src: string, start: string, end: string) => {
  const from = src.indexOf(start);
  const to = from === -1 ? -1 : src.indexOf(end, from + start.length);
  return from === -1 || to === -1 ? '' : src.slice(from, to);
};

/** The slice of `src` from `start` to the end. Needed where a region's own end
 *  marker is the boundary that defined its parent and is therefore outside it. */
const tailFrom = (src: string, start: string) => {
  const from = src.indexOf(start);
  return from === -1 ? '' : src.slice(from);
};

// Each action is isolated, so an assertion about one can never be satisfied by a
// line that belongs to the other — which is exactly the failure mode D-2B-B is
// about ("release now" standing in for both steps).
const HANDLERS = sliceBetween(code, 'const [settlementApprovalPrompt', 'const handleToggleSocialPause');
const CLOSE_HANDLER = sliceBetween(HANDLERS, 'const closeSettlementApprovalPrompt', 'const promptSettlementApproval');
const PROMPT_HANDLER = sliceBetween(HANDLERS, 'const promptSettlementApproval', 'const handleApproveSettlement');
const APPROVE_HANDLER = sliceBetween(HANDLERS, 'const handleApproveSettlement', 'const confirmSettlementApproval');
const CONFIRM_HANDLER = sliceBetween(HANDLERS, 'const confirmSettlementApproval', 'const handleInitiateSettlementPayout');
const INITIATE_HANDLER = tailFrom(HANDLERS, 'const handleInitiateSettlementPayout');
const LEDGER_JSX = sliceBetween(code, 'dashboardData.pendingSettlements.map(', 'Recent ledger transactions');
const REFUSAL_HELPER = sliceBetween(code, 'function settlementRefusalMessage', 'export default function AdminView');
// D-2B-B BATCH 2 — the three handlers that make the payout a CONFIRMED step,
// isolated from the reason step and from the request itself.
const PAYOUT_STEP_HANDLERS = tailFrom(HANDLERS, 'const promptSettlementPayoutConfirmation');
const PAYOUT_OPENER = sliceBetween(PAYOUT_STEP_HANDLERS, 'const promptSettlementPayoutConfirmation', 'const cancelSettlementPayoutConfirmation');
const PAYOUT_CANCELLER = sliceBetween(PAYOUT_STEP_HANDLERS, 'const cancelSettlementPayoutConfirmation', 'const confirmSettlementPayout');

describe('D-2B-B: approve and initiate are two separate admin actions', () => {
  it('slices shipped code, not an empty region', () => {
    [HANDLERS, CLOSE_HANDLER, PROMPT_HANDLER, APPROVE_HANDLER, CONFIRM_HANDLER, INITIATE_HANDLER, LEDGER_JSX, REFUSAL_HELPER]
      .forEach((slice) => expect(slice.length).toBeGreaterThan(0));
  });

  it('labels the two steps distinctly and renders no legacy release control', () => {
    expect(LEDGER_JSX).toContain("'Approve settlement'");
    expect(LEDGER_JSX).toContain("'Initiate payout'");
    // BATCH 3 — the second money-moving affordance is gone from the UI entirely,
    // not merely hidden behind a disclosure.
    expect(LEDGER_JSX).not.toContain('Release Now');
  });

  it('records the approval through settlement/approve with a reason body', () => {
    expect(APPROVE_HANDLER).toContain('fetch(`/api/admin/claims/${claimId}/settlement/approve`');
    expect(APPROVE_HANDLER).toContain("method: 'POST'");
    expect(APPROVE_HANDLER).toContain('body: JSON.stringify({ reason })');
  });

  it('initiates the payout through settlement/initiate with NO body', () => {
    expect(INITIATE_HANDLER).toContain('fetch(`/api/admin/claims/${claimId}/settlement/initiate`');
    expect(INITIATE_HANDLER).toContain("method: 'POST'");
    // The approval can never be supplied by the browser: no body at all.
    expect(INITIATE_HANDLER).not.toContain('body:');
    expect(INITIATE_HANDLER).not.toContain('JSON.stringify');
  });

  it('cannot chain: neither action can stand in for the other', () => {
    expect(APPROVE_HANDLER).not.toContain('initiate');
    expect(APPROVE_HANDLER).not.toContain('Initiate');
    expect(CONFIRM_HANDLER).not.toContain('Initiate');
    // ...and paying never records the approval it requires, so that approval can
    // only ever come from a separate, deliberate action.
    expect(INITIATE_HANDLER).not.toContain('approve');
    expect(INITIATE_HANDLER).not.toContain('Approve');
  });
});

describe('D-2B-B: the approval reason is required, and enforced before the request', () => {
  it('opens a reason step instead of mutating on the first click', () => {
    expect(LEDGER_JSX).toContain('onClick={() => promptSettlementApproval(ps.claimId)}');
    // Opening the step must not itself reach the network or the mutation.
    expect(PROMPT_HANDLER).not.toContain('fetch(');
    expect(PROMPT_HANDLER).not.toContain('handleApproveSettlement');
  });

  it('cancelling sends nothing and records nothing', () => {
    expect(LEDGER_JSX).toContain('onClick={closeSettlementApprovalPrompt}');
    expect(CLOSE_HANDLER).toContain('setSettlementApprovalPrompt(null)');
    expect(CLOSE_HANDLER).not.toContain('fetch(');
    expect(CLOSE_HANDLER).not.toContain('handleApproveSettlement');
  });

  it('refuses an empty or whitespace-only reason BEFORE the mutation is reachable', () => {
    expect(CONFIRM_HANDLER).toContain('if (!reason.trim()) {');
    expect(CONFIRM_HANDLER).toContain("setSettlementApprovalReasonError('A reason is required.')");
    const guard = CONFIRM_HANDLER.indexOf('if (!reason.trim()) {');
    const mutation = CONFIRM_HANDLER.indexOf('handleApproveSettlement(claimId, reason.trim())');
    expect(guard).toBeGreaterThan(-1);
    expect(mutation).toBeGreaterThan(guard);
    // The `return` inside the guard is what keeps the flow off the mutation.
    expect(CONFIRM_HANDLER.slice(guard, mutation)).toContain('return;');
  });

  it('submits the TRIMMED reason, which is the value the route stores', () => {
    expect(CONFIRM_HANDLER).toContain('handleApproveSettlement(claimId, reason.trim())');
  });

  it('marks the field required and renders the error in place', () => {
    expect(LEDGER_JSX).toContain('<Textarea');
    expect(LEDGER_JSX).toContain('required');
    expect(LEDGER_JSX).toContain('error={settlementApprovalReasonError || undefined}');
  });
});

describe('D-2B-B: both preconditions fail closed in the console', () => {
  it('treats a missing or unparseable settle_at as NOT due', () => {
    expect(LEDGER_JSX).toContain(
      'settleAtDate !== null && !Number.isNaN(settleAtDate.getTime()) && settleAtDate.getTime() <= Date.now()',
    );
  });

  it('treats an absent approval field as NOT approved', () => {
    expect(LEDGER_JSX).toContain('const hasApproval = ps.hasSettlementApproval === true;');
  });

  it('gates the money on both, and blocks a second in-flight action', () => {
    expect(LEDGER_JSX).toContain('disabled={!hasApproval || !isDue || isApproving || isReleasing}');
    expect(LEDGER_JSX).toContain('loading={isInitiating}');
    expect(LEDGER_JSX).toContain('loading={isApproving}');
  });

  it('states the approval fact from the payload rather than assuming it', () => {
    expect(LEDGER_JSX).toContain('Settlement approved by');
    expect(LEDGER_JSX).toContain('Payout initiation is refused until one is on file.');
  });
});

describe("D-2B-B: a refusal is reported in the server's own words", () => {
  it('forwards the server message and its reasons[] verbatim', () => {
    expect(REFUSAL_HELPER).toContain('Array.isArray(data?.reasons)');
    expect(REFUSAL_HELPER).toContain('reasons.join');
    expect(INITIATE_HANDLER).toContain("settlementRefusalMessage(data, 'Failed to initiate payout.')");
  });

  it('never invents a reason of its own', () => {
    // Only the vocabulary the server sends is rendered, so a server that renames
    // a condition needs no UI change — and the UI cannot contradict the server.
    expect(REFUSAL_HELPER).not.toContain('no_durable_approval');
    expect(REFUSAL_HELPER).not.toContain('not_elapsed');
  });
});

describe('D-2B-B: no new dialog, and the legacy handler stays wired to its route', () => {
  it('carries the reason without a dialog or a native prompt', () => {
    expect(HANDLERS).not.toContain('<Modal');
    expect(HANDLERS).not.toContain('setConfirmModal({');
    expect(LEDGER_JSX).not.toContain('<Modal');
    expect(LEDGER_JSX).not.toMatch(/\bwindow\.(alert|confirm|prompt)\(/);
  });

  it('keeps the legacy release HANDLER and its route, without a UI control', () => {
    // BATCH 3 — the control is REMOVED, not hidden: no JSX calls the handler.
    expect(code).not.toContain('handleReleaseSettlementNow(ps.claimId)');
    // The declaration survives — adminConsoleUx15CDE.test.ts slices its UX-15E
    // review flow up to it — so the retained handler still reaches its own route.
    expect(code).toContain('const handleReleaseSettlementNow = async (claimId: string)');
    expect(code).toContain('fetch(`/api/admin/claims/${claimId}/release-settlement`');
  });
});

describe('D-2B-B Batch 2: the payout is CONFIRMED before it is sent', () => {
  it('opens a confirmation step instead of paying on the first click', () => {
    expect(LEDGER_JSX).toContain('onClick={() => promptSettlementPayoutConfirmation(ps.claimId)}');
    // Opening a step sends nothing and calls no mutation: it only records which
    // settlement is being confirmed.
    expect(PAYOUT_OPENER).not.toContain('fetch(');
    expect(PAYOUT_OPENER).not.toContain('handleInitiateSettlementPayout');
  });

  it('cancelling sends nothing either', () => {
    expect(PAYOUT_CANCELLER).not.toContain('fetch(');
    expect(PAYOUT_CANCELLER).not.toContain('handleInitiateSettlementPayout');
  });

  it('renders the step from the ledger row, without a new dialog', () => {
    expect(LEDGER_JSX).toContain('<SettlementPayoutConfirmation');
    expect(LEDGER_JSX).toContain('onConfirm={() => confirmSettlementPayout(ps.claimId)}');
    expect(LEDGER_JSX).toContain('onCancel={cancelSettlementPayoutConfirmation}');
    expect(LEDGER_JSX).not.toContain('<Modal');
  });

  it('decides nothing itself and reaches the handler only through the reducer', () => {
    expect(PAYOUT_STEP_HANDLERS).not.toContain('fetch(');
    expect(PAYOUT_STEP_HANDLERS).toContain("applyConsoleAction({ type: 'open-payout-confirmation', claimId })");
    expect(PAYOUT_STEP_HANDLERS).toContain("applyConsoleAction({ type: 'cancel-payout-confirmation' })");
    expect(PAYOUT_STEP_HANDLERS).toContain("applyConsoleAction({ type: 'confirm-payout', claimId })");
    expect(PAYOUT_STEP_HANDLERS).toContain('handleInitiateSettlementPayout(requested)');
  });

  it('exposes ONE current payout action and no legacy release control', () => {
    // BATCH 3 — the disclosure is gone, not merely closed, so the pending
    // settlement interface shows the one current path and no second, misleading
    // money-moving control anywhere in the row.
    expect(LEDGER_JSX).not.toContain('<details');
    expect(LEDGER_JSX).not.toContain('Release Now');
    expect(LEDGER_JSX).not.toContain('handleReleaseSettlementNow');
    // ...and the supported path is still what the interface offers.
    expect(LEDGER_JSX.indexOf("'Initiate payout'")).toBeGreaterThan(-1);
  });
});

describe('D-2B-B Batch 2: no action keeps one global in-flight marker', () => {
  it('reads every in-flight state from the per-claim action state', () => {
    // The scalar that let claim B's begin/finish clear claim A's marker is gone.
    expect(code).not.toContain('itemActionProcessing');
    expect(LEDGER_JSX).toContain('isActionInFlight(consoleActions.inFlight, settlementInitiateActionKey(ps.claimId))');
    expect(LEDGER_JSX).toContain('isActionInFlight(consoleActions.inFlight, settlementApprovalActionKey(ps.claimId))');
    expect(LEDGER_JSX).toContain('isActionInFlight(consoleActions.inFlight, legacySettlementReleaseActionKey(ps.claimId))');
  });

  it('clears only this claim\'s in-flight key when the request ends, and reports a failure as before', () => {
    // Cleanup is keyed to the ONE claim, so a failed (or successful) payout can
    // never re-enable another claim's control; the error path keeps the file's
    // existing convention.
    expect(INITIATE_HANDLER).toContain(
      "applyConsoleAction({ type: 'finish', key: settlementInitiateActionKey(claimId) })",
    );
    expect(INITIATE_HANDLER).toContain('setDataError(e.message)');
  });
});

describe('D-2B-B Batch 3: a submitted payout is never reported as a completed one', () => {
  it('falls back to a non-committal message when the server sends none', () => {
    // The banner states what was SUBMITTED: the provider's outcome is unresolved
    // until reconciliation reports it, so the fallback may not claim a payout has
    // been made. A server-provided message is deliberately NOT constrained here —
    // a verified completion is decided server-side, by every payout row having
    // been confirmed, and it has its own words for that.
    expect(INITIATE_HANDLER).toContain(
      "setActionSuccess(data.message || 'Payout initiation submitted — the provider result is not yet confirmed.');",
    );
  });
});


