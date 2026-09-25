import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  CATEGORY_TAXONOMY,
  FALLBACK_GROUP_KEY,
  groupedCategoryIds,
  resolveTaxonomy,
} from '../../../config/categoryTaxonomy';

// =============================================================================
// PHASE 16.1 BATCH 1C — CATEGORY EXPLORER DISCLOSURE + ACCESSIBILITY CONTRACT
// =============================================================================
// The Batch 1B audit established the homepage explorer's disclosure behaviour:
// only the first DEFAULT_VISIBLE_GROUPS (4) non-empty taxonomy groups are rendered
// initially; the rest are reached through the "Show all" button or the search box;
// unknown/admin-created categories are preserved under "Other Items"; search
// bypasses the limit. Batch 1C remediated only the accessibility gap (the
// disclosure's state was not announced) and left the disclosure NUMBER alone.
//
// This file pins that contract in two layers, matching the repository's existing
// conventions (there is no DOM harness — see vitest.config.ts `environment:
// 'node'` and phase9PublicSurface.test.ts's rationale — and Batch 1C explicitly
// does NOT install jsdom/React Testing Library):
//
//   1. BEHAVIOURAL, against the REAL resolver (resolveTaxonomy) and the REAL
//      taxonomy, so the disclosure arithmetic is exercised on real data;
//   2. SOURCE-LEVEL, against the real component that ships, for the parts that
//      only exist inside the render (the slice, the search bypass, and the
//      button's ARIA wiring).
// =============================================================================

// This file lives at src/components/home/__tests__/, so the repository root is
// four levels up (__tests__ → home → components → src → root).
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/**
 * Comments are stripped before any structural assertion: the Batch 1C comments
 * themselves discuss `aria-expanded`, `aria-controls` and the group id, so
 * asserting against raw source could pass (or fail) on prose rather than code.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const EXPLORER = stripComments(read('src/components/home/CategoryExplorer.tsx'));

/** The value the component ships with; asserted against the source below. */
const DEFAULT_VISIBLE_GROUPS = 4;

/**
 * The live list a FULLY SEEDED database serves. `groupedCategoryIds()` is the
 * taxonomy's own declared id set, and categoryTaxonomy.test.ts proves it equals
 * the 46 ids the backend seeds — so this is real production data, not a fixture.
 *
 * Each row also carries `name_en`/`name_sw` because that is the real shape of a
 * `GET /api/categories` row (and it is what the explorer's search filter reads).
 * `resolveTaxonomy` itself resolves by `id` only, so the names change nothing
 * about the grouping assertions.
 */
const FULL_SEED_LIVE = groupedCategoryIds().map((id) => ({ id, name_en: id, name_sw: id }));
const FULL_GROUPS = resolveTaxonomy(FULL_SEED_LIVE);

// ---------------------------------------------------------------------------
// Test A — the default window is the FIRST FOUR non-empty groups
// ---------------------------------------------------------------------------
describe('1C-A: the default disclosure window is the first four non-empty groups', () => {
  it('behaviourally: the real taxonomy resolves to ten groups, of which the window shows the first four', () => {
    expect(FULL_GROUPS.length).toBe(CATEGORY_TAXONOMY.length);
    expect(FULL_GROUPS.length).toBeGreaterThan(DEFAULT_VISIBLE_GROUPS);

    const defaultWindow = FULL_GROUPS.slice(0, DEFAULT_VISIBLE_GROUPS);
    expect(defaultWindow).toHaveLength(DEFAULT_VISIBLE_GROUPS);
    // The window is POSITIONAL — the first four in declaration order — not a
    // ranking by size, popularity or recency.
    expect(defaultWindow.map((g) => g.key)).toEqual(
      CATEGORY_TAXONOMY.slice(0, DEFAULT_VISIBLE_GROUPS).map((g) => g.key),
    );
    // Every group in the window is backed by live categories (nothing advertised
    // that the backend cannot accept).
    for (const group of defaultWindow) {
      expect(group.categories.length).toBeGreaterThan(0);
      for (const category of group.categories) {
        expect(FULL_SEED_LIVE.map((c) => c.id)).toContain(category.id);
      }
    }
  });

  it('in the shipped component: the window is exactly `slice(0, DEFAULT_VISIBLE_GROUPS)`', () => {
    expect(EXPLORER).toContain('const DEFAULT_VISIBLE_GROUPS = 4;');
    expect(EXPLORER).toContain(
      'const visibleGroups = isSearching || showAll ? groups : groups.slice(0, DEFAULT_VISIBLE_GROUPS);',
    );
    // Exactly one definition and one application of the constant.
    expect(EXPLORER.match(/DEFAULT_VISIBLE_GROUPS/g) ?? []).toHaveLength(2);
    // Empty groups are dropped BEFORE the window is applied, so the window is
    // "first four NON-EMPTY groups" rather than "first four slots, some blank".
    expect(EXPLORER).toContain('.filter((group) => group.categories.length > 0);');
  });
});

// ---------------------------------------------------------------------------
// Test B — hidden groups exist, and the disclosure control is required
// ---------------------------------------------------------------------------
describe('1C-B: with more than four groups the remainder is hidden until disclosed', () => {
  it('behaviourally: the fully-seeded taxonomy hides six groups', () => {
    const hidden = FULL_GROUPS.length - FULL_GROUPS.slice(0, DEFAULT_VISIBLE_GROUPS).length;
    expect(hidden).toBeGreaterThan(0);
    expect(hidden).toBe(CATEGORY_TAXONOMY.length - DEFAULT_VISIBLE_GROUPS);
  });

  it('behaviourally: the fallback group — where every admin-created category lands — is outside the default window', () => {
    // The audit's key finding, pinned so a future change to the window or to the
    // taxonomy order has to be a conscious decision.
    expect(FULL_GROUPS.map((g) => g.key)).toContain(FALLBACK_GROUP_KEY);
    expect(FULL_GROUPS.slice(0, DEFAULT_VISIBLE_GROUPS).map((g) => g.key)).not.toContain(FALLBACK_GROUP_KEY);
    expect(FULL_GROUPS[FULL_GROUPS.length - 1].key).toBe(FALLBACK_GROUP_KEY);
  });

  it('in the shipped component: the control renders only when something is hidden', () => {
    expect(EXPLORER).toContain('const hiddenGroupCount = groups.length - visibleGroups.length;');
    expect(EXPLORER).toContain('{hiddenGroupCount > 0 && (');
  });
});

// ---------------------------------------------------------------------------
// Test C — Show all reveals every resolved group, and is one-way
// ---------------------------------------------------------------------------
describe('1C-C: activating the disclosure reveals all groups', () => {
  it('behaviourally: the disclosed set is every resolved group, which strictly exceeds the window', () => {
    // With showAll (or a search) the component renders `groups` itself; modelling
    // that here proves the disclosed set is a superset of the default window.
    const disclosed = FULL_GROUPS;
    const defaultWindow = FULL_GROUPS.slice(0, DEFAULT_VISIBLE_GROUPS);
    expect(disclosed.length).toBeGreaterThan(defaultWindow.length);
    for (const group of defaultWindow) {
      expect(disclosed.map((g) => g.key)).toContain(group.key);
    }
  });

  it('in the shipped component: `showAll` starts false, is set only to true, and gates the full list', () => {
    expect(EXPLORER).toContain('const [showAll, setShowAll] = useState(false);');
    expect(EXPLORER).toContain('onClick={() => setShowAll(true)}');
    // One-way disclosure: no path back to the collapsed state.
    expect(EXPLORER).not.toContain('setShowAll(false)');
    expect(EXPLORER).not.toMatch(/Show fewer|Show less|Onyesha chache/);
    // Exactly one activation site, one visibility decision, one announced state.
    expect(EXPLORER.match(/setShowAll\(true\)/g) ?? []).toHaveLength(1);
    expect(EXPLORER).toContain('isSearching || showAll ? groups : groups.slice(0, DEFAULT_VISIBLE_GROUPS)');
    expect(EXPLORER).toContain('aria-expanded={showAll}');
  });
});

// ---------------------------------------------------------------------------
// Test D — a non-empty search bypasses the four-group window
// ---------------------------------------------------------------------------
describe('1C-D: a non-empty search reaches categories in groups the window hides', () => {
  /** The explorer's own filter, mirrored: name-contains, then drop empty groups. */
  function searchMirror(query: string) {
    const needle = query.trim().toLowerCase();
    return FULL_GROUPS
      .map((group) => ({
        ...group,
        categories: group.categories.filter((c: any) => String(c?.name_en || '').toLowerCase().includes(needle)),
      }))
      .filter((group) => group.categories.length > 0);
  }

  it('behaviourally: a match living outside the default window is found by search', () => {
    // 'smartphone'/'smartwatch' live in 'phones-electronics', which the audit showed
    // sits OUTSIDE the first four groups.
    expect(FULL_GROUPS.findIndex((g) => g.key === 'phones-electronics')).toBeGreaterThanOrEqual(
      DEFAULT_VISIBLE_GROUPS,
    );

    const matched = searchMirror('smart');
    expect(matched.map((g) => g.key)).toEqual(['phones-electronics']);
    // …and that group is precisely one the default window hides.
    expect(FULL_GROUPS.slice(0, DEFAULT_VISIBLE_GROUPS).map((g) => g.key)).not.toContain('phones-electronics');
  });

  it('behaviourally: a query matching nothing yields no groups (the component shows its empty state)', () => {
    expect(searchMirror('zzzz-no-such-category')).toEqual([]);
  });

  it('in the shipped component: search is computed over ALL groups and only the render is sliced', () => {
    expect(EXPLORER).toContain('const resolved = resolveTaxonomy(categories);');
    expect(EXPLORER).toContain('const isSearching = query.trim().length > 0;');
    expect(EXPLORER).toContain('if (!needle) return resolved;');
    // `isSearching` is the FIRST operand, so any non-empty query wins over the slice.
    expect(EXPLORER).toContain('isSearching || showAll ? groups : groups.slice(0, DEFAULT_VISIBLE_GROUPS)');
    // The rendered list is the windowed one; the searched one is `groups`.
    expect(EXPLORER).toContain('{visibleGroups.map((group) => {');
  });
});

// ---------------------------------------------------------------------------
// Test E — an unknown / admin-created id is kept, under `other`
// ---------------------------------------------------------------------------
describe('1C-E: an unknown admin-created category is preserved under the fallback group', () => {
  it('resolveTaxonomy places an unmapped id in `other` and never drops it', () => {
    const groups = resolveTaxonomy([{ id: 'national-id' }, { id: 'custom-category' }]);
    const reachable = groups.flatMap((group) => group.categories.map((c: any) => c.id));
    expect(reachable).toContain('custom-category');

    const holders = groups.filter((group) => group.categories.some((c: any) => c.id === 'custom-category'));
    expect(holders.map((g) => g.key)).toEqual([FALLBACK_GROUP_KEY]);
  });

  it('on a fully seeded database it joins the existing fallback group rather than inventing a group', () => {
    const withCustom = resolveTaxonomy([...FULL_SEED_LIVE, { id: 'custom-category' }]);
    // No new group appears: the ungrouped category is appended to `other`.
    expect(withCustom.length).toBe(FULL_GROUPS.length);

    const fallback = withCustom.find((group) => group.key === FALLBACK_GROUP_KEY);
    expect(fallback).toBeDefined();
    expect(fallback!.categories.map((c: any) => c.id)).toContain('custom-category');
  });
});

// ---------------------------------------------------------------------------
// Test F — accessibility: announced state + a controls reference to a real region
// ---------------------------------------------------------------------------
describe('1C-F: the disclosure announces its state and controls the group region', () => {
  const GROUP_REGION_ID = 'category-explorer-groups';

  it('the button exposes aria-expanded bound to `showAll` and an aria-controls reference', () => {
    expect(EXPLORER).toContain('aria-expanded={showAll}');
    expect(EXPLORER).toContain(`aria-controls="${GROUP_REGION_ID}"`);

    // The BUTTON ELEMENT itself carries both attributes and is never hidden (the
    // chevron ICON inside it legitimately keeps its own aria-hidden, so the slice
    // stops at the end of the aria-controls attribute rather than at the first '>'
    // — which would land inside the arrow function of onClick).
    const setShowAllIdx = EXPLORER.indexOf('onClick={() => setShowAll(true)}');
    expect(setShowAllIdx).toBeGreaterThan(-1);
    const tagStart = EXPLORER.lastIndexOf('<Button', setShowAllIdx);
    const controlsAttr = `aria-controls="${GROUP_REGION_ID}"`;
    const controlsIdx = EXPLORER.indexOf(controlsAttr, tagStart);
    expect(controlsIdx).toBeGreaterThan(tagStart);
    const buttonTag = EXPLORER.slice(tagStart, controlsIdx + controlsAttr.length);
    expect(buttonTag).toContain('aria-expanded={showAll}');
    expect(buttonTag).toContain(controlsAttr);
    expect(buttonTag).not.toContain('aria-hidden');
  });

  it('the controlled region carries the matching id exactly once', () => {
    expect(EXPLORER.match(new RegExp(`id="${GROUP_REGION_ID}"`, 'g')) ?? []).toHaveLength(1);
    expect(EXPLORER).toContain(`<ul id="${GROUP_REGION_ID}"`);
  });

  it('hidden groups stay OMITTED from the DOM — no aria-hidden and no CSS-only hiding', () => {
    const regionLine = EXPLORER.split('\n').find((line) => line.includes(`id="${GROUP_REGION_ID}"`)) ?? '';
    expect(regionLine).not.toContain('aria-hidden');
    expect(regionLine).not.toMatch(/hidden(?![a-zA-Z])/);
    // No visibility-toggling utility classes were introduced for the groups.
    expect(EXPLORER).not.toMatch(/invisible|opacity-0|display:\s*none/);
    // The window is enforced by slicing the array (omission), which Test A pins.
    expect(EXPLORER).toContain('groups.slice(0, DEFAULT_VISIBLE_GROUPS)');
  });

  it('the live region states the disclosure only when something is hidden, in both languages', () => {
    expect(EXPLORER).toContain('groups shown — use Show all to see the rest.');
    expect(EXPLORER).toContain('yameonyeshwa — tumia Onyesha makundi yote kuona mengine.');
    // Two summary clauses + the button's own guard.
    expect(EXPLORER.match(/hiddenGroupCount > 0/g) ?? []).toHaveLength(3);
    // The Swahili instruction names the button by the label it actually renders.
    expect(EXPLORER).toContain('Onyesha makundi yote ${groups.length}');
  });
});
