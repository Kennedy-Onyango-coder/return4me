// CATEGORY INPUT RULES (Phase 16.1 Batch 1 — CAT-01, CAT-07, CAT-19)
// ==================================================================
// The ONE place an untrusted category mention is decided: which category id a
// WRITE (finder report, agent verification, admin item review, category
// administration) is allowed to reference, and which numeric Recovery Fee
// Engine field an administrator is allowed to store. Extracted from the routes
// for the same reason services/foundItemCounty.ts was extracted: the rule
// becomes directly unit-testable and there is provably ONE implementation of
// it instead of a copy per route.
//
// WHY THIS EXISTS (the defect it closes)
//   Three category-writing paths validated only that a value was PRESENT and
//   then let it reach the database, where `items_category_id_fkey` rejected it.
//   The caller saw either a 500 or — worse — the raw Postgres constraint text
//   echoed back through `recordItemVerification`'s catch block. A request with
//   a trivially malformed category must be a controlled 4xx at the boundary,
//   never a database error, and it must be rejected BEFORE any side effect
//   (item update, verification write, audit write).
//
// THE CANONICAL SOURCE IS DELEGATED, NEVER DUPLICATED
//   The live category list is ALWAYS supplied by the caller (from
//   db.getCategories()). This module holds no category list, no seed copy, no
//   id constant beyond the storage FORMAT (the VARCHAR(50) primary key shape),
//   no alias table and no name->id mapping. An id that is not in the caller's
//   live list is REJECTED — never coerced, never guessed, and never resolved
//   from a category NAME: category search and category references are by
//   canonical id only (see the Phase 16.1 audit, CAT-07).

/** Bilingual, user-facing copy. Mirrors the existing route message style. */
export const CATEGORY_MESSAGES = {
  /**
   * The SAME wording the found-item report route and the lost-report route
   * already answer with (routes/lostReports.ts -> MESSAGES.categoryInvalid),
   * kept here so every category boundary rejects with one phrase. A test
   * asserts this equals the wording those routes use, so the two can never
   * drift apart.
   */
  invalid: 'Aina ya kitu haikubaliki. / That item category is not valid.',
  idFormat: 'ID lazima iwe herufi ndogo na kistari (lowercase-kebab-case) pekee, na isikuwe tupu.',
  idTooLong: 'ID ya kategoria ni ndefu kupita kiasi (herufi 50 kwa juu). / Category ID is too long (50 characters maximum).',
} as const;

/**
 * The API accepts exactly the shape the `categories.id VARCHAR(50)` primary key
 * can actually store. 50 was previously enforced only by Postgres, so a longer
 * id passed the regex and failed at the database as a 500 (audit CAT-19).
 */
export const CATEGORY_ID_MAX_LENGTH = 50;

/** Lowercase kebab-case, unchanged from the pre-existing API contract. */
export const CATEGORY_ID_PATTERN = /^[a-z0-9-]+$/;

/** The id FORMAT rules, used by category creation. */
export function validateCategoryIdFormat(raw: unknown): { ok: boolean; error?: string } {
  if (!raw || typeof raw !== 'string' || !CATEGORY_ID_PATTERN.test(raw)) {
    return { ok: false, error: CATEGORY_MESSAGES.idFormat };
  }
  if (raw.length > CATEGORY_ID_MAX_LENGTH) {
    return { ok: false, error: CATEGORY_MESSAGES.idTooLong };
  }
  return { ok: true };
}

export interface CategoryResolution {
  ok: boolean;
  /** The canonical id, verbatim from the caller's live list. Set exactly when `ok` is true. */
  id?: string;
  /** User-facing bilingual error. Set exactly when `ok` is false. */
  error?: string;
}

/**
 * Resolves an untrusted category id against the caller's LIVE category list.
 *
 * - missing (`undefined`/`null`)   -> invalid
 * - non-string (number/array/object — a repeated `?categoryId=` query
 *   parameter arrives as an array) -> invalid
 * - blank / whitespace-only        -> invalid
 * - an id the live list does not contain, INCLUDING a category's display
 *   name (`?categoryId=Laptop`)    -> invalid
 * - a canonical id                 -> that id
 *
 * Case is NOT folded and no near-match is attempted: category ids are already
 * canonical lowercase slugs, so anything else is a different (unknown) value
 * and must be refused rather than guessed at. Surrounding whitespace is
 * tolerated, matching the lost-report route's existing `categoryId.trim()`.
 */
export function resolveCategoryId(
  raw: unknown,
  categories: Array<{ id: string }> | null | undefined,
): CategoryResolution {
  if (raw === undefined || raw === null) return { ok: false, error: CATEGORY_MESSAGES.invalid };
  if (typeof raw !== 'string') return { ok: false, error: CATEGORY_MESSAGES.invalid };

  const id = raw.trim();
  if (id === '') return { ok: false, error: CATEGORY_MESSAGES.invalid };

  const known = (categories || []).some((category) => category && category.id === id);
  if (!known) return { ok: false, error: CATEGORY_MESSAGES.invalid };

  return { ok: true, id };
}

export interface ParsedCategoryNumber {
  /** false when the caller omitted the field (`undefined`/`null`/`''`). */
  supplied: boolean;
  /** true when the field was omitted, or when it was supplied and valid. */
  ok: boolean;
  value?: number;
  error?: string;
}

export interface CategoryNumberRule {
  /** Minimum accepted value — 0 for every money/percentage field on `categories`. */
  min: number;
  /** Maximum accepted value, where the concept has one (percentages -> 100). */
  max?: number;
}

function numberError(field: string, rule: CategoryNumberRule): string {
  const range = rule.max === undefined ? `>= ${rule.min}` : `${rule.min} - ${rule.max}`;
  return `${field} si sahihi: lazima iwe nambari halisi (${range}). / ${field} is invalid: it must be a real number (${range}).`;
}

/**
 * Parses one numeric Recovery Fee Engine field from an admin request body.
 *
 * The previous implementation applied a bare `Number()` and passed the result
 * straight to the DB layer, so `"abc"` became `NaN`, `Infinity` stayed
 * `Infinity`, a negative amount survived to a Postgres CHECK constraint, and
 * the caller received a 500 for what is plainly a 400 (audit CAT-19). Nothing
 * is silently coerced: a supplied value that is not a finite number inside the
 * rule's range is REJECTED with a bilingual field-named message.
 *
 * Structural limits deliberately mirror the database:
 *   - amounts (`base_fee`, `complexity_fee`, `delay_fee`, `finder_reward_cap`)
 *     are `>= 0` (the same CHECK constraints `sql/schema.sql` declares);
 *   - percentages (`ceiling_percent`, `finder_pct`, `agent_pct`, `platform_pct`)
 *     are `0 - 100` — a share of a fee cannot exceed the whole fee.
 * `finder_reward_cap` has no upper bound: it is an absolute KES ceiling, and
 * its own "no cap" case is expressed by omitting the field, not by a number.
 */
export function parseCategoryNumber(
  raw: unknown,
  field: string,
  rule: CategoryNumberRule,
): ParsedCategoryNumber {
  if (raw === undefined || raw === null || raw === '') return { supplied: false, ok: true };

  // Booleans, arrays and objects are never silently treated as numbers.
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return { supplied: true, ok: false, error: numberError(field, rule) };
  }

  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) return { supplied: true, ok: false, error: numberError(field, rule) };
  if (value < rule.min) return { supplied: true, ok: false, error: numberError(field, rule) };
  if (rule.max !== undefined && value > rule.max) {
    return { supplied: true, ok: false, error: numberError(field, rule) };
  }

  return { supplied: true, ok: true, value };
}
