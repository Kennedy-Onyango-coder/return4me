import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(repoRoot, relative), 'utf8');
const app = read('src/App.tsx');
const navbar = read('src/components/Navbar.tsx');
const shell = read('src/components/dashboard/DashboardShell.tsx');
const control = read('src/components/LanguageControl.tsx');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const shellCode = stripComments(shell);
const controlCode = stripComments(control);

describe('Batch C authenticated language-control consistency', () => {
  it('keeps App as the sole language owner and passes its state into the authenticated shell', () => {
    expect(app).toContain('const [lang, setLang] = useState<AppLanguage>');
    expect((app.match(/const \[lang, setLang\]/g) || [])).toHaveLength(1);
    expect(app).toContain('<DashboardShell');
    expect(app).toContain('lang={lang}');
    expect(app).toContain('setLang={setLang}');
    expect(shell).toContain("lang: 'en' | 'sw'");
    expect(shell).toContain("setLang: (lang: 'en' | 'sw') => void");
  });

  it('uses the shared presentation control at the authenticated shell boundary', () => {
    expect(navbar).toContain("import LanguageControl from './LanguageControl'");
    expect(shell).toContain("import LanguageControl from '../LanguageControl'");
    expect((navbar.match(/<LanguageControl /g) || [])).toHaveLength(3);
    expect(shell).toContain('<LanguageControl');
    expect(shell).toContain('layout="toggle"');
    expect(shell).toContain('theme="inverse"');
  });

  it('preserves exactly English=en and Kiswahili=sw behavior', () => {
    expect(control).toContain("export type AppLanguage = 'en' | 'sw'");
    expect(control).toContain("(['en', 'sw'] as const)");
    expect(control).toContain("setLang('en')");
    expect(control).toContain("setLang('sw')");
    expect(control).toContain("setLang(lang === 'en' ? 'sw' : 'en')");
    expect(control).not.toMatch(/en[-_]KE|sw[-_]KE|french|arabic/i);
  });

  it('names current and target languages accurately and shows the current language', () => {
    expect(control).toContain("const currentLanguage = lang === 'en' ? 'English' : 'Kiswahili'");
    expect(control).toContain("const otherLanguage = lang === 'en' ? 'Kiswahili' : 'English'");
    expect(control).toContain('Current language: ${currentLanguage}. Switch to ${otherLanguage}.');
    expect(control).toContain('<span>{currentLanguage}</span>');
    expect(shell).not.toMatch(/aria-label=\{lang === 'en' \? 'Badilisha lugha'/);
  });

  it('uses native buttons, an approximately 44px target, and visible focus treatment', () => {
    expect(control).toContain('<Button');
    expect(control).toContain("type=\"button\"");
    expect(control).toContain("size=\"md\"");
    expect(control).toContain('min-h-[44px]');
    expect(control).toContain('focus-visible:ring-2');
    expect(control).toContain('focus-visible:ring-white');
    expect(control).toContain('focus-visible:ring-primary-green');
    expect(control).toContain('<Globe size={16} aria-hidden="true" />');
  });

  it('does not rely on color alone to communicate an active language', () => {
    expect(control).toContain('aria-pressed={active}');
    expect(control).toContain('{active && <Check');
    expect(control).toContain('current language');
    expect(control).toContain('lugha ya sasa');
    expect(control).toContain('<span>{currentLanguage}</span>');
  });

  it('keeps language state, storage, navigation, and session decisions out of the shell/control', () => {
    expect(shellCode).not.toMatch(/useState[^;]*(?:lang|language)/i);
    expect(controlCode).not.toMatch(/useState|localStorage|sessionStorage|indexedDB|return4me\.language|fetch\(|window\.location|history\./);
    expect(control).not.toMatch(/onExitSite|onSignOut|agentToken|adminToken|claim|payment|settlement/);
  });

  it('keeps account, agent, and admin surfaces behind the one DashboardShell', () => {
    const branch = app.slice(app.indexOf('if (dashboardSurface)'), app.lastIndexOf('return ('));
    for (const surface of ["dashboardSurface === 'account'", "dashboardSurface === 'agent'", "dashboardSurface === 'admin'"]) {
      expect(branch).toContain(surface);
    }
    expect((branch.match(/<LanguageControl/g) || [])).toHaveLength(0);
  });
});
