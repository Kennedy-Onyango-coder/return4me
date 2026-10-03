// RETURN4ME NAVBAR BATCH 1 - restore language + appearance control access.
//
// Regression: the utility tray and the session block were changed from
// `hidden lg:flex` to `hidden xl:flex` while the compact header stayed
// `lg:hidden`. That left 1024-1279px (lg -> xl) with a full desktop navbar
// and NO reachable language, appearance, or session control anywhere on the
// page. The controls were never removed - only made unreachable at one width.
//
// These are source-contract tests, matching the repository's established
// strategy for this surface (see languageControlBatchC / appearanceControlBatchE).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

const NAVBAR = read('components/Navbar.tsx');
// Strip comments so a class asserted absent cannot be satisfied by prose.
const code = NAVBAR.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('NAVBAR BATCH 1 - language + appearance control visibility', () => {
  // ------------------------------------------------- the unreachable-control band
  //
  // UX-02 (public navigation + global chrome) moved the full desktop row from
  // `lg` to `xl`: the header now shares the public page container
  // (`max-w-7xl px-5 sm:px-12`), and at 1024px that leaves 928px for a row that
  // measures ~1000px at the smallest legible ladder step.
  //
  // The CONTRACT this batch protects is unchanged and is still asserted — no
  // width may lose its language / appearance / session controls — but the two
  // gates it depends on are now `xl` on BOTH sides, so the assertions below pin
  // the PAIR instead of the old `lg`-vs-`xl` split.
  it('gates the utility tray where the compact fallback hands over', () => {
    // `hidden xl:flex` on the tray and `xl:hidden` on the compact header, which
    // carries the SAME two controls: the tray is never their only home.
    expect(code).toMatch(/hidden xl:flex[^"]*surface-muted/);
    // A gate wider than the fallback (`2xl`) would black out 1280-1535px.
    expect(code).not.toMatch(/hidden 2xl:flex/);
    // ...and no desktop-only group may be left behind at `lg` or below.
    expect(code).not.toMatch(/hidden lg:flex/);
    expect(code).not.toMatch(/hidden md:flex/);
  });

  it('gates the session block with the tray, never wider', () => {
    // The session block sits beside the tray and must share its breakpoint.
    // (The divider padding is still the reduced `pl-2` from the earlier spacing
    // pass; only the breakpoint moved.)
    const session = code.match(/hidden xl:flex[^"]*border-l[^"]*pl-2/);
    expect(session).not.toBeNull();
    expect(code).not.toMatch(/hidden 2xl:flex/);
  });

  it('keeps the compact header as the sub-xl fallback', () => {
    // If this ever became `2xl:hidden` the two implementations would not
    // overlap and the controls would vanish at every width in between.
    expect(code).toMatch(/flex xl:hidden items-center gap-1/);
  });

  it('keeps the desktop nav and the drawer on the same breakpoint', () => {
    expect(code).toMatch(/hidden xl:flex min-w-0 flex-1 items-center justify-center/); // nav
    expect(code).toMatch(/xl:hidden/);                                                 // drawer + scrim
  });

  // ------------------------------------------------------------ compact header
  it('gives the compact header BOTH utility controls', () => {
    // UX-02: the compact header is now `flex xl:hidden items-center gap-1`, and
    // the anchor follows the breakpoint move. What this test protects — that the
    // compact header carries BOTH utility controls, and that the drawer's own
    // copies cannot satisfy the assertion — is unchanged.
    const start = code.indexOf('flex xl:hidden items-center gap-1');
    expect(start).toBeGreaterThan(-1);
    // Bound the slice to the compact header group only, so the drawer's own
    // copies cannot satisfy this assertion.
    const compact = code.slice(start, code.indexOf('</header>', start));
    expect(compact).toContain('<LanguageControl ');
    expect(compact).toContain('<AppearanceControl ');
  });

  it('reuses the shared controls with the existing App-owned props', () => {
    const start = code.indexOf('flex xl:hidden items-center gap-1');
    const compact = code.slice(start, code.indexOf('</header>', start));
    // The `compact` / `minWidth` props added by the spacing remediation are
    // PRESENTATION ONLY; the props that prove App still owns the state are
    // asserted exactly as before.
    expect(compact).toMatch(/<LanguageControl lang=\{lang\} setLang=\{setLang\} layout="toggle"/);
    expect(compact).toMatch(/<AppearanceControl value=\{appearance\} onChange=\{setAppearance\} labels=\{appearanceLabels\}/);
    // No new state, context, or second appearance component.
    expect(NAVBAR).toMatch(/import AppearanceControl from '\.\/AppearanceControl'/);
    expect(code).not.toMatch(/useState[^;]*(appearance|theme)/i);
  });

  // ------------------------------------------------------------------- drawer
  it('keeps both drawer controls exactly as they were', () => {
    expect(code).toMatch(/<LanguageControl[^>]*layout="choices"/);
    expect(code).toMatch(/<AppearanceControl[^>]*fullWidth/);
  });

  // --------------------------------------------- existing contracts untouched
  it('keeps the public navigation IA and adds no Agent Portal item', () => {
    for (const label of ["handleNavClick('home')", "handleNavClick('owner')", "handleNavClick('finder')", "handleNavClick('becomeAgent')"]) {
      expect(code).toContain(label);
    }
    // Admin remains session-gated; no public Agent Portal destination.
    expect(code).toMatch(/\{isAdmin && \(/);
    expect(code).not.toMatch(/handleNavClick\('agent'\)/);
  });

  it('preserves the session behaviour the fix must not disturb', () => {
    expect(code).toMatch(/isTokenOnlySession/);
    expect(code).toContain('onClick={logout}');
    expect(code).toMatch(/Guest|Mgeni/);
  });

  it('does not alter the appearance option set', () => {
    const control = read('components/AppearanceControl.tsx');
    for (const option of ['light', 'dark', 'system']) {
      expect(control).toContain(`<option value="${option}">`);
    }
  });

  it('leaves translation architecture untouched', () => {
    // The control labels still come from the existing bundle, unchanged.
    expect(NAVBAR).toMatch(/appearanceLabel/);
    expect(NAVBAR).toMatch(/appearanceLight/);
    expect(NAVBAR).toMatch(/appearanceDark/);
    expect(NAVBAR).toMatch(/appearanceSystem/);
  });
});
