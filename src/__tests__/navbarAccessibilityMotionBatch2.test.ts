// RETURN4ME NAVBAR BATCH 2 - accessibility + motion polish.
//
// Four targeted corrections:
//   A. the logo was a `div role="button"` with a hand-rolled Enter/Space keydown
//      handler; it is now a native <button> (Return4me navigates by App-owned
//      view state, not URL, so a real <a href> would point nowhere).
//   B. the active public destination was conveyed only by colour + underline, so
//      assistive technology could not tell where the visitor was. Each
//      destination now carries aria-current="page" exactly like AdminView's tabs
//      and CustomerDashboard already do.
//   C. the drawer slide + scrim fade + nav underline now honour a reduced-motion
//      preference via useReducedMotion() from the motion library already in use.
//   D. the scrim keeps its literal: no suitable existing semantic token exists.
//
// Source-contract tests, matching the repository's established strategy for this
// surface (navbarControlVisibilityBatch1, languageControlBatchC, appearanceControlBatchE).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

const NAVBAR = read('components/Navbar.tsx');
// Strip comments so an assertion cannot be satisfied by prose.
const code = NAVBAR.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('NAVBAR BATCH 2 - accessibility + motion polish', () => {
  // ------------------------------------------------------------ A. logo control
  it('renders the logo as a native button, not a div role="button"', () => {
    expect(code).not.toMatch(/<div[^>]*role="button"/);
    expect(code).toMatch(/<button\s+type="button"\s+className="shrink-0 flex items-center/);
  });

  it('keeps the logo on the Home destination with its accessible name', () => {
    const start = code.indexOf('className="shrink-0 flex items-center rounded-small');
    expect(start).toBeGreaterThan(-1);
    const logo = code.slice(start - 120, code.indexOf('</button>', start));
    expect(logo).toContain("handleNavClick('home')");
    expect(logo).toContain('aria-label=');
  });

  it('drops the manual tabIndex and keydown emulation it no longer needs', () => {
    const start = code.indexOf('className="shrink-0 flex items-center rounded-small');
    const logo = code.slice(start - 120, code.indexOf('</button>', start));
    // Native buttons are focusable and activate on Enter/Space already.
    expect(logo).not.toContain('tabIndex');
    expect(logo).not.toContain('onKeyDown');
    expect(code).not.toMatch(/role="button"/);
  });

  // --------------------------------------------------------------- B. aria-current
  it('marks every main public destination with a current-view-aware aria-current', () => {
    for (const view of ['home', 'owner', 'finder', 'becomeAgent', 'admin']) {
      expect(code).toContain(
        `aria-current={currentView === '${view}' ? 'page' : undefined}`
      );
    }
  });

  it('never hardcodes aria-current to always-on for a destination', () => {
    // Inactive destinations must not claim to be the current page, so every
    // main-nav aria-current has to be conditional.
    const unconditional = code.match(/aria-current="page"/g) || [];
    expect(unconditional).toHaveLength(0);
  });

  it('keeps the five-item public IA and still gates the admin item', () => {
    // UX-02: the desktop link group is `hidden xl:flex` now (the full row moved
    // to the width where it fits the page grid); the group's CONTENTS — the four
    // public destinations plus the session-gated admin item — are what this
    // assertion protects and they are unchanged.
    const nav = code.slice(code.indexOf('<nav className="hidden xl:flex'), code.indexOf('</nav>'));
    expect(nav).toContain("handleNavClick('home')");
    expect(nav).toContain("handleNavClick('owner')");
    expect(nav).toContain("handleNavClick('finder')");
    expect(nav).toContain("handleNavClick('becomeAgent')");
    // Agent Portal remains absent from public navigation.
    expect(nav).not.toContain('Agent Portal');
    // The admin destination stays conditional on the admin session.
    expect(nav).toMatch(/\{isAdmin && \([\s\S]*?handleNavClick\('admin'\)/);
  });

  it('extends aria-current to the drawer and the bottom tab bar', () => {
    // The drawer and the tabs are the same destinations at other widths, so the
    // active state must be announced there too.
    const drawer = code.slice(code.indexOf('<AnimatePresence>'));
    expect(drawer).toContain("aria-current={currentView === 'home' ? 'page' : undefined}");
    expect(drawer).toContain("aria-current={currentView === 'owner' ? 'page' : undefined}");
    expect(drawer).toContain("aria-current={currentView === 'finder' ? 'page' : undefined}");
    // The tab bar is identified by its rendered container class, not by the JSX
    // comment above it (comments are stripped from `code`).
    const tabsStart = code.indexOf('md:hidden fixed bottom-0');
    expect(tabsStart).toBeGreaterThan(-1);
    const tabs = code.slice(tabsStart);
    expect(tabs).toContain("aria-current={currentView === 'home' ? 'page' : undefined}");
    expect(tabs).toContain("aria-current={currentView === 'owner' ? 'page' : undefined}");
    expect(tabs).toContain("aria-current={currentView === 'finder' ? 'page' : undefined}");
  });

  // --------------------------------------------------------- C. reduced motion
  it('derives reduced motion from the animation library already in use', () => {
    expect(code).toContain("import { motion, AnimatePresence, useReducedMotion } from 'motion/react'");
    expect(code).toMatch(/const prefersReducedMotion = useReducedMotion\(\)/);
  });

  it('removes the drawer slide and scrim fade under reduced motion', () => {
    // The scrim fades and the panel slides by default; both collapse to an
    // instant resolve when motion is reduced.
    expect(code).toMatch(/transition=\{prefersReducedMotion \? \{ duration: 0 \} : \{ duration: 0\.2 \}\}/);
    expect(code).toMatch(
      /transition=\{prefersReducedMotion \? \{ duration: 0 \} : \{ type: 'spring', damping: 25, stiffness: 200 \}\}/
    );
  });

  it('removes the nav underline spring under reduced motion but keeps it otherwise', () => {
    expect(code).toMatch(/const navUnderlineTransition = prefersReducedMotion/);
    expect(code).toMatch(/\? \{ duration: 0 \}/);
    expect(code).toContain(": { type: 'spring' as const, stiffness: 300, damping: 30 };");
    // Both underline instances read the shared transition.
    expect((code.match(/transition=\{navUnderlineTransition\}/g) || [])).toHaveLength(2);
  });

  it('keeps the drawer fully functional, not merely animated differently', () => {
    const drawer = code.slice(code.indexOf('<AnimatePresence>'));
    // The drawer is still presentational motion, not a state rewrite: it keeps
    // its open/close handlers, breakpoints and panel identity.
    expect(drawer).toContain('onClick={() => setIsOpen(false)}');
    expect(drawer).toContain('AnimatePresence');
    expect(drawer).toContain("initial={{ x: '100%' }}");
    // UX-02: the drawer/scrim pair is `xl:hidden` now, matching the compact
    // header it belongs to (see navbarControlVisibilityBatch1's paired gate).
    expect(drawer).toContain('xl:hidden');
    expect(code).toContain('setIsOpen(true)');
  });

  it('does not disable the drawer animation for everyone', () => {
    // The default (non-reduced) spring transition must remain present.
    expect(code).toMatch(/\{ type: 'spring', damping: 25, stiffness: 200 \}/);
  });

  // ------------------------------------------------------------------ D. scrim
  it('leaves the scrim literal unchanged because no suitable token exists', () => {
    // The repository has no semantic scrim/overlay token; `bg-black/40` is
    // retained rather than inventing a token purely to remove a literal.
    expect(code).toContain('bg-black/40');
  });
});

