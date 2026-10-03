// RETURN4ME HOMEPAGE BATCH 3 - appearance/theme-token migration.
//
// The homepage was the last major public surface still built on hard-coded
// light/brand literals, so selecting Dark in the Navbar produced a dark Navbar
// above a predominantly light page. This batch moves the homepage onto the
// project's EXISTING semantic appearance tokens (index.css :root +
// html[data-theme='dark']), which App already drives through
// `appearance`/`setAppearance` -> `return4me.appearance` -> `data-theme`.
//
// Light-mode parity is guaranteed by construction: every token's light value is
// byte-identical to the literal it replaced (e.g. --appearance-text-primary is
// #003820, exactly --color-primary-green / text-primary-green), so light mode
// is unchanged while dark mode now resolves correctly.
//
// Source-contract tests, matching the repository's established strategy.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

const HOME = read('components/HomeView.tsx');
// Comments are stripped so a literal cannot be "absent" merely because prose
// mentions it, and a token cannot be "present" because a comment shows it.
const code = HOME.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
const CSS = read('index.css');

describe('HOMEPAGE BATCH 3 - appearance token migration', () => {
  // ------------------------------------------- migrated page surfaces
  it('renders page surfaces with the semantic appearance tokens', () => {
    // The light-mode page sections (Trust strip, Earn & Return, Recently found,
    // How it works, One network) are the surface token; the category section and
    // the media placeholders are the muted surface.
    expect(code).toMatch(/section className="bg-\[var\(--appearance-surface\)\]/);
    expect(code).toMatch(/bg-\[var\(--appearance-surface\)\] p-6/);
    expect(code).toMatch(/bg-\[var\(--appearance-background\)\] py-14/);
    expect(code).toMatch(/bg-\[var\(--appearance-surface-muted\)\] rounded-xl/);
  });

  it('renders borders with the semantic border token', () => {
    expect(code).toMatch(/border-\[var\(--appearance-border\)\]/);
  });

  it('renders body text with the semantic text tokens', () => {
    expect(code).toMatch(/text-\[var\(--appearance-text-primary\)\]/);
    expect(code).toMatch(/text-\[var\(--appearance-text-muted\)\]/);
  });

  it('no longer hard-codes the migrated light/brand literals', () => {
    // These are the exact literals the audit found on the homepage. Each has a
    // byte-identical light value in the semantic token set, so all of them are
    // expected to be gone from shipped code. The ONE documented exception is
    // `hover:bg-brand-light-gray` on the inverse button that sits ON brand green
    // (see the "brand-green surfaces" test below): it is part of a fixed
    // light-on-green pairing, not a page surface.
    const EXCEPTED = 'hover:bg-brand-light-gray';
    const scan = code.split(EXCEPTED).join('');
    for (const literal of [
      'bg-brand-beige',
      'bg-brand-light-gray',
      'border-brand-border',
      'border-line-subtle',
      'text-brand-muted-text',
      'text-brand-dark-text',
      'text-ink-muted',
      'text-ink',
    ]) {
      expect(scan, `${literal} must be migrated`).not.toMatch(
        new RegExp('(?<![\\w-])' + literal + '(?![\\w/-])')
      );
    }
  });

  it('uses every appearance token it references from the real theme system', () => {
    // Guard against a typo'd variable that would silently resolve to nothing.
    const used = [...code.matchAll(/var\((--appearance-[a-z-]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of new Set(used)) {
      expect(CSS, `${name} must be defined in index.css`).toContain(`${name}:`);
    }
  });

  // ---------------------------------------- intentionally retained
  it('keeps the brand-green surfaces, which are the brand in both themes', () => {
    // The hero, the final CTA and the icon plates are deliberately brand
    // surfaces, not page surfaces: they must not follow data-theme, or the brand
    // identity would be lost in dark mode.
    expect(code).toContain('bg-primary-green');
    // BATCH 6C: the final CTA section gained an `aria-labelledby` BEFORE its
    // className, so the literal `<section className="bg-primary-green py-14`
    // no longer matches. The contract this test protects is that the final CTA
    // is still the brand-green surface in BOTH themes, so the assertion is
    // relaxed to the section's own class list rather than its attribute order —
    // the colour pairing it guards is unchanged.
    expect(code).toMatch(/<section[^>]*className="bg-primary-green py-14/);
    // The inverse button that sits ON brand green keeps its white fill and its
    // brand text; migrating either would destroy the contrast pairing.
    expect(code).toContain(
      'bg-white hover:bg-brand-light-gray text-primary-green border-white'
    );
  });

  it('keeps photo-overlay and hero-legend literals that are content, not theme', () => {
    // These sit on top of the Nairobi photography, so they are fixed imagery
    // colours by design and must not become theme variables.
    expect(code).toMatch(/bg-white\/40 hover:bg-white\/70/);
    expect(code).toContain('bg-black/30 hover:bg-black/50');
    expect(code).toContain('r4m-hero-scrim');
  });

  it('keeps the accent-orange hero and status accents unchanged', () => {
    expect(code).toContain('text-accent-orange');
    expect(code).toContain('bg-accent-orange');
    expect(code).toContain('text-status-success');
  });

  // ---------------------------------------- architecture preserved
  it('does not create a second appearance state in HomeView', () => {
    // HomeView stays a pure presentation consumer. The appearance value is
    // owned by App and reaches the page only via the root data-theme marker.
    expect(code).not.toMatch(/useState\s*[<(][^)]*(appearance|theme)/i);
    expect(code).not.toMatch(/localStorage/);
    expect(code).not.toMatch(/data-theme/);
    expect(code).not.toMatch(/matchMedia\('\(prefers-color-scheme/);
    expect(code).not.toMatch(/AppearanceControl|AppearancePreference/);
  });

  it('leaves the theme architecture itself untouched', () => {
    // One canonical root marker, one preference key. The token block is matched
    // structurally (selector + a token) rather than by exact whitespace.
    expect(CSS).toContain("html[data-theme='dark']");
    expect(CSS).toMatch(/:root\s*\{[^}]*--appearance-background:/);
    expect(read('utils/appearancePreference.ts')).toContain('return4me.appearance');
  });

  it('keeps the existing prefers-reduced-motion carousel behaviour', () => {
    // Unrelated to the token work and explicitly preserved.
    expect(HOME).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(code).toContain('motion-reduce:transition-none');
  });

  // ---------------------------------------- content / IA preserved
  it('preserves the homepage section order', () => {
    // Section markers in their shipped order.
    const order = [
      'HERO STORY SLIDESHOW',
      'TRUST STRIP',
      'SERVICE DISCOVERY / CATEGORIES',
      'EARN & RETURN MARKETING',
      'RECENT FOUND ITEMS',
      'ONE NETWORK',
      'FINAL CTA',
    ];
    let last = -1;
    for (const marker of order) {
      const at = HOME.indexOf(marker);
      if (at < 0) continue;
      expect(at, `${marker} must come after the previous section`).toBeGreaterThan(last);
      last = at;
    }
  });

  it('preserves the CTA destinations', () => {
    for (const view of ['owner', 'finder', 'becomeAgent']) {
      expect(code).toContain(`setView('${view}')`);
    }
  });

  it('preserves the carousel and accessibility contracts', () => {
    expect(code).toContain('aria-roledescription="carousel"');
    expect(code).toContain('role="tablist"');
    expect(code).toContain('aria-selected={i === current}');
    expect(code).toContain('aria-hidden={active ? undefined : true}');
    // Real photography, still lazily decoded.
    expect(code).toContain('/assets/return4me-earn-and-return.webp');
    expect(code).toContain('loading="lazy"');
    expect(code).toContain('decoding="async"');
  });
});

