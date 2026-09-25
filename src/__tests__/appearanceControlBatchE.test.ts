import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { translations } from '../types';
import {
  APPEARANCE_STORAGE_KEY,
  persistAppearance,
  resolveAppearance,
  type AppearancePreference,
} from '../utils/appearancePreference';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(repoRoot, relative), 'utf8');
const app = read('src/App.tsx');
const navbar = read('src/components/Navbar.tsx');
const shell = read('src/components/dashboard/DashboardShell.tsx');
const control = read('src/components/AppearanceControl.tsx');
const select = read('src/components/ui/Select.tsx');
const css = read('src/index.css');
const types = read('src/types.ts');

const appearanceKeys = ['appearanceLabel', 'appearanceLight', 'appearanceDark', 'appearanceSystem'];
const semanticTokens = [
  'background', 'surface', 'surface-muted', 'text-primary', 'text-secondary',
  'text-muted', 'border', 'border-strong', 'accent', 'accent-foreground',
  'focus', 'danger', 'danger-foreground', 'success', 'success-foreground',
  'warning', 'warning-foreground',
];

function darkSystem() {
  return { matchMedia: vi.fn(() => ({ matches: true })) };
}

describe('Batch E appearance tokens and selector', () => {
  it('keeps the shared selector stateless and free of persistence/system logic', () => {
    expect(control).toContain('value: AppearancePreference');
    expect(control).toContain('onChange: (value: AppearancePreference) => void');
    expect(control).not.toMatch(/useState|localStorage|sessionStorage|matchMedia|return4me\.appearance|prefers-color-scheme/);
    expect(app).toContain('const [appearancePreference, setAppearancePreference] = useState<AppearancePreference>');
  });

  it('offers exactly light, dark, and system values', () => {
    for (const value of ['light', 'dark', 'system'] as const) {
      expect(control).toContain(`<option value="${value}">`);
    }
    expect((control.match(/<option /g) || [])).toHaveLength(3);
    expect(control).not.toMatch(/value="(?:auto|default|light-mode|dark-mode|system-default)"/);
  });

  it('renders understandable English and Kiswahili labels from the central translations', () => {
    expect(translations.en).toMatchObject({
      appearanceLabel: 'Appearance', appearanceLight: 'Light', appearanceDark: 'Dark', appearanceSystem: 'System',
    });
    expect(translations.sw).toMatchObject({
      appearanceLabel: 'Mwonekano', appearanceLight: 'Mwanga', appearanceDark: 'Giza', appearanceSystem: 'Mfumo',
    });
    for (const key of appearanceKeys) {
      expect(Object.keys(translations.en)).toContain(key);
      expect(Object.keys(translations.sw)).toContain(key);
    }
    expect(types.match(/appearanceLabel:/g)).toHaveLength(2);
  });

  it('uses a named native select with visible selected state and 44px focusable target', () => {
    expect(control).toContain("import Select from './ui/Select'");
    expect(control).toContain('label={labels.appearance}');
    expect(control).toContain('hideLabel');
    expect(control).toContain('aria-label={labels.appearance}');
    expect(control).toContain('value={value}');
    expect(control).toContain('onChange=');
    expect(select).toContain('<select');
    expect(select).toContain('h-11');
    expect(select).toContain('focus:ring-2');
  });


  it('integrates the one shared control in desktop, drawer, and authenticated surfaces', () => {
    expect(navbar).toContain("import AppearanceControl from './AppearanceControl'");
    expect((navbar.match(/<AppearanceControl /g) || [])).toHaveLength(2);
    expect(navbar).toContain('fullWidth');
    expect(shell).toContain("import AppearanceControl from '../AppearanceControl'");
    expect((shell.match(/<AppearanceControl /g) || [])).toHaveLength(1);
    for (const shellSource of [navbar, shell]) {
      expect(shellSource).toContain('value={appearance}');
      expect(shellSource).toContain('onChange={setAppearance}');
    }
    expect(app).toContain('appearance={appearancePreference}');
    expect(app).toContain('setAppearance={setAppearancePreference}');
  });

  it('preserves the five-item public navigation and language controls', () => {
    for (const destination of ["handleNavClick('home')", 't.ownerBtn', 't.finderBtn', 't.becomeAgentBtn', 't.signInBtn']) {
      expect(navbar).toContain(destination);
    }
    expect(navbar).not.toMatch(/t\.agentBtn/);
    expect((navbar.match(/<LanguageControl /g) || [])).toHaveLength(3);
    expect(shell).toContain('<LanguageControl');
  });

  it('persists the selected preference but not the resolved system appearance', () => {
    for (const preference of ['light', 'dark', 'system'] as const) {
      const setItem = vi.fn();
      persistAppearance({ setItem }, preference);
      expect(setItem).toHaveBeenCalledWith(APPEARANCE_STORAGE_KEY, preference);
    }
    const setItem = vi.fn();
    const preference: AppearancePreference = 'system';
    persistAppearance({ setItem }, preference);
    expect(resolveAppearance(preference, darkSystem())).toBe('dark');
    expect(setItem).toHaveBeenCalledWith('return4me.appearance', 'system');
    expect(setItem).not.toHaveBeenCalledWith('return4me.appearance', 'dark');
  });

  it('defines a complete light semantic token foundation matching current colors', () => {
    const light = css.slice(css.indexOf(':root {', css.indexOf('APPEARANCE SEMANTIC TOKENS')), css.indexOf("html[data-theme='dark']"));
    for (const token of semanticTokens) expect(light).toContain(`--appearance-${token}:`);
    expect(light).toContain('--appearance-background: #FDF8EE');
    expect(light).toContain('--appearance-surface: #FFFFFF');
    expect(light).toContain('--appearance-surface-muted: #F4EFE6');
  });

  it('defines corresponding dark tokens only under the canonical root marker', () => {
    expect(css).toContain("html[data-theme='dark']");
    const dark = css.slice(css.indexOf("html[data-theme='dark']"));
    for (const token of semanticTokens) expect(dark).toContain(`--appearance-${token}:`);
    expect(css).not.toMatch(/^\s*\.dark\s*\{|^\s*\.light\s*\{|\[data-mode|\[data-appearance=/m);
    expect(css).not.toContain('data-theme="system"');
  });

  it('adds tokens without a mass Tailwind color migration or PWA metadata change', () => {
    const tokenStart = css.indexOf('APPEARANCE SEMANTIC TOKENS');
    const batchE = css.slice(tokenStart, css.indexOf('\nbody {', tokenStart));
    expect(batchE).not.toMatch(/bg-(?:white|black|gray|slate|zinc|neutral|stone)-\d|text-(?:white|black|gray|slate|zinc|neutral|stone)-\d/);
    expect(batchE).not.toContain('prefers-color-scheme');
    expect(app).not.toMatch(/theme-color|manifest/);
  });
});
