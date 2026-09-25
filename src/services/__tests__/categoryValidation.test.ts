import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  CATEGORY_MESSAGES,
  CATEGORY_ID_MAX_LENGTH,
  resolveCategoryId,
  validateCategoryIdFormat,
  parseCategoryNumber,
} from '../categoryValidation';

// ===========================================================================
// PHASE 16.1 BATCH 1 (CAT-01 / CAT-07 / CAT-19) — THE CATEGORY INPUT BOUNDARY
// ===========================================================================
// BEHAVIOURAL tests: every case calls the real function with the real argument
// shapes the routes pass. The module deliberately holds no category list, so the
// "live list" below is supplied exactly as the routes supply it (the ids from
// db.getCategories()) — which is what makes the "unknown id" cases meaningful
// proof that an unknown category is refused rather than resolved by name.
// ===========================================================================

const LIVE = [{ id: 'laptop' }, { id: 'smartphone' }, { id: 'other-item' }];

// This file lives in src/services/__tests__, so reaching the REPOSITORY root
// takes three levels up (__tests__ -> services -> src -> repo). Two levels up
// resolved to <repo>/src, which made read('src/routes/lostReports.ts') look for
// <repo>/src/src/routes/lostReports.ts and throw ENOENT — so the wording-parity
// assertion below never actually read the route file.
const repoRoot = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

describe('resolveCategoryId — a category reference must be a LIVE canonical id', () => {
  it('accepts an id the live list contains, verbatim', () => {
    expect(resolveCategoryId('laptop', LIVE)).toEqual({ ok: true, id: 'laptop' });
  });

  it('tolerates surrounding whitespace (matching the lost-report route trim)', () => {
    expect(resolveCategoryId('  laptop  ', LIVE)).toEqual({ ok: true, id: 'laptop' });
  });

  it('rejects a MISSING value', () => {
    for (const raw of [undefined, null]) {
      const result = resolveCategoryId(raw, LIVE);
      expect(result.ok).toBe(false);
      expect(result.error).toBe(CATEGORY_MESSAGES.invalid);
    }
  });

  it('rejects a BLANK or whitespace-only value', () => {
    for (const raw of ['', '   ', '\t']) {
      expect(resolveCategoryId(raw, LIVE).ok).toBe(false);
    }
  });

  it('rejects an UNKNOWN id', () => {
    expect(resolveCategoryId('not-a-real-category', LIVE).ok).toBe(false);
  });

  it('rejects a category NAME — no name→id resolution, ever', () => {
    // 'Laptop' is laptop's display name; category search/reference is by id only.
    expect(resolveCategoryId('Laptop', LIVE).ok).toBe(false);
  });

  it('rejects a case variant rather than folding it', () => {
    expect(resolveCategoryId('LAPTOP', LIVE).ok).toBe(false);
    expect(resolveCategoryId('Laptop', LIVE).ok).toBe(false);
  });

  it('rejects every non-string shape a caller can send', () => {
    // A repeated `?categoryId=a&categoryId=b` query parameter arrives as an array.
    for (const raw of [['laptop', 'smartphone'], 42, true, {}, [], () => {}]) {
      expect(resolveCategoryId(raw as any, LIVE).ok).toBe(false);
    }
  });

  it('invents no fallback: an empty/absent live list refuses everything', () => {
    for (const categories of [[], null, undefined]) {
      expect(resolveCategoryId('laptop', categories as any).ok).toBe(false);
    }
  });

  it('never returns a value the caller did not supply from the live list', () => {
    const result = resolveCategoryId('smartphone', LIVE);
    expect(result.id).toBe(LIVE[1].id);
  });
});

describe('validateCategoryIdFormat — the id FORMAT plus the VARCHAR(50) limit (CAT-19)', () => {
  it('accepts lowercase kebab-case ids', () => {
    for (const id of ['laptop', 'national-id', 'other-item', 'a', 'a1-b2']) {
      expect(validateCategoryIdFormat(id).ok, `${id} must be accepted`).toBe(true);
    }
  });

  it('rejects the same shapes the pre-existing API regex rejected', () => {
    for (const id of ['', 'Laptop', 'national id', 'national_id', 'National-ID', null, undefined, 42, {}]) {
      const result = validateCategoryIdFormat(id as any);
      expect(result.ok, `${String(id)} must be rejected`).toBe(false);
      expect(result.error).toBe(CATEGORY_MESSAGES.idFormat);
    }
  });

  it('accepts exactly 50 characters and rejects 51 (the old 500 path)', () => {
    expect(CATEGORY_ID_MAX_LENGTH).toBe(50);
    const atLimit = 'a'.repeat(CATEGORY_ID_MAX_LENGTH);
    const overLimit = 'a'.repeat(CATEGORY_ID_MAX_LENGTH + 1);

    expect(validateCategoryIdFormat(atLimit).ok).toBe(true);

    const result = validateCategoryIdFormat(overLimit);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(CATEGORY_MESSAGES.idTooLong);
  });
});

describe('parseCategoryNumber — admin fee fields are real numbers, or a 400 (CAT-19)', () => {
  const AMOUNT = { min: 0 };
  const PERCENT = { min: 0, max: 100 };

  it('treats an omitted field as "not supplied" so defaults/preserved values win', () => {
    for (const raw of [undefined, null, '']) {
      const result = parseCategoryNumber(raw, 'base_fee', AMOUNT);
      expect(result.supplied).toBe(false);
      expect(result.ok).toBe(true);
    }
  });

  it('accepts finite numbers and numeric strings (including padded/comma-free forms)', () => {
    expect(parseCategoryNumber(400, 'base_fee', AMOUNT).value).toBe(400);
    expect(parseCategoryNumber('400', 'base_fee', AMOUNT).value).toBe(400);
    expect(parseCategoryNumber(' 12.5 ', 'ceiling_percent', PERCENT).value).toBe(12.5);
    expect(parseCategoryNumber(0, 'flat_fee', AMOUNT).value).toBe(0);
  });

  it('rejects values that used to become NaN and reach the database as a 500', () => {
    for (const raw of ['abc', 'NaN', '12abc', '--5']) {
      const result = parseCategoryNumber(raw, 'base_fee', AMOUNT);
      expect(result.ok, `${raw} must be rejected`).toBe(false);
      expect(result.error).toContain('base_fee');
    }
  });

  it('rejects non-finite numbers', () => {
    for (const raw of [Infinity, -Infinity, NaN, 'Infinity']) {
      expect(parseCategoryNumber(raw as any, 'delay_fee', AMOUNT).ok, `${String(raw)} must be rejected`).toBe(false);
    }
  });

  it('rejects a NEGATIVE amount (the Postgres CHECK constraint is now a 400)', () => {
    expect(parseCategoryNumber(-1, 'complexity_fee', AMOUNT).ok).toBe(false);
    expect(parseCategoryNumber('-0.01', 'complexity_fee', AMOUNT).ok).toBe(false);
  });

  it('bounds percentages to 0 - 100 and lets the boundaries through', () => {
    expect(parseCategoryNumber(0, 'finder_pct', PERCENT).value).toBe(0);
    expect(parseCategoryNumber(100, 'finder_pct', PERCENT).value).toBe(100);
    expect(parseCategoryNumber('25', 'finder_pct', PERCENT).value).toBe(25);

    expect(parseCategoryNumber(101, 'finder_pct', PERCENT).ok).toBe(false);
    expect(parseCategoryNumber(-1, 'platform_pct', PERCENT).ok).toBe(false);
  });

  it('rejects every non-numeric shape rather than coercing it', () => {
    for (const raw of [true, false, ['10'], { value: 10 }, () => 10]) {
      expect(parseCategoryNumber(raw as any, 'agent_pct', PERCENT).ok, `${String(raw)} must be rejected`).toBe(false);
    }
  });

  it('names the offending field in the error so the admin can act on it', () => {
    const result = parseCategoryNumber('nonsense', 'ceiling_percent', PERCENT);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ceiling_percent');
    expect(result.error).toContain('0 - 100');
  });
});

describe('CATEGORY_MESSAGES — one rejection phrase, shared with the existing routes', () => {
  it('the invalid-category wording is byte-identical to the routes already using it', () => {
    // The shared literal the found-item report handler and the lost-report route
    // answer with. Pinned here so the new boundaries (agent verification, admin
    // item review, public search) cannot drift into a second phrasing — this
    // ADDS a guard on top of the existing foundItemCategoryValidation assertion,
    // it does not replace it.
    const shared = 'Aina ya kitu haikubaliki. / That item category is not valid.';
    expect(CATEGORY_MESSAGES.invalid).toBe(shared);
    expect(read('src/routes/lostReports.ts')).toContain(shared);
  });
});
