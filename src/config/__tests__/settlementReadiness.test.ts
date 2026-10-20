import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { evaluateSettlementReadiness } from '../settlementReadiness';

// =============================================================================
// PHASE 3 — READ-ONLY SETTLEMENT READINESS
// =============================================================================

function input(overrides: Record<string, any> = {}) {
  const claim = {
    id: 'CLM-READY',
    item_id: 'ITEM-1',
    status: 'pending_settlement',
    settle_at: new Date(Date.now() - 60_000).toISOString(),
    settlement_approved_at: new Date().toISOString(),
    settlement_approved_by: 'admin-one',
    settlement_authorized_total: null,
    settlement_authorized_ledger_ids: null,
    ...overrides.claim,
  };
  const item = {
    id: 'ITEM-1',
    assigned_agent_id: 'AGENT-1',
    category_id: 'CAT-1',
    finder_phone: '254711111111',
    locked_finder_share: 100,
    locked_agent_share: 200,
    status: 'verified',
    ...overrides.item,
  };
  const agent = {
    id: 'AGENT-1',
    mpesa_till_or_paybill: '254722222222',
    payout_method_type: 'Personal M-Pesa',
    ...overrides.agent,
  };
  const category = { id: 'CAT-1', finder_share: 100, agent_share: 200, ...overrides.category };
  const ledgerRows = overrides.ledgerRows ?? [
    {
      id: 'LED-F',
      claim_id: 'CLM-READY',
      type: 'finder_payout',
      amount: 100,
      phone_or_till: '254711111111',
      status: 'pending',
      payout_outcome: 'not_submitted',
    },
    {
      id: 'LED-A',
      claim_id: 'CLM-READY',
      type: 'agent_payout',
      amount: 200,
      phone_or_till: '254722222222',
      status: 'pending',
      payout_outcome: 'not_submitted',
    },
  ];
  return {
    claim,
    item,
    agent,
    category,
    ledgerRows,
    payoutsPaused: false,
    simulation: { required: false, permitted: false },
    wallet: { disbursementConfigured: true, routingOk: true, routingCode: 'ready' },
    now: new Date(),
    ...overrides,
  };
}

describe('Phase 3 — readiness is a complete local checklist', () => {
  it('is ready only when every condition passes', () => {
    const result = evaluateSettlementReadiness(input());
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.conditions.every((condition) => condition.ok)).toBe(true);
  });

  it.each([
    ['claim_not_found', { claim: null }],
    ['claim_not_pending_settlement', { claim: { status: 'released' } }],
    ['settlement_window_open', { claim: { settle_at: new Date(Date.now() + 60_000).toISOString() } }],
    ['durable_approval_missing', { claim: { settlement_approved_at: null } }],
    ['payout_rows_missing', { ledgerRows: [] }],
    ['payout_outcome_unresolved', { ledgerRows: [
      { id: 'LED-F', type: 'finder_payout', amount: 100, phone_or_till: '254711111111', status: 'pending', payout_outcome: 'unknown' },
      { id: 'LED-A', type: 'agent_payout', amount: 200, phone_or_till: '254722222222', status: 'pending', payout_outcome: 'not_submitted' },
    ] }],
    ['destination_not_eligible', { agent: { mpesa_till_or_paybill: '123456', payout_method_type: 'Till Number' } }],
    ['ledger_amount_mismatch', { item: { locked_finder_share: 99 } }],
    ['payout_paused', { payoutsPaused: true }],
    ['simulation_not_permitted', { simulation: { required: true, permitted: false } }],
    ['disbursement_wallet_missing', { wallet: { disbursementConfigured: false, routingOk: true, routingCode: 'not_required' } }],
    ['wallet_routing_refused', { wallet: { disbursementConfigured: true, routingOk: false, routingCode: 'payout_wallet_is_settlement_wallet' } }],
    ['claim_data_unreadable', { agent: null }],
  ])('reports %s as a blocking condition', (code, override) => {
    const result = evaluateSettlementReadiness(input(override as any));
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(code);
  });

  it('every failing condition carries an actionable next action', () => {
    const result = evaluateSettlementReadiness(input({ payoutsPaused: true }));
    const failing = result.conditions.filter((condition) => !condition.ok);
    expect(failing.length).toBeGreaterThan(0);
    for (const condition of failing) {
      expect(condition.detail.length).toBeGreaterThan(10);
      expect(condition.next_action.length).toBeGreaterThan(10);
    }
  });

  it('is pure: it reads no clock beyond the supplied now and performs no I/O', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../settlementReadiness.ts'), 'utf8');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('process.env');
    expect(source).not.toMatch(/getWalletBalance|walletBalance|balance\s*\(/);
    expect(source).not.toContain('db.');
  });

  it('the server endpoint is permissioned and performs no provider call or payout write', () => {
    const server = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');
    const start = server.indexOf("'/api/admin/claims/:id/settlement-readiness'");
    expect(start).toBeGreaterThan(-1);
    const end = server.indexOf("app.post('/api/admin/claims/:id/settlement/initiate'", start);
    expect(end).toBeGreaterThan(start);
    const route = server.slice(start, end);
    expect(route).toContain('requireAdminPermission(ADMIN_PERMISSIONS.CLAIMS_DETAIL)');
    // The repository's /api/admin invariant is enforced IN the route as well as
    // by the named permission: authenticateJWT does not prove the admin role,
    // and a pending-2FA token must never reach this read.
    expect(route).toContain("if (req.user?.role !== 'admin')");
    expect(route).toContain("return res.status(403).json({ error: 'Access denied.' });");
    expect(route).toContain('evaluateSettlementReadiness(');
    expect(route).not.toContain('triggerIntasendPayout');
    expect(route).not.toContain('markPayoutSubmissionStarted');
    expect(route).not.toContain('wallet balance');
  });
});
