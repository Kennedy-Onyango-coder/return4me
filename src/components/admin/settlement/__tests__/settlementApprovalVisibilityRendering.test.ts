import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import SettlementApprovalSummary from '../SettlementApprovalSummary';
import SettlementPayoutConfirmation from '../SettlementPayoutConfirmation';
import SettlementApproveAndPayConfirmation from '../SettlementApproveAndPayConfirmation';

// =============================================================================
// GATE 2 — WHAT THE OPERATOR ACTUALLY READS ABOUT AN APPROVAL.
// =============================================================================
// These assertions run against REAL rendered markup (react-dom/server), not
// against source text, so they pin what an administrator sees on:
//   * the pending-settlement row's shared summary block,
//   * the payout confirmation step,
//   * the combined "approve & pay" step.
//
// The requirement they protect is that all three describe the SAME authorization
// and that a missing, legacy or unreadable snapshot is shown as unavailable —
// never silently replaced by the claim fee or by a freshly calculated total.
// =============================================================================

const AUTHORIZED_ROWS = [
  { role: 'finder' as const, ledgerEntryId: 'TX-F', bookedAmount: '100.00', ledgerRowFound: true, ledgerRowRoleMatches: true },
  { role: 'agent' as const, ledgerEntryId: 'TX-A', bookedAmount: '150.00', ledgerRowFound: true, ledgerRowRoleMatches: true },
];

const payoutHandlers = {
  onCancel: () => {},
  onConfirm: () => {},
  password: '',
  onPasswordChange: () => {},
};

const approveAndPayHandlers = {
  ...payoutHandlers,
  reason: '',
  onReasonChange: () => {},
  // Required by the component: a request in flight disables both controls.
  submitting: false,
};

const renderPayout = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    React.createElement(SettlementPayoutConfirmation, {
      claimId: 'claim-77',
      itemId: 'item-9',
      lockedTotalFee: null,
      ...payoutHandlers,
      ...props,
    }),
  );

const renderApproveAndPay = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    React.createElement(SettlementApproveAndPayConfirmation, {
      claimId: 'claim-77',
      itemId: 'item-9',
      lockedTotalFee: null,
      ...approveAndPayHandlers,
      ...props,
    }),
  );

describe('GATE 2: a readable approval is shown with its total and covered rows', () => {
  it('renders the approved total and each covered row with its booked amount', () => {
    const html = renderPayout({
      approvalState: 'authorized',
      approvedTotal: '250.00',
      approvedLedgerRows: AUTHORIZED_ROWS,
      approvedRowsAgree: true,
    });
    expect(html).toContain('Approved payout total KES 250.00');
    expect(html).toContain('finder:TX-F');
    expect(html).toContain('KES 100.00 booked');
    expect(html).toContain('agent:TX-A');
    expect(html).toContain('KES 150.00 booked');
    expect(html).toContain('not a recalculation');
    // The platform share is described as NOT part of the payout.
    expect(html).toContain('The platform share of the claim fee is not part of this payout.');
  });

  it('renders the SAME total and rows in the combined approve & pay step', () => {
    const payoutHtml = renderPayout({
      approvalState: 'authorized',
      approvedTotal: '250.00',
      approvedLedgerRows: AUTHORIZED_ROWS,
      approvedRowsAgree: true,
    });
    const approveAndPayHtml = renderApproveAndPay({
      approvalState: 'authorized',
      approvedTotal: '250.00',
      approvedLedgerRows: AUTHORIZED_ROWS,
      approvedRowsAgree: true,
    });
    for (const expected of [
      'Approved payout total KES 250.00',
      'finder:TX-F',
      'KES 100.00 booked',
      'agent:TX-A',
      'KES 150.00 booked',
    ]) {
      expect(payoutHtml, expected).toContain(expected);
      expect(approveAndPayHtml, expected).toContain(expected);
    }
  });

  it('shows the PERSISTED total even when the booked rows no longer add up, and warns', () => {
    const html = renderPayout({
      approvalState: 'authorized',
      approvedTotal: '250.00',
      approvedLedgerRows: [
        { role: 'finder', ledgerEntryId: 'TX-F', bookedAmount: '40.00', ledgerRowFound: true, ledgerRowRoleMatches: true },
        { role: 'agent', ledgerEntryId: 'TX-A', bookedAmount: '50.00', ledgerRowFound: true, ledgerRowRoleMatches: true },
      ],
      approvedRowsAgree: false,
    });
    // The approved figure is not replaced by the rows' 90.00.
    expect(html).toContain('Approved payout total KES 250.00');
    expect(html).toContain('no longer add up to the approved total');
    expect(html).toContain('The server refuses this payout');
  });
});

describe('GATE 2: legacy, missing and unreadable snapshots are shown as unavailable', () => {
  it('states that a legacy approval has no stored total or rows, and shows no KES figure', () => {
    const html = renderPayout({ approvalState: 'legacy' });
    expect(html).toContain('predates approved-amount storage');
    expect(html).toContain('not available');
    expect(html).toContain('payout rows booked at handover');
    // No amount is invented: without lockedTotalFee this view renders no money.
    expect(html).not.toContain('KES');
  });

  it('states that an incomplete or unreadable snapshot cannot be shown', () => {
    for (const approvalState of ['incomplete', 'unreadable', 'unavailable']) {
      const html = renderPayout({ approvalState });
      expect(html, approvalState).toContain('carries no readable amount/row record');
      expect(html, approvalState).toContain('The server refuses this payout');
      expect(html, approvalState).not.toContain('Approved payout total');
    }
  });

  it('fails closed when the payload carries no approval state at all', () => {
    const html = renderPayout();
    expect(html).toContain('No settlement approval is on file, so no payout is authorized.');
    expect(html).not.toContain('Approved payout total');
  });

  it('tells the combined step what confirming records when no approval exists yet', () => {
    const html = renderApproveAndPay();
    expect(html).toContain('No settlement approval is on file yet');
    expect(html).toContain('payout rows booked at handover');
    // It describes what will be recorded; it does not present a total as approved.
    expect(html).not.toContain('Approved payout total');
  });
});

describe('GATE 2: a covered row that no longer matches is surfaced', () => {
  it('names a covered row that is missing from the ledger', () => {
    const html = renderPayout({
      approvalState: 'authorized',
      approvedTotal: '250.00',
      approvedLedgerRows: [
        { role: 'finder', ledgerEntryId: 'TX-F', bookedAmount: '100.00', ledgerRowFound: true, ledgerRowRoleMatches: true },
        { role: 'agent', ledgerEntryId: 'TX-GONE', bookedAmount: null, ledgerRowFound: false, ledgerRowRoleMatches: null },
      ],
      approvedRowsAgree: null,
    });
    // The row is still listed (it is part of what was approved)…
    expect(html).toContain('agent:TX-GONE');
    expect(html).toContain('row not found in the current ledger');
    // …and the refusal is stated rather than silently dropping the row.
    expect(html).toContain('is not in the current ledger. The server refuses this payout');
  });

  it('names a covered row that is not the payout leg the approval records', () => {
    const html = renderPayout({
      approvalState: 'authorized',
      approvedTotal: '250.00',
      approvedLedgerRows: [
        { role: 'finder', ledgerEntryId: 'TX-F', bookedAmount: '100.00', ledgerRowFound: true, ledgerRowRoleMatches: false },
        { role: 'agent', ledgerEntryId: 'TX-A', bookedAmount: '150.00', ledgerRowFound: true, ledgerRowRoleMatches: true },
      ],
    });
    expect(html).toContain('is not the payout leg the approval records');
  });

  it('names a covered row whose booked amount is unreadable', () => {
    const html = renderPayout({
      approvalState: 'authorized',
      approvedTotal: '250.00',
      approvedLedgerRows: [
        { role: 'finder', ledgerEntryId: 'TX-F', bookedAmount: null, ledgerRowFound: true, ledgerRowRoleMatches: true },
        { role: 'agent', ledgerEntryId: 'TX-A', bookedAmount: '150.00', ledgerRowFound: true, ledgerRowRoleMatches: true },
      ],
    });
    expect(html).toContain('booked amount unreadable');
    expect(html).toContain('has an amount this build cannot read');
  });
});

describe('GATE 2: the amounts are labelled so they cannot be confused', () => {
  it('labels the locked figure as the claim fee and the approved figure as the approved payout total', () => {
    const html = renderPayout({
      lockedTotalFee: 250,
      approvalState: 'authorized',
      approvedTotal: '250.00',
      approvedLedgerRows: AUTHORIZED_ROWS,
    });
    expect(html).toContain('KES 250 claim fee');
    expect(html).toContain('Approved payout total KES 250.00');
    // The approved total is NEVER labelled as a claim fee.
    expect(html).not.toMatch(/Approved payout total KES [\d.,]+[^<]{0,40}claim fee/i);
    // Nothing here claims money has already moved.
    expect(html).not.toMatch(/has been paid|payment sent|payout complete/i);
    expect(html).not.toContain('released');
  });

  it('never presents the claim fee as the approved amount', () => {
    const noSnapshot = renderPayout({ lockedTotalFee: 250, approvalState: 'legacy' });
    // The claim fee is still shown as the claim fee…
    expect(noSnapshot).toContain('KES 250 claim fee');
    // …but no approved total is fabricated from it.
    expect(noSnapshot).not.toContain('Approved payout total');
  });
});

describe('GATE 2: the shared summary is purely presentational', () => {
  it('holds no state, makes no request and knows no endpoint', () => {
    const source = readFileSync(new URL('../SettlementApprovalSummary.tsx', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/use(?:State|Effect|Ref|Memo|Callback|Reducer|Context|LayoutEffect)\s*\(/);
    expect(code).not.toContain('fetch(');
    expect(code).not.toContain('/api/');
    // It cannot compute an approved amount: it only renders what it is given.
    expect(code).not.toContain('reduce(');
  });

  it('renders without invoking either control of the payout confirmation', () => {
    let confirmed = 0;
    let cancelled = 0;
    renderToStaticMarkup(
      React.createElement(SettlementPayoutConfirmation, {
        claimId: 'claim-77',
        itemId: 'item-9',
        lockedTotalFee: null,
        approvalState: 'authorized',
        approvedTotal: '250.00',
        approvedLedgerRows: AUTHORIZED_ROWS,
        password: '',
        onPasswordChange: () => {},
        onCancel: () => { cancelled += 1; },
        onConfirm: () => { confirmed += 1; },
      }),
    );
    expect(confirmed).toBe(0);
    expect(cancelled).toBe(0);
  });

  it('renders the summary on its own for every state without throwing', () => {
    for (const approvalState of ['not_approved', 'authorized', 'legacy', 'incomplete', 'unreadable', 'unavailable', '', undefined]) {
      const html = renderToStaticMarkup(
        React.createElement(SettlementApprovalSummary, {
          approvalState,
          approvedTotal: approvalState === 'authorized' ? '250.00' : null,
          approvedLedgerRows: AUTHORIZED_ROWS,
        }),
      );
      expect(html.length, String(approvalState)).toBeGreaterThan(0);
    }
  });
});
