import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// PHASE 15 (BATCH 3) — OWNER DASHBOARD WORKSPACES
// =============================================================================
// My Lost Reports and My Claims were modernized as PRESENTATION only. These
// source-level tripwires pin the contracts that the modernization must not
// touch: the claim endpoints and their request bodies, the report service
// calls, the disclosure wiring between a report card and its matches panel,
// and the single-page-heading rule the dashboard band owns.
//
// Same rationale as the repository's other boundary suites (publicNavigation,
// lostReportDiscoverability, claimsAdminUiBoundary): there is no jsdom/React
// harness in this project, so the contract is asserted against the shipped
// source rather than through a renderer.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/** Comments are stripped where the assertion is about CODE, not prose. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const dashboardCode = stripComments(read('src/components/CustomerDashboard.tsx'));
const sectionCode = stripComments(read('src/components/customer/LostReportsSection.tsx'));
const matchesCode = stripComments(read('src/components/customer/PossibleMatches.tsx'));

describe('15-B3: the claims workflow is unchanged', () => {
  it('keeps the four claim endpoints and their HTTP verbs', () => {
    expect(dashboardCode).toContain("fetch('/api/customer/claims', { credentials: 'same-origin' })");
    expect(dashboardCode).toContain("fetch('/api/customer/claims/link/request-otp', {");
    expect(dashboardCode).toContain("fetch('/api/customer/claims/link/verify', {");
    expect(dashboardCode).toContain(
      "fetch('/api/customer/claims/' + encodeURIComponent(claimId) + '/link', {"
    );
    expect(dashboardCode).toContain("method: 'POST'");
    expect(dashboardCode).toContain("method: 'DELETE'");
  });

  it('sends exactly the same request bodies as before', () => {
    expect(dashboardCode).toContain('body: JSON.stringify({ claimId })');
    expect(dashboardCode).toContain(
      'body: JSON.stringify({ claimId: linkClaimId, code: linkCode, securityAnswers: linkAnswers })'
    );
  });

  it('still derives active and history from the existing flag', () => {
    expect(dashboardCode).toContain('.filter((c: any) => c.is_active)');
    expect(dashboardCode).toContain('.filter((c: any) => !c.is_active)');
  });
});

describe('15-B3: the lost-report workflow still owns its own data', () => {
  it('calls only the existing service functions', () => {
    expect(sectionCode).toContain('listMyLostReports()');
    expect(sectionCode).toContain('fetchLostReportMatches(');
    // The report write stays in the wizard, backed by createLostReport.
    expect(read('src/components/customer/LostReportWizard.tsx')).toContain('createLostReport(payload)');
  });

  it('never talks to the report API directly and never POSTs', () => {
    expect(sectionCode).not.toContain('/api/lost-reports');
    expect(sectionCode).not.toContain("method: 'POST'");
  });

  it('keeps the matches panel attached to its report card', () => {
    // The disclosure control and the region it opens must keep sharing one id,
    // so a candidate list can never render away from the report it belongs to.
    const ids = sectionCode.match(/lost-report-matches-\$\{report\.id\}/g) || [];
    expect(ids.length).toBe(2);
    expect(sectionCode).toContain('aria-expanded={expanded}');
  });
});

describe('15-B3: one page-level heading, owned by the dashboard band', () => {
  it('renders a single <h1> in the dashboard and none in the workspaces', () => {
    expect((dashboardCode.match(/<h1/g) || []).length).toBe(1);
    expect((sectionCode.match(/<h1/g) || []).length).toBe(0);
    expect((matchesCode.match(/<h1/g) || []).length).toBe(0);
  });

  it('groups claims under the existing active/history headings', () => {
    expect(dashboardCode).toContain("t('Active claims', 'Claims zinazoendelea')");
    expect(dashboardCode).toContain("t('Claim history', 'Historia ya claims')");
    expect(dashboardCode).toContain("t('Link an existing claim', 'Unganisha claim iliyopo')");
  });
});
