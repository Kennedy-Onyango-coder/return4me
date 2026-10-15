import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// FOUND-ITEMS TAB — RESULT ANNOUNCEMENT + GECODING FLAG PRESENTATION
// =============================================================================
// A broken working-tree edit once dropped the found-items result-count
// announcement into the FILTERS panel, where it referenced `filteredItems` —
// a binding that only exists inside the later "Items Render Grid" IIFE — and
// left a stray `<div key="results-start">` that swallowed the filters-grid
// closing tag, unbalancing the whole tab's JSX. The re-applied fix:
//   1. the live region lives inside the results scope, derived from the SAME
//      `filteredItems` the grid renders (never an unfiltered backend total);
//   2. it is rendered in BOTH return branches, so the live region stays
//      mounted and only its text changes when filters flip the result set;
//   3. the "Needs Geocoding" hub flag is action-required (`warning`), not a
//      failure (`danger` — reserved for suspensions and payout refusals).
// Source-level tripwires in the established style of this repository (there is
// no jsdom / React Testing Library harness here — see adminConsoleShell.test.ts
// and adminConsoleSectionChrome.test.ts).
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const adminView = read('src/components/AdminView.tsx');

/** De-comment, so an assertion is about shipped code and not about the prose
 *  that explains it. */
const decomment = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const code = decomment(adminView);

/** Slices a region between two unique marker comments and de-comments it. */
function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`marker not found: ${from} -> ${to}`);
  return decomment(source.slice(start, end));
}

// The whole found-items tab, from its TAB CONTENT marker to the next tab's.
const FOUND_ITEMS_TAB = sliceBetween(
  adminView,
  '{/* TAB CONTENT: ALL FOUND ITEMS REAL-TIME DIRECTORY */}',
  '{/* TAB CONTENT: CLAIMS ADMINISTRATION (PHASE 6F) */}'
);
const FILTERS_PANEL = sliceBetween(
  adminView,
  '{/* Filters Panel */}',
  '{/* Items Render Grid */}'
);
const RESULTS_GRID = sliceBetween(
  adminView,
  '{/* Items Render Grid */}',
  '{/* TAB CONTENT: CLAIMS ADMINISTRATION (PHASE 6F) */}'
);

describe('Found-items announcement: it lives where filteredItems is in scope', () => {
  it('is rendered inside the results IIFE, not in the filters panel', () => {
    expect(FILTERS_PANEL).not.toContain('resultAnnouncement');
    expect(RESULTS_GRID).toContain('const resultAnnouncement');
  });

  it('derives the count from the same filtered set the grid renders', () => {
    // The announcement is built AFTER the filter pass, from `filteredItems` —
    // so the announced number can never drift from the rendered cards.
    expect(RESULTS_GRID.indexOf('const filteredItems =')).toBeLessThan(
      RESULTS_GRID.indexOf('const resultAnnouncement')
    );
    expect(RESULTS_GRID).toContain(
      '`Showing ${filteredItems.length} of ${totalItems} found items`'
    );
  });


  it('states the unfiltered total separately, never as the result count', () => {
    expect(RESULTS_GRID).toContain('const totalItems = dashboardData.items.length;');
    // The "Showing X of Y" shape is the only place the total appears — the
    // zero branches never dress the total up as a filtered figure.
    expect(RESULTS_GRID).toContain("'No found items available'");
    expect(RESULTS_GRID).toContain("'No items match your current search and filters'");
  });
});

describe('Found-items announcement: the live region contract', () => {
  it('announces politely and atomically as a status', () => {
    expect(RESULTS_GRID).toContain('role="status"');
    expect(RESULTS_GRID).toContain('aria-live="polite"');
    expect(RESULTS_GRID).toContain('aria-atomic="true"');
  });

  it('renders in BOTH return branches so the live region never unmounts', () => {
    // A live region that unmounts with its content cannot announce the change
    // that removed it; both branches therefore start with the same element.
    expect((RESULTS_GRID.match(/\{resultAnnouncement\}/g) || []).length).toBe(2);
  });
});

describe('Found-items tab: the structural break does not return', () => {
  it('leaves no stray results-start div', () => {
    expect(adminView).not.toContain('results-start');
  });

  it('keeps the filters grid balanced: search, status, flag — nothing else', () => {
    // The stray div previously swallowed this closing tag. The panel now
    // contains exactly the three filter controls and nothing referencing the
    // results scope.
    expect(FILTERS_PANEL).not.toContain('filteredItems');
    expect(FILTERS_PANEL).toContain('id="item-search"');
    expect(FILTERS_PANEL).toContain('id="item-status-filter"');
    expect(FILTERS_PANEL).toContain('id="item-flag-filter"');
  });

  it('does not override the search field\u2019s visible label with an aria-label', () => {
    // Input.tsx already links `label="Search Items"` via htmlFor/id; an
    // aria-label would REPLACE that accessible name (WCAG 2.5.3 Label in
    // Name requires it to contain the visible label text).
    expect(FILTERS_PANEL).not.toContain('aria-label=');
    expect(code).toMatch(/label="Search Items"\s*\n\s*id="item-search"/);
  });
});

describe('Agent hub rows: Needs Geocoding is action-required, not a failure', () => {
  it('renders the flag with the warning variant', () => {
    expect(code).toContain('<Badge variant="warning">Needs Geocoding</Badge>');
  });

  it('never dresses it in the danger variant reserved for suspensions/refusals', () => {
    expect(code).not.toContain('<Badge variant="danger">Needs Geocoding</Badge>');
  });
});

describe('Found-items results grid: native list semantics', () => {
  it('renders the recovered-item cards as a real list, not as div soup', () => {
    // Native `ul`/`li` is the repository's convention for every card collection
    // (LostReportsSection and PossibleMatches wrap their cards the same way), and
    // no file in this project uses `role="list"` / `role="listitem"` — so the
    // list is announced by the element itself rather than by ARIA.
    expect(RESULTS_GRID).toContain('<ul className="grid grid-cols-1 xl:grid-cols-2 gap-4">');
    expect(RESULTS_GRID).toContain('<li key={item.id}');
    expect(RESULTS_GRID).not.toContain('<div className="grid grid-cols-1 xl:grid-cols-2 gap-4">');
    expect(RESULTS_GRID).not.toContain('role="list"');
  });

  it('keeps the responsive grid on the list itself, so the layout is unchanged', () => {
    // The grid classes moved onto the `ul` (not onto a wrapper), so the
    // single-column -> two-column xl breakpoint and the gap are preserved, and
    // the card keeps its own flex/md:flex-row classes.
    expect(RESULTS_GRID).toContain('grid grid-cols-1 xl:grid-cols-2 gap-4');
    expect(RESULTS_GRID).toContain('md:flex-row gap-5');
  });

  it('balances the list: one card template, one item element, one list element', () => {
    const count = (re: RegExp) => (RESULTS_GRID.match(re) || []).length;
    expect(count(/<li /g)).toBe(1);
    expect(count(/<\/li>/g)).toBe(1);
    expect(count(/<ul /g)).toBe(1);
    expect(count(/<\/ul>/g)).toBe(1);
  });
});
