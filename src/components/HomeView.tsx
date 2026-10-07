import React, { useState, useEffect, useCallback, useRef } from 'react';
import { translations } from '../types';
import {
  Search, MapPin, ShieldCheck, Lock, Package,
  Users, CreditCard, ChevronLeft, ChevronRight,
  ScanLine, Smartphone, CheckCircle, ArrowRight, Clock, Monitor, Store,
  RefreshCw
} from 'lucide-react';
import Button from './ui/Button';
import Badge from './ui/Badge';
import SectionHeading from './ui/SectionHeading';
import { ICON_SIZE } from './ui/iconSize';
import EmptyState from './ui/EmptyState';
import Skeleton from './ui/Skeleton';
import { motion, AnimatePresence } from 'motion/react';

type ViewName = 'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'terms' | 'privacy' | 'signin' | 'becomeAgent';

interface HomeViewProps {
  setView: (view: ViewName) => void;
  categories: any[];
  activeAgentsCount: number | null;
  recentItems: any[];
  recentItemsLoading: boolean;
  recentItemsError: boolean;
  /** Batch 4 — the discovery error state's "Try Again" control re-invokes the
   *  SAME existing App-level fetchRecentItems() that populates the list on
   *  mount, on return-to-home and on the 45s poll. No second fetch
   *  implementation and no page reload: App owns the request, the abort
   *  controller, the overlap guard and the loading/error state model, and this
   *  only re-invokes it. Optional so the surface still renders without it. */
  onRetryRecentItems?: () => void;
  /** Phase 7B: opens the public item-detail route (/item/:id) for a found
   *  item. Cards are real links, so middle-click / open-in-new-tab / keyboard
   *  activation keep working. */
  onOpenItem: (itemId: string) => void;
}

export default function HomeView(props: HomeViewProps) {
  const {
    setView, categories,
    activeAgentsCount, recentItems, recentItemsLoading, recentItemsError,
    onRetryRecentItems, onOpenItem,
  } = props;
  const t = translations.en;

  // P14A (P14-09) — the ONLY source of a category's human-readable name is the
  // live category list. This used to fall back to a hard-coded label map for
  // four ids, which meant an admin RENAME of one of those categories kept
  // showing the old name here. An unresolvable id now shows the id itself — a
  // neutral, honest label that never contradicts the live data.
  const getCategoryName = (categoryId: string) => {
    const cat = categories.find((c: any) => c.id === categoryId);
    if (cat) return cat.name_en;
    return categoryId;
  };

  type SlideAction = { label: string; view?: ViewName; scroll?: boolean };
  interface HeroSlide {
    img: string;
    alt: string;
    eyebrow: string;
    h1: React.ReactNode;
    copy: string;
    primary: SlideAction;
    secondary: SlideAction;
  }

  // ── HERO SLIDESHOW STATE ────────────────────────────────────────────────
  const [current, setCurrent] = useState(0);
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* WCAG 2.2.2 (Pause, Stop, Hide) — the hero rotates on its own every 6.5s
     and never stopped before, so a visitor reading a slide could be moved off
     it with no way to hold it. Two flags now cover the two honest reasons to
     stop, and neither removes the ability to change slides:
       rotationPaused  — the visitor is reading it (pointer over the region, or
                         keyboard focus inside it); released when they leave.
       rotationStopped — the visitor took control (a dot, an arrow, a swipe or
                         an arrow key): rotation does not resume behind them.
     `prefers-reduced-motion` keeps its existing full pause, unchanged. */
  const [rotationPaused, setRotationPaused] = useState(false);
  const [rotationStopped, setRotationStopped] = useState(false);
  const goToSlide = useCallback((i: number) => {
    setRotationStopped(true);
    setCurrent(((i % 4) + 4) % 4);
  }, []);
  const nextSlide = useCallback(() => goToSlide(current + 1), [goToSlide, current]);
  const prevSlide = useCallback(() => goToSlide(current - 1), [goToSlide, current]);

  // Pause auto-advance for users who prefer reduced motion, while the visitor
  // is reading the hero, and once they have taken control of it.
  useEffect(() => {
    if (reducedMotion || rotationPaused || rotationStopped) return;
    const id = window.setInterval(() => {
      setCurrent((c) => (c + 1) % 4);
    }, 6500);
    return () => window.clearInterval(id);
  }, [reducedMotion, rotationPaused, rotationStopped]);

  const scrollToHowItWorks = () => {
    document.getElementById('how-it-works')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
  };

  const handleSlideAction = (action: SlideAction) => {
    if (action.scroll) {
      scrollToHowItWorks();
    } else if (action.view) {
      setView(action.view);
    }
  };

  const handleCarouselKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); nextSlide(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevSlide(); }
  };

  // Basic mobile swipe (touch) support for the hero slideshow.
  const touchX = React.useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { touchX.current = e.touches[0].clientX; };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    touchX.current = null;
    if (Math.abs(dx) > 40) {
      if (dx < 0) nextSlide(); else prevSlide();
    }
  };

  // ── HERO STORYLINE ───────────────────────────────────────────────────────
  // Four real Return4me photos tell one story in order:
  //   FIND → REPORT / CONNECT → TRUSTED HANDOVER → SUCCESSFUL RETURN
  const slides: HeroSlide[] = [
    {
      img: 'return4me-hero-found-id-nairobi',
      alt: 'Person finding a lost identification card on a Nairobi street',
      eyebrow: 'Return4me',
      h1: (
        <>
          {"Found something that isn't yours?"}
          <span className="block text-accent-orange mt-2">
            {'Help reconnect it with the person who lost it.'}
          </span>
        </>
      ),
      copy: "Return4me's secure lost-and-found network returns found items to their owners — verified, safe and fast.",
      // BATCH 5 (MF-3) — this label was the only "Find My Lost Item" in the
      // application, and it sat on a slide whose heading addresses the person
      // who FOUND something. It now reuses the canonical public-navigation
      // label (types.ts `ownerBtn`) that the Navbar, the mobile drawer, the
      // bottom tab bar and this page's own Final CTA already use for /lost.
      // LABEL ONLY: the destination is still `owner` -> /lost, unchanged.
      primary: { label: t.ownerBtn, view: 'owner' },
      secondary: { label: 'Report a Found Item', view: 'finder' },
    },
    {
      img: 'return4me-agent-handover',
      alt: 'Person handing a found item to a Return4me agent',
      eyebrow: 'Trusted handover',
      h1: (
        <>
          {'Safe hands. Real people.'}
          <span className="block text-accent-orange mt-2">
            {'Connect with trusted Return4me agents who complete every return.'}
          </span>
        </>
      ),
      copy: 'A national network of vetted agents handles drop-offs and verified handovers close to home.',
      // Phase 8.1 — this CTA used to open the internal agent PORTAL directly
      // from a public hero. It now opens the public "Become an Agent" journey,
      // which leads to /agent_portal. Agent access is unchanged; it is simply
      // no longer a raw public portal link.
      primary: { label: 'Become an Agent', view: 'becomeAgent' },
      secondary: { label: 'How It Works', scroll: true },
    },
    {
      img: 'return4me-app-user-nairobi',
      alt: 'Kenyan user using the Return4me platform on a smartphone',
      eyebrow: 'Digital platform',
      h1: (
        <>
          {'Lost-and-found, made simpler.'}
          <span className="block text-accent-orange mt-2">
            {'Report, verify and follow your journey through Return4me.'}
          </span>
        </>
      ),
      copy: 'Start with a single report on your phone. The platform matches items and protects every step of the return.',
      // BATCH 5 (MF-1) — this was the only homepage reporting CTA that did not
      // say lost or found, so a visitor who LOST something could read it as
      // their own path and be taken to the found-item form. It now uses the
      // terminology the application already established (identical to this
      // slide-1 secondary and to the /found document title in App.tsx).
      // LABEL ONLY: the destination is still `finder` -> /found, unchanged.
      primary: { label: 'Report a Found Item', view: 'finder' },
      secondary: { label: 'How It Works', scroll: true },
    },
    {
      img: 'return4me-successful-return',
      alt: 'Lost item being returned to its owner through Return4me',
      eyebrow: 'Successful returns',
      h1: (
        <>
          {"Lost doesn't have to mean gone forever."}
          <span className="block text-accent-orange mt-2">
            {'Return4me helps people reconnect with the things that matter.'}
          </span>
        </>
      ),
      copy: 'Every return is a story — a phone, an ID or a treasured keepsake, finally back where it belongs.',
      // BATCH 5 (MF-2) — "Get Started" communicated neither what begins nor
      // which of the two journeys it selects. It now reuses `t.ownerBtn`
      // ("I Lost Something"), the canonical label for /lost, so the EN/SW
      // pair can never drift. LABEL ONLY: destination still `owner` -> /lost.
      primary: { label: t.ownerBtn, view: 'owner' },
      secondary: { label: 'How It Works', scroll: true },
    },
  ];

  // ── HOW IT WORKS STEPS ──────────────────────────────────────────────────
  const steps = [
    {
      title: 'Report',
      desc: 'Tell us what you lost or found — a photo, a location, a few details.',
    },
    {
      title: 'Match & Verify',
      desc: 'Return4me checks for matches and verifies rightful ownership securely.',
    },
    {
      title: 'Pay Securely',
      desc: 'Payment is confirmed through M-Pesa before collection. After the Agent records the viewing and handover, settlement follows the applicable dispute window.',
    },
    {
      title: 'Collect',
      desc: 'Collect your item from a verified agent, who hands it over to you in person after you have viewed and verified it.',
    },
  ];

  return (
    <div className="w-full">
      {/* ───────── HERO STORY SLIDESHOW ───────── */}
      <section
        role="region"
        aria-roledescription="carousel"
        aria-label={'How Return4me works'}
        onKeyDown={handleCarouselKeyDown}
        tabIndex={-1}
        className="relative isolate overflow-hidden bg-primary-green"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        /* WCAG 2.2.2 — reading the hero holds it still; leaving it resumes. No
           local focus or outline treatment is added: the region is not a
           control, and focus inside it keeps the single global indicator. */
        onMouseEnter={() => setRotationPaused(true)}
        onMouseLeave={() => setRotationPaused(false)}
        onFocus={() => setRotationPaused(true)}
        onBlur={() => setRotationPaused(false)}
      >
        {/* Crossfading photo layers: FIND, CONNECT, HANDOVER, RETURN */}
        {slides.map((s, i) => {
          const active = i === current;
          return (
            <div
              key={s.img}
              aria-hidden={active ? undefined : true}
              className={`absolute inset-0 transition-opacity duration-700 motion-reduce:transition-none ${active ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
            >
              <picture className="absolute inset-0">
                <source
                  type="image/webp"
                  srcSet={`/assets/${s.img}-430w.webp 430w, /assets/${s.img}-768w.webp 768w, /assets/${s.img}-1024w.webp 1024w, /assets/${s.img}-1440w.webp 1440w`}
                  sizes="100vw"
                />
                <img
                  src={`/assets/${s.img}-430w.webp`}
                  alt={active ? s.alt : ''}
                  width="1672"
                  height="941"
                  loading="eager"
                  fetchPriority={i === 0 ? 'high' : 'auto'}
                  decoding="async"
                  className="h-full w-full object-cover object-center"
                />
              </picture>
              {/* REQUEST 01 — directional scrim (see .r4m-hero-scrim in index.css).
                  Strongest exactly where the headline/copy column sits and fading
                  to nothing across the rest of the frame, so the real Nairobi
                  photograph stays visible while the text keeps a reliable
                  contrast ratio. Deliberately NOT an opaque black rectangle. */}
              <div className="r4m-hero-scrim absolute inset-0" aria-hidden="true" />
              {/* The previous second gradient ("subtle top gradient") was removed:
                  it darkened the TOP of every frame, which is where these
                  photographs are brightest and where no text sits. The vertical
                  stop inside .r4m-hero-scrim now handles the copy/controls
                  contrast deliberately instead. */}
            </div>
          );
        })}

        {/* Foreground content */}
        <div className="relative z-10 mx-auto max-w-7xl px-5 sm:px-12 pt-16 pb-20 sm:pt-20 sm:pb-24 lg:pt-28 lg:pb-28 min-h-[520px] sm:min-h-[560px] lg:min-h-[600px] flex items-center">
          <div className="max-w-2xl w-full">
            {slides.map((s, i) => {
              const active = i === current;
              return (
                <motion.div
                  key={s.img}
                  initial={{ opacity: 0, y: 12 }}
                  animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
                  transition={{ duration: reducedMotion ? 0 : 0.4, ease: 'easeOut' }}
                  className={active ? '' : 'hidden'}
                  /* BATCH 6B — this wrapper is the slide's PANEL: it holds the
                     eyebrow, the <h1>, the copy and both CTAs, which is exactly
                     the content the tablist selects. The background photo layer
                     above is deliberately NOT the panel; it carries no text and
                     no controls.
                     The id is derived ONLY from the slide index — never from
                     `lang`, `s.img` or any translated string — so it is stable
                     across language switches, image changes and re-renders.
                     `aria-labelledby` points back at the owning tab, completing
                     the tab -> panel -> tab relationship the tablist declares
                     with `aria-controls`.
                     `tabIndex={0}` makes the panel reachable by keyboard so a
                     keyboard user can actually read the slide they selected; it
                     receives the global `:focus-visible` ring from index.css, so
                     no bespoke focus styling is introduced here.
                     Hiding is UNCHANGED: inactive panels keep `display:none`
                     via the class above, which already removes them from the
                     accessibility tree. */ 
                  id={`r4m-hero-panel-${i}`}
                  role="tabpanel"
                  aria-labelledby={`r4m-hero-tab-${i}`}
                  tabIndex={0}
                >
                  <div className="mb-4 flex items-center gap-2">
                    <span className="inline-block h-0.5 w-8 bg-accent-orange rounded-full" />
                    <span className="text-caption font-bold uppercase tracking-widest text-white/90">{s.eyebrow}</span>
                  </div>
                  {/* UX-01 ladder: page (32/40) → display (40/48) → hero (48/56).
                      The old 3xl/4xl/5xl steps were the same sizes under Tailwind
                      names, with an extra arbitrary leading-[1.1]; the ladder
                      steps carry their own line heights. */}
                  <h1 className="text-page sm:text-display lg:text-hero font-extrabold tracking-tight text-white">
                    {s.h1}
                  </h1>
                  <p className="mt-5 text-body sm:text-body-large text-white/90 max-w-xl leading-relaxed">
                    {s.copy}
                  </p>
                  {/* One obvious primary action per slide; the secondary is the
                      subordinate variant on the same rung. Both are the shared
                      Button at `lg` (52px), so the 44px floor is the primitive's
                      and no local min-height/px override restates it. */}
                  <div className="mt-8 flex flex-col sm:flex-row gap-3">
                    <Button variant="primary" size="lg" onClick={() => handleSlideAction(s.primary)}>
                      {s.primary.label}
                    </Button>
                    <Button
                      variant="inverse"
                      size="lg"
                      onClick={() => handleSlideAction(s.secondary)}
                    >
                      {s.secondary.label}
                    </Button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Previous / next controls — 44px targets (UX-03 §11). The colours are
            fixed imagery overlays over the photographs, not theme surfaces. */}
        <button
          type="button"
          onClick={prevSlide}
          aria-label={'Previous slide'}
          className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 z-10 h-11 w-11 rounded-full bg-black/30 hover:bg-black/50 text-white flex items-center justify-center transition-colors motion-reduce:transition-none"
        >
          <ChevronLeft size={ICON_SIZE.feature} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={nextSlide}
          aria-label={'Next slide'}
          className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 z-10 h-11 w-11 rounded-full bg-black/30 hover:bg-black/50 text-white flex items-center justify-center transition-colors motion-reduce:transition-none"
        >
          <ChevronRight size={ICON_SIZE.feature} aria-hidden="true" />
        </button>

        {/* BATCH 6A — this `role="tablist"` was the ONLY user-facing or
            accessibility string on the homepage still hard-coded in English.
            Every neighbouring carousel label already localizes off the same
            `lang` prop with this exact ternary (see the carousel region label
            at 256, the previous/next controls at 350/358, and the per-tab
            "Go to slide" labels at 373), so this one was an isolated omission
            rather than a missing capability: a Kiswahili screen-reader user
            heard English for the tab group while every control inside it was
            already Kiswahili.
            No new translation key, architecture, helper, state or prop is
            introduced — this reuses the pattern the file already uses. */}
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1" role="tablist" aria-label={'Slide indicator'}>
          {slides.map((s, i) => (
            <button
              key={s.img}
              type="button"
              /* BATCH 6B — the tab now carries a stable, index-derived DOM id
                 and names the panel it controls. `key` is a React reconciliation
                 hint and is NOT a DOM id, so it cannot satisfy this. Both ids
                 use the same `i`, giving a deterministic 1:1 pairing.
                 Everything else about the tab is unchanged: its role,
                 `aria-selected`, its bilingual label, its styling and its
                 click behaviour. */ 
              id={`r4m-hero-tab-${i}`}
              onClick={() => goToSlide(i)}
              role="tab"
              aria-selected={i === current}
              aria-controls={`r4m-hero-panel-${i}`}
              aria-label={`Go to slide ${i + 1} of ${slides.length}`}
              aria-current={i === current ? 'true' : undefined}
              /* UX-03 — the tab is a 44px target and the DOT is its child. The
                 dot keeps the size-and-colour difference (never colour alone),
                 which is what the contrast suite pins; the target around it now
                 meets the touch floor instead of being an 8px dot. */
              className="group flex h-11 min-w-11 items-center justify-center rounded-full transition-colors motion-reduce:transition-none hover:bg-white/10"
            >
              <span
                aria-hidden="true"
                className={`rounded-full transition-all duration-300 motion-reduce:transition-none ${i === current ? 'w-8 h-2 bg-accent-orange' : 'w-2 h-2 bg-white/40 hover:bg-white/70'}`}
              />
            </button>
          ))}
        </div>
      </section>

      {/* ───────── TRUST STRIP ───────── */}
      <section className="bg-[var(--appearance-surface)]">
        <div className="mx-auto max-w-7xl px-5 sm:px-12 py-5">
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-caption sm:text-body font-semibold text-[var(--appearance-text-muted)]">
            <span className="flex items-center gap-2">
              <ShieldCheck size={ICON_SIZE.ui} className="text-status-success" aria-hidden="true" />
              {'Vetted Agents Only'}
            </span>
            <span className="flex items-center gap-2">
              <Users size={ICON_SIZE.ui} className="text-status-success" aria-hidden="true" />
              {activeAgentsCount !== null
                ? (`${activeAgentsCount} Active Agents`)
                : ('Growing Agent Network')}
            </span>
            <span className="flex items-center gap-2">
              <CreditCard size={ICON_SIZE.ui} className="text-status-success" aria-hidden="true" />
              {'M-Pesa Supported'}
            </span>
            <span className="flex items-center gap-2">
              <Lock size={ICON_SIZE.ui} className="text-status-success" aria-hidden="true" />
              {'Payment held safely'}
            </span>
          </div>
        </div>
      </section>

      {/* ───────── EARN & RETURN MARKETING ───────── */}
      {/* BATCH 6C — hand-written <h2>, so the id goes on the heading element
          itself and the section is named from it. */}
      <section aria-labelledby="earn-heading" className="bg-[var(--appearance-surface)] py-14 sm:py-20 border-t border-[var(--appearance-border)]">
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center">
            {/* Image area */}
            <div className="order-2 lg:order-1">
              <div className="aspect-[4/3] bg-[var(--appearance-surface-muted)] rounded-xl overflow-hidden flex items-center justify-center">
                <img
                  src="/assets/return4me-earn-and-return.webp"
                  alt={'A Return4me agent safely returning a found item to its owner'}
                  width="1672"
                  height="941"
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  decoding="async"
                />
              </div>
            </div>

            {/* Content area */}
            <div className="order-1 lg:order-2">
              <h2 id="earn-heading" className="text-section font-bold tracking-tight text-[var(--appearance-text-primary)]">
                {'Found something? Help it find its way home.'}
              </h2>
              <p className="mt-4 text-body sm:text-body-large text-[var(--appearance-text-muted)] leading-relaxed">
                {"Every lost item has a story. Every person who finds something has an opportunity to make a difference — and be rewarded for doing the right thing."}
              </p>

              <div className="mt-8 space-y-6">
                {/* If you find something */}
                <div>
                  {/* UX-03 — the two core intents are SUB-HEADINGS now (16px bold,
                      sentence case) instead of 14px upper-case labels, so a
                      visitor can tell "I found something" from "I lost
                      something" at a glance. Text unchanged. */}
                  <h3 className="text-body-large font-bold text-[var(--appearance-text-primary)]">
                    {"If you find something"}
                  </h3>
                  <p className="mt-2 text-body text-[var(--appearance-text-muted)] leading-relaxed">
                    {"Found someone's ID, phone, bag, certificate or other belonging? Don't leave it behind. Report it on Return4me and give its owner a chance to get it back."}
                  </p>
                  <p className="mt-2 text-body text-[var(--appearance-text-muted)]">
                    {"Successful finders can earn when a reported item is safely returned."}
                  </p>
                  <div className="mt-4">
                    {/* BATCH 5 (MF-5) — the visual hierarchy was inverted: this
                        found-item REPORT was the loudest button on the page
                        (accent) while the lost-item SEARCH beside it was quiet
                        (primary). `accent` is documented in ui/Button.tsx as
                        reserved for the financial / recovery CTAs (claim & pay,
                        submit report) — reporting a found item is neither, and
                        the lost journey is the one this page is built around.
                        CALLER-SIDE ONLY: the shared Button is unmodified, and
                        `Search Found Items` below remains `primary` at /lost. */}
                    <Button variant="outline" size="lg" onClick={() => setView('finder')}>
                      <MapPin size={ICON_SIZE.emphasis} aria-hidden="true" />
                      {/* BATCH 5 (MF-4) — "Report Something Found" was a private
                          synonym for the destination the Navbar, the four-roles
                          card and the Final CTA all label `t.finderBtn`.
                          LABEL ONLY: destination still `finder` -> /found. */}
                      {t.finderBtn}
                    </Button>
                  </div>
                </div>

                {/* If you lose something */}
                <div>
                  <h3 className="text-body-large font-bold text-[var(--appearance-text-primary)]">
                    {"If you lose something"}
                  </h3>
                  <p className="mt-2 text-body text-[var(--appearance-text-muted)] leading-relaxed">
                    {"Lost something important? Search the items our agents are holding. If yours has been found, you can claim it and collect it in person."}
                  </p>
                  <div className="mt-4">
                    <Button variant="primary" size="lg" onClick={() => setView('owner')}>
                      <Search size={ICON_SIZE.emphasis} aria-hidden="true" />
                      {'Search Found Items'}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Closing brand message */}
              <div className="mt-10 pt-6 border-t border-[var(--appearance-border)]">
                <p className="text-body text-[var(--appearance-text-primary)] leading-relaxed">
                  {'Lost something? Search for it.'}
                  <br />
                  {'Found something? Give it a chance to get home.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────── RECENT FOUND ITEMS ───────── */}
      {/* BATCH 4 — this section is a BROWSE surface, not a lost-item reporting
          surface, and it is now labelled as such. The CTA wording matches the
          handler it has always called (`setView('owner')`, the existing public
          found-item search), the journey is explained in one line, and the
          section is a labelled landmark. No new route, no new fetch, no change
          to the cards, the data source or the /item/:id links. */}
      <section
        id="found-items"
        aria-labelledby="found-items-heading"
        className="bg-[var(--appearance-surface)] py-14 sm:py-20 border-t border-[var(--appearance-border)]"
      >
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <SectionHeading
            titleId="found-items-heading"
            titleClassName="text-section"
            eyebrow={'Recently found'}
            title={'Items waiting for owners'}
            description={'These items have been found and are safely held by verified agents.'}
          />
           <div className="mt-6 flex flex-wrap gap-3">
             <Button variant="primary" size="md" onClick={() => setView('owner')}>
               <Search size={ICON_SIZE.ui} aria-hidden="true" />
               {'Browse Found Items'}
             </Button>
           </div>
          {/* The journey this section actually leads into, stated once and
              truthfully. It promises no ownership, no guaranteed recovery and
              no payment outcome — only what the existing surfaces do. */}
          <p className="mt-3 text-body leading-relaxed text-[var(--appearance-text-muted)] max-w-2xl">
            {'Browse found items → open an item to see its details → select “It’s Mine” to begin a claim.'}
          </p>
          {/* Honest result status. The homepage is deliberately given a slice of
              the newest items, not the whole inventory, so this reports only the
              number actually rendered and never a total it cannot know. */}
          <p
            role="status"
            aria-live="polite"
            className="mt-2 text-caption text-[var(--appearance-text-muted)]"
          >
            {recentItemsLoading
              ? ('Loading recently found items…')
              : recentItemsError
              ? ('Recently found items could not be loaded.')
              : recentItems.length === 0
              ? ('No recently found items are available right now.')
              : (`Showing ${recentItems.length} recently found item${recentItems.length === 1 ? '' : 's'}.`)}
          </p>
          {recentItemsLoading ? (
            <div
              aria-busy={recentItemsLoading}
              className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
            >
              {[1, 2, 3].map((i) => (
                <div key={i} className="bg-[var(--appearance-surface-muted)]/50 rounded-panel border border-[var(--appearance-border)] overflow-hidden">
                  <Skeleton shape="rect" className="aspect-[4/3]" />
                  <div className="p-4 space-y-2">
                    <Skeleton shape="text" className="w-3/4 h-4" />
                    <Skeleton shape="text" className="w-1/2 h-3" />
                  </div>
                </div>
              ))}
            </div>
           ) : recentItemsError ? (
            <div className="mt-8">
              <EmptyState
                icon={Package}
                title={'Could not load items'}
                description={'We could not load recently found items just now.'}
                action={
                  /* BATCH 4 — re-invokes the EXISTING App-level
                     fetchRecentItems(). It does not reload the page, adds no
                     second request implementation, and inherits App's
                     loading/error model: the retry clears the error on the
                     next fetch and re-enters the skeleton branch, so this
                     control disappears while the retry is in flight. */
                  onRetryRecentItems ? (
                    <Button variant="accent" size="sm" onClick={onRetryRecentItems}>
                      <RefreshCw size={ICON_SIZE.metadata} aria-hidden="true" />
                      {'Try Again'}
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : recentItems.length === 0 ? (
            <div className="mt-8">
              <EmptyState
                icon={Package}
                title={'No items waiting'}
                description={'Check back soon — new items are added regularly.'}
                action={
                  <Button variant="accent" size="sm" onClick={() => setView('finder')}>
                    <MapPin size={ICON_SIZE.metadata} aria-hidden="true" />
                    {'Report a Found Item'}
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {recentItems.map((item: any) => {
                const isSensitive = item.is_sensitive_document;
                const hasPhoto = item.photo_url && !isSensitive;
                const statusText = item.status === 'claimed'
                  ? ('Claimed')
                  : item.status === 'at_agent'
                  ? ('With Agent')
                  : ('Found');
                const statusVariant = item.status === 'claimed' ? 'warning' : item.status === 'at_agent' ? 'info' : 'success';
                
                return (
                  <motion.div
                    key={item.id}
                    whileHover={{ y: -4 }}
                    whileTap={{ scale: 0.98 }}
                    className="group relative flex h-full flex-col bg-[var(--appearance-surface)] rounded-panel border border-[var(--appearance-border)] overflow-hidden transition-shadow hover:shadow-floating motion-reduce:transition-none"
                  >
                    {/* The whole card is one real link to the public item page
                        (/item/:id). The id — never a description or an array
                        index — is what identifies it, and because it is an
                        anchor, open-in-new-tab and keyboard activation behave
                        the way a visitor expects. */}
                    <a
                      href={`/item/${encodeURIComponent(item.id)}`}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                        e.preventDefault();
                        onOpenItem(item.id);
                      }}
                      /* UX-03 — no local focus ring and no ring on the group:
                         the keyboard indicator is the single global
                         :focus-visible rule, and the card's own radius is what
                         the outline follows. */
                      className="block h-full rounded-panel"
                      aria-label={`Open found item details: ${getCategoryName(item.category_id)}`}
                    >
                    {/* Thumbnail area */}
                    <div className="aspect-[4/3] bg-[var(--appearance-surface-muted)] relative overflow-hidden">
                      {hasPhoto ? (
                        <img
                          src={item.photo_url}
                          alt={`${getCategoryName(item.category_id)} - found item`}
                          loading="lazy"
                          decoding="async"
                          width="400"
                          height="300"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        />
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-[var(--appearance-text-muted)] bg-[var(--appearance-surface-muted)]">
                          <Lock size={ICON_SIZE.feature} aria-hidden="true" className="mb-2" />
                          <span className="text-caption font-bold">
                            {isSensitive
                              ? ('Photo hidden for privacy')
                              : ('No photo available')}
                          </span>
                        </div>
                      )}
                      {/* Status badge — only when the item is in a lifecycle
                          state that says something the section title does not.
                          Every card here is already an item that was FOUND and
                          is being held (the section and the eyebrow both say
                          so), so a "Found" badge on every card was repetition,
                          not information. The two states that ARE news keep
                          their semantic badge, icon and text (never colour
                          alone). */}
                      {item.status === 'claimed' || item.status === 'at_agent' ? (
                        <div className="absolute top-3 left-3">
                          <Badge variant={statusVariant} icon={item.status === 'claimed' ? Lock : ShieldCheck}>
                            {statusText}
                          </Badge>
                        </div>
                      ) : null}
                      {/* Hover action hint */}
                      <div className="absolute inset-0 bg-primary-green/0 group-hover:bg-primary-green/5 transition-colors duration-300" />
                    </div>
                    
                    {/* Content */}
                    <div className="p-4 flex flex-1 flex-col">
                      <h3 className="text-body-large font-semibold text-[var(--appearance-text-primary)] truncate">
                        {getCategoryName(item.category_id)}
                      </h3>
                      <p className="mt-1 text-small text-[var(--appearance-text-muted)] leading-relaxed line-clamp-2">
                        {isSensitive
                          ? ('Details hidden for privacy')
                          : (item.description || ('No description available'))}
                      </p>
                      {/* Where it was found. Real data only: the row renders
                          when the public item payload already carries a
                          location description, and it never exposes a
                          coordinate or any other private field. */}
                      {!isSensitive && item.location_description ? (
                        <p className="mt-2 flex items-center gap-2 text-caption text-[var(--appearance-text-muted)]">
                          <MapPin size={ICON_SIZE.metadata} aria-hidden="true" className="shrink-0" />
                          <span className="truncate">{item.location_description}</span>
                        </p>
                      ) : null}
                      <div className="mt-3 flex-1" />
                      <div className="mt-3 pt-3 border-t border-[var(--appearance-border)] flex items-center justify-between">
                        <span className="text-caption text-[var(--appearance-text-muted)]">
                          {new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                        <span className="text-caption font-mono text-[var(--appearance-text-primary)] bg-[var(--appearance-surface-muted)] px-2 py-1 rounded-compact">
                          {item.id.substring(0, 8).toUpperCase()}
                        </span>
                      </div>
                    </div>
                    </a>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ───────── HOW IT WORKS ───────── */}
      {/* BATCH 6C — this section keeps its existing scroll anchor, which the
          hero's "How It Works" secondary scrolls to and a Batch 4 test pins.
          The new heading id serves a DIFFERENT purpose — it names the section
          for assistive tech — so the two coexist deliberately and neither
          replaces the other. (The comment deliberately avoids quoting the
          anchor's literal attribute: Batch 4 asserts every `id=` and `titleId=`
          on this page is unique, and a comment repeating it would read as a
          duplicate.) */}
      <section id="how-it-works" aria-labelledby="how-heading" className="bg-[var(--appearance-background)] py-14 sm:py-20 border-t border-[var(--appearance-border)] scroll-mt-20">
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-14 items-center">
            {/* Image left — the physical handover */}
            <div className="relative order-1 overflow-hidden rounded-hero shadow-floating">
              <img
                src="/assets/return4me-agent-handover-1024w.webp"
                srcSet="/assets/return4me-agent-handover-430w.webp 430w, /assets/return4me-agent-handover-768w.webp 768w, /assets/return4me-agent-handover-1024w.webp 1024w, /assets/return4me-agent-handover-1440w.webp 1440w"
                sizes="(min-width:1024px) 45vw, 100vw"
                alt={'Person handing a found item to a Return4me agent'}
                width="1672"
                height="941"
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover aspect-[4/3]"
              />
            </div>
            {/* Steps right */}
            <div className="order-2">
              <SectionHeading
                titleId="how-heading"
                titleClassName="text-section"
                eyebrow={'How it works'}
                title={'Four simple steps'}
                description={'From report to recovery — we handle the hard parts.'}
              />
              <ol className="mt-6 space-y-5">
                {steps.map((step, i) => (
                  <li key={i} className="flex items-start gap-4">
                    {/* UX-03 — the step number was white on the brand ORANGE,
                        which measures 2.78:1 (below AA for any text size) and
                        was the only place on the page where orange carried a
                        label. It is now the semantic primary pair: the deep
                        brand green with its own foreground in the light theme,
                        and the light green with dark ink in the dark theme. */}
                    <span className="w-8 h-8 rounded-full bg-[var(--appearance-primary)] text-[var(--appearance-primary-foreground)] text-caption font-extrabold flex items-center justify-center shrink-0">
                      {i + 1}
                    </span>
                    <div>
                      <p className="text-body font-semibold text-[var(--appearance-text-primary)]">{step.title}</p>
                      <p className="mt-1 text-small text-[var(--appearance-text-muted)] leading-relaxed">{step.desc}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </section>

      {/* ───────── DIGITAL PLATFORM ───────── */}
      {/* BATCH 6C — the section is named from its own visible <h2> rather than
          an `aria-label`, so assistive tech reads the same words a sighted user
          does, in whichever language is active. */}
      <section aria-labelledby="platform-heading" className="bg-[var(--appearance-surface)] py-14 sm:py-20 border-t border-[var(--appearance-border)]">
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-14 items-center">
            {/* Text left */}
            <div>
              <SectionHeading
                titleId="platform-heading"
                titleClassName="text-section"
                eyebrow={'Digital platform'}
                title={'Everything starts with a report.'}
                description={'From your phone you can start and manage the return journey — no offices to visit, no forms to post.'}
              />
              <ul className="mt-6 space-y-3 text-body font-semibold text-[var(--appearance-text-primary)]">
          {[
            'Search items agents are holding',
            'Report a found item',
            'Verify identity securely',
            'Track a claim you have started',
            'Connect with a vetted agent for the handover',
          ].map((ft) => (
            <li key={ft} className="flex items-center gap-3">
              <span className="inline-block h-2 w-2 rounded-full bg-accent-orange shrink-0" aria-hidden="true" />
              {ft}
            </li>
          ))}
        </ul>
      </div>
      {/* Image right — the app/platform experience */}
      <div className="relative">
        <div className="overflow-hidden rounded-hero shadow-floating">
          <img
            src="/assets/return4me-app-user-nairobi-1024w.webp"
            srcSet="/assets/return4me-app-user-nairobi-430w.webp 430w, /assets/return4me-app-user-nairobi-768w.webp 768w, /assets/return4me-app-user-nairobi-1024w.webp 1024w, /assets/return4me-app-user-nairobi-1440w.webp 1440w"
            sizes="(min-width:1024px) 45vw, 100vw"
            alt={'Kenyan user using the Return4me platform on a smartphone'}
            width="1672"
            height="941"
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover aspect-[4/3]"
          />
        </div>
      </div>
    </div>
  </div>
</section>

      {/* ───────── SUCCESSFUL RETURN / WHY IT MATTERS ───────── */}
      <section aria-labelledby="returns-heading" className="bg-[var(--appearance-background)] py-14 sm:py-20 border-t border-[var(--appearance-border)]">
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-14 items-center">
            {/* Image left — the human outcome */}
            <div className="relative overflow-hidden rounded-hero shadow-floating">
              <img
                src="/assets/return4me-successful-return-1024w.webp"
                srcSet="/assets/return4me-successful-return-430w.webp 430w, /assets/return4me-successful-return-768w.webp 768w, /assets/return4me-successful-return-1024w.webp 1024w, /assets/return4me-successful-return-1440w.webp 1440w"
                sizes="(min-width:1024px) 45vw, 100vw"
                alt={'Lost item being returned to its owner through Return4me'}
                width="1672"
                height="941"
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover aspect-[4/3]"
              />
            </div>
            {/* Message right */}
            <div>
              <div className="text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)] mb-3">
                {'Successful returns'}
              </div>
              <h2 id="returns-heading" className="text-section font-bold tracking-tight text-[var(--appearance-text-primary)]">
                {'Because getting something back matters.'}
              </h2>
              <p className="mt-4 text-body sm:text-body-large text-[var(--appearance-text-muted)] leading-relaxed max-w-xl">
                {'Every lost item has a person behind it. Return4me exists to make the journey back possible — safely, transparently and with real people nearby.'}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ───────── REQUEST 03 — WHAT RETURN4ME IS FOR ─────────
          Marketing for the four audiences that make the ecosystem work: people
          who lost something, people who found something, Agents, and the
          venues/businesses that can host a handover. Every sentence describes a
          capability the backend actually has, and NO figure is claimed that the
          product does not define — there are no earnings averages, no agent
          counts, no recovery totals and no guarantees. Agent economics are
          described exactly as BecomeAgentView describes them ("a share of the
          recovery fee"), never as an amount. */}
      <section aria-labelledby="roles-heading" className="bg-[var(--appearance-background)] py-14 sm:py-20 border-t border-[var(--appearance-border)]">
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <SectionHeading
            titleId="roles-heading"
            eyebrow={'How it fits together'}
            title={'One network, four roles'}
            description={'Return4me only works when the person who lost something, the person who found it and the agent who handles the handover can all reach each other safely.'}
          />

          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="border border-[var(--appearance-border)] rounded-panel bg-[var(--appearance-surface)] p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-small bg-primary-green/10">
                <Search size={ICON_SIZE.heading} className="text-[var(--appearance-text-primary)]" aria-hidden="true" />
              </span>
              <h3 className="mt-4 text-body-large font-bold text-[var(--appearance-text-primary)]">
                {'Lost something?'}
              </h3>
              <p className="mt-2 text-body text-[var(--appearance-text-muted)] leading-relaxed">
                {'Describe what you lost, where you last had it and the details that make it identifiable. Found items reported to Return4me are searchable, so your description can help you recognise your own property.'}
              </p>
              <Button variant="outline" size="md" className="mt-5" onClick={() => setView('owner')}>
                {t.ownerBtn}
              </Button>
            </div>

            <div className="border border-[var(--appearance-border)] rounded-panel bg-[var(--appearance-surface)] p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-small bg-primary-green/10">
                <MapPin size={ICON_SIZE.heading} className="text-[var(--appearance-text-primary)]" aria-hidden="true" />
              </span>
              <h3 className="mt-4 text-body-large font-bold text-[var(--appearance-text-primary)]">
                {'Found something?'}
              </h3>
              <p className="mt-2 text-body text-[var(--appearance-text-muted)] leading-relaxed">
                {'Report what you found and where. The item is held with a vetted agent and the owner is verified before any handover. Where the platform rules provide for it, the finder receives a recovery appreciation share for a verified return.'}
              </p>
              <p className="mt-2 text-caption text-[var(--appearance-text-muted)] leading-relaxed">
                {'Payments and appreciation are handled through Return4me — never demanded privately from an owner.'}
              </p>
              <Button variant="outline" size="md" className="mt-5" onClick={() => setView('finder')}>
                {t.finderBtn}
              </Button>
            </div>

            <div className="border border-[var(--appearance-border)] rounded-panel bg-[var(--appearance-surface)] p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-small bg-primary-green/10">
                <Users size={ICON_SIZE.heading} className="text-[var(--appearance-text-primary)]" aria-hidden="true" />
              </span>
              <h3 className="mt-4 text-body-large font-bold text-[var(--appearance-text-primary)]">
                {'Become an Agent'}
              </h3>
              <p className="mt-2 text-body text-[var(--appearance-text-muted)] leading-relaxed">
                {'Agents receive found items, confirm them, and complete verified physical handovers in their own area. Agents earn a share of the recovery fee on the recoveries they actually complete, under the platform rules.'}
              </p>
              <p className="mt-2 text-caption text-[var(--appearance-text-muted)] leading-relaxed">
                {'Every agent is vetted and approved before taking custody of an item. No earnings figures are promised — what an agent receives depends on the recoveries they complete.'}
              </p>
              <Button variant="outline" size="md" className="mt-5" onClick={() => setView('becomeAgent')}>
                {t.becomeAgentBtn}
              </Button>
            </div>

            <div className="border border-[var(--appearance-border)] rounded-panel bg-[var(--appearance-surface)] p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-small bg-primary-green/10">
                <Store size={ICON_SIZE.heading} className="text-[var(--appearance-text-primary)]" aria-hidden="true" />
              </span>
              <h3 className="mt-4 text-body-large font-bold text-[var(--appearance-text-primary)]">
                {'Businesses, venues & communities'}
              </h3>
              <p className="mt-2 text-body text-[var(--appearance-text-muted)] leading-relaxed">
                {'Offices, malls, campuses, matatu SACCOs and places of worship are where lost property actually accumulates. Registering the venue as an Agent lets items be handed over through the same verified process instead of being held indefinitely.'}
              </p>
              <Button variant="outline" size="md" className="mt-5" onClick={() => setView('becomeAgent')}>
                {'See the Agent process'}
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* ───────── FINAL CTA ───────── */}
      <section aria-labelledby="final-cta-heading" className="bg-primary-green py-14 sm:py-20">
        <div className="mx-auto max-w-3xl px-5 sm:px-12 text-center">
          <h2 id="final-cta-heading" className="text-section font-bold tracking-tight text-white">
            {'Ready to get started?'}
          </h2>
          <p className="mt-3 text-body sm:text-body-large text-white/80 max-w-xl mx-auto">
            {'Whether you lost something or found something, we\'re here to help.'}
          </p>
          {/* The band and this white-filled inverse button are the documented
              FIXED brand-green pairing (Batch 3): they are the brand in both
              themes and must not follow data-theme. */}
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Button variant="secondary" size="lg" onClick={() => setView('owner')} className="bg-white hover:bg-brand-light-gray text-primary-green border-white">
              <Search size={ICON_SIZE.emphasis} aria-hidden="true" />
              {t.ownerBtn}
            </Button>
            <Button variant="inverse" size="lg" onClick={() => setView('finder')}>
              <MapPin size={ICON_SIZE.emphasis} aria-hidden="true" />
              {t.finderBtn}
            </Button>
          </div>
        </div>
      </section>

    </div>
  );
}

