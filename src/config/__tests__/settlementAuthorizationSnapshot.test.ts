import { describe, it, expect } from 'vitest';
import {
  buildSettlementAuthorizationSnapshot,
  parseSettlementAuthorizationLedgerIds,
  compareSettlementAuthorization,
  toMinorUnits,
} from '../settlementAuthorizationSnapshot';

// =============================================================================
// BATCH 3 — THE APPROVAL SNAPSHOT, EXHAUSTIVELY.
// =============================================================================
// These are the rules the settlement executor depends on before it submits a
// payout: "is this the amount, to the rows, that an administrator approved?".
// Every ambiguous state is asserted to be a REFUSAL, because the alternative —
// treating an unreadable snapshot as agreement — would pay money nobody approved.
//
// The legacy case (no snapshot at all) is asserted to be ALLOWED and REPORTED,
// not refused: approvals recorded before this batch cannot be re-created, and
// blocking them would strand a legitimately approved payout forever.
// =============================================================================

const FINDER = { ledgerEntryId: 'TXN-F1', recipientType: 'finder' as const, amount: 250 };
const AGENT = { ledgerEntryId: 'TXN-A1', recipientType: 'agent' as const, amount: 350 };

describe('toMinorUnits — currency precision', () => {
  it('reads NUMERIC strings and numbers as minor units', () => {
    expect(toMinorUnits('250')).toBe(25000);
    expect(toMinorUnits('250.5')).toBe(25050);
    expect(toMinorUnits(350)).toBe(35000);
    expect(toMinorUnits('0')).toBe(0);
  });

  it('rounds half up at the second decimal, like NUMERIC(10,2)', () => {
    expect(toMinorUnits('250.005')).toBe(25001);
    expect(toMinorUnits('250.004')).toBe(25000);
  });

  it('refuses anything that is not a usable non-negative amount', () => {
    for (const bad of [null, undefined, '', '  ', 'abc', '12abc', -1, '-0.01', NaN, Infinity]) {
      expect(toMinorUnits(bad as any), `value=${String(bad)}`).toBeNull();
    }
  });
});

describe('buildSettlementAuthorizationSnapshot — what was covered', () => {
  it('sums the legs and serialises role:id pairs in canonical order', () => {
    const snapshot = buildSettlementAuthorizationSnapshot([AGENT, FINDER]);
    expect(snapshot.readable).toBe(true);
    expect(snapshot.totalMinorUnits).toBe(60000);
    expect(snapshot.serializedLedgerIds).toBe('finder:TXN-F1,agent:TXN-A1');
    expect(snapshot.ledgerIds).toEqual(['finder:TXN-F1', 'agent:TXN-A1']);
  });

  it('is order-independent', () => {
    expect(buildSettlementAuthorizationSnapshot([FINDER, AGENT]).serializedLedgerIds).toBe(
      buildSettlementAuthorizationSnapshot([AGENT, FINDER]).serializedLedgerIds,
    );
  });

  it('refuses an empty, duplicated, anonymous or unreadable set', () => {
    expect(buildSettlementAuthorizationSnapshot([]).reason).toBe('no_payout_legs');
    expect(buildSettlementAuthorizationSnapshot(undefined).reason).toBe('no_payout_legs');
    expect(
      buildSettlementAuthorizationSnapshot([FINDER, { ...FINDER }]).reason,
    ).toBe('duplicate_ledger_id');
    expect(
      buildSettlementAuthorizationSnapshot([{ ...FINDER, ledgerEntryId: '  ' }]).reason,
    ).toBe('missing_ledger_id');
    expect(
      buildSettlementAuthorizationSnapshot([{ ...FINDER, amount: 'not-a-number' }]).reason,
    ).toBe('unreadable_amount');
  });

  // THE DEFECT: distinct rows for the SAME recipient role used to be read as
  // two legitimate obligations and summed, so a doubled booking could be
  // approved for a doubled total. The 409 text already promised duplication was
  // refused; only duplicate IDS were.
  it('refuses two DISTINCT rows for the same payout role', () => {
    const secondFinder = { ledgerEntryId: 'TXN-F2', recipientType: 'finder' as const, amount: 250 };
    expect(buildSettlementAuthorizationSnapshot([FINDER, secondFinder]).reason).toBe('duplicate_role');
    expect(buildSettlementAuthorizationSnapshot([secondFinder, FINDER]).reason).toBe('duplicate_role');

    const secondAgent = { ledgerEntryId: 'TXN-A2', recipientType: 'agent' as const, amount: 350 };
    expect(buildSettlementAuthorizationSnapshot([AGENT, FINDER, secondAgent]).reason).toBe('duplicate_role');

    // The duplicate-role refusal is not a general tightening: one finder leg and
    // one agent leg remain a readable authorisation with the same total.
    const valid = buildSettlementAuthorizationSnapshot([FINDER, AGENT]);
    expect(valid.readable).toBe(true);
    expect(valid.totalMinorUnits).toBe(60000);
  });

  it('the same row twice is still reported as duplicate_ledger_id, not duplicate_role', () => {
    expect(
      buildSettlementAuthorizationSnapshot([FINDER, { ...FINDER, amount: 999 }]).reason,
    ).toBe('duplicate_ledger_id');
  });
});

describe('parseSettlementAuthorizationLedgerIds — the persisted form', () => {
  it('reads the canonical form, in any order', () => {
    expect(parseSettlementAuthorizationLedgerIds('finder:TXN-F1,agent:TXN-A1')).toHaveLength(2);
    expect(parseSettlementAuthorizationLedgerIds('agent:TXN-A1,finder:TXN-F1')).toEqual([
      { role: 'agent', id: 'TXN-A1' },
      { role: 'finder', id: 'TXN-F1' },
    ]);
  });

  it('returns null for anything that is not exactly that shape', () => {
    for (const bad of [null, undefined, '', '   ', 'finder', 'x:TXN-1', 'finder:', 'finder:TXN-F1,finder:TXN-F1']) {
      expect(parseSettlementAuthorizationLedgerIds(bad as any), `value=${String(bad)}`).toBeNull();
    }
  });
});

describe('compareSettlementAuthorization — the payout may only be what was approved', () => {
  const current = [FINDER, AGENT];

  it('treats a pre-snapshot approval as legacy and reports it (never a refusal)', () => {
    expect(compareSettlementAuthorization({ authorizedTotal: null, authorizedLedgerIds: null }, current)).toEqual({
      ok: true,
      code: 'legacy_approval',
      totalMinorUnits: null,
    });
  });

  it('refuses a half-written snapshot in either direction', () => {
    const withIdsOnly = compareSettlementAuthorization(
      { authorizedTotal: null, authorizedLedgerIds: 'finder:TXN-F1,agent:TXN-A1' },
      current,
    );
    const withTotalOnly = compareSettlementAuthorization(
      { authorizedTotal: '600.00', authorizedLedgerIds: null },
      current,
    );
    expect(withIdsOnly.ok).toBe(false);
    expect((withIdsOnly as any).code).toBe('incomplete_snapshot');
    expect(withTotalOnly.ok).toBe(false);
    expect((withTotalOnly as any).code).toBe('incomplete_snapshot');
  });

  it('refuses an unparseable snapshot and an unreadable approved amount', () => {
    expect(
      (compareSettlementAuthorization(
        { authorizedTotal: '600.00', authorizedLedgerIds: 'nonsense' },
        current,
      ) as any).code,
    ).toBe('unparseable_snapshot');
    expect(
      (compareSettlementAuthorization(
        { authorizedTotal: 'not-money', authorizedLedgerIds: 'finder:TXN-F1,agent:TXN-A1' },
        current,
      ) as any).code,
    ).toBe('unreadable_authorized_total');
  });

  it('accepts an exact match, independent of id order', () => {
    expect(
      compareSettlementAuthorization(
        { authorizedTotal: '600.00', authorizedLedgerIds: 'agent:TXN-A1,finder:TXN-F1' },
        [AGENT, FINDER],
      ),
    ).toEqual({ ok: true, code: 'matches', totalMinorUnits: 60000 });
  });

  it('refuses a different row set (a re-booked or swapped payout leg)', () => {
    const verdict = compareSettlementAuthorization(
      { authorizedTotal: '600.00', authorizedLedgerIds: 'finder:TXN-F1,agent:TXN-A1' },
      [{ ...FINDER, ledgerEntryId: 'TXN-F2' }, AGENT],
    );
    expect(verdict.ok).toBe(false);
    expect((verdict as any).code).toBe('ledger_ids_changed');
  });

  it('refuses a changed amount even when the rows are the same', () => {
    const verdict = compareSettlementAuthorization(
      { authorizedTotal: '600.00', authorizedLedgerIds: 'finder:TXN-F1,agent:TXN-A1' },
      [{ ...FINDER, amount: 260 }, AGENT],
    );
    expect(verdict.ok).toBe(false);
    expect((verdict as any).code).toBe('amount_changed');
  });

  it('refuses when the claim has no readable payout rows to compare', () => {
    expect(
      (compareSettlementAuthorization(
        { authorizedTotal: '600.00', authorizedLedgerIds: 'finder:TXN-F1,agent:TXN-A1' },
        [],
      ) as any).code,
    ).toBe('no_payout_legs');
    expect(
      (compareSettlementAuthorization(
        { authorizedTotal: '600.00', authorizedLedgerIds: 'finder:TXN-F1,agent:TXN-A1' },
        [{ ...FINDER, amount: 'abc' }, AGENT],
      ) as any).code,
    ).toBe('current_legs_unreadable');
  });

  // A claim that carries a DUPLICATED payout role cannot be compared with any
  // approval, and must never fall through to "matches": release is refused.
  it('refuses a claim whose current legs duplicate a payout role', () => {
    const verdict = compareSettlementAuthorization(
      { authorizedTotal: '600.00', authorizedLedgerIds: 'finder:TXN-F1,agent:TXN-A1' },
      [FINDER, { ...FINDER, ledgerEntryId: 'TXN-F2' }, AGENT],
    );
    expect(verdict.ok).toBe(false);
    expect((verdict as any).code).toBe('current_legs_unreadable');
    expect((verdict as any).message).toContain('duplicate_role');
  });
});
