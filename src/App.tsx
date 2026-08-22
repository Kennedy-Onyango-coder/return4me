import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import Navbar from './components/Navbar';
import ErrorBoundary from './components/ErrorBoundary';
import { translations } from './types';
import { Search, MapPin, Users, ShieldCheck, CheckCircle, ArrowRight, Globe, Info, Sparkles, Loader2 } from 'lucide-react';

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

  const getCategoryIcon = (categoryId: string) => {
    switch (categoryId) {
      case 'national-id':
        return <Search size={20} />;
      case 'vehicle-logbook':
        return <MapPin size={20} />;
      case 'driving-licence':
        return <ShieldCheck size={20} />;
      case 'number-plate':
        return <ShieldCheck size={20} />;
      default:
        return <Globe size={20} />;
    }
  };

  const getCategoryName = (categoryId: string) => {
    const cat = categories.find((c: any) => c.id === categoryId);
    if (cat) {
      return lang === 'en' ? cat.name_en : cat.name_sw;
    }
    if (categoryId === 'national-id') return lang === 'en' ? 'National ID' : 'Kitambulisho cha Kitaifa';
    if (categoryId === 'vehicle-logbook') return lang === 'en' ? 'Vehicle Logbook' : 'Kitabu cha Gari (Logbook)';
    if (categoryId === 'driving-licence') return lang === 'en' ? 'Driving Licence' : 'Leseni ya Udereva';
    if (categoryId === 'number-plate') return lang === 'en' ? 'Number Plate' : 'Bamba la Nambari';
    return lang === 'en' ? 'Found Document' : 'Hati Iliyopatikana';
  };

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

  const getAgentStatText = () => {
    if (activeAgentsCount === null || activeAgentsCount === 0) {
      return lang === 'en' 
        ? 'Growing Network of Verified Agents' 
        : 'Mtandao wa Mawakala Waliothibitishwa';
    }
    if (lang === 'en') {
      return `${activeAgentsCount} Verified Agent${activeAgentsCount !== 1 ? 's' : ''}`;
    } else {
      return `${activeAgentsCount} ${activeAgentsCount === 1 ? 'Wakala Aliyethibitishwa' : 'Mawakala Waliothibitishwa'}`;
    }
  };

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
      <main className="flex-grow flex flex-col md:flex-row max-w-7xl w-full mx-auto border-x border-brand-border bg-white shadow-sm pb-16 md:pb-0">
        
        {/* LANDING / HERO VIEW */}
        {currentView === 'home' && (
          <div className="flex flex-col w-full flex-grow">
            {/* Coded Top Hero Banner */}
            <div className="relative w-full border-b border-brand-border bg-primary-green overflow-hidden flex items-center justify-center py-16 sm:py-20 lg:py-24 px-4 sm:px-12">
              {/* Background Image with dark green overlay */}
              <div className="absolute inset-0 z-0">
                <img
                  src="/assets/hero-nairobi-street-callout.jpg"
                  alt="Nairobi City Skyline"
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
                <div className="absolute inset-0 bg-[#123124] opacity-50 mix-blend-multiply" />
              </div>

              {/* Decorative circles to match lower design */}
              <div className="absolute inset-0 opacity-5 pointer-events-none z-10">
                <div className="absolute -top-10 -left-10 w-40 h-40 rounded-full border-4 border-white" />
                <div className="absolute -bottom-10 -right-10 w-40 h-40 rounded-full border-4 border-white" />
              </div>

              {/* Hero Content */}
              <div className="relative z-20 max-w-3xl w-full text-center flex flex-col items-center">
                <h1 className="text-2xl sm:text-3xl font-extrabold text-white leading-tight mb-3 tracking-tight">
                  {lang === 'en' ? 'Lost something valuable?' : 'Je, umepoteza kitu cha thamani?'}
                </h1>
                <h2 className="text-3xl sm:text-5xl font-black text-accent-orange leading-none mb-6 tracking-tight uppercase">
                  {lang === 'en' ? 'We help return what matters most.' : 'Tunasaidia kurejesha kilicho muhimu zaidi.'}
                </h2>
                <p className="text-stone-200 text-xs sm:text-sm mb-8 max-w-lg leading-relaxed font-medium">
                  {lang === 'en' 
                    ? 'A trusted community platform for lost and found items in Kenya.' 
                    : 'Jukwaa la jamii linaloaminika kwa vitu vilivyopotea na kupatikana nchini Kenya.'}
                </p>

                {/* CTAs */}
                <div className="w-full max-w-md flex flex-col sm:flex-row gap-4 justify-center items-center">
                  <button 
                    onClick={() => setView('finder')}
                    className="w-full sm:w-1/2 bg-accent-orange hover:bg-accent-hover text-white py-4 rounded-xl font-extrabold text-xs shadow-xl shadow-black/20 uppercase tracking-wider cursor-pointer transition-all border border-transparent"
                  >
                    {t.finderBtn}
                  </button>
                  <button 
                    onClick={() => setView('owner')}
                    className="w-full sm:w-1/2 border-2 border-accent-orange hover:bg-accent-orange/10 text-accent-orange py-3.5 rounded-xl font-extrabold text-xs uppercase tracking-wider cursor-pointer transition-all bg-white/5 backdrop-blur-sm"
                  >
                    {lang === 'en' ? 'I lost something' : 'Nimepoteza Kitu'}
                  </button>
                </div>
              </div>
            </div>

            {/* Section 2: Registry Search (Full-width, bg-white) */}
            <div className="w-full bg-white py-16 sm:py-20 lg:py-24 px-4 sm:px-12 border-b border-brand-border">
              <div className="max-w-7xl mx-auto w-full flex flex-col items-center">
                
                <header className="mb-8 text-center max-w-2xl flex flex-col items-center">
                  <div className="inline-flex items-center space-x-2 bg-brand-light-gray px-3 py-1.5 rounded-full text-xs font-bold text-accent-orange border border-brand-border mb-4">
                    <ShieldCheck size={12} />
                    <span>
                      {lang === 'en' 
                        ? 'M-Pesa Escrow Protection & Official ID Verification' 
                        : 'Ulinzi wa Malipo ya M-Pesa na Uhakiki wa Kitambulisho cha Kitaifa'}
                    </span>
                  </div>

                  <h2 className="text-3xl sm:text-5xl font-extrabold leading-tight mb-4 tracking-tight text-primary-green">
                    {lang === 'en' ? 'Lost a document?' : 'Kupoteza hati?'}<br/>
                    <span className="text-accent-orange">
                      {lang === 'en' ? 'Search our secure registry.' : 'Tafuta rekodi zetu salama.'}
                    </span>
                  </h2>
                  
                  <p className="text-stone-500 text-sm sm:text-base leading-relaxed">
                    {t.motto}
                  </p>
                </header>

                {/* Clickable Search Bar to go to search */}
                <div 
                  onClick={() => setView('owner')}
                  className="relative w-full max-w-2xl mb-12 cursor-pointer"
                >
                  <div className="absolute left-5 top-1/2 -translate-y-1/2 text-brand-muted-text">
                    <Search size={20} strokeWidth={2.5} />
                  </div>
                  <input 
                    type="text" 
                    readOnly
                    placeholder={lang === 'en' ? "ID Number, Plate, or Full Name..." : "Nambari ya ID, Bamba, au Jina Kamili..."} 
                    className="w-full h-16 pl-14 pr-6 rounded-2xl border-2 border-brand-border bg-white text-lg focus:border-primary-green outline-none shadow-sm placeholder:text-stone-300 transition-all cursor-pointer font-medium text-brand-dark-text" 
                  />
                </div>

                {/* Recently Found Section */}
                <div className="w-full max-w-5xl flex flex-col">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-brand-muted-text">
                      {lang === 'en' ? 'Recently Found' : 'Imepatikana Hivi Karibuni'}
                    </h3>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => fetchRecentItems()}
                        disabled={recentItemsLoading}
                        className="text-xs font-bold text-brand-muted-text hover:text-primary-green disabled:opacity-50 cursor-pointer flex items-center gap-1"
                        aria-label={lang === 'en' ? 'Refresh recently found items' : 'Onyesha upya vitu vilivyopatikana hivi karibuni'}
                      >
                        <Loader2 size={12} className={recentItemsLoading ? 'animate-spin' : ''} />
                        {lang === 'en' ? 'Refresh' : 'Onyesha Upya'}
                      </button>
                      <button 
                        onClick={() => setView('owner')} 
                        className="text-xs font-bold text-primary-green hover:underline cursor-pointer"
                      >
                        {lang === 'en' ? 'View All Items →' : 'Tazama Zote →'}
                      </button>
                    </div>
                  </div>
                  
                  {recentItemsLoading ? (
                    /* Loading Skeleton */
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 w-full">
                      {[1, 2, 3, 4].map((i) => (
                        <div key={i} className="p-4 bg-brand-beige/50 border border-brand-border/60 rounded-xl flex gap-4 items-center animate-pulse">
                          <div className="w-12 h-12 bg-stone-200/60 rounded-lg shrink-0" />
                          <div className="flex-1 space-y-2">
                            <div className="h-4 bg-stone-200/80 rounded w-2/3" />
                            <div className="h-3 bg-stone-200/50 rounded w-5/6" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : recentItems.length === 0 ? (
                    /* Bilingual Empty State */
                    <div className="w-full text-center py-8 px-4 bg-brand-beige border border-brand-border/80 rounded-2xl flex flex-col items-center justify-center gap-4">
                      <div className="w-12 h-12 rounded-full bg-emerald-50 text-primary-green flex items-center justify-center">
                        <CheckCircle size={24} />
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-brand-dark-text">
                          {lang === 'en' ? 'No items reported yet — be the first!' : 'Hakuna vitu vilivyoripotiwa bado — kuwa wa kwanza!'}
                        </h4>
                        <p className="text-xs text-brand-muted-text mt-1">
                          {lang === 'en' 
                            ? 'Help reconnect Kenyans with their lost documents and valuables.' 
                            : 'Saidia kuunganisha Wakenya na hati zao za thamani zilizopotea.'}
                        </p>
                      </div>
                      <button
                        onClick={() => setView('finder')}
                        className="bg-primary-green hover:bg-primary-hover text-white text-xs font-bold px-4 py-2.5 rounded-lg shadow transition-all cursor-pointer"
                      >
                        {lang === 'en' ? 'Report a Found Item' : 'Ripoti Kitu Kilichopatikana'}
                      </button>
                    </div>
                  ) : (
                    /* Dynamic Real Cards Mapping */
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                      {recentItems.map((item: any) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setView('owner')}
                          className="p-4 bg-brand-beige border border-brand-border rounded-xl flex gap-4 items-center hover:shadow-sm hover:border-primary-green/40 transition-all duration-200 text-left cursor-pointer w-full"
                        >
                          <div className="w-12 h-12 bg-white rounded-lg flex items-center justify-center text-primary-green border border-brand-border shadow-sm shrink-0">
                            {getCategoryIcon(item.category_id)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-brand-dark-text font-sans truncate">
                              {getCategoryName(item.category_id)}
                            </p>
                            <p className="text-xs text-brand-muted-text truncate">
                              {(item.document_name_fuzzy || item.description || (lang === 'en' ? 'Verified Item' : 'Bidhaa Iliyothibitishwa'))} | {item.location_description}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

              </div>
            </div>

            {/* Section 3: Physical Handover Process (Full-width, bg-brand-beige) */}
            <div className="w-full bg-brand-beige py-16 sm:py-20 lg:py-24 px-4 sm:px-12 border-b border-brand-border">
              <div className="max-w-7xl mx-auto w-full flex flex-col items-center">
                <div className="text-center max-w-2xl mb-12">
                  <p className="text-xs font-bold text-brand-muted-text uppercase tracking-widest mb-3">
                    {lang === 'en' ? 'OUR COOPERATIVE SECURITY' : 'USALAMA WETU WA PAMOJA'}
                  </p>
                  <h2 className="text-3xl font-extrabold text-primary-green tracking-tight">
                    {lang === 'en' ? 'Physical Handover Process' : 'Mchakato wa Kuwasilisha Bidhaa'}
                  </h2>
                  <p className="text-stone-500 text-xs sm:text-sm mt-3 leading-relaxed">
                    {lang === 'en' 
                      ? 'Every document is physically protected through our nationwide chain of vetted pick-up points.' 
                      : 'Kila hati inalindwa physically kupitia mtandao wetu wa mawakala nchi nzima.'}
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-5xl">
                  <div className="bg-white border border-brand-border p-6 rounded-2xl shadow-sm hover:shadow-md transition-all flex flex-col gap-3">
                    <div className="w-10 h-10 rounded-full bg-emerald-50 text-primary-green flex items-center justify-center text-sm font-black mb-1">
                      1
                    </div>
                    <h3 className="font-extrabold text-base text-brand-dark-text leading-tight">
                      {lang === 'en' ? 'Report & Dropoff' : 'Ripoti na Uweke'}
                    </h3>
                    <p className="text-xs text-stone-500 leading-relaxed">
                      {lang === 'en' 
                        ? 'Finder snaps document safely; drops it physically at any of our vetted local agents.' 
                        : 'Mtafutaji anapiga picha ya hati salama na kuiweka physically kwa mmoja wa mawakala wetu.'}
                    </p>
                  </div>

                  <div className="bg-white border border-brand-border p-6 rounded-2xl shadow-sm hover:shadow-md transition-all flex flex-col gap-3">
                    <div className="w-10 h-10 rounded-full bg-emerald-50 text-primary-green flex items-center justify-center text-sm font-black mb-1">
                      2
                    </div>
                    <h3 className="font-extrabold text-base text-brand-dark-text leading-tight">
                      {lang === 'en' ? 'Vetted Hold' : 'Ulinzi Salama'}
                    </h3>
                    <p className="text-xs text-stone-500 leading-relaxed">
                      {lang === 'en' 
                        ? 'Vetted agents physically secure documents in safe lockboxes with immediate ledger tracking.' 
                        : 'Mawakala waliothibitishwa wanalinda hati hizo physically kwenye sanduku salama zenye ufuatiliaji.'}
                    </p>
                  </div>

                  <div className="bg-white border border-brand-border p-6 rounded-2xl shadow-sm hover:shadow-md transition-all flex flex-col gap-3">
                    <div className="w-10 h-10 rounded-full bg-emerald-50 text-primary-green flex items-center justify-center text-sm font-black mb-1">
                      3
                    </div>
                    <h3 className="font-extrabold text-base text-brand-dark-text leading-tight">
                      {lang === 'en' ? 'Verify & Retrieve' : 'Thibitisha na Kuchukua'}
                    </h3>
                    <p className="text-xs text-stone-500 leading-relaxed">
                      {lang === 'en' 
                        ? 'The rightful owner answers safety/verification questions, pays delivery escrow, and retrieves.' 
                        : 'Mmiliki halali anajibu maswali ya usalama/uthibitisho, analipia amana, na kuchukua.'}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Section 4: Deep green callout for Finders */}
            <div className="relative w-full overflow-hidden py-16 sm:py-20 lg:py-24 px-4 sm:px-12 border-b border-brand-border">
              {/* Background Image with dark green overlay */}
              <div className="absolute inset-0 z-0">
                <img
                  src="/assets/hero-nairobi-street-v2.jpg"
                  alt="Bustling Nairobi Street Scene"
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
                <div className="absolute inset-0 bg-[#123124] opacity-50 mix-blend-multiply" />
              </div>

              {/* Decorative circles to match lower design */}
              <div className="absolute inset-0 opacity-5 pointer-events-none z-10">
                <div className="absolute -top-10 -left-10 w-40 h-40 rounded-full border-4 border-white" />
                <div className="absolute -bottom-10 -right-10 w-40 h-40 rounded-full border-4 border-white" />
              </div>

              <div className="relative z-20 max-w-2xl mx-auto w-full text-center flex flex-col items-center">
                <div className="relative z-20 w-16 h-16 bg-white/30 backdrop-blur-sm rounded-full flex items-center justify-center mb-6 ring-8 ring-white/20 shadow-xl shadow-black/10 mx-auto">
                  <Sparkles size={28} className="text-accent-orange animate-pulse" />
                </div>
                <h3 className="text-3xl font-extrabold text-white mb-3 tracking-tight">
                  {lang === 'en' ? 'I found something' : 'Nimepata Kitu'}
                </h3>
                <p className="text-stone-200 text-xs sm:text-sm mb-8 max-w-md leading-relaxed font-medium">
                  {lang === 'en' ? 'Report it in 60 seconds. Get paid via M-Pesa once it reaches its owner.' : 'Ripoti ndani ya sekunde 60. Lipwa kupitia M-Pesa ikifika kwa mmiliki.'}
                </p>
                <div className="w-full max-w-sm flex flex-col sm:flex-row gap-4 justify-center items-center">
                  <button 
                    onClick={() => setView('finder')}
                    className="w-full sm:w-1/2 bg-accent-orange hover:bg-accent-hover text-white py-4 rounded-xl font-extrabold text-xs shadow-xl shadow-black/20 uppercase tracking-wider cursor-pointer transition-all border border-transparent"
                  >
                    {t.finderBtn}
                  </button>
                  <button 
                    onClick={() => setView('owner')}
                    className="w-full sm:w-1/2 border-2 border-accent-orange hover:bg-accent-orange/10 text-accent-orange py-3.5 rounded-xl font-extrabold text-xs uppercase tracking-wider cursor-pointer transition-all bg-white/5 backdrop-blur-sm"
                  >
                    {lang === 'en' ? 'I lost something' : 'Nimepoteza Kitu'}
                  </button>
                </div>
              </div>
            </div>

            {/* Section 5: Ecosystem & Payment partner bar (Full-width, bg-white) */}
            <div className="w-full bg-white py-16 sm:py-20 lg:py-24 px-4 sm:px-12">
              <div className="max-w-7xl mx-auto w-full flex flex-col gap-10">
                <div className="flex flex-col md:flex-row items-center justify-between gap-8 pb-10 border-b border-brand-border">
                  <div className="flex-1 max-w-2xl">
                    <p className="text-[10px] uppercase tracking-widest text-brand-muted-text font-bold mb-1.5">Our Ecosystem</p>
                    <h4 className="text-2xl font-black text-primary-green mb-3 tracking-tight">{getAgentStatText()}</h4>
                    <p className="text-sm text-stone-500 leading-relaxed font-medium">
                      Our nationwide safety ecosystem connects verified pick-up hubs, security lockers, M-Pesa points, and cyber cafes under strict local agent management.
                    </p>
                  </div>
                  <div className="w-24 h-24 grid grid-cols-2 gap-1.5 p-2 bg-brand-light-gray rounded-2xl shrink-0">
                    <div className="bg-primary-green rounded-md"></div>
                    <div className="bg-brand-border rounded-md"></div>
                    <div className="bg-brand-border rounded-md"></div>
                    <div className="bg-primary-green rounded-md"></div>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center text-primary-green shrink-0">
                      <ShieldCheck size={16} />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] font-bold uppercase text-brand-muted-text leading-none mb-1">Escrow Partner</span>
                      <span className="text-xs font-black text-emerald-600 tracking-tight">SECURE M-PESA GATEWAY</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-[10px] bg-emerald-50 text-primary-green border border-emerald-100 font-extrabold px-3.5 py-1.5 rounded-full uppercase tracking-wider">
                      KES 500 Average Fee
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* FEATURE WORKSPACE ROUTING */}
        {/* Only one of these six ever renders at a time (mutually exclusive
            on currentView), so a single Suspense boundary around all of
            them is sufficient — it only ever needs to cover whichever one
            chunk is currently being fetched. */}
        <Suspense fallback={<ViewLoadingFallback />}>
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

      {/* Geometric Balance Micro-Footer */}
      <footer className="h-auto py-6 bg-brand-light-gray border-t border-brand-border px-4 sm:px-12 flex flex-col sm:flex-row items-center justify-between gap-4 text-[10px] text-brand-muted-text font-medium w-full">
        <div className="text-center sm:text-left">
          &copy; {new Date().getFullYear()} Jamoko Solutions Ltd. All rights reserved. Vetted & Physical Handovers only.
          <div className="mt-1 font-semibold text-stone-400">
            ODPC Reg. No. [PENDING] | Data Protection Officer:{' '}
            <a href="mailto:dpo@return4me.co.ke" className="hover:underline text-primary-green">
              dpo@return4me.co.ke
            </a>
          </div>
        </div>
        <div className="flex gap-6 font-bold text-primary-green uppercase tracking-wider">
          <button onClick={() => setView('privacy')} className="hover:underline cursor-pointer text-[10px] font-bold">
            Privacy Policy
          </button>
          <button onClick={() => setView('terms')} className="hover:underline cursor-pointer text-[10px] font-bold">
            Terms of Service
          </button>
          <span className="text-[10px]">Fee Schedule</span>
        </div>
      </footer>
    </div>
  );
}
