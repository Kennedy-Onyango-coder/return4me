import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import Navbar from './components/Navbar';
import DashboardShell, { type DashboardSurface } from './components/dashboard/DashboardShell';
// Display-only identity helper for the dashboard shell header. It reads the
// admin username/userId CLAIM and never the token itself (see the module docs).
import { readAdminSessionIdentity, adminIdentityLabel } from './services/adminSession';
import HomeView from './components/HomeView';
import ErrorBoundary from './components/ErrorBoundary';
import { translations } from './types';
import { Loader2 } from 'lucide-react';
// Phase 7B public routing foundation. Pure helpers only — every history/DOM
// interaction stays in this file. No routing dependency is introduced.
import {
  parsePublicRoute,
  itemPath,
  accountPath,
  reportLostPath,
  reportLostSignInPath,
  legacyClaimItemId,
  viewForRoute,
  pathForView,
  isRestorableView,
  type PublicRoute,
  type PublicViewName,
} from './utils/publicRoutes';

// FinderView/OwnerView/AgentView/AdminView/PrivacyView/TermsView were all
// statically imported here, which meant every single visitor — including
// someone just landing on the homepage — downloaded the full JS for all
// six screens up front, AdminView (2,500 lines, the single largest
// component in the app) and AgentView (1,175 lines) included, even though
// the overwhelming majority of visitors are Owners/Finders who will never
// touch either. This is a mobile PWA aimed at Kenya, where data cost and
// network speed are real constraints for the target audience — shipping
// ~7,000 lines of view code nobody asked for on first load is exactly the
// kind of thing that quietly kills conversion on a slow connection.
// React.lazy() defers each view's chunk to the moment it's actually
// navigated to; Suspense below supplies a loading state for that instant.
const FinderView = lazy(() => import('./components/FinderView'));
const OwnerView = lazy(() => import('./components/OwnerView'));
const AgentView = lazy(() => import('./components/AgentView'));
const AdminView = lazy(() => import('./components/AdminView'));

const PrivacyView = lazy(() => import('./components/PrivacyView'));
const TermsView = lazy(() => import('./components/TermsView'));
const CustomerAccountView = lazy(() => import('./components/CustomerAccountView'));
// Phase 7B: the public /item/:id detail page. Lazy like the other non-home
// screens — a visitor landing on the homepage never downloads it.
const PublicItemView = lazy(() => import('./components/PublicItemView'));
// Phase 8.1 public navigation: the single Sign In chooser (Owner/Claimant vs
// Agent) and the public agent journey. Both are lazy like every other
// non-home screen, and both are presentation-only — they hold no credentials
// and delegate to the authentication surfaces that already exist.
const SignInView = lazy(() => import('./components/SignInView'));
const BecomeAgentView = lazy(() => import('./components/BecomeAgentView'));
// Phase 11A: the public "Report a Lost Item" entry point. Lazy like the rest,
// and a thin shell around the EXISTING customer lost-report experience — it
// renders no report form of its own.
const ReportLostView = lazy(() => import('./components/ReportLostView'));

// Shown for the brief moment a lazy view's chunk is being fetched — kept
// minimal and framework-agnostic (no dependency on any single view's
// styling) since it can appear before any view-specific CSS classes are
// even relevant.
function ViewLoadingFallback() {
  return (
    <div className="flex-grow flex items-center justify-center w-full py-24">
      <Loader2 className="animate-spin text-primary-green" size={28} />
    </div>
  );
}

export default function App() {
  const [lang, setLang] = useState<'en' | 'sw'>('en');
  const [currentView, setView] = useState<'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'privacy' | 'terms' | 'signin' | 'becomeAgent'>('home');
  const [categories, setCategories] = useState<any[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState<boolean>(true);
  const [categoriesError, setCategoriesError] = useState<boolean>(false);
  const [activeAgentsCount, setActiveAgentsCount] = useState<number | null>(null);
  const [recentItems, setRecentItems] = useState<any[]>([]);
  const [recentItemsLoading, setRecentItemsLoading] = useState<boolean>(true);
  const [recentItemsError, setRecentItemsError] = useState<boolean>(false);

  // Minimal customer-account entry point, reachable at /account. Kept as a
  // separate top-level mode so it needs no changes to the Navbar view union
  // or any existing screen.
  const [customerMode, setCustomerMode] = useState<boolean>(
    () => typeof window !== 'undefined' && parsePublicRoute(window.location.pathname, window.location.search).kind === 'account'
  );

  // ---------------------------------------------------------------------------
  // PHASE 7B — PUBLIC ROUTE STATE
  //
  // The single source of truth for "which public URL are we on". `currentView`
  // (below) keeps driving the existing screens exactly as before; `route` only
  // adds the addressable public surfaces (/item/:id, /account, /console,
  // /agent_portal) on top of them. There is deliberately no second navigation
  // system: Navbar clicks, found-item links, the account surface and browser
  // back/forward all funnel through applyRoute/navigate.
  // ---------------------------------------------------------------------------
  const [route, setRoute] = useState<PublicRoute>(() =>
    typeof window === 'undefined'
      ? { kind: 'home' }
      : parsePublicRoute(window.location.pathname, window.location.search)
  );

  // The item handed from /item/:id's "It's Mine" into the existing claim
  // journey. Null whenever the owner view was entered the old way (Navbar).
  const [claimItem, setClaimItem] = useState<any | null>(null);

  /**
   * Applies a location to the app's state. Does not touch history except for
   * the two cases that are themselves redirects (the legacy ?claim= link and
   * /console, both explained below) — callers decide whether to push or replace.
   *
   * `historyState` is the entry's own state (from popstate), used to restore
   * whichever state-driven screen that entry was showing when it was left.
   * `preferredView` lets a caller that is deliberately navigating to a screen
   * override that restoration (e.g. Navbar "Report an item").
   */
  const applyRoute = useCallback(
    (fullPath: string, historyState?: any, preferredView?: PublicViewName) => {
      const qIndex = fullPath.indexOf('?');
      const pathname = qIndex === -1 ? fullPath : fullPath.slice(0, qIndex);
      const search = qIndex === -1 ? '' : fullPath.slice(qIndex);

      // LEGACY COMPATIBILITY: social.ts has already published
      // https://return4me.co.ke/?claim=<itemId> links. Those must keep working,
      // and they must land on the same safe public page as /item/<itemId> —
      // never on an implicit claim or authentication action.
      const legacyItemId = legacyClaimItemId(pathname, search);
      if (legacyItemId) {
        window.history.replaceState(null, '', itemPath(legacyItemId));
        setRoute({ kind: 'item', itemId: legacyItemId });
        setCustomerMode(false);
        return;
      }

      const next = parsePublicRoute(pathname, search);
      setRoute(next);

      if (next.kind === 'console') {
        // REQUEST 04 — /console IS the admin route, and it stays in the URL.
        //
        // This branch used to rewrite the location to '/' the instant the panel
        // opened ("existing behaviour, preserved verbatim"). That was the bug:
        //   (a) it destroyed the bookmark/refresh target, so a reload always
        //       landed on the homepage; and
        //   (b) under React StrictMode the effect below runs twice in
        //       development — pass 1 rewrote the URL to '/', pass 2 re-read
        //       window.location (now '/'), resolved it to `home`, and replaced
        //       the admin view with the homepage. That is exactly the reported
        //       "/console redirects to the homepage".
        //
        // Nothing about admin authentication or authorization changes here.
        // AdminView still renders its own passcode + 2FA gate when there is no
        // token, and every /api/admin route still enforces its own explicit
        // role check server-side (see adminRouteAudit.test.ts).
        setView('admin');
        setCustomerMode(false);
        return;
      }

      if (next.kind === 'account') {
        setCustomerMode(true);
        return;
      }

      setCustomerMode(false);

      const forcedView = viewForRoute(next);
      if (forcedView) {
        setView(forcedView);
        return;
      }

      // The item surface renders from `route` itself; leave the underlying
      // state-driven view alone so Back returns to what the visitor was doing.
      // Phase 11A: /report-lost works the same way — it renders from `route`,
      // and the underlying view is whatever the navigating caller asked for
      // ('owner', so the bar keeps showing the lost-item journey).
      if (next.kind === 'item' || next.kind === 'reportLost') return;

      const remembered = historyState?.r4mView;
      if (isRestorableView(preferredView)) setView(preferredView);
      else if (isRestorableView(remembered)) setView(remembered);
      else setView('home');
    },
    []
  );

  /**
   * Navigates to a public path. The screen being LEFT is recorded on the
   * current history entry, so browser Back restores it (Home → /item/:id →
   * Back lands on Home rather than a bare URL).
   */
  const navigate = useCallback(
    (path: string, view?: PublicViewName) => {
      if (typeof window === 'undefined') return;
      window.history.replaceState(
        { r4mView: view ?? currentView },
        '',
        window.location.pathname + window.location.search
      );
      window.history.pushState({}, '', path);
      applyRoute(path, null, view);
    },
    [applyRoute, currentView]
  );

  // REQUEST 08 — the single "go to a screen" entry point used by every
  // in-content CTA (hero buttons, category explorer, footer links). It keeps
  // the browser URL in step with the screen, so /lost, /found,
  // /become-an-agent and /sign-in are real pages rather than hidden React
  // state. Screens with no dedicated path yet (home, privacy, terms) stay on
  // '/' and are switched in place when we are already there, so no redundant
  // history entry is created.
  const goToView = useCallback(
    (view: PublicViewName) => {
      if (typeof window === 'undefined') return;
      if (view === 'agent') {
        navigate('/agent_portal', 'agent');
        return;
      }
      if (view === 'admin') {
        navigate('/console', 'admin');
        return;
      }
      const target = pathForView(view);
      if (target === '/' && route.kind === 'home') {
        setView(view);
        return;
      }
      navigate(target, view);
    },
    [navigate, route.kind]
  );

  // Expose setView globally for components to route to terms/privacy
  // (scripts/audit-browser.mjs depends on this handle).
  useEffect(() => {
    (window as any).setView = setView;
    return () => {
      delete (window as any).setView;
    };
  }, []);

  // Browser back/forward + the one-time application of the initial location.
  // Applying the initial location here (rather than in a useState initializer)
  // keeps redirect handling — ?claim= → /item/:id — in a single place that every
  // entry point shares. /console is deliberately NOT a redirect any more: it
  // resolves to the console at its own URL (see applyRoute).
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      applyRoute(window.location.pathname + window.location.search, event.state);
    };
    window.addEventListener('popstate', onPopState);
    applyRoute(window.location.pathname + window.location.search, null);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyRoute]);

  // This is a single-page client-routed app — currentView switches which
  // screen renders, but the URL never changes and nothing ever touched
  // document.title, so every screen (home, report an item, track a claim,
  // agent dashboard, admin panel) showed the identical browser-tab title.
  // Beyond just looking broken with multiple tabs open, screen readers
  // announce document.title on a route/view change as the primary signal
  // that the page changed — with a static title, that announcement never
  // fires, so a screen-reader user gets no confirmation the screen updated
  // at all. Doesn't require a full router to fix.
  useEffect(() => {
    // PHASE 11A: /report-lost renders from `route`, not from `currentView`, so
    // it needs its own title branch — otherwise the reported page would
    // announce whichever screen the visitor happened to arrive from.
    if (route.kind === 'reportLost') {
      document.title = lang === 'sw'
        ? 'Ripoti Kitu Kilichopotea | Return4me'
        : 'Report a Lost Item | Return4me';
      return;
    }
    const titles: Record<typeof currentView, { en: string; sw: string }> = {
      home: { en: "Return4me | Kenya's Trusted Lost & Found Platform", sw: 'Return4me | Jukwaa la Kuaminika la Vitu Vilivyopotea Kenya' },
      finder: { en: 'Report a Found Item | Return4me', sw: 'Ripoti Ulichokipata | Return4me' },
      owner: { en: 'Find & Claim Your Lost Item | Return4me', sw: 'Tafuta na Dai Kilichopotea | Return4me' },
      agent: { en: 'Agent Dashboard | Return4me', sw: 'Dashibodi ya Wakala | Return4me' },
      admin: { en: 'Admin Panel | Return4me', sw: 'Paneli ya Msimamizi | Return4me' },
      privacy: { en: 'Privacy Policy | Return4me', sw: 'Sera ya Faragha | Return4me' },
      terms: { en: 'Terms of Service | Return4me', sw: 'Vigezo vya Huduma | Return4me' },
      // Phase 8.1 public navigation screens.
      signin: { en: 'Sign In | Return4me', sw: 'Ingia | Return4me' },
      becomeAgent: { en: 'Become an Agent | Return4me', sw: 'Kuwa Wakala | Return4me' },
    };
    document.title = titles[currentView][lang];
  }, [currentView, lang, route.kind]);

  // Token management for Agents & Admins
  const [agentToken, setAgentToken] = useState<string | null>(() => localStorage.getItem('agent_token'));
  const [adminToken, setAdminToken] = useState<string | null>(() => localStorage.getItem('admin_token'));

  // Sync tokens to localStorage
  const handleSetAgentToken = (token: string | null) => {
    setAgentToken(token);
    if (token) {
      localStorage.setItem('agent_token', token);
    } else {
      localStorage.removeItem('agent_token');
    }
  };

  const handleSetAdminToken = (token: string | null) => {
    setAdminToken(token);
    if (token) {
      localStorage.setItem('admin_token', token);
    } else {
      localStorage.removeItem('admin_token');
    }
  };

  // ---------------------------------------------------------------------------
  // PHASE 11B — THE CUSTOMER SESSION IS PART OF THE SITE CHROME TOO.
  //
  // A customer signs in through /account with an SMS OTP, and that session is
  // held server-side and referenced by an httpOnly cookie
  // (services/customerAuth.ts). Because it is NOT a localStorage token, App
  // never knew about it: `token={agentToken}` therefore left a freshly signed-in
  // customer looking at the PUBLIC bar ("Guest" + "Sign In"). This is the single
  // place that resolves it, from the SAME endpoint the account and /report-lost
  // surfaces already use. No second authentication mechanism is introduced.
  // ---------------------------------------------------------------------------
  const [customerSession, setCustomerSession] = useState<{ id: string; full_name?: string; phone?: string } | null>(null);

  const refreshCustomerSession = useCallback(async () => {
    if (typeof window === 'undefined') return null;
    try {
      const res = await fetch('/api/customer/me', { credentials: 'same-origin' });
      if (!res.ok) {
        // 401 and 403 both mean "no live, active customer session" — fail to the
        // signed-out state rather than displaying a session that does not exist.
        setCustomerSession(null);
        return null;
      }
      const data = await res.json().catch(() => null);
      const next = data?.customer ?? null;
      setCustomerSession(next);
      return next;
    } catch {
      setCustomerSession(null);
      return null;
    }
  }, []);

  // Resolve once on load, and again whenever the tab regains focus, so a session
  // that expired or was revoked server-side stops being reflected in the chrome.
  // Focus is a single, user-initiated event — this is not a poll.
  useEffect(() => {
    refreshCustomerSession();
    const onFocus = () => { refreshCustomerSession(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshCustomerSession]);

  /**
   * Ends EVERY session the browser holds and returns to the public home page.
   * Before this it cleared only the agent/admin localStorage tokens, so a
   * "Logout" left a live customer cookie behind and the account surface stayed
   * usable — the same confusion the bar already had about customer sessions.
   */
  const logout = () => {
    handleSetAgentToken(null);
    handleSetAdminToken(null);
    if (customerSession) {
      // Server-side revocation: the cookie is httpOnly, so only the server can
      // actually end the session. Best-effort — local state is cleared either
      // way, so the UI never keeps showing a session we are ending.
      fetch('/api/customer/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    }
    setCustomerSession(null);
    if (typeof window !== 'undefined' && window.location.pathname !== '/') {
      navigate('/', 'home');
    } else {
      setCustomerMode(false);
      setView('home');
    }
  };

  // Categories and the agent-count stat rarely change within a single
  // visit, so these stay mount-only. Recent items are different — a Finder
  // report + Agent verification can happen at any point during someone's
  // visit, and the homepage previously had no way to ever learn about it
  // (see fetchRecentItems below, and the effects that call it).
  useEffect(() => {
    const fetchCategories = async (attempt = 1) => {
      try {
        if (attempt === 1) {
          setCategoriesLoading(true);
          setCategoriesError(false);
        }
        const res = await fetch('/api/categories');
        if (!res.ok) throw new Error(`Failed to fetch categories (status ${res.status})`);
        const data = await res.json();
        setCategories(data);
        setCategoriesError(false);
        setCategoriesLoading(false);
      } catch (err) {
        console.error(`[Attempt ${attempt}/4] Failed to load categories:`, err);
        if (attempt < 4) {
          setTimeout(() => fetchCategories(attempt + 1), 3000);
        } else {
          setCategoriesError(true);
          setCategoriesLoading(false);
        }
      }
    };
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        setActiveAgentsCount(data.activeAgentsCount);
      } catch (err) {
        console.error('Failed to load stats:', err);
      }
    };
    fetchCategories();
    fetchStats();
  }, []);

  // RECENT ITEMS — fetchRecentItems is deliberately a single stable
  // function (via useCallback with an empty dependency array) rather than
  // being redefined inline inside a mount-only effect, because it now
  // needs to be called from three different places: once at mount, once
  // every time the user navigates back to the home view, and once every
  // 45 seconds while the home view is on screen. A previous visitor could
  // otherwise report an item, have it verified by an Agent, return to the
  // homepage, and still see the stale empty/old list from before — the
  // exact bug this fixes.
  //
  // isFetchingRecentItemsRef prevents overlapping requests (e.g. the
  // manual Refresh button clicked while a poll is already in flight), and
  // the AbortController ensures a request that's still in flight when the
  // component unmounts (or a newer request supersedes it) never calls
  // setState on an unmounted/stale render — no memory leak, no "Can't
  // perform a React state update on an unmounted component" warning, and
  // no risk of a slow, superseded response overwriting a newer one.
  const isFetchingRecentItemsRef = useRef(false);
  const recentItemsAbortRef = useRef<AbortController | null>(null);

  const fetchRecentItems = useCallback(async () => {
    if (isFetchingRecentItemsRef.current) return;
    isFetchingRecentItemsRef.current = true;

    recentItemsAbortRef.current?.abort();
    const controller = new AbortController();
    recentItemsAbortRef.current = controller;

    try {
      setRecentItemsLoading(true);
      setRecentItemsError(false);
      const res = await fetch('/api/items/search', { signal: controller.signal });
      if (!res.ok) throw new Error('Failed to fetch recent items');
      const data = await res.json();
      if (controller.signal.aborted) return;
      // Sort by created_at descending (most recent first)
      const sorted = data.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setRecentItems(sorted.slice(0, 4));
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // superseded by a newer request or unmount — not a real failure
      console.error('Failed to load recent items:', err);
      setRecentItemsError(true);
    } finally {
      if (!controller.signal.aborted) {
        setRecentItemsLoading(false);
      }
      isFetchingRecentItemsRef.current = false;
    }
  }, []);

  // Initial load.
  useEffect(() => {
    fetchRecentItems();
    return () => {
      recentItemsAbortRef.current?.abort();
    };
  }, [fetchRecentItems]);

  // Refetch every time the user navigates back to the home view — covers
  // returning from Finder (after reporting), Owner, Agent, or Admin. Also
  // polls every 45s while home stays on screen, so an item verified by an
  // Agent while someone is just sitting on the homepage still shows up
  // without them needing to navigate away and back.
  useEffect(() => {
    if (currentView !== 'home') return;
    fetchRecentItems();
    const intervalId = setInterval(fetchRecentItems, 45000);
    return () => clearInterval(intervalId);
  }, [currentView, fetchRecentItems]);

  const t = translations[lang];

  // ---------------------------------------------------------------------------
  // PART B — THE SHELL BOUNDARY (public site shell vs authenticated dashboard)
  //
  // App used to render ONE shell for the whole application: the public <Navbar>
  // + <main> + public <footer>. Every authenticated surface therefore rendered
  // INSIDE the public shell, so someone signed in and working in a dashboard was
  // still shown the five public destinations (Home · I Lost Something · I Found
  // Something · Become an Agent · Sign In) and the fixed mobile bottom tab bar.
  // Phase 11B only made that public bar session-aware ("My Account" + sign out);
  // it never created a boundary. A session-aware public bar is still a PUBLIC
  // bar, which is why the complaint persisted.
  //
  // The boundary is decided by a LIVE SESSION, not merely by which view is
  // selected:
  //   · /account (customerMode) is always an authenticated surface;
  //   · /agent_portal is a dashboard only once an agent token exists — WITHOUT
  //     one it is the public agent sign-in/registration page, which must keep
  //     public navigation;
  //   · /console is a dashboard only once an admin token exists — without one it
  //     is the public admin authentication gate.
  //
  // OwnerView (/lost) is deliberately NOT an authenticated dashboard: it is the
  // PUBLIC search/claim journey reachable by anyone from "I Lost Something". The
  // authenticated claimant dashboard is /account. Keeping OwnerView in the
  // public shell is required, not an oversight.
  //
  // The public Navbar is NOT MOUNTED on dashboard surfaces (not hidden with
  // CSS): no public destinations, no nav handlers and no mobile tab bar exist
  // while someone is inside a dashboard.
  // ---------------------------------------------------------------------------
  const dashboardSurface: DashboardSurface | null = customerMode
    ? 'account'
    : currentView === 'agent' && agentToken
      ? 'agent'
      : currentView === 'admin' && adminToken
        ? 'admin'
        : null;

  // A safe, display-only label for the dashboard shell's identity chip.
  //   · admin   — reuses the SAME helper AdminView already uses; it reads only
  //               the username/userId claim and can never return the token;
  //   · account — the customer's own name from the server session;
  //   · agent   — no trustworthy label exists at this level, so the generic
  //               word is used rather than inventing an identity.
  const dashboardIdentityLabel = dashboardSurface === 'admin'
    ? adminIdentityLabel(readAdminSessionIdentity(adminToken))
    : dashboardSurface === 'account'
      ? (customerSession?.full_name || (lang === 'en' ? 'My Account' : 'Akaunti Yangu'))
      : dashboardSurface === 'agent'
        ? (lang === 'en' ? 'Agent' : 'Wakala')
        : undefined;

  // The ONE customer-account surface, extracted so it renders in the dashboard
  // shell below. Every callback is unchanged from the previous inline version.
  const accountSurface = (
    <ErrorBoundary fallbackTitle="Account Page Crash">
      <CustomerAccountView
        lang={lang}
        onExit={() => {
          navigate('/', 'home');
        }}
        /* Phase 9C: a possible match opens the public /item/:id page,
           which is where the EXISTING "It's Mine" ownership journey
           begins. The matcher never becomes a second claim path. */
        onOpenItem={(itemId) => navigate(itemPath(itemId), 'home')}
        onAuthenticated={() => {
          // Return the visitor to the item they pressed "It's Mine" on,
          // so the journey continues instead of dead-ending on the
          // dashboard. The destination is validated in publicRoutes.ts
          // (internal app-owned paths only — never an open redirect).
          //
          // PHASE 11A: the same mechanism returns a lost reporter to
          // /report-lost, where the reporting experience is waiting.
          //
          // PHASE 11B: the customer now holds a live cookie session, so
          // re-resolve it here and the chrome switches out of its
          // public "Guest"/"Sign In" state immediately — no page reload.
          refreshCustomerSession();
          if (route.kind === 'account' && route.next) {
            navigate(route.next, route.next === reportLostPath() ? 'owner' : 'home');
          }
        }}
        /* PHASE 11B: signing out — or being rejected with 401 inside the
           dashboard — must clear the shell's session state as well, or the
           chrome would keep advertising a session the server has ended. */
        onSessionEnded={() => setCustomerSession(null)}
      />
    </ErrorBoundary>
  );

  // Authenticated surfaces get their own shell. Nothing below this line is the
  // public site: the public Navbar/footer are not rendered here at all.
  if (dashboardSurface) {
    return (
      <DashboardShell
        lang={lang}
        setLang={setLang}
        surface={dashboardSurface}
        identityLabel={dashboardIdentityLabel}
        onExitSite={() => navigate('/', 'home')}
        onSignOut={logout}
      >
        <Suspense fallback={<ViewLoadingFallback />}>
          {dashboardSurface === 'account' && accountSurface}

          {dashboardSurface === 'agent' && (
            <AgentView lang={lang} token={agentToken} setToken={handleSetAgentToken} />
          )}

          {dashboardSurface === 'admin' && (
            <ErrorBoundary fallbackTitle="Admin Panel Crash">
              <AdminView lang={lang} token={adminToken} setToken={handleSetAdminToken} />
            </ErrorBoundary>
          )}
        </Suspense>
      </DashboardShell>
    );
  }

  return (
    <div className="min-h-screen bg-brand-beige flex flex-col antialiased">
      {/* Global Brand Navbar */}
      <Navbar
        lang={lang}
        setLang={setLang}
        currentView={currentView}
        setView={setView}
        /* PHASE 11B: an admin session no longer evaporates the moment the
           console is left. `agentToken || adminToken` keeps whichever
           token-backed session is genuinely live, on every surface — before
           this, adminToken was only passed while currentView === 'admin', so
           navigating away reverted the bar to the public "Guest" state. */
        token={agentToken || adminToken}
        logout={logout}
        isAccountView={customerMode}
        /* The customer session is a cookie, so App resolves it and reports the
           answer here; `isAccountView` alone cannot express "signed in". */
        accountSignedIn={Boolean(customerSession)}
        onOpenAccount={() => {
          // Existing entry point, now addressable. Pushed (not replaced) so
          // browser Back returns the visitor to where they were.
          navigate('/account', 'home');
        }}
        onNavigate={(view) => goToView(view)}
      />

      {/* Main Content Area */}
      <main className="flex-grow flex flex-col md:flex-row max-w-7xl w-full mx-auto border-x border-brand-border bg-white shadow-sm pb-24 md:pb-0">
        
        {/* FEATURE WORKSPACE ROUTING */}
        {/* Only one of these views ever renders at a time (mutually exclusive
            on currentView), so a single Suspense boundary around all of
            them is sufficient — it only ever needs to cover whichever one
            chunk is currently being fetched. HomeView is statically imported
            (landing page — must paint instantly), the rest are lazy. */}
        {route.kind === 'item' ? (
          /* PHASE 7B — PUBLIC ITEM DETAIL. Rendered from the URL alone, so
             direct navigation, refresh, bookmarking, sharing and the legacy
             ?claim= link all work. */
          <ErrorBoundary fallbackTitle="Item Page Crash">
            <Suspense fallback={<ViewLoadingFallback />}>
              <PublicItemView
                lang={lang}
                itemId={route.itemId}
                categories={categories}
                onBack={() => navigate('/', 'home')}
                onContinueClaim={(item) => {
                  // Authenticated visitor: carry the SAME masked public item
                  // into the existing claim journey (the item id is preserved
                  // through the URL all the way to here).
                  setClaimItem(item);
                  navigate('/', 'owner');
                }}
                onRequireAuth={() => {
                  // NOT authenticated: stop at the existing customer
                  // authentication boundary, remembering where to come back to.
                  // No claim, payment or private data is reachable before it.
                  navigate(accountPath(itemPath(route.itemId)), 'home');
                }}
              />
            </Suspense>
          </ErrorBoundary>
        ) : route.kind === 'reportLost' ? (
          /* PHASE 11A — PUBLIC LOST-REPORT ENTRY POINT. Rendered from the URL
             alone, so /report-lost is linkable, bookmarkable and refresh-safe.
             The page itself resolves the customer session and either renders
             the EXISTING LostReportsSection or hands off to the existing
             /account authentication boundary with a validated return path. */
          <ErrorBoundary fallbackTitle="Lost Report Crash">
            <Suspense fallback={<ViewLoadingFallback />}>
              <div className="w-full p-4 sm:p-8">
                <ReportLostView
                  lang={lang}
                  onSignIn={() => navigate(reportLostSignInPath(), 'owner')}
                  onOpenItem={(itemId) => navigate(itemPath(itemId), 'owner')}
                  onBrowseFound={() => navigate('/lost', 'owner')}
                />
              </div>
            </Suspense>
          </ErrorBoundary>
        ) : (
        <Suspense fallback={<ViewLoadingFallback />}>
          {currentView === 'home' && (
            <HomeView
              lang={lang}
              setLang={setLang}
              /* REQUEST 08: the homepage CTA prop is the URL-aware navigator, so
                 every hero/category button leaves the browser on the matching
                 public path (/lost, /found, /become-an-agent). */
              setView={goToView}
              categories={categories}
              categoriesLoading={categoriesLoading}
              categoriesError={categoriesError}
              activeAgentsCount={activeAgentsCount}
              recentItems={recentItems}
              recentItemsLoading={recentItemsLoading}
              recentItemsError={recentItemsError}
              onOpenItem={(itemId: string) => navigate(itemPath(itemId), 'home')}
            />
          )}

          {currentView === 'finder' && (
            <div className="w-full p-4 sm:p-8">
              <FinderView
                lang={lang}
                categories={categories}
                categoriesLoading={categoriesLoading}
                categoriesError={categoriesError}
              />
            </div>
          )}

          {currentView === 'owner' && (
            <div className="w-full p-4 sm:p-8">
              <OwnerView
                lang={lang}
                categories={categories}
                categoriesLoading={categoriesLoading}
                categoriesError={categoriesError}
                /* Phase 7B: opens the public /item/:id page from a search
                   result, and lets /item/:id hand an item into this same claim
                   journey without rebuilding the claim flow. */
                onOpenItem={(itemId: string) => navigate(itemPath(itemId), 'owner')}
                initialClaimItem={claimItem}
                /* PHASE 11A: the lost-reporting entry point. This is what makes
                   the public "I Lost Something" journey actually offer a way to
                   report a loss, instead of only the claim/search journey. */
                onReportLost={() => navigate(reportLostPath(), 'owner')}
              />
            </div>
          )}

          {currentView === 'agent' && (
            <div className="w-full p-4 sm:p-8">
              <AgentView lang={lang} token={agentToken} setToken={handleSetAgentToken} />
            </div>
          )}

          {currentView === 'admin' && (
            <div className="w-full p-4 sm:p-8">
              <ErrorBoundary fallbackTitle="Admin Panel Crash">
                <AdminView lang={lang} token={adminToken} setToken={handleSetAdminToken} />
              </ErrorBoundary>
            </div>
          )}

          {/* Phase 8.1 — the public Sign In chooser. Presentation only: each
              path hands off to the authentication surface that already exists
              (/account for Owner/Claimant, /agent_portal for Agent), so no
              authentication mechanism is duplicated or replaced. */}
          {currentView === 'signin' && (
            <div className="w-full p-4 sm:p-8">
              <SignInView
                lang={lang}
                onOwnerSignIn={() => navigate('/account', 'home')}
                onAgentSignIn={() => navigate('/agent_portal', 'agent')}
                onBecomeAgent={() => goToView('becomeAgent')}
              />
            </div>
          )}

          {/* Phase 8.1 — the public agent journey. It explains the role and
              leads to the EXISTING agent sign-in/registration inside
              /agent_portal: no second registration flow, no invented figures. */}
          {currentView === 'becomeAgent' && (
            <div className="w-full p-4 sm:p-8">
              <BecomeAgentView
                lang={lang}
                onContinueToAgentPortal={() => navigate('/agent_portal', 'agent')}
                onSignIn={() => goToView('signin')}
              />
            </div>
          )}

          {currentView === 'privacy' && (
            <div className="w-full p-4 sm:p-8">
              <PrivacyView lang={lang} setView={setView} />
            </div>
          )}

          {currentView === 'terms' && (
            <div className="w-full p-4 sm:p-8">
              <TermsView lang={lang} setView={setView} />
            </div>
          )}
        </Suspense>
        )}

      </main>

      {/* Footer */}
      <footer className="bg-brand-light-gray border-t border-brand-border px-5 sm:px-12 py-8">
        <div className="mx-auto max-w-7xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          <div className="text-xs sm:text-sm text-brand-muted-text leading-relaxed">
            <p className="font-semibold text-brand-dark-text">
              &copy; {new Date().getFullYear()} Return4me. All rights reserved.
            </p>
            <p className="mt-1">Vetted &amp; Physical Handovers only.</p>
            <p className="mt-2">
              Data Protection Officer:{' '}
              <a href="mailto:dpo@return4me.co.ke" className="font-semibold text-primary-green hover:underline">
                dpo@return4me.co.ke
              </a>
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-6">
            <button onClick={() => setView('privacy')} className="text-xs sm:text-sm font-bold text-primary-green hover:underline cursor-pointer">
              Privacy Policy
            </button>
            <button onClick={() => setView('terms')} className="text-xs sm:text-sm font-bold text-primary-green hover:underline cursor-pointer">
              Terms of Service
            </button>
            <span className="text-xs sm:text-sm font-semibold text-brand-muted-text">Fee Schedule</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

