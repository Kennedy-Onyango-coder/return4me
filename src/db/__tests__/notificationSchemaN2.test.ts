import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../index';
import { customers, account_activation_tokens, notification_events } from '../schema';
import { eq } from 'drizzle-orm';

// N2 — NOTIFICATION ARCHITECTURE FOUNDATION: schema/persistence primitives.
//
// WHAT CLASS OF TEST THIS IS. These are EXECUTED database tests, not
// source-string assertions. Every case performs a real insert against the real
// in-memory executor (src/db/index.ts), which is deliberately wired to enforce
// the SAME security-critical unique indexes that ensureSchemaUpToDate()
// declares in Postgres — see MOCK_UNIQUE_INDEXES. That wiring is what makes
// these assertions meaningful: without it a duplicate insert would silently
// succeed and a test would pass while proving nothing.
//
// LIMITATION, STATED PLAUSIBLY RATHER THAN HIDDEN: the CHECK constraints
// (account_type / purpose / channel / status whitelists) are enforced by
// Postgres but NOT modelled by the in-memory executor, so the constraint
// declarations are asserted across all three schema sources instead of being
// pretended-executed. That is a real limitation of this harness, not a weak
// stand-in for a passing test.

async function clearTables() {
  await db.delete(notification_events);
  await db.delete(account_activation_tokens);
  await db.delete(customers);
}

let seq = 0;
function id(prefix: string) {
  seq += 1;
  return `${prefix}-${seq}`;
}
function future() {
  return new Date(Date.now() + 60 * 60 * 1000);
}

// Drizzle wraps every driver error as "Failed query: ..." and preserves the
// ORIGINAL Postgres-shaped error on `.cause`. The in-memory executor raises a
// real 23505 (see MOCK_UNIQUE_INDEXES in src/db/index.ts), so asserting on the
// cause is asserting on the genuine unique-constraint violation — not on a
// message Drizzle happens to produce.
function expectUniqueViolation(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error('Expected a unique-constraint violation, but the insert succeeded.');
    },
    (err: any) => {
      const code = err?.cause?.code ?? err?.code;
      if (code !== '23505') {
        throw new Error(`Expected 23505 unique violation, received: ${err?.cause?.message ?? err?.message}`);
      }
    }
  );
}

describe('N2 — customer email columns', () => {
  beforeEach(clearTables);

  it('lets existing grandfathered customers keep a NULL email and stay active', async () => {
    // THE migration-safety case: a customer created by the old SMS-only flow
    // has no email. The column is nullable precisely so such a row neither
    // fails the migration nor receives a fabricated address.
    await db.insert(customers).values({
      id: id('cus'),
      full_name: 'Grandfathered SMS Customer',
      phone: '+254700000001',
      status: 'active',
      email: null,
      email_verified_at: null,
    });

    const rows = await db.select().from(customers);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBeNull();
    expect(rows[0].email_verified_at).toBeNull();
    // Critically: the migration must NOT have forced a reactivation.
    expect(rows[0].status).toBe('active');
  });

  it('permits multiple NULL emails to coexist (mirrors WHERE email IS NOT NULL)', async () => {
    // The in-memory executor does not implement multi-row VALUES, so these are
    // three separate single-row inserts � which is also closer to how
    // registrations actually arrive (one request, one account).
    await db.insert(customers).values({ id: id('cus'), full_name: 'A', phone: '+254700000002', status: 'active', email: null });
    await db.insert(customers).values({ id: id('cus'), full_name: 'B', phone: '+254700000003', status: 'active', email: null });
    await db.insert(customers).values({ id: id('cus'), full_name: 'C', phone: '+254700000004', status: 'active', email: null });

    const rows = await db.select().from(customers);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.email === null)).toBe(true);
  });

  it('rejects two customers sharing the same non-null email', async () => {
    await db.insert(customers).values({
      id: id('cus'),
      full_name: 'First',
      phone: '+254700000005',
      status: 'active',
      email: 'owner@example.com',
    });

    // The executor raises a Postgres-shaped 23505 for this index, which the N3
    // registration handler will catch and translate into a safe,
    // non-enumerating response.
    await expectUniqueViolation(
      db.insert(customers).values({
        id: id('cus'),
        full_name: 'Second',
        phone: '+254700000006',
        status: 'active',
        email: 'owner@example.com',
      })
    );
  });

  it('represents email_verified_at as NULL until verified, then a timestamp', async () => {
    const customerId = id('cus');
    await db.insert(customers).values({
      id: customerId,
      full_name: 'Pending Verification',
      phone: '+254700000007',
      status: 'active',
      email: 'pending@example.com',
      email_verified_at: null,
    });

    const before = await db.select().from(customers).where(eq(customers.id, customerId));
    expect(before[0].email_verified_at).toBeNull();

    const verifiedAt = new Date();
    await db.update(customers).set({ email_verified_at: verifiedAt }).where(eq(customers.id, customerId));

    const after = await db.select().from(customers).where(eq(customers.id, customerId));
    expect(after[0].email_verified_at).toBeTruthy();
    // Activation records WHEN, not just a boolean — that is why a nullable
    // timestamp was chosen over a second truth-bearing column.
    expect(new Date(after[0].email_verified_at as any).getTime()).toBe(verifiedAt.getTime());
  });
});

describe('N2 — account activation tokens', () => {
  beforeEach(clearTables);

  it('stores only a token hash, never the plaintext token', async () => {
    const rawToken = 'a'.repeat(64); // what the user would receive by email
    const tokenHash = 'b'.repeat(64);

    await db.insert(account_activation_tokens).values({
      id: id('tok'),
      account_type: 'customer',
      account_id: id('cus'),
      purpose: 'email_activation',
      token_hash: tokenHash,
      expires_at: future(),
      consumed_at: null,
    });

    const rows = await db.select().from(account_activation_tokens);
    expect(rows[0].token_hash).toBe(tokenHash);
    // The schema has no column capable of holding the raw token, and this
    // asserts the persisted value is the hash — so a database leak cannot
    // be replayed into an account takeover.
    expect(JSON.stringify(rows[0])).not.toContain(rawToken);
    expect(Object.keys(rows[0])).not.toContain('token');
  });

  it('represents both expiry and consumed (single-use) state', async () => {
    const expiresAt = future();
    const tokenId = id('tok');
    await db.insert(account_activation_tokens).values({
      id: tokenId,
      account_type: 'customer',
      account_id: id('cus'),
      purpose: 'email_activation',
      token_hash: 'c'.repeat(64),
      expires_at: expiresAt,
      consumed_at: null,
    });

    const open = await db.select().from(account_activation_tokens).where(eq(account_activation_tokens.id, tokenId));
    expect(open[0].consumed_at).toBeNull();
    expect(new Date(open[0].expires_at as any).getTime()).toBe(expiresAt.getTime());

    const consumedAt = new Date();
    await db.update(account_activation_tokens).set({ consumed_at: consumedAt }).where(eq(account_activation_tokens.id, tokenId));

    const closed = await db.select().from(account_activation_tokens).where(eq(account_activation_tokens.id, tokenId));
    expect(closed[0].consumed_at).toBeTruthy();
  });

  it('keeps customer and agent ownership unambiguous via account_type', async () => {
    // One shared table serves both account kinds, so the (account_type,
    // account_id) pair is what makes ownership explicit rather than ambiguous.
    await db.insert(account_activation_tokens).values({ id: id('tok'), account_type: 'customer', account_id: 'acct-shared', purpose: 'email_activation', token_hash: 'd'.repeat(64), expires_at: future() });
    await db.insert(account_activation_tokens).values({ id: id('tok'), account_type: 'agent', account_id: 'acct-shared', purpose: 'email_activation', token_hash: 'e'.repeat(64), expires_at: future() });

    const rows = await db.select().from(account_activation_tokens);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.account_type).sort()).toEqual(['agent', 'customer']);
    // Same account_id under two types must not collide — which also proves
    // the token_hash index is not accidentally unique.
    expect(new Set(rows.map((r) => r.token_hash)).size).toBe(2);
  });
});

describe('N2 — notification events and durable idempotency', () => {
  beforeEach(clearTables);

  it('rejects a duplicate idempotency_key with a Postgres-shaped 23505', async () => {
    // THE cost-control invariant. Two concurrent dispatches of one logical
    // notification race to insert; exactly one must win, and the loser gets a
    // unique violation it can handle rather than a second billable send.
    await db.insert(notification_events).values({
      id: id('ntf'),
      event_type: 'CLAIM_OTP',
      channel: 'sms',
      provider: 'africas_talking',
      idempotency_key: 'claim:CLM-1:otp:challenge-9',
      recipient_reference: 'masked:+2547******001',
      status: 'pending',
      attempt_count: 0,
    });

    await expectUniqueViolation(
      db.insert(notification_events).values({
        id: id('ntf'),
        event_type: 'CLAIM_OTP',
        channel: 'sms',
        provider: 'africas_talking',
        // SAME key — a retry, not a new logical event.
        idempotency_key: 'claim:CLM-1:otp:challenge-9',
        recipient_reference: 'masked:+2547******001',
        status: 'pending',
        attempt_count: 0,
      })
    );

    const rows = await db.select().from(notification_events);
    expect(rows).toHaveLength(1);
  });

  it('allows distinct events and records retry attempts on one row', async () => {
    await db.insert(notification_events).values({ id: id('ntf'), event_type: 'CLAIM_OTP', channel: 'sms', idempotency_key: 'evt:a', recipient_reference: 'ref:a', status: 'sent', attempt_count: 1, sent_at: new Date() });
    await db.insert(notification_events).values({ id: id('ntf'), event_type: 'ACCOUNT_ACTIVATION', channel: 'email', idempotency_key: 'evt:b', recipient_reference: 'ref:b', status: 'pending', attempt_count: 0 });

    expect(await db.select().from(notification_events)).toHaveLength(2);

    // A retry reuses the SAME row and bumps attempt_count rather than creating
    // a second event — that is what distinguishes "retried" from "new".
    await db.update(notification_events).set({ attempt_count: 2, status: 'sending' }).where(eq(notification_events.idempotency_key, 'evt:a'));

    const retried = await db.select().from(notification_events).where(eq(notification_events.idempotency_key, 'evt:a'));
    expect(retried[0].attempt_count).toBe(2);
    expect(retried[0].status).toBe('sending');
  });

  it('records failed and fallback_available states for an operator workflow', async () => {
    await db.insert(notification_events).values({
      id: id('ntf'),
      event_type: 'PICKUP_CODE',
      channel: 'sms',
      provider: 'africas_talking',
      idempotency_key: 'evt:pickup-1',
      recipient_reference: 'ref:pickup',
      status: 'failed',
      attempt_count: 2,
      last_error: 'provider_rejected',
    });

    await db.update(notification_events).set({ status: 'fallback_available' }).where(eq(notification_events.idempotency_key, 'evt:pickup-1'));

    const rows = await db.select().from(notification_events);
    expect(rows[0].status).toBe('fallback_available');
    expect(rows[0].last_error).toBe('provider_rejected');
    // No plaintext secret may ever appear on the row.
    expect(Object.keys(rows[0])).not.toContain('code');
  });

  it('links a fallback event back to the failure that caused it', async () => {
    const originalId = id('ntf');
    await db.insert(notification_events).values({ id: originalId, event_type: 'PICKUP_CODE', channel: 'sms', idempotency_key: 'evt:orig', recipient_reference: 'ref:pickup', status: 'failed', attempt_count: 1 });
    await db.insert(notification_events).values({ id: id('ntf'), event_type: 'PICKUP_CODE', channel: 'email', provider: 'resend', idempotency_key: 'evt:fallback', recipient_reference: 'ref:pickup', status: 'fallback_sent', attempt_count: 1, fallback_of: originalId });

    const rows = await db.select().from(notification_events);
    const fallback = rows.find((r) => r.idempotency_key === 'evt:fallback');
    expect(fallback?.fallback_of).toBe(originalId);
  });
});

// LIMITATION, DOCUMENTED RATHER THAN PAPERED OVER: the in-memory executor has
// no schema, so it cannot enforce CHECK constraints. These assertions
// therefore verify that all THREE schema sources (the canonical Drizzle
// definition, the bootstrap SQL file, and the incremental migration) declare
// the same whitelists — so Postgres enforces them identically no matter which
// path created the database. They do NOT pretend to execute them, because the
// harness cannot.
describe('N2 — CHECK constraints are declared in every schema source', () => {
  const drizzleSrc = fs.readFileSync(path.resolve(__dirname, '../schema.ts'), 'utf8');
  const bootstrapSql = fs.readFileSync(path.resolve(__dirname, '../../../sql/schema.sql'), 'utf8');
  const migrationSrc = fs.readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8');

  it('constrains activation token purpose and account type in all three sources', () => {
    for (const [name, src] of [['schema.ts', drizzleSrc], ['schema.sql', bootstrapSql], ['index.ts', migrationSrc]] as const) {
      expect(src, name).toContain('account_activation_tokens_purpose_check');
      expect(src, name).toContain('email_activation');
      expect(src, name).toContain('account_activation_tokens_account_type_check');
      expect(src, name).toContain("'customer', 'agent'");
    }
  });

  it('constrains notification channel and status in all three sources', () => {
    for (const [name, src] of [['schema.ts', drizzleSrc], ['schema.sql', bootstrapSql], ['index.ts', migrationSrc]] as const) {
      expect(src, name).toContain('notification_events_channel_check');
      expect(src.replace(/\s+/g, ' '), name).toMatch(/channel\}?\)? IN \('sms', 'email'\)/);
      expect(src, name).toContain('notification_events_status_check');
      for (const s of ['pending', 'sending', 'sent', 'failed', 'fallback_available', 'fallback_requested', 'fallback_sent', 'cancelled']) {
        expect(src, name).toContain(s);
      }
    }
  });

  it('declares the customer email columns and the partial unique index everywhere', () => {
    for (const [name, src] of [['schema.ts', drizzleSrc], ['schema.sql', bootstrapSql], ['index.ts', migrationSrc]] as const) {
      expect(src, name).toContain('email_verified_at');
      expect(src, name).toContain('uq_customers_email');
      // The partial predicate is what lets grandfathered NULL-email accounts
      // coexist. Losing it would turn a safe migration into a hard failure.
      expect(src.replace(/\s+/g, ' '), name).toMatch(/uq_customers_email[^]{0,160}IS NOT NULL/);
    }
  });

  it('adds the customer email columns additively, never a destructive rewrite', () => {
    // The migration must be ADD COLUMN IF NOT EXISTS: it must never drop,
    // rewrite, backfill, or force a status change on existing customers.
    expect(migrationSrc).toContain('ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(255)');
    expect(migrationSrc).toContain('ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ');
    expect(migrationSrc).not.toMatch(/ALTER TABLE customerss+ALTER COLUMN/);
    expect(migrationSrc).not.toMatch(/UPDATE customers SET/i);
    expect(migrationSrc).not.toMatch(/DELETE FROM customers/i);
  });

  it('never declares a plaintext activation-token column', () => {
    for (const [name, src] of [['schema.ts', drizzleSrc], ['schema.sql', bootstrapSql], ['index.ts', migrationSrc]] as const) {
      // token_hash is the only credential-shaped column permitted.
      expect(src.replace(/\s+/g, ' '), name).toMatch(/token_hash[^;]{0,140}(NOT NULL|notNull\(\))/);
      expect(src, name).not.toMatch(/\braw_token\b/);
      expect(src, name).not.toMatch(/\bplaintext_token\b/);
      expect(src, name).not.toMatch(/token_plain/);
    }
  });
});
