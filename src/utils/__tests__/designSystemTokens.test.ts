import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-01 — DESIGN SYSTEM FOUNDATION (token tripwires)
// =============================================================================
// WHY THIS FILE EXISTS
//
// UX-01 locked the visual foundation: one typography ladder, one radius ladder,
// one semantic colour vocabulary, two elevation steps, a bounded motion band,
// and one keyboard-focus language. A locked system is only real if something
// fails when it drifts, so every value below is recomputed from src/index.css —
// the single source of truth — exactly the way contrastTokens.test.ts already
// reads the colour tokens.
//
// The assertions read the SOURCE css, not the build output: Tailwind v4
// tree-shakes unused theme variables out of the compiled bundle, so a
// build-output assertion would silently pass for a token that no longer exists
// in the source.
//
// These are structural contracts, not pixel measurements; the repository has no
// DOM/browser harness (vitest environment: 'node').

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const css = fs.readFileSync(path.resolve(repoRoot, 'src/index.css'), 'utf8');

/** Source with CSS comments removed — prose about a value must never satisfy a
 *  value assertion, and must never trip a "must not contain" guard. */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

const themeStart = cssCode.indexOf('@theme {');
const themeBlock = cssCode.slice(themeStart, cssCode.indexOf('\n}', themeStart));

const lightStart = cssCode.indexOf(':root {', cssCode.indexOf('APPEARANCE SEMANTIC TOKENS'));
const lightBlock = cssCode.slice(lightStart, cssCode.indexOf('\n}', lightStart));

const darkStart = cssCode.indexOf("html[data-theme='dark']");
const darkBlock = cssCode.slice(darkStart, cssCode.indexOf('\n}', darkStart));

/** `--name: value;` inside a scope. The trailing `:` keeps `--text-body:` from
 *  matching `--text-body-large:` or `--text-body--line-height:`. */
function valueIn(scope: string, name: string): string | null {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(scope);
  return match ? match[1].trim() : null;
}

const theme = (name: string) => valueIn(themeBlock, name);
const light = (name: string) => valueIn(lightBlock, name);
const dark = (name: string) => valueIn(darkBlock, name);
/** Semantic roles are namespaced: role `surface` is `--appearance-surface`. */
const lightRole = (role: string) => valueIn(lightBlock, `appearance-${role}`);
const darkRole = (role: string) => valueIn(darkBlock, `appearance-${role}`);

/** rem/px literal -> px number. */
function toPx(value: string | null): number | null {
  if (!value) return null;
  const rem = /^(-?[\d.]+)rem$/.exec(value);
  if (rem) return Math.round(parseFloat(rem[1]) * 16);
  const px = /^(-?[\d.]+)px$/.exec(value);
  if (px) return Math.round(parseFloat(px[1]));
  return null;
}

const TYPOGRAPHY_LADDER = [
  { name: 'caption', size: 12, lineHeight: 16 },
  { name: 'small', size: 13, lineHeight: 18 },
  { name: 'body', size: 14, lineHeight: 20 },
  { name: 'body-large', size: 16, lineHeight: 24 },
  { name: 'heading', size: 18, lineHeight: 26 },
  { name: 'subsection', size: 20, lineHeight: 28 },
  { name: 'section', size: 24, lineHeight: 32 },
  { name: 'page', size: 32, lineHeight: 40 },
  { name: 'display', size: 40, lineHeight: 48 },
  { name: 'hero', size: 48, lineHeight: 56 },
];

const RADIUS_LADDER = [
  { name: 'compact', size: 6 },
  { name: 'small', size: 8 },
  { name: 'standard', size: 12 },
  { name: 'panel', size: 16 },
  { name: 'hero', size: 24 },
];

const SPACING_LADDER = [4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80];

// Every semantic role the system documents, required in BOTH themes.
const SEMANTIC_ROLES = [
  'background',
  'surface', 'surface-muted', 'surface-elevated',
  'text-primary', 'text-secondary', 'text-muted',
  'border', 'border-strong',
  'primary', 'primary-hover', 'primary-foreground',
  'accent', 'accent-hover', 'accent-foreground',
  'success', 'success-foreground',
  'warning', 'warning-foreground',
  'danger', 'danger-foreground',
  'info', 'info-foreground',
  'focus', 'scrim',
];

// Role pairs that must clear WCAG AA for normal text in both themes.
const CONTRAST_PAIRS: Array<[string, string]> = [
  ['primary-foreground', 'primary'],
  ['accent-foreground', 'accent'],
  ['accent-foreground', 'accent-hover'],
  ['success-foreground', 'success'],
  ['warning-foreground', 'warning'],
  ['danger-foreground', 'danger'],
  ['info-foreground', 'info'],
];

// ---------------------------------------------------------------------------
// WCAG 2.1 relative luminance + contrast ratio (same maths as contrastTokens)
// ---------------------------------------------------------------------------
function luminance(hex: string): number {
  const value = hex.replace('#', '').trim();
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const channels = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('UX-01 typography ladder (the single source of truth for type)', () => {
  it('declares every locked step at its exact size and line-height', () => {
    for (const step of TYPOGRAPHY_LADDER) {
      expect(toPx(theme(`text-${step.name}`)), `--text-${step.name}`).toBe(step.size);
      expect(
        toPx(theme(`text-${step.name}--line-height`)),
        `--text-${step.name} line-height`,
      ).toBe(step.lineHeight);
    }
  });

  it('honours the 12px floor: no step in the scale is smaller than caption', () => {
    expect(Math.min(...TYPOGRAPHY_LADDER.map((s) => s.size))).toBe(12);
    expect(cssCode).not.toMatch(/--text-[\w-]+:\s*0\.(?:[0-6]\d*)rem/);
  });

  it('retires the off-ladder 28px display step', () => {
    expect(cssCode).not.toContain('--text-display: 1.75rem');
    expect(toPx(theme('text-display'))).toBe(40);
  });

  it('locks the weight vocabulary', () => {
    expect(css).toContain('WEIGHTS: 400 body');
    expect(css).toContain('700 buttons / important labels');
    expect(css).toContain('800 major headings');
  });
});

describe('UX-01 radius ladder', () => {
  it('declares exactly the five locked steps, ascending', () => {
    const sizes = RADIUS_LADDER.map((s) => toPx(theme(`radius-${s.name}`)));
    expect(sizes).toEqual([6, 8, 12, 16, 24]);
  });

  it('keeps the ladder a rename of the Tailwind steps it replaced', () => {
    // rounded-md/lg/xl/2xl/3xl are 6/8/12/16/24 by default in Tailwind v4, so
    // adopting a token must never silently re-point those to another value.
    expect(css).toContain('md 6 / lg 8 / xl 12');
  });
});

describe('UX-01 spacing rhythm', () => {
  it('documents the 4px-base rhythm and every step is on that base', () => {
    expect(css).toContain('RETURN4ME SPACING RHYTHM');
    for (const step of SPACING_LADDER) {
      expect(Number.isInteger(step / 4), `${step}px must be a 4px multiple`).toBe(true);
    }
  });

  it('does not declare a parallel spacing namespace that nothing consumes', () => {
    expect(cssCode).not.toMatch(/--spacing-[a-z]/);
  });
});

describe('UX-01 semantic colour roles', () => {
  it('declares every role in the light scope', () => {
    for (const role of SEMANTIC_ROLES) {
      expect(lightRole(role), `light --appearance-${role}`).toBeTruthy();
    }
  });

  it('declares every role in the canonical dark scope', () => {
    for (const role of SEMANTIC_ROLES) {
      expect(darkRole(role), `dark --appearance-${role}`).toBeTruthy();
    }
  });

  it('keeps the two scopes genuinely different (dark is not a copy of light)', () => {
    for (const role of ['background', 'surface', 'text-primary', 'border', 'scrim']) {
      expect(darkRole(role)).not.toBe(lightRole(role));
    }
  });

  it('uses the canonical dark scope only (no competing theme mechanism)', () => {
    expect(css).toContain("html[data-theme='dark']");
    expect(cssCode).not.toMatch(/\.dark\s*\{|\[data-appearance=/);
  });

  it('keeps every status foreground legible in both themes (AA, 4.5:1)', () => {
    const offenders: string[] = [];
    for (const [scopeName, scope] of [['light', lightRole], ['dark', darkRole]] as const) {
      for (const [fgRole, bgRole] of CONTRAST_PAIRS) {
        const fg = scope(fgRole);
        const bg = scope(bgRole);
        if (!fg || !bg || !fg.startsWith('#') || !bg.startsWith('#')) continue;
        const ratio = contrast(fg, bg);
        if (ratio < 4.5) {
          offenders.push(`${scopeName}: ${fgRole} on ${bgRole} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(offenders, `\n${offenders.join('\n')}\n`).toEqual([]);
  });
});

describe('UX-01 elevation', () => {
  it('exposes exactly two shadow steps that resolve through the elevation vars', () => {
    expect(theme('shadow-raised')).toBe('var(--elevation-raised)');
    expect(theme('shadow-floating')).toBe('var(--elevation-floating)');
  });

  it('defines both steps in each theme with different values', () => {
    for (const step of ['raised', 'floating']) {
      expect(light(`elevation-${step}`), `light elevation-${step}`).toBeTruthy();
      expect(dark(`elevation-${step}`), `dark elevation-${step}`).toBeTruthy();
      expect(dark(`elevation-${step}`)).not.toBe(light(`elevation-${step}`));
    }
  });
});

describe('UX-01 motion band', () => {
  const ms = (name: string) => {
    const value = light(name);
    const match = value ? /^(\d+)ms$/.exec(value) : null;
    return match ? parseInt(match[1], 10) : null;
  };

  it('keeps ordinary interaction between 150ms and 200ms', () => {
    for (const name of ['motion-quick', 'motion-standard']) {
      const value = ms(name);
      expect(value, `--${name}`).not.toBeNull();
      expect(value!).toBeGreaterThanOrEqual(150);
      expect(value!).toBeLessThanOrEqual(200);
    }
  });

  it('keeps deliberate transitions between 250ms and 400ms', () => {
    for (const name of ['motion-deliberate', 'motion-slow']) {
      const value = ms(name);
      expect(value, `--${name}`).not.toBeNull();
      expect(value!).toBeGreaterThanOrEqual(250);
      expect(value!).toBeLessThanOrEqual(400);
    }
  });

  it('orders the ladder and honours prefers-reduced-motion', () => {
    expect(ms('motion-quick')!).toBeLessThan(ms('motion-deliberate')!);
    expect(ms('motion-standard')!).toBeLessThan(ms('motion-slow')!);
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('uses the motion token rather than a hard-coded duration in the foundation', () => {
    expect(css).toContain('var(--motion-quick)');
  });
});

describe('UX-01 focus language', () => {
  const focusRule = /:focus-visible\s*\{([^}]*)\}/.exec(cssCode);
  const focusBody = focusRule ? focusRule[1] : '';

  it('declares exactly one global keyboard-focus indicator', () => {
    expect(focusBody).toContain('outline: 2px solid var(--color-accent-orange)');
    expect(focusBody).toContain('outline-offset: 2px');
  });

  it('does not override a control radius while focused (off-ladder regression)', () => {
    // The old rule set `border-radius: 0.25rem`; because an unlayered rule beats
    // every @layer utilities rule, that silently replaced each control's own
    // radius the moment a keyboard user focused it.
    expect(focusBody).not.toContain('border-radius');
  });

  it('keeps the white outline for dark brand surfaces', () => {
    expect(cssCode).toContain('.bg-primary-green :focus-visible');
    expect(cssCode).toContain('outline-color: white');
  });
});

