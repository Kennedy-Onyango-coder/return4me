import React, { useState, useEffect, useRef } from 'react';
import { translations } from '../types';
import { Globe, User, ShieldCheck, MapPin, Search, Home, Menu, X, LogOut } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import LanguageControl from './LanguageControl';
import AppearanceControl from './AppearanceControl';
import Button from './ui/Button';
import { ICON_SIZE } from './ui/iconSize';
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

  // UX-02 — the compact menu is a DISCLOSURE, not a dialog.
  //
  // The trigger owns the panel it discloses (`aria-expanded` / `aria-controls`
  // below), so when the panel is dismissed from the keyboard the focus returns
  // to the control that opened it instead of being dropped on <body>. The panel
  // itself is deliberately NOT a focus trap: it is a plain navigation
  // disclosure, so Tab continues past its last control into the page exactly as
  // it would for any other open disclosure.
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  // BATCH 2 (navbar) — reduced motion.
  //
  // `useReducedMotion()` ships with the animation library already in use
  // (motion/react), so this honours the OS "reduce motion" setting without a
  // second media-query listener, a second state, or a new dependency. The
  // drawer's slide/scale and the active-nav underline keep their real motion
  // for everyone else; here they resolve instantly instead. Functionality,
  // focus handling and open/close behaviour are untouched.
  const prefersReducedMotion = useReducedMotion();

  // UX-02 — ESCAPE CLOSES THE COMPACT MENU.
  //
  // Before this, the drawer could only be dismissed by the close button, by
  // choosing a destination, or by clicking the scrim — a keyboard user had no
  // way back out of it. The listener is attached only while the panel is open
  // (so the bar adds no global key handling when it is closed) and removes
  // itself on close/unmount. `Escape` is not intercepted for any other purpose
  // on this bar, so there is nothing else it could shadow.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        menuTriggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

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

  // UX-02 — SIGN IN IS THE SHARED BUTTON, NOT A SECOND BUTTON SYSTEM.
  //
  // The control used to be hand-rolled here (`signInButtonClass`: its own 44px
  // height, its own off-ladder 13px type step, its own radius, border, a local
  // `outline-none` + `ring-2` stack and its own hover/active palette). §15 of
  // the UX-02 contract asks for the shared `Button`, and PI-1/C5
  // (focusContract.test.ts) requires exactly ONE focus treatment, so the whole
  // declaration is gone. Sign In now renders as
  //   <Button variant="primary" size="md">  →  44px / text-body / rounded-standard
  // and inherits the primitive's height, radius, type step and single global
  // focus indicator instead of re-deriving them.
  //
  // `primary` is the deliberate variant for §15's hierarchy — "Sign In = clear
  // primary navigation action", "Do not make Sign In oversized": it is ONE
  // standard-size (44px) button, on brand in the light theme and still
  // AA-legible in the dark theme, where its label is the semantic foreground on
  // the brand surface rather than the raw dark green the old pill used.

  // "My Account" stays a QUIET link rather than a button: it is a destination,
  // not an action, so it keeps the primary-link treatment (and the same active
  // language as the four public destinations) while the shared Button is
  // reserved for Sign In. The underline indicator is shared via `layoutId`, so
  // the indicator walks between the links and the account entry.
  const accountLinkClass =
    'relative inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap rounded-small px-2 text-body font-medium transition-colors cursor-pointer ' +
    (isAccountView
      ? 'bg-[var(--appearance-surface-muted)] font-semibold text-[var(--appearance-primary)]'
      : 'text-[var(--appearance-text-muted)] hover:bg-[var(--appearance-surface-muted)] hover:text-[var(--appearance-text-primary)]');

  // UX-02 — ONE LADDER SIZE, AND THE ROW MOVES WHERE IT ACTUALLY FITS.
  //
  // The previous pass kept the full row alive at 1024px by stepping the links
  // DOWN to an arbitrary `text-[12px]` and back up to `xl:text-[13px]`, on a row
  // the same pass had already measured at ZERO free space (`logo→Home` was
  // exactly the container gap at 1024px). Two arbitrary type sizes on a crammed
  // row are not a navigation system, so UX-02 does what §9 asks: the full row
  // now lives only at the width where it genuinely fits, and the compact menu
  // takes over below it.
  //
  // The MEASURED reason for `xl` rather than `lg` — §12 also aligns the header
  // with the public page grid (`max-w-7xl px-5 sm:px-12`, exactly HomeView's
  // grid):
  //   · at 1024px the header then has only 1024 - 96 = 928px of content width,
  //     while the full row (logo + four destinations + Sign In + utility tray +
  //     session block) needs ≈1000px at the smallest legible ladder step;
  //   · at 1280px it has 1280 - 96 = 1184px — the same row fits with room to
  //     spare even now that the shared Button replaced the narrower hand-rolled
  //     Sign In pill and the links moved up to `text-body`.
  // Forcing the full row into 928px would re-create the exact defect SPACING
  // REMEDIATION fixed (links sliding under the logo), so the row moves up and
  // the menu owns the 1024–1279px band. That is the principle the previous
  // audit recorded: "medium/narrow desktop should switch to a menu rather than
  // shrink endlessly".
  //
  // Type: ONE ladder step — `text-body` (14/20), the scale's default UI text and
  // the same step the shared Button's `md` size uses, so the destinations and
  // the Sign In label are typographically consistent (§7/§8).
  //
  // Active state (§11): never colour alone — the current destination carries a
  // stronger weight (`font-semibold`), a surface tint and the moving underline.
  // Both the tint and the ink come from semantic appearance tokens, so the
  // active link stays legible in the dark theme, where the raw brand green would
  // be dark-on-dark text.
  //
  // Focus: none of its own. The bar carries no local `outline-none`/`ring-*`;
  // the single global `:focus-visible` rule (index.css, PI-1/C5) is the
  // indicator, exactly as it now is for the shared primitives.
  //
  // `whitespace-nowrap` (a label never wraps) and `shrink-0` (a label never
  // compresses) stay: they are correctness, not style. The 40px minimum is
  // raised to the 44px touch floor.
  const navLinkClass = (view: string) =>
    'relative inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap rounded-small px-2 text-body font-medium transition-colors cursor-pointer ' +
    (currentView === view
      ? 'bg-[var(--appearance-surface-muted)] font-semibold text-[var(--appearance-primary)]'
      : 'text-[var(--appearance-text-muted)] hover:bg-[var(--appearance-surface-muted)] hover:text-[var(--appearance-text-primary)]');

  // BATCH 2 (navbar): the active-nav underline keeps its spring for normal
  // motion, and resolves immediately when the visitor asked for reduced motion.
  const navUnderlineTransition = prefersReducedMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 300, damping: 30 };

  const navLinkUnderline = (view) =>
    currentView === view ? (
      <motion.span
        layoutId="nav-underline"
        className="absolute bottom-0 left-2 right-2 h-0.5 bg-[var(--appearance-primary)] rounded-full"
        transition={navUnderlineTransition}
      />
    ) : null;

  return (
    <>
      <header className="h-18 xl:h-19 bg-[var(--appearance-surface)] text-[var(--appearance-text-primary)] sticky top-0 z-40 border-b border-[var(--appearance-border)] flex items-center shadow-raised">
        {/* UX-02 — THE HEADER SHARES THE PAGE GRID, AND ITS CHROME IS TOKEN-BASED.
        
            §12 asked for two things here and they are the same fix:
              · the container is now EXACTLY the public page container —
                `max-w-7xl px-5 sm:px-12`, the same grid every public view uses
                (HomeView: `mx-auto max-w-7xl px-5 sm:px-12`) — instead of the
                wider `max-w-[1600px] px-4 sm:px-5 lg:px-6` that made the bar
                drift away from the page content on large screens;
              · the height and the elevation are no longer arbitrary literals.
                `h-18 / xl:h-19` are the same 72px/76px on the Tailwind spacing
                scale (4px base), and the header shadow is the UX-01 elevation
                token `shadow-raised` instead of a hand-written
                `shadow-[0_2px_12px_rgba(0,56,32,0.05)]` — which also means the
                header has a deliberate elevation in the dark theme, where a
                5%-green shadow is invisible.
        
            The inter-group gap is the 8px rhythm step at every width now (it was
            `gap-2 lg:gap-3`): the row's own breathing room comes from the
            centred nav box, which is a real distribution of space rather than a
            fixed gap, so the extra 4px bought nothing but a tighter fit. */}
        <div className="max-w-7xl w-full mx-auto px-5 sm:px-12 flex items-center justify-between gap-2">
          {/* Brand Logo Group
              BATCH 2 (navbar): this was a `div role="button"` with a hand-rolled
              Enter/Space keydown handler. Return4me navigates by switching the
              App-owned `currentView` state, not by URL, so a real <a href> would
              be a link to nowhere — the project's own native navigation
              mechanism is a <button>. Swapping to it gives the logo a real
              button name, native activation, and native focus for free, so the
              ARIA role, the manual tabIndex and the keydown emulation are all
              removed rather than duplicated. The Home destination and the
              accessible name are unchanged.
              UX-02: the local focus ring is gone as well — the single global
              `:focus-visible` rule (index.css, PI-1/C5) is the indicator — and
              the radius is the ladder's `rounded-small`. The image, its sizes
              and its responsive caps are untouched. */}
          <button
            type="button"
            className="shrink-0 flex items-center rounded-small cursor-pointer select-none"
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

          {/* UX-02 — THE PRIMARY LINK GROUP IS THE PUBLIC IA, AND NOTHING ELSE.
              `min-w-0 flex-1` keeps this box able to give space back to the
              utility tray instead of forcing the flex LINE to expand — the
              original defect, where a squeezed nav could not compress its
              `shrink-0 whitespace-nowrap` children and OVERFLOWED them under the
              logo. `justify-center` centres the group in the space the row
              actually has, which is what turns the remaining room into even
              breathing room on both sides. There is deliberately no
              `overflow-hidden`: clipping would hide a destination instead of
              fixing a width constraint.
              The group renders at `xl` and up only — see `navLinkClass` above for
              the measurement behind that breakpoint. Below it, the compact menu
              carries the same four destinations. */}
          <nav className="hidden xl:flex min-w-0 flex-1 items-center justify-center gap-0" aria-label={lang === 'en' ? 'Main navigation' : 'Navishan kuu'}>
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
          </nav>

          {/* UX-02 — UTILITY CONTROLS ARE SECONDARY: a single quiet bordered
              group holding the two shared controls (the language toggle and the
              appearance select). App still owns both states; this is presentation
              only, and the same two components are used by the compact header,
              the drawer and the authenticated shell.

              The tray is gated at `xl` together with the rest of the desktop row,
              and it can never be unreachable at any width: the compact header
              below carries the SAME two controls. (BATCH 1's blackout was two
              different gates — `xl` here and `lg` there; UX-02 keeps them equal.)

              Two corrections around it:
                · the group `focus-within` ring is gone. It stacked a second
                  focus treatment on top of the global `:focus-visible`
                  indicator, which is exactly the duplicate PI-1/C5 removed from
                  the shared primitives;
                · the appearance select no longer claims a fixed `min-w-[9.5rem]`
                  at `xl`. A native select already sizes to its own content, so
                  the fixed minimum only made the widest control on the bar ~20px
                  wider than it needed to be; the shared `min-w-24` floor (96px,
                  the 8-point rhythm's 24 step) keeps it from collapsing. */}
          <div className="hidden xl:flex shrink-0 items-center gap-1 rounded-standard border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] px-1.5 py-0.5">
            <LanguageControl lang={lang} setLang={setLang} layout="toggle" toggleLabel={t.langToggle} />
            <AppearanceControl value={appearance} onChange={setAppearance} labels={appearanceLabels} minWidth="min-w-24" />
          </div>

          {/* UX-02 — SIGN IN, WHERE THE LOCKED IA PUTS IT (after Language and
              Appearance), AS THE SHARED BUTTON.

              §15: Sign In is the one item on this bar that starts a session, so
              it is the only control rendered as a `Button` — the four
              destinations are quiet links and the utilities are quiet secondary
              controls. It is a standard `size="md"` (44px) button, never a
              promotional CTA, and its label is `accountControlLabel`, so the
              signed-in state still reads "My Account" rather than "Sign In".

              PHASE 16 is preserved exactly: a token-only (agent/admin) session
              is never shown this control at all — a signed-in operator must not
              be offered "Sign In" — and the account state is a quiet LINK rather
              than a button, because "My Account" is a destination, not an
              action. */}
          {!isTokenOnlySession && (
            <div className="hidden xl:flex shrink-0 items-center">
              {isAccountView || accountSignedIn ? (
                <button
                  onClick={handleAccountClick}
                  className={accountLinkClass}
                  aria-current={isAccountView || currentView === 'signin' ? 'page' : undefined}
                >
                  {accountControlLabel}
                  <motion.span
                    layoutId="nav-underline"
                    className="absolute bottom-0 left-2 right-2 h-0.5 bg-[var(--appearance-primary)] rounded-full"
                    transition={navUnderlineTransition}
                  />
                </button>
              ) : (
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => handleNavClick('signin')}
                  aria-current={currentView === 'signin' ? 'page' : undefined}
                >
                  {accountControlLabel}
                </Button>
              )}
            </div>
          )}

          {/* UX-02 — THE SESSION CLUSTER (rightmost, as before).
              It reports the live session and, when signed in, offers the one
              truthful action: Sign out. A signed-out visitor sees the passive
              "Guest" state beside the Sign In button above, which is why this
              cluster carries no button in that state. Both branches read the
              derived `signedIn` flag (token OR customer cookie), so no role can
              be shown a stale state. */}
          <div className="hidden xl:flex shrink-0 items-center border-l border-[var(--appearance-border)] pl-2">
            {signedIn ? (
              <button
                onClick={logout}
                className="flex min-h-[44px] items-center gap-2 px-3 text-body font-medium text-[var(--appearance-text-muted)] hover:text-[var(--appearance-text-primary)] transition-colors cursor-pointer rounded-small"
              >
                <LogOut size={ICON_SIZE.ui} aria-hidden="true" />
                <span>{t.logout}</span>
              </button>
            ) : (
              <div className="flex items-center gap-2 px-2 text-body font-medium text-[var(--appearance-text-muted)]">
                <User size={ICON_SIZE.ui} aria-hidden="true" />
                <span>{lang === 'en' ? 'Guest' : 'Mgeni'}</span>
              </div>
            )}
          </div>

          {/* UX-02 — THE COMPACT HEADER: the same public chrome below `xl`.

              It carries the logo (above), BOTH utility controls and the menu
              trigger, so language and appearance are never more than one tap
              away at any width (the BATCH 1 contract), and the menu itself holds
              every public destination plus Sign In. Same shared components, same
              App-owned props, same App-owned state — nothing is duplicated.

              Menu trigger (§10): a real 44x44 touch target with an accessible
              name, `aria-expanded` for its state and `aria-controls` for the
              panel it discloses, and the ladder's `heading` icon step (20) — the
              previous 22px icon was off the UX-01 icon ladder. The appearance
              select still flexes (`min-w-0 flex-1`) so it absorbs only the space
              actually left over on a narrow phone, and the language toggle keeps
              its FULL visible word and its 44px `md` size (Batch B/C pin both). */}
          <div className="flex xl:hidden items-center gap-1 md:gap-2">
            <LanguageControl lang={lang} setLang={setLang} layout="toggle" toggleLabel={t.langToggle} />
            <AppearanceControl value={appearance} onChange={setAppearance} labels={appearanceLabels} minWidth="min-w-0 flex-1 sm:min-w-24 sm:flex-none" />
            <button
              ref={menuTriggerRef}
              type="button"
              onClick={() => setIsOpen(true)}
              aria-expanded={isOpen}
              aria-controls="public-nav-menu"
              aria-label={lang === 'sw' ? 'Fungua menyu' : 'Open menu'}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-small text-[var(--appearance-text-primary)] hover:text-[var(--appearance-primary)] transition-colors cursor-pointer"
            >
              <Menu size={ICON_SIZE.heading} aria-hidden="true" />
            </button>
          </div>

        </div>
      </header>

      {/* Mobile Drawer Slide-out and Backdrop (Below xl) */}
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop Overlay */}
            {/* BATCH 2 (navbar) — reduced motion. Under a `reduce` preference the
                scrim and the panel resolve instantly (no fade, no slide) instead
                of animating. The elements, the fixed positioning, the z-order,
                the click-to-close handler and the `xl:hidden` behaviour are all
                unchanged, so the drawer works identically — it simply arrives
                without motion. The scrim keeps `bg-black/40`: see the note in
                the final report — no suitable existing semantic token exists, and
                inventing one purely to remove a literal is out of scope.

                UX-02 adds the keyboard exit and the disclosure wiring: the panel
                carries the id the trigger's `aria-controls` points at plus an
                accessible name, and `Escape` closes it (see the effect above).
                It is still NOT a focus trap — a navigation disclosure must not
                become a modal by accident. */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2 }}
              onClick={() => setIsOpen(false)}
              className="fixed inset-0 bg-black/40 z-40 xl:hidden"
            />

            {/* Side Drawer Menu */}
            <motion.div
              id="public-nav-menu"
              role="group"
              aria-label={lang === 'en' ? 'Site menu' : 'Menyu ya tovuti'}
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 h-full w-72 sm:w-85 bg-[var(--appearance-surface)] text-[var(--appearance-text-primary)] shadow-floating z-50 flex flex-col border-l border-[var(--appearance-border)] xl:hidden"
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
                  type="button"
                  onClick={() => setIsOpen(false)}
                  aria-label={lang === 'sw' ? 'Funga menyu' : 'Close menu'}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-small bg-[var(--appearance-surface)] border border-[var(--appearance-border)] text-[var(--appearance-text-muted)] hover:text-[var(--appearance-primary)] transition-colors cursor-pointer"
                >
                  <X size={ICON_SIZE.ui} aria-hidden="true" />
                </button>
              </div>

              {/* Drawer Links */}
              <div className="flex-1 overflow-y-auto p-5 space-y-5">
                <div className="space-y-2">
                  <p className="text-caption font-bold text-[var(--appearance-text-muted)] uppercase tracking-widest px-3 mb-2">
                    {lang === 'en' ? 'Main Menu' : 'Menyu Kuu'}
                  </p>
                  
                  {/* Home */}
                  <button
                    onClick={() => handleNavClick('home')}
                    aria-current={currentView === 'home' ? 'page' : undefined}
                    className={`w-full flex min-h-[44px] items-center gap-3 rounded-standard px-3 py-3 text-body font-semibold transition-colors text-left cursor-pointer ${
                      currentView === 'home' 
                        ? 'bg-[var(--appearance-surface-muted)] font-bold text-[var(--appearance-primary)]' 
                        : 'text-[var(--appearance-text-primary)] hover:bg-[var(--appearance-surface-muted)]'
                    }`}
                  >
                    <Home size={ICON_SIZE.emphasis} aria-hidden="true" />
                    <span>{lang === 'en' ? 'Home' : 'Ukurasa wa Kwanza'}</span>
                  </button>

                  {/* Owner (Lost) */}
                  <button
                    onClick={() => handleNavClick('owner')}
                    aria-current={currentView === 'owner' ? 'page' : undefined}
                    className={`w-full flex min-h-[44px] items-center gap-3 rounded-standard px-3 py-3 text-body font-semibold transition-colors text-left cursor-pointer ${
                      currentView === 'owner' 
                        ? 'bg-[var(--appearance-surface-muted)] font-bold text-[var(--appearance-primary)]' 
                        : 'text-[var(--appearance-text-primary)] hover:bg-[var(--appearance-surface-muted)]'
                    }`}
                  >
                    <Search size={ICON_SIZE.emphasis} aria-hidden="true" />
                    <span>{t.ownerBtn}</span>
                  </button>

                  {/* Finder (Found) */}
                  <button
                    onClick={() => handleNavClick('finder')}
                    aria-current={currentView === 'finder' ? 'page' : undefined}
                    className={`w-full flex min-h-[44px] items-center gap-3 rounded-standard px-3 py-3 text-body font-semibold transition-colors text-left cursor-pointer ${
                      currentView === 'finder' 
                        ? 'bg-[var(--appearance-surface-muted)] font-bold text-[var(--appearance-primary)]' 
                        : 'text-[var(--appearance-text-primary)] hover:bg-[var(--appearance-surface-muted)]'
                    }`}
                  >
                    <MapPin size={ICON_SIZE.emphasis} aria-hidden="true" />
                    <span>{t.finderBtn}</span>
                  </button>

                  {/* Phase 8.1 — public agent journey. This replaced the
                      "Agent Portal" item: the internal portal is no longer a
                      public destination, while agent access is unchanged. */}
                  <button
                    onClick={() => handleNavClick('becomeAgent')}
                    aria-current={currentView === 'becomeAgent' ? 'page' : undefined}
                    className={`w-full flex min-h-[44px] items-center gap-3 rounded-standard px-3 py-3 text-body font-semibold transition-colors text-left cursor-pointer ${
                      currentView === 'becomeAgent'
                        ? 'bg-[var(--appearance-surface-muted)] font-bold text-[var(--appearance-primary)]' 
                        : 'text-[var(--appearance-text-primary)] hover:bg-[var(--appearance-surface-muted)]'
                    }`}
                  >
                    <Globe size={ICON_SIZE.emphasis} aria-hidden="true" />
                    <span>{t.becomeAgentBtn}</span>
                  </button>


                </div>

                {/* System Pages */}
                <div className="space-y-2 pt-4 border-t border-[var(--appearance-border)]/60">
                  <p className="text-caption font-bold text-[var(--appearance-text-muted)] uppercase tracking-widest px-3 mb-2">
                    {lang === 'en' ? 'Legals & Info' : 'Sheria na Taarifa'}
                  </p>
                  
                  {/* Terms */}
                  <button
                    onClick={() => handleNavClick('terms')}
                    aria-current={currentView === 'terms' ? 'page' : undefined}
                    className={`w-full flex min-h-[44px] items-center gap-3 rounded-standard px-3 py-3 text-body font-semibold transition-colors text-left cursor-pointer ${
                      currentView === 'terms' 
                        ? 'bg-[var(--appearance-surface-muted)] font-bold text-[var(--appearance-primary)]' 
                        : 'text-[var(--appearance-text-primary)] hover:bg-[var(--appearance-surface-muted)]'
                    }`}
                  >
                    <span>{lang === 'en' ? 'Terms of Service' : 'Masharti ya Matumizi'}</span>
                  </button>

                  {/* Privacy */}
                  <button
                    onClick={() => handleNavClick('privacy')}
                    aria-current={currentView === 'privacy' ? 'page' : undefined}
                    className={`w-full flex min-h-[44px] items-center gap-3 rounded-standard px-3 py-3 text-body font-semibold transition-colors text-left cursor-pointer ${
                      currentView === 'privacy' 
                        ? 'bg-[var(--appearance-surface-muted)] font-bold text-[var(--appearance-primary)]' 
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
                  <Button
                    variant="primary"
                    size="md"
                    className="w-full"
                    onClick={() => (isAccountView || accountSignedIn ? handleAccountClick() : handleNavClick('signin'))}
                    aria-current={(isAccountView || currentView === 'signin') ? 'page' : undefined}
                  >
                    <User size={ICON_SIZE.ui} aria-hidden="true" />
                    {accountControlLabel}
                  </Button>
                )}

                {/* Account Actions */}
                {signedIn ? (
                  <button
                    onClick={() => {
                      logout();
                      setIsOpen(false);
                    }}
                    className="w-full min-h-[44px] bg-accent-strong hover:bg-accent-strong-hover text-[var(--appearance-accent-foreground)] text-body font-bold py-3 rounded-standard shadow-raised transition-colors cursor-pointer flex items-center justify-center gap-2"
                  >
                    <LogOut size={ICON_SIZE.metadata} aria-hidden="true" />
                    <span>{t.logout}</span>
                  </button>
                ) : (
                  <div className="min-h-[44px] py-2 px-3 bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-standard flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-[var(--appearance-surface-muted)] flex items-center justify-center text-accent-orange">
                        <User size={ICON_SIZE.metadata} aria-hidden="true" />
                      </div>
                      <span className="text-body font-bold text-[var(--appearance-text-primary)]">
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
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-[var(--appearance-surface)] border-t border-[var(--appearance-border)] z-30 py-2 px-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex justify-around items-center">
        <button
          type="button"
          onClick={() => handleNavClick('home')}
          aria-current={currentView === 'home' ? 'page' : undefined}
          className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-1 rounded-small px-1 py-1 text-caption font-semibold transition-colors ${
            currentView === 'home' ? 'bg-[var(--appearance-surface-muted)] font-bold text-[var(--appearance-primary)]' : 'text-[var(--appearance-text-muted)]'
          }`}
        >
          <Home size={ICON_SIZE.emphasis} aria-hidden="true" />
          <span className="text-caption font-semibold">{lang === 'sw' ? 'Mwanzo' : 'Home'}</span>
        </button>
        <button
          type="button"
          onClick={() => handleNavClick('owner')}
          aria-current={currentView === 'owner' ? 'page' : undefined}
          className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-1 rounded-small px-1 py-1 text-caption font-semibold transition-colors ${
            currentView === 'owner' ? 'bg-[var(--appearance-surface-muted)] font-bold text-[var(--appearance-primary)]' : 'text-[var(--appearance-text-muted)]'
          }`}
        >
          <Search size={ICON_SIZE.emphasis} aria-hidden="true" />
          <span className="text-caption font-semibold">{lang === 'sw' ? 'Tafuta' : 'Search'}</span>
        </button>
        <button
          type="button"
          onClick={() => handleNavClick('finder')}
          aria-current={currentView === 'finder' ? 'page' : undefined}
          className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-1 rounded-small px-1 py-1 text-caption font-semibold transition-colors ${
            currentView === 'finder' ? 'bg-[var(--appearance-surface-muted)] font-bold text-[var(--appearance-primary)]' : 'text-[var(--appearance-text-muted)]'
          }`}
        >
          <MapPin size={ICON_SIZE.emphasis} aria-hidden="true" />
          <span className="text-caption font-semibold">{lang === 'sw' ? 'Ripoti' : 'Report'}</span>
        </button>
        {/* PHASE 16 — a token-only (agent/admin) session is not offered the
            customer "Sign In" tab. See isTokenOnlySession above. */}
        {!isTokenOnlySession && (
        <button
          type="button"
          onClick={() => (isAccountView || accountSignedIn ? handleAccountClick() : handleNavClick('signin'))}
          aria-current={(isAccountView || currentView === 'signin') ? 'page' : undefined}
          className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-1 rounded-small px-1 py-1 text-caption font-semibold transition-colors ${
            (isAccountView || currentView === 'signin') ? 'bg-[var(--appearance-surface-muted)] font-bold text-[var(--appearance-primary)]' : 'text-[var(--appearance-text-muted)]'
          }`}
        >
          <User size={ICON_SIZE.emphasis} aria-hidden="true" />
          <span className="text-caption font-semibold">{(isAccountView || accountSignedIn) ? (lang === 'sw' ? 'Akaunti' : 'Account') : t.signInBtn}</span>
        </button>
        )}
        {/* PHASE 16 — a token-only (agent/admin) session is not offered the
            customer "Sign In" tab. See isTokenOnlySession above.
            UX-02: this tab-bar "More" control discloses the same panel as the
            header trigger, so it advertises that relationship too. */}
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          aria-expanded={isOpen}
          aria-controls="public-nav-menu"
          className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-1 rounded-small px-1 py-1 text-caption font-semibold transition-colors ${
            isOpen ? 'bg-[var(--appearance-surface-muted)] font-bold text-[var(--appearance-primary)]' : 'text-[var(--appearance-text-muted)]'
          }`}
        >
          <Menu size={ICON_SIZE.emphasis} aria-hidden="true" />
          <span className="text-caption font-semibold">{lang === 'sw' ? 'Zaidi' : 'More'}</span>
        </button>
      </div>
    </>
  );
}
