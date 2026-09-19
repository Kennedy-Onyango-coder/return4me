import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// PHASE 15 (BATCH 2) — OWNER DASHBOARD OVERVIEW
// =============================================================================
// The Overview on /account is presentation over data the dashboard ALREADY
// holds. This repository has no DOM/React test harness (see publicNavigation
// and lostReportDiscoverability for the same rationale), so these guarantees
// are asserted against the real component source.
//
// They pin the three rules this batch had to keep:
//   1. exactly ONE page-level heading per rendered section, and the customer's
//      own name is never a heading;
//   2. the Overview adds NO request, endpoint or second data source — its
//      derived summary reads the claims the component already loads, and the
//      lost-report collection stays owned by LostReportsSection;
//   3. the Overview stays customer-scoped and shell-restrained: the existing
//      masked phone, one Sign out, no invented dashboard URL.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

const dashboard = read('src/components/CustomerDashboard.tsx');
/** Comments are stripped where the assertion is about CODE, not prose. */
const code = dashboard.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('15-B2: the Overview keeps ONE page-level heading', () => {
  it('renders a single <h1>, which belongs to the active section', () => {
    expect((code.match(/<h1/g) || []).length).toBe(1);
    expect(code).toContain('id="account-section-heading"');
  });

  it('never turns the customer name into a heading', () => {
    expect(code).not.toMatch(/<h[1-6][^>]*>\s*\{customer\.full_name\}/);
  });
});

describe('15-B2: the Overview adds no data source', () => {
  it('still calls only the existing customer claims endpoints', () => {
    const targets = Array.from(code.matchAll(/fetch\('([^']*)'/g)).map((m) => m[1]);
    expect(targets).toEqual([
      '/api/customer/claims',
      '/api/customer/claims/link/request-otp',
      '/api/customer/claims/link/verify',
      '/api/customer/claims/',
    ]);
  });

  it('never reads lost reports itself — that stays LostReportsSection', () => {
    expect(code).not.toContain('lost-reports');
    expect(code).not.toContain('listMyLostReports');
    expect((code.match(/<LostReportsSection/g) || []).length).toBe(1);
  });

  it('keeps customer identity out of client-side storage', () => {
    expect(code).not.toMatch(/localStorage|sessionStorage/);
  });

  it('derives its summary from the claims arrays it already has', () => {
    expect(code).toContain('<StatCard');
    expect(code).toContain('activeClaims.length');
    expect(code).toContain('historyClaims.length');
  });
});

describe('15-B2: the Overview stays customer-scoped and shell-restrained', () => {
  it('shows the existing masked phone, never the raw number', () => {
    expect(code).toContain('maskPhone(customer.phone)');
    expect(code).not.toMatch(/>\{customer\.phone\}</);
  });

  it('exposes exactly one Sign out control', () => {
    expect((code.match(/onClick=\{onSignOut\}/g) || []).length).toBe(1);
  });

  it('invents no dashboard URL and no router', () => {
    expect(code).not.toMatch(/href=/);
    expect(code).not.toContain('window.location');
  });
});
