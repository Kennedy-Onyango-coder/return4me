import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildCategoryLabel, type SocialCategory } from '../services/social';
import { db, type Category } from '../db/database';
import { testRunId } from '../db/__tests__/ensureTestCategory';

// =============================================================================
// C1 — `categories.name_sw` IS RETAINED BILINGUAL DATA, NOT A SELECTION GATE.
//
// The C1 audit (owner-approved Option A) changed five production files:
//
//   C1-A  the Finder / Owner / admin-review category SELECTORS stopped requiring
//         a Swahili name before an English-named category could be chosen;
//   C1-B  the published social label degrades to the English name when `name_sw`
//         is blank, instead of publishing a dangling "English / ";
//   C1-C  the category READ path normalises `name_sw` to a string;
//   C1-D  the admin category-edit form prefills `name_sw` as a string.
//
// This file is the machine-checkable record of that, so the gate cannot be
// quietly restored and a blank Swahili name cannot start leaking half a label
// into a public channel again.
//
// TWO DELIBERATELY DIFFERENT TECHNIQUES, for one reason:
//
//   * BEHAVIOURAL where the code is reachable. `buildCategoryLabel` and the
//     category read path are ordinary exported code, so they are CALLED here —
//     `services/social` is importable exactly as
//     services/__tests__/socialSanitize.test.ts already imports it, and
//     `db/database` is driven directly by dozens of existing suites. The selector
//     rules are behavioural too: the live callback expression is lifted out of the
//     component and EXECUTED against fixtures, so these assertions measure the
//     shipped predicate rather than the text around it (a comment can satisfy
//     `.toContain`, a call cannot).
//
//   * SOURCE-LEVEL only for the `AdminView` edit prefill, which lives inside a
//     React event handler. vitest.config.ts runs `environment: 'node'` for
//     `src/**/*.test.ts` and the repository has no jsdom / testing-library
//     dependency, so a .tsx component cannot be mounted. That is the same
//     limitation neighbouring suites record (see the header of
//     categoryArchitectureBatch2.test.ts) and it is why the prefill assertion is
//     narrow and paired with a negative one.
//
// THE INVARIANT IS SCOPED TO THE SELECTORS ON PURPOSE. Other `name_sw` reads
// remain in the product by design (`AdminView` displays the bilingual name and
// writes it back on save), and they are NOT gated here — C1 only removed the
// requirement that a category must HAVE one in order to be selected.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/** Whitespace-collapsed source: JSX line breaks must never decide an assertion. */
const collapse = (source: string) => source.replace(/\s+/g, ' ');

/**
 * The callback expression of the FIRST `<list>.filter(` in `source`, e.g.
 * `cat => cat.name_en`.
 *
 * A balanced-delimiter scan rather than a regex, so a callback that wraps across
 * JSX lines is returned whole. It is deliberately strict: the three callbacks
 * this file reads are single expressions with no string literals (a literal
 * containing a parenthesis would defeat the scan), and the caller compiles the
 * result and fails loudly if it is not callable.
 */
function extractFilterPredicate(source: string, list: string): string {
  const marker = `${list}.filter(`;
  const at = source.indexOf(marker);
  expect(at, `${list}.filter( not found`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = at + marker.length - 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return source.slice(at + marker.length, i).trim();
    }
  }
  return '';
}

/** The LIVE selector rule, compiled and ready to be called with fixtures. */
function selectorPredicate(relPath: string, list: string): (cat: unknown) => boolean {
  const extracted = extractFilterPredicate(read(relPath), list);
  const fn = new Function(`return (${extracted});`)() as unknown;
  expect(typeof fn, `${relPath}: "${extracted}" is not a callable predicate`).toBe('function');
  return fn as (cat: unknown) => boolean;
}

/** `[file, the list the control filters, what the control is for]` — the C1-A set. */
const C1_SELECTORS: Array<[string, string, string]> = [
  ['src/components/FinderView.tsx', 'categories', 'FinderView category select'],
  ['src/components/OwnerView.tsx', 'categories', 'OwnerView category filter'],
  ['src/components/AdminView.tsx', 'adminCategories', 'AdminView review-panel category select'],
];

/**
 * What `.filter()` actually asks of the live predicate: its TRUTHINESS.
 *
 * The three callbacks are expression-bodied and return the name itself (a
 * non-empty string, or `''` when the English name is missing), so these
 * assertions must never compare the returned string against a boolean — the
 * production behaviour is "keep the truthy ones".
 */
const admits = (relPath: string, list: string, cat: unknown): boolean =>
  Boolean(selectorPredicate(relPath, list)(cat));

describe('C1-A — a category is selectable on its ENGLISH name alone', () => {
  const BOTH = { id: 'national-id', name_en: 'National ID', name_sw: 'Kitambulisho cha Kitaifa' };

  for (const [file, list, label] of C1_SELECTORS) {
    it(`${label}: still admits a category that has both names`, () => {
      expect(admits(file, list, BOTH)).toBe(true);
    });

    it(`${label}: admits a category whose Swahili name is empty, blank, null or absent`, () => {
      expect(admits(file, list, { ...BOTH, name_sw: '' }), 'empty name_sw').toBe(true);
      expect(admits(file, list, { ...BOTH, name_sw: '   ' }), 'whitespace-only name_sw').toBe(true);
      expect(admits(file, list, { ...BOTH, name_sw: null }), 'null name_sw').toBe(true);
      expect(admits(file, list, { id: 'national-id', name_en: 'National ID' }), 'absent name_sw').toBe(true);
    });

    it(`${label}: still refuses a category with no English name`, () => {
      expect(admits(file, list, { id: 'x', name_en: '', name_sw: 'Kitambulisho cha Kitaifa' })).toBe(false);
      expect(admits(file, list, { id: 'x', name_sw: 'Kitambulisho cha Kitaifa' })).toBe(false);
    });

    it(`${label}: no filter predicate anywhere in the component mentions name_sw`, () => {
      expect(read(file)).not.toMatch(/\.filter\([^)]*name_sw/);
    });
  }

  it('every one of the three selectors labels its options with the English name it filtered on', () => {
    for (const [file] of C1_SELECTORS) {
      expect(collapse(read(file)), `${file} must render {cat.name_en} as the option label`).toContain('{cat.name_en}');
    }
  });
});

/** The `SocialCategory` shape, so every fixture below is type-checked. */
const category = (over: Partial<SocialCategory> = {}): SocialCategory => ({
  id: 'national-id',
  name_en: 'National ID',
  name_sw: 'Kitambulisho cha Kitaifa',
  total_fee: 500,
  is_sensitive_document: false,
  ...over,
});

describe('C1-B — buildCategoryLabel keeps the bilingual label, and degrades safely', () => {
  it('1. both names present: the exact existing "English / Swahili" label', () => {
    expect(buildCategoryLabel(category())).toBe('National ID / Kitambulisho cha Kitaifa');
  });

  it('2. empty Swahili name: the English name alone, with no dangling separator', () => {
    const label = buildCategoryLabel(category({ name_sw: '' }));
    expect(label).toBe('National ID');
    expect(label).not.toContain('/');
  });

  it('3. whitespace-only Swahili name: the English name alone', () => {
    for (const blank of [' ', '   ', '\t', '\n', ' \t \n ']) {
      expect(buildCategoryLabel(category({ name_sw: blank })), JSON.stringify(blank)).toBe('National ID');
    }
  });

  it("4. no category at all: the default 'Lost Item' fallback", () => {
    expect(buildCategoryLabel()).toBe('Lost Item');
    expect(buildCategoryLabel(undefined)).toBe('Lost Item');
  });

  it("5. no category and the explicit 'Item' fallback the reunited broadcast passes", () => {
    expect(buildCategoryLabel(undefined, 'Item')).toBe('Item');
  });

  it("5b. that 'Item' fallback never overrides a real category", () => {
    expect(buildCategoryLabel(category({ name_sw: '' }), 'Item')).toBe('National ID');
  });

  it('6. a usable Swahili name is rendered EXACTLY as stored, padding included', () => {
    // The pre-C1 label interpolated `category.name_sw` verbatim. Trimming is only
    // the usability test, so the published text of every existing category stays
    // byte-for-byte identical — that is the point of the helper, and this is the
    // assertion that stops a future tidy-up from reflowing live copy.
    expect(buildCategoryLabel(category({ name_sw: '  Kitambulisho cha Kitaifa  ' })))
      .toBe('National ID /   Kitambulisho cha Kitaifa  ');
  });

  it('7. a null/undefined Swahili name (possible at runtime) degrades to the English name', () => {
    expect(buildCategoryLabel({ ...category(), name_sw: null as any })).toBe('National ID');
    expect(buildCategoryLabel({ ...category(), name_sw: undefined as any })).toBe('National ID');
  });
});

describe('C1-B wiring — the publication service routes its labels through the helper', () => {
  const SOCIAL = read('src/services/social.ts');

  it('the ONLY bilingual category template left in the service is the helper own one', () => {
    const templates = SOCIAL.match(/\$\{category\.name_en\} \/ \$\{category\.name_sw\}/g) ?? [];
    expect(
      templates.length,
      `the raw "English / Swahili" template must exist only inside buildCategoryLabel; found ${templates.length}`,
    ).toBe(1);
  });

  it('Twitter keeps its long-standing English-only label (it must NOT adopt the helper)', () => {
    const start = SOCIAL.indexOf('async postToTwitter');
    expect(start, 'postToTwitter not found in services/social.ts').toBeGreaterThan(-1);
    const next = SOCIAL.indexOf('\n  async ', start + 1);
    const body = SOCIAL.slice(start, next === -1 ? undefined : next);
    expect(body).toContain('category.name_en');
    expect(body, 'the Twitter label must not read the Swahili name').not.toContain('name_sw');
    expect(body, 'the Twitter label must not use the bilingual helper').not.toContain('buildCategoryLabel');
  });
});

/** The fee columns every category fixture must carry (the platform 25/35/40 split). */
const FEES = {
  total_fee: 500,
  finder_share: 125,
  agent_share: 175,
  platform_share: 200,
  is_sensitive_document: false,
};

/**
 * Create a category whose `name_sw` is whatever the caller passes.
 *
 * `categories.name_sw` is `notNull()` with no default (src/db/schema.ts), so a
 * REAL Postgres cannot hold a row with no Swahili name at all. The in-memory
 * engine the suite runs on — CI, and any machine whose DATABASE_URL is the
 * unconfigured placeholder — does NOT enforce NOT NULL (documented at length in
 * src/__tests__/setup.testEnv.ts), which is the only way the defensive branch C1-C
 * added can be exercised. Hence:
 *
 *   * returns the created row normally against the in-memory engine;
 *   * returns `null` — and asserts the refusal really was that column
 *     constraint, so a fixture typo or a broken engine still fails — against a
 *     database that enforces the column. There the input this branch is about
 *     cannot exist, and the empty-string and valid-name assertions below carry
 *     the coverage instead.
 */
async function createWithRawNameSw(id: string, name_sw: unknown): Promise<Category | null> {
  try {
    return await db.createCategory({
      id,
      name_en: 'C1 Retained Swahili Fixture',
      name_sw: name_sw as any,
      ...FEES,
    });
  } catch (error) {
    const detail = String((error as any)?.cause?.message ?? (error as any)?.message ?? error);
    expect(
      detail,
      `placing a "${String(name_sw)}" name_sw failed for a reason other than the column constraint: ${detail}`,
    ).toMatch(/null value in column ["']?name_sw["']?|not-null|null constraint/i);
    return null;
  }
}

describe('C1-C — the category read path never hands back a null name_sw', () => {
  it("a row stored with an EMPTY Swahili name reads back as '' (the realistic case)", async () => {
    const id = `TEST-C1-EMPTYSW-${testRunId}`;
    const created = await db.createCategory({ id, name_en: 'C1 Empty Swahili', name_sw: '', ...FEES });
    expect(created.name_sw).toBe('');
    expect((await db.getCategory(id))?.name_sw).toBe('');
  });

  it("a row whose name_sw is NULL reads back as '' and not null", async () => {
    const id = `TEST-C1-NULLSW-${testRunId}`;
    const created = await createWithRawNameSw(id, null);
    if (!created) return; // see createWithRawNameSw: this database enforces the column
    expect(created.name_sw).toBe('');
    const reread = await db.getCategory(id);
    expect(reread?.name_sw).toBe('');
    expect(typeof reread?.name_sw, 'name_sw is declared as a string, so it must be one').toBe('string');
  });

  it("a row with no name_sw value at all reads back as ''", async () => {
    const id = `TEST-C1-OMITSW-${testRunId}`;
    const created = await createWithRawNameSw(id, undefined);
    if (!created) return; // see createWithRawNameSw: this database enforces the column
    expect(created.name_sw).toBe('');
    expect((await db.getCategory(id))?.name_sw).toBe('');
  });

  it('a real Swahili name survives the same read path untouched', async () => {
    const id = `TEST-C1-KEEPSW-${testRunId}`;
    const created = await db.createCategory({ id, name_en: 'C1 Kept Swahili', name_sw: 'Jina la Kiswahili', ...FEES });
    expect(created.name_sw).toBe('Jina la Kiswahili');
    expect((await db.getCategory(id))?.name_sw).toBe('Jina la Kiswahili');
  });
});

describe('C1-D — the admin category-edit form prefills a STRING for the Swahili field', () => {
  const ADMIN_VIEW = read('src/components/AdminView.tsx');

  it('prefills the Swahili name with an empty-string fallback', () => {
    expect(ADMIN_VIEW).toMatch(/setCatFormNameSw\(\s*cat\.name_sw\s*\?\?\s*''\s*\)/);
  });

  it('no longer seeds the controlled field straight from a possibly-undefined value', () => {
    expect(ADMIN_VIEW).not.toMatch(/setCatFormNameSw\(\s*cat\.name_sw\s*\)/);
  });

  it('the field really is controlled by that state, and that state is what gets saved', () => {
    // `value={catFormNameSw}` is why the fallback matters (a null would be an
    // uncontrolled input), and `name_sw: catFormNameSw` is why it must not be
    // dropped: the retained bilingual data has to survive an admin edit.
    expect(ADMIN_VIEW).toContain('value={catFormNameSw}');
    expect(collapse(ADMIN_VIEW)).toContain('name_sw: catFormNameSw');
  });
});
