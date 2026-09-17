import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// PHASE 9 — CONTRAST REGRESSION TRIPWIRES
// =============================================================================
// WHY THIS FILE EXISTS
//
// The reported defect was: "on hover the button text becomes invisible". The
// measured cause was the brand accent used as a BUTTON SURFACE:
//
//     bg-accent-orange (#EC7E0D) + text-white   = 2.78 : 1
//     hover:bg-accent-hover (#D26C08) + text-white = 3.57 : 1
//
// Both fail WCAG 2.1 AA (4.5:1 for normal text; 3:1 minimum for large/UI). The
// brand orange is a brand-identity colour and is fine for dots, rules, borders
// and indicators — it is simply not a legal text background.
//
// This suite recomputes the ratios from src/index.css (the design tokens are
// the single source of truth, so the numbers can never be "documented" in a
// comment while drifting in code), and then scans the real component source for
// the defect CLASS rather than one instance: any className string that puts
// `text-white` on a RETURN4ME brand background must clear 4.5:1, or the test
// fails at the exact file and line that would ship an unreadable button.

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const indexCss = fs.readFileSync(path.resolve(repoRoot, 'src/index.css'), 'utf8');

// ---------------------------------------------------------------------------
// WCAG 2.1 relative luminance + contrast ratio (pure, no dependencies)
// ---------------------------------------------------------------------------
function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '').trim();
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function channelToLinear(channel8bit: number): number {
  const c = channel8bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

export function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// The design tokens, read straight out of @theme in src/index.css
// ---------------------------------------------------------------------------
function readThemeTokens(): Record<string, string> {
  const tokens: Record<string, string> = {};
  const re = /--color-([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(indexCss)) !== null) tokens[m[1]] = m[2];
  return tokens;
}

const TOKENS = readThemeTokens();

const WHITE = '#FFFFFF';

describe('design-token contrast (recomputed from src/index.css)', () => {
  it('publishes the tokens this suite depends on', () => {
    for (const token of [
      'primary-green', 'primary-hover', 'accent-orange', 'accent-hover',
      'accent-strong', 'accent-strong-hover', 'brand-beige', 'brand-light-gray',
      'brand-dark-text', 'brand-muted-text',
    ]) {
      expect(TOKENS[token], `missing --color-${token} in src/index.css @theme`).toBeTruthy();
    }
  });

  it('the text-safe accent clears 4.5:1 with white — normal AND hover', () => {
    expect(contrastRatio(WHITE, TOKENS['accent-strong'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(WHITE, TOKENS['accent-strong-hover'])).toBeGreaterThanOrEqual(4.5);
    // The hover step must never be LIGHTER than the resting step, or a hover
    // would reduce legibility rather than increase it.
    expect(relativeLuminance(TOKENS['accent-strong-hover']))
      .toBeLessThanOrEqual(relativeLuminance(TOKENS['accent-strong']));
  });

  it('proves the brand orange is NOT a text background (regression evidence, not an assertion about the brand)', () => {
    // If this ever passes 4.5:1 the accent-strong tokens could be revisited;
    // until then, orange-as-button-surface must not come back.
    expect(contrastRatio(WHITE, TOKENS['accent-orange'])).toBeLessThan(4.5);
    expect(contrastRatio(WHITE, TOKENS['accent-hover'])).toBeLessThan(4.5);
  });

  it('the primary green button surfaces both clear 4.5:1 with white', () => {
    expect(contrastRatio(WHITE, TOKENS['primary-green'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(WHITE, TOKENS['primary-hover'])).toBeGreaterThanOrEqual(4.5);
  });

  it('body text tokens clear 4.5:1 on every surface they are used on', () => {
    const surfaces = ['brand-beige', 'brand-light-gray', '#FFFFFF'];
    for (const ink of ['brand-dark-text', 'brand-muted-text']) {
      for (const surface of surfaces) {
        const bg = surface.startsWith('#') ? surface : TOKENS[surface];
        expect(
          contrastRatio(TOKENS[ink], bg),
          `${ink} on ${surface}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('documents the measured limits of the brand orange (it is a decorative identity colour, not an indicator on its own)', () => {
    // Measured, not assumed: brand orange does NOT reach 3:1 on cream or on
    // white. It is therefore used only as a decorative accompaniment — a dot
    // beside a label, a rule above an eyebrow, a filled slide indicator — and
    // never as the sole carrier of state. Where it does indicate state (the
    // hero slide indicators) the active item ALSO changes size, which is what
    // this assertion protects.
    expect(contrastRatio(TOKENS['accent-orange'], TOKENS['brand-beige'])).toBeLessThan(3);
    expect(contrastRatio(TOKENS['accent-orange'], '#FFFFFF')).toBeLessThan(3);

    const homeView = fs.readFileSync(path.resolve(repoRoot, 'src/components/HomeView.tsx'), 'utf8');
    expect(homeView, 'the active slide indicator must differ in size, not only in colour')
      .toMatch(/i === current \? 'w-8 h-2 bg-accent-orange' : 'w-2 h-2 bg-white\/40/);
  });
});


// ---------------------------------------------------------------------------
// SOURCE SCAN — the defect CLASS, not one instance.
//
// Every className value in the app's own source is de-composed into its class
// tokens. Wherever a class string puts `text-white` on a RETURN4ME brand
// background (base state or any hover:/focus:/active: state), the pair must
// clear 4.5:1. A translucent brand background (bg-primary-green/20 …) is not a
// solid surface and is skipped — over a photo its real contrast is decided by
// the scrim, which src/index.css defines and documents separately.
// ---------------------------------------------------------------------------

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(path.resolve(repoRoot, 'src'));
  return files;
}

const CLASS_NAME_START = /className\s*=\s*/g;

/** Balanced capture of the `className={...}` expression (or its quoted value). */
function readClassNameExpression(source: string, from: number): { text: string; end: number } {
  const first = source[from];
  if (first === '"' || first === "'" || first === '`') {
    let j = from + 1;
    while (j < source.length && source[j] !== first) {
      if (source[j] === '\\') j++;
      j++;
    }
    return { text: source.slice(from, j), end: j + 1 };
  }
  if (first !== '{') return { text: '', end: from };

  let depth = 0;
  let j = from;
  let quote: string | null = null;
  while (j < source.length) {
    const ch = source[j];
    if (quote) {
      if (ch === '\\') j++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return { text: source.slice(from, j + 1), end: j + 1 };
    }
    j++;
  }
  return { text: source.slice(from), end: source.length };
}

/**
 * String literals inside a className expression — the actual class lists.
 *
 * Dynamic template literals are de-composed: each STATIC segment is judged on
 * its own, and each `${…}` interpolation is recursed into, so a class in one
 * branch of a ternary is never mistakenly paired with a class from the other
 * branch (which is exactly how a real violation could hide).
 */
function classListsIn(expression: string): string[] {
  const lists: string[] = [];
  const re = /(['"`])((?:[^\\]|\\.)*?)\1/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expression)) !== null) {
    const body = m[2];
    if (body.includes('${')) {
      const segments = body.split(/\$\{([\s\S]*?)\}/g);
      segments.forEach((segment, index) => {
        if (index % 2 === 1) lists.push(...classListsIn(segment));
        else if (segment.trim()) lists.push(segment);
      });
    } else {
      lists.push(body);
    }
  }
  return lists;
}

const SOLID_BRAND_BG = /(?:^|[\s'`"{}?:])(?:[a-z-]+:)?bg-([a-z0-9-]+)(?!\/)/g;

describe('no className pairs text-white with an unreadable Return4me background', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(repoRoot, file).replace(/\\/g, '/');
    CLASS_NAME_START.lastIndex = 0;
    let start: RegExpExecArray | null;
    while ((start = CLASS_NAME_START.exec(source)) !== null) {
      const { text, end } = readClassNameExpression(source, CLASS_NAME_START.lastIndex);
      CLASS_NAME_START.lastIndex = end;
      for (const list of classListsIn(text)) {
        if (!/(?:^|[\s'`"{}?:])text-white(?![\w-])/.test(list)) continue;
        SOLID_BRAND_BG.lastIndex = 0;
        let bg: RegExpExecArray | null;
        while ((bg = SOLID_BRAND_BG.exec(list)) !== null) {
          const token = TOKENS[bg[1]];
          if (!token) continue; // Tailwind's own palette / translucent white, not a brand token
          const ratio = contrastRatio(WHITE, token);
          if (ratio < 4.5) {
            offenders.push(`${relative}: text-white on bg-${bg[1]} (${token}) = ${ratio.toFixed(2)}:1`);
          }
        }
      }
    }
  }

  it('reports zero violations across src/ (this is the "text disappears on hover" class)', () => {
    expect(offenders, `\n${offenders.join('\n')}\n`).toEqual([]);
  });
});

describe('the shared Button primitive uses the text-safe accent', () => {
  const buttonTsx = fs.readFileSync(path.resolve(repoRoot, 'src/components/ui/Button.tsx'), 'utf8');

  it('the accent variant no longer paints white text on brand orange', () => {
    const accentLine = buttonTsx.split('\n').find((line) => line.includes('bg-accent-'));
    expect(accentLine, 'no accent button variant found in Button.tsx').toBeTruthy();
    expect(accentLine).toContain('bg-accent-strong');
    expect(accentLine).toContain('hover:bg-accent-strong-hover');
    expect(accentLine).not.toContain('bg-accent-orange');
    expect(accentLine).not.toContain('hover:bg-accent-hover');
  });
});
