import React, { useState, useEffect } from 'react';
import { translations } from '../types';
import { Globe, User, ShieldCheck, MapPin, Search, Home, Menu, X, LogOut } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface NavbarProps {
  lang: 'en' | 'sw';
  setLang: (lang: 'en' | 'sw') => void;
  currentView: 'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'terms' | 'privacy';
  setView: (view: 'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'terms' | 'privacy') => void;
  token: string | null;
  logout: () => void;
}

export default function Navbar({ lang, setLang, currentView, setView, token, logout }: NavbarProps) {
  const t = translations[lang];
  const [isOpen, setIsOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Check if admin is logged in (to conditionally show admin console link)
  useEffect(() => {
    const adminToken = localStorage.getItem('admin_token');
    setIsAdmin(!!adminToken);
  }, [currentView, token]);

  const handleNavClick = (view: 'home' | 'finder' | 'owner' | 'agent' | 'admin' | 'terms' | 'privacy') => {
    setView(view);
    setIsOpen(false);
  };

  const navLinkClass = (view) =>
    'relative px-3 py-2 text-sm font-medium transition-colors cursor-pointer rounded-md ' +
    (currentView === view
      ? 'text-primary-green'
      : 'text-brand-muted-text hover:text-brand-dark-text');

  const navLinkUnderline = (view) =>
    currentView === view ? (
      <motion.span
        layoutId="nav-underline"
        className="absolute bottom-0 left-3 right-3 h-0.5 bg-primary-green rounded-full"
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      />
    ) : null;

  return (
    <>
      <header className="bg-white text-brand-dark-text sticky top-0 z-40 h-16 md:h-20 border-b border-brand-border flex items-center">
        <div className="max-w-7xl w-full mx-auto px-4 sm:px-12 flex items-center justify-between">
          {/* Brand Logo Group */}
          <div
            className="flex items-center cursor-pointer select-none"
            onClick={() => handleNavClick('home')}
            role="button"
            tabIndex={0}
            aria-label={lang === 'sw' ? 'Nenda Nyumbani' : 'Go to Home'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleNavClick('home');
              }
            }}
          >
            <img 
              src="/assets/logo_wordmark_transparent.png" 
              alt="Return4me Logo" 
              className="h-11 md:h-14 w-auto object-contain"
              referrerPolicy="no-referrer"
            />
          </div>

          <nav className="hidden lg:flex items-center gap-1" aria-label={lang === 'en' ? 'Main navigation' : 'Navishan kuu'}>
            <button onClick={() => handleNavClick('home')} className={navLinkClass('home')}>
              {lang === 'en' ? 'Home' : 'Mwanzo'}
              {navLinkUnderline('home')}
            </button>
            <button onClick={() => handleNavClick('owner')} className={navLinkClass('owner')}>
              {t.ownerBtn}
              {navLinkUnderline('owner')}
            </button>
            <button onClick={() => handleNavClick('finder')} className={navLinkClass('finder')}>
              {t.finderBtn}
              {navLinkUnderline('finder')}
            </button>
            <button onClick={() => handleNavClick('agent')} className={navLinkClass('agent')}>
              {t.agentBtn}
              {navLinkUnderline('agent')}
            </button>
            {isAdmin && (
              <button onClick={() => handleNavClick('admin')} className={navLinkClass('admin')}>
                {t.adminBtn}
                {navLinkUnderline('admin')}
              </button>
            )}
          </nav>

          <div className="hidden lg:flex items-center gap-3">
            <button
              onClick={() => setLang(lang === 'en' ? 'sw' : 'en')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-muted-text hover:text-brand-dark-text transition-colors cursor-pointer rounded-md"
              aria-label={t.langToggle}
            >
              <Globe size={15} />
              <span>{lang === 'en' ? 'SW' : 'EN'}</span>
            </button>
            <div className="h-5 w-px bg-brand-border" />
            {token ? (
              <button
                onClick={logout}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-muted-text hover:text-accent-orange transition-colors cursor-pointer rounded-md"
              >
                <LogOut size={15} />
                <span>{t.logout}</span>
              </button>
            ) : (
              <div className="flex items-center gap-1.5 px-2 py-1.5 text-sm font-medium text-brand-muted-text">
                <User size={15} />
                <span>{lang === 'en' ? 'Guest' : 'Mgeni'}</span>
              </div>
            )}
          </div>

          <div className="flex lg:hidden items-center gap-2">
            <button
              onClick={() => setLang(lang === 'en' ? 'sw' : 'en')}
              className="flex items-center gap-1 px-2.5 py-1.5 text-sm font-medium text-brand-muted-text hover:text-brand-dark-text transition-colors cursor-pointer rounded-md"
              aria-label={t.langToggle}
            >
              <Globe size={15} />
              <span>{lang === 'en' ? 'SW' : 'EN'}</span>
            </button>
            <button
              onClick={() => setIsOpen(true)}
              className="p-2 rounded-md text-brand-dark-text hover:text-primary-green transition-colors cursor-pointer"
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
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
              className="fixed inset-0 bg-black/40 z-40 lg:hidden"
            />

            {/* Side Drawer Menu */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 h-full w-[290px] sm:w-[340px] bg-white shadow-2xl z-50 flex flex-col border-l border-brand-border lg:hidden"
            >
              {/* Drawer Header */}
              <div className="p-5 border-b border-brand-border flex items-center justify-between bg-brand-light-gray/30">
                <img 
                  src="/assets/logo_wordmark_transparent.png" 
                  alt="Return4me Logo" 
                  className="h-10 w-auto object-contain"
                  referrerPolicy="no-referrer"
                />
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-2 rounded-lg bg-white border border-brand-border text-brand-muted-text hover:text-primary-green hover:shadow-xs transition-all cursor-pointer"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Drawer Links */}
              <div className="flex-1 overflow-y-auto p-5 space-y-5">
                <div className="space-y-1.5">
                  <p className="text-xs font-bold text-brand-muted-text uppercase tracking-widest px-3 mb-2">
                    {lang === 'en' ? 'Main Menu' : 'Menyu Kuu'}
                  </p>
                  
                  {/* Home */}
                  <button
                    onClick={() => handleNavClick('home')}
                    className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left cursor-pointer ${
                      currentView === 'home' 
                        ? 'bg-primary-green/10 text-primary-green' 
                        : 'text-brand-dark-text hover:bg-brand-light-gray'
                    }`}
                  >
                    <Home size={18} />
                    <span>{lang === 'en' ? 'Home' : 'Ukurasa wa Kwanza'}</span>
                  </button>

                  {/* Owner (Lost) */}
                  <button
                    onClick={() => handleNavClick('owner')}
                    className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left cursor-pointer ${
                      currentView === 'owner' 
                        ? 'bg-primary-green/10 text-primary-green' 
                        : 'text-brand-dark-text hover:bg-brand-light-gray'
                    }`}
                  >
                    <Search size={18} />
                    <span>{t.ownerBtn}</span>
                  </button>

                  {/* Finder (Found) */}
                  <button
                    onClick={() => handleNavClick('finder')}
                    className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left cursor-pointer ${
                      currentView === 'finder' 
                        ? 'bg-primary-green/10 text-primary-green' 
                        : 'text-brand-dark-text hover:bg-brand-light-gray'
                    }`}
                  >
                    <MapPin size={18} />
                    <span>{t.finderBtn}</span>
                  </button>

                  {/* Agent Portal */}
                  <button
                    onClick={() => handleNavClick('agent')}
                    className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left cursor-pointer ${
                      currentView === 'agent' 
                        ? 'bg-primary-green/10 text-primary-green' 
                        : 'text-brand-dark-text hover:bg-brand-light-gray'
                    }`}
                  >
                    <Globe size={18} />
                    <span>{t.agentBtn}</span>
                  </button>


                </div>

                {/* System Pages */}
                <div className="space-y-1.5 pt-4 border-t border-brand-border/60">
                  <p className="text-xs font-bold text-brand-muted-text uppercase tracking-widest px-3 mb-2">
                    {lang === 'en' ? 'Legals & Info' : 'Sheria na Taarifa'}
                  </p>
                  
                  {/* Terms */}
                  <button
                    onClick={() => handleNavClick('terms')}
                    className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left cursor-pointer ${
                      currentView === 'terms' 
                        ? 'bg-primary-green/10 text-primary-green' 
                        : 'text-brand-dark-text hover:bg-brand-light-gray'
                    }`}
                  >
                    <span>{lang === 'en' ? 'Terms of Service' : 'Masharti ya Matumizi'}</span>
                  </button>

                  {/* Privacy */}
                  <button
                    onClick={() => handleNavClick('privacy')}
                    className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left cursor-pointer ${
                      currentView === 'privacy' 
                        ? 'bg-primary-green/10 text-primary-green' 
                        : 'text-brand-dark-text hover:bg-brand-light-gray'
                    }`}
                  >
                    <span>{lang === 'en' ? 'Privacy Policy' : 'Sera ya Faragha'}</span>
                  </button>
                </div>
              </div>

              {/* Drawer Footer Controls */}
              <div className="p-5 border-t border-brand-border bg-brand-light-gray/30 space-y-4">
                {/* Localized Language Selector */}
                <div>
                  <label className="block text-xs font-bold text-brand-muted-text uppercase tracking-widest mb-2 px-1">
                    {lang === 'en' ? 'Select Language' : 'Chagua Lugha'}
                  </label>
                  <div className="grid grid-cols-2 bg-white border border-brand-border p-1 rounded-xl text-xs font-bold shadow-xs">
                    <button
                      onClick={() => setLang('en')}
                      className={`py-2 rounded-lg transition-all cursor-pointer text-center uppercase tracking-wide ${
                        lang === 'en' ? 'bg-primary-green text-white shadow-sm' : 'text-brand-muted-text hover:text-brand-dark-text'
                      }`}
                    >
                      ENGLISH
                    </button>
                    <button
                      onClick={() => setLang('sw')}
                      className={`py-2 rounded-lg transition-all cursor-pointer text-center uppercase tracking-wide ${
                        lang === 'sw' ? 'bg-primary-green text-white shadow-sm' : 'text-brand-muted-text hover:text-brand-dark-text'
                      }`}
                    >
                      KISWAHILI
                    </button>
                  </div>
                </div>

                {/* Account Actions */}
                {token ? (
                  <button
                    onClick={() => {
                      logout();
                      setIsOpen(false);
                    }}
                    className="w-full bg-accent-orange hover:bg-accent-hover text-white text-xs font-bold py-3.5 rounded-xl shadow-md shadow-orange-500/10 transition-all cursor-pointer flex items-center justify-center space-x-2"
                  >
                    <LogOut size={14} />
                    <span>{t.logout}</span>
                  </button>
                ) : (
                  <div className="py-2.5 px-3 bg-white border border-brand-border rounded-xl flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <div className="w-8 h-8 rounded-full bg-brand-light-gray flex items-center justify-center text-accent-orange">
                        <User size={14} />
                      </div>
                      <span className="text-xs font-bold text-brand-dark-text">
                        {lang === 'en' ? 'Guest Account' : 'Akaunti ya Mgeni'}
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
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-brand-border z-30 py-2 px-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex justify-around items-center shadow-[0_-4px_12px_rgba(0,0,0,0.05)]">
        <button
          onClick={() => handleNavClick('home')}
          className={`flex flex-col items-center justify-center space-y-0.5 cursor-pointer flex-1 py-1 transition-all ${
            currentView === 'home' ? 'text-primary-green' : 'text-brand-muted-text'
          }`}
        >
          <Home size={18} />
          <span className="text-xs font-semibold">{lang === 'sw' ? 'Mwanzo' : 'Home'}</span>
        </button>
        <button
          onClick={() => handleNavClick('owner')}
          className={`flex flex-col items-center justify-center space-y-0.5 cursor-pointer flex-1 py-1 transition-all ${
            currentView === 'owner' ? 'text-primary-green' : 'text-brand-muted-text'
          }`}
        >
          <Search size={18} />
          <span className="text-xs font-semibold">{lang === 'sw' ? 'Tafuta' : 'Search'}</span>
        </button>
        <button
          onClick={() => handleNavClick('finder')}
          className={`flex flex-col items-center justify-center space-y-0.5 cursor-pointer flex-1 py-1 transition-all ${
            currentView === 'finder' ? 'text-primary-green' : 'text-brand-muted-text'
          }`}
        >
          <MapPin size={18} />
          <span className="text-xs font-semibold">{lang === 'sw' ? 'Ripoti' : 'Report'}</span>
        </button>
        <button
          onClick={() => handleNavClick('agent')}
          className={`flex flex-col items-center justify-center space-y-0.5 cursor-pointer flex-1 py-1 transition-all ${
            currentView === 'agent' ? 'text-primary-green' : 'text-brand-muted-text'
          }`}
        >
          <Globe size={18} />
          <span className="text-xs font-semibold">{lang === 'sw' ? 'Wakala' : 'Agent'}</span>
        </button>
        <button
          onClick={() => setIsOpen(true)}
          className={`flex flex-col items-center justify-center space-y-0.5 cursor-pointer flex-1 py-1 transition-all ${
            isOpen ? 'text-primary-green' : 'text-brand-muted-text'
          }`}
        >
          <Menu size={18} />
          <span className="text-xs font-semibold">{lang === 'sw' ? 'Zaidi' : 'More'}</span>
        </button>
      </div>
    </>
  );
}
