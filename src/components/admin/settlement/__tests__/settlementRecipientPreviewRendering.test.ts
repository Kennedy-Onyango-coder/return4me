import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SettlementRecipientPreview, {
  SETTLEMENT_RECIPIENTS_NONE_TEXT,
  SETTLEMENT_RECIPIENTS_UNAVAILABLE_TEXT,
  describeSettlementLegState,
  type SettlementRecipientLeg,
} from '../SettlementRecipientPreview';
import { maskPayoutDestinationForLog } from '../../../../config/payoutDestinations';

// =============================================================================
// ADM-007 — WHAT THE CONFIRMATION STEP SAYS ABOUT WHO WOULD BE PAID.
// =============================================================================
// These assertions run against REAL rendered markup (react-dom/server), the same
// way `settlementApprovalVisibilityRendering.test.ts` pins the approved totals,
// so they describe what an operator reads on the irreversible confirmation step
// rather than what the source file contains.
//
// Two properties are being protected:
//   1. every persisted payout leg is NAMED, with the destination the server
//      masked and the amount the server booked, and with the leg's own
//      submission state in the executor's vocabulary; and
//   2. a payload this build cannot read is stated as unavailable, and the block
//      carries NO control of its own — no approve, initiate, retry or re-arm.
//
// The component is deliberately prop-only and receives destinations ALREADY
// MASKED by the server (`maskedDestination`, built in server.ts from
// `maskPayoutDestinationForLog`). The test therefore proves the rendered output
// of a server-shaped leg, and never introduces a second masking policy.
// =============================================================================

const RAW_PHONE = '+254712345678';
const MASKED_PHONE = '+254712***678';

const finderLeg: SettlementRecipientLeg = {
  role: 'finder',
  maskedDestination: MASKED_PHONE,
  amount: '100.00',
  status: 'pending',
  payoutOutcome: 'not_submitted',
};

const agentLeg: SettlementRecipientLeg = {
  role: 'agent',
  maskedDestination: '254798***321',
  amount: '150.00',
  status: 'pending',
  payoutOutcome: 'accepted',
};

const render = (legs?: readonly SettlementRecipientLeg[] | null) =>
  renderToStaticMarkup(React.createElement(SettlementRecipientPreview, { legs }));

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('ADM-007: the preview names every leg this action would pay', () => {
  it('renders one row per persisted leg, with its masked destination and booked amount', () => {
    const html = render([finderLeg, agentLeg]);

    expect(occurrences(html, '<li')).toBe(2);
    expect(html).toContain('Finder payout');
    expect(html).toContain('Agent payout');

    // The destinations are exactly what the server sent, untouched.
    expect(html).toContain(MASKED_PHONE);
    expect(html).toContain('254798***321');

    // The amounts are the ones BOOKED on the ledger rows — not recomputed.
    expect(html).toContain('KES 100.00');
    expect(html).toContain('KES 150.00');
    expect(html).toContain('Each amount is the amount booked on that payout row');
  });

  it('renders the canonical masker’s output and never the full number it came from', () => {
    const masked = maskPayoutDestinationForLog(RAW_PHONE);
    expect(masked).toBe(MASKED_PHONE);

    const html = render([{ ...finderLeg, maskedDestination: masked }]);

    expect(html).toContain(MASKED_PHONE);
    // Neither spelling of the full number reaches the operator's screen.
    expect(html).not.toContain(RAW_PHONE);
    expect(html).not.toContain('254712345678');
  });

  it('describes each leg’s own submission state in the executor’s vocabulary', () => {
    const html = render([finderLeg, agentLeg]);

    // Never submitted: the only state that is a fresh, submittable payout.
    expect(html).toContain('Not submitted yet');
    // Acceptance is not completion — and the label does not claim it is.
    expect(html).toContain('Accepted by provider — not yet confirmed');
    expect(html).not.toMatch(/has been paid|payment sent|payout complete/i);
  });

  it('states that an amount was not recorded rather than showing KES 0', () => {
    const html = render([{ ...finderLeg, amount: null }]);
    expect(html).toContain('amount not recorded');
    expect(html).not.toContain('KES 0');
  });
});


describe('ADM-007: unreadable and empty payloads are stated, never dropped', () => {
  it('reports a payload that could not be read as unavailable', () => {
    for (const legs of [undefined, null]) {
      const html = render(legs);
      expect(html, String(legs)).toContain(SETTLEMENT_RECIPIENTS_UNAVAILABLE_TEXT);
      expect(html).toContain('Payout recipients');
      // No leg is invented, and no amount is shown for one.
      expect(html).not.toContain('Finder payout');
      expect(html).not.toContain('KES ');
    }
  });

  it('reports an empty leg list as nothing to confirm', () => {
    const html = render([]);
    expect(html).toContain(SETTLEMENT_RECIPIENTS_NONE_TEXT);
    expect(html).not.toContain('Finder payout');
    expect(html).not.toContain('KES ');
  });
});

describe('ADM-007: a destination the payout policy cannot pay is shown as blocked', () => {
  it('labels every unreadable or missing destination, and repeats the policy reason', () => {
    const html = render([
      { ...finderLeg, maskedDestination: '(none)' },
      { ...agentLeg, maskedDestination: '***' },
      { ...agentLeg, maskedDestination: '   ' },
    ]);

    expect(occurrences(html, 'Destination unavailable')).toBe(3);
    expect(
      occurrences(
        html,
        'This destination cannot be paid under the phone-only payout policy.',
      ),
    ).toBe(3);
    // The placeholder markers are never presented as if they were a destination.
    expect(html).not.toContain('(none)');
  });
});

describe('ADM-007: the preview carries no control of its own', () => {
  it('renders no button, form or input, and offers no payout action', () => {
    const html = render([finderLeg, agentLeg]);

    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<form');
    expect(html).not.toMatch(/approve|release settlement|re-arm|initiate|retry payout|send payout/i);
  });
});

describe('the leg-state vocabulary the operator is shown', () => {
  const leg = (overrides: Partial<SettlementRecipientLeg>): SettlementRecipientLeg => ({
    role: 'finder',
    maskedDestination: MASKED_PHONE,
    amount: '100.00',
    status: 'pending',
    payoutOutcome: null,
    ...overrides,
  });

  it('treats a completed ledger row as provider-confirmed and blocking', () => {
    const state = describeSettlementLegState(leg({ status: 'completed' }));
    expect(state.label).toBe('Completed — provider-confirmed');
    expect(state.variant).toBe('success');
    expect(state.blocking).toBe(true);
  });

  it('treats only not_submitted as a fresh, submittable payout', () => {
    const state = describeSettlementLegState(leg({ payoutOutcome: 'not_submitted' }));
    expect(state.label).toBe('Not submitted yet');
    expect(state.variant).toBe('pending');
    expect(state.blocking).toBe(false);
  });

  it('blocks every in-flight, accepted, unknown or rejected outcome', () => {
    const expected = [
      ['submitting', 'Submission in flight — do not resend', 'warning'],
      ['accepted', 'Accepted by provider — not yet confirmed', 'warning'],
      ['unknown', 'Outcome unknown — reconciliation required', 'danger'],
      ['rejected', 'Rejected — no transfer was made', 'danger'],
      ['completed', 'Completed — provider-confirmed', 'success'],
    ] as const;

    for (const [outcome, label, variant] of expected) {
      const state = describeSettlementLegState(leg({ payoutOutcome: outcome }));
      expect(state.label, outcome).toBe(label);
      expect(state.variant, outcome).toBe(variant);
      expect(state.blocking, outcome).toBe(true);
    }
  });

  it('reads a missing submission history as UNRESOLVED, not as never submitted', () => {
    for (const payoutOutcome of [null, undefined, '']) {
      const state = describeSettlementLegState(leg({ payoutOutcome }));
      expect(state.label, String(payoutOutcome)).toBe('No submission history recorded');
      expect(state.variant).toBe('neutral');
      expect(state.blocking).toBe(true);
    }
  });

  it('never uses a label that claims money has already moved', () => {
    const outcomes = [undefined, null, 'not_submitted', 'submitting', 'accepted', 'unknown', 'rejected', 'completed'];
    for (const payoutOutcome of outcomes) {
      const { label } = describeSettlementLegState(leg({ payoutOutcome }));
      expect(label, String(payoutOutcome)).not.toMatch(/\bpaid\b/i);
    }
  });
});
