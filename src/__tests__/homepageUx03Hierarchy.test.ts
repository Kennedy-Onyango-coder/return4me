// =============================================================================
// RETURN4ME UX-03 — HOMEPAGE EDITORIAL HIERARCHY, DISCOVERY & RESPONSIVE POLISH
// =============================================================================
// Source-level tripwires, matching this repository's established technique: the
// project has no jsdom / RTL harness, so every contract below is asserted
// against the source that actually ships.
//
// WHAT THIS SUITE PINS (and what each test would catch if a later change tried
// to undo it):
//   * the hero still tells ONE dominant story per slide: four slides, exactly
//     one primary action and one subordinate secondary on each, on the
//     destinations the application really has;
//   * the hero is readable, controllable and pausable: the real photograph and
//     its directional scrim, the 44px prev/next controls, a 44px slide
//     indicator that states its position (not colour alone), reduced motion for
//     both the CSS transition and the animated panel, and WCAG 2.2.2
//     pause/stay-stopped behaviour the page never had before;
//   * the discovery section renders a real lost-and-found catalogue: image,
//     category, description, found location, date and reference, with status
//     badges reserved for the states that are actually news and no private
//     field anywhere;
//   * the loading / empty / error states stay deliberate;
//   * the homepage is on the UX-01 ladders (type, radius, elevation, spacing,
//     icon) with no sub-12px text, no local focus treatment and no raw palette
//     where a semantic appearance token exists - in BOTH themes;
//   * the page shares ONE container with the public navbar, and no route, auth
//     or dashboard surface is touched.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/** Source with comments removed, so documentation can neither satisfy a
 *  "must exist" pin nor defeat a "must never come back" tripwire. */
const stripComments = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const homeViewTsx = read('src/components/HomeView.tsx');
const homeCode = stripComments(homeViewTsx);
const explorerTsx = read('src/components/home/CategoryExplorer.tsx');
const explorerCode = stripComments(explorerTsx);
const sectionHeadingTsx = stripComments(read('src/components/ui/SectionHeading.tsx'));
const buttonTsx = read('src/components/ui/Button.tsx');
const indexCss = read('src/index.css');
const navbarTsx = read('src/components/Navbar.tsx');
const publicRoutesTs = read('src/utils/publicRoutes.ts');

/* The hero, sliced from RENDERED markup: from the carousel's own region
   attribute to the trust strip that follows it. Deliberately not sliced on a
   comment marker (comment stripping removes those) and not on the whole file,
   so a hero assertion can never be satisfied by a string further down the
   page. */
const HERO = homeCode.slice(
  homeCode.indexOf('aria-roledescription="carousel"'),
  homeCode.indexOf('Vetted Agents Only'),
);
/* The discovery section, sliced between its own anchors. */
const DISCOVERY = homeCode.slice(
  homeCode.indexOf('id="found-items"'),
  homeCode.indexOf('id="how-it-works"'),
);

describe('UX-03 hero - one dominant, editorial story per slide', () => {
  it('keeps the four-slide storyline and its rotation timer intact', () => {
    expect(homeCode).toContain('const slides: HeroSlide[] = [');
    // Four real slides, four photos.
    expect((homeCode.match(/img: '/g) || []).length).toBe(4);
    // The rotation is still a 4-slide cycle on the same interval.
    expect(homeCode).toContain('((i % 4) + 4) % 4');
    expect(homeCode).toContain('}, 6500);');
  });

  it('gives every slide exactly one primary action and one subordinate fallback', () => {
    // One obvious primary action per hero state: each slide renders exactly two
    // controls - the primary and its subordinate fallback. The secondary is the
    // subordinate `inverse` variant, never a second primary and never the
    // financial/recovery `accent`, which is reserved for claim and pay.
    expect((HERO.match(/<Button/g) || []).length).toBe(2);
    expect((HERO.match(/<Button\s+variant="primary"/g) || []).length).toBe(1);
    expect((HERO.match(/<Button\s+variant="inverse"/g) || []).length).toBe(1);
    expect(HERO).toContain('handleSlideAction(s.primary)');
    expect(HERO).toContain('handleSlideAction(s.secondary)');
    expect(HERO).not.toContain('variant="accent"');
    expect(HERO).not.toContain('variant="secondary"');
  });

  it('keeps the hero actions on the existing public destinations only', () => {
    expect(homeCode).toContain("{ label: t.ownerBtn, view: 'owner' }");
    expect(homeCode).toContain("view: 'becomeAgent'");
    expect((homeCode.match(/scroll: true/g) || []).length).toBe(3);
    expect((homeCode.match(/getElementById\('([^']+)'\)/) || [])[1]).toBe('how-it-works');
    // The Agent Portal and the admin console are not public destinations.
    expect(homeCode).not.toMatch(/view: 'agent'/);
    expect(homeCode).not.toMatch(/view: 'admin'/);
    expect(homeCode).not.toMatch(/setView\('admin'\)/);
    expect(homeCode).not.toMatch(/setView\('agent'\)/);
  });

  it('uses the shared Button and does not restate the height it owns', () => {
    expect(homeCode).toContain("import Button from './ui/Button'");
    // UX-02 precedent: the 44px floor lives in the primitive (Button lg is
    // 52px), not in a per-call min-height or px literal. Neither hero action
    // passes a className at all.
    expect(HERO).not.toMatch(/<Button[^>]*className=/);
    expect(buttonTsx).toContain("lg: 'h-13 px-6 text-body-large rounded-standard'");
  });

  it('puts the headline on the locked display ladder, not an arbitrary size', () => {
    expect(HERO).toContain('text-page sm:text-display lg:text-hero');
    expect(HERO).toContain('text-body sm:text-body-large');
    // No arbitrary size and no off-ladder Tailwind type step in the hero.
    expect(HERO).not.toMatch(/text-\[\d+px\]/);
    expect(HERO).not.toMatch(/leading-\[/);
    expect(HERO).not.toMatch(/text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?![\w-])/);
    for (const step of ['--text-page: 2rem', '--text-display: 2.5rem', '--text-hero: 3rem']) {
      expect(indexCss, `${step} must be the locked ladder step it names`).toContain(step);
    }
  });

  it('keeps the real photography, its responsive sources and its scrim', () => {
    expect(HERO).toContain('type="image/webp"');
    expect(HERO).toContain("alt={active ? s.alt : ''}");
    expect(HERO).toContain('r4m-hero-scrim');
    expect(indexCss).toContain('.r4m-hero-scrim');
    // The first slide is still the high-priority paint; the rest decode off the
    // main thread.
    expect(HERO).toContain("fetchPriority={i === 0 ? 'high' : 'auto'}");
    expect(HERO).toContain('decoding="async"');
    expect(HERO).toContain('object-cover');
  });

  it('honours reduced motion in the CSS transition AND the animated panel', () => {
    expect(homeCode).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')");
    expect(homeCode).toContain('motion-reduce:transition-none');
    // The slide panel is animated by JS, which the global CSS policy cannot
    // reach; it now reads the same reduced-motion flag the carousel already had.
    expect(homeCode).toContain('duration: reducedMotion ? 0 : 0.4');
  });

  it('is pausable and stays stopped once the visitor takes control (WCAG 2.2.2)', () => {
    // Reading it (pointer over / focus inside) holds the rotation still.
    expect(homeCode).toContain('onMouseEnter={() => setRotationPaused(true)}');
    expect(homeCode).toContain('onMouseLeave={() => setRotationPaused(false)}');
    expect(homeCode).toContain('onFocus={() => setRotationPaused(true)}');
    expect(homeCode).toContain('onBlur={() => setRotationPaused(false)}');
    // Taking control (a dot, an arrow, a swipe or an arrow key) stops it.
    expect(homeCode).toContain('setRotationStopped(true)');
    // ...and the timer honours all three reasons to stand still.
    expect(homeCode).toContain('if (reducedMotion || rotationPaused || rotationStopped) return;');
    expect(homeCode).toContain('[reducedMotion, rotationPaused, rotationStopped]');
  });

  it('states the current slide with position, size, colour and state', () => {
    // Position in the accessible name, in both languages.
    expect(HERO).toContain('`Go to slide ${i + 1} of ${slides.length}`');
    expect(HERO).toContain('kati ya ${slides.length}');
    // The tablist itself is named in both languages.
    expect(HERO).toContain("aria-label={lang === 'en' ? 'Slide indicator' : 'Kiashiria cha slaidi'}");
    // The relationship and the selected state remain wired.
    expect(HERO).toContain('id={`r4m-hero-tab-${i}`}');
    expect(HERO).toContain('aria-controls={`r4m-hero-panel-${i}`}');
    expect(HERO).toContain('aria-selected={i === current}');
    expect(HERO).toContain("aria-current={i === current ? 'true' : undefined}");
    // Never colour alone: the active indicator also changes SIZE, and the dot
    // itself is decorative (the tab carries the name and the state).
    expect(HERO).toContain("i === current ? 'w-8 h-2 bg-accent-orange' : 'w-2 h-2 bg-white/40");
    expect(HERO).toMatch(/<span\s+aria-hidden="true"/);
  });

  it('keeps every hero control on the 44px touch floor', () => {
    // Prev/next were 40px; the indicator dots were 8px targets.
    expect((HERO.match(/h-11 w-11/g) || []).length).toBe(2);
    expect(HERO).toContain('h-11 min-w-11');
    expect(HERO).not.toContain('w-10 h-10');
    expect(HERO).not.toContain('bottom-5');
  });

  it('composes on a deliberate height and the 8-point rhythm, with no width hacks', () => {
    // The only arbitrary literal left in the hero is the composition height,
    // which is a stated minimum (the section grows with its content) rather
    // than a fixed box - the same documented class of exception as the nav
    // bar's 44px floor.
    expect(HERO).toContain('min-h-[520px] sm:min-h-[560px] lg:min-h-[600px]');
    expect(HERO).toContain('pt-16 pb-20 sm:pt-20 sm:pb-24 lg:pt-28 lg:pb-28');
    expect(HERO).not.toMatch(/w-\[|max-w-\[|overflow-x/);
  });
});

describe('UX-03 discovery - a real lost-and-found catalogue', () => {
  it('renders the fields a visitor needs to recognise an item', () => {
    // Image (or the documented privacy placeholder), category, description,
    // found location, date and reference: all REAL payload fields.
    expect(DISCOVERY).toContain('item.photo_url');
    expect(DISCOVERY).toContain('getCategoryName(item.category_id)');
    expect(DISCOVERY).toContain('item.description');
    expect(DISCOVERY).toContain('item.location_description');
    expect(DISCOVERY).toContain('new Date(item.created_at).toLocaleDateString');
    expect(DISCOVERY).toContain('item.id.substring(0, 8).toUpperCase()');
    // The location row only renders when the payload actually carries one.
    expect(DISCOVERY).toContain('!isSensitive && item.location_description ? (');
  });

  it('exposes no private field and no coordinate', () => {
    for (const field of ['contact_phone', 'finder_phone', 'document_number', 'latitude', 'longitude']) {
      expect(homeViewTsx, `homepage must not read ${field}`).not.toContain(field);
    }
  });

  it('keeps one interaction per card and the /item/:id link that carries it', () => {
    expect((DISCOVERY.match(/<a\s/g) || []).length).toBe(1);
    expect(homeViewTsx).toContain('href={`/item/${encodeURIComponent(item.id)}`}');
    expect(homeViewTsx).toContain('onOpenItem(item.id)');
  });

  it('reserves the status badge for states that are actually news', () => {
    // "Found" is the section's own premise, so a badge on every card was
    // repetition; only claimed / with-agent change what the visitor should do.
    expect(DISCOVERY).toContain("item.status === 'claimed' || item.status === 'at_agent' ? (");
    expect(DISCOVERY).toMatch(/item\.status === 'claimed' \|\| item\.status === 'at_agent' \? \([\s\S]{0,400}<Badge/);
    // The semantic variants and their icons are unchanged.
    expect(DISCOVERY).toContain("const statusVariant = item.status === 'claimed' ? 'warning' : item.status === 'at_agent' ? 'info' : 'success';");
    expect(DISCOVERY).toContain("icon={item.status === 'claimed' ? Lock : ShieldCheck}");
  });

  it('uses typography hierarchy, not bolding everything', () => {
    expect(DISCOVERY).toContain('text-body-large font-semibold');
    expect(DISCOVERY).toContain('text-small');
    expect(DISCOVERY).toContain('text-caption');
    expect(DISCOVERY).not.toContain('text-xs');
    expect(DISCOVERY).not.toMatch(/text-(?:\[)?(?:9|10|11)(?:px)?/);
  });
});
describe('UX-03 states - loading, empty and error stay deliberate', () => {
  it('keeps all three discovery states on the shared primitives', () => {
    expect(homeViewTsx).toContain('recentItemsLoading ? (');
    expect(homeViewTsx).toContain('recentItemsError ? (');
    expect(homeViewTsx).toContain('recentItems.length === 0 ? (');
    expect(homeViewTsx).toContain('<Skeleton shape="rect"');
    expect((homeViewTsx.match(/<EmptyState/g) || []).length).toBe(2);
    // The retry re-invokes the EXISTING App fetch - no second request, no
    // reload, no raw error text.
    expect(DISCOVERY).toContain('onClick={onRetryRecentItems}');
    expect(DISCOVERY).not.toMatch(/fetch\(|window\.location|reload\(/);
    // The category surface keeps its own non-silent failure state too.
    expect(homeCode).toContain('We could not load the list of item types.');
    expect(homeCode).toContain('Hatukuweza kupakia orodha ya aina za vitu.');
  });

  it('never shows a browser-native or raw error string', () => {
    for (const pattern of [/e\.message/, /err\.message/, /response\.text\(\)/, /error\.toString\(\)/]) {
      expect(homeViewTsx, String(pattern)).not.toMatch(pattern);
      expect(explorerTsx, String(pattern)).not.toMatch(pattern);
    }
  });
});

describe('UX-03 homepage-local legacy audit (ladders, focus, palette)', () => {
  it('carries no local focus or outline treatment on the homepage', () => {
    for (const [name, source] of [['HomeView', homeCode], ['CategoryExplorer', explorerCode]] as const) {
      expect(source, `${name} must not suppress or duplicate the global focus ring`)
        .not.toMatch(/focus(-visible)?:(outline-none|ring)/);
      expect(source, `${name} must not use a focus-within ring`).not.toMatch(/focus-within:ring/);
      expect(source, `${name} must not use outline-none`).not.toContain('outline-none');
    }
    // The single global indicator is still the one focus language.
    expect(indexCss).toContain('outline: 2px solid var(--color-accent-orange)');
    expect(indexCss).toContain('.bg-primary-green :focus-visible');
  });

  it('keeps every homepage surface on the radius and elevation ladder', () => {
    for (const [name, source] of [['HomeView', homeCode], ['CategoryExplorer', explorerCode]] as const) {
      expect(source, `${name} must not hand-roll a shadow`)
        .not.toMatch(/shadow-\[|shadow-lg|shadow-xl|shadow-2xl/);
    }
    // Exactly one legacy radius NAME survives in HomeView: the "Earn & Return"
    // media placeholder, whose Batch 3 literal (byte-identical to
    // rounded-standard) is pinned by homepageAppearanceBatch3. Nothing else may
    // use an off-ladder name, and the explorer has none at all.
    expect((homeCode.match(/rounded-(?:md|lg|xl|2xl|3xl)\b/g) || []).length).toBe(1);
    expect(homeCode).toContain('bg-[var(--appearance-surface-muted)] rounded-xl');
    expect((explorerCode.match(/rounded-(?:md|lg|xl|2xl|3xl)\b/g) || []).length).toBe(0);
    // ...and the ladders it leans on are the locked UX-01 ones.
    for (const token of ['--radius-compact: 6px', '--radius-small: 8px', '--radius-standard: 12px', '--radius-panel: 16px', '--radius-hero: 24px']) {
      expect(indexCss, `${token} must exist`).toContain(token);
    }
    expect(indexCss).toContain('--shadow-floating: var(--elevation-floating)');
  });

  it('reads every homepage Lucide icon from the UX-01 ladder', () => {
    expect(homeCode).toContain("import { ICON_SIZE } from './ui/iconSize'");
    expect(homeCode).not.toMatch(/size=\{\d+\}/);
    expect(explorerCode).toContain("import { ICON_SIZE } from '../ui/iconSize'");
    expect(explorerCode).not.toMatch(/size=\{\d+\}/);
    expect(read('src/components/ui/iconSize.ts')).toContain('export const ICON_LADDER');
  });

  it('keeps the homepage on the 8-point spacing rhythm', () => {
    for (const [name, source] of [['HomeView', homeCode], ['CategoryExplorer', explorerCode]] as const) {
      expect(source, `${name} must not invent spacing steps`)
        .not.toMatch(/\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-(?:0\.5|1\.5|2\.5|3\.5|7|9|11|13)\b/);
      expect(source, `${name} must not use an arbitrary spacing value`)
        .not.toMatch(/\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-\[\d/);
    }
  });

  it('has no sub-12px and no arbitrary type anywhere on the homepage', () => {
    for (const [name, source] of [['HomeView', homeCode], ['CategoryExplorer', explorerCode]] as const) {
      expect(source, `${name} must stay on the caption floor`).not.toMatch(/text-\[\d+px\]/);
      expect(source, `${name} must not use a sub-caption size`).not.toMatch(/text-(?:\[(?:9|10|11)px\]|xs)/);
    }
  });
});
describe('UX-03 page hierarchy, grid and theme', () => {
  it('puts every major section heading on the section step', () => {
    // Four sections are headed by the shared SectionHeading, which is passed the
    // opt-in 24/32 step instead of its 18px card-heading default.
    expect((homeCode.match(/titleClassName="text-section"/g) || []).length).toBe(4);
    // Three are hand-written and carry the same step directly.
    for (const id of ['earn-heading', 'returns-heading', 'final-cta-heading']) {
      expect(homeCode, `${id} must sit on the section step`).toContain(`<h2 id="${id}" className="text-section`);
    }
    // The primitive stays additive: its default output is unchanged.
    expect(sectionHeadingTsx).toContain('text-heading font-extrabold tracking-tight');
    expect(sectionHeadingTsx).toContain('titleClassName = \'\'');
  });

  it('uses ONE container and one vertical rhythm across the page', () => {
    // The public navbar grid and the homepage grid are the same container.
    expect(navbarTsx).toContain('mx-auto max-w-7xl px-5 sm:px-12');
    expect((homeCode.match(/mx-auto max-w-7xl px-5 sm:px-12/g) || []).length).toBeGreaterThanOrEqual(8);
    // Eight major sections share the same band rhythm; the closing CTA keeps a
    // narrower column for its centred composition.
    expect((homeCode.match(/py-14 sm:py-20/g) || []).length).toBe(8);
    expect(homeCode).toContain('mx-auto max-w-3xl px-5 sm:px-12');
    expect(homeCode).not.toMatch(/py-\[\d/);
  });

  it('keeps the three responsive grids it already had', () => {
    expect(DISCOVERY).toContain('grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4');
    expect(homeCode).toContain('grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center');
    expect(homeCode).toContain('grid grid-cols-1 md:grid-cols-2 gap-5');
    expect(explorerCode).toContain('grid grid-cols-1 sm:grid-cols-2 gap-4');
  });

  it('is theme-aware: the explorer carries no light-only surface', () => {
    // The explorer used raw light-token surfaces (bg-white, text-ink, ...), so
    // dark mode rendered it as light cards on a dark page.
    expect(explorerCode).not.toMatch(/\bbg-white\b/);
    expect(explorerCode).not.toContain('text-ink');
    expect(explorerCode).not.toContain('line-subtle');
    expect(explorerCode).not.toContain('canvas-muted');
    expect(explorerCode).toContain('bg-[var(--appearance-surface)]');
    expect(explorerCode).toContain('text-[var(--appearance-text-primary)]');
    expect(explorerCode).toContain('border-[var(--appearance-border)]');
    expect(explorerCode).toContain('focus:border-[var(--appearance-focus)]');
    // ...and its search control is a real 44px field on the appearance tokens.
    expect(explorerCode).toContain('h-11 w-full rounded-standard border border-[var(--appearance-border)]');
  });

  it('keeps exactly the two documented fixed brand-green surfaces', () => {
    // The hero's photographic backdrop and the Final CTA band are the brand in
    // BOTH themes by design (Batch 3: "the hero, the final CTA and the icon
    // plates are deliberately brand surfaces"); every other surface uses a
    // semantic appearance token.
    expect((homeCode.match(/bg-primary-green(?![-/\w])/g) || []).length).toBe(2);
    // The hero backdrop and the closing band, on the rendered markup.
    expect(homeCode).toContain('overflow-hidden bg-primary-green');
    expect(homeCode).toContain('className="bg-primary-green py-14 sm:py-20"');
    // A label never sits on the brand ORANGE: the step number moved to the
    // semantic primary pair (white on orange is 2.78:1).
    expect(homeCode).not.toContain('bg-accent-orange text-white');
    expect(homeCode).toContain('bg-[var(--appearance-primary)] text-[var(--appearance-primary-foreground)]');
  });

  it('scopes the orange strictly to decoration', () => {
    // Orange remains the brand's decorative accent (rules, dots, the active
    // indicator, hero highlight text) - never a text background and never the
    // only carrier of state.
    const orange = homeCode.match(/text-accent-orange|bg-accent-orange/g) || [];
    expect(orange.length).toBeGreaterThan(0);
    expect(homeCode).not.toMatch(/bg-accent-orange[^"]*text-white/);
    expect(indexCss).toContain('--color-accent-strong: #B35A00');
  });
});
describe('UX-03 language, copy and boundaries', () => {
  it('keeps every new homepage string bilingual', () => {
    // The slide indicator states its position in both languages.
    expect(HERO).toContain('`Nenda kwenye slaidi ${i + 1} kati ya ${slides.length}`');
    expect(HERO).toContain("'Slide indicator' : 'Kiashiria cha slaidi'");
    // The explorer now offers the two journeys under the canonical labels, which
    // resolve in BOTH languages from types.ts instead of a fourth local wording.
    expect(explorerCode).toContain('{t.ownerBtn}');
    expect(explorerCode).toContain('{t.finderBtn}');
    expect(explorerCode).not.toContain('I lost something');
    expect(explorerCode).not.toContain('I found something');
    expect(read('src/types.ts')).toContain("ownerBtn: 'Nimepoteza Kitu'");
    expect(read('src/types.ts')).toContain("finderBtn: 'Nimepata Kitu'");
    // The discovery catalogue speaks both languages throughout its states.
    for (const pair of ['No description available', 'Hakuna maelezo', 'Photo hidden for privacy', 'Picha imefichwa kwa faragha']) {
      expect(homeViewTsx, `${pair} must survive`).toContain(pair);
    }
  });

  it('uses none of the vague startup vocabulary the brief forbids', () => {
    const copy = stripComments(homeViewTsx);
    for (const banned of [
      'revolutioniz', 'next-generation', 'seamless ecosystem', 'ai-powered',
      'AI powered', 'artificial intelligence', 'unlock possibilities',
      'transforming the future', 'smart platform', 'guaranteed recovery',
      'bank-level', '100% secure',
    ]) {
      expect(copy, `homepage copy must not say "${banned}"`).not.toContain(banned);
    }
  });

  it('adds no route, no new public destination and no dashboard surface', () => {
    // No new route and no new public view: the page's destinations are the ones
    // that already existed.
    expect(publicRoutesTs).not.toContain("'/browse'");
    expect(publicRoutesTs).toContain("{ path: LOST_PATH, view: 'owner' }");
    for (const view of ['owner', 'finder', 'becomeAgent']) {
      expect(homeCode).toContain(`setView('${view}')`);
    }
    // The homepage reaches no authenticated surface and imports no dashboard.
    expect(homeCode).not.toMatch(/AgentView|AdminView|OwnerView|FinderView|DashboardShell/);
    expect(explorerCode).not.toMatch(/AgentView|AdminView|OwnerView|FinderView|DashboardShell/);
    // No fetch, no API contract and no state library entered the homepage.
    expect(homeCode).not.toMatch(/fetch\(/);
    expect(homeCode).not.toMatch(/axios|react-query|redux|zustand/);
  });

  it('touches neither the router nor the authentication handoff', () => {
    for (const pattern of [/useNavigate/, /react-router/, /localStorage/, /sessionStorage/, /\/api\//]) {
      expect(homeCode, String(pattern)).not.toMatch(pattern);
      expect(explorerCode, String(pattern)).not.toMatch(pattern);
    }
  });
});
