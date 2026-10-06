// RETURN4ME HOMEPAGE BATCH 4 — Browse + Discovery clarity.
//
// Source-level, matching this repository's established tripwire strategy (no DOM
// harness exists; these assert against the real shipped TSX).
//
// WHAT THIS BATCH IS: the homepage's discovery section is a BROWSE surface, but
// its CTA was worded "Find My Lost Item" while the handler it has always called
// (`setView('owner')`) opens the public found-item SEARCH. The label and the
// destination disagreed. This batch aligns the label with the destination, names
// the landmark, states the journey honestly, and gives the error state a retry.
//
// WHAT THIS BATCH IS NOT — each is a deliberate tripwire, failing if a later
// change drifts back into the behaviours Batch 4 refused to introduce:
//   * no /browse route, and no duplication of OwnerView's search surface
//   * no second fetch of /api/items/search (the retry re-invokes App's existing
//     fetchRecentItems; the data source and polling are untouched)
//   * no change to the /item/:id card links or to the claim/auth handoff
//   * no invented totals — the homepage only ever receives a 4-item slice, so
//     the status line reports the number RENDERED and never an N it cannot know
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/** Source with comments removed, so documentation cannot satisfy a copy
 *  assertion and cannot defeat a "must not appear" tripwire. */
const stripComments = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const homeViewTsx = read('src/components/HomeView.tsx');
const homeCode = stripComments(homeViewTsx);
const publicItemTsx = read('src/components/PublicItemView.tsx');
const publicItemCode = stripComments(publicItemTsx);
const appTsx = read('src/App.tsx');
const publicRoutesTs = read('src/utils/publicRoutes.ts');
const sectionHeadingTsx = read('src/components/ui/SectionHeading.tsx');
const navbarTsx = read('src/components/Navbar.tsx');
const ownerViewTsx = read('src/components/OwnerView.tsx');

// The discovery section, sliced out of the homepage so every assertion below is
// about THIS section and cannot be satisfied by a string elsewhere on the page.
const discoveryStart = homeCode.indexOf('id="found-items"');
const discoveryEnd = homeCode.indexOf('id="how-it-works"');
const DISCOVERY = homeCode.slice(discoveryStart, discoveryEnd);

describe('HOMEPAGE BATCH 4 — discovery CTA wording', () => {
  it('names the CTA for the browse surface it actually opens, in both languages', () => {
    expect(DISCOVERY).toContain("lang === 'en' ? 'Browse Found Items' : 'Vinjari Vitu Vilivyopatikana'");
  });

  it('still routes through the existing owner/browse view — the handler is unchanged', () => {
    // The whole point: this only relabelled an existing destination. It did not
    // re-point the CTA, and it did not add a route.
    expect(DISCOVERY).toContain("onClick={() => setView('owner')}");
  });

  it('no longer presents the discovery CTA as a lost-item recovery action', () => {
    expect(DISCOVERY).not.toContain('Find My Lost Item');
    expect(DISCOVERY).not.toContain('Pata Kitu Kilichopotea');
  });

  // BATCH 5 (MF-3) SUPERSEDES this assertion, and this comment is the record of
  // why. Batch 4 pinned the hero's one-off "Find My Lost Item" so that a change
  // to the DISCOVERY section could not silently drag the hero along with it.
  // That tripwire did its job. Batch 5 then found the pinned string was itself
  // the defect: it was the only "Find My Lost Item" in the entire application,
  // and it lived on a slide whose heading addresses the person who FOUND
  // something. Batch 5 relabelled that hero CTA to `t.ownerBtn`
  // ("I Lost Something") — the canonical public-navigation label already used by
  // the Navbar, the drawer, the bottom tab bar and this page's own Final CTA —
  // WITHOUT touching its destination.
  //
  // The scope Batch 4 actually protected is preserved below: the discovery
  // section's own CTA, handler, journey line, landmark and masking are still
  // asserted, and the hero destination is still asserted (in the tests that
  // follow, which now check the destination rather than the retired wording).
  it('leaves the hero CTA on the /lost destination and the /lost page title alone', () => {
    expect(homeViewTsx).toContain("view: 'owner'");
    expect(read('src/types.ts')).toContain("ownerTitle: 'Find My Lost Item'");
  });
});

describe('HOMEPAGE BATCH 4 — discovery journey explanation', () => {
  it('explains the real journey in both languages', () => {
    expect(DISCOVERY).toContain('Browse found items → open an item to see its details → select “It’s Mine” to begin a claim.');
    expect(DISCOVERY).toContain('Vinjari vitu vilivyopatikana → fungua kitu kuona maelezo yake → chagua “Ni Yangu” kuanza dai.');
  });

  it('makes no promise about ownership, recovery or payment', () => {
    for (const overclaim of ['guaranteed', 'guarantee', 'instantly yours', 'you will receive']) {
      expect(DISCOVERY.toLowerCase()).not.toContain(overclaim);
    }
  });
});

describe('HOMEPAGE BATCH 4 — discovery landmark identity', () => {
  it('the section is addressable and labelled by its own heading', () => {
    expect(homeViewTsx).toContain('id="found-items"');
    // The heading id reaches the <h2> through the shared SectionHeading's
    // optional titleId, so aria-labelledby resolves to a real heading element
    // rather than to a wrapper div.
    expect(DISCOVERY).toContain('titleId="found-items-heading"');
    expect(DISCOVERY).toContain('aria-labelledby="found-items-heading"');
  });

  it('the ids are unique in HomeView.tsx — no duplicate anchor targets', () => {
    expect(homeViewTsx.match(/id="found-items"/g) || []).toHaveLength(1);
    expect(homeViewTsx.match(/titleId="found-items-heading"/g) || []).toHaveLength(1);
    // Every id the page can emit, however it is passed, is distinct.
    const allIds = [
      ...[...homeViewTsx.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]),
      ...[...homeViewTsx.matchAll(/\btitleId="([^"]+)"/g)].map(m => m[1]),
    ];
    expect(allIds).toContain('found-items');
    expect(allIds).toContain('found-items-heading');
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('the heading id is rendered on the real <h2>, not on a wrapper', () => {
    expect(sectionHeadingTsx).toMatch(/<h2 id=\{titleId\}/);
  });
});
describe('HOMEPAGE BATCH 4 — honest result status', () => {
  it('is a polite status region', () => {
    expect(DISCOVERY).toContain('role="status"');
    expect(DISCOVERY).toContain('aria-live="polite"');
  });

  it('covers loading, error, empty and populated states', () => {
    expect(DISCOVERY).toContain('Loading recently found items…');
    expect(DISCOVERY).toContain('Recently found items could not be loaded.');
    expect(DISCOVERY).toContain('No recently found items are available right now.');
    expect(DISCOVERY).toContain('recently found item${recentItems.length === 1');
  });

  it('reports only the number rendered — it never claims a total it cannot know', () => {
    // The homepage is handed a 4-item slice, so a "of N" total would be a lie.
    expect(DISCOVERY).toContain('${recentItems.length} recently found item');
    expect(DISCOVERY).not.toMatch(/of\s+\{?[A-Za-z]/);
    expect(DISCOVERY.toLowerCase()).not.toContain('total');
  });

  it('the skeleton container carries loading semantics and keeps its layout', () => {
    expect(DISCOVERY).toContain('aria-busy={recentItemsLoading}');
    // Layout and skeleton count are explicitly preserved.
    expect(DISCOVERY).toContain('grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4');
    expect(DISCOVERY).toContain('[1, 2, 3].map');
  });
});

describe('HOMEPAGE BATCH 4 — discovery error retry', () => {
  it('offers a retry that calls the EXISTING fetch function', () => {
    expect(DISCOVERY).toContain('onClick={onRetryRecentItems}');
    expect(DISCOVERY).toContain("lang === 'en' ? 'Try Again' : 'Jaribu Tena'");
  });

  it('is the shared Button, inside the existing EmptyState action slot', () => {
    expect(DISCOVERY).toMatch(/<EmptyState[\s\S]*?action=\{[\s\S]*?<Button variant="accent" size="sm"/);
    expect(read('src/components/ui/EmptyState.tsx')).toContain('{action && <div className="pt-2">{action}</div>}');
  });

  it('re-invokes App fetchRecentItems rather than adding a second request', () => {
    // Exactly one wiring, no new endpoint, no page reload.
    expect(appTsx.match(/onRetryRecentItems=\{fetchRecentItems\}/g) || []).toHaveLength(1);
    expect(DISCOVERY).not.toMatch(/fetch\(|window\.location|reload\(/);
  });

  it('leaves fetchRecentItems itself, its polling and its guards untouched', () => {
    const at = appTsx.indexOf('const fetchRecentItems');
    const fn = appTsx.slice(at, at + 1400);
    expect(fn).toContain("fetch('/api/items/search', { signal: controller.signal })");
    expect(fn).toContain('isFetchingRecentItemsRef');
    expect(fn).toContain('recentItemsAbortRef');
    expect(fn).toContain('sorted.slice(0, 4)');
    expect(appTsx).toContain('setInterval(fetchRecentItems, 45000)');
  });

  it('does not add retry to unrelated sections', () => {
    // The prop is declared once in HomeViewProps and destructured once — that is
    // not "usage". The tripwire is on the rendered CONTROL: exactly one retry
    // button exists on the page, and it is inside the discovery section.
    expect(homeCode.match(/onClick=\{onRetryRecentItems\}/g) || []).toHaveLength(1);
    const outside = homeCode.slice(0, discoveryStart) + homeCode.slice(discoveryEnd);
    expect(outside).not.toContain('Try Again');
    expect(outside).not.toContain('onClick={onRetryRecentItems}');
    expect(outside).not.toContain('<RefreshCw');
  });
});
describe('HOMEPAGE BATCH 4 — public item back-link wording', () => {
  it('the label now describes the homepage it actually returns to', () => {
    expect(publicItemTsx).toContain("t('Back to home', 'Rudi nyumbani')");
    expect(publicItemCode).not.toContain('Back to found items');
  });

  it('changes wording ONLY — the handler and destination are untouched', () => {
    expect(publicItemTsx).toContain('onClick={handleClaimClick}');
    expect(publicItemTsx).toContain('onBack();');
    expect(appTsx).toContain("onBack={() => navigate('/', 'home')}");
  });

  it('does not alter the "It\'s Mine" authentication handoff', () => {
    expect(publicItemTsx).toContain("fetch('/api/customer/me', { credentials: 'same-origin' })");
    expect(publicItemTsx).toContain('onContinueClaim(item)');
    expect(publicItemTsx).toContain('onRequireAuth()');
    expect(appTsx).toContain("navigate(accountPath(itemPath(route.itemId)), 'home')");
  });
});

describe('HOMEPAGE BATCH 4 — preservation tripwires', () => {
  it('adds no /browse route and no browse view', () => {
    expect(publicRoutesTs).not.toContain("'/browse'");
    expect(publicRoutesTs).not.toMatch(/BROWSE/);
    expect(publicRoutesTs).toContain("{ path: LOST_PATH, view: 'owner' }");
  });

  it('leaves OwnerView — the browse surface — completely unmodified', () => {
    // Browse is still surfaced through OwnerView; Batch 4 renamed a homepage
    // label, it did not rebuild or duplicate the search implementation.
    expect(ownerViewTsx).toContain("fetch(`/api/items/search?${params.toString()}`)");
    for (const f of ['county', 'administrativeUnitId', 'area', 'categoryId']) {
      expect(ownerViewTsx).toContain(f);
    }
  });

  it('keeps the discovery cards linking to /item/:id', () => {
    expect(homeViewTsx).toContain('href={`/item/${encodeURIComponent(item.id)}`}');
    expect(homeViewTsx).toContain('onOpenItem(item.id)');
  });

  it('keeps sensitive-document masking on the discovery cards', () => {
    expect(homeViewTsx).toContain('is_sensitive_document');
    expect(homeViewTsx).toContain('Photo hidden for privacy');
    for (const privateField of ['contact_phone', 'finder_phone', 'document_number', 'latitude', 'longitude']) {
      expect(homeViewTsx).not.toContain(privateField);
    }
  });

  it('keeps the Batch 3 appearance-token migration and the hero carousel', () => {
    expect(homeViewTsx).toContain('bg-[var(--appearance-surface)] py-14');
    expect(homeViewTsx).toContain('id="how-it-works"');
    expect(homeViewTsx).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')");
    expect(homeViewTsx).toContain('aria-roledescription="carousel"');
  });

  it('keeps the Navbar Batch 1/2 contracts, including no public Agent Portal', () => {
    expect(navbarTsx).toContain('accountSignedIn');
    expect(navbarTsx).toContain('onOpenAccount');
    const navCode = stripComments(navbarTsx);
    expect(navCode).not.toMatch(/['"]\/agent_portal['"]\s*[,}]/);
  });

  it('does not reorder the homepage sections', () => {
    // Anchors chosen from RENDERED markup only (not imports, not comments), so
    // this asserts the order a visitor actually scrolls through.
    const body = homeViewTsx.slice(homeViewTsx.indexOf('return ('));
    const order = [
      'aria-roledescription="carousel"',           // 1. hero
      'Vetted Agents Only',                        // 2. trust strip
      'Found something? Help it find its way home.', // 3. Earn & Return
      'id="found-items"',                         // 4. Recently found
      'id="how-it-works"',                        // 5. How it works
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = body.indexOf(marker);
      expect(at, `section anchor missing: ${marker}`).toBeGreaterThan(-1);
      expect(at, `section out of order: ${marker}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });
});


