import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ClaimDetailPanel from '../ClaimDetailPanel';
import type { AdminClaimDetailView } from '../../../../services/adminClaimsApiTypes';

// =============================================================================
// ADM-001 — THE CLAIM DRAWER'S SETTLEMENT CONTEXT, IN ITS THREE REAL STATES.
// =============================================================================
// A pending_settlement claim is the only kind with a settlement decision
// outstanding, and that decision lives in exactly one place: the Pending
// Settlements list under Money → Ledger. The drawer therefore reports the
// server's own facts and offers a NAVIGATION action — never an approve, an
// initiate, a retry or a re-arm.
//
// These assertions render the REAL drawer (react-dom/server) and pin:
//   * the three distinguishable states — the row is in the loaded list, the list
//     loaded without this claim, and the list has not loaded at all;
//   * that the "Open settlement row" route appears ONLY in the first state, and
//     is never a dead control when no navigation handler is supplied; and
//   * that no money-moving wording is offered from this surface in any state.
// =============================================================================

const SETTLE_AT = '2026-10-01T12:00:00.000Z';

/** A detail DTO shaped exactly like `toAdminSafeClaimDetailView` sends. */
const detailClaim = (overrides: Partial<AdminClaimDetailView> = {}): AdminClaimDetailView => ({
  id: 'CLM-1',
  status: 'pending_settlement',
  is_active: true,
  created_at: '2026-09-30T09:00:00.000Z',
  updated_at: '2026-10-01T10:00:00.000Z',
  claimant_phone: '2547***678',
  verification_tier: 2,
  has_paid: true,
  paid_at: '2026-09-30T11:00:00.000Z',
  payment_state: 'paid',
  financial_state: 'pending_settlement',
  agent_confirmed_at: '2026-10-01T09:00:00.000Z',
  item: null,
  agent: null,
  verification: {
    tier: 2,
    agent_confirmed_at: '2026-10-01T09:00:00.000Z',
    identifying_detail_present: true,
    id_proof_present: true,
    handover_photo_present: true,
  },
  settlement: { settle_at: SETTLE_AT, state: 'pending_settlement' },
  dispute: null,
  sibling_claims: [],
  ...overrides,
});

type RowState = 'available' | 'not_listed' | 'unknown';

const renderDrawer = (
  settlementRowState: RowState,
  options: {
    claim?: AdminClaimDetailView;
    onOpenSettlement?: (claimId: string) => void;
  } = {},
) =>
  renderToStaticMarkup(
    React.createElement(ClaimDetailPanel, {
      claimId: 'CLM-1',
      claim: options.claim ?? detailClaim(),
      loading: false,
      error: null,
      onClose: () => {},
      onRetry: () => {},
      onOpenClaim: () => {},
      settlementRowState,
      ...(options.onOpenSettlement ? { onOpenSettlement: options.onOpenSettlement } : {}),
    }),
  );

/** Action LABELS that would only be appropriate if this surface could move money.
 *  The panel's own read-only footnote says it cannot "approve, release or re-send
 *  a payout", so this matches offered actions, never that statement. */
const PAYOUT_ACTIONS =
  /(approve payout|release payout|re-arm payout|rearm payout|initiate payout|retry payout|send payout)/i;

describe('ADM-001: the three settlement-row states are worded differently', () => {
  it('available: says the row is listed and offers the one navigation route', () => {
    const html = renderDrawer('available', { onOpenSettlement: () => {} });

    expect(html).toContain('Review window closes');
    expect(html).toContain('Listed under Pending Settlements.');
    expect(html).toContain('Open settlement row');
    expect(html).toContain('<button');
    expect(html).not.toMatch(PAYOUT_ACTIONS);
  });

  it('not_listed: says the loaded list does not contain this claim and asks for a refresh', () => {
    const html = renderDrawer('not_listed', { onOpenSettlement: () => {} });

    expect(html).toContain('Not in the loaded Pending Settlements list.');
    expect(html).toContain('Refresh the dashboard before acting');
    // No navigation target is promised for a row that is not there.
    expect(html).not.toContain('Open settlement row');
    expect(html).not.toContain('Listed under Pending Settlements.');
    expect(html).not.toMatch(PAYOUT_ACTIONS);
  });

  it('unknown: says the list itself has not loaded, which is a different fact', () => {
    const html = renderDrawer('unknown', { onOpenSettlement: () => {} });

    expect(html).toContain('Settlement list not loaded.');
    expect(html).toContain('Reload the dashboard to read the settlement list.');
    expect(html).not.toContain('Open settlement row');
    // "unknown" must not be reported as "not listed": nothing was read.
    expect(html).not.toContain('Not in the loaded Pending Settlements list.');
    expect(html).not.toMatch(PAYOUT_ACTIONS);
  });

  it('does not render a dead navigation control when no handler is supplied', () => {
    const html = renderDrawer('available');
    expect(html).not.toContain('Open settlement row');
    expect(html).toContain('Reload the dashboard to read the settlement list.');
  });

  it('does not render the settlement panel at all for a claim with no decision outstanding', () => {
    const html = renderDrawer('available', {
      claim: detailClaim({ status: 'released', financial_state: 'released' }),
      onOpenSettlement: () => {},
    });
    expect(html).not.toContain('Review window closes');
    expect(html).not.toContain('Open settlement row');
    // The drawer's own read-only statement is also absent from this claim.
    expect(html).not.toContain('Nothing on this panel can approve, release or re-send a payout.');
  });
});

describe('ADM-001: the drawer states the review window it actually read', () => {
  it('reports an elapsed window as eligible for review', () => {
    const html = renderDrawer('available', {
      claim: detailClaim({
        settlement: { settle_at: '2020-01-01T00:00:00.000Z', state: 'pending_settlement' },
      }),
      onOpenSettlement: () => {},
    });
    expect(html).toContain('Elapsed — the settlement is eligible for review.');
  });

  it('reports an open window as refusing payout until it closes', () => {
    const html = renderDrawer('available', {
      claim: detailClaim({
        settlement: { settle_at: '2099-01-01T00:00:00.000Z', state: 'pending_settlement' },
      }),
      onOpenSettlement: () => {},
    });
    expect(html).toContain('Still open — the server refuses approval and payout until it closes.');
  });

  it('says no window is recorded instead of inventing one', () => {
    const html = renderDrawer('available', {
      claim: detailClaim({ settlement: { settle_at: null, state: 'pending_settlement' } }),
      onOpenSettlement: () => {},
    });
    expect(html).toContain('No review window recorded — the claim cannot become due until one is set.');
  });
});
