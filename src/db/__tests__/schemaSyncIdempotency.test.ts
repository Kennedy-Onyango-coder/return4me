import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ensureSchemaUpToDate } from '../index.ts';

// =============================================================================
// SCHEMA-SYNC IDEMPOTENCY — CUSTOMER NOTIFICATION PREFERENCE CONSTRAINTS.
//
// THE PRODUCTION DEFECT THIS FILE PINS, verbatim from the Render startup log:
//
//   [SCHEMA SYNC] Failed to run: ALTER TABLE customer_notification_prefs ADD
//     CONSTRAINT customer_notification_prefs_channel_check CHECK (channel IN
//     ('sms', 'email', 'in_app'))
//   error: constraint "customer_notification_prefs_channel_check" for relation
//     "customer_notification_prefs" already exists
//   [SCHEMA SYNC] 2 of 171 migration statement(s) failed.
//   Refusing to start in production with an unverified schema.
//
// WHY IT HAPPENED: sql/schema.sql declares these two predicates as UNNAMED
// inline column CHECKs. Postgres names an unnamed inline column CHECK
// "<table>_<column>_check" — precisely the two names the incremental migration
// list then tried to ADD. Because ensureSchemaUpToDate() itself runs
// sql/schema.sql when no base schema exists, the constraint was already present
// on the FIRST boot, the bare ADD CONSTRAINT aborted, and the production
// fail-closed guard refused to start. It is the same class of defect already
// documented for items_status_check in src/db/index.ts.
//
// WHAT THIS SUITE ASSERTS:
//   1. the general invariant — every ADD CONSTRAINT in the migration list is
//      preceded by a matching DROP CONSTRAINT IF EXISTS. Postgres has no
//      "ADD CONSTRAINT IF NOT EXISTS", so paired DROP-then-ADD is what makes
//      each statement safely re-runnable, and these two were the only ADDs in
//      the list missing their DROP;
//   2. the re-asserted predicate still equals sql/schema.sql's, so the DDL
//      cannot silently diverge from the bootstrap file the migration mirrors;
//   3. behaviourally, that BOTH database states complete with ZERO failed
//      statements — a fresh database (the bootstrap creates the constraint
//      first), a database that already carries it, and a legacy database whose
//      preferences table predates the constraint;
//   4. that the production fail-closed guarantee is still in force: a genuine
//      failure still throws in production.
//
// Static inspection is used where noted, for the same reason
// migrationOrder.test.ts uses it: these are properties of the schema DEFINITION
// across the three representations, and running real DDL needs live PostgreSQL.
// =============================================================================

const dbDir = path.resolve(__dirname, '..');
const indexTs = fs.readFileSync(path.join(dbDir, 'index.ts'), 'utf8');
const schemaTs = fs.readFileSync(path.join(dbDir, 'schema.ts'), 'utf8');
const schemaSql = fs.readFileSync(path.resolve(dbDir, '../../sql/schema.sql'), 'utf8');

/** Collapses all whitespace so SQL can be compared across formatting. */
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The backtick-quoted SQL literals of the `statements` array, in execution
 * order, with comments removed and whitespace collapsed. Comments are removed
 * BEFORE the literals are collected so a comment that mentions a statement can
 * never be read as one (the same trap migrationOrder.test.ts documents).
 */
function migrationStatements(): string[] {
  const startMarker = 'export async function ensureSchemaUpToDate';
  const startIdx = indexTs.indexOf(startMarker);
  if (startIdx === -1) throw new Error('Could not find ensureSchemaUpToDate in src/db/index.ts');
  const arrayStart = indexTs.indexOf('const statements = [', startIdx);
  if (arrayStart === -1) throw new Error('Could not find the statements array');
  const arrayEnd = indexTs.indexOf('\n  ];', arrayStart);
  if (arrayEnd === -1) throw new Error('Could not find the end of the statements array');

  const body = indexTs.slice(arrayStart, arrayEnd).replace(/\r\n/g, '\n');
  const withoutComments = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  const literals: string[] = [];
  const literalRegex = /`([^`]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = literalRegex.exec(withoutComments)) !== null) {
    literals.push(collapse(match[1]));
  }
  if (literals.length === 0) throw new Error('Found no SQL literals in the statements array');
  return literals;
}

const TABLE = 'customer_notification_prefs';
const CHANNEL_CONSTRAINT = 'customer_notification_prefs_channel_check';
const CATEGORY_CONSTRAINT = 'customer_notification_prefs_category_check';
const BOTH_CONSTRAINTS = [CHANNEL_CONSTRAINT, CATEGORY_CONSTRAINT];

describe('every constraint re-assertion in the migration list is idempotent', () => {
  const statements = migrationStatements();

  it('found the statements to check (sanity check the parser works)', () => {
    expect(statements.length).toBeGreaterThan(100);
    expect(statements.some((s) => s.startsWith(`ALTER TABLE ${TABLE} ADD CONSTRAINT`))).toBe(true);
  });

  // Postgres does not support "ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS".
  // The ONLY way a constraint ADD can be safely re-run is the repository's
  // established DROP-IF-EXISTS-then-ADD pattern, whose whole purpose is to stay
  // idempotent on a database that already has the constraint. A bare ADD is
  // therefore always a latent startup failure; this test catches the entire
  // class, not just the two statements that actually broke in production.
  it('precedes every ALTER TABLE ... ADD CONSTRAINT with a DROP CONSTRAINT IF EXISTS of the same name', () => {
    const adds = statements.filter((s) => /^ALTER TABLE \w+ ADD CONSTRAINT \w+/.test(s));

    expect(adds.length).toBeGreaterThan(0);
    for (const s of adds) {
      const parsed = /^ALTER TABLE (\w+) ADD CONSTRAINT (\w+)/.exec(s);
      if (!parsed) throw new Error(`unparseable ADD CONSTRAINT statement: ${s}`);
      const [, table, name] = parsed;
      const expectedDrop = `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`;
      const index = statements.indexOf(s);
      expect(
        statements[index - 1],
        `the statement before "${s}" must be "${expectedDrop}" so the ADD is idempotent`
      ).toBe(expectedDrop);
    }
  });

  it('drops and re-adds the two notification-preference constraints in that order', () => {
    for (const name of BOTH_CONSTRAINTS) {
      const dropIdx = statements.indexOf(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${name}`);
      const addIdx = statements.findIndex((s) => s.startsWith(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${name} `));
      expect(dropIdx, `DROP for ${name} must be present`).toBeGreaterThanOrEqual(0);
      expect(addIdx, `ADD for ${name} must be present`).toBeGreaterThanOrEqual(0);
      expect(addIdx).toBe(dropIdx + 1);
    }
  });
});

describe('the re-asserted predicates stay in lockstep with sql/schema.sql', () => {
  const statements = migrationStatements();

  // The segment of sql/schema.sql that creates the table, up to the unique
  // index that follows it: this is where Postgres derives the two names from.
  const bootstrapBlock = collapse(
    schemaSql.slice(
      schemaSql.indexOf('CREATE TABLE customer_notification_prefs ('),
      schemaSql.indexOf('CREATE UNIQUE INDEX uq_customer_notification_pref')
    )
  );

  const channelPredicate = bootstrapBlock.match(/CHECK \(channel IN \([^)]*\)\)/)?.[0];
  const categoryPredicate = bootstrapBlock.match(/CHECK \(category IN \([^)]*\)\)/)?.[0];

  it('sql/schema.sql declares them as UNNAMED inline column CHECKs', () => {
    // UNNAMED means no CONSTRAINT keyword, and column-level means written
    // directly after the column definition. That is what makes Postgres pick
    // the "<table>_<column>_check" name the migration list then re-asserts.
    expect(bootstrapBlock).toContain('channel VARCHAR(20) NOT NULL CHECK (channel IN');
    expect(bootstrapBlock).toContain('category VARCHAR(40) NOT NULL CHECK (category IN');
    expect(bootstrapBlock).not.toContain(`CONSTRAINT ${CHANNEL_CONSTRAINT}`);
    expect(bootstrapBlock).not.toContain(`CONSTRAINT ${CATEGORY_CONSTRAINT}`);
  });

  it('the names the migration list adds are exactly the names Postgres derives', () => {
    for (const [constraintName, predicate] of [
      [CHANNEL_CONSTRAINT, channelPredicate],
      [CATEGORY_CONSTRAINT, categoryPredicate],
    ] as const) {
      expect(predicate, 'the bootstrap predicate must be findable').toBeDefined();
      const column = /CHECK \((\w+) IN/.exec(predicate!)?.[1];
      expect(column, 'the constrained column must be parseable').toBeDefined();
      expect(constraintName).toBe(`${TABLE}_${column}_check`);
    }
  });

  it('the ADDs re-assert the identical predicate text sql/schema.sql declares', () => {
    for (const [constraintName, predicate] of [
      [CHANNEL_CONSTRAINT, channelPredicate],
      [CATEGORY_CONSTRAINT, categoryPredicate],
    ] as const) {
      const add = statements.find((s) => s.startsWith(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${constraintName} `));
      expect(add, `the ADD for ${constraintName} must be present`).toBeDefined();
      // Compared from "CHECK (" onward, so the statement's prefix is irrelevant.
      expect(collapse(add!.slice(add!.indexOf('CHECK (')))).toBe(collapse(predicate!));
    }
  });

  it('the Drizzle schema declares the same two constraint names', () => {
    // The third representation. A rename in one and not the others is exactly
    // the drift the schema-sync rule forbids.
    expect(schemaTs).toContain(`"${CHANNEL_CONSTRAINT}"`);
    expect(schemaTs).toContain(`"${CATEGORY_CONSTRAINT}"`);
  });
});

/**
 * A deliberately small PostgreSQL stand-in.
 *
 * It models ONLY the semantics this defect depends on: a constraint that
 * already exists rejects ADD CONSTRAINT with the error Postgres raises, and
 * DROP CONSTRAINT IF EXISTS is a no-op when the constraint is absent. Table
 * existence is not modelled — in the real production database every table the
 * statements target already exists, and this fake's job is to reproduce the
 * constraint-name collision, not the whole server.
 */
class FakePgPool {
  readonly constraints = new Map<string, Set<string>>();
  /** Simulates an unrelated, genuine failure (e.g. a CHECK violated by a row). */
  failOn: RegExp | null = null;
  private baseSchemaExists: boolean;

  constructor(options: { constraints?: Record<string, string[]>; baseSchemaExists?: boolean } = {}) {
    this.baseSchemaExists = options.baseSchemaExists ?? true;
    for (const [table, names] of Object.entries(options.constraints ?? {})) {
      this.constraints.set(table, new Set(names));
    }
  }

  constraintsFor(table: string): string[] {
    return [...(this.constraints.get(table) ?? new Set<string>())].sort();
  }

  async connect() {
    return { release: () => {} };
  }

  async query(sql: string): Promise<{ rows: unknown[] }> {
    if (this.failOn && this.failOn.test(sql)) {
      throw new Error('simulated genuine failure: check constraint is violated by some row');
    }

    if (sql.includes('information_schema.tables')) {
      return { rows: [{ exists: this.baseSchemaExists }] };
    }

    // The bootstrap branch: ensureSchemaUpToDate() runs the WHOLE of
    // sql/schema.sql. Its "(no IF NOT EXISTS)" form is what distinguishes it
    // from the migration list's CREATE TABLE IF NOT EXISTS literal. Its one
    // effect this defect depends on is that Postgres materialises the unnamed
    // inline column CHECKs under their derived names.
    if (/CREATE TABLE customer_notification_prefs \(/.test(sql)) {
      this.baseSchemaExists = true;
      const set = this.constraints.get(TABLE) ?? new Set<string>();
      for (const name of BOTH_CONSTRAINTS) set.add(name);
      this.constraints.set(TABLE, set);
      return { rows: [] };
    }

    const add = /^\s*ALTER TABLE\s+(\w+)\s+ADD CONSTRAINT\s+(\w+)/i.exec(sql);
    if (add) {
      const [, table, name] = add;
      const set = this.constraints.get(table) ?? new Set<string>();
      if (set.has(name)) {
        throw new Error(`constraint "${name}" for relation "${table}" already exists`);
      }
      set.add(name);
      this.constraints.set(table, set);
      return { rows: [] };
    }

    const drop = /^\s*ALTER TABLE\s+(\w+)\s+DROP CONSTRAINT IF EXISTS\s+(\w+)/i.exec(sql);
    if (drop) {
      this.constraints.get(drop[1])?.delete(drop[2]);
      return { rows: [] };
    }

    return { rows: [] };
  }
}

const TEST_DATABASE_URL = 'postgresql://r4m_schema_sync_test:pw@127.0.0.1:5432/r4m_schema_sync_test';
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  vi.restoreAllMocks();
});

/**
 * Runs the real ensureSchemaUpToDate() against the fake and returns every
 * statement that reported "[SCHEMA SYNC] Failed to run" — the exact signal the
 * production log carried.
 */
async function runSchemaSync(pool: FakePgPool): Promise<string[]> {
  // A real-looking URL, so the placeholder guard does not short-circuit the
  // sync before it has run a single statement.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const failures: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
    if (text.includes('[SCHEMA SYNC] Failed to run')) failures.push(text);
  });
  try {
    await ensureSchemaUpToDate(pool as unknown as Parameters<typeof ensureSchemaUpToDate>[0]);
  } finally {
    spy.mockRestore();
  }
  return failures;
}

describe('startup schema sync completes on every database state', () => {
  it('a FRESH database completes: the bootstrap creates the constraint, the re-assertion replaces it', async () => {
    const pool = new FakePgPool({ baseSchemaExists: false });
    const failures = await runSchemaSync(pool);
    expect(failures).toEqual([]);
    expect(pool.constraintsFor(TABLE)).toEqual([...BOTH_CONSTRAINTS].sort());
  });

  it('a database that ALREADY has both constraints (the production state) completes with zero failures', async () => {
    const pool = new FakePgPool({ constraints: { [TABLE]: [...BOTH_CONSTRAINTS] } });
    const failures = await runSchemaSync(pool);
    // This assertion reproduces the Render failure: before the fix, both ADDs
    // raised "already exists" and landed in this array.
    expect(failures).toEqual([]);
    expect(pool.constraintsFor(TABLE)).toEqual([...BOTH_CONSTRAINTS].sort());
  });

  it('a legacy database whose preferences table predates the constraints ends up with both of them', async () => {
    const pool = new FakePgPool({ constraints: { [TABLE]: [] } });
    const failures = await runSchemaSync(pool);
    expect(failures).toEqual([]);
    expect(pool.constraintsFor(TABLE)).toEqual([...BOTH_CONSTRAINTS].sort());
  });

  it('booting twice is a no-op: the second run adds nothing and fails nothing', async () => {
    const pool = new FakePgPool({ baseSchemaExists: false });
    expect(await runSchemaSync(pool)).toEqual([]);
    const afterFirstBoot = pool.constraintsFor(TABLE);
    expect(await runSchemaSync(pool)).toEqual([]);
    expect(pool.constraintsFor(TABLE)).toEqual(afterFirstBoot);
  });
});

describe('the production fail-closed guarantee is untouched', () => {
  it('still refuses to start when a statement genuinely fails', async () => {
    const pool = new FakePgPool({ constraints: { [TABLE]: [...BOTH_CONSTRAINTS] } });
    // A failure idempotency is NOT supposed to paper over.
    pool.failOn = /ALTER TABLE customer_sessions ADD CONSTRAINT/;

    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        ensureSchemaUpToDate(pool as unknown as Parameters<typeof ensureSchemaUpToDate>[0])
      ).rejects.toThrow(/Refusing to start in production with an unverified schema/);
    } finally {
      errorSpy.mockRestore();
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('keeps the failure counter and the production throw in the source', () => {
    expect(indexTs).toContain('migrationFailureCount++');
    expect(indexTs).toContain("if (process.env.NODE_ENV === 'production') {");
    expect(indexTs).toContain('Refusing to start in production with an unverified schema.');
  });
});
