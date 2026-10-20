import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// =============================================================================
// IN-MEMORY QUERY DOUBLE — PARENTHESISED / QUOTED WHERE CLAUSES.
// =============================================================================
// Regression suite for splitOnTopLevel() in src/db/index.ts.
//
// The double used to split OR (and then AND) with a bare /\s+or\s+/i, which
// ignores both SQL precedence and parentheses. Given
//
//   flag_a = true AND (flag_b = true OR flag_c = true)
//
// it produced a trailing fragment `flag_c = true)` that no predicate branch
// recognised. That branch falls through to the function's default `return
// true`, so `.some()` reported a match for EVERY row — one guarded UPDATE
// (the payout activation CAS) activated the whole table and made a later
// `status IN (...)` filter legitimately return nothing.
//
// These tests drive the REAL boundary (`pool.query`, exported from
// src/db/index.ts) rather than calling the private helper, so they pin the
// behaviour the rest of the suite depends on: the mock must evaluate a WHERE
// clause the way Postgres would, including precedence, nested groups and
// string literals that merely CONTAIN "and" / "or".
//
// DATABASE_URL is forced empty before the module is imported, exactly as
// src/db/__tests__/index.test.ts does, so this file can never touch a real
// Postgres even on a developer machine with a populated .env.
// =============================================================================

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const TABLE = 'mock_where_nesting_probe';

type Pool = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };
let pool: Pool;

interface Fixture {
  id: string;
  flag_a: boolean;
  flag_b: boolean;
  flag_c: boolean;
  flag_d: boolean;
  flag_e: boolean;
  label: string;
}

// Every combination of five booleans: 32 rows, so each predicate's expected
// set is computed from the fixture itself instead of being hand-listed.
const FIXTURES: Fixture[] = Array.from({ length: 32 }, (_, mask) => ({
  id: `row-${mask}`,
  flag_a: Boolean(mask & 1),
  flag_b: Boolean(mask & 2),
  flag_c: Boolean(mask & 4),
  flag_d: Boolean(mask & 8),
  flag_e: Boolean(mask & 16),
  label: `plain-${mask}`,
}));
// Two fixtures whose label contains the SQL keywords. A splitter that ignores
// quoting tears these values apart and (because the tail is unrecognised)
// matches every row.
const QUOTED_LABEL = 'salt and pepper OR sugar';
const SECOND_QUOTED_LABEL = 'rock AND roll';
FIXTURES[0].label = QUOTED_LABEL;
FIXTURES[1].label = SECOND_QUOTED_LABEL;

beforeAll(async () => {
  process.env.DATABASE_URL = '';
  vi.resetModules();
  const mod = await import('../index');
  pool = mod.pool as Pool;

  for (const row of FIXTURES) {
    await pool.query(
      `INSERT INTO ${TABLE} (id, flag_a, flag_b, flag_c, flag_d, flag_e, label)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, row.flag_a, row.flag_b, row.flag_c, row.flag_d, row.flag_e, row.label],
    );
  }
});

afterAll(() => {
  // Restore the environment for any later import in this worker.
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  vi.resetModules();
});

async function idsWhere(where: string): Promise<string[]> {
  const result = await pool.query(`SELECT * FROM ${TABLE} WHERE ${where}`);
  return result.rows.map((row) => row.id).sort();
}

function expected(predicate: (row: Fixture) => boolean): string[] {
  return FIXTURES.filter(predicate).map((row) => row.id).sort();
}

describe('mock DB WHERE evaluation: nested parentheses', () => {
  it('evaluates A AND (B OR C): the nested OR is a group, not a top-level split', async () => {
    const actual = await idsWhere('flag_a = true AND (flag_b = true OR flag_c = true)');
    expect(actual).toEqual(expected((r) => r.flag_a && (r.flag_b || r.flag_c)));
    // The specific row the old naive split let through: A true, both nested
    // flags false. If it appears, the guard matched everything.
    expect(actual).not.toContain('row-1');
  });

  it('evaluates (A OR B) AND C with the group on the LEFT of the AND', async () => {
    const actual = await idsWhere('(flag_a = true OR flag_b = true) AND flag_c = true');
    expect(actual).toEqual(expected((r) => (r.flag_a || r.flag_b) && r.flag_c));
  });

  it('evaluates multiple nested groups: A AND ((B OR C) AND (D OR E))', async () => {
    const actual = await idsWhere(
      'flag_a = true AND ((flag_b = true OR flag_c = true) AND (flag_d = true OR flag_e = true))',
    );
    expect(actual).toEqual(
      expected((r) => r.flag_a && (r.flag_b || r.flag_c) && (r.flag_d || r.flag_e)),
    );
  });

  it('handles sibling groups ANDed together: (A OR B) AND (C OR D)', async () => {
    const actual = await idsWhere('(flag_a = true OR flag_b = true) AND (flag_c = true OR flag_d = true)');
    expect(actual).toEqual(expected((r) => (r.flag_a || r.flag_b) && (r.flag_c || r.flag_d)));
  });

  it('applies SQL precedence without parentheses: A OR B AND C means A OR (B AND C)', async () => {
    const actual = await idsWhere('flag_a = true OR flag_b = true AND flag_c = true');
    expect(actual).toEqual(expected((r) => r.flag_a || (r.flag_b && r.flag_c)));
    // A left-to-right reading would include this row; SQL must not.
    expect(actual).not.toContain('row-2');
  });

  it('handles uppercase AND / OR the same way', async () => {
    const actual = await idsWhere('flag_a = true and (flag_b = true or flag_c = true)');
    // Identifiers stay lowercase: the double reads columns by exact key, and
    // Postgres folds unquoted identifiers to lowercase too. Only the SQL
    // keywords change case here, which is what this test pins.
    const upper = await idsWhere('flag_a = true AND (flag_b = true OR flag_c = true)');
    expect(upper).toEqual(actual);
  });
});

describe('mock DB WHERE evaluation: quoted string literals', () => {
  it('does not split on "and"/"or" inside a single-quoted value', async () => {
    const actual = await idsWhere(`label = '${QUOTED_LABEL}'`);
    expect(actual).toEqual(['row-0']);
  });

  it('does not split on uppercase AND inside a quoted value', async () => {
    const actual = await idsWhere(`label = '${SECOND_QUOTED_LABEL}'`);
    expect(actual).toEqual(['row-1']);
  });

  it('combines a quoted literal with a real boolean group', async () => {
    const actual = await idsWhere(`label = '${QUOTED_LABEL}' AND flag_a = true`);
    // row-0 has flag_a false, so the group must be evaluated (and fail),
    // not skipped because the left side matched.
    expect(actual).toEqual([]);
  });
});
