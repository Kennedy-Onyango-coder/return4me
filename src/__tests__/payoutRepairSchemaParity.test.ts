import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PAYOUT_REPAIR_REQUEST_COLUMNS } from '../config/payoutRepairPolicy';

// =============================================================================
// F2 — THE THREE DECLARATIONS MUST AGREE, COLUMN BY COLUMN
// =============================================================================
// The previous parity test only asserted that a handful of constraint NAMES
// appeared somewhere in each file. That is why a 22-vs-23-vs-24 column drift in
// the REPORT survived: nothing compared the actual column lists.
//
// This test parses the ordered column definitions from:
//   * sql/schema.sql    (the migration-style declaration)
//   * src/db/index.ts   (the idempotent runtime DDL)
//   * src/db/schema.ts  (the Drizzle table)
// and compares name, type family, nullability and default family across all
// three, against ONE exported ordered list.

const ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

interface ColumnShape {
  name: string;
  type: 'varchar' | 'text' | 'timestamp';
  notNull: boolean;
  default: 'none' | "'proposed'" | 'now';
}

function normaliseDefault(raw: string | null): ColumnShape['default'] {
  if (!raw) return 'none';
  const value = raw.trim();
  if (/^'proposed'$/i.test(value)) return "'proposed'";
  if (/^(current_timestamp|now\(\)|now)$/i.test(value)) return 'now';
  throw new Error(`unrecognised SQL default: ${value}`);
}

/** Parse `name TYPE [NOT NULL] [DEFAULT ...]` lines from a CREATE TABLE body. */
function parseDdl(body: string): ColumnShape[] {
  const columns: ColumnShape[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/,$/, '');
    if (!line || line.startsWith('--') || /^CONSTRAINT\b/i.test(line)) continue;
    const match = line.match(/^([a-z_][a-z0-9_]*)\s+(.+)$/i);
    if (!match) continue;
    const [, name, rest] = match;
    const type: ColumnShape['type'] | null = /^VARCHAR\(/i.test(rest)
      ? 'varchar'
      : /^TEXT\b/i.test(rest)
        ? 'text'
        : /^TIMESTAMP\b/i.test(rest)
          ? 'timestamp'
          : null;
    if (!type) continue;
    const defaultMatch = rest.match(/\bDEFAULT\s+('proposed'|CURRENT_TIMESTAMP|NOW\(\))/i);
    columns.push({
      name,
      type,
      notNull: /\bNOT NULL\b/i.test(rest) || /\bPRIMARY KEY\b/i.test(rest),
      default: normaliseDefault(defaultMatch ? defaultMatch[1] : null),
    });
  }
  return columns;
}

function sqlDeclarations(): ColumnShape[] {
  const source = read('sql/schema.sql');
  const start = source.indexOf('CREATE TABLE payout_repair_requests (');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n);', start);
  expect(end).toBeGreaterThan(start);
  return parseDdl(source.slice(start, end));
}

function runtimeDeclarations(): ColumnShape[] {
  const source = read('src/db/index.ts');
  const start = source.indexOf('CREATE TABLE IF NOT EXISTS payout_repair_requests (');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('CREATE INDEX IF NOT EXISTS idx_payout_repair_requests_ledger', start);
  expect(end).toBeGreaterThan(start);
  return parseDdl(source.slice(start, end).replace(/`/g, ''));
}

function drizzleDeclarations(): ColumnShape[] {
  const source = read('src/db/schema.ts');
  const start = source.indexOf('export const payout_repair_requests = pgTable(');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n});', start);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);

  const starts = [...block.matchAll(/^\s{4}([a-z_][a-z0-9_]*):\s*/gm)];
  const columns: ColumnShape[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const name = starts[i][1];
    const chunkStart = starts[i].index! + starts[i][0].length;
    const chunkEnd = i + 1 < starts.length ? starts[i + 1].index! : block.length;
    const chunk = block.slice(chunkStart, chunkEnd);
    const type: ColumnShape['type'] | null = chunk.startsWith('varchar(')
      ? 'varchar'
      : chunk.startsWith('text(')
        ? 'text'
        : chunk.startsWith('timestamp(')
          ? 'timestamp'
          : null;
    if (!type) continue;
    const stringDefault = chunk.match(/\.default\("([^"]+)"\)/);
    columns.push({
      name,
      type,
      notNull: chunk.includes('.notNull()') || chunk.includes('.primaryKey()'),
      default: chunk.includes('.defaultNow()')
        ? 'now'
        : normaliseDefault(stringDefault ? `'${stringDefault[1]}'` : null),
    });
  }
  return columns;
}

describe('payout_repair_requests — column parity across all three declarations', () => {
  it('the shared ordered list has exactly 24 columns', () => {
    expect(PAYOUT_REPAIR_REQUEST_COLUMNS).toHaveLength(24);
  });

  it.each([
    ['sql/schema.sql', sqlDeclarations],
    ['src/db/index.ts', runtimeDeclarations],
    ['src/db/schema.ts', drizzleDeclarations],
  ])('%s declares exactly the shared column list, in order', (_label, parse) => {
    const columns = parse();
    expect(columns.map((c) => c.name)).toEqual([...PAYOUT_REPAIR_REQUEST_COLUMNS]);
  });

  it('type, nullability and default family are identical in all three', () => {
    const sql = sqlDeclarations();
    const runtime = runtimeDeclarations();
    const drizzle = drizzleDeclarations();
    expect(runtime).toEqual(sql);
    expect(drizzle).toEqual(sql);
  });

  it('the partial unique index is the same one-open-request rule everywhere', () => {
    const sql = read('sql/schema.sql');
    const runtime = read('src/db/index.ts');
    const schema = read('src/db/schema.ts');
    for (const source of [sql, runtime, schema]) {
      expect(source).toContain('uq_payout_repair_open_per_ledger');
    }
    expect(runtime).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_repair_open_per_ledger ON payout_repair_requests(ledger_entry_id) WHERE status = 'proposed'",
    );
    expect(sql).toContain(
      "CREATE UNIQUE INDEX uq_payout_repair_open_per_ledger ON payout_repair_requests(ledger_entry_id) WHERE status = 'proposed'",
    );
    // Drizzle expresses the same predicate with its template tag (lowercase SQL).
    expect(schema).toMatch(/\.where\(sql`\$\{table\.status\} = 'proposed'`\)/);
  });

  it('every CHECK constraint name is declared in all three sources', () => {
    const names = [
      'payout_repair_requests_status_check',
      'payout_repair_requests_operation_check',
      'payout_repair_requests_entry_type_check',
      'payout_repair_requests_operation_target_check',
      'payout_repair_requests_dual_control_check',
      'payout_repair_requests_confirmation_check',
    ];
    for (const file of ['sql/schema.sql', 'src/db/index.ts', 'src/db/schema.ts']) {
      const text = read(file);
      for (const name of names) expect(text, `${file} must declare ${name}`).toContain(name);
    }
  });
});
