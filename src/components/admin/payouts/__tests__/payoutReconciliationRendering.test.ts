import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import PayoutReconciliationTable, { NOT_RECORDED_TEXT } from '../PayoutReconciliationTable';
import PayoutReconciliationPanel, { PAYOUT_RECONCILIATION_PANEL_ID } from '../PayoutReconciliationPanel';
import {
  mapPayoutReconciliationItem,
  type AdminPayoutReconciliationItemDto,
} from '../../../../services/adminPayoutReconciliationApi';

// =============================================================================
// BATCH 2 — WHAT THE UNRESOLVED-PAYOUT SURFACE ACTUALLY RENDERS.
// =============================================================================
// This panel is the ONLY place an administrator can see which payouts are not
// confirmed paid, and a payout in that state MAY ALREADY HAVE MOVED MONEY. A
// misread row therefore cannot be corrected by trying again — it is money. So
// the assertions below are made against REAL rendered HTML (`react-dom/server`,
// the same approach as components/admin/settlement/__tests__/
// settlementPayoutConfirmationRendering.test.ts) rather than against source
// text, and the fixtures are built through the real mapping function so the
// privacy-bounded type and the table are exercised together.
//
// The properties pinned here, in order of consequence:
//   1. the table is READ-ONLY — no button, input, select or form exists in it;
//   2. a raw recipient number can never be rendered (only the masked value);
//   3. a value the row does not carry says so, and never renders as blank or 0;
//   4. an 'accepted' outcome is never presented as a completed payment;
//   5. the panel's first paint is a loading state, NOT "No unresolved payouts".

const DEFAULT_DTO: AdminPayoutReconciliationItemDto = {
  ledgerEntryId: 'led-1',
  claimId: 'claim-1',
  itemId: 'item-1',
  type: 'finder_payout',
  amount: 1500,
  status: 'pending',
  payoutOutcome: 'accepted',
  providerBatchId: 'batch-9',
  providerTransactionId: 'txn-1',
  recipient: '0712345678',
  reason: null,
  createdAt: '2026-10-01T08:30:00.000Z',
};

/** A row as the service module would produce it for the console. */
function row(overrides: Partial<AdminPayoutReconciliationItemDto> = {}) {
  const mapped = mapPayoutReconciliationItem({ ...DEFAULT_DTO, ...overrides });
  if (!mapped) throw new Error('fixture did not map to a row');
  return mapped;
}

const renderTable = (rows: ReturnType<typeof row>[]) =>
  renderToStaticMarkup(React.createElement(PayoutReconciliationTable, { rows }));

const SOURCE_DIR = new URL('../', import.meta.url);
const readSource = (file: string) => readFileSync(new URL(file, SOURCE_DIR), 'utf8');
/** Source with comments removed, so prose about a control is not mistaken for one. */
const code = (file: string) =>
  readSource(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('Batch 2: the payout table reports, and offers nothing to click', () => {
  it('renders no control of any kind — the rows are visible, not actionable', () => {
    const html = renderTable([row()]);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('href=');
  });

  it('never offers to resend, retry, refund or mark a payout paid', () => {
    const source = code('PayoutReconciliationTable.tsx');
    expect(source).not.toMatch(/resubmit|re-?send|refund|mark as paid|markPaid|retry/i);
    expect(source).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('/api/');
  });

  it('is pure enough to be rendered on the server: no state, effects or handlers', () => {
    const source = code('PayoutReconciliationTable.tsx');
    expect(source).not.toMatch(/use(?:State|Effect|Ref|Memo|Callback|Reducer|Context|LayoutEffect)\s*\(/);
    expect(source).not.toMatch(/on[A-Z]\w*=/);
    expect(source).not.toContain('window.');
  });

  it('labels every column, so a figure is never ambiguous', () => {
    const html = renderTable([]);
    for (const heading of ['Payout', 'Amount', 'Ledger status', 'Provider outcome', 'Recipient', 'Provider references', 'Recorded']) {
      expect(html, heading).toContain(heading);
    }
  });
});


describe('Batch 2: a row is rendered field by field, and money is never invented', () => {
  it('shows the amount, the payout type, the ledger status and the provider references', () => {
    const html = renderTable([row()]);
    expect(html).toContain('KES 1500.00');
    expect(html).toContain('Finder payout');
    expect(html).toContain('pending');
    expect(html).toContain('batch-9');
    expect(html).toContain('txn-1');
    expect(html).toContain('claim-1');
    expect(html).toContain('item-1');
    expect(html).toContain('led-1');
  });

  it('RENDERS ONLY THE MASKED RECIPIENT — the raw number is not in the output at all', () => {
    const html = renderTable([row()]);
    expect(html).toContain('0712***678');
    expect(html).not.toContain('0712345678');
    expect(html).toContain('Masked');
  });

  it('states that an amount is missing instead of rendering 0, and does state a real 0', () => {
    const missing = renderTable([row({ amount: null })]);
    expect(missing).toContain('No amount was recorded for this row.');
    expect(missing).not.toContain('KES 0.00');

    // A genuine zero is a real figure and must NOT be hidden behind the marker.
    const zero = renderTable([row({ amount: 0 })]);
    expect(zero).toContain('KES 0.00');
    expect(zero).not.toContain('No amount was recorded for this row.');
  });

  it('marks every absent value with the visible marker — never a blank cell', () => {
    const html = renderTable([row({
      ledgerEntryId: null,
      claimId: null,
      itemId: null,
      status: null,
      providerBatchId: null,
      providerTransactionId: null,
      recipient: null,
      createdAt: null,
    })]);
    expect(html).toContain(NOT_RECORDED_TEXT);
    expect(html).toContain('Age unknown');
    // The recipient column must not fall back to a fabricated placeholder.
    expect(html).not.toContain('Masked');
  });

  it('shows no recorded reason when the row carries none', () => {
    expect(renderTable([row({ reason: null })])).not.toContain('Recorded reason:');
    expect(renderTable([row({ reason: 'balance too low' })])).toContain('balance too low');
  });
});

describe('Batch 2: an unresolved row can never read as a completed payment', () => {
  it('renders an accepted transfer as NOT confirmed paid', () => {
    const html = renderTable([row({ payoutOutcome: 'accepted' })]);
    expect(html).toContain('NOT confirmed paid');
    expect(html).not.toContain('Completed — confirmed paid');
  });

  it('renders a null outcome as unverified history, not as "never submitted"', () => {
    const html = renderTable([row({ payoutOutcome: null })]);
    expect(html).toContain('No submission history recorded');
    expect(html).toContain('verify with the provider');
  });

  it('renders an unrecognized outcome as unresolved and shows the raw token', () => {
    const html = renderTable([row({ payoutOutcome: 'weird_state' })]);
    expect(html).toContain('Unrecognized outcome recorded');
    expect(html).toContain('weird_state');
  });

  it('does render a confirmed transfer as completed — the report is not one-sided', () => {
    const html = renderTable([row({ payoutOutcome: 'completed' })]);
    expect(html).toContain('Completed — confirmed paid');
  });
});

// -----------------------------------------------------------------------------
// THE PANEL. `react-dom/server` does not run effects, which is exactly what
// makes the FIRST PAINT assertable here: what an operator sees before any read
// has completed. Everything that happens after a read is decided in the effect
// below it, so those rules are pinned against the source instead — with the
// comment-stripped code, so prose ABOUT a rule can never satisfy it.
// -----------------------------------------------------------------------------

const renderPanel = (token: string | null = 'session-token') =>
  renderToStaticMarkup(React.createElement(PayoutReconciliationPanel, { token }));

describe('Batch 2: the panel names itself, and is labelled by its own heading', () => {
  it('carries the id the console disclosure points at, and points aria-labelledby at a real h2', () => {
    const html = renderPanel();
    expect(html).toContain(`id="${PAYOUT_RECONCILIATION_PANEL_ID}"`);
    expect(html).toContain('aria-labelledby="payout-reconciliation-heading"');
    expect(html).toContain('id="payout-reconciliation-heading"');
    expect(html).toContain('<h2');
  });

  it('says what it is and that it is read-only', () => {
    const html = renderPanel();
    expect(html).toContain('Unresolved payouts');
    expect(html).toContain('Operations');
    expect(html).toContain('Read-only');
    expect(html).toContain('check each row with the provider');
  });
});

describe('Batch 2: the first paint is a read in progress — never an empty list', () => {
  it('shows a loading state and does NOT claim there is nothing to reconcile', () => {
    const html = renderPanel();
    expect(html).toContain('Reading the unresolved-payout list…');
    expect(html).toContain('aria-busy="true"');
    // "No unresolved payouts" before a successful read would be an assertion
    // about money that nothing has verified yet.
    expect(html).not.toContain('No unresolved payouts');
    expect(html).not.toContain('Last read');
    // The "not read yet" and "last read" lines describe a FINISHED read, so
    // neither may appear while the first read is still in flight.
    expect(html).not.toContain('This list has not been read yet');
  });

  it('renders no table and no error banner until a read has actually finished', () => {
    const html = renderPanel();
    expect(html).not.toContain('<table');
    expect(html).not.toContain('role="alert"');
  });

  it('offers exactly ONE control, and it is the disabled re-read', () => {
    const html = renderPanel();
    expect((html.match(/<button/g) ?? []).length).toBe(1);
    expect(html).toContain('Refresh');
    expect(html).toContain('Reading unresolved payouts'); // the sr-only loading label
    expect(html).toContain('disabled');
    expect(html).toContain('aria-busy="true"');
  });


describe('Batch 2: the panel cannot re-send a payout — it can only re-READ the list', () => {
  it('issues exactly one read per (mount, refresh), and no other network call', () => {
    const source = code('PayoutReconciliationPanel.tsx');
    expect(source.match(/fetchUnresolvedPayouts\(/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toContain('axios');
    expect(source).not.toContain('/api/'); // the path lives in the service module
    expect(source).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
  });

  it('re-reads only by bumping a token — the Refresh control is not a resend', () => {
    const source = code('PayoutReconciliationPanel.tsx');
    expect(source).toContain('setReloadToken((n) => n + 1)');
    expect(source).toMatch(/useEffect\([\s\S]*\[token, reloadToken\]\)/);
  });

  it('names no mutation: no retry, no resubmit, no refund, no "mark as paid" control', () => {
    const source = code('PayoutReconciliationPanel.tsx');
    // The only place those words may appear is the read-only explanation shown
    // to the operator — never as an interpolated handler or request.
    expect(source).not.toMatch(/\b(retry|resubmit|refund|markPaid|markAsPaid)\b\s*[:(=]/);
    expect(source).not.toMatch(/onClick=\{[^}]*\b(payout|send|submissions?)\b/i);
  });

  it('never logs anything', () => {
    expect(code('PayoutReconciliationPanel.tsx')).not.toMatch(/console\./);
    expect(code('PayoutReconciliationTable.tsx')).not.toMatch(/console\./);
  });
});

describe('Batch 2: a failed read can never look like good news', () => {
  it('cancels the read on unmount, so leaving the tab starts nothing and leaves nothing pending', () => {
    const source = code('PayoutReconciliationPanel.tsx');
    expect(source).toContain('new AbortController()');
    expect(source).toContain('return () => controller.abort()');
    expect(source).toMatch(/signal:\s*controller\.signal/);
  });

  it('guards every state write with the request sequence, so a stale read cannot overwrite a newer one', () => {
    const source = code('PayoutReconciliationPanel.tsx');
    expect(source).toContain('requestIdRef');
    expect(source.match(/requestId !== requestIdRef\.current/g) ?? []).toHaveLength(3); // then / catch / finally
  });

  it('stays completely silent about a deliberately cancelled read', () => {
    const source = code('PayoutReconciliationPanel.tsx');
    expect(source).toMatch(/err\.isAbort\)\s*return;/);
    // The abort branch must come BEFORE the branch that sets an error message.
    expect(source.indexOf('err.isAbort')).toBeLessThan(source.indexOf('setError(err instanceof'));
  });

  it('keeps the last good rows and warns that they may be out of date', () => {
    const source = code('PayoutReconciliationPanel.tsx');
    expect(source).toContain("kind={hasRows ? 'warning' : 'error'}");
    expect(source).toContain('The rows below are from the last successful read and may be out of date.');
    // A failed read must never clear the rows it already had.
    expect(source).not.toMatch(/setRows\(\[\]\)|setRows\(\(\) => \[\]\)/);
  });

  it('shows the empty state ONLY after a successful read that returned no rows', () => {
    const source = code('PayoutReconciliationPanel.tsx');
    // ...which is what this ternary says: empty state only when there is no error.
    expect(source).toMatch(/\)\s*:\s*error\s*\?\s*null\s*:\s*\(/);
    expect(source).toContain('No unresolved payouts');
  });
});

  it('is one section, so the console can disclose it as a single unit', () => {
    const html = renderPanel();
    expect((html.match(/<section/g) ?? []).length).toBe(1);
  });
});
