import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { db } from '../db/database';
import { db as drizzle } from '../db/index';
import { claims as claimsTable, ledger as ledgerTable } from '../db/schema';
import { eq } from 'drizzle-orm';
import { generateToken } from '../services/auth';
import { registerAdminPayoutRepairRoutes } from '../routes/adminPayoutRepair';
import {
  PAYOUT_REFUSAL_EVIDENCE_ACTION,
  PAYOUT_REFUSAL_EVIDENCE_PREFIX,
} from '../config/payoutRepairPolicy';

// =============================================================================
// PHASE 1 — THE ENDPOINTS, THEIR DEFAULT-DENY AUTHORIZATION AND SCHEMA PARITY
// =============================================================================
// The endpoints are mounted on a REAL Express app with the REAL handlers, the
// REAL permission guard (where the test is about default-deny) and the REAL
// JWT check. Only the admin-session middleware and the error helper are injected,
// because server.ts cannot be imported (it starts listening at import time).
//
// The second app overrides the permission GUARD and supplies a permissive
// permission resolver, because in production NO role holds these permissions —
// without that seam the authorized branch would be untestable, and an untested
// branch is exactly where a dual-control bug would hide.

const RUN = `ep-${Date.now().toString(36)}`;
const ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const PROPOSER = `proposer-${RUN}`;
const CONFIRMER = `confirmer-${RUN}`;
const REASON = 'Provider statement shows the earlier transfer was refused before execution.';

const proposerToken = generateToken({ userId: PROPOSER, role: 'admin', username: PROPOSER } as any);
const confirmerToken = generateToken({ userId: CONFIRMER, role: 'admin', username: CONFIRMER } as any);

let seq = 0;
async function seedLeg(outcome: string | null): Promise<string> {
  seq += 1;
  const claimId = `CLM-${RUN}-${seq}`;
  const rowId = `LED-${RUN}-${seq}`;
  await drizzle.insert(claimsTable).values({
    id: claimId,
    owner_phone: '+254700000002',
    security_answers: {},
    status: 'pending_settlement',
  } as any);
  await drizzle.insert(ledgerTable).values({
    id: rowId,
    claim_id: claimId,
    item_id: null,
    type: 'finder_payout',
    amount: '100.00',
    phone_or_till: '+254712345678',
    status: 'failed',
    payout_outcome: outcome,
    provider_batch_id: `BATCH-${RUN}-${seq}`,
    provider_transaction_id: null,
    failure_reason: 'IntaSend refused this transaction (provider rejection - the transfer was not executed).',
  } as any);
  if (outcome === 'rejected') {
    // The external evidence contract from config/payoutRepairPolicy.ts. No
    // production code writes it; the endpoint test supplies it so the authorized
    // path can be exercised.
    await db.logAudit(
      'SYSTEM',
      PAYOUT_REFUSAL_EVIDENCE_ACTION,
      PAYOUT_REFUSAL_EVIDENCE_PREFIX +
        JSON.stringify({
          version: 1,
          ledger_entry_id: rowId,
          provider: 'intasend',
          provider_batch_id: `BATCH-${RUN}-${seq}`,
          provider_transaction_id: null,
          idempotency_key: `PAYOUT_LEG_FINDER:${claimId}`,
          idempotency_key_disposition: 'released',
          non_execution_reference: `INTASEND-REFUSAL-${rowId}`,
          recorded_by: 'reconciliation-operator',
          recorded_at: '2026-05-01T08:00:00.000Z',
        }),
    );
  }
  return rowId;
}

function buildApp(options: { overrideGuard: boolean }) {
  const app = express();
  app.use(express.json());
  registerAdminPayoutRepairRoutes(app, {
    requireCurrentAdminSession: (_req: any, _res: any, next: any) => next(),
    sendServerError: (res: any, _error: any, context: string) =>
      res.status(500).json({ error: 'server_error', context }),
    ...(options.overrideGuard
      ? {
          requireAdminPermission: () => (_req: any, _res: any, next: any) => next(),
          serviceDeps: { hasPermission: () => true },
        }
      : {}),
  });
  return app;
}

async function listen(app: any): Promise<{ base: string; close: () => Promise<void> }> {
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () =>
      new Promise<void>((resolve) => {
        // Keep-alive sockets from undici would otherwise delay close() for
        // seconds; a test must not hang on transport bookkeeping.
        try {
          server.closeAllConnections?.();
        } catch {
          /* older Node */
        }
        server.close(() => resolve());
      }),
  };
}

async function post(base: string, token: string, url: string, body?: any) {
  const response = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json: any = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

describe('payout repair endpoints — authorization is denied by default', () => {
  let real: { base: string; close: () => Promise<void> };

  beforeAll(async () => {
    real = await listen(buildApp({ overrideGuard: false }));
  });
  afterAll(async () => {
    await real.close();
  });

  it('answers 403 to an administrator for BOTH endpoints (no role holds the permission)', async () => {
    const propose = await post(real.base, proposerToken, '/api/admin/payout-repairs', {
      ledgerEntryId: 'LED-ANY',
      reason: REASON,
    });
    expect(propose.status).toBe(403);
    expect(propose.json.error).toBe('Access denied.');

    const confirm = await post(real.base, confirmerToken, '/api/admin/payout-repairs/RPR-ANY/confirm');
    expect(confirm.status).toBe(403);
    expect(confirm.json.error).toBe('Access denied.');
  });

  it('answers 401/403 without a token', async () => {
    const response = await fetch(`${real.base}/api/admin/payout-repairs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect([401, 403]).toContain(response.status);
  });
});

describe('payout repair endpoints — behaviour behind the (test-only) permission seam', () => {
  let app: { base: string; close: () => Promise<void> };

  beforeAll(async () => {
    app = await listen(buildApp({ overrideGuard: true }));
  });
  afterAll(async () => {
    await app.close();
  });

  it('proposes, then a DIFFERENT administrator confirms — over real HTTP', async () => {
    const rowId = await seedLeg('rejected');
    const proposed = await post(app.base, proposerToken, '/api/admin/payout-repairs', {
      ledgerEntryId: rowId,
      reason: REASON,
    });
    expect(proposed.status).toBe(201);
    expect(proposed.json.success).toBe(true);
    expect(proposed.json.code).toBe('PROPOSED');
    const requestId = proposed.json.data.requestId;
    expect(requestId).toMatch(/^RPR-/);

    // Self-confirmation is a 409 with a specific code, not a generic 403.
    const self = await post(app.base, proposerToken, `/api/admin/payout-repairs/${requestId}/confirm`);
    expect(self.status).toBe(409);
    expect(self.json.code).toBe('SELF_CONFIRMATION_FORBIDDEN');

    const confirmed = await post(app.base, confirmerToken, `/api/admin/payout-repairs/${requestId}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.code).toBe('CONFIRMED');
    expect(confirmed.json.data.confirmedBy).toBe(CONFIRMER);

    // No response body ever carries a destination, amount or raw phone number.
    const all = JSON.stringify([proposed.json, self.json, confirmed.json]);
    expect(all).not.toContain('712345678');
    expect(all).not.toContain('100.00');

    const rows: any[] = await drizzle.select().from(ledgerTable).where(eq(ledgerTable.id, rowId));
    expect(rows[0].status).toBe('pending');
    expect(rows[0].payout_outcome).toBe('not_submitted');
  });

  it('revalidates: a request whose row became ineligible cannot be confirmed', async () => {
    const rowId = await seedLeg('rejected');
    const proposed = await post(app.base, proposerToken, '/api/admin/payout-repairs', {
      ledgerEntryId: rowId,
      reason: REASON,
    });
    await drizzle
      .update(ledgerTable)
      .set({ failure_reason: 'A later provider callback reported a different outcome.' } as any)
      .where(eq(ledgerTable.id, rowId));

    const confirmed = await post(
      app.base,
      confirmerToken,
      `/api/admin/payout-repairs/${proposed.json.data.requestId}/confirm`,
    );
    expect(confirmed.status).toBe(409);
    expect(confirmed.json.code).toBe('STALE_TARGET_STATE');
  });

  it('answers 422 with blocking codes for a legacy NULL-outcome row', async () => {
    const rowId = await seedLeg(null);
    const response = await post(app.base, proposerToken, '/api/admin/payout-repairs', {
      ledgerEntryId: rowId,
      reason: REASON,
    });
    expect(response.status).toBe(422);
    expect(response.json.code).toBe('INELIGIBLE');
    expect(response.json.blockingCodes).toContain('submission_history_missing');
    // The refusal carries no evidence digest and no destination.
    expect(JSON.stringify(response.json)).not.toContain('712345678');
  });

  it('validates parameters and reports a missing request as 404', async () => {
    const badId = await post(app.base, proposerToken, '/api/admin/payout-repairs', {
      ledgerEntryId: "LED-1' OR 1=1",
      reason: REASON,
    });
    expect(badId.status).toBe(400);
    expect(badId.json.code).toBe('INVALID_LEDGER_ENTRY_ID');

    const badReason = await post(app.base, proposerToken, '/api/admin/payout-repairs', {
      ledgerEntryId: 'LED-1',
      reason: 'no',
    });
    expect(badReason.status).toBe(400);
    expect(badReason.json.code).toBe('INVALID_REASON');

    const missing = await post(app.base, confirmerToken, '/api/admin/payout-repairs/RPR-NOTFOUND/confirm');
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe('NOT_FOUND');
  });
});

describe('payout repair schema — one table, declared identically in all three sources', () => {
  it('schema.ts declares the table, its constraints and the one-open-request index', () => {
    const source = read('src/db/schema.ts');
    expect(source).toContain('"payout_repair_requests"');
    for (const name of [
      'uq_payout_repair_open_per_ledger',
      'payout_repair_requests_status_check',
      'payout_repair_requests_operation_check',
      'payout_repair_requests_entry_type_check',
      'payout_repair_requests_operation_target_check',
      'payout_repair_requests_dual_control_check',
      'payout_repair_requests_confirmation_check',
    ]) {
      expect(source).toContain(name);
    }
    // The CHECK vocabularies are generated from the policy module, never restated.
    expect(source).toContain('PAYOUT_REPAIR_STATUS_SQL_LIST');
    expect(source).toContain('PAYOUT_REPAIR_OPERATION_SQL_LIST');
    expect(source).toContain('PAYOUT_REPAIR_LEG_TYPE_SQL_LIST');
  });

  it('sql/schema.sql declares the same table, every constraint and the partial unique index', () => {
    const sql = read('sql/schema.sql');
    expect(sql).toContain('CREATE TABLE payout_repair_requests');
    for (const name of [
      'payout_repair_requests_status_check',
      'payout_repair_requests_operation_check',
      'payout_repair_requests_entry_type_check',
      'payout_repair_requests_operation_target_check',
      'payout_repair_requests_dual_control_check',
      'payout_repair_requests_confirmation_check',
      'uq_payout_repair_open_per_ledger',
    ]) {
      expect(sql).toContain(name);
    }
    expect(sql).toContain("WHERE status = 'proposed'");
    expect(sql).toContain("confirmed_by <> proposed_by");
  });

  it('the runtime DDL is idempotent and cannot fail on a second boot', () => {
    const source = read('src/db/index.ts');
    const start = source.indexOf('CREATE TABLE IF NOT EXISTS payout_repair_requests');
    expect(start).toBeGreaterThan(-1);
    const region = source.slice(start, source.indexOf('];', start));
    expect(region).toContain('CREATE TABLE IF NOT EXISTS payout_repair_requests');
    expect(region).toContain('CREATE INDEX IF NOT EXISTS idx_payout_repair_requests_ledger');
    expect(region).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_repair_open_per_ledger');
    // Every ADD CONSTRAINT is preceded by a DROP ... IF EXISTS for the same name.
    const adds = [...region.matchAll(/ADD CONSTRAINT (\w+)/g)].map((m) => m[1]);
    expect(adds.length).toBeGreaterThan(0);
    for (const name of adds) {
      expect(region).toContain(`DROP CONSTRAINT IF EXISTS ${name}`);
    }
    // No destructive DDL of any kind.
    expect(region).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
  });

  it('the only operation the schema permits is the one the policy produces', () => {
    for (const file of ['src/db/schema.ts', 'sql/schema.sql', 'src/config/payoutRepairPolicy.ts']) {
      const text = read(file);
      expect(text).toContain("release_rejected_leg");
      expect(text).not.toMatch(/release_anything|mark_eligible|force_submit/);
    }
  });
});

describe('the repository write convention — Drizzle only, no raw ledger SQL', () => {
  /** Remove comment-only lines so prose ABOUT a forbidden statement is not a hit. */
  const stripComments = (text: string) =>
    text
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      })
      .join('\n');

  it('no source file issues a raw UPDATE/INSERT/DELETE against the ledger', () => {
    const offenders: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) {
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      if (/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+ledger\b/i.test(text)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the repair writes go through the schema-typed table, not through SQL text', () => {
    const source = stripComments(read('src/db/database.ts'));
    expect(source).toContain('payoutRepairRequestsTable');
    expect(source).toContain('.insert(payoutRepairRequestsTable)');
    expect(source).toContain('.update(payoutRepairRequestsTable)');
    expect(source).toContain('.update(ledgerTable)');
    // No raw-SQL mutation of the ledger is ever embedded in a template string.
    expect(source).not.toMatch(/sql`\s*(UPDATE|INSERT|DELETE)/i);
    expect(source).not.toMatch(/`\s*(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+ledger/i);
  });
});
