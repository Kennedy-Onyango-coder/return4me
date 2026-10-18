// =============================================================================
// PI-1 / C5 — global focus/dropdown contract (structural).
// =============================================================================
//
// LIMITATION (documented, per the directive): this is a SOURCE-STRUCTURE
// contract, not a browser render. It proves the code declares ONE deliberate
// focus treatment and does not suppress it; it cannot measure the rendered
// pixels. Browser-render verification is deferred to a visual regression run.
//
// WHAT IT GUARDS
//   The shared controls (Button/Input/Select/Textarea) must not each carry
//   their own `focus:outline-none` + `focus:ring-2` (which suppressed the
//   global keyboard indicator and stacked a box-shadow ring on top of a border
//   change, producing the reported double-border/orange-border look). They now
//   rely on the single global `:focus-visible` rule, keeping only a
//   `focus:border-*` mouse affordance.
// =============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const read = (rel: string) => readFileSync(new URL('../..' + '/' + rel, import.meta.url), 'utf8');

describe('PI-1 C5 — one deliberate focus treatment per control', () => {
  it('the global :focus-visible accessibility rule exists', () => {
    const css = read('src/index.css');
    expect(css).toMatch(/:focus-visible\s*\{/);
    expect(css).toContain('outline: 2px solid var(--appearance-focus)');
  });

  it('shared controls do not suppress or duplicate the focus treatment', () => {
    for (const rel of [
      'src/components/ui/Input.tsx',
      'src/components/ui/Select.tsx',
      'src/components/ui/Textarea.tsx',
    ]) {
      const source = read(rel);
      // No local outline suppression — the global rule is the indicator.
      expect(source, `${rel} must not use focus:outline-none`).not.toContain('focus:outline-none');
      // No stacked box-shadow ring — that was the duplicate treatment.
      expect(source, `${rel} must not use focus:ring-2`).not.toContain('focus:ring-2');
      // The mouse affordance remains.
      expect(source, `${rel} keeps focus:border affordance`).toContain('focus:border-[var(--appearance-focus)]');
    }
  });

  it('Button relies on the same single global rule (no local focus classes)', () => {
    const source = read('src/components/ui/Button.tsx');
    expect(source).not.toContain('focus:outline-none');
    expect(source).not.toContain('focus:ring-2');
  });

  // WP1 — the focus indicator must be (a) themed rather than a hard-coded colour
  // and (b) still visible where the theme is discarded entirely.
  it('WP1 — the focus colour is themed in both appearances and survives forced colors', () => {
    const css = read('src/index.css');

    // (a) `--appearance-focus` is declared once per appearance block, so the ring
    // is measured against the surface it actually sits on (dark green on cream,
    // mint on near-black) instead of one compromise colour for both.
    const tokenDecls = css.match(/--appearance-focus:\s*[^;]+;/g) || [];
    expect(
      tokenDecls.length,
      'light and dark must each declare --appearance-focus',
    ).toBeGreaterThanOrEqual(2);

    // (b) Windows High Contrast / forced-colors replaces author colours with the
    // user's palette, which can collapse a themed ring into the background. The
    // indicator is therefore re-stated with the system `Highlight` colour in the
    // same 2px offset, one pixel thicker so the system's own control borders
    // cannot swallow it.
    expect(css).toMatch(/@media\s*\(forced-colors:\s*active\)\s*\{/);
    expect(css).toMatch(
      /@media\s*\(forced-colors:\s*active\)[\s\S]*?:focus-visible\s*\{[\s\S]*?outline:\s*3px solid Highlight/,
    );
    expect(css).toMatch(
      /@media\s*\(forced-colors:\s*active\)[\s\S]*?outline-offset:\s*2px/,
    );
  });

  // WP4 — the bypass block. Kept in this file because it is the same contract
  // family: a keyboard user must be able to see where focus is, and must be able
  // to skip past the chrome to reach it.
  it('WP4 — a real skip link bypasses the chrome into the one <main>', () => {
    const app = read('src/App.tsx');

    // The link exists and points at the landmark below.
    expect(app).toContain('href="#main-content"');
    expect(app).toContain('Skip to main content');

    // It is hidden visually but NOT from the tab order: `sr-only` keeps it
    // focusable, and `focus:not-sr-only` reveals it on arrival. `display: none`
    // (or a `hidden` attribute) would make the bypass unreachable entirely.
    expect(app).toContain('sr-only focus:not-sr-only');

    // It must be a comfortable target once revealed (WCAG 2.5.8 / 44px).
    expect(app).toMatch(/focus:min-h-\[44px\]/);

    // There is exactly one <main>, it owns the id the link targets, and it is
    // programmatically focusable — without `tabIndex={-1}` focus stays on the
    // link in several browsers and the bypass silently does nothing.
    // (`\s` after the tag name, so prose like "<main>" in the comments above is
    // not counted as markup.)
    expect(app.match(/<main\s/g) || []).toHaveLength(1);
    expect(app).toMatch(/<main[^>]*id="main-content"/);
    expect(app).toMatch(/<main[^>]*tabIndex=\{-1\}/);
  });
});

// =============================================================================
// WP1 follow-up — the discovery card's focus ring was INVISIBLE, not missing.
// =============================================================================
// The card link inherited the global rule correctly, but its wrapper carried
// `overflow-hidden` (to crop the thumbnail to the 16px panel radius). An outline
// is painted OUTSIDE the border box of the element that owns it, so the 2px ring
// at a 2px offset was clipped away by that ancestor and a keyboard user saw
// nothing on the homepage's main browse surface — while every other control
// showed the ring.
//
// The fix moves the card chrome and the clip onto the link itself: an element's
// own `overflow-hidden` never clips its own outline. One focus treatment is kept
// (no local ring, no orange, no `outline-none`), and the thumbnail is still
// cropped to the rounded corners.
//
// LIMITATION: like the rest of this file, this is a source-structure contract. It
// proves the clipping element and the focused element are the same node; it
// cannot measure pixels. A visual regression run still covers rendering.
// =============================================================================
describe('WP1 follow-up — the discovery card cannot clip its own focus ring', () => {
  // JSX/block comments are stripped first: the fix is documented in prose that
  // names `overflow-hidden`, and prose must never satisfy an assertion.
  const home = read('src/components/HomeView.tsx').replace(/\/\*[\s\S]*?\*\//g, '');

  const cardStart = home.indexOf('whileHover={{ y: -4 }}');
  const linkStart = cardStart > -1 ? home.indexOf('<a', cardStart) : -1;
  const linkEnd =
    linkStart > -1 ? home.indexOf('aria-label={`Open found item details', linkStart) : -1;

  it('locates the discovery card it is asserting about', () => {
    expect(cardStart, 'the discovery card must still animate on hover').toBeGreaterThan(-1);
    expect(linkStart, 'the card must still be one real link').toBeGreaterThan(cardStart);
    expect(linkEnd, 'the link must still be labelled').toBeGreaterThan(linkStart);
  });

  it('does not put the clip on an ancestor of the focusable link', () => {
    const wrapper = home.slice(cardStart, linkStart);
    // `overflow-hidden` on an ancestor is the original bug; the radius, surface
    // and group state belong on the link for the same reason.
    expect(wrapper).not.toContain('overflow-hidden');
    expect(wrapper).not.toContain('rounded-panel');
    expect(wrapper).not.toContain('group');
  });

  it('keeps the card chrome, the clip and the radius on the link itself', () => {
    const link = home.slice(linkStart, linkEnd);
    expect(link).toContain('overflow-hidden');
    expect(link).toContain('rounded-panel');
    expect(link).toContain('border border-[var(--appearance-border)]');
    expect(link).toContain('group');
  });

  it('adds no local focus indicator (one global treatment, never orange)', () => {
    const link = home.slice(linkStart, linkEnd);
    // No stacked box-shadow ring and no local outline: the global
    // `:focus-visible` rule remains the single indicator.
    expect(link).not.toMatch(/focus-visible:ring|focus:ring|ring-2/);
    expect(link).not.toMatch(/outline-(none|accent-orange|orange)/);
  });
});
