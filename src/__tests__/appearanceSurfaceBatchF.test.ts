import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(root, relative), 'utf8');
const css = read('src/index.css');
const app = read('src/App.tsx');
const navbar = read('src/components/Navbar.tsx');
const shell = read('src/components/dashboard/DashboardShell.tsx');
const control = read('src/components/LanguageControl.tsx');
const html = read('index.html');
const primitives = Object.fromEntries(
  ['Button', 'Input', 'Select', 'Textarea', 'Modal', 'Badge', 'Banner', 'EmptyState', 'SectionHeading', 'StatCard', 'Stepper', 'Skeleton', 'OTPInput']
    .map(name => [name, read(`src/components/ui/${name}.tsx`)]),
);

function luminance(hex: string) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('Batch F incremental appearance surface migration', () => {
  it('migrates the global canvas and App shell to semantic appearance tokens', () => {
    expect(css).toMatch(/body\s*\{[\s\S]*background-color: var\(--appearance-background\)/);
    expect(css).toMatch(/body\s*\{[\s\S]*color: var\(--appearance-text-primary\)/);
    expect(app).toContain('bg-[var(--appearance-background)]');
    expect(app).toContain('bg-[var(--appearance-surface)]');
    expect(app).toContain('border-[var(--appearance-border)]');
  });

  it('migrates the public footer without changing its content or behavior', () => {
    expect(app).toContain('<footer className="bg-[var(--appearance-surface-muted)] border-t border-[var(--appearance-border)]');
    expect(app).toContain('dpo@return4me.co.ke');
    expect(app).toContain("setView('privacy')");
    expect(app).toContain("setView('terms')");
  });

  it('migrates shared controls while preserving their structural contracts', () => {
    for (const name of ['Button', 'Input', 'Select', 'Textarea', 'Modal', 'Badge', 'Banner', 'EmptyState', 'SectionHeading', 'StatCard', 'Stepper', 'Skeleton', 'OTPInput']) {
      expect(primitives[name], `${name} must consume appearance tokens`).toContain('--appearance-');
    }
    expect(primitives.Button).toContain('primary:');
    expect(primitives.Input).toContain('<input');
    expect(primitives.Select).toContain('<select');
    expect(primitives.Textarea).toContain('<textarea');
    expect(primitives.Modal).toContain('role="dialog"');
    expect(primitives.Modal).toContain('trapModalFocus');
    expect(primitives.OTPInput).toContain('inputMode="numeric"');
  });

  it('keeps button variant hierarchy and maps theme-sensitive variants semantically', () => {
    for (const variant of ['primary', 'secondary', 'accent', 'outline', 'inverse', 'ghost', 'danger']) {
      expect(primitives.Button).toContain(`${variant}:`);
    }
    for (const token of ['surface', 'surface-muted', 'text-primary', 'accent', 'accent-foreground', 'danger', 'danger-foreground']) {
      expect(primitives.Button).toContain(`--appearance-${token}`);
    }
    expect(primitives.Button).toContain('disabled:opacity-50');
  });


  it('migrates forms for dark readability without behavior changes', () => {
    for (const name of ['Input', 'Select', 'Textarea', 'OTPInput']) {
      const source = primitives[name];
      expect(source).toContain('bg-[var(--appearance-surface)]');
      expect(source).toContain('text-[var(--appearance-text-primary)]');
      expect(source).toContain('border-[var(--appearance-border)]');
      expect(source).toContain('focus:ring-[var(--appearance-focus)]');
      expect(source).toContain('disabled:opacity-50');
    }
  });

  it('migrates modal surfaces while preserving focus, escape, scroll lock, and portal behavior', () => {
    expect(primitives.Modal).toContain('bg-[var(--appearance-surface)]');
    expect(primitives.Modal).toContain('border-[var(--appearance-border)]');
    expect(primitives.Modal).toContain('createPortal');
    expect(primitives.Modal).toContain("event.key === 'Escape'");
    expect(primitives.Modal).toContain("document.body.style.overflow = 'hidden'");
  });

  it('keeps status meaning through semantic colors, borders, icons, and text', () => {
    for (const name of ['Badge', 'Banner']) {
      for (const token of ['success', 'warning', 'danger']) {
        expect(primitives[name]).toContain(`--appearance-${token}`);
      }
    }
    expect(primitives.Badge).toContain('CheckCircle2');
    expect(primitives.Badge).toContain('AlertTriangle');
    expect(primitives.Badge).toContain('AlertCircle');
    expect(primitives.Banner).toContain('role={isInterruptive');
  });

  it('migrates Navbar surfaces and controls while preserving the five-item IA', () => {
    for (const destination of ["handleNavClick('home')", 't.ownerBtn', 't.finderBtn', 't.becomeAgentBtn', 't.signInBtn']) {
      expect(navbar).toContain(destination);
    }
    expect(navbar).not.toMatch(/t\.agentBtn/);
    for (const token of ['surface', 'surface-muted', 'text-primary', 'text-muted', 'border', 'focus']) {
      expect(navbar).toContain(`--appearance-${token}`);
    }
    expect((navbar.match(/<LanguageControl /g) || [])).toHaveLength(3);
    expect((navbar.match(/<AppearanceControl /g) || [])).toHaveLength(2);
  });

  it('migrates DashboardShell and language-choice surfaces without changing shell behavior', () => {
    for (const token of ['background', 'surface', 'text-primary', 'text-muted', 'border']) {
      expect(shell).toContain(`--appearance-${token}`);
    }
    expect(control).toContain('--appearance-surface');
    expect(control).toContain('aria-pressed={active}');
    expect(shell).toContain('<LanguageControl');
    expect(shell).toContain('<AppearanceControl');
    expect(shell).toContain('onExitSite');
    expect(shell).toContain('onSignOut');
  });

  it('adds a defensive pre-paint bootstrap using only the canonical preference key', () => {
    expect(html).toContain("localStorage.getItem('return4me.appearance')");
    expect(html).toContain("matchMedia('(prefers-color-scheme: dark)')");
    expect(html).toContain("setAttribute('data-theme', effective)");
    expect(html).not.toContain('data-theme", "system');
    expect((html.match(/return4me\.appearance/g) || [])).toHaveLength(1);
  });

  it('keeps the canonical dark scope and App ownership without competing mechanisms', () => {
    expect(css).toContain("html[data-theme='dark']");
    expect(css).not.toMatch(/^\s*\.dark\s*\{|^\s*\.light\s*\{|\[data-mode|\[data-appearance=/m);
    expect(app).toContain('const [appearancePreference, setAppearancePreference] = useState<AppearancePreference>');
    expect(app).toContain('subscribeToSystemAppearance');
    expect(read('src/components/AppearanceControl.tsx')).not.toMatch(/localStorage|matchMedia|useState/);
  });

  it('meets AA text contrast for known primary and secondary token pairs', () => {
    expect(contrast('#003820', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#334B3F', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#F1F7F3', '#12211A')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#C8D6CE', '#12211A')).toBeGreaterThanOrEqual(4.5);
  });
});
