import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// DASHBOARD SHELL BOUNDARY
// =============================================================================
// The architectural requirement: the public site chrome (Navbar + public
// footer) is the PUBLIC SITE's shell, not a global one. An authenticated
// dashboard must render in its own shell, so the public destinations are not
// mounted at all while someone is signed in and working.
//
// WHY THIS TEST ASSERTS STRUCTURE RATHER THAN A CSS CLASS
//   The defect being prevented is "the public navbar is still mounted on a
//   dashboard". Hiding it with `hidden`/`display:none` would leave every public
//   destination and handler in the DOM and would still satisfy a class check.
//   These assertions therefore pin the RENDER BOUNDARY: the authenticated
//   branch returns DashboardShell and the public branch (the only place the
//   public Navbar appears) is reached only when there is no dashboard surface.
//
// This repository has no DOM/React harness (no jsdom, no React Testing
// Library) — source-level tripwires are the established convention here, the
// same style as adminConsoleShell.test.ts / navbarSessionState.test.ts.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const appTsx = read('src/App.tsx');
const appCode = stripComments(appTsx);
const shellTsx = read('src/components/dashboard/DashboardShell.tsx');
const shellCode = stripComments(shellTsx);

// The component's FINAL `return (` is the public shell; everything from the
// `if (dashboardSurface)` guard up to that point is the authenticated branch.
// (Slicing to the *first* `return (` after the guard would capture the guard
// itself and assert against an empty string.)
const publicReturnStart = appCode.lastIndexOf('return (');
const dashboardBranch = appCode.slice(appCode.indexOf('if (dashboardSurface)'), publicReturnStart);
const publicBranch = appCode.slice(publicReturnStart);

describe('dashboard shell boundary: the public Navbar is not mounted on dashboards', () => {
  it('the authenticated branch renders DashboardShell', () => {
    expect(dashboardBranch).toContain('<DashboardShell');
    expect(dashboardBranch).toContain('surface={dashboardSurface}');
  });

  it('the public Navbar appears in the PUBLIC branch only — never in the dashboard branch', () => {
    // The public bar exists...
    expect(publicBranch).toContain('<Navbar');
    // ...and is not rendered anywhere inside the authenticated branch.
    expect(dashboardBranch).not.toContain('<Navbar');
  });

  it('the public footer likewise stays out of the authenticated branch', () => {
    expect(publicBranch).toContain('<footer');
    expect(dashboardBranch).not.toContain('<footer');
  });

  it('the boundary is decided by a live session, not merely by the selected view', () => {
    // account is always authenticated; agent/admin require a real token. This is
    // what keeps /agent_portal and /console public until someone signs in.
    expect(appCode).toContain("? 'account'");
    expect(appCode).toMatch(/currentView === 'agent' && agentToken/);
    expect(appCode).toMatch(/currentView === 'admin' && adminToken/);
  });

  it('OwnerView / lost stays in the public branch (it is the public search/claim journey)', () => {
    // If owner were ever moved into the dashboard branch this tripwire fires.
    expect(dashboardBranch).not.toContain('<OwnerView');
    expect(publicBranch).toContain('<OwnerView');
  });

  it('the dashboard shell contains no public customer destinations of its own', () => {
    // The shell must not re-create the public nav it replaced.
    for (const dest of ['t.ownerBtn', 't.finderBtn', 't.becomeAgentBtn', 't.signInBtn']) {
      expect(shellCode, `DashboardShell must not render ${dest}`).not.toContain(dest);
    }
    expect(shellCode).not.toContain('handleNavClick');
    expect(shellCode).not.toContain('<Navbar');
  });

  it('the dashboard shell owns no authentication logic (no second session authority)', () => {
    expect(shellCode).not.toMatch(/fetch\(/);
    expect(shellCode).not.toContain('localStorage');
    expect(shellCode).not.toContain('agentToken');
    expect(shellCode).not.toContain('adminToken');
    expect(shellCode).not.toContain('customer_token');
  });

  it('the dashboard shell still offers a way back to the public site and a way to sign out', () => {
    expect(shellTsx).toContain('onExitSite');
    expect(shellTsx).toContain('onSignOut');
    // Both are real, labelled buttons rather than bare links.
    expect(shellTsx).toMatch(/onClick=\{onExitSite\}/);
    expect(shellTsx).toMatch(/onClick=\{onSignOut\}/);
  });

  it('every authenticated surface routes through one shell component', () => {
    for (const surface of ["'account'", "'agent'", "'admin'"]) {
      expect(appCode).toContain(`dashboardSurface === ${surface}`);
    }
    expect(appTsx).toContain("import DashboardShell");
  });
});
