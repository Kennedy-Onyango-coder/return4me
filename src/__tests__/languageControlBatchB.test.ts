import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(repoRoot, relative), 'utf8');
const navbar = read('src/components/Navbar.tsx');
const controlCode = read('src/components/LanguageControl.tsx');
const app = read('src/App.tsx');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const navbarCode = stripComments(navbar);

describe('Batch B public language-control consolidation', () => {
  it('renders the shared control on desktop, compact header, and mobile drawer', () => {
    expect((navbar.match(/<LanguageControl /g) || [])).toHaveLength(3);
    expect((navbar.match(/layout="toggle"/g) || [])).toHaveLength(2);
    expect(navbar).toContain('layout="choices"');
  });

  it('exposes exactly the English and Kiswahili runtime values', () => {
    expect(navbar).toContain("lang: 'en' | 'sw'");
    expect(controlCode).toContain("(['en', 'sw'] as const)");
    expect(controlCode).toContain("setLang('en')");
    expect(controlCode).toContain("setLang('sw')");
    expect(controlCode).toContain("setLang(lang === 'en' ? 'sw' : 'en')");
    expect(controlCode).not.toMatch(/en[-_]KE|sw[-_]KE|french|arabic/i);
  });

  it('keeps App as owner and the control presentation-only', () => {
    expect(app).toContain('const [lang, setLang] = useState<AppLanguage>');
    expect(navbar).toContain("import LanguageControl from './LanguageControl'");
    expect(navbar).toContain('setLang={setLang}');
    expect(controlCode).not.toMatch(/useState|localStorage|sessionStorage|indexedDB|fetch\(|window\.location|history\./);
    expect(navbarCode).not.toMatch(/useState[^;]*(?:lang|language)/i);
  });

  it('uses named, keyboard-accessible controls with visible focus and 44px targets', () => {
    expect(controlCode).toContain('<fieldset>');
    expect(controlCode).toContain('<legend');
    expect(controlCode).toContain('aria-label=');
    expect(controlCode).toContain('aria-pressed={active}');
    expect((controlCode.match(/type="button"/g) || [])).toHaveLength(1);
    expect(controlCode).toContain("import Button from './ui/Button'");
    expect(read('src/components/ui/Button.tsx')).toContain("type = 'button'");
    expect((controlCode.match(/focus-visible:ring-2/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(controlCode).toContain('min-h-[44px]');
    expect(controlCode).toContain("size=\"md\"");
  });

  it('communicates the current language semantically and without color alone', () => {
    expect(controlCode).toContain('Current language: ${currentLanguage}');
    expect(controlCode).toContain('{active && <Check');
    expect(controlCode).toContain('current language');
    expect(controlCode).toContain('lugha ya sasa');
    expect(controlCode).toContain('<span>{currentLanguage}</span>');
  });

  it('does not alter the five-item public information architecture', () => {
    for (const destination of ["handleNavClick('home')", 't.ownerBtn', 't.finderBtn', 't.becomeAgentBtn', 't.signInBtn']) {
      expect(navbar).toContain(destination);
    }
    expect(navbar).not.toMatch(/t\.agentBtn/);
  });
});
