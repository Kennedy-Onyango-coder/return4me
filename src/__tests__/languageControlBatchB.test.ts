import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(repoRoot, relative), 'utf8');
const navbar = read('src/components/Navbar.tsx');
const app = read('src/App.tsx');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const navbarCode = stripComments(navbar);

describe('Batch B — the public bar is English-only (no language control)', () => {
  it('renders no language control on any public surface', () => {
    expect((navbar.match(/<LanguageControl /g) || [])).toHaveLength(0);
    expect(navbar).not.toContain('LanguageControl');
  });

  it('carries no `en | sw` language state or selection', () => {
    expect(navbarCode).not.toMatch(/\blang === 'sw'|\blang === 'en'/);
    expect(navbar).not.toContain("lang: 'en' | 'sw'");
    expect(app).not.toMatch(/AppLanguage/);
  });

  it('renders the appearance control from the central English dictionary', () => {
    expect(navbar).toContain("import AppearanceControl from './AppearanceControl'");
    for (const key of ['appearanceLabel', 'appearanceLight', 'appearanceDark', 'appearanceSystem']) {
      expect(navbar).toContain(`t.${key}`);
    }
  });

  it('does not alter the five-item public information architecture', () => {
    for (const destination of ["handleNavClick('home')", 't.ownerBtn', 't.finderBtn', 't.becomeAgentBtn', 't.signInBtn']) {
      expect(navbar).toContain(destination);
    }
    expect(navbar).not.toMatch(/t\.agentBtn/);
  });
});

