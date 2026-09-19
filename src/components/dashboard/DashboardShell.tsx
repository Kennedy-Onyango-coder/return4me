import React from 'react';
import { Globe, LogOut, ExternalLink, User } from 'lucide-react';
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

// PHASE 16 — the generic per-role Lucide glyph that used to head this band
// (LayoutDashboard / Store / ShieldCheck) is gone: the header now carries the
// product's own approved wordmark (see the header markup below), so the
// authenticated workspace reads as Return4me rather than as a generic dashboard
// template. Nothing about the surface's identity logic changed — SURFACE_COPY
// above still names it, and App still owns WHO is signed in.

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
          change of context is unmistakable. PHASE 16: full-bleed, because an
          authenticated workspace is an operations surface rather than a
          marketing page — it uses the whole viewport instead of a centred
          1280px column, with gutters that grow with the screen
          (px-4 → sm:px-6 → lg:px-10). */}
      <header className="bg-primary-green text-white shadow-sm">
        <div className="w-full px-4 sm:px-6 lg:px-10">
          <div className="flex items-center justify-between gap-3 min-h-[64px] py-2">
            <div className="flex items-center gap-3 min-w-0">
              {/* PHASE 16 — OFFICIAL BRANDING. This band used to introduce the
                  workspace with a generic Lucide role icon (LayoutDashboard /
                  Store / ShieldCheck), which made a signed-in Return4me
                  workspace read like a generic dashboard template. It now
                  carries the product's own approved wordmark — the SAME
                  /assets/logo_wordmark_transparent.png the public Navbar
                  renders, undistorted (h-6, w-auto, object-contain) on a white
                  plate so it keeps its contrast against the dark brand band.
                  No replacement, redrawn or generated logo is introduced. The
                  surface name stays in words beside it, so the role is never
                  conveyed by imagery alone. */}
              <span className="flex h-9 shrink-0 items-center rounded-lg bg-white px-2">
                <img
                  src="/assets/logo_wordmark_transparent.png"
                  alt="Return4me"
                  className="h-6 w-auto object-contain"
                  referrerPolicy="no-referrer"
                />
              </span>
              <p className="min-w-0 truncate text-sm font-extrabold leading-tight">{label}</p>
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

      {/* Workspace — the surface renders its OWN sections/nav in here. PHASE 16:
          full width, so a dense admin/agent table or a multi-column dashboard
          band is not squeezed into a centred column. Each surface keeps its own
          INTERNAL max-widths where a form or a reading block needs one — the
          canvas is wide, the content is not stretched. */}
      <main className="flex-grow w-full px-4 sm:px-6 lg:px-10 py-6">
        {children}
      </main>

      <footer className="border-t border-brand-border bg-white">
        <div className="w-full px-4 sm:px-6 lg:px-10 py-4">
          <p className="text-caption text-brand-muted-text">
            {lang === 'en'
              ? 'You are signed in. Dashboard actions are recorded against your session.'
              : 'Umeingia. Vitendo vya dashibodi hurekodiwa dhidi ya kipindi chako.'}
          </p>
        </div>
      </footer>
    </div>
  );
}
