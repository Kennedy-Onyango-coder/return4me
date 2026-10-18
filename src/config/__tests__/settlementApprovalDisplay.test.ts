import { describe, expect, it } from 'vitest';
import {
  describeSettlementApproval,
  formatPersistedCurrencyAmount,
  SETTLEMENT_APPROVAL_NOTES,
} from '../settlementApprovalDisplay';

// =============================================================================
// GATE 2 — WHAT THE CONSOLE MAY SAY ABOUT AN APPROVAL.
// =============================================================================
// The Admin Console now shows the approved total and the payout rows an approval
// covered. These assertions pin the ONE rule that makes that safe to display:
// the values come from the PERSISTED approval snapshot and from nowhere else.
//
// The cases are the ones an operator can actually meet:
//   * a normal approval (both columns set, readable);
//   * a legacy approval (approved before snapshots existed);
//   * a snapshot that is missing or half-written;
//   * a snapshot that cannot be parsed;
//   * a covered row that is gone, re-typed, or no longer adds up;
//   * a claim with no approval at all.
// In every non-readable case the approved total is NULL — never a number derived
// from `items.locked_total_fee`, the ledger rows or the claim fee.
// =============================================================================

const approved = (overrides: Record<string, unknown> = {}) => ({
  approvedAt: '2026-10-01T10:00:00.000Z',
  authorizedTotal: '250.00',
  authorizedLedgerIds: 'finder:TX-F,agent:TX-A',
  ...overrides,
});

const ledger = [
  { id: 'TX-F', type: 'finder_payout', amount: '100.00' },
  { id: 'TX-A', type: 'agent_payout', amount: '150.00' },
  { id: 'TX-P', type: 'platform_fee', amount: '40.00' },
];

describe('GATE 2: a readable approval shows the PERSISTED total and rows', () => {
  it('reports the stored total, the covered rows and the booked amounts', () => {
    const summary = describeSettlementApproval(approved(), ledger);

    expect(summary.state).toBe('authorized');
    expect(summary.authorizedTotal).toBe('250.00');
    expect(summary.note).toBe(SETTLEMENT_APPROVAL_NOTES.authorized);
    // Canonical role order: finder before agent, exactly as the gate sorts them.
    expect(summary.ledgerIds).toEqual(['finder:TX-F', 'agent:TX-A']);
    expect(summary.rows).toEqual([
      {
        role: 'finder',
        ledgerEntryId: 'TX-F',
        key: 'finder:TX-F',
        bookedAmount: '100.00',
        ledgerRowFound: true,
        ledgerRowRoleMatches: true,
      },
      {
        role: 'agent',
        ledgerEntryId: 'TX-A',
        key: 'agent:TX-A',
        bookedAmount: '150.00',
        ledgerRowFound: true,
        ledgerRowRoleMatches: true,
      },
    ]);
    expect(summary.bookedRowsAgreeWithApproval).toBe(true);
  });

  it('NEVER recalculates the approved total from the booked rows', () => {
    // The stored approval says 250.00; the rows now book 90.00. The displayed
    // total must stay the stored one and the disagreement must be visible.
    const summary = describeSettlementApproval(approved(), [
      { id: 'TX-F', type: 'finder_payout', amount: '40.00' },
      { id: 'TX-A', type: 'agent_payout', amount: '50.00' },
    ]);
    expect(summary.state).toBe('authorized');
    expect(summary.authorizedTotal).toBe('250.00');
    expect(summary.bookedRowsAgreeWithApproval).toBe(false);
  });

  it('does not treat the platform leg as a recipient row', () => {
    const summary = describeSettlementApproval(approved(), ledger);
    expect(summary.ledgerIds).not.toContain('platform:TX-P');
    expect(summary.rows.some((row) => row.ledgerEntryId === 'TX-P')).toBe(false);
  });

  it('formats a NUMERIC string at currency precision without floating point drift', () => {
    const summary = describeSettlementApproval(
      approved({ authorizedTotal: '250.5', authorizedLedgerIds: 'finder:TX-F,agent:TX-A' }),
      ledger,
    );
    expect(summary.authorizedTotal).toBe('250.50');
    expect(formatPersistedCurrencyAmount('250.005')).toBe('250.01');
    expect(formatPersistedCurrencyAmount(0)).toBe('0.00');
  });
});

describe('GATE 2: a legacy or missing snapshot is NAMED, never replaced', () => {
  it('reports a legacy approval (both columns NULL) without a total or rows', () => {
    const summary = describeSettlementApproval(
      approved({ authorizedTotal: null, authorizedLedgerIds: null }),
      ledger,
    );
    expect(summary.state).toBe('legacy');
    expect(summary.authorizedTotal).toBeNull();
    expect(summary.rows).toEqual([]);
    expect(summary.bookedRowsAgreeWithApproval).toBeNull();
    expect(summary.note).toBe(SETTLEMENT_APPROVAL_NOTES.legacy);
  });

  it('treats missing columns exactly like NULLs — still legacy, still no amount', () => {
    const summary = describeSettlementApproval({ approvedAt: '2026-10-01T10:00:00.000Z' }, ledger);
    expect(summary.state).toBe('legacy');
    expect(summary.authorizedTotal).toBeNull();
  });

  it('refuses to read a HALF-written snapshot as a legacy approval', () => {
    const totalOnly = describeSettlementApproval(
      approved({ authorizedLedgerIds: null }),
      ledger,
    );
    expect(totalOnly.state).toBe('incomplete');
    expect(totalOnly.authorizedTotal).toBeNull();

    const idsOnly = describeSettlementApproval(approved({ authorizedTotal: null }), ledger);
    expect(idsOnly.state).toBe('incomplete');
    expect(idsOnly.authorizedTotal).toBeNull();
  });

  it('reports an unparseable row list as unreadable, with no partial rows', () => {
    const summary = describeSettlementApproval(approved({ authorizedLedgerIds: 'finder:TX-F,buyer:TX-A' }), ledger);
    expect(summary.state).toBe('unreadable');
    expect(summary.rows).toEqual([]);
    expect(summary.authorizedTotal).toBeNull();
  });

  it('reports an unreadable total as unreadable rather than guessing one', () => {
    const summary = describeSettlementApproval(approved({ authorizedTotal: 'KES 250' }), ledger);
    expect(summary.state).toBe('unreadable');
    expect(summary.authorizedTotal).toBeNull();
    expect(summary.note).toBe(SETTLEMENT_APPROVAL_NOTES.unreadable);
  });

  it('shows nothing as authorized for a claim with NO approval, even with a snapshot present', () => {
    const summary = describeSettlementApproval(approved({ approvedAt: null }), ledger);
    expect(summary.state).toBe('not_approved');
    expect(summary.authorizedTotal).toBeNull();
    expect(summary.rows).toEqual([]);
    expect(summary.note).toBe(SETTLEMENT_APPROVAL_NOTES.not_approved);
  });

  it('produces a named state for a missing claim rather than throwing', () => {
    expect(describeSettlementApproval(null).state).toBe('not_approved');
    expect(describeSettlementApproval(undefined).state).toBe('not_approved');
  });
});

describe('GATE 2: a covered row that no longer matches is reported, not repaired', () => {
  it('flags a covered row that is missing from the ledger', () => {
    const summary = describeSettlementApproval(approved(), [ledger[0]]);
    const agentRow = summary.rows.find((row) => row.ledgerEntryId === 'TX-A')!;
    expect(agentRow.ledgerRowFound).toBe(false);
    expect(agentRow.bookedAmount).toBeNull();
    expect(agentRow.ledgerRowRoleMatches).toBeNull();
    // Undeterminable, so the diagnostic is NULL rather than a reassuring false.
    expect(summary.bookedRowsAgreeWithApproval).toBeNull();
    // The PERSISTED total and row list are still shown exactly as approved.
    expect(summary.authorizedTotal).toBe('250.00');
    expect(summary.ledgerIds).toEqual(['finder:TX-F', 'agent:TX-A']);
  });

  it('flags a covered row whose ledger type is not the leg the approval recorded', () => {
    const summary = describeSettlementApproval(approved(), [
      { id: 'TX-F', type: 'agent_payout', amount: '100.00' },
      { id: 'TX-A', type: 'agent_payout', amount: '150.00' },
    ]);
    expect(summary.rows[0].ledgerRowRoleMatches).toBe(false);
    expect(summary.rows[1].ledgerRowRoleMatches).toBe(true);
  });

  it('flags an unreadable booked amount and leaves the approved total untouched', () => {
    const summary = describeSettlementApproval(approved(), [
      { id: 'TX-F', type: 'finder_payout', amount: 'not-a-number' },
      { id: 'TX-A', type: 'agent_payout', amount: '150.00' },
    ]);
    expect(summary.rows[0].bookedAmount).toBeNull();
    expect(summary.authorizedTotal).toBe('250.00');
    expect(summary.bookedRowsAgreeWithApproval).toBeNull();
  });

  it('stays independent of the claim fee and the platform share', () => {
    // Neither figure is an input: the same snapshot and rows produce the same
    // display whatever the item or platform share happens to be.
    const withoutLedger = describeSettlementApproval(approved(), []);
    expect(withoutLedger.state).toBe('authorized');
    expect(withoutLedger.authorizedTotal).toBe('250.00');
    expect(withoutLedger.bookedRowsAgreeWithApproval).toBeNull();
    expect(withoutLedger.rows.every((row) => row.ledgerRowFound === false)).toBe(true);
  });
});
