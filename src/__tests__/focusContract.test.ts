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
    expect(css).toContain('outline: 2px solid var(--color-accent-orange)');
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
});