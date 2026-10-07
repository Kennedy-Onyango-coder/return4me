import { describe, it, expect } from 'vitest';
import {
  describePageRange,
  formatTimestamp,
  presentBoolean,
  presentClaimStatus,
  presentDisputeState,
  presentFinancialState,
  presentHistoricalClaim,
  presentPayment,
  presentRole,
  presentVerificationTier,
} from '../claimsPresentation';

// =============================================================================
// PHASE 6F — CLAIMS UI PRESENTATION RULES
// =============================================================================
// These are the regression tests for HOW claim data reaches an administrator's
// eyes. This repo runs vitest in a node environment with no jsdom / React
// Testing Library, so the presentation rules live in pure functions precisely
// so they CAN be tested — the components above them are thin renderers.
//
// The invariants under test:
//   1. paid_at is the only payment truth
//   2. no financial figure is ever invented
//   3. an unavailable historical snapshot is UNKNOWN, not "unpaid"
describe('6F presentPayment — paid_at is the only truth', () => {
  it('paid_at set + has_paid true -> Paid, with the timestamp', () => {
    const p = presentPayment(true, '2026-02-01T10:00:00.000Z');
    expect(p.paid).toBe(true);
    expect(p.label).toBe('Paid');
    expect(p.at).toBe('2026-02-01T10:00:00.000Z');
  });

  it('paid_at null + has_paid false -> Not paid, no timestamp', () => {
    const p = presentPayment(false, null);
    expect(p.paid).toBe(false);
    expect(p.label).toBe('Not paid');
    expect(p.at).toBeNull();
  });

  it('has_paid true WITHOUT paid_at is still NOT paid — the timestamp wins', () => {
    const p = presentPayment(true, null);
    expect(p.paid).toBe(false);
    expect(p.label).toBe('Not paid');
  });

  it('paid_at set is never downgraded by a stale has_paid false', () => {
    const p = presentPayment(false, '2026-02-01T10:00:00.000Z');
    expect(p.paid).toBe(true);
    expect(p.label).toBe('Paid');
  });

  it('uses no word that could imply an amount', () => {
    for (const lang of ['en'] as const) {
      for (const p of [
        presentPayment(true, '2026-02-01T10:00:00.000Z'),
        presentPayment(false, null),
      ]) {
        expect(p.label).not.toMatch(/KES|Ksh|\d/);
      }
    }
  });
});

describe('6F presentClaimStatus — semantic meaning is preserved', () => {
  it('disputed is never rendered as Rejected, and refunding is never Refunded', () => {
    const disputed = presentClaimStatus('disputed').label;
    const rejected = presentClaimStatus('rejected').label;
    const refunding = presentClaimStatus('refunding').label;
    const refunded = presentClaimStatus('refunded').label;

    expect(disputed).not.toBe(rejected);
    expect(disputed.toLowerCase()).toContain('dispute');
    expect(refunding).not.toBe(refunded);
    expect(refunding.toLowerCase()).toContain('progress');
    expect(refunded.toLowerCase()).not.toContain('progress');
  });

  it('renders every real status as a human label, never a raw snake_case token', () => {
    const statuses = [
      'pending_verification', 'awaiting_agent_confirmation', 'pending_payment', 'payment_window_expired',
      'escrow_held', 'pending_settlement', 'releasing', 'released', 'disputed', 'refunding',
      'refunded', 'rejected',
    ];
    for (const s of statuses) {
      const label = presentClaimStatus(s).label;
      expect(label, s).not.toBe(s);
      expect(label, s).not.toContain('_');
      expect(label.length, s).toBeGreaterThan(2);
    }
  });

  it('carries a semantic tone so meaning is never colour-only', () => {
    expect(presentClaimStatus('rejected').tone).toBe('danger');
    expect(presentClaimStatus('released').tone).toBe('success');
    expect(presentClaimStatus('disputed').tone).toBe('warning');
  });
});

describe('6F presentFinancialState — lifecycle words, never money', () => {
  it('maps every financial stage to a word with no currency or digits', () => {
    const stages = ['escrow_held', 'settling', 'settled', 'refunding', 'refunded', 'rejected', 'unpaid', 'anything'];
    for (const state of stages) {
      const { label } = presentFinancialState(state);
      expect(label, state).not.toMatch(/KES|Ksh|\$|\u00a3|\u20ac|\d/);
    }
  });

  it('keeps refunding distinct from refunded', () => {
    expect(presentFinancialState('refunding').label).not.toBe(presentFinancialState('refunded').label);
  });
});

// ---------------------------------------------------------------------------
// R1 — LEGACY DISPUTE SNAPSHOTS REMAIN UNKNOWN
// ---------------------------------------------------------------------------
describe('6F presentHistoricalClaim — unknown is not unpaid', () => {
  it('snapshot_incomplete renders as Unknown, and NEVER as Not paid', () => {
    const h = presentHistoricalClaim({ status_at_dispute: null, paid_at_dispute: null }, true);
    expect(h.unknown).toBe(true);
    expect(h.status).toContain('Unknown');
    expect(h.payment).toContain('Unknown');
    expect(h.payment).not.toBe('Not paid');
    expect(h.payment.toLowerCase()).not.toContain('unpaid');
  });

  it('a snapshot_incomplete dispute is still unknown even if stale columns are non-null', () => {
    const h = presentHistoricalClaim({ status_at_dispute: 'pending_payment', paid_at_dispute: null }, true);
    expect(h.unknown).toBe(true);
    expect(h.payment).toContain('Unknown');
  });

  it('a complete snapshot renders the recorded historical values', () => {
    const paid = presentHistoricalClaim(
      { status_at_dispute: 'escrow_held', paid_at_dispute: '2026-01-01T00:00:00.000Z' },
      false,
    );
    expect(paid.unknown).toBe(false);
    expect(paid.payment).toBe('Paid');
    expect(paid.status).toBe(presentClaimStatus('escrow_held').label);

    const unpaid = presentHistoricalClaim({ status_at_dispute: 'pending_payment', paid_at_dispute: null }, false);
    expect(unpaid.unknown).toBe(false);
    expect(unpaid.payment).toBe('Not paid');
  });

  it('both-sides-empty is treated as unknown even without the flag', () => {
    const h = presentHistoricalClaim({ status_at_dispute: null, paid_at_dispute: null }, false);
    expect(h.unknown).toBe(true);
  });

  it('the Swahili wording also says unknown, not unpaid', () => {
    const h = presentHistoricalClaim({ status_at_dispute: null, paid_at_dispute: null }, true);
    expect(h.payment).toContain('Haijulikani');
    expect(h.payment).not.toContain('Haijalipwa');
  });
});

// ---------------------------------------------------------------------------
// DATES
// ---------------------------------------------------------------------------
describe('6F formatTimestamp', () => {
  it('returns Not available for null, undefined, empty and unparseable values', () => {
    expect(formatTimestamp(null)).toBe('Not available');
    expect(formatTimestamp(undefined)).toBe('Not available');
    expect(formatTimestamp('')).toBe('Not available');
    expect(formatTimestamp('not-a-date')).toBe('Not available');
  });

  it('renders a real timestamp with its year', () => {
    expect(formatTimestamp('2026-03-04T09:30:00.000Z')).toContain('2026');
  });

  it('a null paid_at never becomes a date', () => {
    expect(formatTimestamp(null)).not.toMatch(/\d{4}/);
  });
});


// ---------------------------------------------------------------------------
// PAGINATION WORDING
// ---------------------------------------------------------------------------
describe('6F describePageRange', () => {
  it('describes an offset window without implying a total', () => {
    expect(describePageRange(0, 25)).toBe('Claims 1–25');
    expect(describePageRange(25, 25)).toBe('Claims 26–50');
    expect(describePageRange(0, 1)).toBe('Claim 1');
  });

  it('never fabricates a grand total', () => {
    for (const [offset, shown] of [[0, 25], [25, 25], [50, 3]] as const) {
      const text = describePageRange(offset, shown);
      expect(text).not.toMatch(/\bof\b/);
      expect(text.toLowerCase()).not.toMatch(/total/i);
    }
  });

  it('handles an empty page honestly', () => {
    expect(describePageRange(0, 0)).toBe('No claims on this page');
  });
});

// ---------------------------------------------------------------------------
// SMALL PRESENTERS
// ---------------------------------------------------------------------------
describe('6F small presenters', () => {
  it('roles distinguish original from contesting, and default to Not available', () => {
    expect(presentRole('original')).toContain('Original');
    expect(presentRole('contesting')).toContain('Contesting');
    expect(presentRole(null)).toBe('Not available');
  });

  it('verification tier is described, and unknown tiers stay Not available', () => {
    expect(presentVerificationTier(2)).toContain('Tier 2');
    expect(presentVerificationTier(null)).toBe('Not available');
  });

  it('dispute state maps the three real values only', () => {
    expect(presentDisputeState('open').label).toBe('Open');
    expect(presentDisputeState('resolved').label).toBe('Resolved');
    expect(presentDisputeState('none').label).toBe('None');
    expect(presentDisputeState('something-else').label).toBe('None');
    expect(presentDisputeState('open').tone).toBe('warning');
  });

  it('booleans render yes/no words, never raw values', () => {
    expect(presentBoolean(true)).toBe('Yes');
    expect(presentBoolean(false)).toBe('No');
  });
});

