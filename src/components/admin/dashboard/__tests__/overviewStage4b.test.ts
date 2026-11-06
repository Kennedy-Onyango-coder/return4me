import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// STAGE 4B — THE OVERVIEW'S WIRING, PINNED
// =============================================================================
// Static source assertions, and the same documented limitation every other
// console-boundary test in this repository states: vitest runs with
// `environment: 'node'` and includes only `src/**/*.test.ts`, so there is no DOM
// harness here and server.ts boots the whole application on import. The
// properties below are the ones a later refactor could quietly undo:
//
//   * the four zone components are mounted, and they are the ONLY Overview
//     rendering (no fifth card implementation creeps back);
//   * the disputes figure comes from the server's `stats.disputesOpenCount` and
//     opens `disputes`;
//   * the three unreachable/duplicate dynamic cards stay retired;
//   * no React key is built from a live count or an array index;
//   * the zones receive data and callbacks through props and never fetch, write
//     or hold state of their own;
//   * AdminView still owns the request, the coalescing, the sequence guard, the
//     stale flag and the retry.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.resolve(repoRoot, relative), 'utf8');

/** Comments describe intent; these assertions are about code. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const ADMIN_VIEW_PATH = 'src/components/AdminView.tsx';
const ZONE_PATHS = [
  'src/components/admin/dashboard/OverviewStatusStrip.tsx',
  'src/components/admin/dashboard/OverviewAttentionZone.tsx',
  'src/components/admin/dashboard/OverviewMoneyZone.tsx',
  'src/components/admin/dashboard/OverviewActivityZone.tsx',
];

const ADMIN_VIEW = read(ADMIN_VIEW_PATH);
const ADMIN_VIEW_CODE = stripComments(ADMIN_VIEW);
const ZONES = ZONE_PATHS.map((relative) => ({ relative, source: read(relative), code: stripComments(read(relative)) }));
const ATTENTION = ZONES[1];
const MONEY = ZONES[2];
const ACTIVITY = ZONES[3];
const STATUS = ZONES[0];

/** The whole Overview surface, as one string: AdminView plus the four zones. */
const OVERVIEW_CODE = [ADMIN_VIEW, ...ZONES.map((zone) => zone.source)].join('\n');
const OVERVIEW_ONLY_CODE = [ADMIN_VIEW_CODE, ...ZONES.map((zone) => zone.code)].join('\n');

describe('Stage 4B — the Overview is four contained zones', () => {
  it('mounts every zone component exactly once, from AdminView', () => {
    for (const component of [
      'OverviewStatusStrip',
      'OverviewAttentionZone',
      'OverviewMoneyZone',
      'OverviewActivityZone',
    ]) {
      const mounts = ADMIN_VIEW_CODE.split(`<${component}`).length - 1;
      expect(mounts, `${component} must be mounted once by the Overview`).toBe(1);
      expect(ADMIN_VIEW_CODE).toContain(`import ${component} from './admin/dashboard/${component}';`);
    }
  });

  it('leaves AdminView owning the fetch, the coalescing, the sequence guard and the retry', () => {
    expect(ADMIN_VIEW_CODE).toContain("fetch('/api/admin/dashboard'");
    expect(ADMIN_VIEW_CODE).toContain('dashboardRequestSeqRef.current += 1');
    const guards = ADMIN_VIEW_CODE.match(/requestSeq !== dashboardRequestSeqRef\.current/g) ?? [];
    expect(guards.length).toBe(2);
    expect(ADMIN_VIEW_CODE).toContain(
      'if (dashboardFetchInFlightRef.current) dashboardRefreshQueuedRef.current = true;',
    );
    expect(ADMIN_VIEW_CODE).toContain('setDashboardStale(dashboardHasDataRef.current)');
    expect(ADMIN_VIEW_CODE).toContain('setDashboardStale(false)');
    expect(ADMIN_VIEW_CODE).not.toContain('setDashboardData(null)');
    expect(ADMIN_VIEW_CODE).toContain("'Retry refresh'");
    expect(ADMIN_VIEW_CODE).toContain('{dashboardStale && dashboardData && (');
  });

  it('passes the reading state and the router into the zones instead of reading them there', () => {
    expect(ADMIN_VIEW_CODE).toContain('dashboardLoadedAt={dashboardLoadedAt}');
    expect(ADMIN_VIEW_CODE).toContain('dashboardStale={dashboardStale}');
    expect(ADMIN_VIEW_CODE).toContain('dashboardLoading={dashboardLoading}');
    expect(ADMIN_VIEW_CODE).toContain('onOpenSection={setActiveTab}');
    expect(ADMIN_VIEW_CODE).toContain('onOpenLedger={() => setActiveTab(\'ledger\')}');
    // The stale sentence is rendered by the status strip, from the flag it is given.
    expect(STATUS.code).toContain("' — the latest refresh failed, so this is an older reading'");
    expect(STATUS.code).toContain('{dashboardLoading && dashboardData && (');
  });

  it('gives every zone data and callbacks through props and nothing else', () => {
    for (const zone of ZONES) {
      expect(zone.code, `${zone.relative} must not fetch`).not.toContain('fetch(');
      expect(zone.code, `${zone.relative} must not call an endpoint`).not.toContain('/api/');
      expect(zone.code, `${zone.relative} must not hold state`).not.toContain('useState');
      expect(zone.code, `${zone.relative} must not run effects`).not.toContain('useEffect');
      expect(zone.code, `${zone.relative} must export a props interface`).toMatch(/export interface Overview\w+Props \{/);
      expect(zone.code, `${zone.relative} must take the payload as a prop`).toContain('dashboardData: any;');
    }
    // ...and the money zone takes the ONE money formatter rather than re-deriving it.
    expect(MONEY.code).toContain('amountLabel: (value: unknown) => string;');
  });
});

describe('Stage 4B — the three unreachable/duplicate cards stay retired', () => {
  it('has no dynamic overviewCards array and no card label for the retired queues', () => {
    expect(ADMIN_VIEW_CODE).not.toContain('overviewCards');
    // A1 — the duplicate of the settlement card.
    expect(OVERVIEW_ONLY_CODE).not.toContain("label={'Pending Settlements'}");
    // A3 — unreachable: the dashboard publishes no `paymentStrikes` key.
    expect(OVERVIEW_ONLY_CODE).not.toContain("label={'Payment Strikes'}");
    expect(ADMIN_VIEW_CODE).not.toContain('dashboardData.paymentStrikes');
    // A4 — unreachable: the admin agent view exposes no `payoutStatus`.
    expect(OVERVIEW_ONLY_CODE).not.toContain('payoutStatus');
    expect(ADMIN_VIEW_CODE).not.toContain('a.payoutStatus');
  });

  it('still shows the unresolved-payout figure exactly once, from the server statistic', () => {
    const occurrences = OVERVIEW_ONLY_CODE.split("label={'Unresolved Payouts'}").length - 1;
    expect(occurrences, 'one card, one source').toBe(1);
    expect(ATTENTION.code).toContain('formatMetricCount(dashboardData.stats?.unresolvedPayoutsCount).text');
    expect(ATTENTION.code).toContain('formatKesAmount(dashboardData.stats?.unresolvedPayoutsAmount).text');
  });
});

describe('Stage 4B — the disputes card reads the right figure and opens the right section', () => {
  it('uses the server statistic, never the length of the disputes array', () => {
    expect(ATTENTION.code).toContain("label={'Open disputes'}");
    expect(ATTENTION.code).toContain('count={formatMetricCount(dashboardData.stats.disputesOpenCount).text}');
    // The old card counted EVERY dispute, resolved ones included. That form is
    // gone from the attention zone (the Disputes section keeps its own list).
    expect(ATTENTION.code).not.toContain('dashboardData.disputes.length');
  });

  it('navigates to the disputes section, not to review', () => {
    const card = ATTENTION.code.slice(ATTENTION.code.indexOf("label={'Open disputes'}"));
    const disputesCard = card.slice(0, card.indexOf('/>'));
    expect(disputesCard).toContain("onOpen={() => onOpenSection('disputes')}");
    expect(disputesCard).not.toContain("onOpenSection('review')");
    expect(disputesCard).toContain("actionLabel={'Review disputes'}");
  });

  it('opens only sections the console really has', () => {
    for (const section of ['agents', 'review', 'disputes', 'ledger', 'payouts']) {
      expect(ATTENTION.code).toContain(`onOpenSection('${section}')`);
    }
    expect(ATTENTION.code).toContain(
      "export type OverviewAttentionSection = 'agents' | 'review' | 'disputes' | 'ledger' | 'payouts';",
    );
  });
});

describe('Stage 4B — React keys are stable identities, not counts or indices', () => {
  it('has no count-interpolated or index key anywhere on the Overview', () => {
    for (const source of [ADMIN_VIEW_CODE, ...ZONES.map((zone) => zone.code)]) {
      expect(source).not.toMatch(/key=\{`/); // template-literal keys
      expect(source).not.toMatch(/key=\{(index|i|idx)\}/); // array-index keys
      expect(source).not.toMatch(/key=\{Math\.random/); // generated keys
    }
    // The count-keyed dynamic cards were the only offenders (A1–A4, retired).
    expect(ADMIN_VIEW_CODE).not.toContain('pending-settlements-');
    expect(ADMIN_VIEW_CODE).not.toContain('open-disputes-');
    expect(ADMIN_VIEW_CODE).not.toContain('payment-strikes-');
    expect(ADMIN_VIEW_CODE).not.toContain('unresolved-payouts-');
  });

  it('keys the activity rows by their own ledger id', () => {
    expect(ACTIVITY.code).toContain('key={entry.id}');
  });
});

describe('Stage 4B — the settlement queue shows the classification, not the array length', () => {
  it('headlines the actionable figure and states the breakdown', () => {
    expect(ATTENTION.code).toContain("label={'Settlements awaiting action'}");
    expect(ATTENTION.code).toContain('settlementQueue.counts.ready_now');
    expect(ATTENTION.code).toContain('description={settlementQueueBreakdownText(settlementQueue)}');
    expect(ATTENTION.code).toContain(
      'const settlementQueue = classifySettlementQueue(dashboardData.pendingSettlements);',
    );
    // F-04 — the figure it used to show.
    expect(ATTENTION.code).not.toContain('pendingSettlements.length');
    // ...and it still opens the ledger, where the server re-checks everything.
    expect(ATTENTION.code).toContain("onOpen={() => onOpenSection('ledger')}");
  });

  it('never shows a zero for a queue the payload did not report', () => {
    expect(ATTENTION.code).toContain('settlementQueue.reported ? settlementQueue.counts.ready_now : undefined');
  });
});

describe('Stage 4B — the escrow money/count distinction is untouched', () => {
  it('keeps the amount card monetary and the count card a count', () => {
    const amountAt = MONEY.code.indexOf('>Escrow Funds Held</span>');
    expect(amountAt, 'the Escrow Funds Held card must exist').toBeGreaterThan(-1);
    const amountWindow = MONEY.code.slice(amountAt, amountAt + 400);
    expect(amountWindow).toContain('formatKesAmount(dashboardData.stats.escrowHeldAmount)');
    expect(amountWindow).not.toContain('dashboardData.stats.escrowHeldCount');

    const countAt = MONEY.code.indexOf('>Claims in Escrow</span>');
    expect(countAt, 'the Claims in Escrow card must exist').toBeGreaterThan(-1);
    const countWindow = MONEY.code.slice(countAt, countAt + 400);
    expect(countWindow).toContain('dashboardData.stats.escrowHeldCount');
    expect(countWindow).not.toContain('formatKesAmount(dashboardData.stats.escrowHeldCount)');
  });

  it('keeps the two escrow cards adjacent, and out of AdminView', () => {
    const amountAt = MONEY.code.indexOf('formatKesAmount(dashboardData.stats.escrowHeldAmount)');
    const countAt = MONEY.code.indexOf('formatMetricCount(dashboardData.stats.escrowHeldCount)');
    expect(amountAt).toBeGreaterThan(-1);
    expect(countAt).toBeGreaterThan(amountAt);
    expect(countAt - amountAt).toBeLessThan(600);
    expect(ADMIN_VIEW_CODE).not.toContain('>Escrow Funds Held</span>');
  });
});
