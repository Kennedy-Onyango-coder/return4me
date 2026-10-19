import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';

// =============================================================================
// F9 — POSTGRESQL-LEVEL VERIFICATION (AUTHORED, NOT EXECUTED IN THIS BATCH)
// =============================================================================
// The in-memory double cannot model transactions, row locks, CHECK constraints
// or the partial unique index. This suite verifies those properties against a
// real PostgreSQL server — but ONLY an explicitly disposable database:
//
//   * the database name must end in `r4m_payout_repair_test` (optionally
//     suffixed with `_<alphanumeric>`);
//   * the host must be localhost / 127.0.0.1;
//   * the connection string is supplied explicitly as
//     R4M_PG_TEST_DATABASE_URL — DATABASE_URL is never read, so a configured
//     application database can never be selected by accident;
//   * every object it creates lives in a per-run schema dropped in afterAll.
//
// HOW TO RUN (separate authorization required; not run by `npm test`):
//   1. create a disposable local database whose name ends with
//      `r4m_payout_repair_test`;
//   2. $env:R4M_PG_TEST_DATABASE_URL = 'postgresql://.../r4m_payout_repair_test'
//   3. node .\node_modules\vitest\vitest.mjs run --config vitest.pg.config.ts
//
// The default vitest include (`src/**/*.test.ts`) does NOT match this file.

const CONNECTION_URL = process.env.R4M_PG_TEST_DATABASE_URL ?? '';
const parsed = CONNECTION_URL ? new URL(CONNECTION_URL) : null;

function isExplicitlyDisposable(url: URL | null): boolean {
  if (!url) return false;
  const database = url.pathname.replace(/^\//, '');
  const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return localHost && /^r4m_payout_repair_test(_[a-z0-9]+)?$/i.test(database);
}

if (!isExplicitlyDisposable(parsed)) {
  throw new Error(
    'F9 PostgreSQL suite refused to run: set R4M_PG_TEST_DATABASE_URL to an explicitly ' +
      'disposable LOCAL database whose name ends in r4m_payout_repair_test. ' +
      'This suite never reads DATABASE_URL and never creates a database.',
  );
}

const SCHEMA = `r4m_pr_pg_${process.pid}_${Date.now().toString(36)}`;
const q = (name: string) => `"${SCHEMA}"."${name}"`;

let pool: Pool;
let seq = 0;

async function seedLedger(): Promise<{ claimId: string; ledgerId: string; batchId: string }> {
  seq += 1;
  const claimId = `CLM-PG-${seq}`;
  const ledgerId = `LED-PG-${seq}`;
  const batchId = `BATCH-PG-${seq}`;
  await pool.query(`INSERT INTO ${q('claims')} (id, status) VALUES ($1, $2)`, [
    claimId,
    'pending_settlement',
  ]);
  await pool.query(
    `INSERT INTO ${q('ledger')}
       (id, claim_id, type, amount, phone_or_till, status, payout_outcome,
        provider_batch_id, provider_transaction_id, failure_reason)
     VALUES ($1, $2, 'finder_payout', 100.00, '+254712345678', 'failed', 'rejected',
             $3, NULL, 'provider refused')`,
    [ledgerId, claimId, batchId],
  );
  return { claimId, ledgerId, batchId };
}

async function insertRequest(params: {
  id?: string;
  ledgerId: string;
  claimId: string;
  status?: 'proposed' | 'confirmed' | 'expired';
  proposedBy?: string;
  confirmedBy?: string | null;
  confirmedAt?: Date | null;
  expiresAt?: Date;
}): Promise<string> {
  const id = params.id ?? `RPR-PG-${++seq}`;
  await pool.query(
    `INSERT INTO ${q('payout_repair_requests')} (
       id, ledger_entry_id, claim_id, entry_type, repair_operation,
       from_status, from_payout_outcome, to_status, to_payout_outcome,
       reason, evidence_json, row_fingerprint, request_fingerprint,
       status, proposed_by, proposed_at, expires_at, confirmed_by, confirmed_at,
       audit_correlation_id
     ) VALUES (
       $1, $2, $3, 'finder_payout', 'release_rejected_leg',
       'failed', 'rejected', 'pending', 'not_submitted',
       'reviewed provider evidence', '{}', repeat('a', 64), repeat('b', 64),
       $4, $5, now(), $6, $7, $8, $9
     )`,
    [
      id,
      params.ledgerId,
      params.claimId,
      params.status ?? 'proposed',
      params.proposedBy ?? 'admin-a',
      params.expiresAt ?? new Date(Date.now() + 60_000),
      params.confirmedBy ?? null,
      params.confirmedAt ?? null,
      `CORR-${id}`,
    ],
  );
  return id;
}

const DDL = [
  `CREATE TABLE ${q('claims')} (
     id VARCHAR(50) PRIMARY KEY,
     status VARCHAR(30) NOT NULL
   )`,
  `CREATE TABLE ${q('ledger')} (
     id VARCHAR(50) PRIMARY KEY,
     claim_id VARCHAR(50) REFERENCES ${q('claims')}(id),
     type VARCHAR(30) NOT NULL,
     amount NUMERIC(12,2) NOT NULL,
     phone_or_till VARCHAR(50),
     status VARCHAR(20) NOT NULL,
     payout_outcome VARCHAR(20),
     provider_batch_id VARCHAR(100),
     provider_transaction_id VARCHAR(100),
     failure_reason TEXT,
     created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE ${q('audit_log')} (
     id VARCHAR(50) PRIMARY KEY,
     admin_user VARCHAR(100) NOT NULL,
     action VARCHAR(150) NOT NULL,
     details TEXT NOT NULL,
     created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE ${q('payout_repair_requests')} (
     id VARCHAR(50) PRIMARY KEY,
     ledger_entry_id VARCHAR(50) NOT NULL REFERENCES ${q('ledger')}(id),
     claim_id VARCHAR(50) REFERENCES ${q('claims')}(id),
     entry_type VARCHAR(30) NOT NULL,
     repair_operation VARCHAR(50) NOT NULL,
     from_status VARCHAR(20) NOT NULL,
     from_payout_outcome VARCHAR(20),
     to_status VARCHAR(20) NOT NULL,
     to_payout_outcome VARCHAR(20) NOT NULL,
     reason TEXT NOT NULL,
     evidence_json TEXT NOT NULL,
     row_fingerprint VARCHAR(128) NOT NULL,
     request_fingerprint VARCHAR(128) NOT NULL,
     status VARCHAR(20) NOT NULL DEFAULT 'proposed',
     proposed_by VARCHAR(100) NOT NULL,
     proposed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
     expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
     confirmed_by VARCHAR(100),
     confirmed_at TIMESTAMP WITH TIME ZONE,
     outcome VARCHAR(40),
     outcome_detail TEXT,
     audit_correlation_id VARCHAR(50) NOT NULL,
     created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
     CONSTRAINT payout_repair_requests_status_check
       CHECK (status IN ('proposed', 'confirmed', 'expired', 'rejected')),
     CONSTRAINT payout_repair_requests_operation_check
       CHECK (repair_operation IN ('release_rejected_leg')),
     CONSTRAINT payout_repair_requests_entry_type_check
       CHECK (entry_type IN ('finder_payout', 'agent_payout')),
     CONSTRAINT payout_repair_requests_operation_target_check
       CHECK (repair_operation = 'release_rejected_leg'
              AND from_status = 'failed'
              AND from_payout_outcome = 'rejected'
              AND to_status = 'pending'
              AND to_payout_outcome = 'not_submitted'),
     CONSTRAINT payout_repair_requests_dual_control_check
       CHECK (confirmed_by IS NULL OR confirmed_by <> proposed_by),
     CONSTRAINT payout_repair_requests_confirmation_check
       CHECK (status <> 'confirmed' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
   )`,
  `CREATE INDEX idx_payout_repair_requests_ledger ON ${q('payout_repair_requests')}(ledger_entry_id, status)`,
  `CREATE INDEX idx_payout_repair_requests_expiry ON ${q('payout_repair_requests')}(status, expires_at)`,
  `CREATE UNIQUE INDEX uq_payout_repair_open_per_ledger ON ${q('payout_repair_requests')}(ledger_entry_id) WHERE status = 'proposed'`,
];

beforeAll(async () => {
  pool = new Pool({ connectionString: CONNECTION_URL, max: 6 });
  await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
  for (const statement of DDL) await pool.query(statement);
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.end();
  }
});


async function expectSqlState(fn: () => Promise<unknown>, expected: string): Promise<any> {
  try {
    await fn();
  } catch (error: any) {
    expect(error?.code).toBe(expected);
    return error;
  }
  throw new Error(`expected SQLSTATE ${expected}, but the statement succeeded`);
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

describe('PostgreSQL — CHECK constraints enforce the repair vocabulary', () => {
  it('rejects an unknown status (23514)', async () => {
    const { ledgerId, claimId } = await seedLedger();
    await expectSqlState(
      () => insertRequest({ ledgerId, claimId, status: 'proposed' }).then(async (id) => {
        await pool.query(`UPDATE ${q('payout_repair_requests')} SET status = 'maybe' WHERE id = $1`, [id]);
      }),
      '23514',
    );
  });

  it('rejects a source/target state outside the ONE supported operation', async () => {
    const { ledgerId, claimId } = await seedLedger();
    await expectSqlState(
      () =>
        pool.query(
          `INSERT INTO ${q('payout_repair_requests')} (
             id, ledger_entry_id, claim_id, entry_type, repair_operation,
             from_status, from_payout_outcome, to_status, to_payout_outcome,
             reason, evidence_json, row_fingerprint, request_fingerprint,
             status, proposed_by, expires_at, audit_correlation_id
           ) VALUES ('RPR-BAD-OP', $1, $2, 'finder_payout', 'release_rejected_leg',
             'pending', 'not_submitted', 'pending', 'not_submitted',
             'reason', '{}', repeat('a', 64), repeat('b', 64),
             'proposed', 'admin-a', now() + interval '1 hour', 'CORR-BAD')`,
          [ledgerId, claimId],
        ),
      '23514',
    );
  });

  it('rejects a self-confirmed row even when inserted directly (dual control)', async () => {
    const { ledgerId, claimId } = await seedLedger();
    await expectSqlState(
      () =>
        insertRequest({
          ledgerId,
          claimId,
          status: 'confirmed',
          proposedBy: 'same-admin',
          confirmedBy: 'same-admin',
          confirmedAt: new Date(),
        }),
      '23514',
    );
  });

  it('rejects a confirmed row without a confirmer/timestamp', async () => {
    const { ledgerId, claimId } = await seedLedger();
    await expectSqlState(
      () => insertRequest({ ledgerId, claimId, status: 'confirmed', confirmedBy: null }),
      '23514',
    );
  });
});

describe('PostgreSQL — the partial unique index is one OPEN request per ledger row', () => {
  it('rejects a second `proposed` row with 23505 and names the index', async () => {
    const { ledgerId, claimId } = await seedLedger();
    await insertRequest({ ledgerId, claimId });
    const error = await expectSqlState(
      () => insertRequest({ ledgerId, claimId }),
      '23505',
    );
    expect(error.constraint).toBe('uq_payout_repair_open_per_ledger');
  });

  it('allows a replacement once the first request is expired', async () => {
    const { ledgerId, claimId } = await seedLedger();
    const first = await insertRequest({ ledgerId, claimId });
    await pool.query(
      `UPDATE ${q('payout_repair_requests')} SET status = 'expired' WHERE id = $1`,
      [first],
    );
    const second = await insertRequest({ ledgerId, claimId });
    expect(second).not.toBe(first);
    const rows = await pool.query(
      `SELECT status FROM ${q('payout_repair_requests')} WHERE ledger_entry_id = $1 ORDER BY id`,
      [ledgerId],
    );
    expect(rows.rows.map((row: any) => row.status).sort()).toEqual(['expired', 'proposed']);
  });
});


describe('PostgreSQL — concurrent confirmation and expiry (single-winner CAS)', () => {
  it('two concurrent confirmations: exactly ONE wins', async () => {
    const { ledgerId, claimId } = await seedLedger();
    const requestId = await insertRequest({ ledgerId, claimId });

    const attempt = (confirmer: string) =>
      withClient(async (client) => {
        await client.query('BEGIN');
        const result = await client.query(
          `UPDATE ${q('payout_repair_requests')}
              SET status = 'confirmed', confirmed_by = $1, confirmed_at = now(), outcome = 'applied'
            WHERE id = $2 AND status = 'proposed' AND confirmed_by IS NULL
            RETURNING id`,
          [confirmer, requestId],
        );
        await client.query('COMMIT');
        return result.rowCount;
      });

    const results = await Promise.all([attempt('admin-b'), attempt('admin-c')]);
    expect(results.filter((count) => count === 1)).toHaveLength(1);
    expect(results.filter((count) => count === 0)).toHaveLength(1);

    const row = await pool.query(
      `SELECT status, confirmed_by FROM ${q('payout_repair_requests')} WHERE id = $1`,
      [requestId],
    );
    expect(row.rows[0].status).toBe('confirmed');
    expect(['admin-b', 'admin-c']).toContain(row.rows[0].confirmed_by);
  });

  it('concurrent expiry and confirmation cannot both record an outcome', async () => {
    const { ledgerId, claimId } = await seedLedger();
    const requestId = await insertRequest({
      ledgerId,
      claimId,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const expire = () =>
      withClient(async (client) => {
        await client.query('BEGIN');
        const result = await client.query(
          `UPDATE ${q('payout_repair_requests')}
              SET status = 'expired'
            WHERE id = $1 AND status = 'proposed' AND expires_at <= now()
            RETURNING id`,
          [requestId],
        );
        if (result.rowCount === 1) {
          await client.query(
            `INSERT INTO ${q('audit_log')} (id, admin_user, action, details)
             VALUES ('AUD-EXP-PG', 'SYSTEM', 'PAYOUT_REPAIR_EXPIRED', $1)`,
            [`expired ${requestId}`],
          );
        }
        await client.query('COMMIT');
        return result.rowCount;
      });

    const confirm = (confirmer: string) =>
      withClient(async (client) => {
        await client.query('BEGIN');
        const result = await client.query(
          `UPDATE ${q('payout_repair_requests')}
              SET status = 'confirmed', confirmed_by = $1, confirmed_at = now()
            WHERE id = $2 AND status = 'proposed' AND confirmed_by IS NULL
            RETURNING id`,
          [confirmer, requestId],
        );
        if (result.rowCount === 1) {
          await client.query(
            `INSERT INTO ${q('audit_log')} (id, admin_user, action, details)
             VALUES ('AUD-CONF-PG', $1, 'PAYOUT_REPAIR_CONFIRMED', $2)`,
            [confirmer, `confirmed ${requestId}`],
          );
        }
        await client.query('COMMIT');
        return result.rowCount;
      });

    const results = await Promise.all([expire(), confirm('admin-b')]);
    expect((results[0] ?? 0) + (results[1] ?? 0)).toBe(1);

    const audit = await pool.query(
      `SELECT action FROM ${q('audit_log')} WHERE details LIKE $1`,
      [`%${requestId}%`],
    );
    expect(audit.rowCount).toBe(1);
    const finalRow = await pool.query(
      `SELECT status FROM ${q('payout_repair_requests')} WHERE id = $1`,
      [requestId],
    );
    expect(['expired', 'confirmed']).toContain(finalRow.rows[0].status);
  });

  it('a CAS that matches nothing changes nothing (loser path)', async () => {
    const { ledgerId, claimId } = await seedLedger();
    const requestId = await insertRequest({ ledgerId, claimId });
    await withClient(async (client) => {
      await client.query('BEGIN');
      const first = await client.query(
        `UPDATE ${q('payout_repair_requests')} SET status = 'confirmed',
                confirmed_by = 'admin-b', confirmed_at = now()
          WHERE id = $1 AND status = 'proposed' RETURNING id`,
        [requestId],
      );
      expect(first.rowCount).toBe(1);
      const second = await client.query(
        `UPDATE ${q('payout_repair_requests')} SET status = 'expired'
          WHERE id = $1 AND status = 'proposed' RETURNING id`,
        [requestId],
      );
      expect(second.rowCount).toBe(0);
      await client.query('COMMIT');
    });
    const row = await pool.query(
      `SELECT status FROM ${q('payout_repair_requests')} WHERE id = $1`,
      [requestId],
    );
    expect(row.rows[0].status).toBe('confirmed');
  });
});


describe('PostgreSQL — transaction rollback and atomicity', () => {
  it('an explicit ROLLBACK discards both the ledger write and its audit row', async () => {
    const { ledgerId } = await seedLedger();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ${q('ledger')} SET status = 'pending', payout_outcome = 'not_submitted' WHERE id = $1`,
        [ledgerId],
      );
      await client.query(
        `INSERT INTO ${q('audit_log')} (id, admin_user, action, details)
         VALUES ('AUD-ROLLBACK-PG', 'admin-b', 'PAYOUT_REPAIR_CONFIRMED', $1)`,
        [`ledger ${ledgerId}`],
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const ledger = await pool.query(
      `SELECT status, payout_outcome FROM ${q('ledger')} WHERE id = $1`,
      [ledgerId],
    );
    expect(ledger.rows[0].status).toBe('failed');
    expect(ledger.rows[0].payout_outcome).toBe('rejected');
    const audit = await pool.query(
      `SELECT id FROM ${q('audit_log')} WHERE id = 'AUD-ROLLBACK-PG'`,
    );
    expect(audit.rowCount).toBe(0);
  });

  it('an audit insert that violates NOT NULL rolls the ledger change back', async () => {
    const { ledgerId } = await seedLedger();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ${q('ledger')} SET status = 'pending', payout_outcome = 'not_submitted' WHERE id = $1`,
        [ledgerId],
      );
      await expectSqlState(
        () =>
          client.query(
            `INSERT INTO ${q('audit_log')} (id, admin_user, action, details)
             VALUES ('AUD-NULL-PG', NULL, 'PAYOUT_REPAIR_CONFIRMED', 'x')`,
          ),
        '23502',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const ledger = await pool.query(
      `SELECT status, payout_outcome FROM ${q('ledger')} WHERE id = $1`,
      [ledgerId],
    );
    expect(ledger.rows[0].status).toBe('failed');
    expect(ledger.rows[0].payout_outcome).toBe('rejected');
  });

  it('committing audit + request + ledger together is atomic', async () => {
    const { ledgerId, claimId } = await seedLedger();
    const requestId = await insertRequest({ ledgerId, claimId });
    await withClient(async (client) => {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ${q('payout_repair_requests')}
            SET status = 'confirmed', confirmed_by = 'admin-b', confirmed_at = now(), outcome = 'applied'
          WHERE id = $1 AND status = 'proposed'`,
        [requestId],
      );
      await client.query(
        `INSERT INTO ${q('audit_log')} (id, admin_user, action, details)
         VALUES ('AUD-ATOMIC-PG', 'admin-b', 'PAYOUT_REPAIR_CONFIRMED', $1)`,
        [`ledger ${ledgerId}`],
      );
      await client.query(
        `UPDATE ${q('ledger')} SET status = 'pending', payout_outcome = 'not_submitted' WHERE id = $1`,
        [ledgerId],
      );
      await client.query('COMMIT');
    });

    const ledger = await pool.query(
      `SELECT status, payout_outcome FROM ${q('ledger')} WHERE id = $1`,
      [ledgerId],
    );
    expect(ledger.rows[0]).toEqual({ status: 'pending', payout_outcome: 'not_submitted' });
    const request = await pool.query(
      `SELECT status FROM ${q('payout_repair_requests')} WHERE id = $1`,
      [requestId],
    );
    expect(request.rows[0].status).toBe('confirmed');
    const audit = await pool.query(`SELECT id FROM ${q('audit_log')} WHERE id = 'AUD-ATOMIC-PG'`);
    expect(audit.rowCount).toBe(1);
  });
});
