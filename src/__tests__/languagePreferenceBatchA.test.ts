import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { persistLanguage, readStoredLanguage } from '../App';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(root, relative), 'utf8');
const app = read('src/App.tsx');
const navbar = read('src/components/Navbar.tsx');
const shell = read('src/components/dashboard/DashboardShell.tsx');
const languageControl = read('src/components/LanguageControl.tsx');

function storage(initial?: string | null) {
  let value = initial;
  return {
    getItem: vi.fn(() => value),
    removeItem: vi.fn(() => { value = null; }),
    setItem: vi.fn((_key: string, next: string) => { value = next; }),
  };
}

describe('Batch A persistent English/Kiswahili language preference', () => {
  it('initializes safely from absent, valid, and invalid stored values', () => {
    expect(readStoredLanguage(storage(null))).toBe('en');
    expect(readStoredLanguage(storage('en'))).toBe('en');
    expect(readStoredLanguage(storage('sw'))).toBe('sw');

    for (const invalid of ['fr', 'english', 'undefined', '{}', '123']) {
      const malformed = storage(invalid);
      expect(readStoredLanguage(malformed)).toBe('en');
      expect(malformed.removeItem).toHaveBeenCalledWith('return4me.language');
    }
  });

  it('falls back to English when storage is unavailable or its read throws', () => {
    expect(readStoredLanguage(null)).toBe('en');
    const throwing = {
      getItem: vi.fn(() => { throw new Error('blocked'); }),
      removeItem: vi.fn(),
    };
    expect(() => readStoredLanguage(throwing)).not.toThrow();
    expect(readStoredLanguage(throwing)).toBe('en');
  });

  it('persists only canonical en/sw values', () => {
    for (const lang of ['en', 'sw'] as const) {
      const target = storage(null);
      expect(() => persistLanguage(target, lang)).not.toThrow();
      expect(target.setItem).toHaveBeenCalledWith('return4me.language', lang);
    }
  });

  it('does not let write failure break the current-session preference', () => {
    const target = {
      setItem: vi.fn(() => { throw new Error('quota/security failure'); }),
    };
    expect(() => persistLanguage(target, 'sw')).not.toThrow();
    expect(target.setItem).toHaveBeenCalledOnce();
    expect(persistLanguage(null, 'sw')).toBeUndefined();
  });

  it('keeps App as the sole language owner and existing controls unchanged', () => {
    expect(app).toContain("const [lang, setLang] = useState<AppLanguage>");
    expect((app.match(/const \[lang, setLang\]/g) || [])).toHaveLength(1);
    expect(languageControl).toContain("setLang('en')");
    expect(languageControl).toContain("setLang('sw')");
    expect(languageControl).toContain("setLang(lang === 'en' ? 'sw' : 'en')");
    expect(navbar).not.toMatch(/useState[^;]*(?:lang|language)/i);
    expect(shell).not.toMatch(/useState[^;]*(?:lang|language)/i);
  });

  it('synchronizes the actual HTML language code and guards non-browser use', () => {
    expect(app).toContain("const LANGUAGE_STORAGE_KEY = 'return4me.language'");
    expect(app).toContain("type AppLanguage = 'en' | 'sw'");
    expect(app).toMatch(/typeof document !== 'undefined'[\s\S]{0,120}document\.documentElement\.lang = lang/);
    expect(app).toMatch(/useEffect\(\(\) => \{[\s\S]{0,300}persistLanguage\(browserStorage\(\), lang\)[\s\S]{0,40}\}, \[lang\]\)/);
    expect(app).not.toMatch(/en_KE|sw_KE/);
  });

  it('does not add backend preference, authentication, payment, or theme behavior to language storage', () => {
    const preference = app.slice(app.indexOf('LANGUAGE_STORAGE_KEY'), app.indexOf('export default function App'));
    expect(preference).not.toMatch(/fetch\(|Authorization|agentToken|adminToken|claim|payment|settlement/);
    expect(preference).not.toMatch(/darkMode|data-theme|classList\.(?:add|remove)|prefers-color-scheme|matchMedia|ThemeProvider/);
    expect(app).not.toContain('return4me.theme');
  });
});
