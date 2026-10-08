// =============================================================================
// BATCH C — RESPONSIVE PRODUCT UX HARDENING (source-invariant contracts)
// =============================================================================
// The repository has no DOM/browser harness (vitest environment: 'node'), so —
// like every other UI suite here (UX-06 … UX-15H, focusContract, publicChromeUx02)
// — this asserts the SHIPPED SOURCE against the rules the batch actually fixed,
// using the same comment stripper and the same "guards are live, not decorative"
// mutation checks.
//
// It exists because these are the rules that were being broken silently:
//   1. the 12px type floor (docs/design-system.md §1: "12px is the floor" — the
//      repository already enforces it inside the ui/ primitives and inside the
//      AdminView panels; this extends the SAME rule to every shipped view);
//   2. ONE focus language (docs/design-system.md §6 + focusContract.test.ts):
//      a local `focus-visible:outline-none` + `focus-visible:ring-2` pair
//      suppresses the global keyboard indicator and stacks a second one, which
//      is the exact defect PI-1/C5 removed from the primitives;
//   3. a horizontally scrollable data table must be reachable by keyboard and
//      announced, and must SHOW that it can scroll — a nine-column ledger that
//      silently scrolls makes the user guess that more columns exist;
//   4. a control must not be crushed on a phone (measured: the claims search
//      input rendered 26px wide at 320/360/390/430);
//   5. the honesty contracts this batch had to protect: agent earnings vs
//      pending settlement, the admin pricing-authority banner, and the
//      assignment state.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the UX-06 … UX-15H suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Every shipped view/component file, walked from disk (no git dependency). */
function componentFiles(dir = path.resolve(repoRoot, 'src/components')): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...componentFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}
const COMPONENT_FILES = componentFiles();
const APP_TSX = path.resolve(repoRoot, 'src/App.tsx');
const FRONTEND_FILES = [...COMPONENT_FILES, APP_TSX];

const rel = (p: string) => path.relative(repoRoot, p).replace(/\\/g, '/');
const code = (p: string) => stripComments(read(rel(p)));

// -----------------------------------------------------------------------------
// 2. ONE FOCUS LANGUAGE  (docs/design-system.md §6)
// -----------------------------------------------------------------------------
// focusContract.test.ts already forbids this pattern inside the ui/ primitives.
// The same pair was still present in the shipped views, where it cancels the
// global `:focus-visible` outline and stacks a box-shadow ring on top of it —
// the reported double-border / orange-border look. It is now gone from App.tsx
// (which carried six instances) and from the AdminView console.
//
// THE ONE DOCUMENTED RESIDUAL: the Agent Hub's drop-off-code input keeps its
// local ring, because two suites pin that exact treatment as
// accessibility-critical for that surface (agentDashboardUx13.test.ts
// `expect(HUB).toContain('focus-visible:ring-2')` and
// agentHubModernizationBatch4B3.test.ts, same assertion). This batch does not
// silently overturn a reviewed contract on another surface's behalf: it names
// the residual and proves it has not spread past that one file.
const FOCUS_RESIDUAL_FILE = 'src/components/agent/AgentHub.tsx';

describe('Batch C: the views keep the single global focus language', () => {
  it('no shipped view outside the documented residual suppresses the global focus outline', () => {
    const offenders: string[] = [];
    for (const file of FRONTEND_FILES) {
      if (rel(file) === FOCUS_RESIDUAL_FILE) continue;
      if (/focus-visible:outline-none/.test(code(file))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it('no shipped view outside the documented residual stacks a second focus-visible ring', () => {
    const offenders: string[] = [];
    for (const file of FRONTEND_FILES) {
      if (rel(file) === FOCUS_RESIDUAL_FILE) continue;
      if (/focus-visible:ring-\d/.test(code(file))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it('the residual is exactly one file, so it cannot spread', () => {
    const withLocalRing: string[] = [];
    for (const file of FRONTEND_FILES) {
      if (/focus-visible:ring-\d/.test(code(file))) withLocalRing.push(rel(file));
    }
    expect(withLocalRing).toEqual([FOCUS_RESIDUAL_FILE]);
  });

  it('the single global rule is still the indicator', () => {
    const css = read('src/index.css');
    expect(css).toMatch(/:focus-visible\s*\{/);
    expect(css).toContain('outline: 2px solid var(--color-accent-orange)');
  });

  it('the guard is live, not decorative (mutation check)', () => {
    const mutant = `<button className="focus-visible:outline-none focus-visible:ring-2" />`;
    expect(/focus-visible:outline-none/.test(mutant)).toBe(true);
    expect(/focus-visible:ring-\d/.test(mutant)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 4. NARROW SCREENS DO NOT CRUSH A CONTROL
// -----------------------------------------------------------------------------
// Measured in a real browser at 320/360/390/430: the claims search input
// rendered 26px wide because a fixed-width 176px select sat beside it in a row
// that never wrapped. The row now stacks below the `sm` breakpoint.
describe('Batch C: a phone-width form row stacks instead of crushing', () => {
  const filters = read('src/components/admin/claims/ClaimsFilters.tsx');

  it('the claims search row stacks on phones and only becomes a row when there is room', () => {
    expect(filters).toContain('className="flex flex-col gap-2 sm:flex-row"');
    expect(filters).toContain('className="w-full sm:w-44 sm:shrink-0"');
    // A bare `w-44 shrink-0` is the defect this replaces.
    expect(code('src/components/admin/claims/ClaimsFilters.tsx')).not.toContain('"w-44 shrink-0"');
  });

  it('both controls in the row carry their own visible label', () => {
    const stripped = code('src/components/admin/claims/ClaimsFilters.tsx');
    // The hand-rolled <label htmlFor> that pointed at the same id as the
    // primitive's own label is gone — two labels for one control make the
    // accessible name repeat itself.
    expect(stripped).not.toContain('<label htmlFor="r4m-claims-search-field"');
    expect(stripped).toContain('id="r4m-claims-search-field"');
    expect(stripped).toMatch(/label=\{'Search by'\}/);
    // Both controls in the row render a visible label, so the row stays
    // aligned when it becomes a row — and neither relies on a placeholder
    // alone to say what it is.
    expect(stripped).toMatch(/label=\{'Search claims'\}/);
    const searchInput = stripped.slice(stripped.indexOf("label={'Search claims'}"));
    expect(searchInput.slice(0, 200), 'the search input must not hide its label').not.toContain('hideLabel');
  });

  it('the admin lost-reports county filter sits on the 44px control ladder', () => {
    const section = code('src/components/admin/lostReports/LostReportsAdministration.tsx');
    expect(section).toContain('h-11 min-w-0 max-w-full rounded-standard');
    // ...and no longer suppresses its own keyboard focus indicator.
    expect(section).not.toMatch(/focus:outline-none/);
    expect(section).not.toContain('focus:border-accent-orange');
  });
});

// -----------------------------------------------------------------------------
// 5. AGENT EARNINGS STAY HONEST (Batch C part 17)
// -----------------------------------------------------------------------------
// A confirmed handover books an agent_payout row as PENDING: nothing is
// disbursed until the dispute window closes. The two states must therefore be
// two different cards, and the pending one must never be presented as earnings.
describe('Batch C: completed earnings and pending settlement stay distinct', () => {
  const hub = read('src/components/agent/AgentHub.tsx');

  it('shows completed earnings as the only thing called earned', () => {
    expect(hub).toContain("'Total Earned (your commission share)'");
    expect(hub).toContain("'completed handovers paid out'");
  });

  it('labels pending settlement as not yet paid, with the dispute window named', () => {
    expect(hub).toContain("'Pending settlement (not yet paid — dispute window running)'");
    expect(hub).toContain("'handovers awaiting settlement'");
    // The pending card may not borrow the earned/paid vocabulary.
    const pendingCard = hub.slice(
      hub.indexOf("'Pending settlement (not yet paid"),
      hub.indexOf("'handovers awaiting settlement'"),
    );
    expect(pendingCard).not.toMatch(/Total Earned|\bearned\b/i);
  });

  it('renders the pending card only when a payout is actually pending', () => {
    expect(hub).toMatch(/agentEarnings\.pendingSettlementsCount\s*>\s*0/);
  });
});

// -----------------------------------------------------------------------------
// 3. SCROLLING DATA REGIONS ARE VISIBLE AND KEYBOARD-REACHABLE
// -----------------------------------------------------------------------------
// A wide operational table is the one place horizontal scrolling is the right
// answer (shrinking it to fit would make it unreadable, hiding columns would
// hide information). Scrolling is only acceptable if it is discoverable and if
// a keyboard user can actually operate it — so every scrolling table wrapper
// carries the shared class plus role/aria-label/tabIndex.
const SCROLL_REGIONS: Array<[file: string, anchor: string]> = [
  ['src/components/AdminView.tsx', 'Recent ledger transactions'],
  ['src/components/AdminView.tsx', 'Category pricing table'],
  ['src/components/AdminView.tsx', 'Payment strikes table'],
  ['src/components/admin/claims/ClaimsTable.tsx', 'Claims table'],
  ['src/components/admin/lostReports/LostReportsAdministration.tsx', 'Lost reports table'],
  ['src/components/PrivacyView.tsx', 'Personal data collected'],
  ['src/components/PrivacyView.tsx', 'External services that process information'],
];

/**
 * The TWO deliberate exceptions, both a horizontal strip of BUTTONS rather than
 * a data table. A browser already scrolls a focused button into view inside a
 * scroll container, so neither needs a tab stop or a scroll shadow.
 *  - `r4m-admin-nav`   the admin console's section strip (index.css)
 *  - the customer dashboard's section strip, whose class string is asserted
 *    unique below
 * They are named explicitly so a THIRD silent scroller cannot appear unnoticed.
 */
const NAV_STRIP = 'r4m-admin-nav';
const CUSTOMER_SECTION_STRIP = 'flex items-stretch overflow-x-auto';

describe('Batch C: every scrolling table is a labelled, focusable region', () => {
  it('declares the shared scroll class, a region role, a name and a tab stop', () => {
    for (const [file, label] of SCROLL_REGIONS) {
      const source = code(file);
      expect(source, `${file} must use the one shared scroll affordance`).toContain('r4m-scroll-x');
      expect(source, `${file} must name the "${label}" region`).toContain(label);
      expect(source, `${file} must expose the region role`).toMatch(/role="region"/);
      expect(source, `${file} must be reachable by keyboard`).toMatch(/tabIndex=\{0\}/);
    }
  });

  it('the shared affordance is defined once, in the token file', () => {
    const css = read('src/index.css');
    expect(css).toContain('.r4m-scroll-x {');
    expect(css).toMatch(/\.r4m-scroll-x\s*\{[^}]*overflow-x:\s*auto/);
    // The "scrolling shadow" only appears while the box can actually scroll —
    // that is what makes the overflow visible without JavaScript.
    expect(css).toMatch(/background-attachment:\s*local,\s*local,\s*scroll,\s*scroll/);
    // ...and focusing the region uses the same single focus language.
    expect(css).toMatch(/\.r4m-scroll-x:focus-visible\s*\{[^}]*outline: 2px solid var\(--appearance-focus\)/);
  });

  it('no scrolling table is left as a silent overflow box', () => {
    const offenders: string[] = [];
    for (const file of FRONTEND_FILES) {
      const source = code(file);
      // `overflow-x-auto` on its own is exactly the silent-overflow state.
      for (const match of source.matchAll(/className="[^"]*overflow-x-auto[^"]*"/g)) {
        const cls = match[0];
        if (cls.includes('r4m-scroll-x') || cls.includes(NAV_STRIP) || cls.includes(CUSTOMER_SECTION_STRIP)) continue;
        offenders.push(`${rel(file)}: ${cls.slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the two navigation-strip exceptions cannot spread', () => {
    const withCustomerStrip: string[] = [];
    for (const file of FRONTEND_FILES) {
      if (code(file).includes(CUSTOMER_SECTION_STRIP)) withCustomerStrip.push(rel(file));
    }
    // Exactly ONE file may carry this class string, so the exception stays a
    // named, reviewed exception instead of becoming a general escape hatch.
    expect(withCustomerStrip).toEqual(['src/components/CustomerDashboard.tsx']);
    // And it really is a <nav> of buttons, not a table in disguise.
    expect(code('src/components/CustomerDashboard.tsx')).toMatch(/<nav[\s\S]{0,120}?className="flex items-stretch overflow-x-auto/);
    expect(code('src/components/AdminView.tsx')).toMatch(/className="r4m-admin-nav[^"]*overflow-x-auto/);
  });

  it('the scroll affordance follows the surface it is painted on', () => {
    // The veil is a role, so a legacy light-only card overrides the role rather
    // than forking the affordance.
    const css = read('src/index.css');
    expect(css).toMatch(/--r4m-scroll-veil:\s*var\(--appearance-surface\)/);
    expect(read('src/components/PrivacyView.tsx')).toContain('r4m-scroll-x-on-white');
  });
});

// -----------------------------------------------------------------------------
// 6. ADMIN PRICING AUTHORITY STAYS VISIBLE (Batch C part 18)
// -----------------------------------------------------------------------------
describe('Batch C: the pricing model in force is stated, not implied', () => {
  const admin = read('src/components/AdminView.tsx');

  it('names the active model and the price a new item would lock', () => {
    expect(admin).toContain('data-pricing-mode={catFormIsAdminModified ?');
    expect(admin).toContain("'Pricing model in force for NEW items'");
    expect(admin).toContain("'MODE 1 — FLAT / ADMIN OVERRIDE is in force'");
    expect(admin).toContain("'MODE 2 — RECOVERY FEE ENGINE is in force'");
    expect(admin).toContain('A new item would lock: KES ');
    expect(admin).toContain('A new item would be priced at Base + Complexity + Delay = KES ');
  });

  it('offers the explicit switch that makes the flat values authoritative', () => {
    expect(admin).toContain("'Make the flat prices authoritative (switch to MODE 1)'");
  });
});

// -----------------------------------------------------------------------------
// 7. ASSIGNMENT STATE STAYS HONEST (Batch C part 19)
// -----------------------------------------------------------------------------
describe('Batch C: automatic assignment is never shown as manual', () => {
  const admin = read('src/components/AdminView.tsx');

  it('states the method that was actually used, and flags a manual fallback', () => {
    expect(admin).toContain('Method: ');
    expect(admin).toContain('{selectedReviewItem.agent_assignment_method}');
    expect(admin).toContain('Needs Manual Reassignment');
  });

  it('separates a successful auto-assignment from the manual-link state', () => {
    expect(admin).toContain('Successfully Auto-Assigned');
    // The two states are keyed off different signals, never one shared flag.
    expect(admin).toMatch(/needs_manual_agent_reassignment/);
    expect(admin).toMatch(/agent_assignment_method/);
  });
});

// -----------------------------------------------------------------------------
// 8. DIALOGS FIT A 320px PHONE (Batch C part 11)
// -----------------------------------------------------------------------------
describe('Batch C: the shared dialog stays usable on the smallest screen', () => {
  const modal = read('src/components/ui/Modal.tsx');

  it('caps its height, scrolls only its body and keeps the footer reachable', () => {
    expect(modal).toMatch(/max-h-\[90vh\]/);
    expect(modal).toContain('flex flex-col');
    expect(modal).toMatch(/overflow-y-auto/);
    expect(modal).toMatch(/border-t[^"]*shrink-0/);
  });

  it('never grows wider than the viewport', () => {
    // Full width on a phone, capped only once there is room for a gutter.
    expect(modal).toContain('w-full sm:max-w-lg');
    expect(modal).not.toMatch(/\bw-\[/);
  });
});

// -----------------------------------------------------------------------------
/** The off-ladder sizes the ladder forbids: 9px, 10px and 11px. */
const SUB_CAPTION = /text-\[(?:9|10|11)px\]/g;

/**
 * THE ONE DOCUMENTED RESIDUAL.
 *
 * OwnerView's star-rating badge is an explicitly recorded exception: it is the
 * single remaining `text-[…]` in that file, it is pinned by
 * `customerDashboardUx09.test.ts` ("leaves the documented residual exactly
 * where it was" — `count(OWNER_VIEW, /text-\[/g)` is `1`) and by
 * `publicExperience.test.ts` ("the arbitrary caption sizes are gone except the
 * documented micro-badge"). This batch therefore does NOT quietly change that
 * residual count — it names it, and proves it has not spread.
 */
const DOCUMENTED_MICRO_BADGE = { file: 'src/components/OwnerView.tsx', expected: 1 };

describe('Batch C: the 12px type floor holds in every shipped view', () => {
  it('no shipped component renders 9px, 10px or 11px text, except the documented badge', () => {
    const offenders: string[] = [];
    let badgeHits = 0;
    for (const file of FRONTEND_FILES) {
      const hits = code(file).match(SUB_CAPTION) || [];
      if (rel(file) === DOCUMENTED_MICRO_BADGE.file) { badgeHits += hits.length; continue; }
      if (hits.length) offenders.push(`${rel(file)} -> ${hits.join(', ')}`);
    }
    expect(offenders).toEqual([]);
    // The residual is still exactly one occurrence in exactly one file — so it
    // cannot grow, and removing it must be a deliberate, documented act.
    expect(badgeHits).toBe(DOCUMENTED_MICRO_BADGE.expected);
  });

  it('the caption step is the replacement that was actually used', () => {
    // A guard on the direction of the fix: the sizes were raised onto the
    // ladder, not deleted along with the text.
    for (const file of [
      'src/components/admin/claims/ClaimsTable.tsx',
      'src/components/admin/claims/ClaimDetailPanel.tsx',
      'src/components/customer/PossibleMatches.tsx',
    ]) {
      expect(read(file), file).toContain('text-caption');
    }
  });

  it('the guard is live, not decorative (mutation check)', () => {
    expect((`<p className="text-[11px]">x</p>`).match(SUB_CAPTION)).not.toEqual(null);
    expect((`<p className="text-caption">x</p>`).match(SUB_CAPTION)).toEqual(null);
    // ...and it is not fooled by a comment that merely mentions the old sizes.
    expect(code('src/components/AdminView.tsx').match(SUB_CAPTION)).toEqual(null);
  });
});
