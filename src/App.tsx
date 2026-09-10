import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import Navbar from './components/Navbar';
import HomeView from './components/HomeView';
import ErrorBoundary from './components/ErrorBoundary';
import { translations } from './types';
import { Loader2 } from 'lucide-react';

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
  const [currentView, setView] = useState<'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'privacy' | 'terms'>('home');
  const [categories, setCategories] = useState<any[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState<boolean>(true);
  const [categoriesError, setCategoriesError] = useState<boolean>(false);
  const [activeAgentsCount, setActiveAgentsCount] = useState<number | null>(null);
  const [recentItems, setRecentItems] = useState<any[]>([]);
  const [recentItemsLoading, setRecentItemsLoading] = useState<boolean>(true);
  const [recentItemsError, setRecentItemsError] = useState<boolean>(false);

  // Expose setView globally for components to route to terms/privacy
  useEffect(() => {
    (window as any).setView = setView;
    
    // Secret path check for admin portal access
    if (window.location.pathname === '/console') {
      setView('admin');
      window.history.replaceState({}, '', '/');
    }

    return () => {
      delete (window as any).setView;
    };
  }, []);

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
    const titles: Record<typeof currentView, { en: string; sw: string }> = {
      home: { en: "Return4me | Kenya's Trusted Lost & Found Platform", sw: 'Return4me | Jukwaa la Kuaminika la Vitu Vilivyopotea Kenya' },
      finder: { en: 'Report a Found Item | Return4me', sw: 'Ripoti Ulichokipata | Return4me' },
      owner: { en: 'Find & Claim Your Lost Item | Return4me', sw: 'Tafuta na Dai Kilichopotea | Return4me' },
      agent: { en: 'Agent Dashboard | Return4me', sw: 'Dashibodi ya Wakala | Return4me' },
      admin: { en: 'Admin Panel | Return4me', sw: 'Paneli ya Msimamizi | Return4me' },
      privacy: { en: 'Privacy Policy | Return4me', sw: 'Sera ya Faragha | Return4me' },
      terms: { en: 'Terms of Service | Return4me', sw: 'Vigezo vya Huduma | Return4me' },
    };
    document.title = titles[currentView][lang];
  }, [currentView, lang]);

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

  const logout = () => {
    handleSetAgentToken(null);
    handleSetAdminToken(null);
    setView('home');
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

  return (
    <div className="min-h-screen bg-brand-beige flex flex-col antialiased">
      {/* Global Brand Navbar */}
      <Navbar
        lang={lang}
        setLang={setLang}
        currentView={currentView}
        setView={setView}
        token={currentView === 'admin' ? adminToken : agentToken}
        logout={logout}
      />

      {/* Main Content Area */}
      <main className="flex-grow flex flex-col md:flex-row max-w-7xl w-full mx-auto border-x border-brand-border bg-white shadow-sm pb-24 md:pb-0">
        
        {/* FEATURE WORKSPACE ROUTING */}
        {/* Only one of these views ever renders at a time (mutually exclusive
            on currentView), so a single Suspense boundary around all of
            them is sufficient — it only ever needs to cover whichever one
            chunk is currently being fetched. HomeView is statically imported
            (landing page — must paint instantly), the rest are lazy. */}
        <Suspense fallback={<ViewLoadingFallback />}>
          {currentView === 'home' && (
            <HomeView
              lang={lang}
              setLang={setLang}
              setView={setView}
              categories={categories}
              categoriesLoading={categoriesLoading}
              categoriesError={categoriesError}
              activeAgentsCount={activeAgentsCount}
              recentItems={recentItems}
              recentItemsLoading={recentItemsLoading}
              recentItemsError={recentItemsError}
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

