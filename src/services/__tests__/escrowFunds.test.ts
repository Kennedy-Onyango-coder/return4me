import { describe, it, expect } from 'vitest';
import {
  computeEscrowFundsHeld,
  toFeeNumber,
  ESCROW_HELD_STATUS,
} from '../escrowFunds';

// Phase 10 (F-2). The admin console rendered a card labelled "Escrow Funds Held"
// whose value was `claims.filter(c => c.status === 'escrow_held').length` — a
// COUNT of claims, sitting immediately beside a genuine `KES {totalRevenue}`
// card, so it read as money. These tests pin the replacement aggregate:
//
//   amount = SUM(items.locked_total_fee) WHERE claim.status = 'escrow_held'
//
// `items.locked_total_fee` is the fee locked at report time from the fee engine
// and is the SAME field the money path charges (resolveAuthoritativePaymentFee),
// so it is the authoritative figure for money held on an escrowed claim.
//
// These are behavioural assertions against the real function, not source-text
// checks: they exercise the aggregation with realistic row shapes (including the
// NUMERIC-as-string form the database layer actually produces).

const item = (id: string, lockedTotalFee: unknown) => ({
  id,
  locked_total_fee: lockedTotalFee,
});

const escrowClaim = (id: string, itemId: string | null) => ({
  id,
  item_id: itemId,
  status: ESCROW_HELD_STATUS,
});

const claimWithStatus = (id: string, itemId: string, status: string) => ({
  id,
  item_id: itemId,
  status,
});

describe('computeEscrowFundsHeld — the money actually held in escrow', () => {
  it('one escrow-held claim contributes its full locked fee', () => {
    const result = computeEscrowFundsHeld([escrowClaim('CLM-1', 'R4M-001')], [item('R4M-001', 1500)]);
    expect(result.amount).toBe(1500);
    expect(result.count).toBe(1);
  });

  it('sums multiple escrow-held claims', () => {
    const claims = [
      escrowClaim('CLM-1', 'R4M-001'),
      escrowClaim('CLM-2', 'R4M-002'),
      escrowClaim('CLM-3', 'R4M-003'),
    ];
    const items = [item('R4M-001', 1500), item('R4M-002', 250), item('R4M-003', 75.5)];

    const result = computeEscrowFundsHeld(claims, items);

    expect(result.amount).toBe(1825.5);
    expect(result.count).toBe(3);
  });

  it('excludes every claim that is not in escrow_held', () => {
    // Only CLM-ESCROW is escrowed; the others must contribute nothing even
    // though their items all carry a locked fee.
    const claims = [
      claimWithStatus('CLM-PENDING', 'R4M-001', 'pending_verification'),
      claimWithStatus('CLM-AWAITING', 'R4M-002', 'awaiting_agent_confirmation'),
      claimWithStatus('CLM-PAYMENT', 'R4M-003', 'pending_payment'),
      claimWithStatus('CLM-SETTLE', 'R4M-004', 'pending_settlement'),
      claimWithStatus('CLM-RELEASED', 'R4M-005', 'released'),
      claimWithStatus('CLM-REFUNDED', 'R4M-006', 'refunded'),
      claimWithStatus('CLM-REJECTED', 'R4M-007', 'rejected'),
      claimWithStatus('CLM-DISPUTED', 'R4M-008', 'disputed'),
      claimWithStatus('CLM-REFUNDING', 'R4M-009', 'refunding'),
      claimWithStatus('CLM-EXPIRED', 'R4M-010', 'payment_window_expired'),
      escrowClaim('CLM-ESCROW', 'R4M-011'),
    ];
    const items = [
      item('R4M-001', 100), item('R4M-002', 100), item('R4M-003', 100),
      item('R4M-004', 100), item('R4M-005', 100), item('R4M-006', 100),
      item('R4M-007', 100), item('R4M-008', 100), item('R4M-009', 100),
      item('R4M-010', 100), item('R4M-011', 999),
    ];

    const result = computeEscrowFundsHeld(claims, items);

    // 11 claims exist, 10 carry fees of 100 each, but only the escrowed one
    // counts — proving both the status filter and that fees are not summed
    // across non-escrow rows.
    expect(result.amount).toBe(999);
    expect(result.count).toBe(1);
  });

  it('returns KES 0 with no claims in escrow', () => {
    const result = computeEscrowFundsHeld(
      [claimWithStatus('CLM-1', 'R4M-001', 'released')],
      [item('R4M-001', 1500)],
    );
    expect(result.amount).toBe(0);
    expect(result.count).toBe(0);
  });

  it('returns 0 for empty collections and for absent collections', () => {
    expect(computeEscrowFundsHeld([], [])).toEqual({ amount: 0, count: 0 });
    expect(computeEscrowFundsHeld(null, null)).toEqual({ amount: 0, count: 0 });
    expect(computeEscrowFundsHeld(undefined, undefined)).toEqual({ amount: 0, count: 0 });
    expect(computeEscrowFundsHeld([], [item('R4M-001', 1500)])).toEqual({ amount: 0, count: 0 });
  });

  it('still counts an escrowed claim whose item or locked fee cannot be resolved, contributing 0 to the total', () => {
    // The claim genuinely IS in escrow, so the count must reflect it; the money
    // cannot be attributed, so it adds nothing. Neither fact is invented from
    // the other.
    const claims = [
      escrowClaim('CLM-1', 'R4M-MISSING'),   // no such item
      escrowClaim('CLM-2', null),            // item_id absent
      escrowClaim('CLM-3', 'R4M-NULLFEE'),   // locked fee null
      escrowClaim('CLM-4', 'R4M-UNDEFINED'), // locked fee absent
      escrowClaim('CLM-5', 'R4M-ZERO'),      // locked fee 0
      escrowClaim('CLM-6', 'R4M-GARBAGE'),   // locked fee unparseable
      escrowClaim('CLM-7', 'R4M-OK'),        // the one real contribution
    ];
    const items = [
      item('R4M-NULLFEE', null),
      { id: 'R4M-UNDEFINED' },
      item('R4M-ZERO', 0),
      item('R4M-GARBAGE', 'not-a-number'),
      item('R4M-OK', 500),
    ];

    const result = computeEscrowFundsHeld(claims, items);

    expect(result.count).toBe(7);
    expect(result.amount).toBe(500);
  });

  it('never lets a 0, negative or non-finite locked fee subtract from the total', () => {
    const claims = [escrowClaim('CLM-1', 'R4M-A'), escrowClaim('CLM-2', 'R4M-B'), escrowClaim('CLM-3', 'R4M-C')];
    const items = [item('R4M-A', 100), item('R4M-B', -50), item('R4M-C', 'NaN')];

    const result = computeEscrowFundsHeld(claims, items);

    expect(result.amount).toBe(100);
    expect(result.count).toBe(3);
  });

  it('handles the NUMERIC-as-string form the database layer produces', () => {
    // db/database.ts parses NUMERIC columns into numbers, but the raw row form
    // is a string — the same defensive conversion the existing code path uses.
    const claims = [escrowClaim('CLM-1', 'R4M-001'), escrowClaim('CLM-2', 'R4M-002')];
    const items = [item('R4M-001', '1500.00'), item('R4M-002', '250.25')];

    const result = computeEscrowFundsHeld(claims, items);

    expect(result.amount).toBe(1750.25);
  });

  it('rounds the total to the column scale so the UI cannot show float artefacts', () => {
    // NUMERIC(10,2) values summed as JS numbers would otherwise render as
    // 0.30000000000000004.
    const claims = [
      escrowClaim('CLM-1', 'R4M-A'),
      escrowClaim('CLM-2', 'R4M-B'),
      escrowClaim('CLM-3', 'R4M-C'),
    ];
    const items = [item('R4M-A', 0.1), item('R4M-B', 0.2), item('R4M-C', 0.3)];

    const result = computeEscrowFundsHeld(claims, items);

    expect(result.amount).toBe(0.6);
    expect(String(result.amount)).toBe('0.6');
  });

  it('does not mutate the rows it is given', () => {
    const claims = [escrowClaim('CLM-1', 'R4M-001')];
    const items = [item('R4M-001', 1500)];
    const claimsSnapshot = JSON.parse(JSON.stringify(claims));
    const itemsSnapshot = JSON.parse(JSON.stringify(items));

    computeEscrowFundsHeld(claims, items);

    expect(claims).toEqual(claimsSnapshot);
    expect(items).toEqual(itemsSnapshot);
  });

  it('is not simply the claim count — the old, wrong value', () => {
    // The regression this phase exists to fix: two escrowed claims worth 1500
    // total previously rendered as "2" under the label "Escrow Funds Held".
    const claims = [escrowClaim('CLM-1', 'R4M-001'), escrowClaim('CLM-2', 'R4M-002')];
    const items = [item('R4M-001', 1000), item('R4M-002', 500)];

    const result = computeEscrowFundsHeld(claims, items);

    expect(result.count).toBe(2);
    expect(result.amount).toBe(1500);
    expect(result.amount).not.toBe(result.count);
  });
});

describe('toFeeNumber — defensive conversion of a stored fee', () => {
  it('converts numbers and numeric strings', () => {
    expect(toFeeNumber(1500)).toBe(1500);
    expect(toFeeNumber('1500.50')).toBe(1500.5);
    expect(toFeeNumber(0)).toBe(0);
  });

  it('returns null for values that cannot represent money', () => {
    for (const bad of [null, undefined, '', 'abc', NaN, Infinity, -Infinity, {}]) {
      expect(toFeeNumber(bad), `expected ${JSON.stringify(bad)} to be null`).toBeNull();
    }
  });

  it('preserves zero and negatives rather than silently rewriting financial values', () => {
    // The caller decides their meaning; this helper must not coerce them.
    expect(toFeeNumber(0)).toBe(0);
    expect(toFeeNumber(-50)).toBe(-50);
  });
});

