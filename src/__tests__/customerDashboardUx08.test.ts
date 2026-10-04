import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// UX-08 — THE CUSTOMER DASHBOARD (the authenticated /account workspace)
// =============================================================================
// The private dashboard was the last customer surface still written against the
// pre-UX-01 vocabulary: hand-styled cards (`bg-white`, `brand-*`, `line-subtle`,
// `status-*`), `rounded-2xl`/`rounded-xl` panels, off-ladder type sizes, raw
// pixel icon sizes (13/14/16/17), two local `focus-visible:ring-2` rings, and —
// the reason UX-08 exists — an Overview whose "section cards" were a second copy
// of the navigation standing right beside it, so the screen answered "here are
// four places to go" instead of "where is my item, and what do I do next".
//
// UX-08 IS PRESENTATION ONLY. It deliberately changes none of:
//   * the customer endpoints, their order, their methods or their bodies;
//   * the handlers, state or the section switch (`setTab`) they are wired to;
//   * the privacy boundary — the server's `toCustomerSafeClaimView` projection
//     and the masked phone stay exactly as they were;
//   * which components own which reads (LostReportsSection still owns the
//     lost-report collection; the Overview still loads nothing of its own).
// What it changes is hierarchy, the copy of the summary band, the single
// next-step action, and the colour/type/icon/radius vocabulary — all of it by
// adopting primitives and tokens that already exist (`StatCard`, `Badge`,
// `Button`, `ICON_SIZE`, the `--appearance-*` tokens, the type/radius ladders).
//
// This repository has no jsdom/React harness, so — exactly as the UX-06, UX-07
// and N3 batches do — the contract is asserted against the shipped source.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the N3, UX-06 and UX-07 suites use. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const DASHBOARD_TSX = read('src/components/CustomerDashboard.tsx');
const DASHBOARD = stripComments(DASHBOARD_TSX);
const INDEX_CSS = read('src/index.css');
const CLAIM_ROUTES = read('src/routes/customerClaims.ts');
const DESIGN_SYSTEM = read('docs/design-system.md');

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;

/**
 * The rendered Overview band, taken from the RAW source so the two block
 * comments that introduce it act as stable delimiters. Everything between them
 * is the summary the customer sees before any section is opened — the place
 * that must answer "where is my item" from data this component already holds,
 * and must therefore fetch nothing at all.
 */
function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start === -1 ? -1 : source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`UX-08 marker not found: ${from} -> ${to}`);
  return source.slice(start, end);
}

const OVERVIEW = sliceBetween(
  DASHBOARD_TSX,
  'OVERVIEW - the calm recovery workspace',
  'MY LOST REPORTS - reporting',
);

/**
 * Every `t('english', 'kiswahili')` pair in a stripped source string. Either
 * quote style is accepted, plus the backticks one call site needs for an
 * interpolated count; the trailing comma some call sites carry is optional, and
 * so is the argument layout. The pair is the contract, not the punctuation.
 */
function bilingualPairs(source: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const re =
    /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)\s*,?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    pairs.push([match[1] ?? match[2] ?? match[3], match[4] ?? match[5] ?? match[6]]);
  }
  return pairs;
}

/**
 * Colour vocabulary that predates UX-01. None of it may appear on the customer
 * dashboard any more: the fixed literals do not flip in dark mode, the brand-*
 * names are the ones the token layer replaced, and the elevation/radius/focus
 * utilities are the ones the ladders now own.
 */
const LEGACY_LITERALS = [
  'bg-white',
  'text-black',
  'text-white',
  'border-brand-border',
  'text-brand-dark-text',
  'text-brand-muted-text',
  'bg-brand-light-gray',
  'bg-brand-beige',
  'bg-canvas',
  'border-line-subtle',
  'text-ink',
  'text-status-',
  'text-primary-green',
  'text-primary-dark',
  'accent-orange',
  'accent-teal',
  'accent-red',
  'bg-gray-',
  'text-gray-',
  'border-gray-',
  'bg-slate-',
  'text-slate-',
  'text-red-',
  'text-green-',
  'text-amber-',
  'text-blue-',
  'rounded-2xl',
  'rounded-xl',
  'rounded-lg',
  'rounded-md',
  'shadow-sm',
  'shadow-md',
  'shadow-lg',
  'shadow-xl',
  'shadow-2xl',
  'focus:ring',
  'focus-visible:ring',
] as const;

/** Claim internals the customer-safe projection must never leak to the client. */
const FORBIDDEN_CLAIM_FIELDS = [
  'security_answers',
  'payment_reference',
  'provider_invoice',
  'provider_reference',
  'owner_name',
  'owner_phone',
  'finder_name',
  'is_admin',
  'fraud',
] as const;

// -----------------------------------------------------------------------------
// The dashboard's behaviour is untouched
// -----------------------------------------------------------------------------

describe('UX-08 keeps every dashboard behaviour exactly as it was', () => {
  it('calls the same four customer endpoints, in the same order', () => {
    // A restyle is only safe if the request sequence is provably unchanged, and
    // the sequence is the first thing a UI rewrite is tempted to reorder.
    const targets = Array.from(DASHBOARD.matchAll(/fetch\('([^']*)'/g)).map((m) => m[1]);
    expect(targets).toEqual([
      '/api/customer/claims',
      '/api/customer/claims/link/request-otp',
      '/api/customer/claims/link/verify',
      '/api/customer/claims/',
    ]);
  });

  it('sends the same bodies, methods and credentials', () => {
    // The linking flow's two POST bodies and the unlink DELETE are the contract
    // the server validates; a "cosmetic" pass must not rename a field.
    expect(DASHBOARD).toContain('JSON.stringify({ claimId })');
    expect(DASHBOARD).toContain(
      'JSON.stringify({ claimId: linkClaimId, code: linkCode, securityAnswers: linkAnswers })',
    );
    expect(DASHBOARD).toContain("'/api/customer/claims/' + encodeURIComponent(claimId) + '/link'");
    expect(DASHBOARD).toContain("method: 'POST'");
    expect(DASHBOARD).toContain("method: 'DELETE'");
    // Every authenticated read/write still rides the server's session cookie.
    expect(count(DASHBOARD, /credentials: 'same-origin'/g)).toBe(4);
  });

  it('keeps the handlers, and the wiring between them, unchanged', () => {
    expect(DASHBOARD).toContain('const loadClaims = useCallback(async () => {');
    expect(DASHBOARD).toContain('useEffect(() => { loadClaims(); }, [loadClaims]);');
    expect(DASHBOARD).toContain('const requestLinkCode = async (e: React.FormEvent) => {');
    expect(DASHBOARD).toContain('const submitLink = async (e: React.FormEvent) => {');
    expect(DASHBOARD).toContain('const unlink = async (claimId: string) => {');
    // Refresh re-runs the one reader, and a successful link reloads through it
    // instead of splicing the row in locally.
    expect(DASHBOARD).toContain('onClick={loadClaims}');
    expect(DASHBOARD).toContain('await loadClaims();');
  });

  it('keeps the link-a-claim panel container contract', () => {
    // The batch note calls this container out explicitly: same width cap, same
    // border, same panel radius — only the tokens behind them moved.
    expect(DASHBOARD).toContain(
      'mt-4 max-w-2xl border border-[var(--appearance-border)] rounded-panel',
    );
    expect(DASHBOARD).toContain("{linkStep === 'claimId' ? (");
  });

  it('still splits the claim list on the server is_active flag', () => {
    // Active vs History is the server's decision, not a client-side guess from
    // a status string: both lists must keep reading the flag.
    expect(DASHBOARD).toContain(
      'const activeClaims = (claims || []).filter((c: any) => c.is_active);',
    );
    expect(DASHBOARD).toContain(
      'const historyClaims = (claims || []).filter((c: any) => !c.is_active);',
    );
    expect(DASHBOARD).toContain('{activeClaims.map(renderClaimCard)}');
    expect(DASHBOARD).toContain('{historyClaims.map(renderClaimCard)}');
  });

  it('keeps session expiry and the session itself where they were', () => {
    // The lost-report section owns its own reads, so it owns its own 401
    // handling; the dashboard only forwards the callback through. And the
    // customer session stays the server's httpOnly cookie — no second copy.
    expect(count(DASHBOARD, /onSessionExpired=\{onSessionExpired\}/g)).toBe(1);
    expect(DASHBOARD).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    expect(DASHBOARD).not.toMatch(/bearer/i);
    expect(DASHBOARD).not.toMatch(/customer_token|admin_token|agent_token/);
  });
});

// -----------------------------------------------------------------------------
// The Overview answers "where is my item" and "what next"
// -----------------------------------------------------------------------------

describe('UX-08 makes the Overview answer where-is-my-item / what-next', () => {
  it('asks those two questions, in both languages', () => {
    expect(DASHBOARD).toContain("t('Where your items stand', 'Hali ya vitu vyako')");
    expect(DASHBOARD).toContain("t('What to do next', 'Cha kufanya baadaye')");
    // The Overview's own page title/description were rewritten to promise
    // exactly that, and nothing more.
    expect(DASHBOARD).toContain(
      "description: 'Where your lost reports and claims stand, and the one next step to take.'",
    );
    expect(DASHBOARD).toContain(
      "description: 'Hali ya ripoti zako na claims zako, na hatua moja inayofuata ya kuchukua.'",
    );
  });

  it('offers exactly ONE next step, through the existing section switch', () => {
    // Two `setTab` call sites in the whole surface: the navigation, and the one
    // next-step action. A third would mean a second navigation had grown back.
    expect(count(DASHBOARD, /setTab\(/g)).toBe(2);
    expect(DASHBOARD).toContain(
      '<Button variant="primary" size="md" onClick={() => setTab(nextSection)}>',
    );
    expect(count(DASHBOARD, /onClick=\{\(\) => setTab\(nextSection\)\}/g)).toBe(1);
  });

  it('derives that step from claims it already holds, and fetches nothing to decide it', () => {
    expect(DASHBOARD).toContain('const hasWorkInProgress = activeClaims.length > 0;');
    expect(DASHBOARD).toContain(
      "const nextSection: AccountSectionKey = hasWorkInProgress ? 'claims' : 'lost';",
    );
    // The whole rendered Overview band — identity, state and next step — adds
    // no request, no effect and no second data source of its own.
    expect(OVERVIEW).toContain('StatCard');
    expect(OVERVIEW).not.toMatch(/fetch\(/);
    expect(OVERVIEW).not.toMatch(/useEffect/);
    expect(OVERVIEW).not.toMatch(/await /);
  });

  it('describes an item in progress with the SAME vocabulary as the claims list', () => {
    // One status vocabulary, so the Overview can never describe a claim
    // differently from the list below it — and never invents a lifecycle state.
    expect(DASHBOARD).toContain('getClaimStatusDisplay(activeClaims[0].status, lang)');
    expect(count(DASHBOARD, /getClaimStatusDisplay\(/g)).toBeGreaterThanOrEqual(2);
    expect(DASHBOARD).not.toMatch(/const\s+STATUS[A-Z_]*\s*=/);
    expect(DASHBOARD).not.toContain("'pending_payment'");
  });

  it('asserts nothing about an account that has nothing in progress', () => {
    // The status line is guarded on a claim actually existing, and the empty
    // branch promises a watch, not a recovery.
    expect(DASHBOARD).toContain('{leadClaimStatus && (');
    expect(DASHBOARD).toContain("t('In progress now', 'Kinachoendelea sasa')");
    expect(DASHBOARD).toContain(
      "'Nothing of yours is in progress yet. File a lost report and we will watch the found-item records for anything that looks like it.'",
    );
    expect(DASHBOARD).toContain(
      "'Something of yours is already with us. Open your claims to see where it stands and what we need from you.'",
    );
  });

  it('keeps the button label and its destination decided by the same fact', () => {
    // The pair cannot drift: both read `hasWorkInProgress`.
    expect(DASHBOARD).toContain("? t('View my claims', 'Ona claims zangu')");
    expect(DASHBOARD).toContain(": t('Report a lost item', 'Ripoti kitu kilichopotea')");
    expect(count(DASHBOARD, /hasWorkInProgress/g)).toBeGreaterThanOrEqual(4);
  });

  it('retires the duplicate navigation the Overview used to carry', () => {
    // The section table is walked once, by the navigation, and the Overview no
    // longer renders its own cards or its own arrow icon.
    expect(count(DASHBOARD, /ACCOUNT_SECTION_ORDER\.map\(/g)).toBe(1);
    expect(DASHBOARD).not.toMatch(/ArrowRight/);
    expect(DASHBOARD).not.toMatch(/<div[^>]*onClick=/);
    // All four destinations stay one labelled click away.
    expect(DASHBOARD).toContain(
      "const ACCOUNT_SECTION_ORDER: AccountSectionKey[] = ['overview', 'lost', 'claims', 'notifications'];",
    );
  });

  it('takes its heading, its hint and its icon from the same section table', () => {
    expect(DASHBOARD).toContain('const sectionCopy = ACCOUNT_SECTIONS[tab][lang];');
    expect(DASHBOARD).toContain('const nextCopy = ACCOUNT_SECTIONS[nextSection][lang];');
    expect(DASHBOARD).toContain('const NextSectionIcon = ACCOUNT_SECTIONS[nextSection].icon;');
    expect(DASHBOARD).toContain('{nextCopy.hint && (');
    expect(DASHBOARD).toContain("hint: 'File a report and check for possible matches.',");
    expect(DASHBOARD).toContain("hint: 'See the claims linked to this account.',");
    expect(DASHBOARD).toContain("hint: 'See updates and your notification history.',");
  });
});

// -----------------------------------------------------------------------------
// The workspace stays operable, and its headings stay honest
// -----------------------------------------------------------------------------

describe('UX-08 keeps the account workspace operable and accessible', () => {
  it('presents the four sections as a labelled navigation of real buttons', () => {
    expect(DASHBOARD).toContain('<nav');
    expect(DASHBOARD).toContain("aria-label={t('Account sections', 'Sehemu za akaunti')}");
    // The navigation is the ONLY hand-rolled <button> in the surface, and it is
    // rendered from the section order — so all four destinations exist.
    expect(count(DASHBOARD, /<button\s/g)).toBe(1);
    expect(DASHBOARD).toContain('{ACCOUNT_SECTION_ORDER.map((key) => {');
    expect(DASHBOARD).toContain('type="button"');
    expect(DASHBOARD).toContain('onClick={() => setTab(key)}');
  });

  it('marks the current section with an accent bar, a tint AND weight', () => {
    // Never colour alone: a tint, an accent bar and a weight change, plus the
    // programmatic `aria-current` below.
    expect(DASHBOARD).toContain('lg:border-l-[3px]');
    expect(DASHBOARD).toContain('border-b-2');
    expect(DASHBOARD).toContain(
      "'border-[var(--appearance-primary)] bg-[var(--appearance-surface-muted)] text-[var(--appearance-primary)] font-extrabold lg:border-l-[var(--appearance-primary)]'",
    );
    // Declared once, inside the map, so every item carries it.
    expect(count(DASHBOARD, /aria-current=\{active \? 'page' : undefined\}/g)).toBe(1);
  });

  it('keeps every interactive target a real control with a real label', () => {
    // A 44px touch target on the nav items (the strip scrolls below lg).
    expect(DASHBOARD).toContain('min-h-11');
    // The three accessible names: the navigation itself and the two icon-only
    // buttons. Nothing else in this surface is icon-only.
    expect(count(DASHBOARD, /aria-label=\{t\(/g)).toBe(3);
    expect(DASHBOARD).toContain("aria-label={t('Refresh', 'Onyesha upya')}");
    expect(DASHBOARD).toContain(
      "aria-label={t('Remove from my account', 'Ondoa kwenye akaunti yangu')}",
    );
  });

  it('gives the workspace ONE page-level heading, shared by every section', () => {
    expect(count(DASHBOARD, /<h1/g)).toBe(1);
    expect(DASHBOARD).toContain('id="account-section-heading"');
    // All four rendered sections point at that single heading.
    expect(count(DASHBOARD, /aria-labelledby="account-section-heading"/g)).toBe(4);
    // ...and its title/description still come from the section table.
    expect(DASHBOARD).toContain('{sectionCopy.title}');
    expect(DASHBOARD).toContain('{sectionCopy.description}');
  });

  it('keeps the customer name out of the heading outline', () => {
    expect(DASHBOARD).toContain(
      '<p className="text-subsection font-extrabold text-[var(--appearance-text-primary)] break-words">{customer.full_name}</p>',
    );
    expect(DASHBOARD).not.toMatch(/<h[1-6][^>]*>\s*\{customer\.full_name\}/);
  });

  it('renders every section sub-heading on the type ladder', () => {
    // Five sub-headings: two in the Overview, three in My Claims. Each climbs
    // the same rung (`text-heading`), so no section can drift off-ladder.
    expect(count(DASHBOARD, /<h2 className="text-heading font-extrabold/g)).toBe(5);
  });

  it('announces loading instead of leaving a silent skeleton', () => {
    expect(DASHBOARD).toContain('aria-busy="true"');
    expect(DASHBOARD).toContain('<span className="sr-only">');
    expect(DASHBOARD).toContain("t('Loading your claims', 'Inapakia claims zako')");
  });

  it('hides every decorative icon from assistive technology', () => {
    // Every icon in this surface repeats adjacent text (or its button's label),
    // so each one is hidden — and there is exactly one hide per icon.
    const iconSizes = count(DASHBOARD, /size=\{ICON_SIZE\.[a-z]+\}/g);
    expect(iconSizes).toBe(10);
    expect(count(DASHBOARD, /aria-hidden="true"/g)).toBe(iconSizes);
  });
});

// -----------------------------------------------------------------------------
// The privacy boundary did not move
// -----------------------------------------------------------------------------

describe('UX-08 keeps the customer privacy boundary exactly where it was', () => {
  const CLAIM_ROUTES_CODE = stripComments(CLAIM_ROUTES);

  it('shows the account its own number masked, and never in full', () => {
    expect(DASHBOARD).toContain("const m = /^\\+254(\\d{9})$/.exec(phone || '');");
    expect(DASHBOARD).toContain("return '0' + d.slice(0, 3) + ' *** ' + d.slice(6);");
    expect(DASHBOARD).toContain('{maskPhone(customer.phone)}');
    // The raw number is never interpolated into the view.
    expect(DASHBOARD).not.toMatch(/\{customer\.phone\}/);
  });

  it('keeps the account identity out of client storage and out of the URL', () => {
    expect(DASHBOARD).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    expect(DASHBOARD).not.toMatch(/window\.location|\.href|pushState|replaceState/);
    // No query string or hash is built anywhere in this surface.
    expect(DASHBOARD).not.toMatch(/\?\$\{|#\$\{/);
  });

  it('reads only the fields the customer-safe projection allows', () => {
    for (const field of FORBIDDEN_CLAIM_FIELDS) {
      expect(DASHBOARD, `the dashboard must not reference ${field}`).not.toContain(field);
    }
    // ...and the allowlisted display fields are exactly what it renders.
    for (const field of [
      'claim.item.document_name_fuzzy',
      'claim.item.category_id',
      'claim.item.location_description',
      'claim.agent.business_name',
      'claim.created_at',
      'claim.expires_at',
      'claim.status',
      'claim.id',
    ]) {
      expect(DASHBOARD, `the dashboard should still render ${field}`).toContain(field);
    }
  });

  it('leaves the server-side projection that defines that boundary in place', () => {
    expect(count(CLAIM_ROUTES_CODE, /function toCustomerSafeClaimView\(/g)).toBe(1);
    // The DTO enumerates the same keys it always did — no field was added to it,
    // and none of the claim internals it exists to withhold crept in.
    const view = sliceBetween(CLAIM_ROUTES_CODE, 'function toCustomerSafeClaimView', '\n}');
    for (const key of [
      'id: row.id',
      'status,',
      'is_active:',
      'created_at:',
      'updated_at:',
      'expires_at:',
      'item: toOwnerSafeItemView(row.item)',
      'agent: toOwnerSafeAgentView(row.agent)',
    ]) {
      expect(view).toContain(key);
    }
    expect(view).not.toMatch(/payment_reference|provider|fraud|security_answers|finder_/);
  });

  it('still routes every claim through that projection, status resolved', () => {
    // Both endpoints that return claims to this surface project through it, and
    // both pass the resolved display status so Active/History stays the
    // server's decision.
    expect(
      count(CLAIM_ROUTES_CODE, /toCustomerSafeClaimView\(row, await resolveDisplayStatus\(row\)\)/g),
    ).toBe(2);
    // Masking stays delegated to the ONE owner-safe implementation — the
    // dashboard may not grow a second copy of an item/agent masking rule.
    expect(DASHBOARD).not.toMatch(/toOwnerSafeItemView|toOwnerSafeAgentView|maskItem|maskAgent/);
  });
});

// -----------------------------------------------------------------------------
// The appearance vocabulary is the shared one
// -----------------------------------------------------------------------------

describe('UX-08 puts the dashboard on the shared appearance vocabulary', () => {
  it('carries none of the pre-UX-01 literals', () => {
    for (const literal of LEGACY_LITERALS) {
      expect(DASHBOARD, `${literal} must not appear on the dashboard`).not.toContain(literal);
    }
  });

  it('uses only appearance tokens the stylesheet actually declares', () => {
    const tokens = Array.from(
      new Set(Array.from(DASHBOARD.matchAll(/var\((--[a-z-]+)\)/g)).map((m) => m[1])),
    );
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(INDEX_CSS, `${token} must be declared in index.css`).toContain(`${token}:`);
    }
    // The semantic families this workspace leans on, all of them paired for both
    // themes by index.css.
    expect(tokens).toEqual(
      expect.arrayContaining([
        '--appearance-surface',
        '--appearance-surface-muted',
        '--appearance-border',
        '--appearance-text-primary',
        '--appearance-text-secondary',
        '--appearance-text-muted',
        '--appearance-primary',
        '--appearance-accent',
        '--appearance-warning',
      ]),
    );
    // No legacy token family survives.
    expect(DASHBOARD).not.toMatch(/var\(--(?:brand|line|status|canvas|ink)/);
  });

  it('climbs the type ladder instead of inventing sizes', () => {
    expect(DASHBOARD).not.toMatch(/\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl)\b/);
    expect(DASHBOARD).not.toMatch(/text-\[\d/);
    for (const rung of [
      'text-caption',
      'text-small',
      'text-body',
      'text-heading',
      'text-subsection',
      'text-section',
    ]) {
      expect(DASHBOARD, `${rung} should be in use`).toMatch(new RegExp(`\\b${rung}\\b`));
    }
  });

  it('takes radius from the radius ladder, and keeps the panels flat-bordered', () => {
    expect(DASHBOARD).not.toMatch(/\brounded-(?:2xl|xl|lg|md|sm|full|none)\b/);
    expect(DASHBOARD).toMatch(/\brounded-panel\b/);
    expect(DASHBOARD).toMatch(/\brounded-standard\b/);
    // The workspace's section contract: a panel radius over a surface fill and a
    // structural border. Borders — not elevation — separate these sections.
    expect(DASHBOARD).toMatch(
      /rounded-panel border border-\[var\(--appearance-border\)\] bg-\[var\(--appearance-surface\)\]/,
    );
  });

  it('keeps any elevation on the two-step ladder, and nothing hand-rolled', () => {
    // The documented hierarchy is flat surface -> subtle border -> subtle
    // shadow -> floating shadow. This workspace separates its sections with
    // borders, so it uses no elevation step itself; the one elevated surface in
    // the Overview comes from the shared StatCard primitive. If elevation is
    // ever added here it must be one of the two ladder steps.
    const shadows = DASHBOARD.match(/\bshadow-[a-z]+/g) || [];
    expect(
      shadows.every((s) => s === 'shadow-raised' || s === 'shadow-floating'),
      `off-ladder elevation: ${shadows.join(', ')}`,
    ).toBe(true);
    expect(DASHBOARD).not.toMatch(/shadow-\[/);
    expect(INDEX_CSS).toContain('--shadow-raised: var(--elevation-raised)');
    expect(INDEX_CSS).toContain('--shadow-floating: var(--elevation-floating)');
  });

  it('sizes every icon from ICON_SIZE and nothing else', () => {
    expect(DASHBOARD).not.toMatch(/\bsize=\{\d+\}/);
    const sizes = DASHBOARD.match(/size=\{[^}]*\}/g) || [];
    expect(sizes.length).toBeGreaterThan(0);
    expect(
      sizes.every((s) => /^size=\{ICON_SIZE\.[a-z]+\}$/.test(s)),
      `off-ladder icon size: ${sizes.join(', ')}`,
    ).toBe(true);
  });

  it('leaves focus entirely to the ONE global focus language', () => {
    // The two local `focus-visible:ring-2` treatments are gone. index.css owns
    // focus app-wide, which is why this file never mentions it.
    expect(count(DASHBOARD, /\bfocus(?:-visible)?:/g)).toBe(0);
    expect(INDEX_CSS).toMatch(/:focus-visible/);
  });

  it('records the migration in the design system', () => {
    expect(DESIGN_SYSTEM).toMatch(/CustomerDashboard.*MIGRATED in UX-08/);
  });
});

// -----------------------------------------------------------------------------
// The workspace stays bilingual
// -----------------------------------------------------------------------------

describe('UX-08 keeps the account workspace bilingual', () => {
  it('translates every string it renders, in both languages', () => {
    // This surface takes the explicit two-argument `t(en, sw)` helper — there is
    // no lookup table to fall back on, so a missing translation is a missing
    // argument. One `t(` call site per pair means no string was rendered in a
    // single language only.
    expect(DASHBOARD).toContain("const t = (en: string, sw: string) => (lang === 'sw' ? sw : en);");
    const pairs = bilingualPairs(DASHBOARD);
    expect(count(DASHBOARD, /\bt\(/g)).toBe(pairs.length);
    expect(pairs.length).toBeGreaterThan(50);
    for (const [en, sw] of pairs) {
      expect(en.trim().length, `empty English copy: ${JSON.stringify(en)}`).toBeGreaterThan(0);
      expect(sw.trim().length, `missing Kiswahili copy for "${en}"`).toBeGreaterThan(0);
      expect(sw, `"${en}" was left untranslated`).not.toBe(en);
    }
  });

  it('ships the recovery copy in both languages', () => {
    const pairs = bilingualPairs(DASHBOARD);
    const required: Array<[string, string]> = [
      ['Where your items stand', 'Hali ya vitu vyako'],
      ['What to do next', 'Cha kufanya baadaye'],
      ['In progress now', 'Kinachoendelea sasa'],
      ['View my claims', 'Ona claims zangu'],
      ['Report a lost item', 'Ripoti kitu kilichopotea'],
      ['Claims linked', 'Claims zilizounganishwa'],
      ['No claims linked yet', 'Hakuna claim iliyounganishwa bado'],
      ['Loading your claims', 'Inapakia claims zako'],
      ['Signed in as', 'Umeingia kama'],
      ['Sign out', 'Toka'],
    ];
    for (const pair of required) {
      expect(pairs, `${pair[0]} / ${pair[1]}`).toEqual(expect.arrayContaining([pair]));
    }
  });

  it('translates the interpolated claims summary too', () => {
    expect(DASHBOARD).toContain('`${activeClaims.length} active, ${historyClaims.length} past`');
    expect(DASHBOARD).toContain(
      '`${activeClaims.length} zinazoendelea, ${historyClaims.length} za nyuma`',
    );
  });

  it('gives the next-step hint in both languages', () => {
    expect(DASHBOARD).toContain("hint: 'File a report and check for possible matches.',");
    expect(DASHBOARD).toContain("hint: 'Wasilisha ripoti na uangalie mechi zinazowezekana.',");
    expect(DASHBOARD).toContain("hint: 'See the claims linked to this account.',");
    expect(DASHBOARD).toContain("hint: 'Ona claims zilizounganishwa na akaunti hii.',");
    expect(DASHBOARD).toContain("hint: 'See updates and your notification history.',");
    expect(DASHBOARD).toContain("hint: 'Tazama taarifa na historia yako.',");
  });

  it('keeps the language a required, typed prop', () => {
    expect(DASHBOARD).toContain("lang: 'en' | 'sw';");
    expect(DASHBOARD).toContain(
      'lang, customer, onSignOut, signingOut = false, onOpenItem, onSessionExpired,',
    );
  });
});
