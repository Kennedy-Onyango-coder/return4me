import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  getLostReportStatusDisplay,
  isSearchingStatus,
  getMatchReasonText,
  LOST_REPORT_MATCH_REASON_KEYS,
  LOST_REPORT_STATUS_VALUES,
  LOST_REPORT_FIELD_LIMITS,
  LOST_REPORT_IDENTIFIER_CLASSES,
  LOST_REPORT_WIZARD_STEPS,
} from '../../../config/lostReportPresentation';
import {
  POSSIBLE_MATCH_NOTICE,
  REPORT_NOT_ACTIVE_NOTICE,
} from '../../../services/lostReportsApi';

// ===========================================================================
// Phase 9C — UX BOUNDARY + PRESENTATION TESTS
//
// Source-level tripwires with the same rationale as the repository's other
// boundary suites (claimsAdminUiBoundary, publicExperience, adminDashboardPrivacy):
// this project has no jsdom / React Testing Library, so the contract is
// asserted against the real source that ships, plus the real exported maps.
//
// What they pin down:
//   * every backend status and every engine match-reason has customer copy;
//   * the shipped copy never claims an item was found or that ownership is
//     confirmed (the API field is `ownership_confirmed`, so comments are
//     stripped before scanning);
//   * no customer-visible file reads or names a private field;
//   * the frontend contains NO matching logic and NO claim/payment call — it
//     consumes Phase 9B and hands off to the existing claim journey.
// ===========================================================================

const repoRoot = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/**
 * Removes line and block comments (including JSX `{/* … *\/}`), so a boundary
 * assertion is about SHIPPED CODE AND COPY rather than about the explanatory
 * comments — several of which deliberately quote the very phrases the copy must
 * avoid ("never say 'we found your item'").
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const PRESENTATION_TS = read('src/config/lostReportPresentation.ts');
const API_TS = read('src/services/lostReportsApi.ts');
const MATCH_VIEW_TS = read('src/services/lostReportMatchView.ts');
const WIZARD_TSX = read('src/components/customer/LostReportWizard.tsx');
const MATCHES_TSX = read('src/components/customer/PossibleMatches.tsx');
const SECTION_TSX = read('src/components/customer/LostReportsSection.tsx');

const CUSTOMER_VISIBLE_SOURCES: Array<[string, string]> = [
  ['config/lostReportPresentation.ts', stripComments(PRESENTATION_TS)],
  ['services/lostReportsApi.ts', stripComments(API_TS)],
  ['components/customer/LostReportWizard.tsx', stripComments(WIZARD_TSX)],
  ['components/customer/PossibleMatches.tsx', stripComments(MATCHES_TSX)],
  ['components/customer/LostReportsSection.tsx', stripComments(SECTION_TSX)],
];

describe('every backend report status has honest customer copy', () => {
  it('maps all five canonical statuses', () => {
    expect(LOST_REPORT_STATUS_VALUES).toHaveLength(5);
    for (const status of LOST_REPORT_STATUS_VALUES) {
      const display = getLostReportStatusDisplay(status, 'en');
      expect(display.label, `no label for ${status}`).toBeTruthy();
      // A raw snake_case token must never reach the customer.
      expect(display.label).not.toBe(status);
      expect(display.label).not.toContain('_');
      expect(getLostReportStatusDisplay(status, 'sw').label).toBeTruthy();
      expect(display.description).toBeTruthy();
    }
  });

  it('marks ONLY active as still searching — the one status the backend matches for', () => {
    expect(isSearchingStatus('active')).toBe(true);
    for (const status of LOST_REPORT_STATUS_VALUES.filter((s) => s !== 'active')) {
      expect(isSearchingStatus(status), `${status} must not claim to be searching`).toBe(false);
    }
  });

  it('treats an unexpected status as inert, never as searching', () => {
    const unknown = getLostReportStatusDisplay('something_new', 'en');
    expect(unknown.searching).toBe(false);
    expect(unknown.variant).toBe('neutral');
  });

  it('covers the closed statuses the API reports via lost_report_not_active', () => {
    for (const closed of ['resolved', 'cancelled', 'lapsed']) {
      expect(isSearchingStatus(closed)).toBe(false);
      expect(getLostReportStatusDisplay(closed, 'en').description).toBeTruthy();
    }
  });
});

describe('match-reason copy matches the engine exactly', () => {
  it('covers every reason Phase 9B can emit, and invents none', () => {
    // Extracted from the engine's own view module rather than hand-listed, so a
    // reason added there without copy here fails this suite.
    const emitted = [...MATCH_VIEW_TS.matchAll(/reasons\.push\('([a-z_]+)'\)/g)].map((m) => m[1]).sort();
    expect(emitted.length).toBeGreaterThan(5);
    expect([...LOST_REPORT_MATCH_REASON_KEYS].sort()).toEqual(emitted);
  });

  it('explains every reason without exposing a value', () => {
    for (const reason of LOST_REPORT_MATCH_REASON_KEYS) {
      for (const lang of ['en', 'sw'] as const) {
        const text = getMatchReasonText(reason, lang);
        expect(text, `${reason} (${lang})`).toBeTruthy();
        expect(text.toLowerCase()).not.toContain('hash');
        expect(text).not.toMatch(/\d{3,}/); // never a number
      }
    }
  });

  it('does not reproduce the identifier for matching_identifier', () => {
    const text = getMatchReasonText('matching_identifier', 'en').toLowerCase();
    expect(text).toContain('identifying detail');
    expect(text).not.toContain('document number');
    expect(text).not.toContain('imei');
  });

  it('returns nothing for an unknown reason rather than a raw token', () => {
    expect(getMatchReasonText('a_reason_that_does_not_exist', 'en')).toBe('');
  });
});

describe('shipped copy never overclaims', () => {
  // Phrases that would assert an outcome Return4me cannot assert from a
  // candidate alone. Checked on comment-stripped source.
  const FORBIDDEN = [
    'we found your item',
    'we have found your item',
    'your item has been found',
    'confirmed match',
    'guaranteed recovery',
    'guaranteed',
    'your item is recovered',
    'ownership is confirmed',
    'we have recovered',
  ];

  it('contains none of the overclaiming phrases', () => {
    for (const [label, source] of CUSTOMER_VISIBLE_SOURCES) {
      const lowered = source.toLowerCase();
      for (const phrase of FORBIDDEN) {
        expect(lowered, `${label} overclaims: "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it('does use the cautious wording instead', () => {
    expect(MATCHES_TSX).toContain('possible match');
    expect(MATCHES_TSX).toContain('This does not confirm ownership');
    expect(WIZARD_TSX).toContain('does not guarantee');
  });

  it('never discloses an engine tolerance to the customer', () => {
    // The 6-hour early window and the 7-day reporting lag are matcher
    // internals; a customer must never be shown them.
    for (const [label, source] of CUSTOMER_VISIBLE_SOURCES) {
      expect(source, `${label} leaked a tolerance`).not.toContain('6-hour');
      expect(source, `${label} leaked a tolerance`).not.toContain('6 hour');
      expect(source, `${label} leaked a tolerance`).not.toContain('7-day');
      expect(source, `${label} leaked a tolerance`).not.toContain('7 day');
      expect(source, `${label} leaked a tolerance`).not.toContain('reporting lag');
    }
  });
});

describe('the customer-visible layer names no private field', () => {
  const PRIVATE_FIELDS = [
    'finder_phone', 'finder_email', 'ocr_extracted_number', 'ocr_extracted_name',
    'document_number_hash', 'assigned_agent_id', 'verified_document_number',
    'latitude', 'longitude', 'customer_id',
  ];

  it('never reads or mentions one', () => {
    for (const [label, source] of CUSTOMER_VISIBLE_SOURCES) {
      for (const field of PRIVATE_FIELDS) {
        expect(source, `${label} references ${field}`).not.toContain(field);
      }
    }
  });

  it('the API client\'s payload type has no identity or contact field', () => {
    const payloadType = API_TS.slice(
      API_TS.indexOf('export interface LostReportCreatePayload'),
      API_TS.indexOf('}', API_TS.indexOf('export interface LostReportCreatePayload')),
    );
    for (const field of ['customerId', 'customer_id', 'phone', 'email', 'finder']) {
      expect(payloadType).not.toContain(field);
    }
  });
});

describe('the frontend does not re-implement matching', () => {
  it('imports nothing from the matching engine', () => {
    for (const [label, source] of CUSTOMER_VISIBLE_SOURCES) {
      expect(source, `${label} imports the engine`).not.toContain('lostReportMatching');
      expect(source, `${label} contains engine logic`).not.toContain('decideCandidate');
      expect(source, `${label} contains engine logic`).not.toContain('evaluateLostReportAgainstItem');
      expect(source, `${label} contains engine logic`).not.toContain('selectLostReportCandidates');
    }
  });

  it('contains no threshold or scoring constant', () => {
    for (const [label, source] of CUSTOMER_VISIBLE_SOURCES) {
      expect(source, `${label}`).not.toContain('MIN_DISTINGUISHING_MATCHES');
      expect(source, `${label}`).not.toContain('SIGNAL_WEIGHTS');
      expect(source, `${label}`).not.toContain('TIME_EARLY_TOLERANCE');
      expect(source, `${label}`).not.toContain('TIME_REPORTING_LAG');
    }
  });
});

describe('the frontend cannot create a claim, a payment or an escrow', () => {
  it('the API client makes exactly one write: creating a lost report', () => {
    const methods = [...stripComments(API_TS).matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
    // Every read is a GET, and the ONLY non-GET call in the whole client is
    // creating a lost report. There is no update, no delete and no mutation of
    // anything else — so the UI has no way to create a claim, take a payment,
    // move an item's state, or alter a report.
    expect(methods.filter((m) => m !== 'GET')).toEqual(['POST']);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(methods).not.toContain(method);
    }
  });

  it('no customer-visible file touches a claim, payment, refund or escrow endpoint', () => {
    for (const [label, source] of CUSTOMER_VISIBLE_SOURCES) {
      for (const forbidden of ['/api/claims', '/api/items', 'escrow', 'refund', 'mpesa', 'm-pesa']) {
        expect(source.toLowerCase(), `${label} touches ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('a match card\'s only navigation is into the EXISTING public item page', () => {
    expect(MATCHES_TSX).toContain('onOpenItem(candidate.id)');
    // App wires that to /item/:id, where the existing "It's Mine" journey starts.
    const appTsx = stripComments(read('src/App.tsx'));
    expect(appTsx).toContain('onOpenItem={(itemId) => navigate(itemPath(itemId), \'home\')}');
  });
});

describe('the notices come from the server, not a second copy', () => {
  it('the client constants equal the Phase 9B server constants', () => {
    const serverNotice = /export const POSSIBLE_MATCH_NOTICE = '([^']+)'/.exec(MATCH_VIEW_TS);
    const serverInactive = /export const REPORT_NOT_ACTIVE_NOTICE = '([^']+)'/.exec(MATCH_VIEW_TS);
    expect(serverNotice?.[1]).toBe(POSSIBLE_MATCH_NOTICE);
    expect(serverInactive?.[1]).toBe(REPORT_NOT_ACTIVE_NOTICE);
  });

  it('the closed-report panel is driven by that notice, not an ad-hoc string', () => {
    expect(MATCHES_TSX).toContain('data.notice === REPORT_NOT_ACTIVE_NOTICE');
  });
});

describe('the wizard mirrors the server contract instead of inventing rules', () => {
  it('its field limits are exactly the server\'s', () => {
    const routesTs = read('src/routes/lostReports.ts');
    const start = routesTs.indexOf('const FIELD_LIMITS = {');
    const end = routesTs.indexOf('} as const;', start);
    const serverLimits: Record<string, number> = {};
    for (const match of routesTs.slice(start, end).matchAll(/(\w+):\s*(\d+)/g)) {
      serverLimits[match[1]] = Number(match[2]);
    }
    expect(serverLimits).toEqual({ ...LOST_REPORT_FIELD_LIMITS });
  });

  it('its minimum lengths are exactly the server\'s', () => {
    const routesTs = read('src/routes/lostReports.ts');
    const area = /const LOCATION_AREA_MIN_LENGTH = (\d+)/.exec(routesTs);
    const docNumber = /const DOCUMENT_NUMBER_MIN_LENGTH = (\d+)/.exec(routesTs);
    expect(Number(area?.[1])).toBe(2);
    expect(Number(docNumber?.[1])).toBe(3);
  });

  it('is four bounded steps', () => {
    expect(LOST_REPORT_WIZARD_STEPS).toHaveLength(4);
    expect(WIZARD_TSX).toContain('<Stepper');
    expect(WIZARD_TSX).toContain('LOST_REPORT_WIZARD_STEPS.map');
  });

  it('labels every field (a placeholder is never the only label)', () => {
    const fields = (WIZARD_TSX.match(/<(Input|Select|Textarea)\b/g) || []).length;
    const labels = (WIZARD_TSX.match(/\n\s+label=\{/g) || []).length;
    expect(fields).toBeGreaterThan(8);
    expect(labels).toBeGreaterThanOrEqual(fields);
  });

  it('shows the identifier CLASS in the review, never the number itself', () => {
    const reviewBlock = WIZARD_TSX.slice(
      WIZARD_TSX.indexOf('STEP 4 — REVIEW'),
      WIZARD_TSX.indexOf('NAVIGATION'),
    );
    expect(reviewBlock).toContain('identifierClassLabel(');
    expect(reviewBlock).toContain("t('recorded', 'imewekwa')");
    // The raw value is never interpolated into the summary.
    expect(reviewBlock).not.toContain('{form.documentNumber}');
    expect(reviewBlock).not.toContain('${form.documentNumber}');
  });

  it('offers only identifier classes the platform actually knows', () => {
    // Every value is either a live category id or one of the two identifier
    // classes Phase 9A documented for this field.
    const taxonomy = read('src/config/categoryTaxonomy.ts');
    for (const entry of LOST_REPORT_IDENTIFIER_CLASSES) {
      const isCategory = taxonomy.includes(`'${entry.value}'`);
      const isIdentifierClass = entry.value === 'imei' || entry.value === 'serial';
      expect(isCategory || isIdentifierClass, `${entry.value} is neither`).toBe(true);
    }
  });
});

describe('empty and closed states are honest', () => {
  it('offers the reporting action when there are no reports', () => {
    expect(SECTION_TSX).toContain("You haven't reported a lost item yet");
    expect(SECTION_TSX).toContain("t('Report something lost', 'Ripoti kitu kilichopotea')");
  });

  it('says "no possible matches yet" without implying the item is gone', () => {
    expect(MATCHES_TSX).toContain('No possible matches yet');
    expect(MATCHES_TSX).toContain('keep using the information in this report');
    expect(MATCHES_TSX).not.toContain('permanently lost');
    expect(MATCHES_TSX).not.toContain('cannot be found');
  });

  it('checks the closed-report notice BEFORE it can render the empty state', () => {
    // Branch order in the source is the render order: a closed report can
    // therefore never fall through to the "we will keep looking" copy.
    expect(MATCHES_TSX.indexOf('REPORT_NOT_ACTIVE_NOTICE'))
      .toBeLessThan(MATCHES_TSX.indexOf('No possible matches yet'));
    expect(MATCHES_TSX).toContain('Matching is no longer active for this report');
  });

  it('does not offer the match affordance on a closed report', () => {
    expect(SECTION_TSX).toContain('status.searching &&');
  });
});


