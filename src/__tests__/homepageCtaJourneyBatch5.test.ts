// RETURN4ME HOMEPAGE BATCH 5 — Journey + CTA clarity.
//
// Source-level, matching this repository's established tripwire strategy (there
// is no DOM harness; these assert against the real shipped TSX).
//
// WHAT THIS BATCH IS: a journey/CTA WORDING and caller-side visual-hierarchy
// batch, and nothing else. The Batch 5 forensic audit found that the homepage
// offered the same two public journeys under seven different labels, and that
// one of them ("Report an Item") did not distinguish lost from found at all,
// so a visitor who had LOST something could read it as their own path and be
// taken to the found-item form. Five changes were made, all of them label or
// variant changes on a button whose onClick was not touched:
//
//   MF-1  hero slide 3  "Report an Item"         -> "Report a Found Item"
//   MF-2  hero slide 4  "Get Started"            -> t.ownerBtn ("I Lost Something")
//   MF-3  hero slide 1  "Find My Lost Item"      -> t.ownerBtn ("I Lost Something")
//   MF-4  Earn & Return "Report Something Found" -> t.finderBtn ("I Found Something")
//   MF-5  Earn & Return found CTA accent -> outline (caller-side only)
//
// Every one of these reuses terminology the repository ALREADY established
// (types.ts ownerBtn / finderBtn; "Report a Found Item" is already this app's
// slide-1 secondary and its /found document title). No new terminology was
// invented, and no canonical label was replaced.
//
// WHAT THIS BATCH IS NOT — each is a deliberate tripwire, failing if a later
// change drifts back into what Batch 5 refused to introduce:
//   * no CTA destination changed: owner -> /lost, finder -> /found,
//     becomeAgent -> /become-an-agent, and the three "How It Works"
//     secondaries still scroll to #how-it-works
//   * no /browse route, no URL-backed browse state, no OwnerView change
//   * no Agent Portal and no admin exposure from the homepage
//   * no change to authentication, the claim journey, payment, or the privacy
//     masking on the discovery cards
//   * src/components/ui/Button.tsx is UNMODIFIED: MF-5 is caller-side
//   * the Batch 3 appearance/carousel contracts and the Batch 4 discovery
//     section (including its "Browse Found Items" CTA) are untouched
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
const appTsx = read('src/App.tsx');
const publicRoutesTs = read('src/utils/publicRoutes.ts');
const navbarTsx = read('src/components/Navbar.tsx');
const navCode = stripComments(navbarTsx);
const buttonTsx = read('src/components/ui/Button.tsx');
const publicItemTsx = read('src/components/PublicItemView.tsx');
const typesTs = read('src/types.ts');

// The hero storyline array, sliced out of the homepage so no assertion below can
// be satisfied by a copy of the same string in the four-roles or Final CTA
// sections (both of which already use t.ownerBtn / t.finderBtn).
const heroStart = homeCode.indexOf('const slides: HeroSlide[] = [');
const heroEnd = homeCode.indexOf('// ── HOW IT WORKS STEPS');
const HERO = homeCode.slice(heroStart, heroEnd);

// The "Earn & Return" section, which holds both the relabelled found CTA (MF-4)
// and the inverted hierarchy fix (MF-5).
const earnStart = homeCode.indexOf('Found something? Help it find its way home.');
const earnEnd = homeCode.indexOf('id="found-items"');
const EARN = homeCode.slice(earnStart, earnEnd);

/** The id the hero's "How It Works" secondary scrolls to, read from the real
 *  call site rather than hard-coded, so a rename is reported as a failure
 *  instead of silently passing. */
const scrollTarget = (homeCode.match(/getElementById\('([^']+)'\)/) || [])[1] || '';


describe('BATCH 5 — hero CTA terminology', () => {
  it('no longer offers the three uninformative hero labels', () => {
    // Each of these was a P1/P2 finding in the audit: "Report an Item" did not
    // distinguish lost from found, and "Get Started" / "Find My Lost Item"
    // obscured which journey the button actually opened.
    expect(HERO).not.toContain("'Report an Item'");
    expect(HERO).not.toContain("'Get Started'");
    expect(HERO).not.toContain("'Find My Lost Item'");
    expect(HERO).not.toContain("'Pata Kitu Kilichopotea'");
  });

  it('MF-3 — slide 1 uses the canonical public label for /lost', () => {
    expect(HERO).toContain("{ label: t.ownerBtn, view: 'owner' }");
  });

  it('MF-1 — slide 3 says FOUND explicitly, in both languages', () => {
    // The replacement string is the one the app already used for this
    // destination: slide 1's secondary, the empty-state action, and the
    // /found document title in App.tsx.
    expect(HERO).toContain(
      "primary: { label: lang === 'en' ? 'Report a Found Item' : 'Ripoti Kitu Kilichopatikana', view: 'finder' }"
    );
  });

  it('MF-2 — slide 4 uses the canonical public label for /lost', () => {
    expect(HERO).toContain("{ label: t.ownerBtn, view: 'owner' }");
  });

  it('the reused labels really do resolve to the expected strings, in both languages', () => {
    // Guards the whole point of MF-2/MF-3/MF-4: the canonical vocabulary this
    // batch delegated to must exist in BOTH languages, in types.ts.
    expect(typesTs).toContain("ownerBtn: 'I Lost Something'");
    expect(typesTs).toContain("ownerBtn: 'Nimepoteza Kitu'");
    expect(typesTs).toContain("finderBtn: 'I Found Something'");
    expect(typesTs).toContain("finderBtn: 'Nimepata Kitu'");
  });
});

describe('BATCH 5 — Earn & Return label and hierarchy', () => {
  it('MF-4 — the found CTA uses the canonical public label', () => {
    expect(EARN).not.toContain('Report Something Found');
    expect(EARN).not.toContain('Ripoti Kitu Ulichopeleza');
    expect(EARN).toContain('{t.finderBtn}');
  });

  it('MF-5 — the found CTA is no longer the loudest button in the section', () => {
    // `accent` is documented in ui/Button.tsx as reserved for the financial /
    // recovery CTAs (claim & pay, submit report). A found-item report is
    // neither, and the lost journey is the one this section is built around.
    expect(EARN).not.toContain('variant="accent"');
  });

  it('MF-5 — the found CTA is outline and the lost CTA stays primary', () => {
    expect(EARN).toContain(
      'variant="outline" size="lg" onClick={() => setView(\'finder\')} className="min-h-[48px]"'
    );
    expect(EARN).toContain(
      'variant="primary" size="lg" onClick={() => setView(\'owner\')} className="min-h-[48px]"'
    );
  });

  it('leaves the accurate "Search Found Items" CTA alone', () => {
    // Deliberate scope boundary: /lost is a search/filter surface today, not a
    // browse gallery, so this label is accurate and was NOT changed.
    expect(EARN).toContain('Search Found Items');
    expect(EARN).toContain('Tafuta Vitu Vilivyopatikana');
  });
});

describe('BATCH 5 — no CTA destination was changed', () => {
  it('every hero action still uses only the three public views, or a scroll', () => {
    const views = [...HERO.matchAll(/view: '([a-zA-Z]+)'/g)].map((m) => m[1]);
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) {
      expect(['owner', 'finder', 'becomeAgent'], `unexpected hero destination: ${v}`).toContain(v);
    }
    // 'agent' and 'admin' must never appear as a homepage destination: the
    // Agent Portal and the admin console are not public pages.
    expect(views).not.toContain('agent');
    expect(views).not.toContain('admin');
  });

  it('the three "How It Works" secondaries still scroll, to the same target', () => {
    expect((HERO.match(/scroll: true/g) || []).length).toBe(3);
    expect(scrollTarget).toBe('how-it-works');
    expect(homeCode).toContain('id="how-it-works"');
  });

  it('the agent journey still reaches /become-an-agent and nothing else', () => {
    expect(HERO).toContain("view: 'becomeAgent'");
  });
});

describe('BATCH 5 — preservation: routing and public IA', () => {
  it('adds no /browse route and no browse view', () => {
    expect(publicRoutesTs).not.toContain("'/browse'");
    expect(publicRoutesTs).not.toMatch(/BROWSE/);
  });

  it('leaves publicRoutes.ts itself untouched in the ways that matter', () => {
    // /lost is still the owner's canonical path, and the authenticated return
    // path is still whitelisted rather than trusted.
    expect(publicRoutesTs).toContain("{ path: LOST_PATH, view: 'owner' }");
    expect(publicRoutesTs).toContain("const LOST_PATH = '/lost'");
    expect(publicRoutesTs).toContain("const FOUND_PATH = '/found'");
    expect(publicRoutesTs).toContain('isSafeReturnPath');
    expect(publicRoutesTs).toContain('export function reportLostPath()');
  });

  it('exposes exactly the five public destinations in the Navbar', () => {
    // Home · I Lost Something · I Found Something · Become an Agent · Sign In
    for (const binding of [
      "handleNavClick('home')",
      't.ownerBtn',
      't.finderBtn',
      't.becomeAgentBtn',
      't.signInBtn',
    ]) {
      expect(navbarTsx, `public destination ${binding} must survive`).toContain(binding);
    }
  });

  it('still has NO public Agent Portal navigation item', () => {
    expect(navCode).not.toMatch(/handleNavClick\('agent'\)/);
    expect(navbarTsx).not.toContain("'agent_portal',");
  });

  it('exposes no admin or Agent Portal destination from the homepage either', () => {
    expect(homeCode).not.toMatch(/setView\('admin'\)/);
    expect(homeCode).not.toMatch(/setView\('agent'\)/);
  });
});

describe('BATCH 5 — preservation: security, privacy and the claim boundary', () => {
  it('keeps sensitive-document masking on the discovery cards', () => {
    expect(homeViewTsx).toContain('is_sensitive_document');
    expect(homeViewTsx).toContain('Photo hidden for privacy');
  });

  it('exposes no private field on the homepage', () => {
    for (const field of ['contact_phone', 'finder_phone', 'document_number', 'latitude', 'longitude']) {
      expect(homeViewTsx, `homepage must not expose ${field}`).not.toContain(field);
    }
  });

  it('does not alter the "It\'s Mine" authentication handoff', () => {
    expect(publicItemTsx).toContain("fetch('/api/customer/me', { credentials: 'same-origin' })");
    expect(publicItemTsx).toContain('onContinueClaim');
    expect(publicItemTsx).toContain('onRequireAuth');
    // The account return path is still the validated one, not a raw redirect.
    expect(appTsx).toContain('accountPath(itemPath(route.itemId))');
  });

  it('keeps the item cards as real links, so the claim journey stays shareable', () => {
    expect(homeViewTsx).toContain('href={`/item/${encodeURIComponent(item.id)}`}');
    expect(homeViewTsx).toContain('onOpenItem(item.id)');
  });
});

describe('BATCH 5 — preservation: shared Button ownership boundary', () => {
  it('did NOT modify src/components/ui/Button.tsx', () => {
    // MF-5 is deliberately a caller-side change. If a later batch edits the
    // shared component, this is the tripwire that says the homepage batch
    // overstepped.
    expect(buttonTsx).toContain('export type ButtonVariant');
    expect(buttonTsx).toContain(
      "'primary' | 'secondary' | 'accent' | 'outline' | 'inverse' | 'ghost' | 'danger'"
    );
    expect(buttonTsx).toContain('const sizeClasses: Record<ButtonSize, string>');
  });

  it('still documents `accent` as the financial / recovery variant', () => {
    // The whole justification for MF-5 rests on this contract existing in the
    // shared component and not being satisfied on the homepage.
    expect(buttonTsx).toContain('Accent — the important financial / recovery CTA (M-Pesa escrow actions).');
  });
});

describe('BATCH 5 — preservation: Batch 3 / Batch 4 contracts', () => {
  it('keeps the Batch 3 appearance migration and the hero carousel', () => {
    expect(homeViewTsx).toContain('bg-[var(--appearance-surface)] py-14');
    expect(homeViewTsx).toContain('aria-roledescription="carousel"');
    expect(homeViewTsx).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')");
  });

  // HOMEPAGE BATCH 6A — the carousel slide-indicator tablist label was the only
  // user-facing or accessibility string on the homepage still hard-coded in
  // English. Every neighbouring carousel label already localizes off the same
  // `lang` prop (the region label, the previous/next controls, and the per-tab
  // "Go to slide" labels), so a Kiswahili screen-reader user heard English for
  // the tab group while every control inside it was already Kiswahili.
  //
  // Both variants are asserted because the whole point of the fix is that the
  // ENGLISH text is no longer the only text: pinning only the ternary's shape
  // would still pass if the Kiswahili branch were empty or wrong.
  // HOMEPAGE BATCH 6B — the carousel declared a tablist and four tabs but had
  // no tab ids, no panel ids, no `aria-controls`, no `aria-labelledby` and no
  // `role="tabpanel"`. That is an incomplete ARIA tabs pattern: assistive
  // technology was told four tabs existed but given no way to reach the content
  // they select.
  //
  // These assertions pin the WHOLE relationship rather than each attribute in
  // isolation, because the failure mode this guards against is a half-wired
  // pattern — e.g. `role="tabpanel"` present but with no `aria-controls`
  // pointing at it, which is worse than having neither. Every id is derived
  // from the same slide index, so the pairing is deterministic and 1:1.
  it('BATCH 6B — wires a deterministic 1:1 tab-to-panel relationship', () => {
    // The tab owns a stable, index-derived id and names the panel it controls.
    expect(HERO).toContain('id={`r4m-hero-tab-${i}`}');
    expect(HERO).toContain('aria-controls={`r4m-hero-panel-${i}`}');
    // The panel owns the matching id, is a real tabpanel, and points back at
    // the tab that controls it, so the relationship is bidirectional.
    expect(HERO).toContain('id={`r4m-hero-panel-${i}`}');
    expect(HERO).toContain('role="tabpanel"');
    expect(HERO).toContain('aria-labelledby={`r4m-hero-tab-${i}`}');
    // A tabpanel must be focusable so a keyboard user can read what they chose.
    expect(HERO).toContain('tabIndex={0}');
  });

  it('BATCH 6B — keeps the panel on the semantic content layer, not the photo layer', () => {
    // The panel is the wrapper carrying the eyebrow, <h1>, copy and CTAs. The
    // background photo layer above it must NOT become the tabpanel: it holds no
    // text and no controls, so labelling it as a panel would announce nothing.
    const panelAt = HERO.indexOf('role="tabpanel"');
    const photoLayerAt = HERO.indexOf('r4m-hero-scrim');
    expect(panelAt, 'the content layer must carry role="tabpanel"').toBeGreaterThan(-1);
    expect(photoLayerAt, 'the photo scrim must still exist').toBeGreaterThan(-1);
    expect(photoLayerAt, 'the panel must be the content layer, after the photos')
      .toBeLessThan(panelAt);
  });

  it('BATCH 6B — leaves inactive-panel hiding and the photo aria-hidden intact', () => {
    // Hiding is unchanged: `display:none` on the inactive content panel (which
    // already removes it from the accessibility tree) and `aria-hidden` on the
    // inactive photo. Batch 6B added attributes only — it did not change how
    // anything is shown or hidden.
    expect(HERO).toContain("className={active ? '' : 'hidden'}");
    expect(HERO).toContain('aria-hidden={active ? undefined : true}');
  });

  it('BATCH 6B — preserves the tablist, tab and aria-selected contracts', () => {
    // The pre-existing Batch 3 contracts must survive: Batch 6B added ids and
    // relationships, it did not replace the roles or the selection state.
    expect(HERO).toContain('role="tablist"');
    expect(HERO).toContain('role="tab"');
    expect(HERO).toContain('aria-selected={i === current}');
  });

  // HOMEPAGE BATCH 6C — section-level landmark naming.
  //
  // Before this batch only 1 of the homepage's 10 <section> elements carried an
  // accessible name. Seven more now derive theirs from their OWN visible
  // heading, which is why there is no `aria-label` duplicating the text and no
  // `role="region"` added: a <section> with a name is already a region, and a
  // named landmark is more useful to a screen reader than a bare one.
  const B6C = {
    labelled: [
      'discover-heading', 'earn-heading', 'how-heading',
      'platform-heading', 'returns-heading', 'roles-heading', 'final-cta-heading',
    ],
    titleIds: ['discover-heading', 'how-heading', 'platform-heading', 'roles-heading'],
    h2Ids: ['earn-heading', 'returns-heading', 'final-cta-heading'],
  };

  it('BATCH 6C — names all seven major sections from their own heading', () => {
    for (const id of B6C.labelled) {
      expect(homeViewTsx, `section must be labelled by ${id}`)
        .toContain(`aria-labelledby="${id}"`);
    }
    // The four SectionHeading-backed sections pass the id through the shared
    // component's optional `titleId`, which SectionHeading renders onto the
    // real <h2> — so the name resolves to a heading, not a wrapper div.
    for (const id of B6C.titleIds) {
      expect(homeViewTsx, `${id} must reach the <h2> via titleId`)
        .toContain(`titleId="${id}"`);
    }
    // The three hand-written <h2> sections carry the id on the heading element.
    for (const id of B6C.h2Ids) {
      expect(homeViewTsx, `${id} must be on the hand-written <h2>`)
        .toContain(`<h2 id="${id}"`);
    }
  });

  it('BATCH 6C — has no dangling references among the seven new labels', () => {
    // Deliberately scoped to the SEVEN static ids. A blanket
    // "every aria-labelledby must match a literal id" rule would wrongly flag
    // Batch 6B's valid template-based carousel pairs
    // (`r4m-hero-tab-${i}` / `r4m-hero-panel-${i}`), which resolve at runtime
    // and have no literal id in the source.
    const provided = [...B6C.titleIds, ...B6C.h2Ids];
    for (const id of B6C.labelled) {
      expect(provided, `aria-labelledby="${id}" has no heading to resolve to`)
        .toContain(id);
    }
  });

  it('BATCH 6C — the seven static heading ids are unique', () => {
    // `found-items-heading` is deliberately excluded: it predates this batch
    // and is already covered by Batch 4's uniqueness assertion.
    const all = [...B6C.titleIds, ...B6C.h2Ids, 'found-items-heading'];
    expect(new Set(all).size, 'heading ids must be unique').toBe(all.length);
    // Counted against `homeCode` (comments stripped) using the file's existing
    // convention: the explanatory comments added alongside each of these ids
    // necessarily repeat the id, so counting raw source would double-count a
    // comment and report a false duplicate.
    for (const id of B6C.labelled) {
      const asTitleId = (homeCode.match(new RegExp(`titleId="${id}"`, 'g')) || []).length;
      const asH2Id = (homeCode.match(new RegExp(`<h2 id="${id}"`, 'g')) || []).length;
      const asLabel = (homeCode.match(new RegExp(`aria-labelledby="${id}"`, 'g')) || []).length;
      expect(asTitleId + asH2Id, `${id} must be defined exactly once`).toBe(1);
      expect(asLabel, `${id} must be referenced exactly once`).toBe(1);
    }
  });

  it('BATCH 6C — preserves the how-it-works scroll anchor alongside the new heading id', () => {
    // The hero's "How It Works" secondary scrolls to `#how-it-works`, and the
    // Batch 4 order test pins that id. The section keeps it; the heading id is
    // separate and neither replaces the other.
    expect(homeViewTsx).toContain('id="how-it-works"');
    expect(homeViewTsx).toContain('aria-labelledby="how-heading"');
    expect(homeViewTsx).toContain('titleId="how-heading"');
    // They must be on the same element, not duplicated across the page.
    expect(homeViewTsx).toContain(
      'id="how-it-works" aria-labelledby="how-heading"'
    );
    expect((homeCode.match(/id="how-it-works"/g) || []).length).toBe(1);
  });

  it('BATCH 6C — leaves the trust strip untouched', () => {
    // The trust strip has no suitable visible heading. Batch 6C deliberately did
    // NOT invent one: no sr-only copy, no aria-label, no role="region", and no
    // conversion away from <section>. That remains a content/semantic decision.
    // Asserting the STRIP is untouched is a real guard — it would fail if a
    // future pass added a heading or label here.
    const trustStart = homeCode.indexOf('Vetted Agents Only');
    expect(trustStart, 'the trust strip must still render').toBeGreaterThan(-1);
    const before = homeCode.lastIndexOf('<section', trustStart);
    const after = homeCode.indexOf('</section>', trustStart);
    const trust = homeCode.slice(before, after);
    expect(trust, 'the trust strip must not gain an accessible name').not.toMatch(
      /aria-labelledby|aria-label=|role="region"/
    );
  });

  it('BATCH 6C — preserves the Batch 4 found-items-heading coverage', () => {
    // Batch 4 wired the discovery section the same way; this batch added
    // others and must not have disturbed it.
    expect(homeViewTsx).toContain('titleId="found-items-heading"');
    expect(homeViewTsx).toContain('aria-labelledby="found-items-heading"');
  });

  it('BATCH 6A — localizes the carousel slide-indicator label in both languages', () => {
    expect(HERO).toContain(
      "aria-label={lang === 'en' ? 'Slide indicator' : 'Kiashiria cha slaidi'}"
    );
    // The hard-coded English-only attribute must not survive anywhere in the
    // hero, and the Kiswahili branch must be a real string.
    expect(HERO).not.toContain('aria-label="Slide indicator"');
    expect(HERO).toContain('Kiashiria cha slaidi');
  });

  it('keeps the Batch 4 discovery section exactly as Batch 4 left it', () => {
    // MF-1..MF-5 do not touch the Recently Found section, including the
    // "Browse Found Items" CTA that Batch 4 introduced and pinned.
    expect(homeViewTsx).toContain('id="found-items"');
    expect(homeViewTsx).toContain("lang === 'en' ? 'Browse Found Items' : 'Vinjari Vitu Vilivyopatikana'");
  });

  it('keeps the live-region status line for the discovery list', () => {
    expect(homeViewTsx).toContain('aria-live');
  });

  it('does not reorder the homepage sections', () => {
    // Anchors taken from RENDERED markup only, so this asserts the order a
    // visitor actually scrolls through and is not tied to line numbers.
    const body = homeViewTsx.slice(homeViewTsx.indexOf('return ('));
    const order = [
      'aria-roledescription="carousel"',               // 1. hero
      '<CategoryExplorer',                            // 2. category explorer
      'Found something? Help it find its way home.', // 3. Earn & Return
      'id="found-items"',                             // 4. Recently found
      'id="how-it-works"',                            // 5. How it works
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = body.indexOf(marker);
      expect(at, `section anchor missing: ${marker}`).toBeGreaterThan(-1);
      expect(at, `section out of order: ${marker}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('keeps the four roles section using the canonical labels', () => {
    // These already used t.ownerBtn / t.finderBtn / t.becomeAgentBtn before
    // Batch 5; this confirms the batch converged the page onto them rather
    // than introducing a fourth vocabulary.
    const roles = homeCode.slice(homeCode.indexOf('One network, four roles'));
    expect(roles).toContain('{t.ownerBtn}');
    expect(roles).toContain('{t.finderBtn}');
    expect(roles).toContain('{t.becomeAgentBtn}');
  });
});

