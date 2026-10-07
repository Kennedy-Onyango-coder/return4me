import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(root, relative), 'utf8');
const app = read('src/App.tsx');
const navbar = read('src/components/Navbar.tsx');
const shell = read('src/components/dashboard/DashboardShell.tsx');
const types = read('src/types.ts');

describe('Batch A — English-only: no runtime language axis', () => {
  it('introduces no language state, storage helper or AppLanguage type', () => {
    expect(app).not.toMatch(/AppLanguage/);
    expect(app).not.toMatch(/readStoredLanguage|persistLanguage/);
    expect(app).not.toMatch(/const \[lang, setLang\]/);
    expect(app).not.toMatch(/\blang === 'sw'|\blang === 'en'/);
  });

  it('pins the document language to English and clears the legacy preference', () => {
    expect(app).toContain("const LEGACY_LANGUAGE_STORAGE_KEY = 'return4me.language'");
    expect(app).toContain("document.documentElement.lang = 'en'");
    expect(app).toMatch(/removeItem\(LEGACY_LANGUAGE_STORAGE_KEY\)/);
  });

  it('no longer renders the language control anywhere', () => {
    expect(navbar).not.toContain('LanguageControl');
    expect(shell).not.toContain('LanguageControl');
  });

  it('keeps only English copy in the dictionary', () => {
    expect(types).toContain('export const translations = {');
    expect(types).not.toMatch(/\bsw:/);
    expect(types).not.toContain('Kiswahili');
  });
});

