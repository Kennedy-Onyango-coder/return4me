import React from 'react';
import { LogOut, ExternalLink, User } from 'lucide-react';
// BATCH 2 (shell polish) — the shell's other controls use the shared design
// system. Batch C routes the language control through the neutral presentation
// primitive while this component continues to own no session, token, persistence,
// or network logic whatsoever.
import LanguageControl from '../LanguageControl';
import AppearanceControl from '../AppearanceControl';
import type { AppearancePreference } from '../../utils/appearancePreference';
import { translations } from '../../types';
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
  appearance: AppearancePreference;
  setAppearance: (appearance: AppearancePreference) => void;
  /** Which authenticated surface is being worked in. Drives the label + icon. */
  surface: DashboardSurface;
  /**
   * Who is signed in, as already resolved by App (never recomputed here — this
   * shell must not become a second place that decides identity).
   */
  identityLabel?: string;
  /**
   * Whether a live session actually backs this surface. Defaults to true
   * because the agent and admin dashboards only mount once a token exists.
   *
   * PHASE 16 — /account is the one surface that is ALWAYS the account surface,
   * authenticated or not (App's boundary is decided by the surface, not by a
   * session, so the gate can render inside it). Without this flag the shell told
   * a signed-OUT visitor they were signed in: an identity chip reading "My
   * Account", a working "Sign out" control, and a footer saying "You are signed
   * in". The surrounding chrome must stay truthful, so those three things are
   * now conditional. The shell still owns no session logic — App decides.
   */
  signedIn?: boolean;
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
  appearance,
  setAppearance,
  surface,
  identityLabel,
  signedIn = true,
  onExitSite,
  onSignOut,
  children,
}: DashboardShellProps) {
  const copy = SURFACE_COPY[surface];
  const label = lang === 'en' ? copy.en : copy.sw;
  const t = translations[lang];
  const appearanceLabels = {
    appearance: t.appearanceLabel,
    light: t.appearanceLight,
    dark: t.appearanceDark,
    system: t.appearanceSystem,
  };

  return (
    <div className="min-h-screen bg-[var(--appearance-background)] text-[var(--appearance-text-primary)] flex flex-col antialiased">
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

              {/* Language — App-owned, presented through the same shared control as
                  the public shell. `inverse` preserves this header's dark-surface
                  treatment while naming both current and target languages. */}
              <LanguageControl
                lang={lang}
                setLang={setLang}
                layout="toggle"
                toggleLabel={lang === 'en' ? 'Switch language' : 'Badilisha lugha'}
                theme="inverse"
              />
              <AppearanceControl value={appearance} onChange={setAppearance} labels={appearanceLabels} />

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
                  App's; this shell owns no session logic of its own. Not rendered
                  when there is no live session to end (PHASE 16 — the signed-out
                  /account gate must not advertise a session that does not exist). */}
              {signedIn && (
              <Button
                variant="inverse"
                size="md"
                onClick={onSignOut}
              >
                <LogOut size={14} aria-hidden="true" />
                <span>{lang === 'en' ? 'Sign out' : 'Toka'}</span>
              </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Workspace — the surface renders its OWN sections/nav in here. PHASE 16:
          full width, so a dense admin/agent table or a multi-column dashboard
          band is not squeezed into a centred column. Each surface keeps its own
          INTERNAL max-widths where a form or a reading block needs one — the
          canvas is wide, the content is not stretched. */}
      <main className="flex-grow w-full px-4 sm:px-6 lg:px-10 py-6 text-[var(--appearance-text-primary)]">
        {children}
      </main>

      <footer className="border-t border-[var(--appearance-border)] bg-[var(--appearance-surface)]">
        <div className="w-full px-4 sm:px-6 lg:px-10 py-4">
          <p className="text-caption text-[var(--appearance-text-muted)]">
            {signedIn
              ? (lang === 'en'
                  ? 'You are signed in. Dashboard actions are recorded against your session.'
                  : 'Umeingia. Vitendo vya dashibodi hurekodiwa dhidi ya kipindi chako.')
              : (lang === 'en'
                  ? 'You are not signed in. Nothing on this page is private, and signing in is what unlocks your account.'
                  : 'Hujaingia. Hakuna kilicho cha faragha kwenye ukurasa huu, na kuingia ndiyo kunafungua akaunti yako.')}
          </p>
        </div>
      </footer>
    </div>
  );
}
