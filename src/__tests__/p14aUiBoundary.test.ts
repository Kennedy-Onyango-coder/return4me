import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isValidCoordinatePair } from '../services/coordinates';

// ===========================================================================
// P14A — UI BOUNDARY TRIPWIRES
//
// Same rationale and technique as the repository's other boundary suites
// (lostReportUxBoundary, claimsAdminUiBoundary, publicExperience): this project
// has no jsdom / React Testing Library, so the contract is asserted against the
// real source that ships. Comments are stripped first, so an assertion is about
// SHIPPED CODE rather than about the explanatory comments that quote the very
// anti-patterns being forbidden.
//
// Pinned here:
//   P14-03  the claimant fee breakdown can never fabricate "KES 0" from a
//           missing client-side category, and prefers the server-authoritative
//           payment-session amount;
//   P14-09  the homepage has no hard-coded category-name dictionary;
//   P14-11  the Finder's GPS prompt uses explicit null checks, so a valid
//           coordinate of exactly 0 is not treated as missing;
//   P14-13  the exact-location field has no county-name datalist.
// ===========================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/** Removes line/block comments so assertions are about shipped code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const OWNER_VIEW = stripComments(read('src/components/OwnerView.tsx'));
const HOME_VIEW = stripComments(read('src/components/HomeView.tsx'));
const FINDER_VIEW = stripComments(read('src/components/FinderView.tsx'));

describe('P14-03 — claimant fee display never fabricates a figure', () => {
  it('no longer falls back to a literal KES 0 for any of the four fee lines', () => {
    for (const field of ['total_fee', 'finder_share', 'agent_share', 'platform_share']) {
      const zeroFallback = new RegExp(`catRecord[^\\n]*${field}[^\\n]*:\\s*0\\b`);
      expect(
        OWNER_VIEW,
        `${field} must not default to a literal 0 when the category record is missing`,
      ).not.toMatch(zeroFallback);
    }
  });

  it('uses the server-authoritative payment-session amount (create + poll)', () => {
    expect(OWNER_VIEW).toMatch(/paymentSession\?\.amount/); // session creation response
    expect(OWNER_VIEW).toMatch(/s\?\.amount/);              // status poll response
    expect(OWNER_VIEW).toMatch(/setPaymentSessionAmount\(/);
  });

  it('prefers the authoritative amount over the client-side category fee', () => {
    const authoritativeFirst = OWNER_VIEW.indexOf('authoritativeTotal !== null');
    const categoryFallback = OWNER_VIEW.indexOf('catRecord ? Math.round(Number(catRecord.total_fee))');
    expect(authoritativeFirst, 'expected an authoritative-total check').toBeGreaterThan(-1);
    expect(categoryFallback, 'expected a category fallback for the total').toBeGreaterThan(-1);
    expect(categoryFallback).toBeGreaterThan(authoritativeFirst);
  });

  it('labels an unresolvable figure instead of printing a number', () => {
    expect(OWNER_VIEW).toContain('Unavailable');
    expect(OWNER_VIEW).toMatch(/value === null/);
  });

  it('routes all four figures through the null-safe formatter', () => {
    for (const expr of ['{money(finderShare)}', '{money(agentShare)}', '{money(platformShare)}', '{money(totalFee)}']) {
      expect(OWNER_VIEW, `expected ${expr} in the fee breakdown`).toContain(expr);
    }
    // …and no raw interpolation of a possibly-null figure survives.
    expect(OWNER_VIEW).not.toMatch(/KES \{finderShare\}/);
    expect(OWNER_VIEW).not.toMatch(/KES \{agentShare\}/);
    expect(OWNER_VIEW).not.toMatch(/KES \{platformShare\}/);
    expect(OWNER_VIEW).not.toMatch(/KES \{totalFee\}/);
  });
});

describe('P14-09 — homepage keeps no stale hard-coded category labels', () => {
  it('resolves names only from the live category list', () => {
    expect(HOME_VIEW).toMatch(/categories\.find\(\(c: any\) => c\.id === categoryId\)/);
    expect(HOME_VIEW).toMatch(/return categoryId;/);
  });

  it('no longer contains the old label dictionary', () => {
    for (const stale of ["'National ID'", "'Vehicle Logbook'", "'Driving Licence'", "'Number Plate'"]) {
      expect(HOME_VIEW, `stale hard-coded label ${stale} must be gone`).not.toContain(stale);
    }
  });
});

describe('P14-11 — Finder GPS prompt treats zero as a valid coordinate', () => {
  it('the shared validator accepts exactly zero (the server rule being mirrored)', () => {
    expect(isValidCoordinatePair(0, 0)).toBe(true);
    expect(isValidCoordinatePair(0, 36.8219)).toBe(true);
    expect(isValidCoordinatePair(null, 36.8219)).toBe(false);
    expect(isValidCoordinatePair(undefined, 36.8219)).toBe(false);
  });

  it('the component uses explicit null checks, not truthiness', () => {
    expect(FINDER_VIEW).toContain('latitude === null || longitude === null');
    expect(FINDER_VIEW).not.toMatch(/!latitude \|\| !longitude/);
  });
});

describe('P14-13 — exact-location field carries no county datalist', () => {
  it('the county-name datalist and its input binding are gone', () => {
    expect(FINDER_VIEW).not.toContain('r4m-county-suggestions');
    expect(FINDER_VIEW).not.toContain('KENYA_COUNTY_NAMES');
    expect(FINDER_VIEW).not.toContain('<datalist');
  });

  it('the exact-location field is still a required free-text input', () => {
    expect(FINDER_VIEW).toMatch(/id="finder-location"/);
    expect(FINDER_VIEW).toMatch(/value=\{locationDescription\}/);
  });

  it('the canonical county selector is untouched', () => {
    expect(FINDER_VIEW).toContain('COUNTY_GROUPS');
    expect(FINDER_VIEW).toMatch(/id="finder-county"/);
  });
});
