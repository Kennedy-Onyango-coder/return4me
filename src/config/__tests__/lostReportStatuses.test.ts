import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  LOST_REPORT_STATUS_VALUES,
  DEFAULT_LOST_REPORT_STATUS,
  TERMINAL_LOST_REPORT_STATUSES,
  isLostReportStatus,
  LOST_REPORT_STATUS_SQL_LIST,
} from '../lostReportStatuses';
import { CLAIM_STATUS_VALUES } from '../claimStatuses';

// Phase 9A — the lost-report lifecycle vocabulary is a CLOSED, DISJOINT set.
//
// The hard requirement this file pins down: a lost-report status must never be
// confusable with a claim status or a found-item status. Checking that against
// the two real sources of truth (the claim-status export and the items CHECK
// constraint in sql/schema.sql) rather than a hand-copied list is what makes
// the assertion meaningful.

const repoRoot = path.resolve(__dirname, '../../..');
const schemaSql = fs.readFileSync(path.join(repoRoot, 'sql/schema.sql'), 'utf8');
const schemaTs = fs.readFileSync(path.join(repoRoot, 'src/db/schema.ts'), 'utf8');
const indexTs = fs.readFileSync(path.join(repoRoot, 'src/db/index.ts'), 'utf8');

/** Extracts the values from the first `CHECK (status IN (...))` after a marker. */
function extractCheckValues(sql: string, constraintMarker: string): string[] {
  const idx = sql.indexOf(constraintMarker);
  expect(idx, `marker not found: ${constraintMarker}`).toBeGreaterThan(-1);
  const afterMarker = sql.slice(idx);
  const checkMatch = afterMarker.match(/CHECK\s*\(\s*status\s+IN\s*\(([^)]+)\)\s*\)/i);
  expect(checkMatch, `no CHECK (status IN (...)) after ${constraintMarker}`).not.toBeNull();
  return checkMatch![1]
    .split(',')
    .map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''))
    .sort();
}

describe('lost-report status vocabulary is closed and lower_snake_case', () => {
  it('is exactly the five documented statuses', () => {
    expect([...LOST_REPORT_STATUS_VALUES].sort()).toEqual(
      ['active', 'cancelled', 'lapsed', 'match_review', 'resolved'].sort(),
    );
  });

  it('uses lower_snake_case, matching the repository status convention', () => {
    for (const status of LOST_REPORT_STATUS_VALUES) {
      expect(status).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  it('defaults new reports to active, and never sets match_review in this phase', () => {
    expect(DEFAULT_LOST_REPORT_STATUS).toBe('active');
    expect(LOST_REPORT_STATUS_VALUES).toContain(DEFAULT_LOST_REPORT_STATUS);
    // match_review exists for Phase 9B; nothing in 9A may produce it.
    expect(DEFAULT_LOST_REPORT_STATUS).not.toBe('match_review');
  });

  it('isLostReportStatus is a real membership test', () => {
    expect(isLostReportStatus('active')).toBe(true);
    expect(isLostReportStatus('released')).toBe(false);
    expect(isLostReportStatus('')).toBe(false);
  });

  it('terminal statuses are the closed ones, and active/match_review are not terminal', () => {
    expect([...TERMINAL_LOST_REPORT_STATUSES].sort()).toEqual(['cancelled', 'lapsed', 'resolved'].sort());
    expect(TERMINAL_LOST_REPORT_STATUSES.has('active')).toBe(false);
    expect(TERMINAL_LOST_REPORT_STATUSES.has('match_review')).toBe(false);
  });

  it('the generated SQL predicate lists exactly the vocabulary', () => {
    expect(LOST_REPORT_STATUS_SQL_LIST).toBe("'active', 'match_review', 'resolved', 'cancelled', 'lapsed'");
  });
});

describe('lost-report statuses cannot be confused with claim or item statuses', () => {
  it('is DISJOINT from the claim-status vocabulary', () => {
    const overlap = LOST_REPORT_STATUS_VALUES.filter((s) => (CLAIM_STATUS_VALUES as readonly string[]).includes(s));
    expect(overlap).toEqual([]);
  });

  it('is DISJOINT from the found-item status vocabulary', () => {
    const itemStatuses = extractCheckValues(schemaSql, 'CREATE TABLE items');
    const overlap = LOST_REPORT_STATUS_VALUES.filter((s) => itemStatuses.includes(s));
    expect(overlap).toEqual([]);
  });
});

describe('the lost-report status vocabulary has one source of truth', () => {
  it('sql/schema.sql lost_reports CHECK equals the canonical list', () => {
    expect(extractCheckValues(schemaSql, 'CREATE TABLE lost_reports'))
      .toEqual([...LOST_REPORT_STATUS_VALUES].sort());
  });

  it('src/db/index.ts lost_reports_status_check equals the canonical list', () => {
    expect(extractCheckValues(indexTs, 'lost_reports_status_check CHECK'))
      .toEqual([...LOST_REPORT_STATUS_VALUES].sort());
  });

  it('sql/schema.sql and src/db/index.ts agree with each other (fresh vs upgraded DB)', () => {
    expect(extractCheckValues(indexTs, 'lost_reports_status_check CHECK'))
      .toEqual(extractCheckValues(schemaSql, 'CREATE TABLE lost_reports'));
  });

  it('the Drizzle table declares the same default status', () => {
    expect(schemaTs).toMatch(/lost_reports = pgTable\("lost_reports"/);
    expect(schemaTs).toMatch(/status: varchar\("status", \{ length: 30 \}\)\.default\("active"\)/);
  });
});
