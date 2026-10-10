import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  computeMoneyInFlight,
  computeUnresolvedPayouts,
  PAYOUT_LEDGER_TYPES,
  SETTLEMENT_PENDING_STATUS,
  RELEASING_STATUS,
  ESCROW_HELD_STATUS,
} from '../escrowFunds';

// BATCH 1 — MONEY IN FLIGHT.
//
// The admin overview's only financial figures were terminal-state figures:
// `escrowHeldAmount` counts claims in 'escrow_held' ONLY, and `totalRevenue`
// counts platform_fee rows already marked 'completed'. Money attached to a claim
// that has moved on — the dispute window running ('pending_settlement'), or a
// payout submitted whose provider outcome is not yet confirmed ('releasing') —
// appeared as nothing at all.
//
// THE PRODUCTION SHAPE THIS COVERS: a settlement was approved and its finder
// payout came back unresolved, so the claim was rolled back to
// 'pending_settlement' (rollbackSettlementToPending) while the money was still
// held. The overview showed zero, and the unresolved payout was not visible
// anywhere in the console.
//
// These are behavioural assertions against the real functions, using the row
// shapes the data layer actually produces (NUMERIC-as-string included), plus
// source pins for the wiring no unit test can reach: the dashboard payload and
// the console's rendering rule.

const item = (id: string, lockedTotalFee: unknown) => ({
  id,
  locked_total_fee: lockedTotalFee,
});

const claim = (id: string, itemId: string | null, status: string) => ({
  id,
  item_id: itemId,
  status,
});

const escrowClaim = (id: string, itemId: string) => claim(id, itemId, ESCROW_HELD_STATUS);
const settledClaim = (id: string, itemId: string) => claim(id, itemId, SETTLEMENT_PENDING_STATUS);
const inFlightClaim = (id: string, itemId: string) => claim(id, itemId, RELEASING_STATUS);

const ledgerRow = (type: string, status: string, amount: unknown, payoutOutcome: string | null) => ({
  type,
  status,
  amount,
  payout_outcome: payoutOutcome,
});

describe('computeMoneyInFlight — money the platform is still holding', () => {
  it('splits each held state into its own fact and totals exactly those states', () => {
    const claims = [
      escrowClaim('CLM-1', 'R4M-1'),
      settledClaim('CLM-2', 'R4M-2'),
      settledClaim('CLM-3', 'R4M-3'),
      inFlightClaim('CLM-4', 'R4M-4'),
    ];
    const items = [
      item('R4M-1', 1000),
      item('R4M-2', 250),
      item('R4M-3', 250),
      item('R4M-4', 75.5),
    ];

    const result = computeMoneyInFlight(claims, items);

    expect(result.escrowHeldAmount).toBe(1000);
    expect(result.escrowHeldCount).toBe(1);
    expect(result.settlementPendingAmount).toBe(500);
    expect(result.settlementPendingCount).toBe(2);
    expect(result.releasingAmount).toBe(75.5);
    expect(result.releasingCount).toBe(1);
    // The total is the sum of the three published facts — never an independent
    // figure with its own definition.
    expect(result.heldAmount).toBe(1575.5);
    expect(result.heldCount).toBe(4);
    expect(result.heldAmount).toBe(
      result.escrowHeldAmount + result.settlementPendingAmount + result.releasingAmount,
    );
  });

  it('THE REPORTED DEFECT: an approved settlement is held money even though escrow_held is empty', () => {
    // The exact state the production console was in: settlement approved, finder
    // payout unresolved, claim rolled back to 'pending_settlement'.
    const claims = [settledClaim('CLM-328944', 'R4M-001')];
    const items = [item('R4M-001', 1500)];

    const result = computeMoneyInFlight(claims, items);

    // The old card was right about its own narrow question and useless as an
    // answer to "is any money held?": escrow_held is empty, so it showed 0.
    expect(result.escrowHeldAmount).toBe(0);
    expect(result.escrowHeldCount).toBe(0);
    // The money is still held, and now it is visible.
    expect(result.settlementPendingAmount).toBe(1500);
    expect(result.heldAmount).toBe(1500);
  });

  it('excludes every state in which the platform is not holding money', () => {
    const excluded = [
      'pending_verification',
      'awaiting_agent_confirmation',
      'pending_payment',
      'payment_window_expired',
      'released',
      'refunded',
      'rejected',
      'disputed',
      'refunding',
    ];
    const claims = excluded.map((status, i) => claim(`CLM-${i}`, `R4M-${i}`, status));
    const items = excluded.map((_, i) => item(`R4M-${i}`, 5000));

    const result = computeMoneyInFlight(claims, items);

    expect(result.escrowHeldAmount).toBe(0);
    expect(result.settlementPendingAmount).toBe(0);
    expect(result.releasingAmount).toBe(0);
    expect(result.heldCount).toBe(0);
    // No held state among them, so the total must be 0 — and that 0 is a fact.
    expect(result.heldAmount).toBe(0);
  });

  it('handles the NUMERIC-as-string form and rounds to the column scale', () => {
    const claims = [escrowClaim('CLM-1', 'R4M-1'), settledClaim('CLM-2', 'R4M-2')];
    const items = [item('R4M-1', '1500.00'), item('R4M-2', '0.1')];

    const result = computeMoneyInFlight(claims, items);

    expect(result.escrowHeldAmount).toBe(1500);
    expect(result.settlementPendingAmount).toBe(0.1);
    expect(String(result.heldAmount)).toBe('1500.1');
  });

  it('a claim is counted once: one item cannot be banked into two states', () => {
    // A claim has exactly one status, so even two claims pointing at the same
    // item cannot put the same fee into two buckets.
    const claims = [escrowClaim('CLM-1', 'R4M-SAME'), settledClaim('CLM-2', 'R4M-SAME')];
    const items = [item('R4M-SAME', 400)];

    const result = computeMoneyInFlight(claims, items);

    expect(result.escrowHeldAmount).toBe(400);
    expect(result.settlementPendingAmount).toBe(400);
    expect(result.heldCount).toBe(2);
    expect(result.heldAmount).toBe(800);
  });

  it('never counts a 0, negative or non-finite locked fee as held money', () => {
    const claims = [
      escrowClaim('CLM-1', 'R4M-A'),
      escrowClaim('CLM-2', 'R4M-B'),
      escrowClaim('CLM-3', 'R4M-C'),
    ];
    const items = [item('R4M-A', 100), item('R4M-B', -50), item('R4M-C', 'NaN')];

    const result = computeMoneyInFlight(claims, items);

    expect(result.escrowHeldAmount).toBe(100);
    // The count is an independent fact: three claims ARE in escrow_held.
    expect(result.escrowHeldCount).toBe(3);
  });

  it('returns true zeroes for no rows, and survives null/undefined input', () => {
    expect(computeMoneyInFlight([], [])).toEqual({
      escrowHeldAmount: 0, escrowHeldCount: 0,
      settlementPendingAmount: 0, settlementPendingCount: 0,
      releasingAmount: 0, releasingCount: 0,
      heldAmount: 0, heldCount: 0,
    });
    expect(computeMoneyInFlight(null, null).heldAmount).toBe(0);
    expect(computeMoneyInFlight(undefined, undefined).heldCount).toBe(0);
    // A claim whose item is absent from the loaded rows still counts as a claim
    // in that state; it simply contributes no amount — exactly as
    // computeEscrowFundsHeld already behaves.
    const orphan = computeMoneyInFlight([settledClaim('CLM-1', 'MISSING')], []);
    expect(orphan.settlementPendingCount).toBe(1);
    expect(orphan.settlementPendingAmount).toBe(0);
  });

  it('does not mutate the rows it is given', () => {
    const claims = [escrowClaim('CLM-1', 'R4M-1')];
    const items = [item('R4M-1', 1500)];
    const claimsSnapshot = JSON.parse(JSON.stringify(claims));
    const itemsSnapshot = JSON.parse(JSON.stringify(items));

    computeMoneyInFlight(claims, items);

    expect(claims).toEqual(claimsSnapshot);
    expect(items).toEqual(itemsSnapshot);
  });

  it('does not redefine the Phase 10 escrow figure — it adds to it', () => {
    // The existing "Escrow Funds Held" card keeps its exact meaning; this batch
    // only makes the money that card never counted visible beside it.
    const claims = [escrowClaim('CLM-1', 'R4M-1'), settledClaim('CLM-2', 'R4M-2')];
    const items = [item('R4M-1', 800), item('R4M-2', 300)];

    const result = computeMoneyInFlight(claims, items);

    expect(result.escrowHeldAmount).toBe(800);
    expect(result.escrowHeldCount).toBe(1);
    expect(result.settlementPendingAmount).toBe(300);
  });
});

describe('computeUnresolvedPayouts — payouts awaiting provider reconciliation', () => {
  it('counts and totals a pending payout whose outcome is unknown or accepted', () => {
    const ledger = [
      ledgerRow('finder_payout', 'pending', 250, 'unknown'),
      ledgerRow('agent_payout', 'pending', 350, 'accepted'),
    ];

    const result = computeUnresolvedPayouts(ledger);

    expect(result.count).toBe(2);
    expect(result.amount).toBe(600);
  });

  it('counts a legacy row with no recorded submission history (fails closed)', () => {
    // payout_outcome NULL means "we cannot prove this was never submitted", so
    // it is unresolved — never treated as "safe to send".
    const result = computeUnresolvedPayouts([ledgerRow('finder_payout', 'pending', 100, null)]);
    expect(result.count).toBe(1);
    expect(result.amount).toBe(100);
  });

  it('counts a refused (rejected) payout as unresolved work, not as paid', () => {
    const result = computeUnresolvedPayouts([ledgerRow('finder_payout', 'failed', 100, 'rejected')]);
    expect(result.count).toBe(1);
  });

  it('does NOT count a payable row that is still safely submittable', () => {
    // 'pending' + 'not_submitted' is the normal pre-submission state: it is not
    // an unresolved provider problem, it is simply work the executor will pick up.
    const result = computeUnresolvedPayouts([
      ledgerRow('finder_payout', 'pending', 250, 'not_submitted'),
      ledgerRow('agent_payout', 'pending', 350, 'not_submitted'),
    ]);
    expect(result.count).toBe(0);
    expect(result.amount).toBe(0);
  });

  it('does NOT count a completed payout, nor any non-payout ledger row', () => {
    const result = computeUnresolvedPayouts([
      ledgerRow('finder_payout', 'completed', 250, 'completed'),
      ledgerRow('agent_payout', 'completed', 350, 'completed'),
      // A platform fee and a receipt are never "unresolved payouts", whatever
      // their status — they are not transfers out to a person.
      ledgerRow('platform_fee', 'pending', 400, null),
      ledgerRow('payment_received', 'pending', 1000, null),
      ledgerRow('refund', 'pending', 1000, null),
    ]);
    expect(result.count).toBe(0);
    expect(result.amount).toBe(0);
  });

  it('covers exactly the rows getUnresolvedPayouts() would return', () => {
    // getUnresolvedPayouts() (db/database.ts) selects the payout types and then
    // applies the SAME rule in application code. Re-applying that composition
    // here proves the overview figure and the reconciliation list agree.
    const ledger = [
      ledgerRow('finder_payout', 'pending', 250, 'unknown'),
      ledgerRow('finder_payout', 'pending', 250, 'not_submitted'),
      ledgerRow('agent_payout', 'pending', 350, 'submitting'),
      ledgerRow('agent_payout', 'completed', 350, 'completed'),
      ledgerRow('platform_fee', 'pending', 400, null),
      ledgerRow('finder_payout', 'failed', 250, 'rejected'),
    ];

    const fromComposition = ledger
      .filter((row) => PAYOUT_LEDGER_TYPES.includes(row.type))
      .filter((row) => row.status !== 'completed')
      .filter((row) => !(row.status === 'pending' && row.payout_outcome === 'not_submitted'));

    const result = computeUnresolvedPayouts(ledger);

    expect(result.count).toBe(fromComposition.length);
    expect(result.amount).toBe(250 + 350 + 250);
  });

  it('returns true zeroes for no rows and survives null input', () => {
    expect(computeUnresolvedPayouts([])).toEqual({ count: 0, amount: 0 });
    expect(computeUnresolvedPayouts(null)).toEqual({ count: 0, amount: 0 });
    expect(computeUnresolvedPayouts(undefined)).toEqual({ count: 0, amount: 0 });
    // An unreadable amount still counts as an unresolved row: the operator needs
    // to see that the row exists, and the amount must not be invented.
    expect(computeUnresolvedPayouts([ledgerRow('finder_payout', 'pending', 'abc', 'unknown')]))
      .toEqual({ count: 1, amount: 0 });
  });

  it('rounds its total to the column scale', () => {
    const result = computeUnresolvedPayouts([
      ledgerRow('finder_payout', 'pending', '0.1', 'unknown'),
      ledgerRow('agent_payout', 'pending', '0.2', 'unknown'),
    ]);
    expect(String(result.amount)).toBe('0.3');
  });
});

// ---------------------------------------------------------------------------
// WIRING — the two points a unit test cannot reach: the dashboard payload and
// the console's rendering rule. (The same source-pin approach the admin route
// audits already use, e.g. db/__tests__/socialRetryReconciliation.test.ts.)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SERVER_TS = fs.readFileSync(path.join(REPO_ROOT, 'src/server.ts'), 'utf8');
const ADMIN_VIEW_TSX = fs.readFileSync(path.join(REPO_ROOT, 'src/components/AdminView.tsx'), 'utf8');
const DATABASE_TS = fs.readFileSync(path.join(REPO_ROOT, 'src/db/database.ts'), 'utf8');

const DASHBOARD = (() => {
  const start = SERVER_TS.indexOf("app.get('/api/admin/dashboard'");
  const end = SERVER_TS.indexOf("app.post('/api/admin/agents/:id/approve'");
  expect(start, 'the dashboard route must still exist').toBeGreaterThan(-1);
  expect(end, 'the dashboard handler end anchor must still exist').toBeGreaterThan(start);
  return SERVER_TS.slice(start, end);
})();

const STATS_BLOCK = (() => {
  const start = SERVER_TS.indexOf('const stats = {');
  expect(start, 'the dashboard stats block must still exist').toBeGreaterThan(-1);
  return SERVER_TS.slice(start, SERVER_TS.indexOf('};', start));
})();

describe('the dashboard payload publishes the in-flight facts', () => {
  it('computes both aggregates inside the dashboard handler, from rows already loaded', () => {
    expect(DASHBOARD).toContain('const moneyInFlight = computeMoneyInFlight(claims, items)');
    expect(DASHBOARD).toContain('const unresolvedPayouts = computeUnresolvedPayouts(ledger)');
  });

  it('publishes each held state and the unresolved-payout figure as its own stat', () => {
    expect(STATS_BLOCK).toContain('settlementPendingAmount: moneyInFlight.settlementPendingAmount');
    expect(STATS_BLOCK).toContain('settlementPendingCount: moneyInFlight.settlementPendingCount');
    expect(STATS_BLOCK).toContain('releasingAmount: moneyInFlight.releasingAmount');
    expect(STATS_BLOCK).toContain('releasingCount: moneyInFlight.releasingCount');
    expect(STATS_BLOCK).toContain('fundsInFlightAmount: moneyInFlight.heldAmount');
    expect(STATS_BLOCK).toContain('fundsInFlightCount: moneyInFlight.heldCount');
    expect(STATS_BLOCK).toContain('unresolvedPayoutsCount: unresolvedPayouts.count');
    expect(STATS_BLOCK).toContain('unresolvedPayoutsAmount: unresolvedPayouts.amount');
  });

  it('leaves the Phase 10 escrow statistic exactly as it was', () => {
    // This batch ADDS facts; it must never redefine the two the console already
    // published (adminEscrowMetric.test.ts owns their contract).
    expect(STATS_BLOCK).toContain('escrowHeldAmount: escrowFundsHeld.amount');
    expect(STATS_BLOCK).toContain('escrowHeldCount: escrowFundsHeld.count');
  });
});

describe('the console renders in-flight money honestly', () => {
  it('uses the em-dash helpers, so a missing figure is never rendered as 0', () => {
    // BATCH 3 — the two helpers keep their names and are still what every
    // money-in-flight card calls, but their bodies now DELEGATE to the single
    // Overview read-out module rather than re-implementing the em-dash rule
    // inline (three different money formats lived on one screen). The rule is
    // unchanged and is pinned BEHAVIOURALLY in
    // components/admin/dashboard/__tests__/adminOverviewMetrics.test.ts.
    expect(ADMIN_VIEW_TSX).toContain('function inFlightAmountLabel(');
    expect(ADMIN_VIEW_TSX).toContain('function inFlightCountLabel(');
    expect(ADMIN_VIEW_TSX).toContain('return formatKesAmount(value).text;');
    expect(ADMIN_VIEW_TSX).toContain('return formatMetricCount(value).text;');
  });

  it('never defaults an in-flight figure to zero', () => {
    const fields = [
      'fundsInFlightAmount', 'fundsInFlightCount',
      'settlementPendingAmount', 'settlementPendingCount',
      'releasingAmount', 'releasingCount',
      'unresolvedPayoutsCount', 'unresolvedPayoutsAmount',
    ];
    for (const field of fields) {
      expect(ADMIN_VIEW_TSX).not.toContain(`stats?.${field} || 0`);
      expect(ADMIN_VIEW_TSX).not.toContain(`stats?.${field} ?? 0`);
      expect(ADMIN_VIEW_TSX).not.toContain(`stats.${field} || 0`);
    }
  });

  it('labels each state separately instead of publishing one merged figure', () => {
    expect(ADMIN_VIEW_TSX).toContain("'Funds Held (not yet paid out)'");
    expect(ADMIN_VIEW_TSX).toContain("'Awaiting Payout'");
    expect(ADMIN_VIEW_TSX).toContain("'Payout In Flight'");
    expect(ADMIN_VIEW_TSX).toContain("'Unresolved Payouts'");
    // No card claims to be a spendable balance: nothing in this codebase models
    // a float, clearing account or provider balance, so no such label may exist.
    expect(ADMIN_VIEW_TSX).not.toContain("'Available Funds'");
    expect(ADMIN_VIEW_TSX).not.toContain("'Available Balance'");
  });

  it('flags an unresolved payout for a provider check', () => {
    expect(ADMIN_VIEW_TSX).toContain('Needs provider check');
  });
});

describe('the unresolved-payout definition cannot drift from the reconciliation endpoint', () => {
  it('getUnresolvedPayouts() selects exactly the ledger types this module aggregates', () => {
    const start = DATABASE_TS.indexOf('public async getUnresolvedPayouts(');
    expect(start, 'getUnresolvedPayouts() must still exist').toBeGreaterThan(-1);
    const body = DATABASE_TS.slice(start, start + 900);
    for (const type of PAYOUT_LEDGER_TYPES) {
      expect(body).toContain(`"${type}"`);
    }
    // ...and applies the SAME rule this module applies.
    expect(body).toContain('isUnresolvedPayoutRow');
  });
});



