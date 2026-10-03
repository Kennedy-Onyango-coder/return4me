import React, { useState, useEffect } from 'react';
import { translations } from '../types';
import { Globe, User, ShieldCheck, MapPin, Search, Home, Menu, X, LogOut } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import LanguageControl from './LanguageControl';
import AppearanceControl from './AppearanceControl';
import type { AppearancePreference } from '../utils/appearancePreference';

interface NavbarProps {
  lang: 'en' | 'sw';
  setLang: (lang: 'en' | 'sw') => void;
  appearance: AppearancePreference;
  setAppearance: (appearance: AppearancePreference) => void;
  currentView: 'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'terms' | 'privacy' | 'signin' | 'becomeAgent';
  setView: (view: 'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'terms' | 'privacy' | 'signin' | 'becomeAgent') => void;
  token: string | null;
  logout: () => void;
  /** True while the Account/dashboard surface is showing (Phase 2). Kept as a
   *  separate flag rather than a member of the `currentView` union so the
   *  account surface does not widen every view's prop types. */
  isAccountView?: boolean;
  /**
   * True when a live CUSTOMER session exists. A customer session is a
   * server-side cookie (services/customerAuth.ts), NOT a localStorage token, so
   * App resolves it from GET /api/customer/me and passes the answer down. It is
   * deliberately separate from `token` (agent/admin): the bar must reflect
   * whichever session is actually live, and a signed-in customer must never be
   * shown the public "Guest"/"Sign In" state again.
   */
  accountSignedIn?: boolean;
  /** Opens the Account/dashboard surface. */
  onOpenAccount?: () => void;
  /** Preferred handler for normal navigation when supplied; lets the app exit
   *  the account surface on any nav click. Falls back to setView. */
  onNavigate?: (view: 'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'terms' | 'privacy' | 'signin' | 'becomeAgent') => void;
}

// PHASE 8.1 — PUBLIC NAVIGATION IA
// The unauthenticated public destinations are exactly:
//   Home · I Lost Something · I Found Something · Become an Agent · Sign In
// "Agent Portal" is deliberately NOT a public destination any more. Agent
// ACCESS is unchanged and still lives at /agent_portal — it is now reached
// through "Become an Agent" (the public explanation of the role) and through
// Sign In → Agent. The internal label still exists in translations for
// non-navigation use, but no public surface renders it as a destination.

export default function Navbar({ lang, setLang, appearance, setAppearance, currentView, setView, token, logout, isAccountView = false, accountSignedIn = false, onOpenAccount, onNavigate }: NavbarProps) {
  const t = translations[lang];
  const appearanceLabels = {
    appearance: t.appearanceLabel,
    light: t.appearanceLight,
    dark: t.appearanceDark,
    system: t.appearanceSystem,
  };
  const [isOpen, setIsOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // BATCH 2 (navbar) — reduced motion.
  //
  // `useReducedMotion()` ships with the animation library already in use
  // (motion/react), so this honours the OS "reduce motion" setting without a
  // second media-query listener, a second state, or a new dependency. The
  // drawer's slide/scale and the active-nav underline keep their real motion
  // for everyone else; here they resolve instantly instead. Functionality,
  // focus handling and open/close behaviour are untouched.
  const prefersReducedMotion = useReducedMotion();

  // PHASE 11B — ONE SOURCE OF TRUTH FOR "IS SOMEONE SIGNED IN".
  //
  // Before this, the bar's entire idea of a session was `token` — the
  // agent/admin localStorage token. A customer session is a server-side cookie,
  // so a customer who had just completed OTP sign-in on /account still saw the
  // PUBLIC bar ("Guest" plus a "Sign In" button), and an admin reverted to that
  // same public state the moment they navigated away from /console (because App
  // only passed adminToken while currentView === 'admin'). `signedIn` is the one
  // derived flag every surface below reads, so all three roles agree. This adds
  // no second authentication mechanism: it consumes the SAME session state App
  // already owns.
  const signedIn = Boolean(token) || accountSignedIn;

  // PHASE 16 — A LIVE TOKEN SESSION IS STILL A SESSION.
  //
  // The account control below used to test only `isAccountView ||
  // accountSignedIn` — the CUSTOMER session. So an agent or an administrator
  // whose `agent_token`/`admin_token` was live, browsing the public site, fell
  // straight through to the signed-OUT branch and was shown a "Sign In" control
  // (and, on mobile, a "Sign In" tab), telling a signed-in operator they were
  // signed out. That is the exact class of untruthfulness Phase 16 removes.
  //
  // The account control belongs to the CUSTOMER account journey, and a token
  // session is NOT a customer session, so it is not re-pointed at /account (that
  // would be a different lie). For a token-only session the control is simply
  // not rendered: the bar keeps the public destinations and the ONE truthful
  // action, Sign out, and the agent/admin surfaces carry their own navigation.
  // No second authentication mechanism, no new public destination.
  const isTokenOnlySession = Boolean(token) && !accountSignedIn && !isAccountView;

  // The account control's label. `isAccountView` deliberately stays the FIRST
  // test and keeps this exact contiguous shape: publicNavigation.test.ts pins
  // `isAccountView ? (lang === 'en' ? 'My Account'` as the tripwire proving a
  // signed-OUT visitor is never offered "My Account" as a destination.
  const accountControlLabel = isAccountView ? (lang === 'en' ? 'My Account' : 'Akaunti Yangu') : accountSignedIn ? (lang === 'en' ? 'My Account' : 'Akaunti Yangu') : t.signInBtn;

  // Check if admin is logged in (to conditionally show admin console link)
  useEffect(() => {
    const adminToken = localStorage.getItem('admin_token');
    setIsAdmin(!!adminToken);
  }, [currentView, token]);

  const handleNavClick = (view: 'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'terms' | 'privacy' | 'signin' | 'becomeAgent') => {
    if (onNavigate) onNavigate(view);
    else setView(view);
    setIsOpen(false);
  };

  const handleAccountClick = () => {
    if (onOpenAccount) onOpenAccount();
    setIsOpen(false);
  };

  // REQUEST 13 — the Sign In control is deliberately styled differently from the
  // ordinary navigation links. It is the one item on this bar that starts a
  // session, so it reads as a control rather than a destination: an outlined
  // pill, on-brand (deep green on white), 44px tall for touch, and legible in
  // every state — resting, hover (a green tint with the SAME dark green text,
  // never white-on-light) and keyboard focus (the global :focus-visible ring).
  // No gradient, no neon, no size change on hover, so nothing shifts.
  // SPACING REMEDIATION — `ml-1` → `ml-0.5` and `px-3.5` → `px-3` return 14px.
  // The 44px touch height, the border, the 13px label, every state colour and
  // the focus ring are all UNCHANGED: this is the same control, sized to sit
  // in a row that was overflowing, not a smaller target.
  const signInButtonClass =
    'ml-0.5 inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap rounded-lg border border-[var(--appearance-border-strong)] bg-[var(--appearance-surface)] px-3 text-[13px] font-bold text-primary-green shadow-sm transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--appearance-focus)] focus-visible:ring-offset-2 ' +
    (currentView === 'signin'
      ? 'border-primary-green bg-primary-green/10'
      : 'text-primary-green hover:border-primary-green hover:bg-primary-green/10');

  const accountLinkClass =
    'relative px-3 py-2 text-sm font-medium transition-colors cursor-pointer rounded-md ' +
    (isAccountView
      ? 'text-primary-green'
      : 'text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]');

  // SPACING REMEDIATION — measured, not guessed. The five links plus Sign In
  // need ~503px at 13px. The 1024-1279px band (`lg` but not `xl`) only has
  // ~456px for them after the logo, tray and session block, so at a uniform
  // 13px the nav still overflowed its own box and `Home` still slid under the
  // logo (measured -19px even after the padding trims).
  //
  // So that band gets a genuinely denser scale — 12px type and `px-1.5` — while
  // 1280px and up keep the 13px / `px-2` treatment, which is the width the bar
  // was designed to look like. This is a responsive type step, not a squeeze:
  // it is applied at a breakpoint, not as a fractional or arbitrary value.
  //
  // UNCHANGED, because they are correctness rather than style: `whitespace-nowrap`
  // (a label never wraps) and `shrink-0` (a label never compresses). The 40px
  // min-height and the focus ring are also untouched.
  const navLinkClass = (view: string) =>
    'relative min-h-[40px] inline-flex shrink-0 items-center whitespace-nowrap rounded-lg px-1 text-[12px] xl:px-2 xl:text-[13px] font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--appearance-focus)] focus-visible:ring-offset-2 ' +
    (currentView === view
      ? 'text-primary-green'
      : 'text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)]');

  // BATCH 2 (navbar): the active-nav underline keeps its spring for normal
  // motion, and resolves immediately when the visitor asked for reduced motion.
  const navUnderlineTransition = prefersReducedMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 300, damping: 30 };

  const navLinkUnderline = (view) =>
    currentView === view ? (
      <motion.span
        layoutId="nav-underline"
        className="absolute bottom-0 left-3 right-3 h-0.5 bg-primary-green rounded-full"
        transition={navUnderlineTransition}
      />
    ) : null;

  return (
    <>
      <header className="h-[72px] xl:h-[76px] bg-[var(--appearance-surface)] text-[var(--appearance-text-primary)] sticky top-0 z-40 border-b border-[var(--appearance-border)] flex items-center shadow-[0_2px_12px_rgba(0,56,32,0.05)]">
        {/* SPACING REMEDIATION — the single measured lever for the whole bar.
            The desktop row is `logo · nav · utility tray · session` inside one
            flex line. Every item except the <nav> is `shrink-0`, so the nav was
            the only element that could give — and because its children are
            `shrink-0 whitespace-nowrap`, a squeezed nav did not compress its
            links, it OVERFLOWED them out of both sides (measured: `Home` landed
            89px INSIDE the logo box at 1024px). `justify-center` then split that
            overflow evenly, pushing the left spill under the logo and the right
            spill under the utility tray.
            So the fix is not an offset or a z-index: it is to make the row
            actually fit at the narrowest width `lg` still serves (1024px). The
            container padding and the inter-group gap are reduced here once, and
            the per-control trims live on each control's own class below. */}
        <div className="max-w-[1600px] w-full mx-auto px-4 sm:px-5 lg:px-6 flex items-center justify-between gap-2 lg:gap-3">
          {/* Brand Logo Group
              BATCH 2 (navbar): this was a `div role="button"` with a hand-rolled
              Enter/Space keydown handler. Return4me navigates by switching the
              App-owned `currentView` state, not by URL, so a real <a href> would
              be a link to nowhere — the project's own native navigation
              mechanism is a <button>. Swapping to it gives the logo a real
              button name, native activation, and native focus for free, so the
              ARIA role, the manual tabIndex and the keydown emulation are all
              removed rather than duplicated. The Home destination, the
              accessible name, the focus ring and the image are unchanged. */}
          <button
            type="button"
            className="shrink-0 flex items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--appearance-focus)] focus-visible:ring-offset-2 cursor-pointer select-none"
            onClick={() => handleNavClick('home')}
            aria-label={lang === 'sw' ? 'Nenda Nyumbani' : 'Go to Home'}
          >
            <img 
              src="/assets/logo_wordmark_transparent.png" 
              alt="Return4me Logo" 
              className="h-10 md:h-12 xl:h-[50px] w-auto max-w-[112px] sm:max-w-[130px] md:max-w-[160px] xl:max-w-[210px] object-contain"
              referrerPolicy="no-referrer"
            />
          </button>

          {/* SPACING REMEDIATION — `min-w-0` lets this box shrink below its
              content width without forcing the flex LINE to expand, which is
              what previously made the links escape out of both sides and slide
              under the logo and the utility tray.
              `justify-center` is KEPT: now that the row genuinely fits, it
              centres the group in the free space, which is what produces an
              even logo→Home gap rather than a lopsided one.
              There is deliberately NO `overflow-hidden` here: the five links
              plus Sign In need ~503px and the narrowest width `lg` serves
              (1024px) leaves ~520px for them, so the group fits on its own.
              Clipping is the wrong tool for a fit problem — it would hide a
              link rather than fix the constraint. Measured: logo→Home is +12px
              at 1024px, +76px at 1152px, +63px at 1280px, with no document
              overflow at any width. */}
          <nav className="hidden lg:flex min-w-0 flex-1 items-center justify-center gap-0" aria-label={lang === 'en' ? 'Main navigation' : 'Navishan kuu'}>
            {/* BATCH 2 (navbar): the active destination was only ever expressed
                as a colour + underline, so assistive technology had no way to
                tell where the visitor currently was. Each public destination now
                follows the SAME pattern already used by AdminView's tabs and
                CustomerDashboard: `aria-current="page"` only when that view is
                active, and absent otherwise. Inactive destinations never claim
                to be the current page. The `view` argument is the single source
                of truth for both the visual and the semantic state. */}
            <button onClick={() => handleNavClick('home')} className={navLinkClass('home')} aria-current={currentView === 'home' ? 'page' : undefined}>
              {lang === 'en' ? 'Home' : 'Mwanzo'}
              {navLinkUnderline('home')}
            </button>
            <button onClick={() => handleNavClick('owner')} className={navLinkClass('owner')} aria-current={currentView === 'owner' ? 'page' : undefined}>
              {t.ownerBtn}
              {navLinkUnderline('owner')}
            </button>
            <button onClick={() => handleNavClick('finder')} className={navLinkClass('finder')} aria-current={currentView === 'finder' ? 'page' : undefined}>
              {t.finderBtn}
              {navLinkUnderline('finder')}
            </button>
            <button onClick={() => handleNavClick('becomeAgent')} className={navLinkClass('becomeAgent')} aria-current={currentView === 'becomeAgent' ? 'page' : undefined}>
              {t.becomeAgentBtn}
              {navLinkUnderline('becomeAgent')}
            </button>
            {isAdmin && (
              <button onClick={() => handleNavClick('admin')} className={navLinkClass('admin')} aria-current={currentView === 'admin' ? 'page' : undefined}>
                {t.adminBtn}
                {navLinkUnderline('admin')}
              </button>
            )}
            {/* PHASE 16 — the customer account control is not offered to a
                token-only (agent/admin) session: it would read "Sign In" to
                someone who is signed in. See isTokenOnlySession above. */}
            {!isTokenOnlySession && (
            <button onClick={() => (isAccountView || accountSignedIn ? handleAccountClick() : handleNavClick('signin'))} className={isAccountView || accountSignedIn ? accountLinkClass : signInButtonClass} aria-current={currentView === 'signin' ? 'page' : undefined}>
              {accountControlLabel}
              {(isAccountView || accountSignedIn) && (
                <motion.span
                  layoutId="nav-underline"
                  className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary-green rounded-full"
                  transition={navUnderlineTransition}
                />
              )}
            </button>
            )}
          </nav>

          {/* BATCH 1 (navbar): the utility tray and the session block were gated
              at `xl`, while the compact header below is `lg:hidden`. That left
              1024-1279px showing a full desktop navbar with NO way to reach
              language, appearance, or session controls. `lg` restores the
              access that existed before the visual pass. */}
          {/* SPACING REMEDIATION — `gap-1.5 p-1` → `gap-1 px-1.5 py-0.5` and the
              inner gap: the tray holds a language toggle AND a native select
              whose `min-w-[9.5rem]` is the single widest control on the bar.
              The control itself, its options, its label and its focus behaviour
              are untouched (see AppearanceControl) — only the space AROUND it is
              reduced. The `focus-within` ring is preserved so keyboard focus
              still announces the tray as a group. */}
          <div className="hidden lg:flex shrink-0 items-center gap-1 rounded-xl border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] px-1.5 py-0.5 focus-within:ring-2 focus-within:ring-[var(--appearance-focus)] focus-within:ring-offset-1">
            <LanguageControl lang={lang} setLang={setLang} layout="toggle" toggleLabel={t.langToggle} />
            <AppearanceControl value={appearance} onChange={setAppearance} labels={appearanceLabels} minWidth="min-w-[6rem] xl:min-w-[9.5rem]" />
          </div>
          <div className="hidden lg:flex shrink-0 items-center border-l border-[var(--appearance-border)] pl-2">
            {signedIn ? (
              <button
                onClick={logout}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)] transition-colors cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--appearance-focus)]"
              >
                <LogOut size={15} />
                <span>{t.logout}</span>
              </button>
            ) : (
              <div className="flex items-center gap-1.5 px-2 py-1.5 text-sm font-medium text-[var(--appearance-text-muted)]">
                <User size={15} />
                <span>{lang === 'en' ? 'Guest' : 'Mgeni'}</span>
              </div>
            )}
          </div>

          {/* BATCH 1 (navbar): the compact header now carries BOTH utility
              controls, matching the desktop tray, so appearance never required
              opening the drawer. Same shared components, same props, same
              App-owned state; the drawer copies below are unchanged.

              SPACING REMEDIATION — the appearance select is allowed to flex
              (`min-w-0 flex-1`) so it absorbs only the space actually left
              over, instead of claiming a fixed minimum on a narrow phone. The
              language toggle keeps its FULL visible word and its 44px `md`
              size: Batch B/Batch C deliberately pin both, and abbreviating it
              to "EN"/"SW" would trade a real accessibility and legibility
              guarantee for a few pixels. The menu button and its aria-label
              are unchanged. */}
          <div className="flex lg:hidden items-center gap-1.5">
            <LanguageControl lang={lang} setLang={setLang} layout="toggle" toggleLabel={t.langToggle} />
            <AppearanceControl value={appearance} onChange={setAppearance} labels={appearanceLabels} minWidth="min-w-0 flex-1 sm:min-w-[6.5rem] sm:flex-none" />
            <button
              onClick={() => setIsOpen(true)}
              className="p-2 rounded-md text-[var(--appearance-text-primary)] hover:text-primary-green transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--appearance-focus)]"
              aria-label={lang === 'sw' ? 'Fungua menyu' : 'Open menu'}
            >
              <Menu size={22} />
            </button>
          </div>

        </div>
      </header>

      {/* Mobile Drawer Slide-out and Backdrop (Below lg) */}
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop Overlay */}
            {/* BATCH 2 (navbar) — reduced motion. Under a `reduce` preference the
                scrim and the panel resolve instantly (no fade, no slide) instead
                of animating. The elements, the fixed positioning, the z-order,
                the click-to-close handler and the lg:hidden behaviour are all
                unchanged, so the drawer works identically — it simply arrives
                without motion. The scrim keeps `bg-black/40`: see the note in
                the final report — no suitable existing semantic token exists, and
                inventing one purely to remove a literal is out of scope. */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2 }}
              onClick={() => setIsOpen(false)}
              className="fixed inset-0 bg-black/40 z-40 lg:hidden"
            />

            {/* Side Drawer Menu */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 h-full w-[290px] sm:w-[340px] bg-[var(--appearance-surface)] text-[var(--appearance-text-primary)] shadow-2xl z-50 flex flex-col border-l border-[var(--appearance-border)] lg:hidden"
            >
              {/* Drawer Header */}
              <div className="p-5 border-b border-[var(--appearance-border)] flex items-center justify-between bg-[var(--appearance-surface-muted)]">
                <img 
                  src="/assets/logo_wordmark_transparent.png" 
                  alt="Return4me Logo" 
                  className="h-10 w-auto object-contain"
                  referrerPolicy="no-referrer"
                />
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-2 rounded-lg bg-[var(--appearance-surface)] border border-[var(--appearance-border)] text-[var(--appearance-text-muted)] hover:text-primary-green hover:shadow-xs transition-all cursor-pointer"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Drawer Links */}
              <div className="flex-1 overflow-y-auto p-5 space-y-5">
                <div className="space-y-1.5">
                  <p className="text-xs font-bold text-[var(--appearance-text-muted)] uppercase tracking-widest px-3 mb-2">
                    {lang === 'en' ? 'Main Menu' : 'Menyu Kuu'}
                  </p>
                  
                  {/* Home */}
                  <button
                    onClick={() => handleNavClick('home')}
                    aria-current={currentView === 'home' ? 'page' : undefined}
                    className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left cursor-pointer ${
                      currentView === 'home' 
                        ? 'bg-primary-green/10 text-primary-green' 
                        : 'text-[var(--appearance-text-primary)] hover:bg-[var(--appearance-surface-muted)]'
                    }`}
                  >
                    <Home size={18} />
                    <span>{lang === 'en' ? 'Home' : 'Ukurasa wa Kwanza'}</span>
                  </button>

                  {/* Owner (Lost) */}
                  <button
                    onClick={() => handleNavClick('owner')}
                    aria-current={currentView === 'owner' ? 'page' : undefined}
                    className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left cursor-pointer ${
                      currentView === 'owner' 
                        ? 'bg-primary-green/10 text-primary-green' 
                        : 'text-[var(--appearance-text-primary)] hover:bg-[var(--appearance-surface-muted)]'
                    }`}
                  >
                    <Search size={18} />
                    <span>{t.ownerBtn}</span>
                  </button>

                  {/* Finder (Found) */}
                  <button
                    onClick={() => handleNavClick('finder')}
                    aria-current={currentView === 'finder' ? 'page' : undefined}
                    className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left cursor-pointer ${
                      currentView === 'finder' 
                        ? 'bg-primary-green/10 text-primary-green' 
                        : 'text-[var(--appearance-text-primary)] hover:bg-[var(--appearance-surface-muted)]'
                    }`}
                  >
                    <MapPin size={18} />
                    <span>{t.finderBtn}</span>
                  </button>

                  {/* Phase 8.1 — public agent journey. This replaced the
                      "Agent Portal" item: the internal portal is no longer a
                      public destination, while agent access is unchanged. */}
                  <button
                    onClick={() => handleNavClick('becomeAgent')}
                    aria-current={currentView === 'becomeAgent' ? 'page' : undefined}
                    className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left cursor-pointer ${
                      currentView === 'becomeAgent'
                        ? 'bg-primary-green/10 text-primary-green' 
                        : 'text-[var(--appearance-text-primary)] hover:bg-[var(--appearance-surface-muted)]'
                    }`}
                  >
                    <Globe size={18} />
                    <span>{t.becomeAgentBtn}</span>
                  </button>


                </div>

                {/* System Pages */}
                <div className="space-y-1.5 pt-4 border-t border-[var(--appearance-border)]/60">
                  <p className="text-xs font-bold text-[var(--appearance-text-muted)] uppercase tracking-widest px-3 mb-2">
                    {lang === 'en' ? 'Legals & Info' : 'Sheria na Taarifa'}
                  </p>
                  
                  {/* Terms */}
                  <button
                    onClick={() => handleNavClick('terms')}
                    aria-current={currentView === 'terms' ? 'page' : undefined}
                    className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left cursor-pointer ${
                      currentView === 'terms' 
                        ? 'bg-primary-green/10 text-primary-green' 
                        : 'text-[var(--appearance-text-primary)] hover:bg-[var(--appearance-surface-muted)]'
                    }`}
                  >
                    <span>{lang === 'en' ? 'Terms of Service' : 'Masharti ya Matumizi'}</span>
                  </button>

                  {/* Privacy */}
                  <button
                    onClick={() => handleNavClick('privacy')}
                    aria-current={currentView === 'privacy' ? 'page' : undefined}
                    className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left cursor-pointer ${
                      currentView === 'privacy' 
                        ? 'bg-primary-green/10 text-primary-green' 
                        : 'text-[var(--appearance-text-primary)] hover:bg-[var(--appearance-surface-muted)]'
                    }`}
                  >
                    <span>{lang === 'en' ? 'Privacy Policy' : 'Sera ya Faragha'}</span>
                  </button>
                </div>
              </div>

              {/* Drawer Footer Controls */}
              <div className="p-5 border-t border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] space-y-4">
                {/* Localized Language Selector */}
                <LanguageControl lang={lang} setLang={setLang} layout="choices" toggleLabel={t.langToggle} />
                <AppearanceControl value={appearance} onChange={setAppearance} labels={appearanceLabels} fullWidth />

                {/* Account (Phase 2) — opens the customer account / dashboard.
                    A single restrained entry point rather than a new section:
                    the account surface reuses this same site chrome and is not
                    a separate application. */}
                {/* PHASE 16 — same rule as the desktop bar: a token-only
                    (agent/admin) session is never shown the customer "Sign In"
                    entry point. See isTokenOnlySession above. */}
                {!isTokenOnlySession && (
                <button
                  onClick={() => (isAccountView || accountSignedIn ? handleAccountClick() : handleNavClick('signin'))}
                  aria-current={(isAccountView || currentView === 'signin') ? 'page' : undefined}
                  className={`w-full min-h-[44px] py-3 rounded-xl border text-xs font-bold transition-all cursor-pointer flex items-center justify-center space-x-2 ${
                    isAccountView || accountSignedIn
                      ? 'bg-primary-green/10 border-primary-green/30 text-primary-green'
                      : 'bg-[var(--appearance-surface)] border-[var(--appearance-border)] text-[var(--appearance-text-primary)] hover:bg-[var(--appearance-surface-muted)]'
                  }`}
                >
                  <User size={14} />
                  <span>{accountControlLabel}</span>
                </button>
                )}

                {/* Account Actions */}
                {signedIn ? (
                  <button
                    onClick={() => {
                      logout();
                      setIsOpen(false);
                    }}
                    className="w-full bg-accent-strong hover:bg-accent-strong-hover text-white text-xs font-bold py-3.5 rounded-xl shadow-md shadow-orange-500/10 transition-all cursor-pointer flex items-center justify-center space-x-2"
                  >
                    <LogOut size={14} />
                    <span>{t.logout}</span>
                  </button>
                ) : (
                  <div className="py-2.5 px-3 bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-xl flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <div className="w-8 h-8 rounded-full bg-[var(--appearance-surface-muted)] flex items-center justify-center text-accent-orange">
                        <User size={14} />
                      </div>
                      <span className="text-xs font-bold text-[var(--appearance-text-primary)]">
                        {lang === 'en' ? 'Not signed in' : 'Hujaingia'}
                      </span>
                    </div>
                    
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Mobile Bottom Tab Bar Navigation (Below md) */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-[var(--appearance-surface)] border-t border-[var(--appearance-border)] z-30 py-2 px-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex justify-around items-center shadow-[0_-4px_12px_rgba(0,0,0,0.05)]">
        <button
          type="button"
          onClick={() => handleNavClick('home')}
          aria-current={currentView === 'home' ? 'page' : undefined}
          className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--appearance-focus)] ${
            currentView === 'home' ? 'text-primary-green' : 'text-[var(--appearance-text-muted)]'
          }`}
        >
          <Home size={18} />
          <span className="text-xs font-semibold">{lang === 'sw' ? 'Mwanzo' : 'Home'}</span>
        </button>
        <button
          type="button"
          onClick={() => handleNavClick('owner')}
          aria-current={currentView === 'owner' ? 'page' : undefined}
          className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--appearance-focus)] ${
            currentView === 'owner' ? 'text-primary-green' : 'text-[var(--appearance-text-muted)]'
          }`}
        >
          <Search size={18} />
          <span className="text-xs font-semibold">{lang === 'sw' ? 'Tafuta' : 'Search'}</span>
        </button>
        <button
          type="button"
          onClick={() => handleNavClick('finder')}
          aria-current={currentView === 'finder' ? 'page' : undefined}
          className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--appearance-focus)] ${
            currentView === 'finder' ? 'text-primary-green' : 'text-[var(--appearance-text-muted)]'
          }`}
        >
          <MapPin size={18} />
          <span className="text-xs font-semibold">{lang === 'sw' ? 'Ripoti' : 'Report'}</span>
        </button>
        {/* PHASE 16 — a token-only (agent/admin) session is not offered the
            customer "Sign In" tab. See isTokenOnlySession above. */}
        {!isTokenOnlySession && (
        <button
          type="button"
          onClick={() => (isAccountView || accountSignedIn ? handleAccountClick() : handleNavClick('signin'))}
          aria-current={(isAccountView || currentView === 'signin') ? 'page' : undefined}
          className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--appearance-focus)] ${
            (isAccountView || currentView === 'signin') ? 'text-primary-green' : 'text-[var(--appearance-text-muted)]'
          }`}
        >
          <User size={18} aria-hidden="true" />
          <span className="text-xs font-semibold">{(isAccountView || accountSignedIn) ? (lang === 'sw' ? 'Akaunti' : 'Account') : t.signInBtn}</span>
        </button>
        )}
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--appearance-focus)] ${
            isOpen ? 'text-primary-green' : 'text-[var(--appearance-text-muted)]'
          }`}
        >
          <Menu size={18} />
          <span className="text-xs font-semibold">{lang === 'sw' ? 'Zaidi' : 'More'}</span>
        </button>
      </div>
    </>
  );
}
