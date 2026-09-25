import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearanceMarker,
  isAppearancePreference,
  persistAppearance,
  readStoredAppearance,
  resolveAppearance,
  subscribeToSystemAppearance,
  type AppearancePreference,
  type MediaQueryListLike,
} from '../utils/appearancePreference';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(root, relative), 'utf8');
const app = read('src/App.tsx');
const utility = read('src/utils/appearancePreference.ts');
const navbar = read('src/components/Navbar.tsx');
const shell = read('src/components/dashboard/DashboardShell.tsx');
const css = read('src/index.css');
const html = read('index.html');

function storage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next; }),
    removeItem: vi.fn(() => { value = null; }),
  };
}

function query(matches: boolean, legacy = false) {
  const listeners: Array<() => void> = [];
  const media = {
    matches,
    addEventListener: legacy ? undefined : vi.fn((_type: 'change', listener: () => void) => { listeners.push(listener); }),
    removeEventListener: legacy ? undefined : vi.fn((_type: 'change', listener: () => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }),
    addListener: legacy ? vi.fn((listener: () => void) => { listeners.push(listener); }) : undefined,
    removeListener: legacy ? vi.fn((listener: () => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }) : undefined,
  } satisfies MediaQueryListLike;
  return {
    media,
    matchMedia: vi.fn(() => media),
    emit(next: boolean) {
      media.matches = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.length,
  };
}

describe('Batch D appearance preference foundation', () => {
  it('accepts only light, dark, and system and defaults safely to light', () => {
    for (const value of ['light', 'dark', 'system'] as const) {
      expect(isAppearancePreference(value)).toBe(true);
      expect(readStoredAppearance(storage(value))).toBe(value);
    }
    for (const value of ['dark-mode', 'LIGHT', 'auto', 'system-default', '{}', '123', null]) {
      expect(isAppearancePreference(value)).toBe(false);
    }
    expect(readStoredAppearance(storage(null))).toBe('light');
    expect(readStoredAppearance(null)).toBe('light');
  });

  it('cleans invalid persisted values and survives read/remove failures', () => {
    for (const value of ['dark-mode', 'LIGHT', 'auto', 'system-default', '{}', '123']) {
      const malformed = storage(value);
      expect(readStoredAppearance(malformed)).toBe('light');
      expect(malformed.removeItem).toHaveBeenCalledWith('return4me.appearance');
    }
    const readFailure = { getItem: vi.fn(() => { throw new Error('blocked'); }), removeItem: vi.fn() };
    expect(() => readStoredAppearance(readFailure)).not.toThrow();
    expect(readStoredAppearance(readFailure)).toBe('light');
    const removeFailure = storage('auto');
    removeFailure.removeItem.mockImplementation(() => { throw new Error('blocked'); });
    expect(readStoredAppearance(removeFailure)).toBe('light');
  });

  it('persists only the user preference and tolerates unavailable or failing storage', () => {
    for (const preference of ['light', 'dark', 'system'] as const) {
      const target = storage();
      persistAppearance(target, preference);
      expect(target.setItem).toHaveBeenCalledWith('return4me.appearance', preference);
    }
    const failing = { setItem: vi.fn(() => { throw new Error('quota'); }) };
    expect(() => persistAppearance(failing, 'dark')).not.toThrow();
    expect(() => persistAppearance(null, 'system')).not.toThrow();
  });

  it('resolves explicit preferences independently of system preference', () => {
    expect(resolveAppearance('light', query(true))).toBe('light');
    expect(resolveAppearance('dark', query(false))).toBe('dark');
  });

  it('resolves system through prefers-color-scheme and falls back to light safely', () => {
    const light = query(false);
    const dark = query(true);
    expect(resolveAppearance('system', light)).toBe('light');
    expect(resolveAppearance('system', dark)).toBe('dark');
    expect(light.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(resolveAppearance('system', {})).toBe('light');
    expect(resolveAppearance('system', { matchMedia: () => { throw new Error('blocked'); } })).toBe('light');
    expect(resolveAppearance('system', { matchMedia: () => null })).toBe('light');
  });

  it('subscribes to system changes only for system and supports modern listeners', () => {
    const modern = query(false);
    const onChange = vi.fn();
    const cleanup = subscribeToSystemAppearance('system', onChange, modern);
    expect(modern.listenerCount()).toBe(1);
    modern.emit(true);
    expect(onChange).toHaveBeenCalledOnce();
    expect(resolveAppearance('system', modern)).toBe('dark');
    cleanup();
    expect(modern.listenerCount()).toBe(0);
    expect(modern.media.removeEventListener).toHaveBeenCalledOnce();

    for (const preference of ['light', 'dark'] as const) {
      const explicit = query(false);
      subscribeToSystemAppearance(preference, onChange, explicit);
      expect(explicit.matchMedia).not.toHaveBeenCalled();
      expect(explicit.listenerCount()).toBe(0);
    }
  });

  it('supports and cleans up legacy system listeners when needed', () => {
    const legacy = query(false, true);
    const cleanup = subscribeToSystemAppearance('system', vi.fn(), legacy);
    expect(legacy.listenerCount()).toBe(1);
    cleanup();
    expect(legacy.listenerCount()).toBe(0);
    expect(legacy.media.removeListener).toHaveBeenCalledOnce();
  });

  it('uses one root marker containing only resolved light or dark', () => {
    const lightRoot = { setAttribute: vi.fn() };
    const darkRoot = { setAttribute: vi.fn() };
    applyAppearanceMarker(lightRoot, 'light');
    applyAppearanceMarker(darkRoot, 'dark');
    expect(lightRoot.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
    expect(darkRoot.setAttribute).toHaveBeenCalledWith('data-theme', 'dark');
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(utility.match(/data-theme/g)).toHaveLength(1);
  });

  it('keeps preference and effective appearance distinct', () => {
    const target = storage();
    const system = query(true);
    const preference: AppearancePreference = 'system';
    persistAppearance(target, preference);
    const effective = resolveAppearance(preference, system);
    expect(target.setItem).toHaveBeenCalledWith('return4me.appearance', 'system');
    expect(effective).toBe('dark');
    expect(effective).not.toBe('system');
    expect(APPEARANCE_STORAGE_KEY).toBe('return4me.appearance');
  });

  it('keeps App as the only appearance state owner and preserves the language foundation', () => {
    expect(app).toContain('const [appearancePreference, setAppearancePreference] = useState<AppearancePreference>');
    expect(app).toContain('const [effectiveAppearance, setEffectiveAppearance] = useState<EffectiveAppearance>');
    expect((utility.match(/useState/g) || [])).toHaveLength(0);
    expect(app).toContain("const LANGUAGE_STORAGE_KEY = 'return4me.language'");
    expect(app).toContain("type AppLanguage = 'en' | 'sw'");
    expect(navbar).toContain('<LanguageControl');
    expect(shell).toContain('<LanguageControl');
  });

  it('introduces no backend/database dependency and no broad surface migration', () => {
    const appAppearance = app.slice(app.indexOf('  const [appearancePreference'), app.indexOf('  const [activeAgentsCount'));
    expect(appAppearance).not.toMatch(/fetch\(|Authorization|agentToken|adminToken|claim|payment|settlement|cookie/i);
    expect(utility).not.toMatch(/fetch\(|agent|admin|claim|payment|settlement|database|api\//i);
    expect(css).not.toMatch(/\.dark\s*\{|\.light\s*\{|\[data-mode|\[data-appearance/);
    expect(html).not.toContain('appearance selector');
  });
});
