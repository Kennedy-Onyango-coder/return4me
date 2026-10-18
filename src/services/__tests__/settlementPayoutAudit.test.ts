import { describe, it, expect } from 'vitest';
import { maskPhoneForLog } from '../auth';
import {
  buildSettlementPayoutPlan,
  formatSettlementPayoutPlanForAudit,
  settlementDestinationFacts,
  describeSettlementDestinationDrift,
  maskSettlementDestination,
  type SettlementPayoutLeg,
} from '../settlementPayoutAudit';

// =============================================================================
// BATCH 1 (E) — THE AUDIT SNAPSHOT'S CONTENT, ASSERTED AS A VALUE.
// =============================================================================
// The audit trail is a security control here: it is how an incident is
// reconstructed ("which recipient, how much, which ledger row, when"). Two
// properties matter and neither is visible from the route's source:
//   1. the snapshot is COMPLETE — every leg, its ledger row, its amount, the
//      claim reference and the total;
//   2. the snapshot is SAFE — a destination never appears unmasked.
// Keeping those rules in a pure module is what makes them decidable here.
// =============================================================================

const legs: SettlementPayoutLeg[] = [
  {
    ledgerEntryId: 'LED-AGENT-1',
    recipientType: 'agent',
    destination: '+254700000123',
    payoutMethodType: 'Personal M-Pesa',
    amount: 150,
  },
  {
    ledgerEntryId: 'LED-FINDER-1',
    recipientType: 'finder',
    destination: '+254700000456',
    payoutMethodType: 'Personal M-Pesa',
    amount: 100,
  },
];

describe('BATCH 1 (E) — settlement payout plan', () => {
  it('sums the legs and states the currency instead of assuming it', () => {
    const plan = buildSettlementPayoutPlan({ claimId: 'C-1', paymentReference: 'REF-1', legs });
    expect(plan.currency).toBe('KES');
    expect(plan.totalAmount).toBe(250);
    expect(plan.claimId).toBe('C-1');
    expect(plan.paymentReference).toBe('REF-1');
    expect(plan.legs.length).toBe(2);
  });

  it('omits a missing payment reference rather than inventing one', () => {
    const plan = buildSettlementPayoutPlan({ claimId: 'C-1', legs: [] });
    expect(plan.paymentReference).toBeNull();
    expect(plan.totalAmount).toBe(0);
  });

  it('does not let a caller mutate the plan it was given', () => {
    const input = legs.map((l) => ({ ...l }));
    const plan = buildSettlementPayoutPlan({ claimId: 'C-1', legs: input });
    input[0].amount = 999999;
    expect(plan.legs[0].amount).toBe(150);
  });
});


describe('BATCH 1 (E) — the audit line is complete and masked', () => {
  const plan = buildSettlementPayoutPlan({ claimId: 'C-1', paymentReference: 'REF-1', legs });
  const line = formatSettlementPayoutPlanForAudit(plan);

  it('names the claim, its payment reference, the total and every ledger row', () => {
    expect(line).toContain('claim=C-1');
    expect(line).toContain('payment_reference=REF-1');
    expect(line).toContain('total=KES 250');
    expect(line).toContain('row=LED-AGENT-1');
    expect(line).toContain('row=LED-FINDER-1');
    expect(line).toContain('KES 150');
    expect(line).toContain('KES 100');
  });

  it('NEVER contains an unmasked destination', () => {
    expect(line).not.toContain('+254700000123');
    expect(line).not.toContain('+254700000456');
    expect(line).toContain(maskPhoneForLog('+254700000123'));
    expect(line).toContain(maskPhoneForLog('+254700000456'));
  });

  it("uses the repository's single masking rule", () => {
    expect(maskSettlementDestination('+254700000123')).toBe(maskPhoneForLog('+254700000123'));
    // A short or missing value is fully masked rather than partially revealed.
    expect(maskSettlementDestination('')).toBe(maskPhoneForLog(''));
    expect(maskSettlementDestination(null)).toBe(maskPhoneForLog(null));
    expect(maskSettlementDestination('123')).toBe('***');
  });

  it('never prints NaN into an audit row', () => {
    const broken = buildSettlementPayoutPlan({
      claimId: 'C-2',
      legs: [{ ...legs[0], amount: Number.NaN }],
    });
    const rendered = formatSettlementPayoutPlanForAudit(broken);
    expect(rendered).toContain('KES unknown');
    expect(rendered).not.toContain('NaN');
  });
});

describe('BATCH 1 (E) — destination drift', () => {
  it('reports nothing when the destinations are unchanged', () => {
    const a = settlementDestinationFacts({
      finderPhone: '+254700000456',
      agentDestination: '+254700000123',
      agentPayoutMethodType: 'Personal M-Pesa',
    });
    const b = settlementDestinationFacts({
      finderPhone: '+254700000456',
      agentDestination: '+254700000123',
      agentPayoutMethodType: 'Personal M-Pesa',
    });
    expect(describeSettlementDestinationDrift(a, b)).toEqual([]);
  });

  it('names the leg and the field that changed, without the values', () => {
    const before = settlementDestinationFacts({
      finderPhone: '+254700000456',
      agentDestination: '+254700000123',
      agentPayoutMethodType: 'Personal M-Pesa',
    });
    const after = settlementDestinationFacts({
      finderPhone: '+254700000999',
      agentDestination: '+254700000123',
      agentPayoutMethodType: 'Personal M-Pesa',
    });
    const drift = describeSettlementDestinationDrift(before, after);
    expect(drift).toEqual(['finder destination changed']);
    expect(drift.join(' ')).not.toContain('+254700000999');
    expect(drift.join(' ')).not.toContain('+254700000456');
  });

  it('reports a payout-method change separately from a destination change', () => {
    const before = settlementDestinationFacts({ finderPhone: '+254700000456', agentDestination: '+254700000123', agentPayoutMethodType: 'Personal M-Pesa' });
    const after = settlementDestinationFacts({ finderPhone: '+254700000456', agentDestination: '+254700000123', agentPayoutMethodType: 'Till Number' });
    expect(describeSettlementDestinationDrift(before, after)).toEqual([
      'agent payout method changed (Personal M-Pesa -> Till Number)',
    ]);
  });

  it('treats an added or removed destination as drift rather than equality', () => {
    const withAgent = settlementDestinationFacts({ agentDestination: '+254700000123' });
    const withoutAgent = settlementDestinationFacts({ agentDestination: '' });
    expect(describeSettlementDestinationDrift(withAgent, withoutAgent)).toEqual(['agent destination removed']);
    expect(describeSettlementDestinationDrift(withoutAgent, withAgent)).toEqual(['agent destination added']);
  });

  it('represents a missing destination as null, not as an empty string', () => {
    const facts = settlementDestinationFacts({ finderPhone: '', agentDestination: null });
    expect(facts.finder).toBeNull();
    expect(facts.agent).toBeNull();
  });

  it("defaults the agent payout method to the executor's own default", () => {
    const facts = settlementDestinationFacts({ agentDestination: '+254700000123' });
    expect(facts.agent?.payoutMethodType).toBe('Till Number');
  });
});
