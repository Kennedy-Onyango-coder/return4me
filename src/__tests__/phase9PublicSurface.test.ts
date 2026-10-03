import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// PHASE 9 — PUBLIC SURFACE (Requests 01, 03, 06, 13)
// =============================================================================
// Source-level tripwires for the homepage/hero/marketing/category-explorer work.
// Same technique (and the same rationale) as publicNavigation.test.ts: this
// repository has no DOM harness, so the contract is asserted against the real
// source that ships.

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const homeView = read('src/components/HomeView.tsx');
const navbar = read('src/components/Navbar.tsx');
// UX-02: the component deliberately documents the control it replaced, so every
// "must not be present any more" assertion runs against the comment-stripped
// source (the repository's established technique) and can never be satisfied by
// prose.
const navbarCode = navbar.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const indexCss = read('src/index.css');
const explorer = read('src/components/home/CategoryExplorer.tsx');
const taxonomy = read('src/config/categoryTaxonomy.ts');

describe('Request 01 — hero text legibility over the real photograph', () => {
  it('uses the documented directional scrim class instead of a flat black panel', () => {
    expect(homeView).toContain('r4m-hero-scrim');
    expect(indexCss).toContain('.r4m-hero-scrim');
  });

  it('the scrim is directional on larger screens and never an opaque overlay', () => {
    // Direction: full strength at the edge where the copy column sits, fading to
    // transparent across the frame, plus a separate vertical stop.
    expect(indexCss).toMatch(/\.r4m-hero-scrim \{[\s\S]*?linear-gradient\(\s*to bottom/);
    expect(indexCss).toMatch(/@media \(min-width: 640px\) \{[\s\S]*?\.r4m-hero-scrim \{[\s\S]*?linear-gradient\(\s*to right/);
    // Every stop is translucent — no 1.0 alpha anywhere in the scrim.
    const scrimBlock = indexCss.slice(indexCss.indexOf('.r4m-hero-scrim'));
    const alphas = [...scrimBlock.matchAll(/rgba\([^)]*,\s*([0-9.]+)\s*\)/g)].map((m) => Number(m[1]));
    expect(alphas.length).toBeGreaterThan(4);
    expect(Math.max(...alphas)).toBeLessThan(0.8);
  });

  it('the photograph itself is still rendered with its real alt text and responsive sources', () => {
    expect(homeView).toContain('type="image/webp"');
    expect(homeView).toMatch(/srcSet=\{`\/assets\/\$\{s\.img\}-430w\.webp 430w/);
    expect(homeView).toContain("alt={active ? s.alt : ''}");
    // The old token-percentage gradients that caused the complaint are gone.
    expect(homeView).not.toContain('bg-gradient-to-r from-primary-green/20');
    expect(homeView).not.toContain('bg-gradient-to-t from-primary-green/15');
  });
});

describe('Request 03 — homepage marketing describes real capability only', () => {
  // Judged on the human COPY only. Comments are stripped (the section's own
  // explanation says "no guarantees" while describing what it avoids) and every
  // className is stripped too, so a utility class such as "h-10 items-center"
  // cannot be mistaken for a claim about "10 items".
  const copyOnly = homeView
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/className=\{`[\s\S]*?`\}/g, '')
    .replace(/className="[^"]*"/g, '');
  const start = copyOnly.indexOf('One network, four roles');
  const end = copyOnly.indexOf('Ready to get started?');
  const section = copyOnly.slice(start, end);

  it('the section exists and covers all four audiences', () => {
    expect(start).toBeGreaterThan(-1);
    for (const audience of ['Lost something?', 'Found something?', 'Become an Agent', 'Businesses, venues']) {
      expect(section, `missing audience: ${audience}`).toContain(audience);
    }
  });

  it('claims no figure the product cannot prove', () => {
    // No currency amounts, no percentages, no counts, no guarantees.
    expect(section).not.toMatch(/KES\s?\d|Ksh|shillings/i);
    expect(section).not.toMatch(/\d+\s?%/);
    expect(section).not.toMatch(/\d[\d,]*\s+(agents|recoveries|items|users)/i);
    expect(section).not.toMatch(/guarantee|guaranteed|average earnings|per month|monthly income/i);
  });

  it('states the payment rule the platform actually enforces', () => {
    // The fee engine splits a recovery fee; the marketing must describe it as a
    // share of that fee (a real mechanism), never as an amount.
    expect(section).toContain('share of the recovery fee');
    expect(section).toMatch(/never demanded privately/i);
  });

  it('routes each audience through an existing screen, not a new flow', () => {
    expect(section).toContain("setView('owner')");
    expect(section).toContain("setView('finder')");
    expect(section).toContain("setView('becomeAgent')");
  });
});


describe('Request 06 — category explorer over the real category list', () => {
  it('is a presentation layer over the live categories, not a second taxonomy', () => {
    expect(explorer).toContain('resolveTaxonomy');
    // It must not hard-code a category list of its own.
    expect(explorer).not.toMatch(/name_en:/);
    expect(taxonomy).toContain('CATEGORY_TAXONOMY');
  });

  it('drops groups with no live categories instead of advertising them', () => {
    expect(explorer).toContain('if (groups.length === 0 && !isSearching) return null;');
    expect(explorer).toMatch(/\.filter\(\(group\) => group\.categories\.length > 0\)/);
  });

  it('is usable on a phone: searchable, collapsed by default, and announced', () => {
    expect(explorer).toContain('type="search"');
    expect(explorer).toContain('aria-live="polite"');
    expect(explorer).toContain('htmlFor="category-explorer-search"');
    expect(explorer).toContain('DEFAULT_VISIBLE_GROUPS');
    expect(explorer).toMatch(/Show all/);
    // No gradients (the design bar) and no emoji.
    expect(explorer).not.toMatch(/gradient/);
    expect(explorer).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u);
  });

  it('the homepage no longer renders the flat dot-joined wall of categories', () => {
    expect(homeView).not.toContain('const CATEGORY_GROUPS');
    expect(homeView).toContain('<CategoryExplorer');
  });
});

describe('Request 13 — Sign In is a distinct control, not a nav link', () => {
  it('is rendered with the shared Button primitive, not with a nav-link class', () => {
    // UX-02: the hand-rolled `signInButtonClass` (its own 44px height, 13px type
    // step, border and focus stack) is gone for good — Sign In is now the shared
    // Button at `size="md"` (44px / text-body / rounded-standard). "A distinct
    // control, not a nav link" is expressed by the ONE button vocabulary now
    // instead of by a second local class, which is what UX-02 §15 requires.
    expect(navbarCode).toContain("import Button from './ui/Button'");
    expect(navbarCode).not.toContain('signInButtonClass');
    const signInButton = navbarCode.slice(navbarCode.indexOf('<Button'), navbarCode.indexOf('</Button>'));
    expect(signInButton).toContain('size="md"');
    expect(signInButton).toContain('variant="primary"');
    // The 44px floor lives in the primitive, not in a local literal.
    expect(read('src/components/ui/Button.tsx')).toContain("md: 'h-11 px-5 text-body");
  });

  it('keeps readable text in every state (no white-on-light, no gradients)', () => {
    // The control no longer sets a text colour by hand at all: the foreground is
    // the variant's (brand-green surface + its own foreground, ~12:1 in the light
    // theme), so the "white-on-light" defect class cannot return here.
    const signInButton = navbarCode.slice(navbarCode.indexOf('<Button'), navbarCode.indexOf('</Button>'));
    expect(signInButton).toContain('variant="primary"');
    expect(signInButton).not.toMatch(/text-(white|primary-green)|gradient|from-|to-/);
    expect(read('src/components/ui/Button.tsx')).toContain('bg-primary-green hover:bg-primary-hover text-white');
  });

  it('stays reachable and announced', () => {
    expect(navbar).toContain("aria-current={currentView === 'signin' ? 'page' : undefined}");
    const bindings = navbar.match(/handleNavClick\('signin'\)/g) || [];
    expect(bindings.length).toBeGreaterThanOrEqual(3);
  });
});
