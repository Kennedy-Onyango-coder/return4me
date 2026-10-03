// =============================================================================
// RETURN4ME UX-06 — PUBLIC ITEM DETAIL (/item/:id)
// =============================================================================
// WHAT THIS SUITE IS
//   The focused contract for the public found-item DETAIL page. It pins the
//   page's information hierarchy, its bilingual copy, its accessibility, its
//   UX-01 design contracts and — most importantly — the PUBLIC/PRIVATE DATA
//   BOUNDARY it renders from, checked against the REAL public read model
//   (services/publicItemView.ts), not against a hand-written fixture of what we
//   hope that read model returns.
//
// HOW IT IS WRITTEN (and what it deliberately is not)
//   Source-level tripwires plus one real-DTO assertion block, matching this
//   repository's other UX batches (foundItemJourneyUx05, lostReportWizardUx04,
//   homepageUx03Hierarchy, publicChromeUx02): there is no jsdom / React Testing
//   Library harness here, so presentation contracts are asserted against the
//   source that actually ships — with comments removed, so prose can neither
//   satisfy a "must exist" pin nor defeat a "must never come back" tripwire.
//
//   SCOPE: this suite does NOT restate what other suites already own —
//     * the HTTP boundary of GET /api/items/:id/public, its 404-for-everything
//       behaviour and the claim/pickup authorization model: publicItemJourney,
//       claimStatusPrivacy, phase16Batch2aSecurityIntegrity;
//     * the "It's Mine" -> session -> claim hand-off: publicExperience,
//       homepageCtaJourneyBatch5, claimEntryAuthContract, claimSubmitCustomerAuth;
//     * the county-level geography policy: countyAwareSearchAndSurfacing.
//   Those stay authoritative and are not duplicated here (and therefore cannot
//   contradict each other).
//
// WHAT A LATER CHANGE WOULD TRIP
//   * rendering an item field the public DTO does not publish, or reading a
//     private one (coordinates, OCR identity, finder contact, internal ids);
//   * dropping the item's identity, its public status, its found location/date,
//     its primary claim action or the privacy explanation;
//   * removing either language of any visible string;
//   * reintroducing off-ladder type/radius/icon sizes, raw palette classes, a
//     local focus ring or a browser-native dialog on this surface;
//   * making the mobile layout a cramped two-column grid.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { toPublicItemView } from '../services/publicItemView';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/**
 * Source with comments removed and line endings normalised (the same treatment
 * foundItemJourneyUx05 uses): a maintenance comment must never satisfy a
 * "must exist" pin, and must never trip a "must not contain" guard.
 */
const stripComments = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/(^|[\s{(,;=[])\/\*[\s\S]*?\*\//g, '$1')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\r\n/g, '\n');

const ITEM_TSX = read('src/components/PublicItemView.tsx');
const ITEM = stripComments(ITEM_TSX);
const BUTTON_TSX = read('src/components/ui/Button.tsx');
const BADGE_TSX = read('src/components/ui/Badge.tsx');
const INDEX_CSS = read('src/index.css');

/** One bilingual literal, written the way this component writes its copy. */
const copy = (en: string, sw: string) => `t('${en}', '${sw}')`;

/** true when the component reads the public DTO's `item.<field>`. */
const readsItem = (field: string) => new RegExp(`\\bitem\\??\\.(?:agent\\??\\.)?${field}\\b`).test(ITEM);

/** Every `t('english', 'kiswahili')` pair in a source string. */
function bilingualPairs(source: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const re = /\bt\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) pairs.push([match[1], match[2]]);
  return pairs;
}

// -----------------------------------------------------------------------------
// A fully populated raw item row — the shape the API boundary actually receives
// — plus the raw hub row. Both carry every private value the platform holds, so
// "the page only ever renders what the public DTO publishes" is proven against
// real data rather than against a conveniently empty fixture.
// -----------------------------------------------------------------------------
const SECRET_OCR_NUMBER = 'OCR-SECRET-UX06';
const SECRET_OCR_NAME = 'OCR SECRET NAME';
const SECRET_DOC_HASH = 'HASH-SECRET-UX06';
const SECRET_FINDER_PHONE = '+254799999906';
const SECRET_FINDER_EMAIL = 'finder-secret-ux06@example.com';
const SECRET_LATITUDE = -1.2921;
const SECRET_LONGITUDE = 36.8219;

function rawItem(overrides: Record<string, any> = {}) {
  return {
    id: 'R4M-123ABC',
    category_id: 'national-id',
    photo_url: 'https://photos.example/item.jpg',
    ocr_extracted_number: SECRET_OCR_NUMBER,
    ocr_extracted_name: SECRET_OCR_NAME,
    document_number_hash: SECRET_DOC_HASH,
    document_name_fuzzy: 'National ID',
    found_county: 'Nairobi City',
    administrative_unit_id: 'unit-roysambu',
    location_description: 'Moi Avenue, Nairobi',
    latitude: SECRET_LATITUDE,
    longitude: SECRET_LONGITUDE,
    finder_phone: SECRET_FINDER_PHONE,
    finder_email: SECRET_FINDER_EMAIL,
    assigned_agent_id: 'AGT-1',
    status: 'at_agent',
    flaggedForReview: true,
    isDescriptionOnly: false,
    description: 'Black leather wallet with a broken zipper',
    is_sensitive_document: false,
    rejection_reason: null,
    locked_total_fee: '500.00',
    declared_value: '20000',
    verification_status: 'confirmed_as_reported',
    created_at: '2026-03-03T09:15:00.000Z',
    ...overrides,
  } as any;
}

const RAW_AGENT = {
  id: 'AGT-1',
  business_name: 'Test Hub Business',
  contact_phone: '+254711111111',
  location_address: 'Moi Avenue, Nairobi CBD, Shop 14B',
  latitude: -1.28,
  longitude: 36.82,
  mpesa_till_or_paybill: 'TILL-SECRET-777',
  national_id_hash: 'AGENT-ID-HASH',
} as any;

// The exact public read model (services/publicItemView.ts). Pinned as the
// allow-list this page may render from; a widening of the DTO, or a page field
// the DTO never publishes, fails here.
const PUBLIC_DTO_KEYS = [
  'id',
  'category_id',
  'photo_url',
  'is_sensitive_document',
  'document_name_fuzzy',
  'found_county',
  'administrative_unit_id',
  'administrative_unit_name',
  'location_description',
  'description',
  'isDescriptionOnly',
  'created_at',
  'status',
  'agent',
];

// The fields this page actually renders out of that read model. Each one is
// asserted BOTH ways below: the DTO must publish it, and the page must render
// it — so removing either half is caught.
const RENDERED_ITEM_FIELDS = [
  'photo_url',
  'is_sensitive_document',
  'document_name_fuzzy',
  'found_county',
  'administrative_unit_name',
  'location_description',
  'description',
  'created_at',
  'status',
];

// Values and column names that must never reach the public page. Names that are
// column identifiers are checked against the source text; values are checked
// against the real public DTO output, so an accidental pass-through is caught by
// the data, not by a naming convention.
const NEVER_READ_ITEM_FIELDS = [
  'ocr_extracted_number',
  'ocr_extracted_name',
  'document_number_hash',
  'finder_phone',
  'finder_email',
  'latitude',
  'longitude',
  'assigned_agent_id',
  'locked_total_fee',
  'declared_value',
  'rejection_reason',
  'verification_status',
  'security_answers',
  'owner_phone',
  'owner_id_proof_url',
  'owner_identifying_details',
  'payment_reference',
  'flaggedForReview',
  'claimed_by_owner_id',
];

describe('UX-06 public data boundary — the page renders only the published read model', () => {
  const view = toPublicItemView(rawItem(), RAW_AGENT);

  it('the read model it renders from is exactly the public allow-list', () => {
    expect(Object.keys(view).sort()).toEqual([...PUBLIC_DTO_KEYS].sort());
  });

  it('every field the page renders is a field the public DTO publishes', () => {
    for (const field of RENDERED_ITEM_FIELDS) {
      expect(view, `the public DTO must publish ${field}`).toHaveProperty(field);
      expect(readsItem(field), `the page must render item.${field}`).toBe(true);
    }
  });

  it('renders the hub only through the two fields the public DTO reduces it to', () => {
    // business_name + the coarse area, and nothing else.
    expect(Object.keys(view.agent).sort()).toEqual(['business_name', 'rough_area']);
    expect(ITEM).toContain('item?.agent?.business_name');
    expect(ITEM).toContain('item?.agent?.rough_area');
  });

  it('never reads a private column, and the DTO never carries one', () => {
    for (const field of NEVER_READ_ITEM_FIELDS) {
      expect(readsItem(field), `the page must not read ${field}`).toBe(false);
      expect(ITEM, `the page must not mention ${field}`).not.toContain(field);
      expect(view, `the public DTO must not publish ${field}`).not.toHaveProperty(field);
    }
  });

  it('exposes no coordinate, no OCR identity, no finder contact and no internal id', () => {
    const json = JSON.stringify(view);
    for (const secret of [
      SECRET_OCR_NUMBER,
      SECRET_OCR_NAME,
      SECRET_DOC_HASH,
      SECRET_FINDER_PHONE,
      SECRET_FINDER_EMAIL,
      '36.82',
      '-1.2921',
      'AGT-1',
    ]) {
      expect(json, `the public DTO leaked ${secret}`).not.toContain(secret);
      expect(ITEM, `the page source mentions ${secret}`).not.toContain(secret);
    }
    // The structured sub-county is published as a NAME; the internal unit id it
    // was resolved from is deliberately not rendered.
    expect(view.administrative_unit_id).toBe('unit-roysambu');
    expect(ITEM).not.toContain('administrative_unit_id');
  });

  it('withholds a sensitive document photo and description before the page can render them', () => {
    const sensitiveView = toPublicItemView(rawItem({ is_sensitive_document: true }), RAW_AGENT);
    expect(sensitiveView.photo_url).toBeNull();
    expect(sensitiveView.description).toBeNull();
    // ...so the "hidden" panel, and the absence of a description row, are the
    // server's decision rather than a client-side hide.
    expect(ITEM).toContain(copy('Photo hidden for privacy', 'Picha imefichwa kwa faragha'));
    expect(ITEM).toContain('{identifyingDetails ? (');
  });
});

describe('UX-06 item identity — name, status, image and its fallback', () => {
  it('titles the item with the live category name, as the discovery card does', () => {
    expect(ITEM).toContain('categories.find(');
    expect(ITEM).toContain('cat.name_en');
    expect(ITEM).toContain('cat.name_sw');
    expect(ITEM).toContain('{itemTitle}');
  });

  it('shows the item status in the established vocabulary, on the shared Badge', () => {
    expect(ITEM).toContain('<Badge variant="info" icon={ShieldCheck}>');
    expect(ITEM).toContain(copy('Held by an agent', 'Inashikiliwa na wakala'));
    expect(ITEM).toContain(copy('Found', 'Imepatikana'));
    expect(ITEM).toContain("item?.status === 'at_agent'");
    // No invented lifecycle state is consulted on this surface.
    expect(ITEM).not.toMatch(/item\??\.status\s*===\s*'(?!at_agent\b)/);
  });

  it('renders the photograph with meaningful bilingual alt text', () => {
    expect(ITEM).toContain('{item.photo_url ? (');
    expect(ITEM).toContain('alt={t(');
    expect(ITEM).toContain('found and held by a Return4me agent');
    expect(ITEM).toContain('iliyopatikana na kushikiliwa na wakala wa Return4me');
    expect(ITEM).toContain('loading="lazy"');
    expect(ITEM).not.toContain('alt=""');
    // The photograph is content, not decoration.
    expect(ITEM).not.toMatch(/<img[\s\S]{0,400}?aria-hidden/);
  });

  it('makes a missing photograph feel deliberate rather than broken', () => {
    expect(ITEM).toContain(copy('No photo available', 'Hakuna picha'));
    expect(ITEM).toContain('item.is_sensitive_document ? (');
    expect(ITEM).toContain('This is a sensitive document, so its photograph is never published.');
    expect(ITEM).toContain(
      'The finder reported this item without a photograph, so the details below are the only way to recognise it.'
    );
  });
});

describe('UX-06 found location and found date', () => {
  it('composes the location line only from the permitted public geography', () => {
    for (const field of ['found_county', 'administrative_unit_name', 'location_description']) {
      expect(readsItem(field), `the page must render item.${field}`).toBe(true);
    }
    expect(ITEM).toContain(".join(' · ')");
    // Absent parts are dropped rather than rendered as a stray separator...
    expect(ITEM).toContain(".filter((part: any) => typeof part === 'string' && part.trim().length > 0)");
    // ...and there is no "not published" placeholder standing in for real data.
    expect(ITEM).not.toMatch(/location_description\s*\|\|/);
    expect(ITEM).not.toContain('Location not published');
    expect(ITEM).not.toContain('Mahali hakujachapishwa');
  });

  it("renders the found date in the product's human-readable form, at day precision", () => {
    expect(readsItem('created_at')).toBe(true);
    expect(ITEM).toContain("toLocaleDateString(sw ? 'sw-KE' : 'en-US'");
    expect(ITEM).toContain("month: 'short'");
    expect(ITEM).toContain("day: 'numeric'");
    expect(ITEM).toContain("year: 'numeric'");
    // No raw ISO timestamp and no invented clock-time precision.
    expect(ITEM).not.toContain('toISOString');
    expect(ITEM).not.toMatch(/\d{2}:\d{2}/);
  });

  it('renders every fact row conditionally, so a missing value is simply absent', () => {
    for (const derived of ['locationLine', 'foundDate', 'identifyingDetails', 'heldAtLine']) {
      expect(ITEM, `${derived} must be rendered conditionally`).toContain(`{${derived} ? (`);
    }
    expect(ITEM).not.toContain('${undefined');
    expect(ITEM).not.toContain('String(undefined');
    expect(ITEM).not.toContain('String(null');
  });

  it('labels every fact row from the caption step, never below the 12px floor', () => {
    expect(ITEM).toContain("const factLabelClass = 'text-caption font-bold uppercase tracking-wider");
    expect(ITEM).toContain("const factValueClass = 'mt-1 break-words text-body-large");
    expect(ITEM).toContain(copy('Found location', 'Mahali ilipopatikana'));
    expect(ITEM).toContain(copy('Found date', 'Tarehe ilipopatikana'));
    expect(ITEM).toContain(copy('Identifying details', 'Maelezo ya kutambua'));
    expect(ITEM).toContain(copy('Held at', 'Inashikiliwa'));
  });
});

describe('UX-06 the primary action is the existing claim entry point', () => {
  const handoff = ITEM.slice(0, ITEM.indexOf('const backLink'));

  it('keeps exactly one claim control, wired to the existing handler', () => {
    expect(ITEM).toContain('onClick={handleClaimClick}');
    expect((ITEM.match(/onClick=\{handleClaimClick\}/g) || []).length).toBe(1);
    expect(ITEM.match(/<Button/g) || []).toHaveLength(4); // 1 in each state branch
  });

  it('keeps the established business wording for the action', () => {
    expect(ITEM).toContain('{t("It\'s Mine", \'Ni Yangu\')}');
    // ...and does not replace it with marketing language.
    expect(ITEM).not.toMatch(/Claim Now|Start Claim|Get Started|Buy/i);
  });

  it('makes the action visually dominant and at least 44px tall', () => {
    const cta = ITEM.slice(ITEM.indexOf('onClick={handleClaimClick}') - 500);
    expect(cta).toContain('variant="accent"');
    expect(cta).toContain('size="lg"');
    expect(cta).toContain('className="w-full"');
    expect(cta).toContain('loading={claimBusy}');
    // The ladder itself: md = 44px, lg = 52px, measured by the primitive.
    expect(BUTTON_TSX).toContain("md: 'h-11 px-5 text-body rounded-standard'");
    expect(BUTTON_TSX).toContain("lg: 'h-13 px-6 text-body-large rounded-standard'");
  });

  it('still proves the session before entering the claim journey, and fails closed', () => {
    expect(ITEM).toContain("fetch('/api/customer/me', { credentials: 'same-origin' })");
    expect(ITEM).toMatch(/if \(res\.ok\) \{\s*\n\s*onContinueClaim\(item\)/);
    expect(ITEM).toMatch(/catch \{[\s\S]{0,240}onRequireAuth\(\)/);
    // The busy/empty guard that keeps a double-press from double-navigating.
    expect(ITEM).toContain('if (claimBusy || !item) return;');
    expect(handoff).toContain('setClaimBusy(true)');
  });

  it('creates no second claim implementation on the public surface', () => {
    expect(ITEM).not.toMatch(/method:\s*'POST'/);
    expect(ITEM).not.toMatch(/\/api\/claims\//);
    expect(ITEM).not.toMatch(/\/(pay|request-otp|pickup-details)/);
    // Its only data sources are the masked public read model and the session check.
    expect(ITEM).toMatch(/\/api\/items\/\$\{encodeURIComponent\(itemId\)\}\/public/);
    expect(ITEM.match(/fetch\(/g) || []).toHaveLength(2);
  });
});

describe('UX-06 the privacy explanation', () => {
  const PRIVACY_EN =
    'Anyone can open this page, so it shows only what helps the rightful owner recognise the item. Full names, document numbers and a finder’s contact details are never published, and proof of ownership is collected only inside the private claim process.';
  const PRIVACY_SW =
    'Mtu yeyote anaweza kufungua ukurasa huu, kwa hivyo unaonyesha tu yale yanayomsaidia mmiliki halisi kutambua bidhaa. Majina kamili, namba za hati na mawasiliano ya aliyekipata hayachapishwi kamwe, na uthibitisho wa umiliki hukusanywa tu ndani ya mchakato wa faragha wa kudai.';

  it('explains, in both languages, why some details are limited', () => {
    expect(ITEM).toContain(copy('Why some details stay private', 'Kwa nini baadhi ya maelezo hayachapishwi'));
    expect(ITEM).toContain(PRIVACY_EN);
    expect(ITEM).toContain(PRIVACY_SW);
    // One real heading, named for assistive tech, on the shared primitive.
    expect(ITEM).toContain('<SectionHeading');
    expect(ITEM).toContain('titleId="item-privacy-heading"');
    expect(ITEM).toContain('aria-labelledby="item-privacy-heading"');
  });

  it('keeps the explanation in customer language — no internal vocabulary', () => {
    const explanation = ITEM.slice(ITEM.lastIndexOf('Why some details stay private')).toLowerCase();
    // Whole words only: "hayachapishwi" contains the letters "api" without
    // being the word, and a substring guard would fail on its own translation.
    for (const term of ['escrow', 'api', 'database', 'sql', 'token', 'hash', 'otp', 'endpoint', 'schema']) {
      expect(explanation, `the privacy explanation must not use "${term}"`).not.toMatch(
        new RegExp(`\\b${term}\\b`),
      );
    }
    // It supports the verification the claim flow performs rather than
    // describing how that verification is implemented.
    expect(explanation).toContain('proof of ownership');
    expect(explanation).toContain('uthibitisho wa umiliki');
  });
});

describe('UX-06 loading, not-found and error states', () => {
  it('keeps all four states, with a route back to discovery from the dead ends', () => {
    expect(ITEM).toContain("state === 'loading'");
    expect(ITEM).toContain("{state === 'ready' && item && (");
    expect(ITEM).toContain("state === 'not_found'");
    expect(ITEM).toContain("state === 'error'");
    expect(ITEM).toContain(copy('Browse found items', 'Angalia vitu vilivyopatikana'));
    expect(ITEM).toContain(copy('Try again', 'Jaribu tena'));
    expect(ITEM).toContain('onClick={loadItem}');
  });

  it('treats every non-public item as one state and never renders a server message', () => {
    expect(ITEM).toContain('if (res.status === 404)');
    expect(ITEM).toContain("setState('not_found')");
    // The API's own error string is never surfaced on the page.
    expect(ITEM).not.toContain('data.error');
    expect(ITEM).not.toContain('err.message');
    expect(ITEM).not.toMatch(/error\.message/);
  });

  it('uses no browser-native dialog and leaks no exception detail', () => {
    expect(ITEM).not.toMatch(/window\.(?:prompt|confirm|alert)\s*\(/);
    expect(ITEM).not.toMatch(/JSON\.stringify\(\s*(?:err|e)\s*\)/);
    expect(ITEM).toContain('Something went wrong on our side. Please try again.');
  });
});

describe('UX-06 accessibility', () => {
  it('has one page-level heading per state, and a semantic heading for the privacy note', () => {
    expect((ITEM.match(/<h1\b/g) || []).length).toBe(3);
    expect((ITEM.match(/<h1 className="[^"]*text-section/g) || []).length).toBe(3);
    expect(ITEM).toContain('<SectionHeading');
    // The fact rows are a description list, so label/value pairing is real.
    expect(ITEM).toContain('<dl className="mt-6 space-y-4">');
    expect(ITEM).toContain('<dt className={factLabelClass}>');
    expect(ITEM).toContain('<dd className={factValueClass}>');
  });

  it('keeps one polite live region that announces the state the page is in', () => {
    expect((ITEM.match(/aria-live=/g) || []).length).toBe(1);
    expect(ITEM).toContain('role="status"');
    expect(ITEM).toContain('role="alert"');
    expect(ITEM).toContain('{stateAnnouncement}');
    expect(ITEM).toContain(copy('Found item loaded', 'Bidhaa imepakiwa'));
    expect(ITEM).toContain('className="sr-only" role="status" aria-live="polite"');
  });

  it('keeps the primary action reachable, labelled and on the 44px floor', () => {
    expect(ITEM).toContain("loadingLabel={t('Checking your session…', 'Inaangalia kipindi chako…')}");
    expect(ITEM).toContain('{t("It\'s Mine", \'Ni Yangu\')}');
    // The subordinate back link clears the touch-target floor too.
    expect(ITEM).toContain('min-h-11');
  });

  it('sizes every icon from the shared ladder and hides it from assistive tech', () => {
    for (const icon of ['ArrowLeft', 'AlertCircle', 'Loader2', 'Lock', 'Package']) {
      expect(ITEM, `${icon} must be decorative`).toMatch(new RegExp(`<${icon}[\\s\\S]{0,220}?aria-hidden="true"`));
    }
    expect(ITEM).toContain('ICON_SIZE.feature');
    expect(ITEM).toContain('ICON_SIZE.ui');
    expect(ITEM).not.toMatch(/size=\{\d/);
    expect(BADGE_TSX).toContain('aria-hidden="true"');
  });

  it('does not suppress or duplicate the single global focus treatment', () => {
    expect(ITEM).not.toContain('outline-none');
    expect(ITEM).not.toContain('focus:ring');
    expect(ITEM).not.toContain('focus-visible:');
    // Reduced motion is honoured globally, which is what neutralises the
    // loading spinner and the panel transitions on this page.
    expect(INDEX_CSS).toContain('prefers-reduced-motion');
  });
});

describe('UX-06 design and responsive contracts (UX-01)', () => {
  it('sits on the public page container without going full-width', () => {
    expect(ITEM).toContain('mx-auto max-w-5xl');
    expect(ITEM).toContain('px-5 sm:px-12');
  });

  it('is mobile-first: one column, then a deliberate two-column composition', () => {
    expect(ITEM).toContain('grid grid-cols-1 md:grid-cols-2');
    expect(ITEM).not.toMatch(/\bsm:grid-cols-2\b/);
    // The photograph keeps its own aspect on mobile and fills the column on
    // desktop, so neither layout stretches or clips it.
    expect(ITEM).toContain('relative aspect-[4/3]');
    expect(ITEM).toContain('md:aspect-auto');
    expect(ITEM).toContain('md:min-h-64');
    expect(ITEM).not.toMatch(/w-\[\d+px\]/);
    expect(ITEM).not.toMatch(/min-w-\[\d+px\]/);
  });

  it('uses the type, radius, elevation and appearance ladders', () => {
    expect(ITEM).not.toMatch(/text-\[\d+px\]/);
    for (const token of [
      '--appearance-background',
      '--appearance-surface',
      '--appearance-surface-muted',
      '--appearance-border',
      '--appearance-text-primary',
      '--appearance-text-muted',
      '--appearance-primary',
      '--appearance-danger',
    ]) {
      expect(ITEM, `missing appearance token ${token}`).toContain(token);
    }
    expect(ITEM).toContain('rounded-panel');
    expect(ITEM).toContain('rounded-compact');
    expect(ITEM).not.toMatch(/rounded-(?:xl|2xl|3xl)/);
    expect(ITEM).toContain('shadow-raised');
    expect(ITEM).not.toMatch(/shadow-\[/);
    expect(ITEM).toContain('text-section');
    expect(ITEM).toContain('text-page');
    expect(ITEM).toContain('text-body-large');
    expect(ITEM).toContain('text-caption');
  });

  it('takes every colour from an appearance token, and drops the legacy literals', () => {
    expect(ITEM).not.toMatch(
      /\b(?:bg|text|border|ring)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/,
    );
    for (const legacy of [
      'bg-white',
      'border-brand-border',
      'text-brand-muted-text',
      'text-brand-dark-text',
      'bg-brand-light-gray',
      'bg-brand-beige',
      'text-status-danger',
      'text-primary-green',
      'text-accent-orange',
    ]) {
      expect(ITEM, `legacy literal ${legacy} must be gone`).not.toContain(legacy);
    }
  });
});

describe('UX-06 every visible string is bilingual', () => {
  it('has a real Swahili counterpart for every English string', () => {
    const pairs = bilingualPairs(ITEM);
    expect(pairs.length).toBeGreaterThanOrEqual(24);
    for (const [en, sw] of pairs) {
      expect(en.trim().length, 'empty English string').toBeGreaterThan(0);
      expect(sw.trim().length, `missing Swahili for "${en}"`).toBeGreaterThan(0);
      expect(sw, `untranslated: ${en}`).not.toBe(en);
    }
  });

  it('covers the journey-critical strings in both languages', () => {
    for (const [en, sw] of [
      ['Back to home', 'Rudi nyumbani'],
      ['Item not found', 'Bidhaa haipatikani'],
      ['Browse found items', 'Angalia vitu vilivyopatikana'],
      ['Loading this found item…', 'Inapakia bidhaa hii iliyopatikana…'],
      ['Why some details stay private', 'Kwa nini baadhi ya maelezo hayachapishwi'],
      ['Photo hidden for privacy', 'Picha imefichwa kwa faragha'],
    ] as const) {
      expect(ITEM, `missing English copy: ${en}`).toContain(`'${en}'`);
      expect(ITEM, `missing Swahili copy: ${sw}`).toContain(`'${sw}'`);
    }
  });
});

