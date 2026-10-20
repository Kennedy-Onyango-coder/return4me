import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  canInitiateSettlementPayout,
  fetchSettlementReadiness,
  readSettlementReadinessPayload,
  settlementReadinessDependencyKey,
  settlementReadinessPath,
  type SettlementReadinessView,
} from '../settlementReadiness';

// =============================================================================
// PHASE 3 — READINESS REFRESH AND THE FAIL-CLOSED INITIATE GATE
// =============================================================================
// The defect this covers: readiness was keyed by claim id alone, so recording an
// approval did not re-run the read and the Initiate button stayed disabled until
// a full page reload. The fix has two halves:
//
//   * a dependency key that changes when approval/settle_at changes;
//   * a per-claim refresh called after every settlement mutation, whose failure
//     CLEARS the cached readiness instead of leaving a stale `ready: true`.
//
// The gate is tested as behaviour. The wiring (call sites and JSX) is pinned
// against source because this repository has no DOM harness.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../../../../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

const READY: SettlementReadinessView = {
  ready: true,
  blockers: [],
  conditions: [
    { code: 'durable_approval_missing', ok: true, label: 'Approval on file', detail: '', next_action: '' },
  ],
};

const BLOCKED: SettlementReadinessView = {
  ready: false,
  blockers: ['durable_approval_missing'],
  conditions: [
    {
      code: 'durable_approval_missing',
      ok: false,
      label: 'A durable settlement approval is on file',
      detail: 'No durable approval is recorded.',
      next_action: 'Record the settlement approval first.',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function baseGate(overrides: Partial<Parameters<typeof canInitiateSettlementPayout>[0]> = {}) {
  return {
    hasApproval: true,
    isDue: true,
    busy: false,
    readiness: READY,
    readinessLoading: false,
    readinessError: null,
    ...overrides,
  };
}

describe('readiness is re-read when an input changes', () => {
  it('keys each claim by id, durable approval and settle_at', () => {
    const before = settlementReadinessDependencyKey([
      { claimId: 'claim-1', hasSettlementApproval: false, settleAt: '2026-10-20T10:00:00.000Z' },
    ]);
    const after = settlementReadinessDependencyKey([
      { claimId: 'claim-1', hasSettlementApproval: true, settleAt: '2026-10-20T10:00:00.000Z' },
    ]);
    expect(before).toBe('claim-1:not-approved:2026-10-20T10:00:00.000Z');
    expect(after).toBe('claim-1:approved:2026-10-20T10:00:00.000Z');
    expect(after).not.toBe(before);
  });

  it('changes when settle_at moves or a claim leaves the queue', () => {
    const key = (rows: unknown) => settlementReadinessDependencyKey(rows);
    expect(
      key([{ claimId: 'c1', hasSettlementApproval: true, settleAt: '2026-10-20T10:00:00.000Z' }]),
    ).not.toBe(
      key([{ claimId: 'c1', hasSettlementApproval: true, settleAt: '2026-10-21T10:00:00.000Z' }]),
    );
    expect(key([{ claimId: 'c1', hasSettlementApproval: true, settleAt: null }])).not.toBe(key([]));
  });

  it('keeps distinct claims in one key without merging their state', () => {
    expect(
      settlementReadinessDependencyKey([
        { claimId: 'c1', hasSettlementApproval: false, settleAt: null },
        { claimId: 'c2', hasSettlementApproval: true, settleAt: '2026-10-20T10:00:00.000Z' },
      ]),
    ).toBe('c1:not-approved:no-settle-at|c2:approved:2026-10-20T10:00:00.000Z');
  });
});

describe('the initiate gate fails closed until the server says ready', () => {
  it('blocks while a durable approval is missing', () => {
    expect(canInitiateSettlementPayout(baseGate({ readiness: BLOCKED }))).toBe(false);
  });

  it('blocks before the first successful check, even with a durable approval', () => {
    expect(canInitiateSettlementPayout(baseGate({ readiness: null }))).toBe(false);
  });

  it('allows initiation only after the server returns a fully ready result', () => {
    expect(canInitiateSettlementPayout(baseGate())).toBe(true);
  });

  it('stays disabled when any other blocker remains', () => {
    const otherBlocker: SettlementReadinessView = {
      ...BLOCKED,
      blockers: ['payout_rows_missing'],
    };
    expect(canInitiateSettlementPayout(baseGate({ readiness: otherBlocker }))).toBe(false);
    expect(canInitiateSettlementPayout(baseGate({ readiness: { ...READY, ready: false } }))).toBe(false);
  });

  it('stays disabled while a recheck is loading or after it fails', () => {
    expect(canInitiateSettlementPayout(baseGate({ readinessLoading: true }))).toBe(false);
    expect(
      canInitiateSettlementPayout(
        baseGate({ readiness: null, readinessError: 'Readiness request failed (500).' }),
      ),
    ).toBe(false);
  });

  it('stays disabled for an unelapsed window or an in-flight sibling action', () => {
    expect(canInitiateSettlementPayout(baseGate({ isDue: false }))).toBe(false);
    expect(canInitiateSettlementPayout(baseGate({ hasApproval: false }))).toBe(false);
    expect(canInitiateSettlementPayout(baseGate({ busy: true }))).toBe(false);
  });
});

describe('the response reader cannot mistake a failure for readiness', () => {
  it('reads the documented envelope', () => {
    expect(readSettlementReadinessPayload(BLOCKED)).toEqual(BLOCKED);
  });

  it('rejects a body without a boolean ready or a checklist', () => {
    expect(() => readSettlementReadinessPayload({ conditions: [] })).toThrow(/not readable/i);
    expect(() => readSettlementReadinessPayload({ ready: true })).toThrow(/no checklist/i);
    expect(() =>
      readSettlementReadinessPayload({ ready: false, conditions: [{ code: 'x' }] }),
    ).toThrow(/malformed condition/i);
  });
});

describe('fetchSettlementReadiness is one authenticated GET', () => {
  it('uses the existing claim-scoped endpoint and returns the parsed checklist', async () => {
    const mock = vi.fn(async () => jsonResponse(BLOCKED));
    vi.stubGlobal('fetch', mock);

    await expect(fetchSettlementReadiness('token-1', 'claim-1')).resolves.toEqual(BLOCKED);
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(settlementReadinessPath('claim-1'));
    expect(url).toBe('/api/admin/claims/claim-1/settlement-readiness');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
  });

  it('surfaces a server refusal as an error, never as ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Claim not found' }, 404)));
    await expect(fetchSettlementReadiness('token-1', 'claim-1')).rejects.toThrow(/Claim not found/);
  });

  it('describes a malformed 200 as unreadable rather than ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ready: 'yes', conditions: [] })));
    await expect(fetchSettlementReadiness('token-1', 'claim-1')).rejects.toThrow(/not readable/i);
  });

  it('describes a network failure as a disabled initiation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await expect(fetchSettlementReadiness('token-1', 'claim-1')).rejects.toThrow(/stays disabled/i);
  });
});

describe('AdminView wiring', () => {
  const adminView = read('src/components/AdminView.tsx');

  it('keys the effect by approval and settle_at, not by claim id alone', () => {
    expect(adminView).toContain('settlementReadinessDependencyKey(');
    expect(adminView).toContain('dashboardData?.pendingSettlements,');
    // A successful dashboard refresh stamps dashboardLoadedAt; including it
    // gives a failed readiness check a real retry path through the console's
    // existing Refresh control.
    expect(adminView).toContain('dashboardLoadedAt,');
    expect(adminView).toContain('refreshSettlementReadiness]);');
  });

  it('re-reads readiness after every settlement mutation that can change it', () => {
    const calls = adminView.split('void refreshSettlementReadiness(claimId)').length - 1;
    // approval, approve-and-pay partial, approve-and-pay success, initiate,
    // legacy release.
    expect(calls).toBeGreaterThanOrEqual(5);
  });

  it('clears the cached readiness when the recheck fails', () => {
    expect(adminView).toContain(
      'setSettlementReadinessById((current) => ({ ...current, [claimId]: null }))',
    );
    expect(adminView).toContain("'Readiness could not be checked.'");
  });

  it('guards each claim independently against stale responses', () => {
    expect(adminView).toContain('settlementReadinessRequestIdRef.current[claimId]');
    expect(adminView).toContain(
      'if (settlementReadinessRequestIdRef.current[claimId] !== requestId) return;',
    );
  });

  it('renders the fail-closed gate and the checklist loading/error state', () => {
    expect(adminView).toContain('disabled={!canInitiateSettlementPayout({');
    expect(adminView).toContain('readinessLoading,');
    expect(adminView).toContain('readinessError,');
    expect(adminView).toContain('loading={readinessLoading}');
    expect(adminView).toContain('error={readinessError}');
  });
});
