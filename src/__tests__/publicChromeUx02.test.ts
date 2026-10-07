// =============================================================================
// RETURN4ME UX-02 — PUBLIC NAVIGATION & GLOBAL CHROME
// =============================================================================
//
// This is the contract suite for the UX-02 batch: the public Navbar, its
// responsive behaviour, its utility controls, its active-route signalling, its
// keyboard behaviour, and the authenticated/public boundary it must not cross.
//
// WHY SOURCE-LEVEL: this repository has no DOM/React harness (no jsdom, no React
// Testing Library), so — exactly like publicNavigation.test.ts,
// navbarControlVisibilityBatch1/2, navbarSessionState and dashboardShellBoundary
// — the contracts are asserted against the real source, with comments stripped so
// an assertion can never be satisfied by prose. Each assertion below fails if the
// specific UX-02 contract it names is removed (verified by mutating the source).
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const navbarTsx = read('src/components/Navbar.tsx');
const navbar = stripComments(navbarTsx);
const appearanceControl = stripComments(read('src/components/AppearanceControl.tsx'));
const appTsx = read('src/App.tsx');
const appCode = stripComments(appTsx);
const homeView = read('src/components/HomeView.tsx');
const indexCss = read('src/index.css');

// Slice once, and bind each assertion to the surface it is about. `bound` fails
// loudly if an anchor ever disappears, so an empty slice can never make a test
// vacuous.
function bound(source: string, from: string, to: string, name: string): string {
  const start = source.indexOf(from);
  expect(start, `${name}: anchor "${from}" must exist`).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  expect(end, `${name}: end anchor "${to}" must exist after "${from}"`).toBeGreaterThan(start);
  const slice = source.slice(start, end);
  expect(slice.length, `${name}: slice must not be empty`).toBeGreaterThan(0);
  return slice;
}

const header = bound(navbar, '<header', '</header>', 'header');
const desktopNav = bound(navbar, '<nav ', '</nav>', 'desktop nav');
const compactHeader = bound(navbar, 'flex xl:hidden items-center gap-1', '</header>', 'compact header');
const drawer = bound(navbar, '<AnimatePresence>', 'md:hidden fixed bottom-0', 'drawer');
const tabBar = bound(navbar, 'md:hidden fixed bottom-0', '</>', 'tab bar');

describe('UX-02 public navigation (locked information architecture)', () => {
  it('exposes the four public destinations on desktop and routes Sign In through the chooser', () => {
    // Home · I Lost Something · I Found Something · Become an Agent
    expect(desktopNav).toContain("handleNavClick('home')");
    expect(desktopNav).toContain("handleNavClick('owner')");
    expect(desktopNav).toContain("handleNavClick('finder')");
    expect(desktopNav).toContain("handleNavClick('becomeAgent')");
    expect(desktopNav).toContain('t.ownerBtn');
    expect(desktopNav).toContain('t.finderBtn');
    expect(desktopNav).toContain('t.becomeAgentBtn');
    // Sign In sits in the header (after the utilities), not inside the link group.
    expect(header).toContain("handleNavClick('signin')");
    expect(header).toContain('accountControlLabel');
  });

  it('never exposes the Agent Portal, Admin, Dashboard or Claims as a public destination', () => {
    expect(navbar).not.toMatch(/t\.agentBtn/);
    expect(navbar).not.toMatch(/handleNavClick\('agent'\)/);
    expect(navbar).not.toMatch(/Agent Portal/);
    expect(navbar).not.toMatch(/handleNavClick\('(dashboard|claims|console)'\)/);
    // The ONE admin binding that exists is session-gated: it appears only after
    // `{isAdmin && (` (which itself reads a live admin token), so it is never
    // part of the signed-out public destinations.
    expect((navbar.match(/handleNavClick\('admin'\)/g) || [])).toHaveLength(1);
    expect(desktopNav).toMatch(/\{isAdmin && \([\s\S]*handleNavClick\('admin'\)/);
    expect(desktopNav).not.toMatch(/handleNavClick\('admin'\)[\s\S]*\{isAdmin && \(/);
    // ...and it is reached only through a live admin token, still read from the
    // single App-owned session the bar already had.
    expect(navbar).toContain("localStorage.getItem('admin_token')");
  });

  it('keeps Sign In available in every surface: desktop, drawer and bottom tab bar', () => {
    const signInBindings = navbar.match(/handleNavClick\('signin'\)/g) || [];
    expect(signInBindings.length).toBeGreaterThanOrEqual(3);
    expect(drawer).toContain("handleNavClick('signin')");
    expect(tabBar).toContain("handleNavClick('signin')");
    // Sign In's label comes from the one App-owned source in every surface, so a
    // signed-in customer reads "My Account" and never "Sign In".
    expect(drawer).toContain('{accountControlLabel}');
    expect(tabBar).toContain('t.signInBtn');
    expect(compactHeader).toContain('setIsOpen(true)');
  });

  it('keeps the appearance control reachable in the tray, the compact header and the drawer', () => {
    // The shared appearance control, three instances, on the App-owned props.
    expect((navbar.match(/<LanguageControl /g) || [])).toHaveLength(0);
    expect((navbar.match(/<AppearanceControl /g) || [])).toHaveLength(3);
    expect(drawer).toContain('fullWidth');
    expect((navbar.match(/value=\{appearance\} onChange=\{setAppearance\}/g) || [])).toHaveLength(3);
    // No local state, no second source of truth for the preference.
    expect(navbar).not.toMatch(/useState[^;]*(?:lang|language|appearance|theme)/i);
    expect(appearanceControl).not.toMatch(/useState|localStorage|matchMedia/);
    // The option set is untouched by this batch.
    for (const value of ['light', 'dark', 'system']) {
      expect(appearanceControl).toContain(`<option value="${value}">`);
    }
  });

  it('orders the header exactly like the locked IA: destinations, utilities, Sign In', () => {
    const destinationsEnd = header.indexOf('</nav>');
    const trayIndex = header.indexOf('<AppearanceControl');
    const signInIndex = header.indexOf("handleNavClick('signin')");
    expect(destinationsEnd).toBeGreaterThan(-1);
    expect(trayIndex).toBeGreaterThan(destinationsEnd);
    expect(signInIndex).toBeGreaterThan(trayIndex);
  });
});

describe('UX-02 Sign In treatment (shared Button, not a second button system)', () => {
  it('renders Sign In with the shared Button primitive at the standard size', () => {
    expect(navbarTsx).toContain("import Button from './ui/Button'");
    expect(header).toContain('<Button');
    expect(header).toContain('variant="primary"');
    expect(header).toContain('size="md"');
    expect(drawer).toContain('<Button');
    // The hand-rolled declaration this batch deleted must not come back.
    expect(navbar).not.toContain('signInButtonClass');
    expect(navbar).not.toContain('signIn:hover:border');
    // Its label still comes from the one App-owned source, so a signed-in
    // customer reads "My Account" and never "Sign In".
    expect(navbar).toMatch(/isAccountView \? \('My Account'\)/);
  });

  it('keeps the account state a quiet link, not a button (a destination is not an action)', () => {
    expect(navbar).toContain('accountLinkClass');
    expect(header).toMatch(/isAccountView \|\| accountSignedIn \?/);
    expect(header).toContain('handleAccountClick');
    // Phase 16 survives: a token-only operator session is never offered Sign In.
    expect((navbar.match(/!isTokenOnlySession &&/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('UX-02 active route (never colour alone, never stale)', () => {
  it('marks the current destination with a conditional aria-current in every surface', () => {
    for (const view of ['home', 'owner', 'finder', 'becomeAgent']) {
      // Scoped per surface: the desktop group, the drawer and the tab bar each
      // have to carry it themselves, so removing it from ONE surface fails here.
      expect(desktopNav, `desktop ${view}`).toContain(
        `aria-current={currentView === '${view}' ? 'page' : undefined}`
      );
      expect(drawer, `drawer ${view}`).toContain(
        `aria-current={currentView === '${view}' ? 'page' : undefined}`
      );
    }
    for (const view of ['home', 'owner', 'finder']) {
      expect(tabBar, `tab ${view}`).toContain(
        `aria-current={currentView === '${view}' ? 'page' : undefined}`
      );
    }
    // Sign In advertises "current" only when the visitor is actually there.
    expect(navbar).toMatch(/aria-current=\{currentView === 'signin' \? 'page' : undefined\}/);
    // Inactive destinations never claim to be current.
    expect(navbar).not.toMatch(/aria-current="page"/);
    expect(drawer).not.toMatch(/aria-current="page"/);
    expect(tabBar).not.toMatch(/aria-current="page"/);
  });

  it('carries the active state with weight + tint + underline, not colour alone', () => {
    // Active link: tinted surface, stronger weight, semantic ink (theme-aware).
    expect(navbar).toMatch(
      /bg-\[var\(--appearance-surface-muted\)\] font-semibold text-\[var\(--appearance-primary\)\]/
    );
    // ...and the moving underline indicator.
    expect(navbar).toContain('layoutId="nav-underline"');
    expect(navbar).toContain('bg-[var(--appearance-primary)]');
    // The active language is weight + tint + ink in the drawer and the tab bar too.
    expect(drawer).toContain('font-bold text-[var(--appearance-primary)]');
    expect(tabBar).toContain("? 'bg-[var(--appearance-surface-muted)] font-bold text-[var(--appearance-primary)]'");
  });

  it('uses theme-aware tokens, never the raw brand constant, for every nav state', () => {
    // The dark theme redefines the plain brand green as a DARK green, so a raw
    // `text-primary-green` / `bg-primary-green` link would be dark-on-dark. Every
    // nav state now resolves through the semantic appearance tokens instead.
    expect(navbar).not.toMatch(/primary-green/);
    expect(navbar).toContain('text-[var(--appearance-primary)]');
    expect(navbar).toContain('bg-[var(--appearance-primary)]');
    // The selected language in the drawer uses the matching foreground token, so
    // the pill inverts correctly in the dark theme too.
    expect(indexCss).toMatch(/--appearance-primary:/);
    expect(indexCss).toMatch(/--appearance-primary-foreground:/);
  });
});

describe('UX-02 responsive navigation (measured breakpoint, paired gates)', () => {
  it('renders the full desktop row and the compact fallback on the SAME breakpoint', () => {
    // Desktop row: nav + utility tray + session cluster, all gated at `xl`.
    expect(navbar).toMatch(/hidden xl:flex min-w-0 flex-1 items-center justify-center/);
    expect(navbar).toMatch(/hidden xl:flex shrink-0 items-center gap-1 rounded-standard border/);
    expect(navbar).toMatch(/hidden xl:flex shrink-0 items-center border-l[^"]*pl-2/);
    // ...and the compact header takes over exactly there.
    expect(navbar).toContain('flex xl:hidden items-center gap-1');
    // Neither surface may be gated wider than the other, or a band loses the
    // utility controls (the Batch 1 defect this batch preserves).
    expect(navbar).not.toMatch(/hidden 2xl:flex/);
    expect(navbar).not.toMatch(/2xl:hidden/);
    // The full row is text-led at ONE ladder step, with no responsive type step.
    expect(navbar).toMatch(/rounded-small px-2 text-body font-medium/);
    expect(navbar).not.toMatch(/text-\[12px\]|text-\[13px\]/);
  });

  it('hides the full link row and exposes a menu trigger below the breakpoint', () => {
    expect(compactHeader).toContain('setIsOpen(true)');
    expect(compactHeader).not.toMatch(/<LanguageControl /);
    expect(compactHeader).toMatch(/<AppearanceControl /);
    // The logo stays visible at every width (it is outside both gates).
    expect(navbar).toContain('h-10 md:h-12 xl:h-[50px]');
    // The drawer and its scrim belong to the same compact tier as the header.
    expect((navbar.match(/xl:hidden/g) || [])).toHaveLength(3);
  });

  it('sizes the header and the container from the UX-01 system, not arbitrary values', () => {
    // §12: the header shares the public page container instead of floating above it.
    expect(navbarTsx).toContain('max-w-7xl w-full mx-auto px-5 sm:px-12');
    expect(homeView).toContain('mx-auto max-w-7xl px-5 sm:px-12');
    // Height + elevation come from the spacing scale and the UX-01 elevation tokens.
    expect(navbarTsx).toContain('h-18 xl:h-19');
    expect(navbarTsx).toContain('shadow-raised');
    expect(navbarTsx).toContain('shadow-floating');
    // No arbitrary shadow survives on the chrome (the elevation tokens replace
    // them). The logo's `xl:h-[50px]` is a pinned size from Phase 8.1 and stays.
    expect(navbar).not.toMatch(/shadow-\[/);
    expect(navbar).toContain('h-18 xl:h-19 bg-[var(--appearance-surface)]');
  });
});

describe('UX-02 compact menu: behaviour, state and keyboard', () => {
  it('communicates its expanded/collapsed state and the panel it controls', () => {
    expect(compactHeader).toContain('aria-expanded={isOpen}');
    expect(compactHeader).toContain('aria-controls="public-nav-menu"');
    expect(navbar).toContain('id="public-nav-menu"');
    // The tab-bar "More" control discloses the same panel.
    expect(tabBar).toContain('aria-expanded={isOpen}');
    expect(tabBar).toContain('aria-controls="public-nav-menu"');
    // Collapsed by default, opened by the trigger, closed on every exit path.
    expect(navbar).toContain('const [isOpen, setIsOpen] = useState(false);');
    expect(navbar).toMatch(/const handleNavClick[\s\S]*?setIsOpen\(false\);/);
    expect(navbar).toMatch(/const handleAccountClick[\s\S]*?setIsOpen\(false\);/);
    expect(drawer).toMatch(/onClick=\{\(\) => setIsOpen\(false\)\}/);
    expect(drawer).toContain('setIsOpen(false)');
  });

  it('gives the trigger an accessible name and a 44px touch target', () => {
    expect(compactHeader).toContain('aria-label=');
    expect(compactHeader).toContain("aria-label={'Open menu'}");
    expect(compactHeader).toContain('h-11 w-11');
    // The drawer's own close control is a named 44px target as well.
    expect(drawer).toContain("aria-label={'Close menu'}");
    expect(drawer).toContain('h-11 w-11');
    expect(drawer).toContain('type="button"');
  });

  it('closes on Escape and returns focus to the trigger, without becoming a trap', () => {
    expect(navbar).toContain("event.key === 'Escape'");
    expect(navbar).toContain("document.addEventListener('keydown', onKeyDown)");
    expect(navbar).toContain("document.removeEventListener('keydown', onKeyDown)");
    expect(navbar).toMatch(/setIsOpen\(false\);\s*\n\s*menuTriggerRef\.current\?\.focus\(\);/);
    // The listener only exists while the panel is open.
    expect(navbar).toMatch(/if \(!isOpen\) return;/);
    // A disclosure must not silently become a modal focus trap.
    expect(navbar).not.toContain("key === 'Tab'");
    expect(navbar).not.toContain('preventDefault');
  });

  it('exposes every required destination inside the open panel', () => {
    for (const binding of [
      "handleNavClick('home')",
      "handleNavClick('owner')",
      "handleNavClick('finder')",
      "handleNavClick('becomeAgent')",
      "handleNavClick('signin')",
    ]) {
      expect(drawer, `drawer must offer ${binding}`).toContain(binding);
    }
    expect(drawer).toContain('t.ownerBtn');
    expect(drawer).toContain('t.finderBtn');
    expect(drawer).toContain('t.becomeAgentBtn');
    expect(drawer).not.toMatch(/<LanguageControl/);
    expect(drawer).toContain('fullWidth');
    expect(drawer).toContain('role="group"');
    expect(drawer).toContain("aria-label={'Site menu'}");
  });
});

describe('UX-02 focus, touch and motion', () => {
  it('carries no local focus treatment on the navigation surface', () => {
    // PI-1/C5 (focusContract.test.ts) is the repository's single-focus contract;
    // UX-02 extends it to the navigation chrome, which used to stack a local ring
    // on top of the global indicator.
    for (const [name, source] of [
      ['Navbar', navbar],
    ] as const) {
      expect(source, `${name} must not suppress or duplicate the global focus ring`)
        .not.toMatch(/focus(-visible)?:(outline-none|ring)/);
      expect(source, `${name} must not use a ring-offset override`).not.toMatch(/ring-offset/);
      expect(source, `${name} must not use a focus-within ring`).not.toMatch(/focus-within:ring/);
    }
    // The one global indicator is still there, including its inverse-surface case.
    expect(indexCss).toContain('outline: 2px solid var(--color-accent-orange)');
    expect(indexCss).toContain('.bg-primary-green :focus-visible');
  });

  it('keeps sign-in, tabs and drawer destinations on the touch-target floor', () => {
    // Button size="md" is 44px (the primitive's locked ladder).
    expect(read('src/components/ui/Button.tsx')).toContain("md: 'h-11 px-5 text-body");
    expect((navbar.match(/min-h-\[44px\]/g) || []).length).toBeGreaterThanOrEqual(8);
    expect(compactHeader).toContain('h-11 w-11');
  });

  it('keeps reduced-motion support for the panel and the underline', () => {
    expect(navbar).toContain('useReducedMotion()');
    expect(navbar).toMatch(/prefersReducedMotion \? \{ duration: 0 \}/);
    expect(navbar).toContain(": { type: 'spring', damping: 25, stiffness: 200 }");
    expect(navbar).toContain(": { type: 'spring' as const, stiffness: 300, damping: 30 };");
    // No decorative continuous animation was introduced.
    expect(navbar).not.toContain('animate-bounce');
    expect(navbar).not.toContain('animate-pulse');
  });
});

describe('UX-02 navigation-local legacy audit', () => {
  it('introduces no arbitrary type, shadow, palette or off-ladder radius', () => {
    expect(navbar).not.toMatch(/text-\[\d+px\]/);
    expect(navbar).not.toMatch(/shadow-\[/);
    expect(navbar).not.toMatch(/\b(bg|text|border)-(emerald|amber|sky|red|orange|stone)-\d/);
    expect(navbar).not.toMatch(/rounded-(md|lg|xl|2xl|3xl)\b/);
    expect(navbar).not.toMatch(/min-w-\[|w-\[290px\]|w-\[340px\]/);
    expect(navbar).not.toMatch(/space-x-\d|space-y-1\.5|py-2\.5|py-3\.5/);
    expect(navbar).not.toContain('focus:outline-none');
    expect(navbar).not.toContain('focus-within:');
    // The literals that are deliberately KEPT, each for a stated reason:
    //   · the 44px touch floor — not a rung on the 8-point spacing rhythm;
    //   · the scrim colour — no suitable semantic token exists (Batch 2 note);
    //   · the safe-area inset — an environment() expression, not a spacing value.
    expect(navbar).toContain('min-h-[44px]');
    expect(navbar).toContain('bg-black/40');
    expect(navbar).toContain('pb-[max(0.5rem,env(safe-area-inset-bottom))]');
  });

  it('reads every Lucide icon from the UX-01 icon ladder', () => {
    expect(navbar).toContain("import { ICON_SIZE } from './ui/iconSize'");
    expect(navbar).not.toMatch(/size=\{\d+\}/);
    for (const step of ['metadata', 'ui', 'emphasis', 'heading']) {
      expect(navbar, `icon ladder step ${step} in use`).toContain(`size={ICON_SIZE.${step}}`);
    }
    expect(read('src/components/ui/iconSize.ts')).toContain('export const ICON_LADDER');
  });

  it('uses the UX-01 type, radius and elevation ladders rather than raw Tailwind names', () => {
    for (const token of ['text-caption', 'text-body', 'rounded-small', 'rounded-standard']) {
      expect(navbar, `UX-01 token ${token} in use`).toContain(token);
    }
    expect(navbar).toContain('shadow-raised');
    expect(indexCss).toContain('--radius-standard: 12px');
    expect(indexCss).toContain('--shadow-raised: var(--elevation-raised)');
  });
});

describe('UX-02 authenticated / public boundary', () => {
  it('never mounts the public Navbar on an authenticated dashboard surface', () => {
    const publicReturnStart = appCode.lastIndexOf('return (');
    const dashboardBranch = appCode.slice(appCode.indexOf('if (dashboardSurface)'), publicReturnStart);
    const publicBranch = appCode.slice(publicReturnStart);
    expect(dashboardBranch).toContain('<DashboardShell');
    expect(dashboardBranch).not.toContain('<Navbar');
    expect(publicBranch).toContain('<Navbar');
    // Every authenticated surface routes through the one shell.
    for (const surface of ["'account'", "'agent'", "'admin'"]) {
      expect(appCode).toContain(`dashboardSurface === ${surface}`);
    }
  });

  it('does not touch authentication, routing or session behaviour', () => {
    // The bar consumes the session App already owns and adds nothing of its own.
    expect(navbar).not.toMatch(/customer_token|agent_token/);
    expect(navbar).not.toMatch(/fetch\(/);
    expect(navbar).toContain('const signedIn = Boolean(token) || accountSignedIn;');
    expect(navbar).toContain('const isTokenOnlySession = Boolean(token) && !accountSignedIn && !isAccountView;');
    expect(appTsx).toContain('token={agentToken || adminToken}');
    expect(appTsx).toContain("fetch('/api/customer/me'");
    // The route model is untouched: the same restorable views, the same paths.
    const publicRoutes = read('src/utils/publicRoutes.ts');
    for (const path of ["const AGENT_PATH = '/agent_portal';", "const FOUND_PATH = '/found'"]) {
      expect(publicRoutes).toContain(path);
    }
  });
});
