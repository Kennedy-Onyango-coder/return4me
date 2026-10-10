import { describe, it, expect } from 'vitest';
import {
  METRIC_NOT_REPORTED,
  OVERVIEW_OPTIONAL_STATS_FIELDS,
  OVERVIEW_REQUIRED_STATS_FIELDS,
  formatKesAmount,
  formatMetricCount,
  isReportedNumber,
  readOverviewStats,
} from '../adminOverviewMetrics';
// BATCH 3 — the Batch 2 payout panel already had the ONE deterministic currency
// formatter in this codebase. The Overview must agree with it exactly, or the two
// admin surfaces would show the same shilling amount two different ways.
import { formatPayoutAmount } from '../../../../services/adminPayoutReconciliationApi';

// =============================================================================
// BATCH 3 — THE ADMIN OVERVIEW'S METRIC READ-OUT
// =============================================================================
// These are BEHAVIOUR tests against the real functions. The module is
// deliberately React-free (see its header) precisely so the two rules that
// matter can be EXECUTED rather than described:
//
//   1. a genuine reported zero stays a valid zero, and a figure the server did
//      not send is never turned into one;
//   2. a payload that is not the statistics this console was built against is a
//      FAILED refresh (error + retry), never a screen of zeros and never a crash.

const validStats = () => ({
  pendingAgentsCount: 2,
  itemsInReviewCount: 1,
  itemsAtAgentCount: 3,
  escrowHeldAmount: 2400,
  escrowHeldCount: 2,
  disputesOpenCount: 1,
  totalRevenue: 18600,
  settlementPendingAmount: 0,
  settlementPendingCount: 0,
  releasingAmount: 0,
  releasingCount: 0,
  fundsInFlightAmount: 2400,
  fundsInFlightCount: 2,
  unresolvedPayoutsCount: 0,
  unresolvedPayoutsAmount: 0,
});

const payloadWith = (stats: Record<string, unknown>) => ({ stats });

describe('formatKesAmount — KES money at the column scale', () => {
  it('renders a genuine zero as KES 0.00, not as "not reported"', () => {
    expect(formatKesAmount(0)).toEqual({ text: 'KES 0.00', reported: true });
  });

  it('renders amounts at the NUMERIC(10,2) scale, ungrouped', () => {
    expect(formatKesAmount(1500)).toEqual({ text: 'KES 1500.00', reported: true });
    expect(formatKesAmount(2400.5)).toEqual({ text: 'KES 2400.50', reported: true });
    // The display layer is where a float artefact from summing 2-dp ledger
    // amounts is absorbed: 0.1 + 0.2 is 0.30000000000000004 in JS.
    expect(formatKesAmount(0.1 + 0.2)).toEqual({ text: 'KES 0.30', reported: true });
    // No thousands separators: a deterministic figure that cannot depend on a
    // locale, matching the Batch 2 payout panel.
    expect(formatKesAmount(1234567.89).text).toBe('KES 1234567.89');
    expect(formatKesAmount(1234567.89).text).not.toContain(',');
  });

  it('is byte-for-byte the same formatter the Batch 2 payout panel uses', () => {
    for (const value of [0, 1500, 2400.5, 1234567.89]) {
      expect(formatKesAmount(value).text).toBe(formatPayoutAmount(value).text);
    }
  });

  it('reports a missing or non-numeric figure as not reported, never as zero', () => {
    for (const value of [null, undefined, NaN, Infinity, -Infinity, '1500', 'not-a-number', true, {}, []]) {
      expect(formatKesAmount(value)).toEqual({ text: METRIC_NOT_REPORTED, reported: false });
    }
  });

  it('renders a negative amount as reported rather than silently fixing it', () => {
    // The aggregates that feed this card only add positive locked fees, so a
    // negative amount can only mean the payload itself is wrong. Hiding it
    // (clamping to 0, or taking the absolute value) would hide the defect.
    expect(formatKesAmount(-250.5)).toEqual({ text: 'KES -250.50', reported: true });
  });
});

describe('formatMetricCount — row counts', () => {
  it('renders a genuine zero as 0', () => {
    expect(formatMetricCount(0)).toEqual({ text: '0', reported: true });
  });

  it('renders a whole count verbatim', () => {
    expect(formatMetricCount(7)).toEqual({ text: '7', reported: true });
    expect(formatMetricCount(1200)).toEqual({ text: '1200', reported: true });
  });

  it('reports a missing or non-numeric count as not reported, never as 0', () => {
    for (const value of [null, undefined, NaN, Infinity, '3', false, {}]) {
      expect(formatMetricCount(value)).toEqual({ text: METRIC_NOT_REPORTED, reported: false });
    }
  });
});

describe('isReportedNumber — zero is a figure, absence is not', () => {
  it('accepts every finite number, including 0 and negatives', () => {
    expect(isReportedNumber(0)).toBe(true);
    expect(isReportedNumber(-1)).toBe(true);
    expect(isReportedNumber(0.5)).toBe(true);
  });

  it('rejects everything that is not a finite number', () => {
    for (const value of [undefined, null, NaN, Infinity, '0', '', true, {}, []]) {
      expect(isReportedNumber(value)).toBe(false);
    }
  });
});


describe('readOverviewStats — a failed response is not a screen of zeros', () => {
  it('accepts the payload the current server actually publishes', () => {
    const readout = readOverviewStats(payloadWith(validStats()));
    expect(readout.ok).toBe(true);
    expect(readout.reason).toBeUndefined();
    expect(readout.stats).toEqual(validStats());
  });

  it('accepts a SUCCESSFUL, GENUINELY EMPTY dashboard (every figure a real zero)', () => {
    // The distinction this whole batch exists for: all-zero figures are a valid
    // reading of a platform with no claims, not a failure and not "unknown".
    const empty = Object.fromEntries(
      [...OVERVIEW_REQUIRED_STATS_FIELDS, ...OVERVIEW_OPTIONAL_STATS_FIELDS].map((f) => [f, 0] as const),
    );
    const readout = readOverviewStats(payloadWith(empty));
    expect(readout.ok).toBe(true);
    expect(formatKesAmount(readout.stats?.escrowHeldAmount)).toEqual({ text: 'KES 0.00', reported: true });
    expect(formatMetricCount(readout.stats?.pendingAgentsCount)).toEqual({ text: '0', reported: true });
    expect(formatKesAmount(readout.stats?.unresolvedPayoutsAmount)).toEqual({ text: 'KES 0.00', reported: true });
  });

  it('rejects a body that is not a JSON object at all', () => {
    for (const body of [null, undefined, 42, 'oops', true, [], [{ stats: validStats() }]]) {
      const readout = readOverviewStats(body);
      expect(readout.ok).toBe(false);
      expect(readout.reason, `body ${JSON.stringify(body)} must be explained`).toBeTruthy();
      expect(readout.stats).toBeUndefined();
    }
  });

  it('rejects a response that carries no statistics block', () => {
    for (const body of [{}, { error: 'nope' }, { stats: null }, { stats: [] }, { stats: 'nope' }]) {
      const readout = readOverviewStats(body);
      expect(readout.ok).toBe(false);
      expect(readout.reason).toBeTruthy();
    }
  });

  it('rejects a MISSING required field instead of treating it as zero', () => {
    for (const field of OVERVIEW_REQUIRED_STATS_FIELDS) {
      const stats = validStats() as Record<string, unknown>;
      delete stats[field];
      const readout = readOverviewStats(payloadWith(stats));
      expect(readout.ok, `omitting ${field} must fail the payload`).toBe(false);
      expect(readout.reason).toContain(field);
    }
  });

  it('rejects a required field that is not a finite number', () => {
    for (const bad of [null, undefined, NaN, Infinity, '2400', '', true, {}, []]) {
      const readout = readOverviewStats(payloadWith({ ...validStats(), escrowHeldAmount: bad }));
      expect(readout.ok, `escrowHeldAmount=${String(bad)} must fail the payload`).toBe(false);
      expect(readout.reason).toContain('escrowHeldAmount');
    }
  });

  it('rejects a count that is fractional or negative, rather than rounding it', () => {
    for (const bad of [2.5, -1, '2', null]) {
      expect(readOverviewStats(payloadWith({ ...validStats(), escrowHeldCount: bad })).ok).toBe(false);
      expect(readOverviewStats(payloadWith({ ...validStats(), pendingAgentsCount: bad })).ok).toBe(false);
    }
    // A whole, non-negative count — including zero — is always valid.
    expect(readOverviewStats(payloadWith({ ...validStats(), escrowHeldCount: 0 })).ok).toBe(true);
  });

  it('allows a legitimately ABSENT optional field (an older build) through', () => {
    const stats = validStats() as Record<string, unknown>;
    for (const field of OVERVIEW_OPTIONAL_STATS_FIELDS) delete stats[field];
    const readout = readOverviewStats(payloadWith(stats));
    expect(readout.ok).toBe(true);
    // ...and that absence renders as "not reported", never as 0.
    expect(formatKesAmount(readout.stats?.fundsInFlightAmount)).toEqual({ text: METRIC_NOT_REPORTED, reported: false });
    expect(formatMetricCount(readout.stats?.unresolvedPayoutsCount)).toEqual({ text: METRIC_NOT_REPORTED, reported: false });
  });

  it('rejects an optional field that IS present but corrupt', () => {
    // Absence ("this build does not report it") and corruption ("the value is
    // garbage") are different facts and must not collapse into one.
    for (const field of OVERVIEW_OPTIONAL_STATS_FIELDS) {
      const readout = readOverviewStats(payloadWith({ ...validStats(), [field]: 'garbage' }));
      expect(readout.ok, `${field} present but non-numeric must fail`).toBe(false);
      expect(readout.reason).toContain(field);
    }
  });

  it('never mutates or defaults the statistics it is given', () => {
    const stats = validStats();
    const before = JSON.stringify(stats);
    const readout = readOverviewStats(payloadWith(stats));
    expect(readout.ok).toBe(true);
    expect(JSON.stringify(stats)).toBe(before);
    expect(readout.stats).toBe(stats);
  });
});
