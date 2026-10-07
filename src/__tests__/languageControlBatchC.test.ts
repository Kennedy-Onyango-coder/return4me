import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(repoRoot, relative), 'utf8');
const app = read('src/App.tsx');
const navbar = read('src/components/Navbar.tsx');
const shell = read('src/components/dashboard/DashboardShell.tsx');

describe('Batch C — authenticated shells are English-only', () => {
  it('App owns no language state and passes none into the shell', () => {
    expect(app).not.toContain('const [lang, setLang]');
    expect(app).not.toMatch(/AppLanguage/);
    expect(app).toContain('<DashboardShell');
    expect(app).not.toContain('lang={lang}');
    expect(app).not.toContain('setLang={setLang}');
    expect(shell).not.toContain("lang: 'en' | 'sw'");
  });

  it('mounts no language control on the public bar or the authenticated shell', () => {
    expect(navbar).not.toContain('LanguageControl');
    expect(shell).not.toContain('LanguageControl');
  });

  it('keeps account, agent and admin surfaces behind the one DashboardShell', () => {
    const branch = app.slice(app.indexOf('if (dashboardSurface)'), app.lastIndexOf('return ('));
    for (const surface of ["dashboardSurface === 'account'", "dashboardSurface === 'agent'", "dashboardSurface === 'admin'"]) {
      expect(branch).toContain(surface);
    }
    expect((branch.match(/<LanguageControl/g) || [])).toHaveLength(0);
  });
});

