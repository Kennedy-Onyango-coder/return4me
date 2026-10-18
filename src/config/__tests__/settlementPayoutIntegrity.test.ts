import { describe, expect, it } from 'vitest';
import {
  compareSettlementAmount,
  compareSettlementDestination,
  formatSettlementAmountFromMinorUnits,
  isSettlementAmountRefusal,
  isSettlementDestinationRefusal,
  resolveSettlementPayoutIntegrity,
  settlementAmountToMinorUnits,
} from '../settlementPayoutIntegrity';

// =============================================================================
// BATCH 1.1 — THE LEDGER-INTEGRITY RULE FOR A PAYOUT ATTEMPT.
// =============================================================================
// The executor refuses to submit a leg whose PLANNED amount or destination
// differs from what the claim's own ledger row BOOKED. These tests pin that rule
// as a pure function: currency precision, canonical phone comparison, the
// fail-closed reading of anything unreadable, and the all-or-nothing shape the
// caller relies on.
//
// They are deliberately separate from the HTTP suite: an integration test can
// show that one mismatch refuses a claim, but only these can show the boundary
// cases (1.005, '100.00', '0712 345 678') that decide whether a real payout is
// refused or wrongly allowed.
// =============================================================================

describe('BATCH 1.1 — payout amounts are compared at ledger currency precision', () => {
  it('treats the NUMERIC(10,2) string and the computed number as the same amount', () => {
    expect(compareSettlementAmount('100.00', 100)).toEqual({
      ok: true,
      bookedMinorUnits: 10000,
      plannedMinorUnits: 10000,
    });
    expect(compareSettlementAmount('150.50', 150.5).ok).toBe(true);
    // The mock/in-memory double returns rows as inserted; Postgres returns
    // NUMERIC as a string. Both shapes must work.
    expect(compareSettlementAmount(100, 100).ok).toBe(true);
  });

  it('rounds both sides to the currency scale before comparing', () => {
    // Below one cent of noise is not a difference in KES.
    expect(compareSettlementAmount('100.00', 100.004).ok).toBe(true);
    expect(compareSettlementAmount('100.00', 99.999999).ok).toBe(true);
    // Half-up on the currency scale, the same reading feeEngine uses.
    expect(settlementAmountToMinorUnits(1.005)).toBe(101);
    expect(settlementAmountToMinorUnits(0.1 + 0.2)).toBe(30);
    expect(settlementAmountToMinorUnits('100.005')).toBe(10001);
    expect(formatSettlementAmountFromMinorUnits(10001)).toBe('100.01');
  });

  it('reports a real difference as a mismatch, with both amounts', () => {
    const verdict = compareSettlementAmount('100.00', 125);
    expect(verdict.ok).toBe(false);
    // `strict` is off in this project, so a `true`/`false` discriminant is not
    // narrowed by `!verdict.ok`. The exported predicate narrows in both modes.
    if (!isSettlementAmountRefusal(verdict)) throw new Error('expected an amount refusal');
    expect(verdict.reason).toBe('amount_mismatch');
    expect(verdict.bookedMinorUnits).toBe(10000);
    expect(verdict.plannedMinorUnits).toBe(12500);
  });

  it('refuses an unreadable booked amount instead of treating it as zero or as a match', () => {
    for (const booked of [null, undefined, '', '   ', 'not-a-number', NaN, Infinity, -1, {}, []]) {
      const verdict = compareSettlementAmount(booked, 100);
      expect(verdict.ok, JSON.stringify(booked)).toBe(false);
      if (!isSettlementAmountRefusal(verdict)) throw new Error('expected an amount refusal');
      expect(verdict.reason, JSON.stringify(booked)).toBe('booked_amount_unreadable');
    }
  });

  it('refuses an unreadable planned amount', () => {
    for (const planned of [null, undefined, '', 'NaN', NaN, -5, {}, true]) {
      const verdict = compareSettlementAmount('100.00', planned);
      expect(verdict.ok, String(planned)).toBe(false);
      if (!isSettlementAmountRefusal(verdict)) throw new Error('expected an amount refusal');
      expect(verdict.reason, String(planned)).toBe('planned_amount_unreadable');
    }
  });
});

describe('BATCH 1.1 — payout destinations are compared in canonical phone form', () => {
  it('accepts the same handset written differently', () => {
    for (const booked of ['0712345678', '+254712345678', '254712345678', '0712 345 678', '0712-345-678']) {
      const verdict = compareSettlementDestination(booked, '+254712345678');
      expect(verdict.ok, booked).toBe(true);
    }
    // ...and in the other direction: booked canonical, live national format.
    expect(compareSettlementDestination('+254712345678', '0712345678').ok).toBe(true);
    expect(compareSettlementDestination('0110000000', '254110000000').ok).toBe(true);
  });

  it('treats a different recipient number as a change', () => {
    const verdict = compareSettlementDestination('+254712345678', '+254712345679');
    expect(verdict.ok).toBe(false);
    if (!isSettlementDestinationRefusal(verdict)) throw new Error('expected a destination refusal');
    expect(verdict.reason).toBe('destination_changed');
  });

  it('refuses a booked destination it cannot canonicalise (Till, Paybill, blank)', () => {
    for (const booked of ['123456', 'E2E-TILL', '', '   ', null, undefined, '+255712345678']) {
      const verdict = compareSettlementDestination(booked, '+254712345678');
      expect(verdict.ok, String(booked)).toBe(false);
      if (!isSettlementDestinationRefusal(verdict)) throw new Error('expected a destination refusal');
      expect(verdict.reason, String(booked)).toBe('booked_destination_unreadable');
    }
  });

  it('refuses a planned destination it cannot canonicalise', () => {
    const verdict = compareSettlementDestination('+254712345678', '123456');
    expect(verdict.ok).toBe(false);
    if (!isSettlementDestinationRefusal(verdict)) throw new Error('expected a destination refusal');
    expect(verdict.reason).toBe('planned_destination_unreadable');
  });
});

describe('BATCH 1.1 — the batch verdict is all-or-nothing and PII-free', () => {
  const finderRow = {
    recipientType: 'finder' as const,
    ledgerEntryId: 'TXN-FINDER',
    bookedAmount: '100.00',
    bookedDestination: '+254700000456',
    plannedAmount: 100,
    plannedDestination: '0700000456',
  };
  const agentRow = {
    recipientType: 'agent' as const,
    ledgerEntryId: 'TXN-AGENT',
    bookedAmount: '150.00',
    bookedDestination: '254700000123',
    plannedAmount: 150,
    plannedDestination: '+254700000123',
  };

  it('resolves ok when every leg matches its booked row, even across format differences', () => {
    const result = resolveSettlementPayoutIntegrity([finderRow, agentRow]);
    expect(result.ok).toBe(true);
    expect(result.amountMismatches).toEqual([]);
    expect(result.destinationMismatches).toEqual([]);
    expect(result.legs.map((l) => l.recipientType)).toEqual(['finder', 'agent']);
    expect(result.legs.every((l) => l.amount.ok && l.destination.ok)).toBe(true);
  });

  it('fails the WHOLE batch when one leg mismatches, naming only that leg', () => {
    const result = resolveSettlementPayoutIntegrity([
      finderRow,
      { ...agentRow, plannedAmount: 175 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.amountMismatches).toHaveLength(1);
    expect(result.amountMismatches[0]).toContain('TXN-AGENT');
    expect(result.amountMismatches[0]).toContain('150.00');
    expect(result.amountMismatches[0]).toContain('175.00');
    expect(result.destinationMismatches).toEqual([]);
    // The matching finder leg is still reported as matching — the CALLER must
    // not be able to read "ok: false" as "submit the other one".
    expect(result.legs.find((l) => l.ledgerEntryId === 'TXN-FINDER')?.amount.ok).toBe(true);
  });

  it('reports both sides when amount and destination are both wrong', () => {
    const result = resolveSettlementPayoutIntegrity([
      { ...finderRow, plannedAmount: 1, plannedDestination: '+254711111111' },
      agentRow,
    ]);
    expect(result.ok).toBe(false);
    expect(result.amountMismatches).toHaveLength(1);
    expect(result.destinationMismatches).toHaveLength(1);
    expect(result.destinationMismatches[0]).toContain('TXN-FINDER');
  });

  it('never puts a full phone number in a refusal sentence', () => {
    const result = resolveSettlementPayoutIntegrity([
      { ...finderRow, plannedDestination: '+254711111111' },
      agentRow,
    ]);
    expect(result.ok).toBe(false);
    const rendered = [...result.amountMismatches, ...result.destinationMismatches].join(' ');
    expect(rendered).not.toContain('+254700000456');
    expect(rendered).not.toContain('+254711111111');
    expect(rendered).toContain('***');
  });

  it('treats an empty or absent leg list as nothing to object to (the caller decides whether to submit)', () => {
    expect(resolveSettlementPayoutIntegrity([]).ok).toBe(true);
    expect(resolveSettlementPayoutIntegrity(null).ok).toBe(true);
    expect(resolveSettlementPayoutIntegrity(undefined).ok).toBe(true);
  });
});
