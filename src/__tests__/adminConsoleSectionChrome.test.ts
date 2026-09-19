import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// BATCH 2 — ADMIN CONSOLE SECTION CHROME
// =============================================================================
// The Batch 2 remediation was presentation-only, so almost everything it
// touched is already pinned elsewhere (adminConsoleShell.test.ts pins the
// console band + sidebar architecture, categoryFeePreview.test.ts pins the
// engine-backed fee preview, adminEscrowMetric.test.ts pins the escrow cards).
//
// These are the two invariants Batch 2 introduced that NOTHING else covers:
//   1. the found-item filters must keep VISIBLE labels (the forensic review of
//      Batch 1 found them demoted to screen-reader-only labels — a fix that is
//      silent, and therefore easy to regress);
//   2. the remaining legacy sections must not re-introduce a second page-level
//      heading or the raw palette status pills Batch 2 replaced with the shared
//      semantic Badge variants.
//
// Source-level tripwires in the established style of this repository (there is
// no jsdom / React Testing Library harness here — see adminConsoleShell.test.ts
// and claimsAdminUiBoundary.test.ts).
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const adminView = read('src/components/AdminView.tsx');

/** De-comment, so an assertion is about shipped code and not about the prose
 *  that explains it (several Batch 2 comments quote the old class names). */
const code = adminView
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

describe('Batch 2: the console has ONE page-level heading per section', () => {
  it('keeps the single authoritative title band', () => {
    expect(adminView).toContain(
      '<h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-brand-dark-text">',
    );
  });

  it('does not re-introduce a competing section title below that band', () => {
    // The four duplicated presentation headings Batch 2 removed.
    expect(adminView).not.toContain('{t.ledgerTitle}');
    expect(adminView).not.toContain('Flagged for Manual Review');
    expect(adminView).not.toContain('User Payment Strikes</h2>');
    expect(adminView).not.toContain('Categories & Pricing</h2>');
  });

  it('does not re-introduce the duplicated section descriptions', () => {
    expect(adminView).not.toContain('{t.disputeDesc}');
    expect(adminView).not.toContain('Monitor registered physical drop-off stations');
    expect(adminView).not.toContain('Live real-time registry of all items uploaded by finders');
  });
});

describe('Batch 2: found-item filter labels stay VISIBLE', () => {
  it('renders the three filters with real labels, not sr-only ones', () => {
    // A label immediately followed by the control id — with no `hideLabel`
    // between them — is exactly what makes the label visible.
    expect(code).toMatch(/label="Search Items"\s*\n\s*id="item-search"/);
    expect(code).toMatch(/label="Hali \/ Status"\s*\n\s*id="item-status-filter"/);
    expect(code).toMatch(/label="Review Flag"\s*\n\s*id="item-flag-filter"/);
  });

  it('does not hide them again behind hideLabel', () => {
    expect(code).not.toMatch(/label="Search Items"\s*\n\s*hideLabel/);
    expect(code).not.toMatch(/label="Hali \/ Status"\s*\n\s*hideLabel/);
    expect(code).not.toMatch(/label="Review Flag"\s*\n\s*hideLabel/);
  });

  it('leaves the filtering binding untouched', () => {
    expect(code).toContain('value={itemSearch}');
    expect(code).toContain('value={itemStatusFilter}');
    expect(code).toContain('value={itemFlagFilter}');
  });
});

describe('Batch 2: legacy status pills use the shared design system', () => {
  it('no raw informational/palette pill classes remain', () => {
    expect(code).not.toContain('bg-blue-50 text-blue-700');
    expect(code).not.toContain('bg-purple-50 text-purple-700');
    expect(code).not.toContain('bg-orange-50 text-orange-700');
  });

  it('the ledger type labels keep their distinct semantic variants', () => {
    expect(code).toContain("entry.type === 'payment_received' ? 'info'");
    expect(code).toContain("entry.type === 'finder_payout' ? 'success'");
    expect(code).toContain("entry.type === 'agent_payout' ? 'warning'");
  });

  it('the strike status vocabulary is unchanged and rendered as badges', () => {
    expect(code).toContain('<Badge variant="danger">Blocked from claims</Badge>');
    expect(code).toContain('<Badge variant="warning">Warning active</Badge>');
    expect(code).toContain('<Badge variant="neutral">Clear</Badge>');
    // The escalation thresholds themselves are untouched.
    expect(code).toContain('strike.count >= 3');
    expect(code).toContain('strike.count >= 2');
    expect(code).toContain('strike.count > 0');
  });
});

describe('Batch 2: the actions those sections drive are still wired', () => {
  it('keeps the ledger / strikes / review / category action handlers', () => {
    expect(code).toContain('onClick={() => handleReleaseSettlementNow(ps.claimId)}');
    expect(code).toContain('onClick={() => handleClearStrikes(strike.phone)}');
    expect(code).toContain('onClick={() => handleDeleteCategory(cat.id, cat.name_en)}');
    expect(code).toContain("onClick={() => resetCategoryForm('edit', cat)}");
    expect(code).toContain('onClick={() => handleRejectAsSpam(selectedReviewItem.id)}');
  });

  it('keeps the two submit forms as real submits', () => {
    expect(code).toContain('onSubmit={handleSaveCategory}');
    expect(code).toContain('onSubmit={handleSaveReview}');
    // Both Save actions must remain real submit buttons — a design-system
    // Button defaults to type="button", so dropping the explicit submit would
    // silently stop the form from ever being sent.
    const submitButtons = [...code.matchAll(/<Button\s[^>]*type="submit"/g)];
    expect(submitButtons.length).toBeGreaterThanOrEqual(2);
  });
});
