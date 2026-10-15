import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import PayoutIntegrityHubsTable, { PENDING_EARNINGS_UNSTATABLE_TEXT } from '../PayoutIntegrityHubsTable';
import { NOT_RECORDED_TEXT } from '../PayoutReconciliationTable';
import { readPayoutIntegrityHubs } from '../payoutIntegrityPresentation';

// =============================================================================
// PROGRAMME 1 / WS1 + WS2 + WS5 — WHAT THE PER-HUB VERDICT TABLE ACTUALLY RENDERS
// =============================================================================
// "Which hubs can never be paid?" is the question an administrator acts on, and a
// wrong answer is money. So these assertions are made against REAL rendered HTML
// (`react-dom/server`, the same approach as the sibling payout-reconciliation
// rendering test), with the fixtures built through the real read model, so the
// mapping and the table are exercised together.
//
// Pinned, in order of consequence:
//   1. the table is READ-ONLY — it contains no control of any kind;
//   2. only the MASKED destination can appear, never a raw number;
//   3. a value the row does not carry says so — never blank, never 0;
//   4. an unreadable verdict is stated as unreadable, never as payable;
//   5. a total that cannot be stated is stated in words, not as a smaller sum.
// =============================================================================

const RAW_UNMASKED_NUMBER = '254712345678';

const rows = readPayoutIntegrityHubs([
  {
    id: 'agent-payable',
    business_name: 'Payable Hub',
    payout_eligibility: {
      eligible: true,
      risk_class: 'eligible',
      masked_destination: '2547****789',
      summary: 'Format and method only.',
    },
    pending_earnings: 1500,
    pending_earnings_count: 2,
  },
  {
    id: 'agent-refused',
    business_name: 'Refused Hub',
    payout_eligibility: {
      eligible: false,
      risk_class: 'refused_destination_not_a_personal_mpesa_phone',
      masked_destination: RAW_UNMASKED_NUMBER,
      summary: 'This hub cannot be paid.',
    },
    pending_earnings: null,
    pending_earnings_count: 4,
  },
  { id: 'agent-unreadable', business_name: 'Unreadable Hub' },
]);

const html = renderToStaticMarkup(React.createElement(PayoutIntegrityHubsTable, { rows }));

describe('the hub verdict table is read-only by construction', () => {
  it('renders no button, input, select, form or handler', () => {
    expect(html).not.toMatch(/<button|<input|<select|<form/);
  });

  it('names itself as a region an assistive-technology user can enter', () => {
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Payout eligibility by hub"');
  });

  it('carries no logging and no markup injection', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/components/admin/payouts/PayoutIntegrityHubsTable.tsx'), 'utf8');
    expect(source).not.toMatch(/console\./);
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });
});

describe('the table states the four facts an operator needs, per column', () => {
  it('labels the columns it fills, including the masked-destination and owed columns', () => {
    expect(html).toContain('Hub');
    expect(html).toContain('Payout destination (masked)');
    expect(html).toContain('Launch-policy verdict');
    expect(html).toContain('Earned, not yet paid');
  });

  it('renders the masked destination and NEVER the raw number', () => {
    expect(html).toContain('2547****789');
    expect(html).not.toContain(RAW_UNMASKED_NUMBER);
  });

  it('states a missing hub id with the visible missing marker, not a blank cell', () => {
    expect(html).toContain(NOT_RECORDED_TEXT);
  });

  it('states an unstatable owed total in words rather than as 0', () => {
    // The refused hub's total could not be stated, so the table says so instead of
    // printing a smaller sum — and its 4 owed rows are never rendered as 0.
    expect(html).toContain(PENDING_EARNINGS_UNSTATABLE_TEXT);
    // The payable hub's genuine figures are stated plainly.
    expect(html).toContain('2 payout row(s) recorded as owed and not yet paid out.');
  });

  it('distinguishes a payable hub from a refused one and from an unreadable verdict', () => {
    expect(html).toContain('Payable');
    expect(html).toContain('Refused — destination is not a personal M-Pesa number');
    expect(html).toContain('Verdict not readable by this console — treat as not payable');
    // The unreadable row is never dressed as the safe answer: its class is stated
    // as not recorded. The label and its value are separate spans, so they are
    // asserted separately rather than as one contiguous string.
    expect(html).toContain('Class: ');
    expect(html).toContain(NOT_RECORDED_TEXT);
  });

  it('states that this build offers NO control that corrects a refused destination', () => {
    // F1. The copy must not imply an operator action that does not exist. It has to
    // say all four things: the console explains the verdict; no correction control
    // exists in this build; the value cannot be fixed here; and retrying a refused
    // payout does not correct the destination.
    expect(html).toContain(
      'Settlement refuses this hub as it stands. This build provides no control that corrects a stored destination or method, so the value cannot be fixed here; retrying a refused payout does not correct it. This screen only reports the verdict.',
    );

    // The false claim must be gone, not merely overridden by a true sentence: no
    // wording may point an operator at an Agents Hub repair action or a retry that
    // is framed as the fix.
    expect(html).not.toContain('Agents Hub action');
    expect(html).not.toContain('Correcting the destination');
    expect(html).not.toContain('then retry the payout');
  });
});
