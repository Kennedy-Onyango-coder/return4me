import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  lostTrackPath,
  lostTrackSignInPath,
  accountPath,
  isSafeReturnPath,
  parsePublicRoute,
} from '../utils/publicRoutes';

// =============================================================================
// PHASE 16 — PRODUCT-WIDE REMEDIATION TRIPWIRES
// =============================================================================
// Five things changed in this phase, and each one is the kind of thing a later
// "small" edit can silently undo. They are pinned here in the same source-level
// style as the rest of this repository's boundary suites (there is no jsdom /
// React Testing Library harness in this project — see publicNavigation.test.ts,
// dashboardShellBoundary.test.ts and claimStatusPrivacy.test.ts for the same
// rationale):
//
//   1. Track My Claim is a CUSTOMER-AUTHENTICATED journey, enforced on BOTH
//      sides: the UI hands a signed-out visitor through the existing /account
//      boundary, and POST /api/claims/lookup resolves the session itself
//      (requireCustomerAuth) instead of trusting a hidden form.
//   2. The return path used for that hand-off is still a validated, internal,
//      app-owned path — never an open redirect.
//   3. The authenticated dashboard shell carries the OFFICIAL Return4me
//      wordmark instead of a generic role icon.
//   4. Authenticated workspaces use the full available viewport width.
//   5. The admin category editor is grouped into five labelled sections.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ownerViewTsx = read('src/components/OwnerView.tsx');
const ownerViewCode = stripComments(ownerViewTsx);
const appCode = stripComments(read('src/App.tsx'));
const shellTsx = read('src/components/dashboard/DashboardShell.tsx');
const shellCode = stripComments(shellTsx);
const adminCode = stripComments(read('src/components/AdminView.tsx'));
const serverTs = read('src/server.ts');

describe('16-A: Track My Claim is behind the customer authentication boundary', () => {
  it('the route builder returns the public /lost page with a non-sensitive intent flag', () => {
    expect(lostTrackPath()).toBe('/lost?track=1');
    // The intent carries no claim id, phone number or credential.
    expect(lostTrackPath()).not.toMatch(/token|secret|otp|phone|claim=/i);
  });

  it('the hand-off goes through the EXISTING /account boundary with a validated return', () => {
    expect(lostTrackSignInPath()).toBe('/account?next=%2Flost%3Ftrack%3D1');
    expect(accountPath(lostTrackPath())).toBe(lostTrackSignInPath());
    // ...and the destination survives the round trip as the owner journey.
    expect(parsePublicRoute('/account', '?next=%2Flost%3Ftrack%3D1')).toEqual({
      kind: 'account',
      next: '/lost?track=1',
    });
    expect(parsePublicRoute('/lost', '?track=1')).toEqual({ kind: 'view', view: 'owner' });
  });

  it('the widened return-path whitelist is still a closed alternation', () => {
    expect(isSafeReturnPath('/lost')).toBe(true);
    expect(isSafeReturnPath('/lost?track=1')).toBe(true);
    expect(accountPath('/lost?track=1')).toBe('/account?next=%2Flost%3Ftrack%3D1');
    // Nothing privileged, off-site or arbitrary became accepted by that widening.
    for (const stillUnsafe of [
      '//evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      '/console',
      '/agent_portal',
      '/account',
      '/lost/anything',
      '/losttrack',
    ]) {
      expect(isSafeReturnPath(stillUnsafe), `must stay unsafe: ${stillUnsafe}`).toBe(false);
    }
    // A query suffix can never escalate the destination to a privileged screen.
    expect(parsePublicRoute('/lost', '?track=1&next=/console')).toEqual({ kind: 'view', view: 'owner' });
  });

  it('OwnerView refuses to open the tracking form without a live session', () => {
    // The trigger consults the session FIRST and hands off instead of opening.
    expect(ownerViewCode).toContain('if (!isSignedIn) {');
    expect(ownerViewCode).toContain('onRequireTrackSignIn?.();');
    // ...and the modal is rendered only for a live session (defence in depth).
    expect(ownerViewCode).toContain('{showTrackModal && isSignedIn && (');
    // The signed-out state says so, in both languages, instead of pretending.
    expect(ownerViewTsx).toContain('Tracking a claim needs a Return4me account');
    expect(ownerViewTsx).toContain('Kufuatilia claim kunahitaji akaunti ya Return4me');
  });

  it('the post-authentication return opens the modal the visitor asked for', () => {
    expect(ownerViewCode).toContain('if (trackIntent && isSignedIn) {');
    expect(appCode).toContain('setTrackClaimIntent(wantsTrack)');
    expect(appCode).toContain('trackIntent={trackClaimIntent}');
    // Only the public owner page can ever carry the intent.
    expect(appCode).toMatch(/next\.view === 'owner'/);
  });

  it('the lookup request carries the cookie session and nothing new in its body', () => {
    // The cookie IS the customer session (httpOnly r4m_customer_session).
    expect(ownerViewCode).toMatch(/fetch\('\/api\/claims\/lookup', \{[\s\S]{0,400}credentials: 'same-origin'/);
    // The existing ownership proof is unchanged.
    expect(ownerViewTsx).toMatch(/body: JSON\.stringify\(\{ claimId: trackClaimId, phone: trackPhone \}\)/);
    // No second credential mechanism was introduced anywhere in this flow.
    expect(ownerViewCode).not.toMatch(/localStorage|sessionStorage|Bearer/);
  });

  it('the SERVER enforces the same boundary — hiding the form is not the control', () => {
    expect(serverTs).toMatch(/app\.post\('\/api\/claims\/lookup',\s*requireCustomerAuth,\s*claimGuessLimiter,/);
    // The ownership proof (the registered phone) is still required on top.
    expect(serverTs).toMatch(/claimPhoneClean !== cleanPhone/);
    // ...and it is the same middleware that guards every other customer route.
    expect(serverTs).toMatch(/import \{[^}]*\brequireCustomerAuth\b[^}]*\} from '\.\/services\/customerAuth'/);
  });
});

describe('16-B: the authenticated shell uses official Return4me branding', () => {
  it('renders the official wordmark already used by the public Navbar', () => {
    expect(shellTsx).toContain('src="/assets/logo_wordmark_transparent.png"');
    // The same asset path the public bar uses — no replacement logo was created.
    expect(read('src/components/Navbar.tsx')).toContain('src="/assets/logo_wordmark_transparent.png"');
    // Undistorted: height-driven with automatic width.
    expect(shellCode).toMatch(/className="h-6 w-auto object-contain"/);
  });

  it('no longer identifies the workspace with a generic role icon', () => {
    for (const genericIcon of ['LayoutDashboard', 'ShieldCheck', 'Store']) {
      expect(shellCode, `generic dashboard icon ${genericIcon} must be gone`).not.toContain(genericIcon);
    }
    // The role is still stated in words, so it is never image-only.
    expect(shellTsx).toContain('SURFACE_COPY');
  });
});

describe('16-C: authenticated workspaces use the available width', () => {
  it('the shell canvas, header and footer are full-bleed with responsive gutters', () => {
    expect(shellCode).not.toContain('max-w-7xl');
    const gutters = shellCode.match(/px-4 sm:px-6 lg:px-10/g) || [];
    expect(gutters.length).toBeGreaterThanOrEqual(3);
  });

  it('still keeps a way back to the public site and a way to sign out', () => {
    // The width change must not have removed the shell's two exits.
    expect(shellCode).toMatch(/onClick=\{onExitSite\}/);
    expect(shellCode).toMatch(/onClick=\{onSignOut\}/);
  });

  it('the shell still owns no session logic of its own', () => {
    expect(shellCode).not.toMatch(/fetch\(/);
    expect(shellCode).not.toMatch(/localStorage|agentToken|adminToken|customer_token/);
    expect(shellCode).not.toContain('<Navbar');
  });
});

describe('16-E: the public bar never tells a signed-in operator they are signed out', () => {
  const navbarCode = stripComments(read('src/components/Navbar.tsx'));

  it('derives a token-only-session flag from the SAME session state App owns', () => {
    expect(navbarCode).toContain(
      'const isTokenOnlySession = Boolean(token) && !accountSignedIn && !isAccountView;'
    );
  });

  it('withholds the customer account control from a token-only (agent/admin) session', () => {
    // All three surfaces — desktop bar, mobile drawer and bottom tab bar.
    expect((navbarCode.match(/\{!isTokenOnlySession && \(/g) || []).length).toBeGreaterThanOrEqual(3);
    // The control is withheld, not re-pointed: the customer entry point keeps
    // routing through the existing chooser for every other state.
    expect((navbarCode.match(/handleNavClick\('signin'\)/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('introduces no second session mechanism and no new public destination', () => {
    expect(navbarCode).not.toMatch(/fetch\(/);
    expect(navbarCode).not.toContain('customer_token');
    expect(navbarCode).not.toContain('agent_token');
    // The five public destinations are untouched.
    for (const binding of ["handleNavClick('home')", 't.ownerBtn', 't.finderBtn', 't.becomeAgentBtn', 't.signInBtn']) {
      expect(navbarCode, `public destination ${binding} must survive`).toContain(binding);
    }
  });

  it('still shows the ONE truthful action — Sign out — for any live session', () => {
    expect((navbarCode.match(/\{signedIn \? \(/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(navbarCode).toContain('const signedIn = Boolean(token) || accountSignedIn;');
  });
});

describe('16-D: the admin category editor is grouped into five sections', () => {
  it('declares the five labelled sections the form already modelled', () => {
    for (const id of [
      'cat-section-basic',
      'cat-section-privacy',
      'cat-section-review',
      'cat-section-fee',
      'cat-section-actions',
    ]) {
      expect(adminCode, `missing section ${id}`).toContain(`id="${id}"`);
      expect(adminCode, `${id} must label its region`).toContain(`aria-labelledby="${id}"`);
    }
  });

  it('keeps every existing control binding and id', () => {
    for (const id of [
      'cat-form-id', 'cat-form-name-en', 'cat-form-name-sw',
      'catFormPublicClueStyle', 'catFormIsSensitive', 'catFormElevatedReview',
      'catFormIsAdminModified', 'cat-form-total-fee', 'cat-form-finder-share',
      'cat-form-agent-share', 'cat-form-platform-share', 'cat-form-base-fee',
      'cat-form-complexity-fee', 'cat-form-delay-fee', 'cat-form-ceiling-pct',
      'cat-form-finder-cap', 'cat-form-finder-pct', 'cat-form-agent-pct',
      'cat-form-platform-pct',
    ]) {
      expect(adminCode, `control ${id} is gone`).toContain(id);
    }
    expect(adminCode).toContain('public_clue_style: catFormPublicClueStyle');
  });

  it('keeps exactly one submit path and the existing save/cancel actions', () => {
    expect(adminCode).toContain('onSubmit={handleSaveCategory}');
    expect((adminCode.match(/<Button\s[^>]*type="submit"/g) || []).length).toBeGreaterThanOrEqual(1);
    expect(adminCode).toContain('onClick={() => setShowCategoryForm(null)}');
    // The bilingual action labels survive the restructure.
    expect(adminCode).toContain('Save Category / Hifadhi');
    expect(adminCode).toContain('Cancel / Ghairi');
  });

  it('presents the checkboxes as labelled, ≥44px rows rather than bare boxes', () => {
    for (const id of ['catFormIsSensitive', 'catFormElevatedReview', 'catFormIsAdminModified']) {
      const labelIdx = adminCode.indexOf(`htmlFor="${id}"`);
      expect(labelIdx, `${id} must have a wrapping label`).toBeGreaterThan(-1);
      const row = adminCode.slice(labelIdx, labelIdx + 400);
      expect(row, `${id} row must meet the 44px touch-target floor`).toContain('min-h-11');
    }
    // No raw palette classes were reintroduced for those controls.
    expect(adminCode).not.toContain('bg-amber-50 border border-amber-200');
  });
});
