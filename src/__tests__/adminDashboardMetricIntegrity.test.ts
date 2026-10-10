import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  ESCROW_HELD_STATUS,
  PAYOUT_LEDGER_TYPES,
  RELEASING_STATUS,
  SETTLEMENT_PENDING_STATUS,
  computeEscrowFundsHeld,
  computeMoneyInFlight,
  computeUnresolvedPayouts,
} from '../services/escrowFunds';
import {
  OVERVIEW_OPTIONAL_STATS_FIELDS,
  OVERVIEW_REQUIRED_STATS_FIELDS,
} from '../components/admin/dashboard/adminOverviewMetrics';

// =============================================================================
// BATCH 3 — DASHBOARD DATA INTEGRITY AND METRIC PRESENTATION
// =============================================================================
// Two kinds of assertion, deliberately:
//
//   * BEHAVIOURAL — the financial lifecycle rules the Overview's figures are
//     defined by are executed against the real aggregates, using the row shapes
//     the data layer produces. A claim in 'pending_settlement' is NOT treated as
//     escrow-held; each held claim's money appears in exactly one bucket;
//     a payout that was NOT confirmed complete and is NOT safe to resend is
//     unresolved; an all-zero platform yields genuine zeros.
//
//   * WIRING — the console and the dashboard handler are pinned by source. This
//     repository has no DOM/component harness (vitest runs `environment: 'node'`
//     and includes only `src/**/*.test.ts`) and server.ts boots the whole
//     application on import, so handler behaviour cannot be mounted here. This is
//     the same documented technique adminEscrowMetric.test.ts and the route-audit
//     tests use. The pins are on the PROPERTIES that matter (validate before
//     render, one data write, no zero-defaulting, stale instead of blank), not on
//     incidental formatting.

const repoRoot = path.resolve(__dirname, '..', '..');
const adminViewTs = fs.readFileSync(path.resolve(repoRoot, 'src/components/AdminView.tsx'), 'utf8');
const serverTs = fs.readFileSync(path.resolve(repoRoot, 'src/server.ts'), 'utf8');

const claim = (id: string, itemId: string | null, status: string) => ({ id, item_id: itemId, status });
const item = (id: string, lockedTotalFee: unknown) => ({ id, locked_total_fee: lockedTotalFee });
const ledgerRow = (type: string, status: string, payoutOutcome: string | null, amount: unknown) => ({
  type,
  status,
  payout_outcome: payoutOutcome,
  amount,
});

describe('financial lifecycle definitions behind the Overview figures', () => {
  it('does NOT treat a claim in pending_settlement as still escrow-held', () => {
    // This is the assumption the audit was told not to make. The money is real
    // and the platform is still holding it — but it is NOT escrow_held, so the
    // escrow card must read zero for it while the in-flight card reads its fee.
    const claims = [claim('CLM-1', 'R4M-1', SETTLEMENT_PENDING_STATUS)];
    const items = [item('R4M-1', 500)];

    expect(computeEscrowFundsHeld(claims, items)).toEqual({ amount: 0, count: 0 });

    const inFlight = computeMoneyInFlight(claims, items);
    expect(inFlight.escrowHeldAmount).toBe(0);
    expect(inFlight.escrowHeldCount).toBe(0);
    expect(inFlight.settlementPendingAmount).toBe(500);
    expect(inFlight.settlementPendingCount).toBe(1);
    expect(inFlight.heldAmount).toBe(500);
    expect(inFlight.heldCount).toBe(1);
  });

  it('counts a claim in exactly one held bucket, and no money in a closed state', () => {
    const claims = [
      claim('CLM-1', 'R4M-1', ESCROW_HELD_STATUS),
      claim('CLM-2', 'R4M-2', SETTLEMENT_PENDING_STATUS),
      claim('CLM-3', 'R4M-3', RELEASING_STATUS),
      // Money that has provably left the platform's hands is not "in flight":
      claim('CLM-4', 'R4M-4', 'released'),
      claim('CLM-5', 'R4M-5', 'refunded'),
      // ...and a claim still under a dispute is not counted as held either.
      claim('CLM-6', 'R4M-6', 'disputed'),
      // Not yet paid for at all — no one's money is being held.
      claim('CLM-7', 'R4M-7', 'pending_payment'),
    ];
    const items = [
      item('R4M-1', 100), item('R4M-2', 200), item('R4M-3', 300),
      item('R4M-4', 400), item('R4M-5', 500), item('R4M-6', 600), item('R4M-7', 700),
    ];

    const inFlight = computeMoneyInFlight(claims, items);
    expect(inFlight.escrowHeldCount + inFlight.settlementPendingCount + inFlight.releasingCount).toBe(3);
    expect(inFlight.heldAmount).toBe(inFlight.escrowHeldAmount + inFlight.settlementPendingAmount + inFlight.releasingAmount);
    expect(inFlight.heldAmount).toBe(600);
    expect(inFlight.heldCount).toBe(3);
  });

  it('reports a genuine zero when the platform holds nothing (an all-zero reading is valid)', () => {
    expect(computeEscrowFundsHeld([], [])).toEqual({ amount: 0, count: 0 });
    expect(computeMoneyInFlight([], [])).toMatchObject({ heldAmount: 0, heldCount: 0, escrowHeldAmount: 0 });
    expect(computeUnresolvedPayouts([])).toEqual({ count: 0, amount: 0 });
  });

  it('counts only payouts that are neither confirmed paid nor safe to resend as unresolved', () => {
    const ledger = [
      // Confirmed paid — settled, not under investigation.
      ledgerRow('finder_payout', 'completed', 'completed', 100),
      // Booked and never submitted: eligible for the normal payout sweep, so not
      // "unresolved".
      ledgerRow('agent_payout', 'pending', 'not_submitted', 50),
      // Provider ACCEPTED it: acceptance is not completion -> unresolved.
      ledgerRow('finder_payout', 'pending', 'accepted', 75),
      // Legacy row with no submission history at all: fail closed -> unresolved.
      ledgerRow('agent_payout', 'pending', null, 25),
      // Provider refused it: needs a human decision -> unresolved.
      ledgerRow('agent_payout', 'failed', 'rejected', 5),
      // A durable pre-submission marker with no result -> unresolved.
      ledgerRow('agent_payout', 'pending', 'submitting', 15),
      // Not a payout row at all: ignored by the payout definition.
      ledgerRow('platform_fee', 'pending', null, 10),
    ];

    const result = computeUnresolvedPayouts(ledger);
    expect(result.count).toBe(4);
    expect(result.amount).toBe(120); // 75 + 25 + 5 + 15
    // Every ledger type the figure is built from is the same set the
    // reconciliation endpoint lists rows by.
    expect([...PAYOUT_LEDGER_TYPES].sort()).toEqual(['agent_payout', 'finder_payout']);
  });
});

describe('the Overview validates a dashboard payload before it renders it', () => {
  it('validates the payload and rejects an incomplete one instead of rendering it', () => {
    const validateAt = adminViewTs.indexOf('readOverviewStats(data)');
    const writeAt = adminViewTs.indexOf('setDashboardData(data)');
    expect(validateAt, 'the Overview must validate the payload').toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(validateAt);
    expect(adminViewTs).toContain('throw new Error(readout.reason');
  });

  it('writes dashboard data from exactly ONE place — there is no second, unvalidated path', () => {
    expect(adminViewTs.match(/setDashboardData\(/g)?.length).toBe(1);
  });

  it('never defaults an Overview figure to zero', () => {
    for (const field of [...OVERVIEW_REQUIRED_STATS_FIELDS, ...OVERVIEW_OPTIONAL_STATS_FIELDS]) {
      expect(adminViewTs).not.toContain(`stats.${field} || 0`);
      expect(adminViewTs).not.toContain(`stats?.${field} || 0`);
      expect(adminViewTs).not.toContain(`stats.${field} ?? 0`);
      expect(adminViewTs).not.toContain(`stats?.${field} ?? 0`);
    }
  });

  it('no longer renders a raw, unguarded statistic into a money card', () => {
    // The old markup `KES {dashboardData.stats.escrowHeldAmount}` renders the
    // literal text "KES undefined" when the field is absent — a figure-shaped
    // claim the server never made.
    expect(adminViewTs).not.toContain('KES {dashboardData.stats.');
  });

  it('never interpolates a money figure raw — not into JSX text, and not into a template literal', () => {
    // M2 (Batch 3 corrective micro-fix) — the guard above matches the JSX form
    // `KES {stats.x}` ONLY. The form it could not see is the TEMPLATE LITERAL,
    // `KES ${stats.x}`, which is exactly how the unresolved-payout description
    // bypassed the read-out module: an absent optional amount printed the text
    // "KES undefined", and a reported amount printed without the two decimals
    // (NUMERIC(10,2)) every other Overview money figure uses.
    //
    // Counts are deliberately excluded — `Across ${stats.fundsInFlightCount}
    // claim(s)` is a legitimate, non-monetary interpolation — and the exclusion
    // uses the SAME rule the validator itself uses to tell a count from an amount
    // (readOverviewStats: field.endsWith('Count')), so it cannot drift from it.
    const moneyFields = [...OVERVIEW_REQUIRED_STATS_FIELDS, ...OVERVIEW_OPTIONAL_STATS_FIELDS]
      .filter((field) => !field.endsWith('Count'));
    // Non-vacuity: the two amounts whose raw form would be worst — confirmed
    // revenue and the unresolved-payout figure — must be inside the rule.
    expect(moneyFields).toContain('totalRevenue');
    expect(moneyFields).toContain('unresolvedPayoutsAmount');

    for (const field of moneyFields) {
      for (const raw of [
        `KES {dashboardData.stats.${field}}`,
        `KES {dashboardData.stats?.${field}}`,
        `\${dashboardData.stats.${field}}`,
        `\${dashboardData.stats?.${field}}`,
      ]) {
        expect(adminViewTs, `${field} must go through the read-out module, never be interpolated raw`).not.toContain(raw);
      }
    }
  });

  it('renders the unresolved-payout DESCRIPTION through the same formatter as every other money figure', () => {
    // M1 lived here. The original line was
    //   ? (`KES ${dashboardData.stats.unresolvedPayoutsAmount} is neither confirmed paid nor safe to resend automatically. …`)
    // — the ONE Overview money figure that never reached the read-out module.
    // The region is this card's own text, not the whole 3,000-line file, so the
    // assertion cannot be satisfied by an unrelated change somewhere else.
    const cardAt = adminViewTs.indexOf("label={'Unresolved Payouts'}");
    expect(cardAt, 'the Unresolved Payouts card must exist').toBeGreaterThan(-1);
    const cardEnd = adminViewTs.indexOf('treat as unknown, not as zero.', cardAt);
    expect(cardEnd, 'the Unresolved Payouts card must close where expected').toBeGreaterThan(cardAt);
    const card = adminViewTs.slice(cardAt, cardEnd);

    // The amount now goes through the shared, validated read-out module…
    expect(card).toContain('formatKesAmount(dashboardData.stats?.unresolvedPayoutsAmount).text');
    // …so the raw template-literal interpolation — the M1 defect — is gone.
    expect(card).not.toContain('${dashboardData.stats.unresolvedPayoutsAmount}');
    expect(card).not.toContain('${dashboardData.stats?.unresolvedPayoutsAmount}');
    // The count condition and the operator-facing wording are unchanged.
    expect(card).toContain('dashboardData.stats.unresolvedPayoutsCount > 0');
    expect(card).toContain('is neither confirmed paid nor safe to resend automatically.');
  });

  it('renders every required Overview figure through the one read-out module', () => {
    expect(adminViewTs).toContain('formatKesAmount(dashboardData.stats.escrowHeldAmount).text');
    expect(adminViewTs).toContain('formatMetricCount(dashboardData.stats.escrowHeldCount).text');
    expect(adminViewTs).toContain('formatKesAmount(dashboardData.stats.totalRevenue).text');
    expect(adminViewTs).toContain('formatMetricCount(dashboardData.stats.itemsAtAgentCount).text');
    expect(adminViewTs).toContain('formatMetricCount(dashboardData.stats.pendingAgentsCount).text');
  });

  it('still issues the dashboard request as a plain GET', () => {
    const callAt = adminViewTs.indexOf("fetch('/api/admin/dashboard'");
    expect(callAt).toBeGreaterThan(-1);
    // No method, no body: the endpoint contract is unchanged.
    expect(adminViewTs.slice(callAt, callAt + 200)).not.toContain('method:');
  });
});

describe('stale, loading, retry and ordering behaviour', () => {
  it('keeps the last good figures and marks them stale when a refresh fails', () => {
    expect(adminViewTs).toContain('setDashboardStale(dashboardHasDataRef.current)');
    expect(adminViewTs).toContain('setDashboardStale(false)');
    // A failed refresh must never blank the reading: there is no second write.
    expect(adminViewTs).not.toContain('setDashboardData(null)');
    expect(adminViewTs).toContain("' — the latest refresh failed, so this is an older reading'");
    expect(adminViewTs).toContain("'Retry refresh'");
    expect(adminViewTs).toContain('{dashboardStale && dashboardData && (');
  });

  it('lets only the newest request apply its result', () => {
    expect(adminViewTs).toContain('dashboardRequestSeqRef.current += 1');
    const guards = adminViewTs.match(/requestSeq !== dashboardRequestSeqRef\.current/g) ?? [];
    // One in the success path, one in the failure path: a superseded request can
    // neither overwrite a newer reading nor report its own failure over it.
    expect(guards.length).toBe(2);
  });

  it('coalesces a refresh that arrives while one is already running', () => {
    expect(adminViewTs)
      .toContain('if (dashboardFetchInFlightRef.current) dashboardRefreshQueuedRef.current = true;');
    expect(adminViewTs).toContain('void fetchDashboardData();');
  });

  it('keeps distinct loading, error and empty states, each with a retry', () => {
    expect(adminViewTs).toContain('dashboardLoading && !dashboardData');
    expect(adminViewTs).toContain('!dashboardData && dataError');
    expect(adminViewTs).toContain('!dashboardLoading && !dashboardData && !dataError');
    expect(adminViewTs).toContain('Retry Connection');
    expect(adminViewTs).toContain('Retry Fetching');
    // The failure state names the failure instead of showing a blank console.
    expect(adminViewTs).toContain('Failed to Load Dashboard');
  });

  it('announces refresh state to assistive tech without hiding the figures', () => {
    expect(adminViewTs).toContain('aria-busy="true"');
    expect(adminViewTs).toContain('aria-live="polite"');
    // The background-refresh indicator is only rendered when figures exist.
    expect(adminViewTs).toContain('{dashboardLoading && dashboardData && (');
  });

  it('adds no polling for the dashboard', () => {
    expect(adminViewTs).not.toMatch(/setInterval\([^)]*fetchDashboardData/);
  });

  it('keeps the Batch 2 reconciliation panel read-only and reachable', () => {
    expect(adminViewTs).toContain('{payoutReconciliationOpen && (');
    expect(adminViewTs).toContain('<PayoutReconciliationPanel token={token} />');
  });
});

describe('the dashboard handler publishes the audited definitions', () => {
  const statsBlock = (() => {
    const start = serverTs.indexOf('const stats = {');
    expect(start, 'the dashboard must still assemble a stats block').toBeGreaterThan(-1);
    return serverTs.slice(start, serverTs.indexOf('};', start));
  })();

  it('publishes the required Overview figures from the audited aggregates', () => {
    expect(statsBlock).toContain("pendingAgentsCount: agents.filter(a => a.status === 'pending').length");
    expect(statsBlock).toContain("itemsAtAgentCount: items.filter(i => i.status === 'at_agent').length");
    expect(statsBlock).toContain('escrowHeldAmount: escrowFundsHeld.amount');
    expect(statsBlock).toContain('escrowHeldCount: escrowFundsHeld.count');
  });

  it('counts only COMPLETED platform fees as revenue, never in-flight money', () => {
    expect(statsBlock).toContain("totalRevenue: ledger.filter(l => l.type === 'platform_fee' && l.status === 'completed')");
    // The in-flight and unresolved figures are separate, separately labelled
    // facts on the same payload: nothing sums them into revenue, and no figure
    // claims to be a spendable balance.
    expect(statsBlock).toContain('fundsInFlightAmount: moneyInFlight.heldAmount');
    expect(statsBlock).toContain('settlementPendingAmount: moneyInFlight.settlementPendingAmount');
    expect(statsBlock).toContain('releasingAmount: moneyInFlight.releasingAmount');
    expect(statsBlock).toContain('unresolvedPayoutsCount: unresolvedPayouts.count');
    expect(statsBlock).not.toContain('availableFunds');
    expect(statsBlock).not.toContain('availableBalance');
  });
});
