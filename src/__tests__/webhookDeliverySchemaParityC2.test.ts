import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  WEBHOOK_DELIVERY_EVENT_CATEGORIES,
  WEBHOOK_DELIVERY_OPEN_STATUSES,
  WEBHOOK_DELIVERY_PROVIDERS,
  WEBHOOK_DELIVERY_STATUSES,
} from '../config/webhookDeliveries';

// =============================================================================
// GATE C / STAGE C2 — THE DURABLE DELIVERY TABLE'S DECLARATIONS MUST AGREE
// =============================================================================
// `intasend_webhook_deliveries` is declared four times, for four different
// readers:
//
//   sql/schema.sql   the migration-style declaration a human reviews and a DBA
//                    applies;
//   src/db/index.ts  the idempotent runtime DDL ensureSchemaUpToDate() runs, which
//                    is what actually creates the table in a running process;
//   src/db/schema.ts the Drizzle table the read/write methods compile against;
//   src/db/index.ts  the in-memory test double's mock state (MOCK_STATE).
//
// Nothing in the type system ties them together, and the earlier payout-repair
// drift (a 22-vs-23-vs-24 column report) is the precedent: a column added to one
// declaration and forgotten in another type-checks perfectly, passes unit tests
// against the double, and fails only against a real Postgres.
//
// This file therefore compares the actual ORDERED COLUMN LISTS and the actual
// CHECK vocabularies, rather than asserting that a name appears "somewhere".
// =============================================================================

const ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const TABLE = 'intasend_webhook_deliveries';

interface ColumnShape {
  name: string;
  type: 'varchar' | 'integer' | 'boolean' | 'timestamp';
  notNull: boolean;
}

/**
 * The expected shape, written out here on purpose.
 *
 * An expectation derived from one of the files under test would agree with that
 * file by construction and prove nothing — exactly the failure mode this suite
 * exists to prevent. This list is the specification; the declarations must match
 * it.
 */
const EXPECTED_COLUMNS: ColumnShape[] = [
  { name: 'id', type: 'varchar', notNull: true },
  { name: 'provider', type: 'varchar', notNull: true },
  { name: 'event_topic', type: 'varchar', notNull: false },
  { name: 'event_category', type: 'varchar', notNull: true },
  // NULL, not FALSE: "no challenge was configured, so nothing was checked" is a
  // different fact from "a challenge was checked and failed".
  { name: 'authenticated', type: 'boolean', notNull: false },
  { name: 'status', type: 'varchar', notNull: true },
  { name: 'outcome_code', type: 'varchar', notNull: false },
  { name: 'retryable', type: 'boolean', notNull: false },
  { name: 'http_status', type: 'integer', notNull: false },
  { name: 'claim_id', type: 'varchar', notNull: false },
  { name: 'payment_session_id', type: 'varchar', notNull: false },
  { name: 'provider_invoice_id', type: 'varchar', notNull: false },
  { name: 'provider_reference', type: 'varchar', notNull: false },
  { name: 'payload_fingerprint', type: 'varchar', notNull: false },
  { name: 'diagnostic', type: 'varchar', notNull: false },
  { name: 'received_at', type: 'timestamp', notNull: true },
  { name: 'processed_at', type: 'timestamp', notNull: false },
];

const CONSTRAINT_NAMES = [
  'intasend_webhook_deliveries_provider_check',
  'intasend_webhook_deliveries_event_category_check',
  'intasend_webhook_deliveries_status_check',
  'intasend_webhook_deliveries_processed_shape_check',
];

const INDEX_NAMES = [
  'idx_intasend_webhook_deliveries_received',
  'idx_intasend_webhook_deliveries_status',
  'idx_intasend_webhook_deliveries_claim',
  'idx_intasend_webhook_deliveries_session',
  'idx_intasend_webhook_deliveries_invoice',
  'idx_intasend_webhook_deliveries_fingerprint',
];

/** `name TYPE [NOT NULL] [DEFAULT …]` lines from a CREATE TABLE body. */
function parseSqlColumns(body: string): ColumnShape[] {
  const columns: ColumnShape[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/,$/, '');
    if (!line || line.startsWith('--') || /^CONSTRAINT\b/i.test(line)) continue;
    const match = line.match(/^([a-z_][a-z0-9_]*)\s+(.+)$/i);
    if (!match) continue;
    const [, name, rest] = match;
    const type: ColumnShape['type'] | null = /^VARCHAR\(/i.test(rest)
      ? 'varchar'
      : /^INTEGER\b/i.test(rest)
        ? 'integer'
        : /^BOOLEAN\b/i.test(rest)
          ? 'boolean'
          : /^TIMESTAMP\b/i.test(rest)
            ? 'timestamp'
            : null;
    if (!type) continue;
    columns.push({
      name,
      type,
      notNull: /\bNOT NULL\b/i.test(rest) || /\bPRIMARY KEY\b/i.test(rest),
    });
  }
  return columns;
}

/** The CREATE TABLE body from sql/schema.sql. */
function sqlTableBody(): string {
  const source = read('sql/schema.sql');
  const start = source.indexOf(`CREATE TABLE ${TABLE} (`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n);', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The CREATE TABLE body from the runtime DDL in src/db/index.ts. */
function runtimeTableBody(): string {
  const source = read('src/db/index.ts');
  const start = source.indexOf(`CREATE TABLE IF NOT EXISTS ${TABLE} (`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(')`,', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The Drizzle table definition block from src/db/schema.ts. */
function drizzleTableBody(): string {
  const source = read('src/db/schema.ts');
  const start = source.indexOf(`export const ${TABLE} = pgTable(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n);', source.indexOf('(table) =>', start));
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** `column: type("column") …` declarations from a Drizzle table block. */
function parseDrizzleColumns(block: string): ColumnShape[] {
  const columns: ColumnShape[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^([a-z_][a-z0-9_]*):\s*(varchar|integer|boolean|timestamp)\("/i);
    if (!match) continue;
    const [, name, type] = match;
    columns.push({
      name,
      type: type.toLowerCase() as ColumnShape['type'],
      notNull: /\.notNull\(\)/.test(line) || /\.primaryKey\(\)/.test(line),
    });
  }
  return columns;
}

/** One named CONSTRAINT's text from sql/schema.sql. */
function sqlConstraintClause(constraint: string): string {
  const source = read('sql/schema.sql');
  const start = source.indexOf(`CONSTRAINT ${constraint}`);
  expect(start).toBeGreaterThan(-1);
  const candidates = [source.indexOf('\n    CONSTRAINT ', start + 1), source.indexOf('\n);', start)]
    .filter((index) => index > start);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

/** The quoted literals of every `IN (…)` list inside one named constraint. */
function sqlCheckLiterals(constraint: string): string[] {
  const clause = sqlConstraintClause(constraint);
  const values = new Set<string>();
  for (const group of clause.match(/IN \([^)]*\)/g) ?? []) {
    for (const literal of group.match(/'[^']*'/g) ?? []) values.add(literal.slice(1, -1));
  }
  return [...values];
}

describe('C2 — the delivery table is declared identically everywhere', () => {
  it('sql/schema.sql declares every expected column, in order, with the right nullability', () => {
    expect(parseSqlColumns(sqlTableBody())).toEqual(EXPECTED_COLUMNS);
  });

  it('the runtime DDL declares every expected column, in order, with the right nullability', () => {
    expect(parseSqlColumns(runtimeTableBody())).toEqual(EXPECTED_COLUMNS);
  });

  it('the Drizzle table declares every expected column, in order, with the right nullability', () => {
    expect(parseDrizzleColumns(drizzleTableBody())).toEqual(EXPECTED_COLUMNS);
  });

  it('the in-memory test double has an explicit (empty) state entry for the table', () => {
    // Listed explicitly so the double's SHAPE is visible in source: rows are
    // inserted on arrival and updated only while still open, and nothing deletes
    // them. An implicit entry would appear on the first insert and hide that.
    expect(read('src/db/index.ts')).toContain(`${TABLE}: [],`);
  });

  it('the test double enforces NO uniqueness on this table, because duplicates are recordable', () => {
    const source = read('src/db/index.ts');
    const start = source.indexOf('const MOCK_UNIQUE_INDEXES');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n};', start);
    expect(end).toBeGreaterThan(start);
    // Repeated deliveries of one logical event are a FACT this stage must be able
    // to record; a unique constraint (on the fingerprint or anything else) would
    // make the second attempt unrecordable — and the fingerprint is explicitly a
    // correlation aid, never an identity.
    expect(source.slice(start, end)).not.toContain(TABLE);
  });

  it('declares no UNIQUE constraint and no foreign key on this table', () => {
    // No FKs by design: an unknown claim id, session id or invoice must still be
    // recordable, because an unrecognised delivery is exactly the case an operator
    // needs to see. A callback must never be refused storage for naming a row the
    // delivery exists to explain the absence of.
    //
    // Comments are stripped first: the schema documents its deliberately absent
    // constraints in prose ("NEVER unique, never an identity"), and a naive
    // substring check would match the explanation instead of the declaration.
    const sql = sqlTableBody()
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .toUpperCase();
    expect(sql).not.toContain('UNIQUE');
    expect(sql).not.toContain('REFERENCES');
    expect(sql).not.toContain('FOREIGN KEY');
    const drizzle = drizzleTableBody();
    expect(drizzle).not.toContain('.references(');
    expect(drizzle).not.toContain('unique(');
  });

  it('declares every CHECK constraint in all three executable declarations', () => {
    for (const name of CONSTRAINT_NAMES) {
      expect(sqlTableBody()).toContain(name);
      expect(read('src/db/index.ts')).toContain(name);
      expect(read('src/db/schema.ts')).toContain(name);
    }
  });

  it('declares every index in all three declarations', () => {
    const sql = read('sql/schema.sql');
    const runtime = read('src/db/index.ts');
    const drizzle = read('src/db/schema.ts');
    for (const name of INDEX_NAMES) {
      expect(sql).toContain(`CREATE INDEX ${name}`);
      expect(runtime).toContain(`CREATE INDEX IF NOT EXISTS ${name}`);
      expect(drizzle).toContain(name);
    }
  });
});

describe('C2 — the SQL CHECK vocabularies are the config module’s vocabularies', () => {
  // A CHECK that drifted from src/config/webhookDeliveries.ts would be worse than
  // no CHECK at all: the writer (which validates against the module) would accept
  // a status Postgres then rejects, turning a diagnostic write into an error.
  it('the provider CHECK matches WEBHOOK_DELIVERY_PROVIDERS', () => {
    expect(sqlCheckLiterals(`${TABLE}_provider_check`).sort()).toEqual(
      [...WEBHOOK_DELIVERY_PROVIDERS].sort(),
    );
  });

  it('the event-category CHECK matches WEBHOOK_DELIVERY_EVENT_CATEGORIES', () => {
    expect(sqlCheckLiterals(`${TABLE}_event_category_check`).sort()).toEqual(
      [...WEBHOOK_DELIVERY_EVENT_CATEGORIES].sort(),
    );
  });

  it('the status CHECK matches WEBHOOK_DELIVERY_STATUSES', () => {
    expect(sqlCheckLiterals(`${TABLE}_status_check`).sort()).toEqual(
      [...WEBHOOK_DELIVERY_STATUSES].sort(),
    );
  });

  it('the processed-shape CHECK uses exactly the OPEN statuses for the unprocessed branch', () => {
    // THE invariant that makes `http_status` mean "the code the provider actually
    // received": an open row carries no processed_at and no status code; a settled
    // row carries both. If this list drifted, an open row could claim a code it
    // never sent — the precise confusion this table exists to end.
    expect(sqlCheckLiterals(`${TABLE}_processed_shape_check`).sort()).toEqual(
      [...WEBHOOK_DELIVERY_OPEN_STATUSES].sort(),
    );
  });

  it('the runtime DDL builds its CHECKs from the same exported vocabularies', () => {
    // The runtime DDL interpolates the module's SQL_LIST constants, so it cannot
    // drift silently — assert the interpolation is actually there rather than a
    // hard-coded list that merely looks right today.
    const runtime = read('src/db/index.ts');
    expect(runtime).toContain('${WEBHOOK_DELIVERY_PROVIDER_SQL_LIST}');
    expect(runtime).toContain('${WEBHOOK_DELIVERY_EVENT_CATEGORY_SQL_LIST}');
    expect(runtime).toContain('${WEBHOOK_DELIVERY_STATUS_SQL_LIST}');
    expect(runtime).toContain('${WEBHOOK_DELIVERY_OPEN_STATUS_SQL_LIST}');
  });
});
