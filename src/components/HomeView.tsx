import React, { useState, useEffect, useCallback, useRef } from 'react';
import { translations } from '../types';
import {
  Search, MapPin, ShieldCheck, Lock, Package,
  Users, CreditCard, ChevronLeft, ChevronRight,
  PhoneCall, Key, Car, Wallet, Luggage, Laptop,
  Gem, ScanLine, Smartphone, CheckCircle, ArrowRight, Clock, Monitor
} from 'lucide-react';
import Button from './ui/Button';
import Badge from './ui/Badge';
import SectionHeading from './ui/SectionHeading';
import EmptyState from './ui/EmptyState';
import Skeleton from './ui/Skeleton';
import { motion, AnimatePresence } from 'motion/react';

type ViewName = 'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'terms' | 'privacy';

interface HomeViewProps {
  lang: 'en' | 'sw';
  setLang: (lang: 'en' | 'sw') => void;
  setView: (view: ViewName) => void;
  categories: any[];
  categoriesLoading: boolean;
  categoriesError: boolean;
  activeAgentsCount: number | null;
  recentItems: any[];
  recentItemsLoading: boolean;
  recentItemsError: boolean;
}

export default function HomeView(props: HomeViewProps) {
  const {
    lang, setView, categories, categoriesLoading, categoriesError,
    activeAgentsCount, recentItems, recentItemsLoading, recentItemsError,
  } = props;
  const t = translations[lang];

  const getCategoryName = (categoryId: string) => {
    const cat = categories.find((c: any) => c.id === categoryId);
    if (cat) return lang === 'en' ? cat.name_en : cat.name_sw;
    if (categoryId === 'national-id') return lang === 'en' ? 'National ID' : 'Kitambulisho cha Kitaifa';
    if (categoryId === 'vehicle-logbook') return lang === 'en' ? 'Vehicle Logbook' : 'Kitabu cha Magari';
    if (categoryId === 'driving-licence') return lang === 'en' ? 'Driving Licence' : 'Leseni ya Udereva';
    if (categoryId === 'number-plate') return lang === 'en' ? 'Number Plate' : 'Nambari ya Gari';
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
  const goToSlide = useCallback((i: number) => {
    setCurrent(((i % 4) + 4) % 4);
  }, []);
  const nextSlide = useCallback(() => goToSlide(current + 1), [goToSlide, current]);
  const prevSlide = useCallback(() => goToSlide(current - 1), [goToSlide, current]);

  // Pause auto-advance for users who prefer reduced motion.
  useEffect(() => {
    if (reducedMotion) return;
    const id = window.setInterval(() => {
      setCurrent((c) => (c + 1) % 4);
    }, 6500);
    return () => window.clearInterval(id);
  }, [reducedMotion]);

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
      alt: lang === 'en' ? 'Person finding a lost identification card on a Nairobi street' : 'Mtu akipata kadi ya kitambulisho iliyopotea mitaani Nairobi',
      eyebrow: 'Return4me',
      h1: (
        <>
          {lang === 'en' ? "Found something that isn't yours?" : 'Umepata kitu kisicho chako?'}
          <span className="block text-accent-orange mt-2">
            {lang === 'en' ? 'Help reconnect it with the person who lost it.' : 'Saidia kikirudi kwa mwenye kilichopoteza.'}
          </span>
        </>
      ),
      copy: lang === 'en'
        ? "Return4me's secure lost-and-found network returns found items to their owners — verified, safe and fast."
        : 'Mtandao salama wa Return4me hurejesha vitu vilivyopatikana kwa wamiliki wao — uliothibitishwa, salama na haraka.',
      primary: { label: lang === 'en' ? 'Report a Found Item' : 'Ripoti Kitu Kilichopatikana', view: 'finder' },
      secondary: { label: lang === 'en' ? 'I Lost Something' : 'Nimepoteza Kitu', view: 'owner' },
    },
    {
      img: 'return4me-agent-handover',
      alt: lang === 'en' ? 'Person handing a found item to a Return4me agent' : 'Mtu akimkabidhi wakala wa Return4me kitu kilichopatikana',
      eyebrow: 'Trusted handover',
      h1: (
        <>
          {lang === 'en' ? 'Safe hands. Real people.' : 'Mikono salama. Watu wa kweli.'}
          <span className="block text-accent-orange mt-2">
            {lang === 'en' ? 'Connect with trusted Return4me agents who complete every return.' : 'Ungana na mawakala wa Return4me wanaoaminika wanaokamilisha kila urejeshaji.'}
          </span>
        </>
      ),
      copy: lang === 'en'
        ? 'A national network of vetted agents handles drop-offs and verified handovers close to home.'
        : 'Mtandao wa kitaifa wa mawakala waliothibitishwa hutunza uwasilishaji na urejeshaji uliothibitishwa karibu na nyumbani.',
      primary: { label: lang === 'en' ? 'Find an Agent' : 'Tafuta Wakala', view: 'agent' },
      secondary: { label: lang === 'en' ? 'How It Works' : 'Inavyofanya Kazi', scroll: true },
    },
    {
      img: 'return4me-app-user-nairobi',
      alt: lang === 'en' ? 'Kenyan user using the Return4me platform on a smartphone' : 'Mkenya akitumia jukwaa la Return4me kwenye simu',
      eyebrow: 'Digital platform',
      h1: (
        <>
          {lang === 'en' ? 'Lost-and-found, made simpler.' : 'Kutafuta-kurudisha, kumerahisishwa.'}
          <span className="block text-accent-orange mt-2">
            {lang === 'en' ? 'Report, verify and follow your journey through Return4me.' : 'Ripoti, thibitisha na ufuatilie safari yako kupitia Return4me.'}
          </span>
        </>
      ),
      copy: lang === 'en'
        ? 'Start with a single report on your phone. The platform matches items and protects every step of the return.'
        : 'Anza kwa ripoti moja kwenye simu yako. Jukwaa linaoanisha vitu na kulinda kila hatua ya urejeshaji.',
      primary: { label: lang === 'en' ? 'Report an Item' : 'Ripoti Kitu', view: 'finder' },
      secondary: { label: lang === 'en' ? 'How It Works' : 'Inavyofanya Kazi', scroll: true },
    },
    {
      img: 'return4me-successful-return',
      alt: lang === 'en' ? 'Lost item being returned to its owner through Return4me' : 'Kitu kilichopotea kinarejeshwa kwa mmiliki wake kupitia Return4me',
      eyebrow: 'Successful returns',
      h1: (
        <>
          {lang === 'en' ? "Lost doesn't have to mean gone forever." : 'Kupoteza hakumaanishi kutoweka milele.'}
          <span className="block text-accent-orange mt-2">
            {lang === 'en' ? 'Return4me helps people reconnect with the things that matter.' : 'Return4me husaidia watu kuungana tena na vile walivyopenda.'}
          </span>
        </>
      ),
      copy: lang === 'en'
        ? 'Every return is a story — a phone, an ID or a treasured keepsake, finally back where it belongs.'
        : 'Kila urejeshaji ni hadithi — simu, kitambulisho au kitu kinachopendwa — kurudi mahali pake.',
      primary: { label: lang === 'en' ? 'Get Started' : 'Anza', view: 'owner' },
      secondary: { label: lang === 'en' ? 'How It Works' : 'Inavyofanya Kazi', scroll: true },
    },
  ];

  // ── HOW IT WORKS STEPS ──────────────────────────────────────────────────
  const steps = [
    {
      title: lang === 'en' ? 'Report' : 'Ripoti',
      desc: lang === 'en'
        ? 'Tell us what you lost or found — a photo, a location, a few details.'
        : 'Tuambie ulichopoteza au umepata — picha, mahali, maelezo machache.',
    },
    {
      title: lang === 'en' ? 'Match & Verify' : 'Oanisha & Thibitisha',
      desc: lang === 'en'
        ? 'Return4me checks for matches and verifies rightful ownership securely.'
        : 'Return4me huangalia mechi na kuthibitisha umiliki halali kwa usalama.',
    },
    {
      title: lang === 'en' ? 'Pay Securely' : 'Lipia kwa Usalama',
      desc: lang === 'en'
        ? 'Payment is held in escrow via M-Pesa until the item is returned.'
        : 'Malipo huhifadhiwa kwa escrow kupitia M-Pesa hadi kitu kurudishwe.',
    },
    {
      title: lang === 'en' ? 'Collect' : 'Chukua',
      desc: lang === 'en'
        ? 'Collect your item from a verified agent — or receive it from a finder.'
        : 'Chukua kitu chako kutoka kwa wakala aliyeidhinishwa — au kipokee kutoka mpataji.',
    },
  ];

  // Category icon mapping for visual consistency
  const getCategoryIcon = (categoryId: string) => {
    switch (categoryId) {
      case 'national-id':
      case 'driving-licence':
        return Key;
      case 'vehicle-logbook':
      case 'number-plate':
        return Car;
      case 'phone':
      case 'smartphone':
        return PhoneCall;
      case 'wallet':
      case 'cash':
        return Wallet;
      case 'laptop':
      case 'tablet':
        return Laptop;
      case 'bag':
      case 'luggage':
        return Luggage;
      case 'keys':
        return Key;
      case 'jewellery':
      case 'watch':
        return Gem;
      default:
        return Package;
    }
  };

  return (
    <div className="w-full">
      {/* ───────── HERO STORY SLIDESHOW ───────── */}
      <section
        role="region"
        aria-roledescription="carousel"
        aria-label={lang === 'en' ? 'How Return4me works' : 'Jinsi Return4me inavyofanya kazi'}
        onKeyDown={handleCarouselKeyDown}
        tabIndex={-1}
        className="relative isolate overflow-hidden bg-primary-green focus:outline-none"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
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
              {/* Directional gradient overlay — left-heavy so headline stays legible; photo stays visible */}
              <div className="absolute inset-0 bg-gradient-to-r from-primary-green/20 via-primary-green/8 to-transparent" />
              {/* Subtle top gradient for additional contrast */}
              <div className="absolute inset-0 bg-gradient-to-t from-primary-green/15 via-transparent to-transparent" />
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
                  transition={{ duration: 0.4, ease: 'easeOut' }}
                  className={active ? '' : 'hidden'}
                >
                  <div className="mb-4 flex items-center gap-2">
                    <span className="inline-block h-0.5 w-8 bg-accent-orange rounded-full" />
                    <span className="text-xs font-bold uppercase tracking-widest text-white/90">{s.eyebrow}</span>
                  </div>
                  <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-white leading-[1.1] sm:leading-tight">
                    {s.h1}
                  </h1>
                  <p className="mt-5 text-sm sm:text-base text-white/90 max-w-xl leading-relaxed">
                    {s.copy}
                  </p>
                  <div className="mt-8 flex flex-col sm:flex-row gap-3">
                    <Button variant="primary" size="lg" onClick={() => handleSlideAction(s.primary)} className="min-h-[48px] px-8">
                      {s.primary.label}
                    </Button>
                    <Button
                      variant="inverse"
                      size="lg"
                      onClick={() => handleSlideAction(s.secondary)}
                      className="min-h-[48px] px-6"
                    >
                      {s.secondary.label}
                    </Button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Previous / next controls */}
        <button
          type="button"
          onClick={prevSlide}
          aria-label={lang === 'en' ? 'Previous slide' : 'Slaidi iliyotangulia'}
          className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/30 hover:bg-black/50 text-white flex items-center justify-center transition-colors motion-reduce:transition-none"
        >
          <ChevronLeft size={22} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={nextSlide}
          aria-label={lang === 'en' ? 'Next slide' : 'Slaidi inayofuata'}
          className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/30 hover:bg-black/50 text-white flex items-center justify-center transition-colors motion-reduce:transition-none"
        >
          <ChevronRight size={22} aria-hidden="true" />
        </button>

        {/* Slide indicators */}
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2" role="tablist" aria-label="Slide indicator">
          {slides.map((s, i) => (
            <button
              key={s.img}
              type="button"
              onClick={() => goToSlide(i)}
              role="tab"
              aria-selected={i === current}
              aria-label={lang === 'en' ? `Go to slide ${i + 1}` : `Nenda kwenye slaidi ${i + 1}`}
              aria-current={i === current ? 'true' : undefined}
              className={`rounded-full transition-all duration-300 motion-reduce:transition-none ${i === current ? 'w-8 h-2 bg-accent-orange' : 'w-2 h-2 bg-white/40 hover:bg-white/70'}`}
            />
          ))}
        </div>
      </section>

      {/* ───────── TRUST STRIP ───────── */}
      <section className="bg-white border-b border-brand-border">
        <div className="mx-auto max-w-7xl px-5 sm:px-12 py-5">
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs sm:text-sm font-semibold text-brand-muted-text">
            <span className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-status-success" aria-hidden="true" />
              {lang === 'en' ? 'Vetted Agents Only' : 'Mawakala Waliothibitishwa Pekee'}
            </span>
            <span className="flex items-center gap-2">
              <Users size={16} className="text-status-success" aria-hidden="true" />
              {activeAgentsCount !== null
                ? (lang === 'en' ? `${activeAgentsCount} Active Agents` : `Wakala ${activeAgentsCount} Hai`)
                : (lang === 'en' ? 'Growing Agent Network' : 'Mtandao wa Wakala Unaokua')}
            </span>
            <span className="flex items-center gap-2">
              <CreditCard size={16} className="text-status-success" aria-hidden="true" />
              {lang === 'en' ? 'M-Pesa Supported' : 'Inatumia M-Pesa'}
            </span>
            <span className="flex items-center gap-2">
              <Lock size={16} className="text-status-success" aria-hidden="true" />
              {lang === 'en' ? 'Secure Escrow' : 'Escrow Salama'}
            </span>
          </div>
        </div>
      </section>

      {/* ───────── SERVICE DISCOVERY / CATEGORIES ───────── */}
      <section className="bg-brand-beige py-14 sm:py-20">
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <SectionHeading
            eyebrow={lang === 'en' ? 'What can we help recover?' : 'Tunaweza kusaidia nini kurejeshwa?'}
            title={lang === 'en' ? 'Common items people lose' : 'Vitu vinavyopotea sana'}
            description={lang === 'en' ? 'From identification documents and cards to money and vehicle records.' : 'Kutoka kwa hati na kadi hadi pesa na rekodi za magari.'}
          />
          {categoriesLoading ? (
            <div className="mt-8">
              <Skeleton shape="text" className="h-64" />
            </div>
          ) : (
            <CategoryDirectory categories={categories} lang={lang} onReportLost={() => setView('owner')} onReportFound={() => setView('finder')} />
          )}
        </div>
      </section>

      {/* ───────── EARN & RETURN MARKETING ───────── */}
      <section className="bg-white py-14 sm:py-20 border-t border-brand-border">
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center">
            {/* Image area */}
            <div className="order-2 lg:order-1">
              <div className="aspect-[4/3] bg-brand-light-gray rounded-xl overflow-hidden flex items-center justify-center">
                <img
                  src="/assets/return4me-earn-and-return.webp"
                  alt={lang === 'en' ? 'A Return4me agent safely returning a found item to its owner' : 'Wakala wa Return4me anarejeshza kilichopatikana kwa mmiliki wake'}
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              </div>
            </div>

            {/* Content area */}
            <div className="order-1 lg:order-2">
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary-green">
                {lang === 'en' ? 'Found something? Help it find its way home.' : 'Umepeleza saidi? Isaidie njia ya nyumbani.'}
              </h2>
              <p className="mt-4 text-sm sm:text-base text-brand-muted-text leading-relaxed">
                {lang === 'en'
                  ? "Every lost item has a story. Every person who finds something has an opportunity to make a difference — and be rewarded for doing the right thing."
                  : "Kila kitu kilichopotea kina hadithi. Kila mtu anayepeleza kitu ana fursa kufanya tofauti — na kutunzwa kwa kufanya kitu sahihi."}
              </p>

              <div className="mt-8 space-y-6">
                {/* If you find something */}
                <div>
                  <h3 className="text-sm font-semibold text-brand-dark-text uppercase tracking-wide">
                    {lang === 'en' ? "If you find something" : "Ikiwa umepeleza kitu"}
                  </h3>
                  <p className="mt-2 text-sm text-brand-muted-text leading-relaxed">
                    {lang === 'en'
                      ? "Found someone's ID, phone, bag, certificate or other belonging? Don't leave it behind. Report it on Return4me and give its owner a chance to get it back."
                      : "Umepeleza kitambulisho, simu, mkoba, cheti au kitu cha mtu? Usiache nyuma. Ripoti kwenye Return4me na umpatie mmiliki wake nia ya kukirejesha."}
                  </p>
                  <p className="mt-2 text-sm text-brand-muted-text">
                    {lang === 'en'
                      ? "Successful finders can earn when a reported item is safely returned."
                      : "Watafutaji wanaofaulu wanaweza kutunzwa inapotangazwa kitu kilichorejeshwa salama."}
                  </p>
                  <div className="mt-4">
                    <Button variant="accent" size="lg" onClick={() => setView('finder')} className="min-h-[48px]">
                      <MapPin size={18} aria-hidden="true" />
                      {lang === 'en' ? 'Report Something Found' : 'Ripoti Kitu Ulichopeleza'}
                    </Button>
                  </div>
                </div>

                {/* If you lose something */}
                <div>
                  <h3 className="text-sm font-semibold text-brand-dark-text uppercase tracking-wide">
                    {lang === 'en' ? "If you lose something" : "Ikiwa umepoteza kitu"}
                  </h3>
                  <p className="mt-2 text-sm text-brand-muted-text leading-relaxed">
                    {lang === 'en'
                      ? "Lost something important? Report it. The sooner your loss is recorded, the sooner a matching found item can be identified."
                      : "Umepoteza kitu muhimu? Ripoti. Mapema zaidi unaporipoti upotevu wako, mapema zaidi kitu kilichopeleza kitatambulika."}
                  </p>
                  <div className="mt-4">
                    <Button variant="primary" size="lg" onClick={() => setView('owner')} className="min-h-[48px]">
                      <Search size={18} aria-hidden="true" />
                      {lang === 'en' ? 'Report a Lost Item' : 'Ripoti Kitu Kilichopotea'}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Closing brand message */}
              <div className="mt-10 pt-6 border-t border-brand-border">
                <p className="text-sm text-brand-dark-text leading-relaxed">
                  {lang === 'en' ? 'Lost something? Report it.' : 'Umepoteza kitu? Ripoti.'}
                  <br />
                  {lang === 'en' ? 'Found something? Give it a chance to get home.' : 'Umepeleza kitu? Mpe nia ya kufika nyumbani.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────── RECENT FOUND ITEMS ───────── */}
      <section className="bg-white py-14 sm:py-20 border-t border-brand-border">
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <SectionHeading
            eyebrow={lang === 'en' ? 'Recently found' : 'Vilivyopatikana hivi karibuni'}
            title={lang === 'en' ? 'Items waiting for owners' : 'Vitu vinavyosubiri wamiliki'}
            description={lang === 'en' ? 'These items have been found and are safely held by verified agents.' : 'Hivi vitu vimepatikana na vimeshikiliwa na wakala waliothibitishwa.'}
          />
          {recentItemsLoading ? (
            <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="bg-brand-beige/50 rounded-2xl border border-brand-border overflow-hidden">
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
                title={lang === 'en' ? 'Could not load items' : 'Haikuweza kupakia vitu'}
                description={lang === 'en' ? 'Please refresh the page.' : 'Tafadhali onyesa upya ukurasa.'}
              />
            </div>
          ) : recentItems.length === 0 ? (
            <div className="mt-8">
              <EmptyState
                icon={Package}
                title={lang === 'en' ? 'No items waiting' : 'Hakuna vitu vinavyosubiri'}
                description={lang === 'en' ? 'Check back soon — new items are added regularly.' : 'Rudi hivi karibuni — vitu vipya vinaongezwa mara kwa mara.'}
                action={
                  <Button variant="accent" size="sm" onClick={() => setView('finder')}>
                    <MapPin size={14} aria-hidden="true" />
                    {lang === 'en' ? 'Report a Found Item' : 'Ripoti Kitu Kilichopatikana'}
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
                  ? (lang === 'en' ? 'Claimed' : 'Imechingwa')
                  : item.status === 'at_agent'
                  ? (lang === 'en' ? 'With Agent' : 'Na Wakala')
                  : (lang === 'en' ? 'Found' : 'Imepatikana');
                const statusVariant = item.status === 'claimed' ? 'warning' : item.status === 'at_agent' ? 'info' : 'success';
                
                return (
                  <motion.div
                    key={item.id}
                    whileHover={{ y: -4 }}
                    whileTap={{ scale: 0.98 }}
                    className="group relative bg-white rounded-2xl border border-brand-border overflow-hidden transition-all hover:shadow-lg focus-within:ring-2 focus-within:ring-accent-orange motion-reduce:transition-none"
                  >
                    {/* Thumbnail area */}
                    <div className="aspect-[4/3] bg-brand-light-gray relative overflow-hidden">
                      {hasPhoto ? (
                        <img
                          src={item.photo_url}
                          alt={lang === 'en' ? `${getCategoryName(item.category_id)} - found item` : `${getCategoryName(item.category_id)} - kitu kilichopatikana`}
                          loading="lazy"
                          decoding="async"
                          width="400"
                          height="300"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        />
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-brand-muted-text bg-brand-light-gray">
                          <Lock size={28} aria-hidden="true" className="mb-2" />
                          <span className="text-xs font-bold">
                            {isSensitive
                              ? (lang === 'en' ? 'Photo hidden for privacy' : 'Picha imefichwa kwa faragha')
                              : (lang === 'en' ? 'No photo available' : 'Hakuna picha')}
                          </span>
                        </div>
                      )}
                      {/* Status badge */}
                      <div className="absolute top-3 left-3">
                        <Badge variant={statusVariant} icon={item.status === 'claimed' ? Lock : item.status === 'at_agent' ? ShieldCheck : Package}>
                          {statusText}
                        </Badge>
                      </div>
                      {/* Hover action hint */}
                      <div className="absolute inset-0 bg-primary-green/0 group-hover:bg-primary-green/5 transition-colors duration-300" />
                    </div>
                    
                    {/* Content */}
                    <div className="p-4 flex-1 flex flex-col">
                      <h3 className="text-sm font-semibold text-brand-dark-text truncate">
                        {getCategoryName(item.category_id)}
                      </h3>
                      <p className="text-xs text-brand-muted-text mt-1 line-clamp-2 flex-1">
                        {isSensitive
                          ? (lang === 'en' ? 'Details hidden for privacy' : 'Maelezo yamefichwa kwa faragha')
                          : (item.description || item.location_description || (lang === 'en' ? 'No description available' : 'Hakuna maelezo'))}
                      </p>
                      <div className="mt-3 pt-3 border-t border-brand-border flex items-center justify-between">
                        <span className="text-xs text-brand-muted-text">
                          {new Date(item.created_at).toLocaleDateString(lang === 'en' ? 'en-US' : 'sw-KE', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                        <span className="text-xs font-mono text-brand-dark-text bg-brand-light-gray px-2 py-1 rounded">
                          {item.id.substring(0, 8).toUpperCase()}
                        </span>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ───────── HOW IT WORKS ───────── */}
      <section id="how-it-works" className="bg-brand-beige py-14 sm:py-20 border-t border-brand-border scroll-mt-20">
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-14 items-center">
            {/* Image left — the physical handover */}
            <div className="relative order-1 overflow-hidden rounded-3xl shadow-lg">
              <img
                src="/assets/return4me-agent-handover-1024w.webp"
                srcSet="/assets/return4me-agent-handover-430w.webp 430w, /assets/return4me-agent-handover-768w.webp 768w, /assets/return4me-agent-handover-1024w.webp 1024w, /assets/return4me-agent-handover-1440w.webp 1440w"
                sizes="(min-width:1024px) 45vw, 100vw"
                alt={lang === 'en' ? 'Person handing a found item to a Return4me agent' : 'Mtu akimkabidhi wakala wa Return4me kitu kilichopatikana'}
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
                eyebrow={lang === 'en' ? 'How it works' : 'Inavyofanya kazi'}
                title={lang === 'en' ? 'Four simple steps' : 'Hatua nne rahisi'}
                description={lang === 'en' ? 'From report to recovery — we handle the hard parts.' : 'Kutoka ripoti hadi urejeshaji — tunashughulikia magumu.'}
              />
              <ol className="mt-6 space-y-5">
                {steps.map((step, i) => (
                  <li key={i} className="flex items-start gap-4">
                    <span className="w-7 h-7 rounded-full bg-accent-orange text-white text-xs font-extrabold flex items-center justify-center shrink-0">
                      {i + 1}
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-brand-dark-text">{step.title}</p>
                      <p className="text-xs text-brand-muted-text mt-1 leading-relaxed">{step.desc}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </section>

      {/* ───────── DIGITAL PLATFORM ───────── */}
      <section className="bg-white py-14 sm:py-20 border-t border-brand-border">
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-14 items-center">
            {/* Text left */}
            <div>
              <SectionHeading
                eyebrow={lang === 'en' ? 'Digital platform' : 'Jukwaa la kidijitali'}
                title={lang === 'en' ? 'Everything starts with a report.' : 'Yote huanza na ripoti.'}
                description={lang === 'en'
                  ? 'From your phone you can start and manage the return journey — no offices to visit, no forms to post.'
                  : 'Kutoka kwenye simu yako unaweza kuanza na kusimamia safari ya urejeshaji — hakuna ofisi za kuenda, hakuna fomu za kutuma.'}
              />
              <ul className="mt-6 space-y-3 text-sm font-semibold text-brand-dark-text">
          {[
            lang === 'en' ? 'Report a lost item' : 'Ripoti kitu kilichopotea',
            lang === 'en' ? 'Report a found item' : 'Ripoti kitu kilichopatikana',
            lang === 'en' ? 'Verify identity securely' : 'Thibitisha utambulisho kwa usalama',
            lang === 'en' ? 'Track a claim you have started' : 'Fuatilia daima uliyoianzisha',
            lang === 'en' ? 'Connect with a vetted agent for the handover' : 'Ungana na wakala aliyeidhinishwa kwa uwasilishaji',
          ].map((ft) => (
            <li key={ft} className="flex items-center gap-2.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-orange shrink-0" aria-hidden="true" />
              {ft}
            </li>
          ))}
        </ul>
      </div>
      {/* Image right — the app/platform experience */}
      <div className="relative">
        <div className="overflow-hidden rounded-3xl shadow-lg">
          <img
            src="/assets/return4me-app-user-nairobi-1024w.webp"
            srcSet="/assets/return4me-app-user-nairobi-430w.webp 430w, /assets/return4me-app-user-nairobi-768w.webp 768w, /assets/return4me-app-user-nairobi-1024w.webp 1024w, /assets/return4me-app-user-nairobi-1440w.webp 1440w"
            sizes="(min-width:1024px) 45vw, 100vw"
            alt={lang === 'en' ? 'Kenyan user using the Return4me platform on a smartphone' : 'Mkenya akitumia jukwaa la Return4me kwenye simu'}
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
      <section className="bg-brand-beige py-14 sm:py-20 border-t border-brand-border">
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-14 items-center">
            {/* Image left — the human outcome */}
            <div className="relative overflow-hidden rounded-3xl shadow-lg">
              <img
                src="/assets/return4me-successful-return-1024w.webp"
                srcSet="/assets/return4me-successful-return-430w.webp 430w, /assets/return4me-successful-return-768w.webp 768w, /assets/return4me-successful-return-1024w.webp 1024w, /assets/return4me-successful-return-1440w.webp 1440w"
                sizes="(min-width:1024px) 45vw, 100vw"
                alt={lang === 'en' ? 'Lost item being returned to its owner through Return4me' : 'Kitu kilichopotea kinarejeshwa kwa mmiliki wake kupitia Return4me'}
                width="1672"
                height="941"
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover aspect-[4/3]"
              />
            </div>
            {/* Message right */}
            <div>
              <div className="text-[11px] font-extrabold uppercase tracking-widest text-accent-orange mb-3">
                {lang === 'en' ? 'Successful returns' : 'Urejeshaji uliofanikiwa'}
              </div>
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary-green">
                {lang === 'en' ? 'Because getting something back matters.' : 'Kwa sababu kupata kitu kinarejeshwa ni muhimu.'}
              </h2>
              <p className="mt-4 text-sm sm:text-base text-brand-muted-text leading-relaxed max-w-xl">
                {lang === 'en'
                  ? 'Every lost item has a person behind it. Return4me exists to make the journey back possible — safely, transparently and with real people nearby.'
                  : 'Kila kitu kilichopotea kina mtu nyuma yake. Return4me ipo kurahisisha safari ya kurudi — kwa usalama, kwa uwazi na kwa watu halisi wa karibu.'}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ───────── FEES / TRANSPARENCY ───────── */}
      <section className="bg-white py-14 sm:py-20 border-t border-brand-border">
        <div className="mx-auto max-w-7xl px-5 sm:px-12">
          <SectionHeading
            eyebrow={lang === 'en' ? 'Transparent fees' : 'Ada wazi'}
            title={lang === 'en' ? 'Know exactly what you pay' : 'Jua kile unalolipa'}
            description={lang === 'en' ? 'The recovery fee depends on the type of item. Every payment is allocated transparently between the finder, local agent and Return4me.' : 'Ada ya urejeshaji inategeneza aina ya bidhaa. Kila malipo inagawanywa wazi kati ya mpataji, wakala wa eneo na Return4me.'}
          />
          {categoriesLoading ? (
            <div className="mt-8">
              <Skeleton shape="text" className="h-64" />
            </div>
          ) : (
            <FeeDirectory categories={categories} lang={lang} />
          )}
        </div>
      </section>

      {/* ───────── FINAL CTA ───────── */}
      <section className="bg-primary-green py-14 sm:py-20">
        <div className="mx-auto max-w-3xl px-5 sm:px-12 text-center">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
            {lang === 'en' ? 'Ready to get started?' : 'Tayari kuanza?'}
          </h2>
          <p className="mt-3 text-sm sm:text-base text-white/80 max-w-xl mx-auto">
            {lang === 'en'
              ? 'Whether you lost something or found something, we\'re here to help.'
              : 'Iwe umepoteza kitu au umepata kitu, tuko hapa kukusaidia.'}
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Button variant="secondary" size="lg" onClick={() => setView('owner')} className="min-h-[48px] bg-white hover:bg-brand-light-gray text-primary-green border-white">
              <Search size={18} aria-hidden="true" />
              {t.ownerBtn}
            </Button>
            <Button variant="inverse" size="lg" onClick={() => setView('finder')} className="min-h-[48px]">
              <MapPin size={18} aria-hidden="true" />
              {t.finderBtn}
            </Button>
          </div>
        </div>
      </section>

    </div>
  );
}

// ── CATEGORY DIRECTORY COMPONENT ──────────────────────────────────────────
// Groups categories into human-friendly discovery groups for the homepage.
// No pricing is displayed — this section is purely for service discovery.

const CATEGORY_GROUPS: { key: string; labelEn: string; labelSw: string; icon: React.ComponentType<any>; ids: string[] }[] = [
  {
    key: 'documents',
    labelEn: 'Documents & Identification',
    labelSw: 'Hati na Vitambulisho',
    icon: ShieldCheck,
    ids: [
      'national-id', 'passport', 'student-id', 'driving-licence', 'atm-credit-card',
      'kra-nhif-nssf', 'birth-certificate', 'academic-certificate',
      'title-deed', 'work-permit-visa', 'insurance-document',
      'other-document', 'vehicle-logbook', 'number-plate',
    ],
  },
  {
    key: 'phones',
    labelEn: 'Phones & Electronics',
    labelSw: 'Simu na Vifaa vya Umeme',
    icon: Smartphone,
    ids: [
      'smartphone', 'feature-phone', 'tablet', 'laptop',
      'smartwatch', 'wireless-earphones', 'headphones',
      'usb-cable', 'phone-charger', 'powerbank',
      'flash-drive-hdd', 'camera', 'gaming-console',
      'memory-card',
    ],
  },
  {
    key: 'personal',
    labelEn: 'Personal Belongings',
    labelSw: 'Vitu vya Kibinafsi',
    icon: Wallet,
    ids: [
      'wallet-with-contents', 'empty-wallet', 'bag-with-documents',
      'id-lanyard-badge', 'optical-sunglasses',
      'umbrella', 'jewelry', 'bicycle',
      'bag-no-docs', 'cash-money',
    ],
  },
  {
    key: 'keys',
    labelEn: 'Keys & Everyday Items',
    labelSw: 'Funguo na Vitu vya Kila Siku',
    icon: Key,
    ids: ['bunch-of-keys', 'single-key', 'padlock'],
  },
  {
    key: 'books',
    labelEn: 'Books & School Items',
    labelSw: 'Vitabu na Vitu vya Shule',
    icon: Package,
    ids: ['bible', 'school-book', 'novel', 'notebook-diary'],
  },
  {
    key: 'other',
    labelEn: 'Other Items',
    labelSw: 'Vitu Vingine',
    icon: Package,
    ids: ['other-item'],
  },
];

function CategoryDirectory({ categories, lang, onReportLost, onReportFound }: { categories: any[]; lang: 'en' | 'sw'; onReportLost: () => void; onReportFound: () => void }) {
  const catMap = new Map(categories.map((c: any) => [c.id, c]));

  const getName = (cat: any) => lang === 'en' ? cat.name_en : cat.name_sw;

  const groups = CATEGORY_GROUPS.map((g) => ({
    ...g,
    items: g.ids.map((id) => catMap.get(id)).filter(Boolean),
  })).filter((g) => g.items.length > 0);

  if (groups.length === 0) return null;

  return (
    <div className="mt-8 space-y-6">
      {groups.map((group) => {
        const Icon = group.icon;
        return (
          <div key={group.key} className="border border-brand-border rounded-xl bg-white p-5 sm:p-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-primary-green/10 flex items-center justify-center shrink-0">
                <Icon size={20} className="text-primary-green" aria-hidden="true" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-brand-dark-text">
                  {lang === 'en' ? group.labelEn : group.labelSw}
                </h3>
                <p className="mt-2 text-sm text-brand-muted-text leading-relaxed">
                  {group.items.map((cat: any) => getName(cat)).join(' \u00B7 ')}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}


// ── FEE DIRECTORY COMPONENT ───────────────────────────────────────────────
// Groups all categories into customer-facing categories with a compact
// table on desktop and an accordion on mobile.

const FEE_GROUPS: { key: string; labelEn: string; labelSw: string; ids: string[] }[] = [
  {
    key: 'documents',
    labelEn: 'Documents & identification',
    labelSw: 'Hati na vitambulisho',
    ids: [
      'national-id', 'passport', 'student-id', 'driving-licence', 'atm-credit-card',
      'kra-nhif-nssf', 'birth-certificate', 'academic-certificate',
      'title-deed', 'work-permit-visa', 'insurance-document',
      'other-document', 'vehicle-logbook', 'number-plate',
    ],
  },
  {
    key: 'phones',
    labelEn: 'Phones & electronics',
    labelSw: 'Simu na vifaa vya umeme',
    ids: [
      'smartphone', 'feature-phone', 'tablet', 'laptop',
      'smartwatch', 'wireless-earphones', 'headphones',
      'usb-cable', 'phone-charger', 'powerbank',
      'flash-drive-hdd', 'camera', 'gaming-console',
      'memory-card',
    ],
  },
  {
    key: 'personal',
    labelEn: 'Personal belongings',
    labelSw: 'Vitu vya kibinafsi',
    ids: [
      'wallet-with-contents', 'empty-wallet', 'bag-with-documents',
      'id-lanyard-badge', 'optical-sunglasses',
      'umbrella', 'jewelry', 'bicycle',
      'bag-no-docs', 'cash-money',
    ],
  },
  {
    key: 'keys',
    labelEn: 'Keys & accessories',
    labelSw: 'Funguo na vifaa',
    ids: ['bunch-of-keys', 'single-key', 'padlock'],
  },
  {
    key: 'books',
    labelEn: 'Books & school items',
    labelSw: 'Vitabu na vituo vya shule',
    ids: ['bible', 'school-book', 'novel', 'notebook-diary'],
  },
  {
    key: 'other',
    labelEn: 'Other items',
    labelSw: 'Vitu vingine',
    ids: ['other-item'],
  },
];

function FeeDirectory({ categories, lang }: { categories: any[]; lang: 'en' | 'sw' }) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [expandedItem, setExpandedItem] = useState<string | null>(null);

  const catMap = new Map(categories.map((c: any) => [c.id, c]));
  const getName = (cat: any) => lang === 'en' ? cat.name_en : cat.name_sw;
  const getGroupCats = (ids: string[]) => ids.map((id) => catMap.get(id)).filter(Boolean);

  const groups = FEE_GROUPS.map((g) => ({
    ...g,
    categories: getGroupCats(g.ids),
  })).filter((g) => g.categories.length > 0);

  if (groups.length === 0) return null;

  return (
    <div className="mt-8 space-y-3">
      {groups.map((group) => {
        const isGroupOpen = expandedGroup === group.key;
        return (
          <div key={group.key} className="border border-brand-border rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => {
                setExpandedGroup(isGroupOpen ? null : group.key);
                setExpandedItem(null);
              }}
              aria-expanded={isGroupOpen}
              aria-controls={`fee-group-${group.key}`}
              className="w-full flex items-center justify-between px-5 py-4 text-left bg-brand-beige/40 hover:bg-brand-beige/70 transition-colors duration-200 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-orange focus-visible:ring-inset"
            >
              <span className="text-sm font-semibold text-brand-dark-text">
                {lang === 'en' ? group.labelEn : group.labelSw}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-brand-muted-text">
                  {group.categories.length} {lang === 'en' ? 'items' : 'vitu'}
                </span>
                <ChevronRight
                  size={16}
                  className={`text-brand-muted-text transition-transform duration-200 motion-reduce:transition-none ${isGroupOpen ? 'rotate-90' : ''}`}
                  aria-hidden="true"
                />
              </span>
            </button>
            {isGroupOpen && (
              <div id={`fee-group-${group.key}`}>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-t border-brand-border bg-brand-beige/30">
                        <th className="text-left px-5 py-3 text-xs font-semibold text-brand-muted-text uppercase tracking-wide">
                          {lang === 'en' ? 'Item' : 'Bidhaa'}
                        </th>
                        <th className="text-right px-5 py-3 text-xs font-semibold text-brand-muted-text uppercase tracking-wide">
                          {lang === 'en' ? 'Total' : 'Jumla'}
                        </th>
                        <th className="text-right px-5 py-3 text-xs font-semibold text-brand-muted-text uppercase tracking-wide">
                          {lang === 'en' ? 'Finder' : 'Mpataji'}
                        </th>
                        <th className="text-right px-5 py-3 text-xs font-semibold text-brand-muted-text uppercase tracking-wide">
                          {lang === 'en' ? 'Agent' : 'Wakala'}
                        </th>
                        <th className="text-right px-5 py-3 text-xs font-semibold text-brand-muted-text uppercase tracking-wide">
                          Return4me
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.categories.map((cat: any, idx: number) => (
                        <tr key={cat.id} className={`border-t border-brand-border ${idx % 2 === 0 ? 'bg-white' : 'bg-brand-beige/20'}`}>
                          <td className="px-5 py-3 font-medium text-brand-dark-text">{getName(cat)}</td>
                          <td className="px-5 py-3 text-right font-bold text-brand-dark-text">KES {cat.total_fee}</td>
                          <td className="px-5 py-3 text-right text-brand-muted-text text-xs">KES {cat.finder_share}</td>
                          <td className="px-5 py-3 text-right text-brand-muted-text text-xs">KES {cat.agent_share}</td>
                          <td className="px-5 py-3 text-right text-brand-muted-text text-xs">KES {cat.platform_share}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="md:hidden">
                  {group.categories.map((cat: any) => {
                    const isItemOpen = expandedItem === cat.id;
                    return (
                      <div key={cat.id} className="border-t border-brand-border">
                        <button
                          type="button"
                          onClick={() => setExpandedItem(isItemOpen ? null : cat.id)}
                          aria-expanded={isItemOpen}
                          aria-controls={`fee-item-${cat.id}`}
                          className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-brand-beige/30 transition-colors duration-200 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-orange focus-visible:ring-inset"
                        >
                          <span className="text-sm font-medium text-brand-dark-text">{getName(cat)}</span>
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-bold text-brand-dark-text">KES {cat.total_fee}</span>
                            <ChevronRight size={14} className={`text-brand-muted-text transition-transform duration-200 motion-reduce:transition-none ${isItemOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
                          </span>
                        </button>
                        {isItemOpen && (
                          <div id={`fee-item-${cat.id}`} className="px-5 pb-4 bg-brand-beige/20">
                            <div className="space-y-2 pt-2">
                              <div className="flex justify-between text-sm">
                                <span className="text-brand-muted-text">{lang === 'en' ? 'Total recovery fee' : 'Ada ya urejeshaji'}</span>
                                <span className="font-bold text-brand-dark-text">KES {cat.total_fee}</span>
                              </div>
                              <div className="flex justify-between text-xs">
                                <span className="text-brand-muted-text">{lang === 'en' ? 'Finder' : 'Mpataji'}</span>
                                <span className="text-brand-dark-text">KES {cat.finder_share}</span>
                              </div>
                              <div className="flex justify-between text-xs">
                                <span className="text-brand-muted-text">{lang === 'en' ? 'Agent' : 'Wakala'}</span>
                                <span className="text-brand-dark-text">KES {cat.agent_share}</span>
                              </div>
                              <div className="flex justify-between text-xs border-t border-brand-border pt-2">
                                <span className="text-brand-muted-text">Return4me</span>
                                <span className="text-brand-dark-text">KES {cat.platform_share}</span>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

