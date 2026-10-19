import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  assertReadOnlyStatement,
  assertAllQueriesReadOnly,
  classifyPayoutLeg,
  runPayoutRepairDryRun,
  assertSafeDryRunEnvironment,
  ReadOnlyViolationError,
  DRY_RUN_QUERIES,
  READ_ONLY_SESSION_BEGIN,
  READ_ONLY_SESSION_END,
} from '../../scripts/payoutRepairDryRun';
import {
  PAYOUT_REFUSAL_EVIDENCE_ACTION,
  PAYOUT_REFUSAL_EVIDENCE_PREFIX,
} from '../config/payoutRepairPolicy';

// =============================================================================
// PHASE 1 — THE DRY RUN IS READ-ONLY, AND SAYS SO HONESTLY
// =============================================================================
// Two independent properties are tested:
//   1. the SQL it can issue (the guard is applied to the REAL query map, and a
//      mutating statement such as `UPDATE ledger` is rejected);
//   2. what it concludes and prints (a row with no submission record is
//      BLOCKED, never "safe", and nothing sensitive is emitted).

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/payoutRepairDryRun.ts');

function makeQuery(store: { ledger: any[]; claims: any[]; audit: any[] }) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql === DRY_RUN_QUERIES.LEDGER_ROW) return { rows: store.ledger.filter((r) => r.id === params[0]) };
    if (sql === DRY_RUN_QUERIES.CLAIM) return { rows: store.claims.filter((c) => c.id === params[0]) };
    if (sql === DRY_RUN_QUERIES.CLAIM_LEDGER) {
      return { rows: store.ledger.filter((r) => r.claim_id === params[0]) };
    }
    if (sql === DRY_RUN_QUERIES.AUDIT_EVIDENCE) {
      const pattern = String(params[0] ?? '').replace(/^%|%$/g, '');
      const actions = Array.isArray(params[1]) ? params[1] : [];
      return {
        rows: store.audit.filter(
          (a) => String(a.details).includes(pattern) || actions.includes(a.action),
        ),
      };
    }
    if (sql === DRY_RUN_QUERIES.FAILED_PAYOUT_CANDIDATES) {
      return { rows: store.ledger.filter((r) => r.status === params[0]) };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return { query, calls };
}

function ledgerRow(overrides: any = {}) {
  return {
    id: 'LED-DRY-1',
    claim_id: 'CLM-DRY-1',
    item_id: 'ITM-1',
    type: 'finder_payout',
    amount: '100.00',
    phone_or_till: '+254712345678',
    status: 'failed',
    payout_outcome: null,
    provider_batch_id: null,
    provider_transaction_id: null,
    failure_reason: null,
    created_at: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** The external evidence contract, supplied by the test store. */
function evidenceRow(row: any) {
  return {
    id: `AUD-EV-${row.id}`,
    action: PAYOUT_REFUSAL_EVIDENCE_ACTION,
    details:
      PAYOUT_REFUSAL_EVIDENCE_PREFIX +
      JSON.stringify({
        version: 1,
        ledger_entry_id: row.id,
        provider: 'intasend',
        provider_batch_id: row.provider_batch_id ?? null,
        provider_transaction_id: null,
        idempotency_key: `PAYOUT_LEG_FINDER:${row.claim_id}`,
        idempotency_key_disposition: 'released',
        non_execution_reference: `INTASEND-REFUSAL-${row.id}`,
        recorded_by: 'reconciliation-operator',
        recorded_at: '2026-05-01T08:00:00.000Z',
      }),
  };
}

describe('dry run — the read-only guard', () => {
  it('accepts every statement in the real query map', () => {
    expect(() => assertAllQueriesReadOnly()).not.toThrow();
    for (const sql of Object.values(DRY_RUN_QUERIES)) {
      expect(() => assertReadOnlyStatement(sql)).not.toThrow();
      expect(assertReadOnlyStatement(sql).toUpperCase().startsWith('SELECT')).toBe(true);
    }
  });

  it.each([
    "UPDATE ledger SET status = 'pending' WHERE id = 'LED-1'",
    'DELETE FROM ledger WHERE id = $1',
    'INSERT INTO ledger (id) VALUES ($1)',
    'ALTER TABLE ledger ADD COLUMN x TEXT',
    'DROP TABLE ledger',
    'TRUNCATE ledger',
    'GRANT ALL ON ledger TO someone',
    'SELECT 1; UPDATE ledger SET status = $1',
    'WITH x AS (DELETE FROM ledger RETURNING id) SELECT * FROM x',
    'SELECT * INTO backup FROM ledger',
    'BEGIN',
    'COMMIT',
    "SELECT 1 -- UPDATE ledger\n",
  ])('rejects %s', (sql) => {
    expect(() => assertReadOnlyStatement(sql)).toThrow(ReadOnlyViolationError);
  });

  it('rejects non-strings and empty statements', () => {
    expect(() => assertReadOnlyStatement(null)).toThrow(ReadOnlyViolationError);
    expect(() => assertReadOnlyStatement('   ')).toThrow(ReadOnlyViolationError);
  });

  it('the session statements can never be data queries (the guard refuses them too)', () => {
    expect(() => assertReadOnlyStatement(READ_ONLY_SESSION_BEGIN)).toThrow(ReadOnlyViolationError);
    expect(() => assertReadOnlyStatement(READ_ONLY_SESSION_END)).toThrow(ReadOnlyViolationError);
    expect(READ_ONLY_SESSION_BEGIN).toBe('BEGIN TRANSACTION READ ONLY');
    expect(READ_ONLY_SESSION_END).toBe('ROLLBACK');
  });

  it('the SCRIPT SOURCE contains no provider call and no write path', () => {
    const rawSource = fs.readFileSync(SCRIPT_PATH, 'utf8');
    // Strip comments first: the file DESCRIBES what it must not do, and a
    // mention in prose is not an import, a call or a write.
    const source = rawSource
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      })
      .join('\n');

    // No payout/provider service is imported or invoked.
    expect(source).not.toMatch(/PaymentService/);
    expect(source).not.toMatch(/triggerIntasendPayout/);
    expect(source).not.toMatch(/from ['"]\.\.\/src\/services/);
    expect(source).not.toMatch(/axios/);
    expect(source).not.toMatch(/fetch\s*\(/);
    // No Drizzle write helpers are used.
    expect(source).not.toMatch(/\.insert\s*\(/);
    expect(source).not.toMatch(/\.update\s*\(/);
    expect(source).not.toMatch(/\.delete\s*\(/);
    // It does not import the data layer (which can write).
    expect(source).not.toMatch(/from ['"]\.\.\/src\/db\//);
    // The ONLY direct client statements are the read-only session begin/rollback;
    // every data statement goes through the injected, guarded query function.
    const directClientQueries = [...source.matchAll(/client\.query\(([^)]*)/g)].map((m) =>
      m[1].trim(),
    );
    expect(directClientQueries.filter((d) => d.includes('READ_ONLY_SESSION'))).toHaveLength(2);
    expect(directClientQueries.filter((d) => d.startsWith('sql'))).toHaveLength(1);
    expect(source).toContain('READ_ONLY_SESSION_BEGIN');
    expect(source).toContain('READ_ONLY_SESSION_END');
  });
});

describe('dry run — classification and honest reporting', () => {
  it('classifies a legacy failed + NULL outcome row as BLOCKED, and says why without overclaiming', async () => {
    const store = {
      ledger: [ledgerRow()],
      claims: [{ id: 'CLM-DRY-1', status: 'pending_settlement' }],
      audit: [],
    };
    const { query } = makeQuery(store);
    const report = await classifyPayoutLeg(query, 'LED-DRY-1');

    expect(report.found).toBe(true);
    expect(report.classification).toBe('BLOCKED');
    expect(report.blockingCodes).toContain('submission_history_missing');
    expect(report.submissionHistoryReading).toMatch(/no submission record was found/i);
    expect(report.submissionHistoryReading).toMatch(/NOT evidence/i);
  });

  it('classifies a provider-rejected leg as ELIGIBLE only when imported evidence is present', async () => {
    const row = ledgerRow({
      payout_outcome: 'rejected',
      provider_batch_id: 'BATCH-1',
      failure_reason: 'IntaSend refused this transaction (provider rejection - the transfer was not executed).',
    });
    const store = {
      ledger: [row],
      claims: [{ id: 'CLM-DRY-1', status: 'pending_settlement' }],
      audit: [evidenceRow(row)],
    };
    const { query } = makeQuery(store);
    const report = await classifyPayoutLeg(query, 'LED-DRY-1');
    expect(report.classification).toBe('ELIGIBLE');
    expect(report.blockingCodes).toEqual([]);
    expect(report.evidenceSummary.refusalEvidenceValid).toBe(true);
  });

  it('classifies a provider-rejected leg WITHOUT imported evidence as BLOCKED (F1)', async () => {
    const store = {
      ledger: [
        ledgerRow({
          payout_outcome: 'rejected',
          provider_batch_id: 'BATCH-1',
          failure_reason: 'IntaSend refused this transaction (provider rejection - the transfer was not executed).',
        }),
      ],
      claims: [{ id: 'CLM-DRY-1', status: 'pending_settlement' }],
      audit: [],
    };
    const { query } = makeQuery(store);
    const report = await classifyPayoutLeg(query, 'LED-DRY-1');
    expect(report.found).toBe(true);
    expect(report.classification).toBe('BLOCKED');
    expect(report.blockingCodes).toContain('refusal_provenance_unverified');
    expect(report.submissionHistoryReading).toMatch(/NOT proof/i);
  });

  it('reports a missing row as BLOCKED (never as "nothing to fix")', async () => {
    const { query } = makeQuery({ ledger: [], claims: [], audit: [] });
    const report = await classifyPayoutLeg(query, 'LED-MISSING');
    expect(report.found).toBe(false);
    expect(report.classification).toBe('BLOCKED');
    expect(report.blockingCodes).toContain('row_not_found');
  });

  it('masks the destination and never prints the amount or the raw phone number', async () => {
    const store = {
      ledger: [ledgerRow()],
      claims: [{ id: 'CLM-DRY-1', status: 'pending_settlement' }],
      audit: [],
    };
    const { query } = makeQuery(store);
    const report = await classifyPayoutLeg(query, 'LED-DRY-1');

    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('712345678');
    expect(serialised).not.toContain('100.00');
    expect(report.destinationMasked).toBeTruthy();
    expect(report.amountPresent).toBe(true);
  });

  it('returns a failing exit code whenever ANY inspected row is blocked or missing', async () => {
    const store = {
      ledger: [ledgerRow(), ledgerRow({ id: 'LED-DRY-2', payout_outcome: 'rejected', failure_reason: 'refused' })],
      claims: [{ id: 'CLM-DRY-1', status: 'pending_settlement' }],
      audit: [],
    };
    const { query } = makeQuery(store);
    const result = await runPayoutRepairDryRun({ query, ledgerEntryIds: ['LED-DRY-1', 'LED-DRY-2'] });
    expect(result.inspected).toBe(2);
    expect(result.eligible).toBe(0);
    expect(result.blocked).toBe(2);
    expect(result.exitCode).toBe(1);
  });

  it('returns 0 only when every inspected row is eligible and present', async () => {
    const row = ledgerRow({ payout_outcome: 'rejected', failure_reason: 'refused' });
    const store = {
      ledger: [row],
      claims: [{ id: 'CLM-DRY-1', status: 'pending_settlement' }],
      audit: [evidenceRow(row)],
    };
    const { query } = makeQuery(store);
    const result = await runPayoutRepairDryRun({ query, ledgerEntryIds: ['LED-DRY-1'] });
    expect(result).toMatchObject({ inspected: 1, eligible: 1, blocked: 0, missing: 0, exitCode: 0 });
  });

  it('returns a failing exit code when nothing is inspected at all', async () => {
    const { query } = makeQuery({ ledger: [], claims: [], audit: [] });
    const result = await runPayoutRepairDryRun({ query });
    expect(result.inspected).toBe(0);
    expect(result.exitCode).toBe(1);
  });

  it('every statement it actually ran passed the guard', async () => {
    const store = {
      ledger: [ledgerRow()],
      claims: [{ id: 'CLM-DRY-1', status: 'pending_settlement' }],
      audit: [],
    };
    const { query, calls } = makeQuery(store);
    await runPayoutRepairDryRun({ query, ledgerEntryIds: ['LED-DRY-1'] });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(() => assertReadOnlyStatement(call.sql)).not.toThrow();
    }
  });
});

describe('dry run — it refuses an unsafe target', () => {
  const base = { DATABASE_URL: 'postgres://localhost/r4m_test' } as any;

  it('refuses when the target is not named', () => {
    expect(() => assertSafeDryRunEnvironment({ ...base })).toThrow(/PAYOUT_REPAIR_DRY_RUN_TARGET/);
  });

  it('refuses a production target', () => {
    expect(() =>
      assertSafeDryRunEnvironment({ ...base, PAYOUT_REPAIR_DRY_RUN_TARGET: 'production' }),
    ).toThrow(/forbids/);
  });

  it('refuses NODE_ENV=production even with a local target', () => {
    expect(() =>
      assertSafeDryRunEnvironment({
        ...base,
        PAYOUT_REPAIR_DRY_RUN_TARGET: 'local-or-staging',
        NODE_ENV: 'production',
      }),
    ).toThrow(/NODE_ENV=production/);
  });

  it('refuses without a DATABASE_URL, and accepts an approved local target', () => {
    expect(() =>
      assertSafeDryRunEnvironment({ PAYOUT_REPAIR_DRY_RUN_TARGET: 'local-or-staging' } as any),
    ).toThrow(/DATABASE_URL/);
    expect(() =>
      assertSafeDryRunEnvironment({
        ...base,
        PAYOUT_REPAIR_DRY_RUN_TARGET: 'local-or-staging',
      }),
    ).not.toThrow();
  });
});
