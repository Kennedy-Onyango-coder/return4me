import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

// =============================================================================
// BATCH 1B (B) — THE PROVIDER-BATCH INDEX IS ONE IDENTICAL INDEX IN ALL THREE
// SCHEMA SOURCES, AND IT SITS ON THE COLUMN THE LOOKUP ACTUALLY FILTERS BY.
//
// WHY THIS FILE EXISTS. getPayoutLegsByProviderBatchId() (src/db/database.ts)
// runs on every provider payout status event and resolves a tracking id back to
// this application's payout legs by filtering ledger rows on provider_batch_id.
// Three separate places can bring the ledger table into existence:
//
//   * sql/schema.sql    — the bootstrap script a FRESH database runs;
//   * src/db/schema.ts  — the Drizzle definition (drizzle-kit, typed reads);
//   * src/db/index.ts   — ensureSchemaUpToDate(), the incremental path an
//                         ALREADY-RUNNING database takes on boot.
//
// If any one of them declares the index differently — another name, another
// column, no partial predicate, or a non-idempotent bare CREATE INDEX — then
// some database is left without the access path reconciliation depends on, and
// nothing fails loudly: the lookup merely degrades into a sequential scan of the
// whole ledger. No behavioural test can catch that, because the in-memory
// executor (src/db/index.ts) does not model indexes at all. A green query test
// therefore proves the FILTER is right, never that the INDEX exists.
//
// WHAT CLASS OF ASSERTION THIS IS, STATED PLAINLY. These are STATIC
// source-inspection assertions over the three schema representations, for the
// same reason migrationOrder.test.ts and schemaSyncIdempotency.test.ts use them:
// asserting on a real physical index needs live PostgreSQL, which this harness
// does not have. The limitation is explicit rather than hidden — this pins the
// DECLARATION (the part that can drift), not the planner's use of it. The one
// connection to real behaviour is textual and deliberately narrow: the indexed
// column must be the same column the lookup's WHERE clause filters on.
// =============================================================================

const dbDir = path.resolve(__dirname, '..');
const indexTs = fs.readFileSync(path.join(dbDir, 'index.ts'), 'utf8');
const schemaTs = fs.readFileSync(path.join(dbDir, 'schema.ts'), 'utf8');
const databaseTs = fs.readFileSync(path.join(dbDir, 'database.ts'), 'utf8');
const schemaSql = fs.readFileSync(path.resolve(dbDir, '../../sql/schema.sql'), 'utf8');

const INDEX_NAME = 'idx_ledger_provider_batch_id';
const INDEXED_COLUMN = 'provider_batch_id';

/** Collapses all whitespace so SQL/TS can be compared across formatting. */
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The one accepted DDL text, whitespace-normalised. `IF NOT EXISTS` is part of
 * it on purpose: Postgres has no "CREATE INDEX IF NOT EXISTS" fallback, so a bare
 * CREATE INDEX makes the second boot (or a second run of the bootstrap script)
 * abort — exactly the class of defect schemaSyncIdempotency.test.ts documents for
 * ADD CONSTRAINT.
 */
const EXPECTED_DDL = `CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON ledger(${INDEXED_COLUMN}) WHERE ${INDEXED_COLUMN} IS NOT NULL`;

/** The Drizzle shape, whitespace-normalised the same way. */
const EXPECTED_DRIZZLE = `${INDEX_NAME}: index("${INDEX_NAME}") .on(table.${INDEXED_COLUMN}) .where(sql\`\${table.${INDEXED_COLUMN}} IS NOT NULL\`)`;

const sources = [
  ['schema.sql', schemaSql],
  ['schema.ts', schemaTs],
  ['index.ts', indexTs],
] as const;

describe('BATCH 1B (B) — provider-batch index parity across the three schema sources', () => {
  it('declares the index in every source that can create the ledger table', () => {
    for (const [name, src] of sources) {
      expect(src, `${name} must declare ${INDEX_NAME}`).toContain(INDEX_NAME);
    }
  });

  it('declares byte-identical DDL on both executable paths — same name, column and predicate', () => {
    // schema.sql formats the statement across two lines; index.ts holds it as a
    // single backtick literal. Collapsing whitespace is what makes the two
    // comparable, so formatting drift alone can never be mistaken for a real
    // difference — and a real difference can never hide behind formatting.
    expect(collapse(schemaSql), 'sql/schema.sql bootstrap').toContain(EXPECTED_DDL);
    expect(collapse(indexTs), 'src/db/index.ts migration list').toContain(EXPECTED_DDL);
  });

  it('declares the identical index in Drizzle — same name, column and partial predicate', () => {
    const normalized = collapse(schemaTs);
    expect(normalized, 'src/db/schema.ts Drizzle index').toContain(EXPECTED_DRIZZLE);
    // ...and the predicate is genuinely PARTIAL: the predicate column is the
    // batch id itself, so rows that were never submitted (NULL) stay out.
    expect(normalized).toContain(`.where(sql\`\${table.${INDEXED_COLUMN}} IS NOT NULL\`)`);
  });

  it('is re-runnable on both executable paths and has no bare-CREATE slip-through', () => {
    // The bare form must not exist anywhere for this index: it would abort the
    // second execution, which is the exact failure mode IF NOT EXISTS prevents.
    const bareIndex = new RegExp(`CREATE INDEX (?!IF NOT EXISTS) ${INDEX_NAME}`);
    expect(collapse(schemaSql)).not.toMatch(bareIndex);
    expect(collapse(indexTs)).not.toMatch(bareIndex);
  });

  it('creates the column before the index that depends on it in the incremental path', () => {
    // ensureSchemaUpToDate() is an ORDERED list. An index in front of the column
    // it references cannot be created at all, so ordering is a correctness
    // requirement here, not a stylistic one.
    const columnAt = indexTs.indexOf('ALTER TABLE ledger ADD COLUMN IF NOT EXISTS provider_batch_id');
    const indexAt = indexTs.indexOf(`CREATE INDEX IF NOT EXISTS ${INDEX_NAME}`);
    expect(columnAt, 'the provider_batch_id column must be added by the migration list').toBeGreaterThanOrEqual(0);
    expect(indexAt, 'the index must be created by the migration list').toBeGreaterThanOrEqual(0);
    expect(indexAt, 'the index must come AFTER the column it indexes').toBeGreaterThan(columnAt);
  });

  it('indexes exactly the column getPayoutLegsByProviderBatchId filters on', () => {
    // The reconciliation lookup filters with
    // .where(and(eq(ledgerTable.provider_batch_id, trimmed), inArray(type, ...))).
    const lookup = databaseTs.match(/getPayoutLegsByProviderBatchId[\s\S]*?eq\(ledgerTable\.(\w+),/);
    expect(lookup, 'the lookup must still filter ledger rows by a column').not.toBeNull();
    const filteredColumn = lookup![1];
    expect(filteredColumn, 'the lookup filters on the batch id').toBe(INDEXED_COLUMN);

    // Both executable DDL paths must index that same column — an index on some
    // other column is an index this lookup cannot use.
    expect(schemaSql).toContain(`ON ledger(${filteredColumn})`);
    expect(indexTs).toContain(`ON ledger(${filteredColumn})`);
  });
});
