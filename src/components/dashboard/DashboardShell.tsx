import React from 'react';
import { Globe, LogOut, ExternalLink, LayoutDashboard, User, ShieldCheck, Store } from 'lucide-react';
// BATCH 2 (shell polish) — the shell's own controls now use the shared design
// system instead of hand-rolled hover/focus styling. Presentation only: every
// handler, label and aria attribute below is unchanged, and this component
// still owns no session, token or network logic whatsoever.
import Button from '../ui/Button';

// ============================================================================
// AUTHENTICATED DASHBOARD SHELL  (Part B — dashboard shell separation)
// ============================================================================
// WHY THIS EXISTS
//   Before this, App.tsx rendered ONE shell for the entire app: the public
//   <Navbar> + <main> + public <footer>. Every authenticated surface
//   (/account, /agent_portal, /console) rendered *inside* that public shell, so
//   a signed-in user working in a dashboard was still shown the public
//   destinations (Home · I Lost Something · I Found Something · Become an
//   Agent · Sign In) and the fixed mobile bottom tab bar — as if they were
//   browsing the public website.
//
//   Earlier work (Phase 11B) only made that public bar SESSION-AWARE (it now
//   shows "My Account" and a sign-out control once a session exists). It never
//   created a boundary, so the public chrome was still mounted on dashboards.
//   A session-aware public bar is still a PUBLIC bar.
//
// WHAT THIS IS
//   A separate shell for authenticated work: its own header, its own identity,
//   its own language control and its own way back to the public site. The
//   public Navbar is NOT RENDERED on these surfaces — it is not mounted at all,
//   rather than hidden with CSS, so none of its destinations, handlers or the
//   mobile tab bar exist while someone is inside a dashboard.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   - No authentication logic. It receives a label and two callbacks; App owns
//     every session, token and sign-out decision.
//   - No public destinations. Going back to the public site is an explicit,
//     labelled action, not a re-creation of the public bar.
//   - No second navigation system: the surface's own sections (e.g. AdminView's
//     existing admin nav) stay exactly where they are.
// ============================================================================

export type DashboardSurface = 'account' | 'agent' | 'admin';

interface DashboardShellProps {
  lang: 'en' | 'sw';
  setLang: (lang: 'en' | 'sw') => void;
  /** Which authenticated surface is being worked in. Drives the label + icon. */
  surface: DashboardSurface;
  /**
   * Who is signed in, as already resolved by App (never recomputed here — this
   * shell must not become a second place that decides identity).
   */
  identityLabel?: string;
  /** Returns to the public site (home). */
  onExitSite: () => void;
  /** Ends the live session(s). App owns what that means per role. */
  onSignOut: () => void;
  children: React.ReactNode;
}

const SURFACE_COPY: Record<DashboardSurface, { en: string; sw: string }> = {
  account: { en: 'My Account', sw: 'Akaunti Yangu' },
  agent: { en: 'Agent Portal', sw: 'Lango la Wakala' },
  admin: { en: 'Admin Console', sw: 'Konsoli ya Msimamizi' },
};

function SurfaceIcon({ surface }: { surface: DashboardSurface }) {
  if (surface === 'admin') return <ShieldCheck size={16} aria-hidden="true" />;
  if (surface === 'agent') return <Store size={16} aria-hidden="true" />;
  return <LayoutDashboard size={16} aria-hidden="true" />;
}

export default function DashboardShell({
  lang,
  setLang,
  surface,
  identityLabel,
  onExitSite,
  onSignOut,
  children,
}: DashboardShellProps) {
  const copy = SURFACE_COPY[surface];
  const label = lang === 'en' ? copy.en : copy.sw;

  return (
    <div className="min-h-screen bg-brand-light-gray flex flex-col antialiased">
      {/* Dashboard header — a dark brand band (not the public bar), so the
          change of context is unmistakable. */}
      <header className="bg-primary-green text-white shadow-sm">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-3 min-h-[60px] py-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/15">
                <SurfaceIcon surface={surface} />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-extrabold leading-tight truncate">{label}</p>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-white/70">
                  Return4me
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-1.5 sm:gap-2 flex-wrap">
              {identityLabel && (
                <span
                  className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-bold max-w-[220px]"
                  title={identityLabel}
                >
                  <User size={12} aria-hidden="true" />
                  <span className="truncate">{identityLabel}</span>
                </span>
              )}

              {/* Language — the same two-language contract as the public site.
                  `inverse` is the design system's dark-surface variant, so these
                  controls no longer hand-roll their dark styling. size="md"
                  keeps the previous 44px touch-target floor. */}
              <Button
                variant="inverse"
                size="md"
                onClick={() => setLang(lang === 'en' ? 'sw' : 'en')}
                aria-label={lang === 'en' ? 'Badilisha lugha' : 'Switch language'}
              >
                <Globe size={14} aria-hidden="true" />
                <span className="uppercase">{lang === 'en' ? 'SW' : 'EN'}</span>
              </Button>

              {/* Back to the public site — explicit, never an implicit bar. */}
              <Button
                variant="inverse"
                size="md"
                onClick={onExitSite}
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span className="hidden sm:inline">{lang === 'en' ? 'View site' : 'Tovuti'}</span>
              </Button>

              {/* Ends the live session. Still presentation only — the handler is
                  App's; this shell owns no session logic of its own. */}
              <Button
                variant="inverse"
                size="md"
                onClick={onSignOut}
              >
                <LogOut size={14} aria-hidden="true" />
                <span>{lang === 'en' ? 'Sign out' : 'Toka'}</span>
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Workspace — the surface renders its OWN sections/nav in here. */}
      <main className="flex-grow w-full mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
        {children}
      </main>

      <footer className="border-t border-brand-border bg-white">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-4">
          <p className="text-[11px] text-brand-muted-text">
            {lang === 'en'
              ? 'You are signed in. Dashboard actions are recorded against your session.'
              : 'Umeingia. Vitendo vya dashibodi hurekodiwa dhidi ya kipindi chako.'}
          </p>
        </div>
      </footer>
    </div>
  );
}
