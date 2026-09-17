import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// PHASE 9 — ADMIN CONSOLE SHELL (Requests 05, §10, §11)
// =============================================================================
// Source-level tripwires for the console redesign. The console is the most
// security-sensitive screen in the product, so these assertions cover BOTH the
// new presentation (sidebar, active state, "signed in as") and the parts that
// must not have changed (the authentication gate, the section set, the absence
// of fabricated administrator data).

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const adminView = read('src/components/AdminView.tsx');
const indexCss = read('src/index.css');

/** The nine sections the console really has, each backed by existing endpoints. */
const REAL_SECTIONS = [
  'stats', 'agents', 'found_items', 'disputes', 'claims', 'ledger', 'review', 'categories', 'strikes',
] as const;

describe('admin sidebar (Request 05 / §11)', () => {
  it('renders the sections as a navigation landmark, not a bare div', () => {
    expect(adminView).toContain('r4m-admin-nav');
    expect(adminView).toMatch(/<nav[\s\S]{0,200}aria-label=\{lang === 'en' \? 'Admin sections'/);
  });

  it('exposes exactly the nine sections that already existed — no invented section', () => {
    const declared = [...adminView.matchAll(/aria-current=\{activeTab === '([a-z_]+)'/g)].map((m) => m[1]);
    expect([...declared].sort()).toEqual([...REAL_SECTIONS].sort());
    // ...and each one still renders a panel.
    for (const section of REAL_SECTIONS) {
      expect(adminView, `no panel for ${section}`).toContain(`activeTab === '${section}' &&`);
    }
  });

  it('marks the active section for assistive tech AND for the style layer', () => {
    // Never colour alone: the active section carries aria-current="page", which
    // the sidebar stylesheet turns into an accent bar plus a tint.
    expect(adminView).toContain("aria-current={activeTab === 'stats' ? 'page' : undefined}");
    expect(indexCss).toContain('.r4m-admin-nav > button[aria-current=');
  });

  it('is a persistent desktop sidebar and a scrollable strip on small screens', () => {
    expect(indexCss).toMatch(/@media \(min-width: 1024px\) \{[\s\S]{0,400}\.r4m-admin-nav \{/);
    expect(indexCss).toMatch(/\.r4m-admin-nav \{[\s\S]{0,400}flex-direction: column;/);
    expect(indexCss).toMatch(/\.r4m-admin-nav \{[\s\S]{0,400}position: sticky;/);
    // The pre-existing horizontal behaviour stays the default (mobile) case.
    expect(adminView).toMatch(/className="r4m-admin-nav flex border-b border-stone-200 overflow-x-auto scrollbar-none"/);
    // The layout wrapper is what puts the nav beside the content on desktop.
    expect(adminView).toContain('lg:grid lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-8 lg:items-start');
  });
});

describe('the console still states who is signed in, truthfully (§10)', () => {
  it('shows the session identifier, falling back to the generic word only', () => {
    expect(adminView).toContain('readAdminSessionIdentity');
    expect(adminView).toContain('adminIdentityLabel');
    expect(adminView).toContain('{adminLabel}');
    // No fabricated identity fields anywhere in the console header.
    for (const invented of ['last login', 'lastLogin', 'adminAvatar', 'admin.email', 'profilePhoto']) {
      expect(adminView, `fabricated identity field: ${invented}`).not.toContain(invented);
    }
  });

  it('never renders the access token', () => {
    expect(adminView).not.toMatch(/>\s*\{token\}\s*</);
    expect(adminView).not.toMatch(/\{adminToken\}/);
    // The token is only ever used as an Authorization header.
    expect(adminView).toMatch(/Authorization: `Bearer \$\{token\}`/);
  });

  it('offers an explicit sign-out that clears the session', () => {
    expect(adminView).toContain('onClick={() => setToken(null)}');
  });

  it('keeps the authentication gate exactly where it was', () => {
    // The redesign must not have moved the console behind anything weaker: the
    // passcode gate still renders whenever there is no token.
    expect(adminView).toContain('{!token && (');
    expect(adminView).toContain('Admin Authentication');
    expect(adminView).toContain('pendingTwoFactorToken');
  });

  it('keeps the emergency-pause controls visible on every section', () => {
    // The safety controls deliberately live outside the section panels, so they
    // travelled with the layout change rather than ending up inside one tab.
    const pauseHandler = adminView.indexOf('handleTogglePause');
    const gridStart = adminView.indexOf('lg:grid lg:grid-cols-[236px_minmax(0,1fr)]');
    expect(pauseHandler).toBeGreaterThan(-1);
    expect(gridStart, 'sidebar shell not found').toBeGreaterThan(-1);
    // The pause controls are rendered ABOVE the sidebar shell, i.e. still global.
    expect(pauseHandler).toBeLessThan(gridStart);
    expect(adminView).toContain('socialPublishingPaused');
  });
});
