import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  parsePublicRoute,
  reportLostPath,
  reportLostSignInPath,
  isSafeReturnPath,
  accountPath,
  viewForRoute,
  pathForView,
} from '../utils/publicRoutes';

// =============================================================================
// PHASE 11A (WP-1) — LOST-REPORT DISCOVERABILITY
// =============================================================================
// The Phase 11 forensic audit found that the public "I Lost Something"
// destination (/lost) renders the CLAIM/track journey only, while the real
// lost-report experience lived exclusively inside the account dashboard. These
// tests pin the fix in both directions:
//   * the entry point now exists on /lost and leads to dedicated reporting;
//   * the claim/tracking journey it already served is untouched;
//   * the authentication hand-off reuses the EXISTING validated return-path
//     mechanism (no second auth system, no open redirect);
//   * nothing public or unauthenticated can create a lost report.
//
// This repository has no DOM/React test harness (see publicNavigation.test.ts
// for the same rationale), so the UI-level guarantees are asserted against the
// real source, exactly as the other routing and privacy suites do.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

const ownerView = read('src/components/OwnerView.tsx');
const appTsx = read('src/App.tsx');
const navbarTsx = read('src/components/Navbar.tsx');
const reportLostView = read('src/components/ReportLostView.tsx');
const lostReportsSection = read('src/components/customer/LostReportsSection.tsx');
const lostReportServerRoutes = read('src/routes/lostReports.ts');

/** Comments are stripped where the assertion is about CODE, not prose. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const reportLostCode = stripComments(reportLostView);

describe('11A: /lost offers a way to REPORT a lost item', () => {
  it('the route is addressable and distinct from the claim journey', () => {
    expect(reportLostPath()).toBe('/report-lost');
    expect(parsePublicRoute('/report-lost')).toEqual({ kind: 'reportLost' });
    expect(parsePublicRoute('/report-lost/')).toEqual({ kind: 'reportLost' });
    // /lost itself is UNCHANGED — still the owner/claim journey.
    expect(parsePublicRoute('/lost')).toEqual({ kind: 'view', view: 'owner' });
    // ...and no nested path was invented for it.
    expect(parsePublicRoute('/lost/report')).toEqual({ kind: 'home' });
  });

  it('/report-lost renders from the route, so it is linkable and refresh-safe', () => {
    // It must not force a state-driven view: a crafted history entry must never
    // be able to turn it into something else.
    expect(viewForRoute({ kind: 'reportLost' })).toBeNull();
    // ...and it has no pathForView inverse (it is not a PublicViewName).
    expect(pathForView('owner')).toBe('/lost');
  });

  it('the /lost page visibly offers the two situations', () => {
    // Presenting a report entry point...
    expect(ownerView).toContain('onReportLost');
    expect(ownerView).toContain('Report a Lost Item');
    expect(ownerView).toContain('lost-entry-heading');
    // ...alongside, not instead of, the search/claim situation.
    expect(ownerView).toContain('It may have been found');
  });

  it('App wires the /lost entry point to the dedicated reporting page', () => {
    expect(appTsx).toContain('onReportLost={() => navigate(reportLostPath(), \'owner\')}');
    expect(appTsx).toContain('ReportLostView');
  });

  it('the public navbar is unchanged — no new destination was added', () => {
    // The brief fixes the public IA at five destinations; reporting is reached
    // from within /lost, not from a sixth nav item.
    expect(navbarTsx).not.toContain('report-lost');
    expect(navbarTsx).not.toMatch(/t\.agentBtn/);
    expect(navbarTsx).toContain('t.ownerBtn');
    expect(navbarTsx).toContain('t.finderBtn');
    expect(navbarTsx).toContain('t.becomeAgentBtn');
    expect(navbarTsx).toContain('t.signInBtn');
  });
});

describe('11A: the authenticated path reaches the EXISTING reporting experience', () => {
  it('/report-lost mounts the same component the dashboard mounts — no second form', () => {
    expect(reportLostCode).toContain("from './customer/LostReportsSection'");
    expect(reportLostCode).toContain('<LostReportsSection');
    // The ONE authoritative wizard is still owned by LostReportsSection.
    expect(lostReportsSection).toContain("import LostReportWizard from './LostReportWizard'");
    // ...and the new page never imports the wizard directly, because it must
    // never grow a second reporting flow of its own.
    expect(reportLostCode).not.toContain('LostReportWizard');
  });

  it('the reporting wizard opens immediately on the entry page', () => {
    expect(reportLostCode).toContain('startInWizard');
    // The opt-in is defaulted OFF, so the dashboard is behaviourally unchanged.
    expect(lostReportsSection).toContain('startInWizard = false');
    expect(lostReportsSection).toContain('useState(startInWizard)');
  });

  it('the dashboard still reaches reporting the way it always did', () => {
    expect(read('src/components/CustomerDashboard.tsx')).toContain('<LostReportsSection');
    // ...and the dashboard does NOT pass the new opt-in (unchanged first view).
    expect(read('src/components/CustomerDashboard.tsx')).not.toContain('startInWizard');
  });
});

describe('11A: the unauthenticated path reuses the EXISTING safe auth hand-off', () => {
  it('the sign-in destination is the existing /account boundary with a validated return path', () => {
    expect(reportLostSignInPath()).toBe('/account?next=%2Freport-lost');
    expect(accountPath('/report-lost')).toBe('/account?next=%2Freport-lost');
    expect(isSafeReturnPath('/report-lost')).toBe(true);
  });

  it('the widened whitelist is still a closed alternation — nothing else became safe', () => {
    // The only newly-accepted shape is the exact path, and the pre-existing
    // rejections all still hold.
    for (const stillUnsafe of [
      '//evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      'item/R4M-1',
      '/console',
      '/account',
      '/agent_portal',
      '/account?next=/item/x',
      '/report-lost/anything',
      '/item/../../etc/passwd',
      '/item/x/y',
      '',
      null,
    ]) {
      expect(isSafeReturnPath(stillUnsafe as any), `must stay unsafe: ${String(stillUnsafe)}`).toBe(false);
    }
    // The canonical item shape still works.
    expect(isSafeReturnPath('/item/R4M-123ABC')).toBe(true);
    expect(accountPath('/item/R4M-1')).toBe('/account?next=%2Fitem%2FR4M-1');
  });

  it('a query suffix on the return destination can never escalate to a privileged screen', () => {
    // isSafeReturnPath has ALWAYS validated the PATHNAME only (it splits on [?#]
    // before matching), which is why the destination below is accepted. The
    // guarantee that matters is behavioural, not lexical: the value still
    // resolves to the lost-report page and can never render the console.
    expect(isSafeReturnPath('/report-lost?next=/console')).toBe(true);
    expect(parsePublicRoute('/report-lost', '?next=/console')).toEqual({ kind: 'reportLost' });
    expect(parsePublicRoute('/console')).toEqual({ kind: 'console' });
  });

  it('an unsafe ?next is still discarded for the reporting destination', () => {
    expect(parsePublicRoute('/account', '?next=%2Freport-lost')).toEqual({
      kind: 'account',
      next: '/report-lost',
    });
    expect(parsePublicRoute('/account', `?next=${encodeURIComponent('//evil.example')}`)).toEqual({
      kind: 'account',
      next: null,
    });
  });

  it('the page resolves the session with the EXISTING customer endpoint, and invents no auth', () => {
    expect(reportLostCode).toContain("fetch('/api/customer/me')");
    // No second auth mechanism: no token handling, no credential storage.
    expect(reportLostCode).not.toMatch(/localStorage|sessionStorage|admin_token|agent_token/);
    // No password/OTP field is rendered by this page (the account surface owns it).
    expect(reportLostCode).not.toMatch(/type="password"|OTPInput/);
  });

  it('App returns the visitor to the reporting page after authenticating', () => {
    // The existing post-authentication return hook, extended to /report-lost.
    expect(appTsx).toMatch(/route\.kind === 'account' && route\.next/);
    expect(appTsx).toContain("route.next === reportLostPath() ? 'owner' : 'home'");
    expect(appTsx).toContain('onSignIn={() => navigate(reportLostSignInPath(), \'owner\')}');
  });
});

describe('11A: no public or unauthenticated lost-report write path was introduced', () => {
  it('the reporting page itself never posts a report', () => {
    expect(reportLostCode).not.toMatch(/method:\s*'POST'/);
    expect(reportLostCode).not.toContain('/api/lost-reports');
  });

  it('lost-report creation is still customer-authenticated server-side', () => {
    const routeLines = lostReportServerRoutes.split(/\r?\n/);
    const declarationFor = (needle: string) => {
      const line = routeLines.find((l) => l.includes(needle));
      expect(line, `route ${needle} not found`).toBeTruthy();
      return line as string;
    };
    // The CREATE route mounts a limiter first (IP ceiling), then authentication,
    // then the customer-keyed limiter — so `requireCustomerAuth` is asserted to
    // be present in the registration rather than assumed to come first.
    expect(declarationFor("app.post('/api/lost-reports'")).toContain('requireCustomerAuth');
    // Every read on that router is owner-scoped behind the same guard.
    expect(declarationFor("app.get('/api/lost-reports'")).toContain('requireCustomerAuth');
    expect(declarationFor("app.get('/api/lost-reports/:id'")).toContain('requireCustomerAuth');
  });

  it('the new page is not registered as a public unauthenticated API path', () => {
    // /report-lost is a client-side route only: there is no server endpoint that
    // accepts a report from it.
    expect(read('src/server.ts')).not.toContain("'/api/report-lost'");
  });
});
