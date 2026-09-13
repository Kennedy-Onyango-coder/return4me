import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getClaimStatusDisplay } from '../components/claimStatus';
import { CLAIM_STATUS_VALUES, INACTIVE_CLAIM_STATUSES } from '../config/claimStatuses';

// ---------------------------------------------------------------------------
// Phase 2 — shared claim-status vocabulary.
//
// Before this, the status -> label map lived privately inside OwnerView.tsx and
// was missing two statuses a real owner can reach (pending_settlement and
// releasing), so those rendered as raw snake_case tokens to the customer. These
// tests pin the vocabulary to the DATABASE constraint rather than to a
// hand-maintained list, so a future status added to the CHECK cannot silently
// fall through to a raw token on the dashboard.
// ---------------------------------------------------------------------------

const ddlTs = fs.readFileSync(path.resolve(__dirname, '../db/index.ts'), 'utf8');
const databaseTs = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');
const ownerViewTsx = fs.readFileSync(path.resolve(__dirname, '../components/OwnerView.tsx'), 'utf8');

function statusesFromConstraint(): string[] {
  const m = ddlTs.match(/ADD CONSTRAINT claims_status_check CHECK \(status IN \(([^)]+)\)\)/);
  if (!m) throw new Error('claims_status_check not found in src/db/index.ts');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

describe('claim status vocabulary', () => {
  const dbStatuses = statusesFromConstraint();

  it('parses the real claims_status_check constraint', () => {
    expect(dbStatuses.length).toBeGreaterThanOrEqual(12);
    expect(dbStatuses).toContain('pending_settlement');
    expect(dbStatuses).toContain('releasing');
  });

  it('CLAIM_STATUS_VALUES matches the database constraint exactly', () => {
    expect([...CLAIM_STATUS_VALUES].sort()).toEqual([...dbStatuses].sort());
  });

  it('24. every value in claims_status_check has a non-raw customer-facing mapping', () => {
    for (const status of dbStatuses) {
      const en = getClaimStatusDisplay(status, 'en');
      const sw = getClaimStatusDisplay(status, 'sw');
      expect(en.label).not.toBe(status);
      expect(sw.label).not.toBe(status);
      expect(en.label).not.toContain('_');
      expect(sw.label).not.toContain('_');
      expect(en.label.trim().length).toBeGreaterThan(0);
      expect(sw.label.trim().length).toBeGreaterThan(0);
      expect(['success', 'warning', 'danger', 'info', 'neutral', 'code']).toContain(en.variant);
    }
  });

  it('22. pending_settlement has a human-readable bilingual label', () => {
    const en = getClaimStatusDisplay('pending_settlement', 'en');
    const sw = getClaimStatusDisplay('pending_settlement', 'sw');
    expect(en.label).toBe('Awaiting Payout Release');
    expect(sw.label).toBe('Inasubiri Malipo Kutolewa');
    expect(en.label).not.toContain('pending_settlement');
  });

  it('23. releasing has a human-readable bilingual label', () => {
    const en = getClaimStatusDisplay('releasing', 'en');
    const sw = getClaimStatusDisplay('releasing', 'sw');
    expect(en.label).toBe('Payout In Progress');
    expect(sw.label).toBe('Malipo Yanaendelea');
    expect(en.label).not.toContain('releasing');
  });

  it('preserves the pre-existing mappings for the statuses that already had them', () => {
    // The exact labels/classes the OwnerView map shipped with; the extraction
    // must not have changed behaviour.
    const expectations: Array<[string, string, string, string]> = [
      ['pending_verification', 'Inasubiri Uthibitisho', 'Pending Verification', 'bg-amber-100 text-amber-800'],
      ['awaiting_agent_confirmation', 'Inasubiri Uthibitisho wa Wakala', 'Awaiting Agent Confirmation', 'bg-amber-100 text-amber-800'],
      ['pending_payment', 'Malipo Yanasubiri', 'Payment Pending', 'bg-amber-100 text-amber-800'],
      ['payment_window_expired', 'Muda wa Malipo Umeisha', 'Payment Window Expired', 'bg-red-100 text-red-800'],
      ['escrow_held', 'Malipo Yamethibitishwa', 'Payment Confirmed', 'bg-emerald-100 text-emerald-800'],
      ['released', 'Bidhaa Imechukuliwa', 'Item Collected', 'bg-emerald-100 text-emerald-800'],
      ['disputed', 'Inakaguliwa (Mzozo)', 'Under Dispute Review', 'bg-orange-100 text-orange-800'],
      ['rejected', 'Ombi Limekataliwa', 'Claim Rejected', 'bg-red-100 text-red-800'],
      ['refunding', 'Urejeshaji Unaendelea', 'Refund In Progress', 'bg-amber-100 text-amber-800'],
      ['refunded', 'Umerejeshewa kwa M-Pesa', 'Refunded to M-Pesa', 'bg-sky-100 text-sky-800'],
    ];
    for (const [status, sw, en, className] of expectations) {
      expect(getClaimStatusDisplay(status, 'sw').label).toBe(sw);
      expect(getClaimStatusDisplay(status, 'en').label).toBe(en);
      expect(getClaimStatusDisplay(status, 'en').className).toBe(className);
    }
  });

  it('OwnerView consumes the shared map instead of keeping a second copy', () => {
    expect(ownerViewTsx).toContain("import { getClaimStatusDisplay } from './claimStatus'");
    // The old private function and its inline map must be gone.
    expect(ownerViewTsx).not.toMatch(/function getClaimStatusDisplay/);
    expect(ownerViewTsx).not.toMatch(/pending_verification:\s*\{/);

    // ...and the map exists in exactly ONE file across the UI layer.
    const dir = path.resolve(__dirname, '../components');
    const withStatusMap = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
      .filter((f) => /pending_settlement:\s*\{/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(withStatusMap).toEqual(['claimStatus.ts']);
  });

  it('is_active grouping uses the same INACTIVE_CLAIM_STATUSES definition as claim submission', () => {
    expect([...INACTIVE_CLAIM_STATUSES].sort()).toEqual(
      ['payment_window_expired', 'disputed', 'rejected', 'refunded', 'released'].sort()
    );
    for (const status of INACTIVE_CLAIM_STATUSES) {
      expect(dbStatuses).toContain(status);
    }
    // server.ts no longer keeps a private copy of the set.
    const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
    expect(serverTs).not.toMatch(/const INACTIVE_CLAIM_STATUSES = new Set<string>\(/);
    expect(serverTs).toContain("import { INACTIVE_CLAIM_STATUSES } from './config/claimStatuses'");
  });

  it('the Claim status union in database.ts declares every status in the constraint', () => {
    // The DB-layer type the rest of the code type-checks against. Every member
    // of the constraint must be present so a new status cannot be added to the
    // CHECK and silently be unrepresentable in code (or vice versa).
    for (const status of dbStatuses) {
      expect(databaseTs).toContain(`"${status}"`);
    }
    // ...and the union is declared on exactly one line, with all 12 members.
    const unionLine = databaseTs.split('\n').find((l) => l.includes('"pending_verification" | "pending_payment"'));
    expect(unionLine).toBeDefined();
    for (const status of dbStatuses) {
      expect(unionLine!).toContain(`"${status}"`);
    }
  });
});
