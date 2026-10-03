import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ICON_SIZE, ICON_LADDER } from '../iconSize';

// =============================================================================
// UX-01 — SHARED PRIMITIVE CONTRACTS
// =============================================================================
// The repository has no DOM/browser harness (vitest environment: 'node'), so —
// like every other UI suite here — these are SOURCE contracts over the shipped
// markup. They assert the design-system rules that are cheap to break and
// expensive to notice: the icon ladder, the 12px type floor, no raw palette
// inside the foundation, one focus language, and the status/semantic vouchers.
//
// Nothing here asserts a Tailwind string for its own sake; each assertion is a
// rule from docs/design-system.md that would otherwise drift silently.

const uiDir = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(uiDir, '..', '..', '..');
const read = (name: string) => fs.readFileSync(path.join(uiDir, name), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const NO_ICON = new Set(['Skeleton', 'OTPInput', 'SectionHeading']); // render no lucide icons
const NO_TEXT = new Set(['Skeleton', 'Spinner']);                   // render no visible text
const PRIMITIVES = [
  'Badge', 'Banner', 'Button', 'EmptyState', 'Input', 'Modal',
  'OTPInput', 'SectionHeading', 'Select', 'Skeleton', 'Spinner',
  'StatCard', 'Stepper', 'Textarea',
].map((name) => [name, read(`${name}.tsx`)] as const);

const LADDER_TEXT_CLASSES = [
  'text-caption', 'text-small', 'text-body', 'text-body-large',
  'text-heading', 'text-subsection', 'text-section', 'text-page',
  'text-display', 'text-hero',
];

describe('UX-01 icon ladder', () => {
  it('is exactly the five locked, ascending sizes', () => {
    expect(ICON_LADDER).toEqual([14, 16, 18, 20, 24]);
    expect([...ICON_LADDER]).toEqual([...ICON_LADDER].sort((a, b) => a - b));
    expect(ICON_SIZE).toMatchObject({
      metadata: 14, ui: 16, emphasis: 18, heading: 20, feature: 24,
    });
  });

  it('is the only source of icon sizes in the foundation', () => {
    for (const [name, source] of PRIMITIVES) {
      if (NO_ICON.has(name)) continue;
      // No hard-coded numeric icon size may survive in a shared primitive; the
      // size must come from ICON_SIZE (or, for Spinner, from the caller's prop).
      expect(source, `${name} must not hard-code an icon size`).not.toMatch(/size=\{\d+\}/);
    }
  });

  it('is actually consumed by every primitive that renders an icon', () => {
    for (const [name, source] of PRIMITIVES) {
      if (NO_ICON.has(name)) continue;
      expect(source, `${name} must render icons at a ladder size`).toMatch(
        /ICON_SIZE\.|size=\{size\}/,
      );
    }
  });
});

describe('UX-01 typography floor inside the foundation', () => {
  it('uses no 9px, 10px or 11px text anywhere in the shared primitives', () => {
    for (const [name, source] of PRIMITIVES) {
      expect(stripComments(source), `${name} must respect the 12px floor`).not.toMatch(
        /text-\[(?:9|10|11)px\]/,
      );
    }
  });

  it('speaks the named ladder instead of raw sizes', () => {
    for (const [name, source] of PRIMITIVES) {
      if (NO_TEXT.has(name)) continue;
      const usesLadder = LADDER_TEXT_CLASSES.some((cls) => source.includes(cls));
      expect(usesLadder, `${name} must use a named typography step`).toBe(true);
    }
  });

  it('gives SectionHeading and StatCard a compliant eyebrow/label (was 11px)', () => {
    expect(read('SectionHeading.tsx')).toContain('text-caption font-extrabold uppercase');
    expect(read('StatCard.tsx')).toContain('text-caption font-extrabold uppercase');
  });
});

describe('UX-01 radius ladder inside the foundation', () => {
  it('uses no arbitrary radius in the shared primitives', () => {
    for (const [name, source] of PRIMITIVES) {
      expect(source, `${name} must not use an arbitrary radius`).not.toMatch(/rounded-\[/);
    }
  });

  it('allows rounded-full only for genuinely round things', () => {
    // Badge (status pill), Stepper (step dot / progress rail), Skeleton
    // (circle avatar) — every other primitive stays on the ladder.
    for (const [name, source] of PRIMITIVES) {
      if (['Badge', 'Stepper', 'Skeleton'].includes(name)) continue;
      expect(source, `${name} must not invent a pill`).not.toContain('rounded-full');
    }
  });

  it('keeps the standard/panel steps in use across controls and surfaces', () => {
    expect(read('Input.tsx')).toContain('rounded-standard');
    expect(read('Select.tsx')).toContain('rounded-standard');
    expect(read('Textarea.tsx')).toContain('rounded-standard');
    expect(read('OTPInput.tsx')).toContain('rounded-standard');
    expect(read('Modal.tsx')).toContain('rounded-panel');
    expect(read('StatCard.tsx')).toContain('rounded-panel');
    expect(read('EmptyState.tsx')).toContain('rounded-panel');
  });
});

describe('UX-01 no raw palette inside the foundation', () => {
  it('never reaches for a Tailwind palette family for a surface or status', () => {
    const palette =
      /(?:^|[\s"'`{}:])(?:bg|text|border|ring|from|to|via)-(?:stone|slate|gray|grey|zinc|neutral|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/;
    const offenders: string[] = [];
    for (const [name, source] of PRIMITIVES) {
      if (palette.test(stripComments(source))) offenders.push(name);
    }
    expect(offenders, `raw palette classes found in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('routes the dialog backdrop through the semantic scrim role', () => {
    expect(read('Modal.tsx')).toContain('bg-[var(--appearance-scrim)]');
    expect(read('Modal.tsx')).not.toContain('bg-stone-950');
  });
});

describe('UX-01 spacing inside the foundation', () => {
  it('uses the 4px rhythm instead of arbitrary spacing values', () => {
    const arbitrarySpacing =
      /(?:^|[\s"'`{}])(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|gap|gap-x|gap-y|space-x|space-y)-\[/;
    for (const [name, source] of PRIMITIVES) {
      expect(source, `${name} must not invent a spacing value`).not.toMatch(arbitrarySpacing);
    }
  });
});

describe('UX-01 status semantics', () => {
  const badge = read('Badge.tsx');
  const banner = read('Banner.tsx');

  it('Badge declares every locked state name', () => {
    for (const variant of ['success', 'warning', 'pending', 'danger', 'info', 'neutral', 'code']) {
      expect(badge, `Badge variant ${variant}`).toMatch(new RegExp(`\\b${variant}:`));
    }
    expect(badge).toMatch(/BadgeVariant = [^;]*'pending'/);
  });

  it('Badge maps its states to semantic tokens, never to a palette', () => {
    for (const token of ['success', 'warning', 'danger', 'border-strong', 'surface-muted']) {
      expect(badge).toContain(`--appearance-${token}`);
    }
  });

  it('pending and warning cannot drift apart visually', () => {
    // Compare the CLASS LIST, not the whole source line (the line also carries
    // the variant key, and the file has CRLF line endings).
    const classesFor = (variant: string) => {
      const line = badge.split('\n').find((l) => l.trim().startsWith(`${variant}:`)) ?? '';
      return line.slice(line.indexOf(':') + 1).trim();
    };
    expect(classesFor('pending')).toBe(classesFor('warning'));
    expect(classesFor('pending')).toContain('--appearance-warning');
  });

  it('gives every status state an icon so meaning is never colour alone', () => {
    for (const icon of ['CheckCircle2', 'AlertTriangle', 'AlertCircle', 'Info', 'Clock']) {
      expect(badge, `Badge icon ${icon}`).toContain(icon);
    }
  });

  it('Banner keeps the four kinds and the alert/status split', () => {
    for (const kind of ['success', 'error', 'warning', 'info']) {
      expect(banner, `Banner kind ${kind}`).toMatch(new RegExp(`\\b${kind}:`));
    }
    expect(banner).toContain("role={isInterruptive ? 'alert' : 'status'}");
    expect(banner).toContain("const isInterruptive = kind === 'error' || kind === 'warning'");
  });
});

describe('UX-01 one focus language across the foundation', () => {
  it('no shared primitive suppresses or duplicates the global focus indicator', () => {
    for (const [name, source] of PRIMITIVES) {
      expect(source, `${name} must not use focus:outline-none`).not.toContain('focus:outline-none');
      expect(source, `${name} must not stack a focus ring`).not.toContain('focus:ring-');
      expect(source, `${name} must not stack a focus-visible ring`).not.toContain(
        'focus-visible:ring-',
      );
    }
  });

  it('keeps the mouse affordance on the form controls', () => {
    for (const name of ['Input', 'Select', 'Textarea', 'OTPInput']) {
      expect(read(`${name}.tsx`), `${name} keeps focus:border`).toContain(
        'focus:border-[var(--appearance-focus)]',
      );
    }
  });
});

describe('UX-01 button hierarchy', () => {
  const button = read('Button.tsx');

  it('keeps all seven variants declared', () => {
    for (const variant of ['primary', 'secondary', 'accent', 'outline', 'inverse', 'ghost', 'danger']) {
      expect(button, `Button variant ${variant}`).toMatch(new RegExp(`\\b${variant}:`));
    }
  });

  it('composes size classes from the locked type and radius ladders', () => {
    const sizeBlock = button.slice(
      button.indexOf('const sizeClasses'),
      button.indexOf('const variantClasses'),
    );
    expect(sizeBlock).toMatch(/sm:[^\n]*rounded-small/);
    expect(sizeBlock).toMatch(/md:[^\n]*rounded-standard/);
    expect(sizeBlock).toMatch(/lg:[^\n]*rounded-standard/);
    for (const cls of ['text-caption', 'text-body', 'text-body-large']) {
      expect(sizeBlock, `size classes must use ${cls}`).toContain(cls);
    }
  });

  it('has no forced uppercase and keeps the 44px floor on the default size', () => {
    // Comments are stripped: the component's own doc explains that the OLD
    // hand-rolled buttons forced uppercase, which is not a class in the code.
    expect(stripComments(button)).not.toContain('uppercase');
    expect(button).toMatch(/md: 'h-11/);
    expect(button).toContain('disabled:opacity-50');
  });

  it('exposes loading and disabled state without shifting layout', () => {
    expect(button).toContain('aria-busy={loading || undefined}');
    expect(button).toContain('const isDisabled = disabled || loading;');
  });
});

describe('UX-01 modal contract', () => {
  const modal = read('Modal.tsx');

  it('keeps the dialog semantics, keyboard handling and focus restoration', () => {
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain('aria-labelledby="r4m-modal-title"');
    expect(modal).toContain('trapModalFocus');
    expect(modal).toContain("event.key === 'Escape'");
    expect(modal).toContain('previouslyFocused.current?.focus?.()');
    expect(modal).toContain("document.body.style.overflow = 'hidden'");
  });

  it('is the floating layer of the elevation hierarchy', () => {
    expect(modal).toContain('shadow-floating');
  });

  it('does not use a browser-native prompt anywhere in the foundation', () => {
    for (const [name, source] of PRIMITIVES) {
      expect(source, `${name} must not use window.prompt`).not.toMatch(
        /window\.(?:prompt|confirm|alert)\s*\(/,
      );
    }
  });
});

describe('UX-01 the design-system reference is repository-local', () => {
  const doc = fs.readFileSync(path.resolve(repoRoot, 'docs/design-system.md'), 'utf8');

  it('documents every foundation area', () => {
    for (const heading of [
      '## 1. Typography', '## 2. Spacing', '## 3. Radius', '## 4. Colour semantics',
      '## 5. Surfaces, borders, shadows', '## 6. Focus', '## 7. Buttons',
      '## 8. Form controls', '## 9. Badges and status', '## 10. Icons',
      '## 11. Motion', '## 12. Modals and dialogs', '## 13. Dashboards',
      '## 14. Legacy inventory',
    ]) {
      expect(doc, `docs/design-system.md must document ${heading}`).toContain(heading);
    }
  });

  it('states the 12px floor and the legacy migration queue', () => {
    expect(doc).toContain('12px is the floor');
    expect(doc).toMatch(/MIGRATE LATER/);
    expect(doc).toMatch(/\| AdminView \|/);
    expect(doc).toMatch(/\| AgentView \+ agent\/\* \|/);
    expect(doc).toMatch(/\| FinderView \|/);
    expect(doc).toMatch(/\| OwnerView \|/);
  });
});

