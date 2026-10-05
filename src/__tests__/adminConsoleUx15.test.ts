import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-15A/B — THE AUTHENTICATED ADMIN CONSOLE: STATES + CHROME
// =============================================================================
// UX-14 ended at the single unauthenticated `{!token && (` branch. UX-15 begins
// immediately after it, with the console's own loading / error / empty states
// and the console chrome (identity band, sign-out, section navigation, section
// heading). Everything below that chrome — the section panels themselves — is a
// later UX-15 continuation and is deliberately NOT asserted against here.
//
// UX-15A/B IS PRESENTATION ONLY. It changes none of:
//   * the authentication protocol, the token, the route architecture or the
//     signed-out gate (UX-14's surface, which this batch does not touch);
//   * the dashboard data contract — the same single dashboard fetch, the same
//     payload, the same `fetchDashboardData` retry handler, the same three
//     conditions deciding loading / error / empty;
//   * the console's business logic, or the emergency-pause, agent, category,
//     claims, ledger, review and strike behaviour of the panels below the chrome.
// What it changes is the presentation vocabulary of those states and of the
// chrome: the shared primitives (`Banner`, `EmptyState`, `Spinner`, `Button`),
// the `--appearance-*` tokens, the UX-01 type ladder and the UX-01 icon ladder.
//
// There is no jsdom/React harness in this repository, so — exactly as the
// UX-06 … UX-14 suites do — the contract is asserted against the shipped source,
// with the same comment stripper and the same `sliceBetween` helper, and every
// assertion is made against a SLICE rather than against the whole file.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the N3 and UX-06 … UX-14 suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ADMIN_VIEW_TSX = read('src/components/AdminView.tsx');
const ADMIN_VIEW = stripComments(ADMIN_VIEW_TSX);
const INDEX_CSS = read('src/index.css');
const DESIGN_SYSTEM = read('docs/design-system.md');
const BANNER_PRIMITIVE = read('src/components/ui/Banner.tsx');
const EMPTY_PRIMITIVE = read('src/components/ui/EmptyState.tsx');
const SPINNER_PRIMITIVE = read('src/components/ui/Spinner.tsx');
const BUTTON_PRIMITIVE = read('src/components/ui/Button.tsx');

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`UX-15 marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

/**
 * THE SCOPE BOUNDARY. `{/* 2. DISTINCT LOADING` is the exact marker UX-14 slices
 * its own gate UP TO, so the authenticated region starts precisely where the
 * signed-out gate ends and the two batches can never overlap.
 */
const CONSOLE_TSX = ADMIN_VIEW_TSX.slice(ADMIN_VIEW_TSX.indexOf('{/* 2. DISTINCT LOADING'));
const CONSOLE = stripComments(CONSOLE_TSX);
/** UX-15A — the three authenticated dashboard states. */
const STATES_TSX = sliceBetween(
  ADMIN_VIEW_TSX,
  '{/* 2. DISTINCT LOADING',
  '{/* 3. ADMIN DASHBOARD WORKSPACE',
);
const STATES = stripComments(STATES_TSX);
const LOADING = stripComments(
  sliceBetween(STATES_TSX, '{token && dashboardLoading', '{token && !dashboardData && dataError'),
);
const ERROR = stripComments(
  sliceBetween(
    STATES_TSX,
    '{token && !dashboardData && dataError',
    '{token && !dashboardLoading && !dashboardData && !dataError',
  ),
);
const EMPTY = stripComments(
  STATES_TSX.slice(STATES_TSX.indexOf('{token && !dashboardLoading && !dashboardData && !dataError')),
);

/** UX-15B — the console chrome bands, each sliced on the real JSX it delimits. */
const IDENTITY = stripComments(
  sliceBetween(
    ADMIN_VIEW_TSX,
    'rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)] px-4 py-3.5 shadow-sm',
    '{/* Social media publishing emergency stop',
  ),
);
const NAV = stripComments(sliceBetween(ADMIN_VIEW_TSX, '<nav', '</nav>'));
const HEADING = stripComments(sliceBetween(ADMIN_VIEW_TSX, '{/* PAGE TITLE', '{/* TAB CONTENT 1'));

/* ---------------------------------------------------------------------------
 * The guards the mutation checks at the bottom re-run against a deliberately
 * broken copy of a slice, so the checks cannot silently rot.
 * ------------------------------------------------------------------------- */
/** Off-ladder / sub-12px type: the UX-01 ladder is the only scale allowed. */
const offLadderType = (source: string): string[] => [
  ...(source.match(/text-\[\d+px\]/g) || []),
  ...(source.match(/\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?![\w-])/g) || []),
];
/** Pre-UX-01 colour: raw hex, a fixed palette (raw red included — the UX-15
 *  error state replaced exactly that), or a literal white surface. */
const legacyColour = (source: string): string[] => [
  ...(source.match(/#[0-9a-fA-F]{3,8}\b/g) || []),
  ...(source.match(/\b(?:bg|text|border)-(?:stone|slate|gray|zinc|emerald|amber|sky|red)-/g) || []),
  ...(source.match(/\bbg-white\b/g) || []),
];
/** Icons sized by a magic number instead of the UX-01 ladder. */
const rawIconSize = (source: string): string[] => source.match(/size=\{\d+\}/g) || [];
/** Any browser dialog: the console is a page, never a native prompt. */
const browserDialog = (source: string): string[] =>
  source.match(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/g) || [];
// -----------------------------------------------------------------------------
// A. The boundary: UX-15 starts where UX-14 stops, and the gate is untouched.
// -----------------------------------------------------------------------------

describe('UX-15 begins at the gate boundary and leaves UX-14 alone', () => {
  it('keeps the gate the ONE unauthenticated branch, with both slice markers', () => {
    expect(ADMIN_VIEW_TSX).toContain('{!token && (');
    expect(count(ADMIN_VIEW, /\{!token && \(/g)).toBe(1);
    // UX-14's slice END marker — byte-identical, so its gate slice still resolves.
    expect(ADMIN_VIEW_TSX).toContain('{/* 2. DISTINCT LOADING');
    // adminConsoleShell.test.ts's login-branch slice END marker.
    expect(ADMIN_VIEW_TSX).toContain('{token && dashboardLoading');
  });

  it('asserts nothing about the signed-out gate from the authenticated region', () => {
    expect(CONSOLE).not.toContain('logo_wordmark_transparent');
    expect(CONSOLE).not.toContain('pendingTwoFactorToken');
    expect(CONSOLE).not.toContain('admin-login');
  });

  it('the scope slice itself is load-bearing: moving the states breaks it', () => {
    expect(() =>
      sliceBetween(ADMIN_VIEW_TSX, '{/* 2. DISTINCT LOADING', '{/* 3. ADMIN DASHBOARD WORKSPACE'),
    ).not.toThrow();
    expect(() =>
      sliceBetween(
        ADMIN_VIEW_TSX.replace('{/* 3. ADMIN DASHBOARD WORKSPACE', ''),
        '{/* 2. DISTINCT LOADING',
        '{/* 3. ADMIN DASHBOARD WORKSPACE',
      ),
    ).toThrow();
  });
});

// -----------------------------------------------------------------------------
// B. Loading — same condition, same loader, same copy, no legacy styling.
// -----------------------------------------------------------------------------

describe('UX-15A: the authenticated loading state', () => {
  it('renders under the unchanged condition with the shared Spinner', () => {
    expect(STATES).toContain('{token && dashboardLoading && !dashboardData && (');
    expect(LOADING).toContain('<Spinner');
    // The shared Spinner IS the loader the console already used: Loader2 with
    // animate-spin — and it owns the "a request is in flight" announcement.
    expect(SPINNER_PRIMITIVE).toContain('Loader2');
    expect(SPINNER_PRIMITIVE).toContain('animate-spin');
    expect(SPINNER_PRIMITIVE).toContain('role="status"');
    expect(SPINNER_PRIMITIVE).toContain('aria-label={label}');
    expect(LOADING).toContain('label="Fetching console dashboard statistics..."');
  });

  it('keeps the exact copy and reads its type and surfaces from the design system', () => {
    expect(LOADING).toContain('Fetching console dashboard statistics...');
    expect(LOADING).toContain('text-caption');
    expect(LOADING).toContain('text-[var(--appearance-text-muted)]');
    expect(LOADING).toContain('text-[var(--appearance-primary)]');
  });

  it('adds no second live region and no legacy state styling', () => {
    expect(count(LOADING, /role="(?:status|alert)"/g)).toBe(0);
    expect(offLadderType(LOADING)).toEqual([]);
    expect(legacyColour(LOADING)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// C. Error — one shared Banner, one live region, the same retry handler.
// -----------------------------------------------------------------------------

describe('UX-15A: the authenticated dashboard error state', () => {
  it('keeps the exact condition, message and retry operation', () => {
    expect(STATES).toContain('{token && !dashboardData && dataError && (');
    expect(ERROR).toContain('{dataError}');
    expect(ERROR).toContain('onClick={fetchDashboardData}');
    // The retry is the shared Button at the 44px floor, not a hand-built control.
    expect(ERROR).toContain('<Button');
    expect(ERROR).toContain('size="md"');
    expect(BUTTON_PRIMITIVE).toContain("md: 'h-11");
    expect(count(ERROR, /<button\b/g)).toBe(0);
    expect(ERROR).toContain('Retry Connection');
  });

  it('renders exactly ONE error live region, owned by the shared Banner', () => {
    expect(count(STATES, /<Banner kind="error">/g)).toBe(1);
    expect(ERROR).toContain('<Banner kind="error">');
    // The primitive owns the announcement; the console adds no ARIA of its own.
    expect(count(ERROR, /role="(?:alert|status)"/g)).toBe(0);
    expect(BANNER_PRIMITIVE).toContain("role={isInterruptive ? 'alert' : 'status'}");
    expect(BANNER_PRIMITIVE).toContain("aria-live={isInterruptive ? 'assertive' : 'polite'}");
  });

  it('is a page-level error, never a browser dialog', () => {
    expect(browserDialog(ERROR)).toEqual([]);
    expect(browserDialog(STATES)).toEqual([]);
  });

  it('drops the bespoke red presentation entirely', () => {
    expect(legacyColour(ERROR)).toEqual([]);
    expect(offLadderType(ERROR)).toEqual([]);
    expect(count(ERROR, /rounded-(?:xl|2xl|3xl)(?![\w-])/g)).toBe(0);
  });

  it('keeps the workspace error channel mutually exclusive, not duplicated', () => {
    // The error that can only render once there IS dashboard data stays where it
    // is (and is still a Banner); the states branch above requires !dashboardData,
    // so the two can never both be live.
    expect(CONSOLE).toContain('{dataError && <Banner kind="error">{dataError}</Banner>}');
  });
});
// -----------------------------------------------------------------------------
// D. Empty — the shared EmptyState, the exact copy, the same retry.
// -----------------------------------------------------------------------------

describe('UX-15A: the authenticated dashboard empty state', () => {
  it('keeps the unchanged condition and both exact strings', () => {
    expect(EMPTY).toContain('{token && !dashboardLoading && !dashboardData && !dataError && (');
    expect(EMPTY).toContain('title="No Dashboard Data Available"');
    expect(EMPTY).toContain(
      'description="The console returned no statistical or audit record metrics at this time."',
    );
  });

  it('renders through the shared EmptyState with a shared retry Button', () => {
    expect(EMPTY).toContain('<EmptyState');
    expect(EMPTY).toContain('icon={HelpCircle}');
    expect(EMPTY).toContain('onClick={fetchDashboardData}');
    expect(EMPTY).toContain('Retry Fetching');
    expect(count(EMPTY, /<button\b/g)).toBe(0);
    // The primitive owns the surface, the icon size and the type ladder.
    expect(EMPTY_PRIMITIVE).toContain('bg-[var(--appearance-surface-muted)]');
    expect(EMPTY_PRIMITIVE).toContain('ICON_SIZE.feature');
    expect(EMPTY_PRIMITIVE).toContain('rounded-panel');
    expect(offLadderType(EMPTY)).toEqual([]);
    expect(legacyColour(EMPTY)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// E. Chrome — identity + sign-out.
// -----------------------------------------------------------------------------

describe('UX-15B: the administrator identity band and its sign-out', () => {
  it('still states who is signed in, and invents nothing', () => {
    expect(IDENTITY).toContain('{adminLabel}');
    expect(IDENTITY).toContain('{adminIdentity.role');
    expect(IDENTITY).toContain('Administrator');
    for (const invented of ['email', 'avatar', 'lastLogin', 'last-login', 'profilePhoto']) {
      expect(IDENTITY.toLowerCase(), `fabricated identity field: ${invented}`).not.toContain(
        invented.toLowerCase(),
      );
    }
  });

  it('moves the hand-built sign-out onto the shared Button without changing the action', () => {
    expect(IDENTITY).toContain('onClick={() => setToken(null)}');
    expect(IDENTITY).toContain('<Button');
    expect(count(IDENTITY, /<button\b/g)).toBe(0);
    // 44px floor through the primitive's md step.
    expect(IDENTITY).toContain('size="md"');
  });

  it('reads every colour from an appearance token', () => {
    expect(IDENTITY).toContain('bg-[var(--appearance-surface)]');
    expect(IDENTITY).toContain('border-[var(--appearance-border)]');
    expect(IDENTITY).toContain('text-[var(--appearance-text-primary)]');
    expect(IDENTITY).toContain('text-[var(--appearance-text-muted)]');
    expect(offLadderType(IDENTITY)).toEqual([]);
    expect(legacyColour(IDENTITY)).toEqual([]);
    expect(rawIconSize(IDENTITY)).toEqual([]);
  });
});
// -----------------------------------------------------------------------------
// F. Chrome — the section navigation.
// -----------------------------------------------------------------------------

describe('UX-15B: the console section navigation', () => {
  it('still declares exactly the ten real sections, in the nav landmark', () => {
    const declared = [...NAV.matchAll(/aria-current=\{activeTab === '([a-z_]+)'/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(
      [
        'stats', 'agents', 'found_items', 'disputes', 'claims', 'ledger', 'review',
        'categories', 'strikes', 'lost_reports',
      ].sort(),
    );
    expect(NAV).toContain("aria-current={activeTab === 'stats' ? 'page' : undefined}");
    expect(NAV).toContain("aria-label={lang === 'en' ? 'Admin sections' : 'Sehemu za msimamizi'}");
  });

  it('keeps the section names and their state keys unchanged', () => {
    for (const label of [
      '<span>{t.statsTab}</span>',
      '<span>{t.disputesTab}</span>',
      '<span>{t.ledgerTab}</span>',
      '<span>{t.categoriesTab}</span>',
      "<span>{lang === 'en' ? 'Agents Hub' : 'Mawakala'}</span>",
      "<span>{lang === 'en' ? 'Found Items' : 'Vitu Vilivyopatikana'}</span>",
      "<span>{lang === 'en' ? 'Claims' : 'Claims'}</span>",
      "<span>{lang === 'en' ? 'Lost Reports' : 'Ripoti za Vitu'}</span>",
      '<span>Manual Review</span>',
      '<span>Payment Strikes</span>',
    ]) {
      expect(NAV, `nav label ${label} must survive UX-15B`).toContain(label);
    }
  });

  it('stays a navigation control, not a row of generic action buttons', () => {
    expect(count(NAV, /<button\b/g)).toBe(10);
    expect(NAV).not.toContain('<Button');
  });

  it('sizes every nav icon from the UX-01 ladder, decoratively', () => {
    expect(rawIconSize(NAV)).toEqual([]);
    expect(count(NAV, /size=\{ICON_SIZE\.metadata\}/g)).toBe(10);
    expect(count(NAV, /aria-hidden="true"/g)).toBe(10);
  });

  it('uses the appearance tokens for the nav text, the bar and the rule', () => {
    expect(NAV).toContain('border-[var(--appearance-border)]');
    expect(NAV).toContain('border-[var(--appearance-primary)]');
    expect(NAV).toContain('text-[var(--appearance-text-primary)]');
    expect(NAV).toContain('text-[var(--appearance-text-muted)]');
    expect(NAV).toContain('text-caption');
    expect(offLadderType(NAV)).toEqual([]);
    expect(legacyColour(NAV)).toEqual([]);
  });

  it('the sidebar stylesheet keeps its architecture and flips in the dark theme', () => {
    // The architecture the shell test pins is untouched...
    expect(INDEX_CSS).toContain('.r4m-admin-nav > button[aria-current=');
    expect(INDEX_CSS).toMatch(/\.r4m-admin-nav \{[\s\S]{0,400}flex-direction: column;/);
    expect(INDEX_CSS).toMatch(/\.r4m-admin-nav \{[\s\S]{0,400}position: sticky;/);
    // ...and the accent bar / focus outline now read from the appearance token,
    // which is declared for BOTH themes (--color-primary-green is light-only).
    expect(INDEX_CSS).toContain('border-left-color: var(--appearance-primary);');
    expect(INDEX_CSS).toContain('outline: 2px solid var(--appearance-primary);');
    expect(INDEX_CSS).not.toMatch(/border-left-color: var\(--color-primary-green\)/);
    expect(count(INDEX_CSS, /--appearance-primary:/g)).toBeGreaterThanOrEqual(2);
  });
});
// -----------------------------------------------------------------------------
// G. Chrome — the section heading band.
// -----------------------------------------------------------------------------

describe('UX-15B: the console section heading band', () => {
  it('keeps exactly ONE authenticated page-level <h1>, on the type ladder', () => {
    expect(count(CONSOLE, /<h1\b/g)).toBe(1);
    expect(HEADING).toContain(
      '<h1 className="text-subsection sm:text-section font-extrabold tracking-tight text-[var(--appearance-text-primary)]">',
    );
    // The responsive pair it replaces, expressed as the semantic steps: 20/28 on
    // small screens, 24/32 from sm up.
    expect(INDEX_CSS).toContain('--text-subsection: 1.25rem;');
    expect(INDEX_CSS).toContain('--text-section: 1.5rem;');
    expect(offLadderType(HEADING)).toEqual([]);
    expect(legacyColour(HEADING)).toEqual([]);
  });

  it('keeps the section copy and the routing behind it untouched', () => {
    expect(HEADING).toContain('{sectionCopy.title}');
    expect(HEADING).toContain('{sectionCopy.description}');
    expect(ADMIN_VIEW_TSX).toContain('const sectionCopy = CONSOLE_SECTIONS[activeTab][lang];');
  });

  it('keeps the dashboard refresh in the chrome, now at the 44px floor', () => {
    expect(HEADING).toContain('onClick={fetchDashboardData}');
    expect(HEADING).toContain('aria-label="Refresh Audit Data"');
    expect(HEADING).toContain('size="md"');
    expect(HEADING).toContain('size={ICON_SIZE.metadata}');
    expect(rawIconSize(HEADING)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// H. The batch is recorded, and the guards are live.
// -----------------------------------------------------------------------------

describe('UX-15A/B records the batch in the design-system reference', () => {
  it('annotates the AdminView queue row without deleting it', () => {
    const row = DESIGN_SYSTEM.split(/\r?\n/).find((line) => line.startsWith('| AdminView |'));
    expect(row, 'the design system must keep the AdminView queue row').toBeDefined();
    expect(row as string).toContain('MIGRATE LATER');
    expect(row as string).toContain('UX-15A/B');
    // The neighbouring batches keep their exact counts.
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-14/g)).toBe(2);
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-11/g)).toBe(2);
    expect(count(DESIGN_SYSTEM, /MIGRATED in UX-13/g)).toBe(1);
  });
});

describe('UX-15 guards are live, not decorative (mutation checks)', () => {
  it('detects a reintroduced off-ladder type size', () => {
    expect(offLadderType(NAV)).toEqual([]);
    expect(offLadderType(`${NAV} text-xs`)).not.toEqual([]);
    expect(offLadderType(`${NAV} text-[11px]`)).not.toEqual([]);
  });

  it('detects a reintroduced legacy colour literal', () => {
    expect(legacyColour(ERROR)).toEqual([]);
    expect(legacyColour(`${ERROR} bg-stone-100`)).not.toEqual([]);
    expect(legacyColour(`${ERROR} text-red-600`)).not.toEqual([]);
    expect(legacyColour(`${ERROR} bg-white`)).not.toEqual([]);
    expect(legacyColour(`${ERROR} text-[#003820]`)).not.toEqual([]);
  });

  it('detects a magic-number icon size and a browser dialog', () => {
    expect(rawIconSize(NAV)).toEqual([]);
    expect(rawIconSize(`${NAV} size={16}`)).not.toEqual([]);
    expect(browserDialog(ERROR)).toEqual([]);
    expect(browserDialog(`${ERROR} window.prompt('reason')`)).not.toEqual([]);
  });
});





