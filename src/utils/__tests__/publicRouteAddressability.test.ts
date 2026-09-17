import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parsePublicRoute, pathForView, viewForRoute, isRestorableView } from '../publicRoutes';

// =============================================================================
// PHASE 9 — REQUEST 08 (professional URL addressability)
//             REQUEST 04 (/console must be a real, bookmarkable admin route)
// =============================================================================
// Pure-function coverage for the newly addressable public paths, plus a
// source-level tripwire for the /console redirect bug. This repository has no
// DOM harness (see publicNavigation.test.ts for the same rationale), so the
// App-level behaviour is asserted against the real source the way the other
// routing and privacy suites do.

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

describe('public paths resolve to the screen the URL names', () => {
  const cases: Array<[string, string]> = [
    ['/lost', 'owner'],
    ['/found', 'finder'],
    ['/become-an-agent', 'becomeAgent'],
    ['/sign-in', 'signin'],
  ];

  for (const [routePath, view] of cases) {
    it(`${routePath} opens the ${view} screen`, () => {
      // A trailing slash is tolerated, exactly like the paths that predate this.
      expect(parsePublicRoute(routePath)).toEqual({ kind: 'view', view });
      expect(parsePublicRoute(`${routePath}/`)).toEqual({ kind: 'view', view });
      expect(viewForRoute(parsePublicRoute(routePath))).toBe(view);
    });
  }

  it('keeps the routes that already existed working, unchanged', () => {
    expect(parsePublicRoute('/')).toEqual({ kind: 'home' });
    expect(parsePublicRoute('/console')).toEqual({ kind: 'console' });
    expect(parsePublicRoute('/agent_portal')).toEqual({ kind: 'agent' });
    expect(parsePublicRoute('/account')).toEqual({ kind: 'account', next: null });
    expect(parsePublicRoute('/item/R4M-1')).toEqual({ kind: 'item', itemId: 'R4M-1' });
  });

  it('an unknown path still falls back to home (never a blank screen)', () => {
    expect(parsePublicRoute('/nope')).toEqual({ kind: 'home' });
    expect(parsePublicRoute('/lost/report')).toEqual({ kind: 'home' });
    expect(parsePublicRoute('/console/items')).toEqual({ kind: 'home' });
  });
});

describe('pathForView is the inverse of the route parser', () => {
  it('round-trips every addressable view', () => {
    for (const view of ['owner', 'finder', 'becomeAgent', 'signin', 'agent'] as const) {
      const routePath = pathForView(view);
      const parsed = parsePublicRoute(routePath);
      expect(parsed.kind === 'view' || parsed.kind === 'agent', `${view} -> ${routePath}`).toBe(true);
      expect(viewForRoute(parsed)).toBe(view);
    }
  });

  it('screens with no dedicated path stay on "/" rather than inventing one', () => {
    expect(pathForView('home')).toBe('/');
    expect(pathForView('privacy')).toBe('/');
    expect(pathForView('terms')).toBe('/');
    expect(pathForView('admin')).toBe('/');
  });

  it('every addressable public path is also restorable from history (no Back dead-end)', () => {
    for (const view of ['owner', 'finder', 'becomeAgent', 'signin'] as const) {
      expect(isRestorableView(view), `${view} must be restorable`).toBe(true);
    }
    // ...while the authentication-gated surfaces stay excluded, as before.
    expect(isRestorableView('admin')).toBe(false);
    expect(isRestorableView('agent')).toBe(false);
  });
});

describe('/console is a real admin route (Request 04 regression tripwire)', () => {
  const appTsx = read('src/App.tsx');

  it('no longer rewrites the console URL to "/" when the panel opens', () => {
    // The exact defect: replaceState('/',) inside the console branch. It broke
    // the bookmark AND caused the StrictMode double-effect bounce back to Home.
    expect(appTsx).not.toContain("window.history.replaceState({}, '', '/')");
  });

  it('opens the admin view at the /console path and leaves the URL alone', () => {
    const start = appTsx.indexOf("if (next.kind === 'console')");
    expect(start, 'console branch not found in App.tsx').toBeGreaterThan(-1);
    const branch = appTsx.slice(start, start + 1800);
    expect(branch).toContain("setView('admin')");
    expect(branch).not.toContain('replaceState');
    expect(branch).not.toContain('pushState');
  });

  it('routes the admin nav entry through the addressable path, not a silent view swap', () => {
    expect(appTsx).toContain("navigate('/console', 'admin')");
  });

  it('does not weaken admin authorisation to make the route work', () => {
    // The console must still render its own gate and receive the real session —
    // App.tsx only decides which screen renders.
    expect(appTsx).toMatch(/<AdminView\s+lang=\{lang\}\s+token=\{adminToken\}/);
    const adminView = read('src/components/AdminView.tsx');
    expect(adminView).toContain('{!token && (');
  });
});

describe('navigation keeps the URL in step with the screen (Request 08)', () => {
  const appTsx = read('src/App.tsx');

  it('every screen-changing entry point goes through the URL-aware navigator', () => {
    expect(appTsx).toContain('const goToView = useCallback');
    expect(appTsx).toContain('onNavigate={(view) => goToView(view)}');
    expect(appTsx).toContain('setView={goToView}');
  });

  it('never puts sensitive data in a URL', () => {
    // The only query parameter the app ever writes is the validated, internal
    // `next` return destination — never a token, phone number or claim secret.
    const written = [...appTsx.matchAll(/navigate\(\s*([^,)]+)/g)].map((m) => m[1].trim());
    expect(written.length).toBeGreaterThan(0);
    for (const target of written) {
      expect(target, 'a navigate() target must not embed a credential').not.toMatch(/token|secret|otp/i);
    }
    expect(appTsx).toContain('accountPath(itemPath(route.itemId))');
  });

  it('the legacy ?claim= link still resolves to the safe public item page', () => {
    expect(appTsx).toContain('legacyClaimItemId(pathname, search)');
    expect(appTsx).toMatch(/history\.replaceState\(null, '', itemPath\(legacyItemId\)\)/);
  });
});
