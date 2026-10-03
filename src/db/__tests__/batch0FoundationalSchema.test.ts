import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// BATCH 0 - FOUNDATIONAL SCHEMA PRIMITIVES (A1, E1, H9/H10, B12/B13)
//
// Asserts DATA-MODEL foundations only, and deliberately asserts NO business
// behaviour, because Batch 0 introduces none: everything added here is
// additive and unread by application logic.
//
//   1. The three schema representations stay IN LOCKSTEP: schema.ts (Drizzle),
//      sql/schema.sql (bootstrap), ensureSchemaUpToDate() in index.ts
//      (incremental upgrade). A column in only some of them means a database
//      created by one path differs from one upgraded by another.
//   2. Nothing Batch 0 added can destroy or fabricate history: strikes are not
//      decremented, notification expiry is independent of retry scheduling,
//      and every new column is nullable so no existing row is rewritten.
//
// Static inspection is correct here for the same reason migrationOrder.test.ts
// uses it: these are properties of the schema DEFINITION across three files,
// and several cannot be exercised without live PostgreSQL.

const dbDir = path.resolve(__dirname, '..');
const schemaTs = fs.readFileSync(path.join(dbDir, 'schema.ts'), 'utf8');
const schemaSql = fs.readFileSync(path.resolve(dbDir, '../../sql/schema.sql'), 'utf8');
const indexTs = fs.readFileSync(path.join(dbDir, 'index.ts'), 'utf8');

function tableBlock(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} = pgTable`);
  if (start === -1) throw new Error(`table not found in schema.ts: ${name}`);
  const next = source.indexOf('export const ', start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

function sqlTableBlock(name: string): string {
  const start = schemaSql.indexOf(`CREATE TABLE ${name} (`);
  if (start === -1) throw new Error(`table not found in sql/schema.sql: ${name}`);
  const end = schemaSql.indexOf('\n);', start);
  return schemaSql.slice(start, end === -1 ? undefined : end);
}

function migrationStatements(): string[] {
  const start = indexTs.indexOf('const statements = [');
  if (start === -1) throw new Error('could not find the statement list in index.ts');
  const end = indexTs.indexOf('\n  ];', start);
  return indexTs.slice(start, end === -1 ? undefined : end).split('\n');
}

const statements = migrationStatements();
const statementsText = statements.join('\n');

describe('A1 individual payment-strike records', () => {
  it('declares a normalized per-strike table in the Drizzle schema', () => {
    const block = tableBlock(schemaTs, 'claim_payment_strike_records');
    // One row per strike, so phone_number is NOT the primary key.
    expect(block).toMatch(/phone_number: varchar\("phone_number", \{ length: 15 \}\)\.notNull\(\)/);
    expect(block).toMatch(/created_at: timestamp\("created_at", \{ withTimezone: true \}\)\.defaultNow\(\)\.notNull\(\)/);
    expect(block).toMatch(/expires_at: timestamp\("expires_at", \{ withTimezone: true \}\)/);
    expect(block).toMatch(/is_cleared_by_admin: boolean\("is_cleared_by_admin"\)\.default\(false\)\.notNull\(\)/);
  });

  it('keeps the AGGREGATE table intact and gives it no expiry column', () => {
    const start = schemaTs.indexOf('export const claim_payment_strikes = pgTable');
    expect(start).toBeGreaterThan(-1);
    // Slice to the table's own closing `});` — NOT to the next `export const`,
    // because the long explanatory comment for claim_payment_strike_records sits
    // between the two and legitimately mentions `expires_at`. Using the next
    // export would sweep that comment into "the aggregate table" and fail.
    const end = schemaTs.indexOf('});', start);
    expect(end).toBeGreaterThan(start);
    const block = schemaTs.slice(start, end);
    expect(block).toMatch(/phone_number: varchar\("phone_number", \{ length: 15 \}\)\.primaryKey\(\)/);
    expect(block).toMatch(/strike_count: integer\("strike_count"\)\.default\(0\)\.notNull\(\)/);
    expect(block).toMatch(/last_strike_at: timestamp\("last_strike_at", \{ withTimezone: true \}\)/);
    expect(block).toMatch(/is_cleared_by_admin: boolean\("is_cleared_by_admin"\)\.default\(false\)\.notNull\(\)/);
    // Per-strike expiry lives in the records table; an expires_at here would
    // invite a decrement, which would destroy the audit history.
    expect(block).not.toMatch(/expires_at/);
  });

  it('preserves per-strike administrator-clearing attribution', () => {
    const block = tableBlock(schemaTs, 'claim_payment_strike_records');
    expect(block).toMatch(/cleared_at: timestamp\("cleared_at", \{ withTimezone: true \}\)/);
    expect(block).toMatch(/cleared_by_admin: varchar\("cleared_by_admin", \{ length: 100 \}\)/);
    // Provenance nullable: a sweep that raced another instance may not resolve one.
    expect(block).toMatch(/source_claim_id: varchar\("source_claim_id", \{ length: 50 \}\)/);
  });

  it('exists in ALL THREE schema representations', () => {
    expect(schemaTs).toContain('claim_payment_strike_records');
    expect(schemaSql).toContain('CREATE TABLE claim_payment_strike_records');
    expect(statementsText).toContain('CREATE TABLE IF NOT EXISTS claim_payment_strike_records');
  });

  it('indexes the phone and the expiry for a future active-strike count', () => {
    expect(schemaTs).toMatch(/idx_claim_strike_records_phone.*\.on\(table\.phone_number\)/s);
    expect(schemaTs).toMatch(/idx_claim_strike_records_expires.*\.on\(table\.expires_at\)/s);
    expect(schemaSql).toContain('idx_claim_strike_records_phone');
    expect(statementsText).toContain('idx_claim_strike_records_phone');
    expect(statementsText).toContain('idx_claim_strike_records_expires');
  });

  it('performs NO backfill and never rewrites the historical aggregate', () => {
    // Load-bearing: a backfill would have to invent per-strike timestamps the
    // aggregate never stored.
    expect(statementsText).not.toMatch(/INSERT\s+INTO\s+claim_payment_strike_records/i);
    expect(statementsText).not.toMatch(/UPDATE\s+claim_payment_strikes\s+SET\s+strike_count\s*=/i);
  });

  it('the >=3 gate uses the AUTHORITATIVE active-strike helper', () => {
    // Batch 0 shipped the schema and deliberately left the gate on the raw
    // aggregate. Batch 0A (A1) changed that: the gate now reads
    // getActivePaymentStrikeCount(), which counts only strikes inside their
    // 5-day window. Asserting the RAW aggregate here would pin the superseded
    // Batch 0 contract, under which a strike never expired.
    const claimsTs = fs.readFileSync(path.resolve(dbDir, '../routes/claims.ts'), 'utf8');
    const gate = claimsTs.slice(claimsTs.indexOf('const strikeCount'));
    expect(gate).toMatch(/getActivePaymentStrikeCount\(ownerPhone\)/);
    // The raw aggregate is still reported elsewhere, but must not gate claims.
    expect(gate).not.toMatch(/getPaymentStrikeCount\(ownerPhone\)/);
  });

  it('A1 freezes a legacy baseline so legacy strikes cannot be double-counted', () => {
    // strike_count and last_strike_at are both overwritten by every new strike,
    // so neither can distinguish pre- from post-migration strikes. These two
    // columns are the write-once snapshot that makes the additive count correct.
    expect(schemaTs).toMatch(/legacy_strike_count: integer\("legacy_strike_count"\)/);
    expect(schemaTs).toMatch(/legacy_last_strike_at: timestamp\("legacy_last_strike_at"/);
    expect(schemaSql).toMatch(/legacy_strike_count INTEGER/);
    expect(statementsText).toContain('ALTER TABLE claim_payment_strikes ADD COLUMN IF NOT EXISTS legacy_strike_count INTEGER');
    expect(statementsText).toContain('ALTER TABLE claim_payment_strikes ADD COLUMN IF NOT EXISTS legacy_last_strike_at TIMESTAMPTZ');
    // Additive only: no backfill of the legacy baseline is permitted.
    expect(statementsText).not.toMatch(/UPDATE\s+claim_payment_strikes\s+SET\s+legacy_strike_count/i);
  });
});

describe('E1 notification active expiry', () => {
  it('adds expires_at to notification_events in the Drizzle schema', () => {
    const block = tableBlock(schemaTs, 'notification_events');
    expect(block).toMatch(/expires_at: timestamp\("expires_at", \{ withTimezone: true \}\)/);
  });

  it('is a DISTINCT column from next_attempt_at (retry scheduling)', () => {
    const block = tableBlock(schemaTs, 'notification_events');
    // Both exist as separate columns. Collapsing them would couple user-visible
    // expiry to delivery-retry mechanics, the specific conflation forbidden.
    expect(block).toMatch(/next_attempt_at: timestamp\("next_attempt_at"/);
    expect(block.indexOf('next_attempt_at:')).toBeGreaterThan(-1);
    expect(block.indexOf('expires_at:')).toBeGreaterThan(-1);
    expect(block.indexOf('next_attempt_at:')).not.toBe(block.indexOf('expires_at:'));
  });

  it('leaves existing rows NULL rather than inferring a 5-day lookback', () => {
    const block = tableBlock(schemaTs, 'notification_events');
    expect(block).not.toMatch(/expires_at: timestamp\("expires_at", \{ withTimezone: true \}\)\.default/);
    expect(statementsText).toContain('ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
    expect(statementsText).not.toMatch(/ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS expires_at[^;]*DEFAULT/i);
  });

  it('exists in ALL THREE schema representations', () => {
    expect(schemaSql).toMatch(/CREATE TABLE notification_events[\s\S]*?expires_at TIMESTAMP WITH TIME ZONE/);
    expect(statementsText).toContain('ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
  });

  it('does NOT alter any existing N9 retry column or constraint', () => {
    // Batch 0 must not disturb completed N9 work. Scoped to the BATCH 0
    // statements only: the pre-existing migration legitimately contains its own
    // DROP/ADD re-assertion of notification_events_status_check (from when N9
    // widened that vocabulary), and asserting globally would flag that older,
    // correct work as a Batch 0 regression.
    const batch0 = statementsText.slice(
      statementsText.indexOf('CREATE TABLE IF NOT EXISTS claim_payment_strike_records')
    );
    expect(batch0).not.toMatch(/ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS retry_attempt_count/i);
    expect(batch0).not.toMatch(/DROP CONSTRAINT[^;]*notification_events_status_check/i);
    expect(batch0).not.toMatch(/DROP CONSTRAINT[^;]*notification_events_channel_check/i);
    expect(batch0).not.toMatch(/UPDATE\s+notification_events/i);
    expect(batch0).not.toMatch(/DELETE\s+FROM\s+notification_events/i);
    // The one and only notification_events statement Batch 0 may add.
    const notifStatements = batch0.split('\n').filter(l => l.includes('notification_events') && l.includes('ALTER TABLE'));
    expect(notifStatements).toHaveLength(1);
    expect(notifStatements[0]).toContain('expires_at');
  });
});

describe('H9/H10 customer session device and activity context', () => {
  it('adds user_agent and keeps the pre-existing activity/revocation columns', () => {
    const block = tableBlock(schemaTs, 'customer_sessions');
    expect(block).toMatch(/user_agent: varchar\("user_agent", \{ length: 512 \}\)/);
    // These already existed and are the real H9/H10 foundation. Batch 0 must
    // not remove or repurpose them.
    expect(block).toMatch(/last_seen_at: timestamp\("last_seen_at", \{ withTimezone: true \}\)/);
    expect(block).toMatch(/revoked_at: timestamp\("revoked_at", \{ withTimezone: true \}\)/);
  });

  it('keeps hashed-token storage and absolute expiry intact', () => {
    const block = tableBlock(schemaTs, 'customer_sessions');
    // Only the hash is persisted; the raw token must never gain a column.
    expect(block).toMatch(/token_hash: varchar\("token_hash", \{ length: 64 \}\)\.notNull\(\)/);
    expect(block).not.toMatch(/raw_token/);
    expect(block).toMatch(/expires_at: timestamp\("expires_at", \{ withTimezone: true \}\)\.notNull\(\)/);
  });

  it('stores NO IP address and reserves no column for one', () => {
    // Rate-limit identities are salted hashes specifically so a table does not
    // become a record of who connected from where. Session rows follow suit.
    const block = tableBlock(schemaTs, 'customer_sessions');
    expect(block).not.toMatch(/ip_address|remote_addr/i);
    expect(sqlTableBlock('customer_sessions')).not.toMatch(/ip_address|remote_addr/i);
  });

  it('bounds user_agent length in both SQL and runtime representations', () => {
    expect(schemaSql).toMatch(/user_agent VARCHAR\(512\)/);
    expect(schemaSql).toMatch(/customer_sessions_user_agent_len/);
    expect(statementsText).toContain('ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS user_agent VARCHAR(512)');
    expect(statementsText).toContain('customer_sessions_user_agent_len');
  });

  it('indexes (customer_id, last_seen_at) for inactivity and revoke-all', () => {
    expect(schemaTs).toMatch(/idx_customer_sessions_activity.*\.on\(table\.customer_id, table\.last_seen_at\)/s);
    expect(statementsText).toContain('idx_customer_sessions_activity');
  });

  it('never deletes a session row to revoke it', () => {
    // Revocation sets revoked_at so the audit trail survives.
    expect(statementsText).not.toMatch(/DELETE\s+FROM\s+customer_sessions/i);
  });
});


describe('B12 lost-report withdrawal foundation', () => {
  it('adds timestamp/actor/reason fields, not a deleted flag', () => {
    const block = tableBlock(schemaTs, 'lost_reports');
    expect(block).toMatch(/withdrawn_at: timestamp\("withdrawn_at", \{ withTimezone: true \}\)/);
    expect(block).toMatch(/withdrawn_by: varchar\("withdrawn_by", \{ length: 100 \}\)/);
    expect(block).toMatch(/withdrawal_reason: text\("withdrawal_reason"\)/);
    // B12 requires the report to SURVIVE. A deleted/removed flag would imply
    // erasure and would be the wrong primitive.
    expect(block).not.toMatch(/\bis_deleted\b|\bdeleted_at\b|\bremoved_at\b/);
  });

  it('leaves every new field nullable so historical reports stay valid', () => {
    const block = tableBlock(schemaTs, 'lost_reports');
    expect(block).not.toMatch(/withdrawn_at: timestamp\("withdrawn_at", \{ withTimezone: true \}\)\.notNull/);
    expect(block).not.toMatch(/withdrawn_by: varchar\("withdrawn_by", \{ length: 100 \}\)\.notNull/);
  });

  it('exists in ALL THREE schema representations', () => {
    expect(schemaSql).toMatch(/CREATE TABLE lost_reports[\s\S]*?withdrawn_at TIMESTAMP WITH TIME ZONE/);
    expect(statementsText).toContain('ALTER TABLE lost_reports ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ');
    expect(statementsText).toContain('ALTER TABLE lost_reports ADD COLUMN IF NOT EXISTS withdrawal_reason TEXT');
  });

  it('does NOT widen the existing closed status vocabulary', () => {
    // 'cancelled' already exists. Batch 0 adds no new lifecycle value.
    expect(statementsText).toMatch(/lost_reports_status_check CHECK \(status IN \('active', 'match_review', 'resolved', 'cancelled', 'lapsed'\)\)/);
  });

  it('does not delete or rewrite any existing lost report', () => {
    expect(statementsText).not.toMatch(/DELETE\s+FROM\s+lost_reports/i);
    expect(statementsText).not.toMatch(/UPDATE\s+lost_reports\s+SET/i);
  });
});

describe('B13 found-item withdrawal foundation', () => {
  it('adds timestamp/actor/reason fields to items, not a deleted flag', () => {
    const block = tableBlock(schemaTs, 'items');
    expect(block).toMatch(/withdrawn_at: timestamp\("withdrawn_at", \{ withTimezone: true \}\)/);
    expect(block).toMatch(/withdrawn_by: varchar\("withdrawn_by", \{ length: 100 \}\)/);
    expect(block).toMatch(/withdrawal_reason: text\("withdrawal_reason"\)/);
    expect(block).not.toMatch(/\bis_deleted\b|\bdeleted_at\b/);
  });

  it('does NOT add a new items.status value or widen items_status_check', () => {
    // items.status is a custody vocabulary whose every value means something
    // specific. B13's withdrawal cases map onto different existing statuses or
    // an admin/agent decision, so the constraint must be untouched here.
    // Scoped to the ADD CONSTRAINT statement itself: a bare substring search
    // spanning from that line would run on until it hit the Batch 0 comment
    // that legitimately contains the word "withdrawn".
    const addConstraint = statementsText.split('\n').find(l => l.includes('ADD CONSTRAINT items_status_check'));
    expect(addConstraint).toBeDefined();
    expect(addConstraint).not.toContain('withdrawn');
  });

  it('exists in ALL THREE schema representations', () => {
    expect(schemaSql).toMatch(/CREATE TABLE items[\s\S]*?withdrawn_at TIMESTAMP WITH TIME ZONE/);
    expect(statementsText).toContain('ALTER TABLE items ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ');
    expect(statementsText).toContain('ALTER TABLE items ADD COLUMN IF NOT EXISTS withdrawal_reason TEXT');
  });

  it('preserves the Finder/Agent verification split', () => {
    // Batch 0 must not disturb the invariant that verified_* fields sit
    // alongside, and never replace, the Finder's original submission.
    const block = tableBlock(schemaTs, 'items');
    expect(block).toMatch(/verified_name: varchar\("verified_name"/);
    expect(block).toMatch(/verification_status: varchar\("verification_status"/);
    expect(block).toMatch(/ocr_extracted_name: varchar\("ocr_extracted_name"/);
  });
});


describe('Batch 0 migration safety (cross-cutting)', () => {
  it('adds every new column idempotently with IF NOT EXISTS', () => {
    const newColumns = [
      'ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS expires_at',
      'ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS user_agent',
      'ALTER TABLE lost_reports ADD COLUMN IF NOT EXISTS withdrawn_at',
      'ALTER TABLE lost_reports ADD COLUMN IF NOT EXISTS withdrawn_by',
      'ALTER TABLE lost_reports ADD COLUMN IF NOT EXISTS withdrawal_reason',
      'ALTER TABLE items ADD COLUMN IF NOT EXISTS withdrawn_at',
      'ALTER TABLE items ADD COLUMN IF NOT EXISTS withdrawn_by',
      'ALTER TABLE items ADD COLUMN IF NOT EXISTS withdrawal_reason',
    ];
    for (const c of newColumns) expect(statementsText).toContain(c);
    // The one new table must also be idempotent.
    expect(statementsText).toContain('CREATE TABLE IF NOT EXISTS claim_payment_strike_records');
  });

  it('introduces NO destructive statement anywhere in the batch', () => {
    // Every Batch 0 statement must be additive, or a guarded DROP of a
    // constraint this same batch re-adds. Nothing may drop a column or table.
    const batch0 = statementsText.slice(
      statementsText.indexOf('CREATE TABLE IF NOT EXISTS claim_payment_strike_records')
    );
    expect(batch0).not.toMatch(/DROP\s+COLUMN/i);
    expect(batch0).not.toMatch(/DROP\s+TABLE/i);
    expect(batch0).not.toMatch(/\bTRUNCATE\b/i);
    // The only DROP permitted is the constraint re-assertion pattern, and each
    // such constraint must be re-added within the same batch.
    const drops = [...batch0.matchAll(/DROP CONSTRAINT IF EXISTS\s+(\w+)/g)].map(m => m[1]);
    for (const name of drops) expect(batch0).toContain(`ADD CONSTRAINT ${name}`);
  });

  it('creates each new table BEFORE any statement that targets it', () => {
    // Same class of ordering bug migrationOrder.test.ts guards for.
    const created = new Set<string>();
    for (const raw of statements) {
      const line = raw.trim();
      if (!line) continue;
      const create = line.match(/^CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
      if (create) { created.add(create[1].toLowerCase()); continue; }
      const alter = line.match(/^ALTER TABLE\s+(\w+)/i);
      if (alter) {
        expect(created.has(alter[1].toLowerCase()),
          `CREATE TABLE for ${alter[1]} must precede its ALTERs`).toBe(true);
      }
    }
  });

  it('keeps every new column out of the payment/claim financial truth', () => {
    // claims.paid_at is the authoritative financial fact and must not gain
    // nullable lifecycle columns in this batch.
    const claims = tableBlock(schemaTs, 'claims');
    expect(claims).toMatch(/paid_at/);
    expect(claims).not.toMatch(/withdrawn_at|withdrawal_reason/);
  });
});

