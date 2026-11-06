import { describe, it, expect } from 'vitest';
import {
  SETTLEMENT_QUEUE_STATES,
  SETTLEMENT_QUEUE_EMPTY_DESCRIPTION,
  SETTLEMENT_QUEUE_UNREPORTED_DESCRIPTION,
  classifySettlementQueue,
  classifySettlementQueueRow,
  settlementQueueBreakdownText,
} from '../settlementQueueStates';

// =============================================================================
// STAGE 4B (F-04) — THE SETTLEMENT QUEUE CLASSIFIER
// =============================================================================
// Behavioural tests against the real functions. The module is pure and has no
// I/O, so what is executed here is exactly what the Overview renders: which
// bucket a `pendingSettlements` row lands in, that no row lands in two, and that
// every row lands in one.
//
// `now` is always passed explicitly: a classification that depends on the wall
// clock could not be asserted at all.

const NOW = Date.parse('2026-01-10T12:00:00.000Z');
const PAST = '2026-01-09T12:00:00.000Z';
const FUTURE = '2026-01-11T12:00:00.000Z';

/** A booked, pending, never-submitted leg — the state a NEW payout row is in. */
const untouchedLeg = (overrides: Record<string, unknown> = {}) => ({
  role: 'finder',
  status: 'pending',
  payoutOutcome: 'not_submitted',
  ...overrides,
});

const row = (overrides: Record<string, unknown> = {}) => ({
  claimId: 'CLM-1',
  settleAt: PAST,
  hasSettlementApproval: false,
  settlementApprovalSource: null,
  settlementApproval: { state: 'not_approved' },
  payoutRecipients: [untouchedLeg()],
  ...overrides,
});

const stateOf = (overrides: Record<string, unknown> = {}) =>
  classifySettlementQueueRow(row(overrides), NOW).state;

/**
 * An `authorized` snapshot whose covered rows were VERIFIED against the booked
 * ledger rows — the only shape that may be classified "approved, not initiated".
 * `bookedRowsAgreeWithApproval` is the display module's own verdict: `true`
 * (verified), `false` (the booked rows changed) or `null` (could not be compared).
 */
const verifiedApproval = (overrides: Record<string, unknown> = {}) => ({
  state: 'authorized',
  bookedRowsAgreeWithApproval: true,
  ...overrides,
});

describe('the four states a settlement row can be in', () => {
  it('is "ready now" when the window has elapsed and no approval is on file', () => {
    expect(stateOf()).toBe('ready_now');
    // The boundary is inclusive: a settle_at of exactly now has elapsed.
    expect(stateOf({ settleAt: new Date(NOW).toISOString() })).toBe('ready_now');
  });

  it('is "in window" when the review window has not elapsed', () => {
    expect(stateOf({ settleAt: FUTURE })).toBe('in_window');
  });

  it('is "approved, not initiated" when an approval is on file and nothing has been sent', () => {
    const entry = classifySettlementQueueRow(
      row({
        hasSettlementApproval: true,
        settlementApprovalSource: 'administrator',
        settlementApproval: verifiedApproval(),
      }),
      NOW,
    );
    expect(entry.state).toBe('approved_not_initiated');
    expect(entry.approvalSource).toBe('administrator');
    expect(entry.undeterminedReason).toBeNull();
  });

  it('keeps an automatic approval distinct from an administrator approval', () => {
    const automatic = classifySettlementQueueRow(
      row({
        hasSettlementApproval: true,
        settlementApprovalSource: 'system_auto_review_window',
        settlementApproval: verifiedApproval(),
      }),
      NOW,
    );
    expect(automatic.state).toBe('approved_not_initiated');
    expect(automatic.approvalSource).toBe('system_auto_review_window');
    // ...and the two are never collapsed into one another.
    expect(automatic.approvalSource).not.toBe('administrator');
  });

  it('reports an approval whose actor was never recorded as "unknown", not as automatic', () => {
    const entry = classifySettlementQueueRow(
      row({
        hasSettlementApproval: true,
        settlementApprovalSource: null,
        settlementApproval: { state: 'legacy' },
      }),
      NOW,
    );
    expect(entry.state).toBe('approved_not_initiated');
    expect(entry.approvalSource).toBe('unknown');
  });

  it('never treats approval as payment: approval does not move the row to "advancing"', () => {
    const approved = classifySettlementQueueRow(
      row({ hasSettlementApproval: true, settlementApproval: verifiedApproval() }),
      NOW,
    );
    expect(approved.state).not.toBe('advancing');
  });
});

describe('precedence — a moving leg outranks every other fact', () => {
  it('counts a row that is BOTH approved and advancing only as advancing', () => {
    const entry = classifySettlementQueueRow(
      row({
        hasSettlementApproval: true,
        settlementApprovalSource: 'administrator',
        settlementApproval: verifiedApproval(),
        payoutRecipients: [untouchedLeg(), untouchedLeg({ role: 'agent', payoutOutcome: 'accepted' })],
      }),
      NOW,
    );
    expect(entry.state).toBe('advancing');
    // No approval source is reported for a row that is not in the approved bucket.
    expect(entry.approvalSource).toBeNull();
  });

  it('treats every "may already have moved" outcome as advancing', () => {
    for (const payoutOutcome of ['submitting', 'accepted', 'unknown', 'rejected']) {
      const entry = classifySettlementQueueRow(
        row({ payoutRecipients: [untouchedLeg({ payoutOutcome })] }),
        NOW,
      );
      expect(entry.state, `${payoutOutcome} must be advancing`).toBe('advancing');
    }
  });

  it('treats a completed leg as advancing even when its history says never submitted', () => {
    expect(
      classifySettlementQueueRow(row({ payoutRecipients: [untouchedLeg({ status: 'completed' })] }), NOW).state,
    ).toBe('advancing');
    // A 'failed' row that was never submitted cannot be initiated either, and it
    // proves no attempt: it is unclassifiable rather than "advancing".
    expect(
      classifySettlementQueueRow(row({ payoutRecipients: [untouchedLeg({ status: 'failed' })] }), NOW).state,
    ).toBe('undetermined');
  });

  it('keeps an advancing leg ahead of an unreadable leg on the same row', () => {
    const entry = classifySettlementQueueRow(
      row({
        payoutRecipients: [
          // Unreadable: no submission history was published for this leg.
          untouchedLeg({ payoutOutcome: null }),
          untouchedLeg({ role: 'agent', payoutOutcome: 'submitting' }),
        ],
      }),
      NOW,
    );
    // The row proves an attempt, so it is advancing — not "need review".
    expect(entry.state).toBe('advancing');
    expect(entry.undeterminedReason).toBeNull();
  });

  it('leaves an untouched leg on a not-yet-elapsed window in "in window"', () => {
    expect(stateOf({ settleAt: FUTURE, payoutRecipients: [untouchedLeg(), untouchedLeg({ role: 'agent' })] }))
      .toBe('in_window');
  });

  it('does not infer advancing from claim status alone', () => {
    // The DTO the console reads carries no claim status on these rows; the
    // classification uses the payout legs only. A row with no legs published is
    // unclassifiable, not "advancing".
    expect(stateOf({ payoutRecipients: undefined })).toBe('undetermined');
  });
});

describe('an invalid or missing settlement time is never "ready now"', () => {
  it('is undetermined for a missing, empty or unparseable settleAt', () => {
    for (const settleAt of [undefined, null, '', 'not-a-date', {}, []]) {
      const entry = classifySettlementQueueRow(row({ settleAt }), NOW);
      expect(entry.state, `settleAt=${JSON.stringify(settleAt)}`).toBe('undetermined');
      expect(entry.undeterminedReason).toBeTruthy();
    }
  });

  it('is undetermined even when an approval is on file', () => {
    expect(
      stateOf({ settleAt: null, hasSettlementApproval: true, settlementApproval: { state: 'authorized' } }),
    ).toBe('undetermined');
  });

  it('accepts an epoch number and a Date as a settlement time', () => {
    expect(stateOf({ settleAt: NOW - 1000 })).toBe('ready_now');
    expect(stateOf({ settleAt: new Date(NOW + 60_000) })).toBe('in_window');
  });
});

describe('an unknown or incomplete payout state is undetermined, never guessed', () => {
  it('is undetermined when the legs were not published at all', () => {
    expect(classifySettlementQueueRow({ claimId: 'CLM-9', settleAt: PAST }, NOW).state).toBe('undetermined');
    expect(classifySettlementQueueRow({ claimId: 'CLM-9', settleAt: PAST, payoutRecipients: 'nope' }, NOW).state)
      .toBe('undetermined');
  });

  it('is undetermined for a legacy leg with no recorded submission history', () => {
    for (const payoutOutcome of [null, undefined, 'SOMETHING_NEW']) {
      expect(stateOf({ payoutRecipients: [untouchedLeg({ payoutOutcome })] })).toBe('undetermined');
    }
  });

  it('is undetermined when the approval snapshot cannot authorize a payout', () => {
    for (const state of ['incomplete', 'unreadable', 'not_approved', 'brand_new_state']) {
      const entry = classifySettlementQueueRow(
        row({ hasSettlementApproval: true, settlementApproval: { state } }),
        NOW,
      );
      expect(entry.state, `approval state ${state}`).toBe('undetermined');
      expect(entry.undeterminedReason).toContain('approval');
    }
  });

  it('is undetermined when the booked rows no longer match the approved rows', () => {
    const entry = classifySettlementQueueRow(
      row({
        hasSettlementApproval: true,
        settlementApproval: { state: 'authorized', bookedRowsAgreeWithApproval: false },
      }),
      NOW,
    );
    expect(entry.state).toBe('undetermined');
  });

  it('is undetermined when a snapshot exists but no approval is on file', () => {
    expect(stateOf({ hasSettlementApproval: false, settlementApproval: { state: 'authorized' } }))
      .toBe('undetermined');
  });

  it('is undetermined for a row that is not an object at all', () => {
    for (const bad of [null, undefined, 42, 'row', true]) {
      expect(classifySettlementQueueRow(bad, NOW).state).toBe('undetermined');
    }
  });
});

// =============================================================================
// STAGE 4B CLOSURE — THE FAIL-CLOSED CORRECTIONS (F3, F4, F5)
// =============================================================================
// Each block below pins one correction and the behaviour around it that must NOT
// change: a fact the console cannot fully read is never made actionable.

describe('F3 — a row with no payout legs is never actionable', () => {
  it('is undetermined for an empty payoutRecipients array, with a readable reason', () => {
    const entry = classifySettlementQueueRow(row({ payoutRecipients: [] }), NOW);
    expect(entry.state).toBe('undetermined');
    expect(entry.undeterminedReason).toBe('no payout recipient legs were reported');
    // No bucket and no approval source: nothing about the row is asserted.
    expect(entry.approvalSource).toBeNull();
  });

  it('stays undetermined for a missing or non-array recipient list', () => {
    for (const payoutRecipients of [undefined, null, 'nope', 42, {}]) {
      expect(stateOf({ payoutRecipients }), `payoutRecipients=${JSON.stringify(payoutRecipients)}`)
        .toBe('undetermined');
    }
  });

  it('keeps classifying a valid, non-empty recipient list', () => {
    expect(stateOf({ payoutRecipients: [untouchedLeg()] })).toBe('ready_now');
    expect(stateOf({ payoutRecipients: [untouchedLeg(), untouchedLeg({ role: 'agent' })] }))
      .toBe('ready_now');
  });

  it('never lets a zero-leg row into ready_now or approved_not_initiated', () => {
    const summary = classifySettlementQueue(
      [
        // An elapsed window with no approval: ready_now with one untouched leg.
        row({ claimId: 'READY', payoutRecipients: [] }),
        // An elapsed window with a VERIFIED approval: approved_not_initiated.
        row({
          claimId: 'APPROVED',
          hasSettlementApproval: true,
          settlementApprovalSource: 'administrator',
          settlementApproval: verifiedApproval(),
          payoutRecipients: [],
        }),
        // An open window: in_window.
        row({ claimId: 'WAITING', settleAt: FUTURE, payoutRecipients: [] }),
      ],
      NOW,
    );
    expect(summary.counts.ready_now).toBe(0);
    expect(summary.counts.in_window).toBe(0);
    expect(summary.counts.approved_not_initiated).toBe(0);
    expect(summary.counts.undetermined).toBe(3);
    // Zero legs is unclassifiable, not "nothing has begun" — the reason says so.
    for (const entry of summary.rows) {
      expect(entry.state).toBe('undetermined');
      expect(entry.undeterminedReason).toBe('no payout recipient legs were reported');
    }
  });
});

describe('F4 — an unverified approval-row comparison is not agreement', () => {
  it('accepts a VERIFIED authorized snapshot', () => {
    const entry = classifySettlementQueueRow(
      row({
        hasSettlementApproval: true,
        settlementApprovalSource: 'administrator',
        settlementApproval: verifiedApproval(),
      }),
      NOW,
    );
    expect(entry.state).toBe('approved_not_initiated');
    expect(entry.approvalSource).toBe('administrator');
    expect(entry.undeterminedReason).toBeNull();
  });

  it('is undetermined when the booked rows disagree with the approval', () => {
    const entry = classifySettlementQueueRow(
      row({
        hasSettlementApproval: true,
        settlementApproval: { state: 'authorized', bookedRowsAgreeWithApproval: false },
      }),
      NOW,
    );
    expect(entry.state).toBe('undetermined');
    expect(entry.undeterminedReason).toBe('the booked payout rows no longer match the approved rows');
  });

  it('is undetermined when the comparison could not be made (null or absent)', () => {
    for (const bookedRowsAgreeWithApproval of [null, undefined]) {
      const entry = classifySettlementQueueRow(
        row({
          hasSettlementApproval: true,
          settlementApproval: { state: 'authorized', bookedRowsAgreeWithApproval },
        }),
        NOW,
      );
      expect(entry.state, `bookedRowsAgreeWithApproval=${String(bookedRowsAgreeWithApproval)}`)
        .toBe('undetermined');
      expect(entry.undeterminedReason)
        .toBe('the approved payout rows could not be verified against the booked rows');
      // An unverified row is not offered as "approved, not initiated" either.
      expect(entry.approvalSource).toBeNull();
    }
  });
});

describe('F5 — an absent approval snapshot is not a legacy approval', () => {
  it('keeps an EXPLICIT legacy snapshot authorizable', () => {
    const entry = classifySettlementQueueRow(
      row({
        hasSettlementApproval: true,
        settlementApprovalSource: 'administrator',
        settlementApproval: { state: 'legacy' },
      }),
      NOW,
    );
    expect(entry.state).toBe('approved_not_initiated');
    expect(entry.approvalSource).toBe('administrator');
    expect(entry.undeterminedReason).toBeNull();
  });

  it('is undetermined when an approval is on file but the snapshot is absent or null', () => {
    for (const settlementApproval of [undefined, null]) {
      const entry = classifySettlementQueueRow(
        row({
          hasSettlementApproval: true,
          settlementApprovalSource: 'administrator',
          settlementApproval,
        }),
        NOW,
      );
      expect(entry.state).toBe('undetermined');
      expect(entry.undeterminedReason)
        .toBe('an approval is on file but the approval snapshot was not published');
      expect(entry.approvalSource).toBeNull();
    }
  });

  it('is undetermined when the snapshot is present but not an object', () => {
    for (const settlementApproval of ['nope', 42, []]) {
      expect(stateOf({ hasSettlementApproval: true, settlementApproval })).toBe('undetermined');
    }
  });

  it('keeps a snapshot-without-approval undetermined', () => {
    expect(stateOf({ hasSettlementApproval: false, settlementApproval: verifiedApproval() }))
      .toBe('undetermined');
  });

  it('keeps an unknown or malformed snapshot state undetermined', () => {
    for (const settlementApproval of [
      { state: 'brand_new_state' },
      { state: 'not_approved' },
      { state: 'incomplete' },
      { state: 'unreadable' },
      // A snapshot whose `state` is not even a string cannot authorize anything
      // either: it has no state to check and its rows were never verified.
      { state: 42 },
      {},
    ]) {
      const entry = classifySettlementQueueRow(
        row({ hasSettlementApproval: true, settlementApproval }),
        NOW,
      );
      expect(entry.state, JSON.stringify(settlementApproval)).toBe('undetermined');
    }
  });
});

describe('the whole queue — every row classified exactly once', () => {
  const mixed = [
    row({ claimId: 'READY' }),
    row({ claimId: 'WAITING', settleAt: FUTURE }),
    row({
      claimId: 'APPROVED-AUTO',
      hasSettlementApproval: true,
      settlementApprovalSource: 'system_auto_review_window',
      settlementApproval: verifiedApproval(),
    }),
    row({
      claimId: 'APPROVED-HUMAN',
      hasSettlementApproval: true,
      settlementApprovalSource: 'administrator',
      settlementApproval: verifiedApproval(),
    }),
    row({ claimId: 'MOVING', payoutRecipients: [untouchedLeg({ payoutOutcome: 'accepted' })] }),
    row({ claimId: 'UNKNOWN', settleAt: 'garbage' }),
  ];

  it('accounts for every input row exactly once (no duplicates, no omissions)', () => {
    const summary = classifySettlementQueue(mixed, NOW);
    expect(summary.total).toBe(mixed.length);
    expect(summary.rows).toHaveLength(mixed.length);
    const ids = summary.rows.map((entry) => entry.claimId);
    expect(new Set(ids).size).toBe(ids.length);

    const counted = SETTLEMENT_QUEUE_STATES.reduce((total, state) => total + summary.counts[state], 0);
    expect(counted).toBe(mixed.length);
    expect(summary.counts.ready_now + summary.counts.in_window
      + summary.counts.approved_not_initiated + summary.counts.advancing
      + summary.counts.undetermined).toBe(mixed.length);
  });

  it('counts each bucket once, from one classification per row', () => {
    const summary = classifySettlementQueue(mixed, NOW);
    expect(summary.counts.ready_now).toBe(1);
    expect(summary.counts.in_window).toBe(1);
    expect(summary.counts.approved_not_initiated).toBe(2);
    expect(summary.counts.advancing).toBe(1);
    expect(summary.counts.undetermined).toBe(1);
    // The two approval sources stay distinct in the tally too.
    expect(summary.approvalSources.system_auto_review_window).toBe(1);
    expect(summary.approvalSources.administrator).toBe(1);
    expect(summary.approvalSources.unknown).toBe(0);
  });

  it('distinguishes "not reported" from "empty"', () => {
    expect(classifySettlementQueue(undefined, NOW).reported).toBe(false);
    expect(classifySettlementQueue(null, NOW).reported).toBe(false);
    expect(classifySettlementQueue('nope', NOW).reported).toBe(false);
    expect(classifySettlementQueue(undefined, NOW).total).toBe(0);

    const empty = classifySettlementQueue([], NOW);
    expect(empty.reported).toBe(true);
    expect(empty.total).toBe(0);
    expect(empty.counts.ready_now).toBe(0);
  });

  it('is deterministic and never mutates its input', () => {
    const before = JSON.stringify(mixed);
    const first = classifySettlementQueue(mixed, NOW);
    const second = classifySettlementQueue(mixed, NOW);
    expect(second).toEqual(first);
    expect(JSON.stringify(mixed)).toBe(before);
  });
});

describe('the card copy the classification drives', () => {
  const textFor = (rows: unknown) => settlementQueueBreakdownText(classifySettlementQueue(rows, NOW));

  it('states the non-zero groups in reading order, with the approval source kept distinct', () => {
    const text = textFor([
      row({ claimId: '1' }),
      row({ claimId: '2' }),
      row({ claimId: '3', settleAt: FUTURE }),
      row({
        claimId: '4',
        hasSettlementApproval: true,
        settlementApprovalSource: 'system_auto_review_window',
        settlementApproval: verifiedApproval(),
      }),
      row({
        claimId: '5',
        hasSettlementApproval: true,
        settlementApprovalSource: 'administrator',
        settlementApproval: verifiedApproval(),
      }),
    ]);
    expect(text).toBe(
      '2 ready now · 1 in window · 2 approved, not initiated (1 automatic, 1 by an administrator)',
    );
    // A group with no rows is not mentioned at all.
    expect(text).not.toContain('payout activity recorded');
    expect(text).not.toContain('need review');
  });

  it('F1 — names the advancing group without claiming progress', () => {
    const text = textFor([
      row({ claimId: '1', payoutRecipients: [untouchedLeg({ payoutOutcome: 'accepted' })] }),
      row({
        claimId: '2',
        payoutRecipients: [untouchedLeg({ payoutOutcome: 'completed', status: 'completed' })],
      }),
    ]);
    expect(text).toBe('2 payout activity recorded');
    // The phrase it replaced read as "in progress", which is false for a refused
    // payout and understates one that has already been paid.
    expect(text).not.toContain('already started');
    // ...and the internal state name is not what an operator reads.
    expect(text).not.toContain('advancing');
  });

  it('says nothing reassuring about an empty queue and nothing numeric about an unreported one', () => {
    expect(textFor([])).toBe(SETTLEMENT_QUEUE_EMPTY_DESCRIPTION);
    expect(textFor(undefined)).toBe(SETTLEMENT_QUEUE_UNREPORTED_DESCRIPTION);
    expect(textFor(undefined)).not.toContain('0');
  });

  it('names the unclassified rows instead of folding them into a bucket', () => {
    const text = textFor([row({ claimId: 'X', settleAt: 'garbage' })]);
    expect(text).toBe('1 need review');
  });
});
