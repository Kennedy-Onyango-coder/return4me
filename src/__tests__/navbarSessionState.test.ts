import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// PHASE 11B — THE SITE CHROME MUST REFLECT THE SESSION THAT ACTUALLY EXISTS.
// =============================================================================
// The reported defect: "after signing in on each dashboard, the navbar still
// appears like the public navbar."
//
// ROOT CAUSE: the bar's only notion of a session was `token` — the agent/admin
// LOCALSTORAGE token. A customer session is a server-side COOKIE
// (services/customerAuth.ts), so App never passed anything to the bar for a
// customer, and `token={currentView === 'admin' ? adminToken : agentToken}`
// additionally meant an ADMIN's session vanished from the bar the moment
// /console was left. The bar therefore fell back to the public "Guest" +
// "Sign In" state for two of the three roles.
//
// These are source-level tripwires in the same style as
// publicNavigation.test.ts (this repository has no DOM/React harness), and they
// pin the fix in BOTH directions: the authenticated state, and the public IA
// that must not be disturbed by it.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const appTsx = read('src/App.tsx');
const navbarTsx = read('src/components/Navbar.tsx');
const navbarCode = stripComments(navbarTsx);
const accountTsx = read('src/components/CustomerAccountView.tsx');

describe('11B: the navbar reflects the live session for every role', () => {
  it('App resolves the CUSTOMER session (a cookie) and reports it to the bar', () => {
    // The SAME endpoint the account and /report-lost surfaces already use.
    expect(appTsx).toContain("fetch('/api/customer/me'");
    expect(appTsx).toContain('setCustomerSession');
    expect(appTsx).toContain('accountSignedIn={Boolean(customerSession)}');
  });

  it('a token-backed session is no longer dropped when the console is left', () => {
    expect(appTsx).toContain('token={agentToken || adminToken}');
    // The exact defect: adminToken was only passed while currentView === 'admin',
    // so navigating away reverted the bar to the public state.
    expect(appTsx).not.toContain("token={currentView === 'admin' ? adminToken : agentToken}");
  });

  it('the bar has ONE derived signed-in flag, and no longer keys off `token` alone', () => {
    expect(navbarCode).toContain('const signedIn = Boolean(token) || accountSignedIn;');
    // Desktop bar + mobile drawer both render the signed-out state from the
    // derived flag now.
    expect((navbarCode.match(/\{signedIn \? \(/g) || []).length).toBeGreaterThanOrEqual(2);
    // ...and the old token-only branch is gone from every surface.
    expect(navbarCode).not.toContain('{token ? (');
  });

  it('all three surfaces treat a signed-in account as an account, not a Sign In', () => {
    // Desktop bar, mobile drawer and bottom tab bar all branch on the account
    // session, so none of them can show a stale "Sign In" to a signed-in user.
    expect((navbarCode.match(/isAccountView \|\| accountSignedIn/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('the account control label keeps the public tripwire intact', () => {
    // publicNavigation.test.ts pins this exact contiguous shape as the proof that
    // a signed-OUT visitor is never offered "My Account".
    expect(navbarTsx).toMatch(/isAccountView \? \(lang === 'en' \? 'My Account'/);
    expect(navbarCode).toContain('const accountControlLabel =');
  });
});

describe('11B: ending a session actually ends it everywhere', () => {
  it('App logout revokes the customer cookie session, not just the tokens', () => {
    expect(appTsx).toContain("fetch('/api/customer/logout'");
    expect(appTsx).toContain('setCustomerSession(null)');
  });

  it('the account surface reports sign-out AND session expiry to App', () => {
    expect(accountTsx).toContain('onSessionEnded?');
    // ...and App clears the chrome state on that signal.
    expect(appTsx).toContain('onSessionEnded={() => setCustomerSession(null)}');
  });

  it('authentication re-resolves the session so the bar updates without a reload', () => {
    expect(appTsx).toContain('refreshCustomerSession();');
  });
});

describe('11B: the public navigation IA is unchanged', () => {
  it('still exposes exactly the five public destinations', () => {
    for (const binding of ["handleNavClick('home')", 't.ownerBtn', 't.finderBtn', 't.becomeAgentBtn', 't.signInBtn']) {
      expect(navbarTsx).toContain(binding);
    }
    expect(navbarTsx).not.toMatch(/t\.agentBtn/);
    // Phase 11A: reporting is reached from within /lost, never as a sixth item.
    expect(navbarTsx).not.toContain('report-lost');
  });

  it('all three surfaces still route Sign In through the one chooser', () => {
    expect((navbarTsx.match(/handleNavClick\('signin'\)/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('the touch-target floor is preserved', () => {
    expect(navbarTsx).toContain('min-h-[44px]');
  });

  it('the bar introduces no second authentication mechanism of its own', () => {
    // No network call, no credential storage, no agent-token handling in the bar.
    expect(navbarCode).not.toMatch(/fetch\(/);
    expect(navbarCode).not.toContain('agent_token');
    expect(navbarCode).not.toContain('customer_token');
  });
});
