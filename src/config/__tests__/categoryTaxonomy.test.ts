import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  CATEGORY_TAXONOMY,
  FALLBACK_GROUP_KEY,
  groupedCategoryIds,
  resolveTaxonomy,
} from '../categoryTaxonomy';

// Phase 9 — the category taxonomy must be a PRESENTATION layer over the real
// seeded categories, never a second source of truth. These assertions read the
// seed straight out of db/database.ts (the same technique
// scripts/audit-browser.mjs uses) so drift between the console's categories and
// the homepage's discovery groups fails the build instead of silently hiding a
// category a user is allowed to report.

const databaseTs = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', '..', 'db', 'database.ts'),
  'utf8'
);

function seededCategoryIds(): string[] {
  const start = databaseTs.indexOf('const list = [');
  const end = databaseTs.indexOf('// Derives Recovery Fee Engine inputs');
  expect(start, 'category seed block not found in db/database.ts').toBeGreaterThan(-1);
  expect(end, 'category seed end marker not found').toBeGreaterThan(start);
  const block = databaseTs.slice(start, end);
  return [...block.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe('category taxonomy is anchored to the real seeded categories', () => {
  const seeded = seededCategoryIds();

  it('the seed itself parses (sanity check that the reader works)', () => {
    expect(seeded.length).toBeGreaterThan(40);
    expect(seeded).toContain('national-id');
    expect(seeded).toContain('other-item');
  });

  it('every id the taxonomy references really exists in the seed', () => {
    const known = new Set(seeded);
    const unknown = groupedCategoryIds().filter((id) => !known.has(id));
    expect(unknown, `taxonomy references categories the backend does not seed: ${unknown.join(', ')}`).toEqual([]);
  });

  it('every seeded category is discoverable — exactly once', () => {
    const grouped = groupedCategoryIds();
    const missing = seeded.filter((id) => !grouped.includes(id));
    expect(missing, `seeded but not grouped (invisible on the homepage): ${missing.join(', ')}`).toEqual([]);

    const counts = new Map<string, number>();
    for (const id of grouped) counts.set(id, (counts.get(id) || 0) + 1);
    const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    expect(duplicated, `grouped more than once: ${duplicated.join(', ')}`).toEqual([]);
  });

  it('has exactly one fallback group, and it carries the real generic category', () => {
    const fallbacks = CATEGORY_TAXONOMY.filter((g) => g.key === FALLBACK_GROUP_KEY);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].ids).toContain('other-item');
  });

  it('has unique group keys and unique labels in both languages', () => {
    expect(new Set(CATEGORY_TAXONOMY.map((g) => g.key)).size).toBe(CATEGORY_TAXONOMY.length);
    expect(new Set(CATEGORY_TAXONOMY.map((g) => g.labelEn)).size).toBe(CATEGORY_TAXONOMY.length);
    expect(new Set(CATEGORY_TAXONOMY.map((g) => g.labelSw)).size).toBe(CATEGORY_TAXONOMY.length);
  });

  it('uses no emoji and no placeholder copy in the group definitions', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
    for (const group of CATEGORY_TAXONOMY) {
      for (const value of [group.labelEn, group.labelSw, group.blurbEn, group.blurbSw]) {
        expect(emoji.test(value), `emoji in taxonomy copy: ${value}`).toBe(false);
        expect(value).not.toMatch(/\bTBD\b|\bTODO\b|lorem/i);
      }
    }
  });
});

describe('resolveTaxonomy never advertises a category the backend cannot accept', () => {
  const live = [
    { id: 'national-id' },
    { id: 'smartphone' },
    { id: 'other-item' },
  ];

  it('keeps only groups backed by live categories', () => {
    const groups = resolveTaxonomy(live);
    expect(groups.map((g) => g.key)).toEqual(['identity-documents', 'phones-electronics', 'other']);
    for (const group of groups) {
      for (const category of group.categories) {
        expect(live.map((c) => c.id)).toContain(category.id);
      }
    }
  });

  it('handles no data at all without inventing any', () => {
    expect(resolveTaxonomy([])).toEqual([]);
    expect(resolveTaxonomy(null)).toEqual([]);
    expect(resolveTaxonomy(undefined)).toEqual([]);
  });
});
