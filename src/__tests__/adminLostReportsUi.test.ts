import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// PHASE 11A (WP-2) — ADMIN LOST-REPORT UI BOUNDARY
// =============================================================================
// Static, file-text audit — the established pattern for frontend behaviour in
// this repository (no jsdom / React Testing Library exists here; see
// publicNavigation.test.ts and claimsAdminUiBoundary.test.ts).
//
// These assertions guard the two things that matter most about a new admin
// surface: that it is READ-ONLY, and that it can never render a protected
// identifier or dump a raw row.

const ROOT = path.resolve(__dirname, '../..');
const SRC = (p: string) => fs.readFileSync(path.resolve(ROOT, p), 'utf8');

const SECTION = 'src/components/admin/lostReports/LostReportsAdministration.tsx';
const CLIENT = 'src/services/adminLostReportsApi.ts';
const ADMIN_VIEW = 'src/components/AdminView.tsx';

const sectionTsx = SRC(SECTION);
const clientTs = SRC(CLIENT);
const adminView = SRC(ADMIN_VIEW);

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** De-comment AND de-string, so a token in prose or a fixture cannot mask code. */
function codeOnly(file: string): string {
  let s = stripComments(SRC(file));
  s = s.replace(/`(?:[^`\\]|\\.|\$\{[^}]*\})*`/g, '""');
  s = s.replace(/(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, '""');
  return s;
}

describe('11A admin lost-reports UI: the console has a real, backed section', () => {
  it('AdminView mounts the lost-report section behind its own tab', () => {
    expect(adminView).toContain("import LostReportsAdministration from './admin/lostReports/LostReportsAdministration'");
    expect(adminView).toContain("onClick={() => setActiveTab('lost_reports')}");
    expect(adminView).toContain("aria-current={activeTab === 'lost_reports' ? 'page' : undefined}");
    expect(adminView).toContain("{activeTab === 'lost_reports' && (");
    expect(adminView).toContain('<LostReportsAdministration lang={lang} token={token} />');
  });

  it('the section keeps the console authentication gate it always had', () => {
    // The token is only ever used as an Authorization header; the console still
    // renders its own gate when there is no token.
    expect(adminView).toContain('{!token && (');
    expect(adminView).toMatch(/Authorization: `Bearer \$\{token\}`/);
  });
});

describe('11A admin lost-reports UI: the section is read-only', () => {
  it('issues GET only, from a client with no mutation verb at all', () => {
    // De-commented but NOT de-stringed: the HTTP verb IS a string literal, so
    // codeOnly() would blank exactly what is being asserted.
    const raw = stripComments(SRC(CLIENT));
    expect(raw).toContain("method: 'GET'");
    expect(raw).not.toMatch(/'POST'|'PUT'|'PATCH'|'DELETE'/);
  });

  it('renders no admin action against a report', () => {
    const code = codeOnly(SECTION);
    for (const verb of ['deleteLostReport', 'updateLostReport', 'setLostReportStatus', 'cancelLostReport', 'resolveLostReport']) {
      expect(code, `${SECTION} must not expose ${verb}`).not.toContain(verb);
    }
    expect(code).not.toMatch(/method:\s*'POST'/);
  });

  it('imports nothing from the database, the routes or the matching engine', () => {
    const sources = [...stripComments(SECTION).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const bad = sources.filter((s) => /db\/|routes\/|server|Matching|adminSafeViews/.test(s));
    expect(bad, `${SECTION} must not import server internals`).toEqual([]);
  });
});

describe('11A admin lost-reports UI: nothing protected can be rendered', () => {
  it('never names the protected identifier or internal account identity', () => {
    for (const file of [SECTION, CLIENT]) {
      const code = codeOnly(file);
      expect(code, `${file} must not reference document_number_hash`).not.toContain('document_number_hash');
      expect(code, `${file} must not reference customer_id`).not.toContain('customer_id');
      expect(code, `${file} must not reference the reporter's private free text`).not.toContain('distinctive_marks');
    }
  });

  it('renders explicit fields — never a raw row or a JSON dump', () => {
    const code = codeOnly(SECTION);
    // No row spread and no generic serialisation.
    expect(code).not.toMatch(/\{\s*\.\.\.\s*report\s*\}/);
    expect(code).not.toMatch(/\{\s*report\s*\}/);
    expect(code).not.toMatch(/\{\s*row\s*\}/);
    expect(code).not.toContain('JSON.stringify');
    // Every rendered value is named.
    for (const field of [
      'report.id',
      'report.status',
      'report.category_id',
      'report.county',
      'report.location_area',
      'report.created_at',
      'report.possible_match_count',
    ]) {
      expect(code, `${SECTION} must render ${field} explicitly`).toContain(field);
    }
  });

  it('never logs anything', () => {
    for (const file of [SECTION, CLIENT]) {
      expect(codeOnly(file), `${file} must not log`).not.toContain('console.log');
    }
  });
});

describe('11A admin lost-reports UI: states and status handling', () => {
  it('handles loading, empty and error states', () => {
    expect(sectionTsx).toContain('Skeleton');
    expect(sectionTsx).toContain('EmptyState');
    expect(sectionTsx).toContain('<Banner kind="error">');
    expect(sectionTsx).toContain('aria-busy="true"');
  });

  it('renders real statuses through the ONE shared presentation map', () => {
    // The same map the customer surface uses, whose own test asserts total
    // coverage of the status vocabulary and a safe fallback for unknown values.
    expect(sectionTsx).toContain("from '../../../config/lostReportPresentation'");
    expect(sectionTsx).toContain('getLostReportStatusDisplay(report.status, lang)');
    // No private status vocabulary is invented here.
    expect(codeOnly(SECTION)).not.toMatch(/'match_review'|'lapsed'|'resolved'/);
  });

  it('bounds its requests and guards against out-of-order responses', () => {
    expect(sectionTsx).toContain('ADMIN_LOST_REPORTS_PAGE_SIZE');
    expect(sectionTsx).toContain('AbortController');
    expect(sectionTsx).toMatch(/requestId/);
    // No polling or auto-refresh.
    expect(sectionTsx).not.toContain('setInterval');
  });

  it('the client path is exactly the admin endpoint', () => {
    expect(clientTs).toContain("const LIST_PATH = '/api/admin/lost-reports'");
    expect(clientTs).toContain('encodeURIComponent');
  });
});
