import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
// PHASE 16.1 (BATCH 1 FOLLOW-UP) — the item-name fallback rule is React-free
// (config/lostReportPresentation.ts), so its presence cases are asserted at
// RUNTIME in this suite rather than only read out of the source text.
import {
  LOST_REPORT_ITEM_NAME_FALLBACK,
  getLostReportItemNameDisplay,
} from '../config/lostReportPresentation';

// =============================================================================
// PHASE 11A (WP-2) — ADMIN LOST-REPORT UI BOUNDARY
// =============================================================================
// Static, file-text audit — the established pattern for frontend behaviour in
// this repository (no jsdom / React Testing Library exists here; see
// publicNavigation.test.ts and claimsAdminUiBoundary.test.ts).
//
// These assertions guard the things that matter most about this admin surface:
// that it renders every value explicitly (never a raw row, never a protected
// identifier), and — since PHASE 16.1 (BATCH 1) — that its ONE write
// (classification) lives in a separate, GET-only-audited client and is guarded
// against duplicate submission.

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
    // The section takes the session token and nothing else: the Swahili half of
    // the UI was removed product-wide, so there is no `lang` prop to pass.
    expect(adminView).toContain('<LostReportsAdministration token={token} />');
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
    expect(sectionTsx).toContain('getLostReportStatusDisplay(report.status)');
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

// ---------------------------------------------------------------------------
// PHASE 16.1 (GEO-16-04) — THE COUNTY FILTER CONTROL
// ---------------------------------------------------------------------------
describe('16.1 admin lost-reports UI: the county filter is canonical', () => {
  it('builds its county options from the ONE canonical dataset', () => {
    expect(sectionTsx).toContain("import { countiesByUxGroup } from '../../../config/kenyaCounties'");
    expect(sectionTsx).toContain('const COUNTY_GROUPS = countiesByUxGroup()');
    expect(sectionTsx).toContain('COUNTY_GROUPS.map');
    expect(sectionTsx).toContain('<optgroup');
    expect(sectionTsx).toContain('value={c.name}');
    // "All Counties" is the cleared state — the unfiltered request. It is a
    // single English label now that the console no longer carries a `lang`.
    expect(sectionTsx).toContain('<option value="">{\'All Counties\'}</option>');
  });

  it('passes the county to the client and omits it entirely when cleared', () => {
    expect(sectionTsx).toContain('county: county || null');
    expect(clientTs).toContain('if (opts.county) url += `&county=${encodeURIComponent(opts.county)}`');
  });

  it('returns to the first page whenever the county changes', () => {
    expect(sectionTsx).toMatch(/const handleCountyChange[\s\S]{0,120}setCounty\(value\);[\s\S]{0,60}setOffset\(0\)/);
    // ...and the reload goes through the ONE existing effect.
    expect(sectionTsx).toMatch(/\[offset, reloadToken, token, county\]/);
  });

  it('adds no second county list, no second request path and no new dependency', () => {
    expect(sectionTsx).not.toContain('KENYA_COUNTY_NAMES');
    expect(sectionTsx).not.toContain('KENYA_COUNTIES');
    expect(sectionTsx.match(/fetchAdminLostReports\(/g)?.length).toBe(1);
    expect(clientTs.match(/fetch\(/g)?.length).toBe(1);
  });

  it('the section stays read-only and still requests only a GET', () => {
    const raw = stripComments(SRC(CLIENT));
    expect(raw).toContain("method: 'GET'");
    expect(raw).not.toMatch(/'POST'|'PUT'|'PATCH'|'DELETE'/);
  });
});

// =============================================================================
// PHASE 16.1 (BATCH 1) — UNCLASSIFIED REPORTS AND CLASSIFICATION CONTROLS
// =============================================================================
// The console must be able to SEE that a report has no category and to FIX it.
// These are file-text assertions (this repository has no jsdom/RTL), chosen so
// each one pins a distinct guarantee rather than a styling detail.
describe('16.1 Batch 1: the console shows and resolves unclassified reports', () => {
  it('labels an unclassified report instead of rendering a blank cell', () => {
    // `category_id` can now be null, and the row branches on it.
    expect(sectionTsx).toContain('report.category_id ?');
    expect(sectionTsx).toContain("{'Unclassified'}");
    // The label is a Badge, not bare text, so it reads as a STATE.
    expect(sectionTsx).toMatch(/<Badge variant="warning">\s*\{'Unclassified'\}/);
  });

  it('offers a classify control with its own accessible name and its own pending state', () => {
    expect(sectionTsx).toContain('function ClassifyControl(');
    expect(sectionTsx).toContain('className="sr-only"');
    expect(sectionTsx).toContain('{`Item category for ${reportId}`}');
    // Reclassify and the deliberate return-to-unclassified action both exist.
    expect(sectionTsx).toContain('onClick={() => onClassify(reportId, selected)}');
    expect(sectionTsx).toContain('onClick={() => onClassify(reportId, null)}');
    expect(sectionTsx).toContain("{'Clear'}");
  });

  it('adds the unclassified-only filter WITHOUT a second request path', () => {
    expect(sectionTsx).toContain('id="admin-lost-unclassified"');
    expect(sectionTsx).toContain("{'Unclassified only'}");
    expect(sectionTsx).toContain('handleUnclassifiedChange');
    // It is the same bounded list request, with one extra parameter.
    expect(clientTs).toContain("if (opts.unclassifiedOnly) url += '&unclassified=true'");
    // The pinned load-effect dependency list is unchanged (offset/reload/token/
    // county); a filter change re-queries through `reloadToken`.
    expect(sectionTsx).toMatch(/\[offset, reloadToken, token, county\]/);
    expect(sectionTsx).toMatch(/const handleUnclassifiedChange[\s\S]{0,220}setReloadToken/);
  });

  it('keeps classification in its OWN client, because the list client is GET-only', () => {
    expect(sectionTsx).toContain("from '../../../services/adminLostReportClassificationApi'");
    expect(sectionTsx).toContain('classifyLostReport(');
    expect(sectionTsx).toContain('unclassifyLostReport(');
    // The read client never gains a mutation.
    expect(stripComments(SRC(CLIENT))).not.toMatch(/'POST'|'PUT'|'PATCH'|'DELETE'/);
  });

  it('prevents duplicate classification submissions and races', () => {
    // One in-flight row at a time, set BEFORE the await and cleared in finally.
    expect(sectionTsx).toContain('if (classifyingId) return;');
    expect(sectionTsx).toContain('setClassifyingId(reportId);');
    expect(sectionTsx).toMatch(/finally \{\s*setClassifyingId\(null\);/);
    // Every control on that row is disabled while it is in flight...
    expect(sectionTsx).toContain('disabled={busy || options.length === 0}');
    expect(sectionTsx).toContain('disabled={!canSave}');
    // ...and a no-op save (same category) cannot be sent at all.
    expect(sectionTsx).toContain("const canSave = Boolean(selected) && selected !== (currentCategoryId || '') && !busy;");
  });

  it('refreshes the list after a change and reports failures where the operator is looking', () => {
    // The row is updated from what the server confirmed, and the list is then
    // re-read — both inside the same handler, in that order.
    expect(sectionTsx).toMatch(/setRows\(\(previous\)[\s\S]{0,400}setReloadToken\(\(n\) => n \+ 1\)/);
    expect(sectionTsx).toContain('{classifyError && <Banner kind="error">{classifyError}</Banner>}');
    expect(sectionTsx).toContain('role="status"');
    // A failure is shown in its own banner rather than replacing the table with
    // the list-level error state.
    expect(sectionTsx).not.toMatch(/setError\(e\.message\)/);
  });
});

// =============================================================================
// PHASE 16.1 (BATCH 1 FOLLOW-UP) — THE ITEM-NAME COLUMN
// =============================================================================
// An administrator triaging a report has to know WHAT was lost before they can
// judge which category it belongs to, and on an unclassified row the item name
// is the only human description the table holds. The column therefore sits
// beside the reference, ahead of the category it informs.
//
// The presence cases (a name, null, undefined, empty, whitespace-only) are
// asserted at RUNTIME against the React-free helper the row renders through —
// the same node-only pattern lostReportWizardUx04.test.ts uses for
// identifierClassLabel(). Placement, truncation and the classification controls
// are pinned by source text, as the rest of this suite does.
describe('16.1 B1 follow-up: the admin table shows the item name', () => {
  it('declares an Item name column between the reference and the category', () => {
    expect(sectionTsx).toContain("<th scope=\"col\" className={thClass}>{'Item name'}</th>");
    const head = sectionTsx.slice(sectionTsx.indexOf('<thead'), sectionTsx.indexOf('</thead>'));
    expect(head.indexOf("{'Lost Report'}")).toBeGreaterThan(-1);
    expect(head.indexOf("{'Lost Report'}")).toBeLessThan(head.indexOf("{'Item name'}"));
    expect(head.indexOf("{'Item name'}")).toBeLessThan(head.indexOf("{'Category'}"));
  });

  it('renders each row through the ONE shared display helper', () => {
    expect(sectionTsx).toContain('getLostReportItemNameDisplay(report.item_name)');
    // The cell branches on the helper's own verdict, never on a second,
    // hand-rolled emptiness test that could drift from it.
    expect(sectionTsx).toContain('{itemName.provided ? (');
    expect(sectionTsx).not.toMatch(/report\.item_name\s*(?:&&|\|\|)/);
  });

  it('shows the name a report carries', () => {
    expect(getLostReportItemNameDisplay('Brown leather wallet'))
      .toEqual({ text: 'Brown leather wallet', provided: true });
  });

  it('shows the fallback when the name is null or missing', () => {
    // A pre-Batch-1 row has no item_name at all; the admin DTO forwards null.
    expect(getLostReportItemNameDisplay(null))
      .toEqual({ text: LOST_REPORT_ITEM_NAME_FALLBACK, provided: false });
    expect(getLostReportItemNameDisplay(undefined))
      .toEqual({ text: LOST_REPORT_ITEM_NAME_FALLBACK, provided: false });
    expect(LOST_REPORT_ITEM_NAME_FALLBACK).toBe('Not provided');
  });

  it('shows the fallback when the name is empty or whitespace only', () => {
    expect(getLostReportItemNameDisplay(''))
      .toEqual({ text: LOST_REPORT_ITEM_NAME_FALLBACK, provided: false });
    expect(getLostReportItemNameDisplay('   '))
      .toEqual({ text: LOST_REPORT_ITEM_NAME_FALLBACK, provided: false });
    expect(getLostReportItemNameDisplay('\t \n'))
      .toEqual({ text: LOST_REPORT_ITEM_NAME_FALLBACK, provided: false });
  });

  it('renders a padded name trimmed rather than with its padding', () => {
    expect(getLostReportItemNameDisplay('  Brown leather wallet  '))
      .toEqual({ text: 'Brown leather wallet', provided: true });
  });

  it('keeps a long name inside the table layout', () => {
    // A bounded column with ellipsis, and the full value kept reachable on the
    // cell's title, so one verbose report cannot stretch the table.
    expect(sectionTsx).toContain('block max-w-[16rem] truncate');
    expect(sectionTsx).toContain('title={itemName.text}');
    // The wrapper's existing scrolling region is untouched by this change.
    expect(sectionTsx).toContain("r4m-scroll-x\" role=\"region\" aria-label={'Lost reports table'} tabIndex={0}");
  });

  it('leaves the Unclassified label and both classification actions usable', () => {
    expect(sectionTsx).toContain('report.category_id ?');
    expect(sectionTsx).toContain("<Badge variant=\"warning\">{'Unclassified'}</Badge>");
    expect(sectionTsx).toContain('function ClassifyControl(');
    // Save a chosen category, and deliberately return the row to unclassified.
    expect(sectionTsx).toContain('onClick={() => onClassify(reportId, selected)}');
    expect(sectionTsx).toContain('onClick={() => onClassify(reportId, null)}');
    expect(sectionTsx).toContain("{'Clear'}");
    // The fallback is muted, never styled as a real (bold) item name.
    expect(sectionTsx).toContain('<span className="text-stone-400">{itemName.text}</span>');
  });
});
