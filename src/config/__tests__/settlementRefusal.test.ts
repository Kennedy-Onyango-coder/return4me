import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  classifyUnresolvedPayoutRow,
  describeSettlementRefusal,
  settlementRefusalBody,
  type SettlementRefusalCode,
} from '../settlementRefusal';

// =============================================================================
// PHASE 3 — STABLE REFUSAL CODES AND ACTIONABLE MESSAGES
// =============================================================================

const CODES: SettlementRefusalCode[] = [
  'claim_not_found',
  'claim_data_unreadable',
  'item_missing',
  'agent_missing',
  'category_missing',
  'payout_paused',
  'claim_not_pending_settlement',
  'settlement_already_in_flight',
  'durable_approval_missing',
  'settlement_window_open',
  'release_lock_lost',
  'release_state_changed',
  'approval_snapshot_mismatch',
  'approval_snapshot_unreadable',
  'payout_rows_missing',
  'payout_rows_unreadable',
  'ledger_amount_mismatch',
  'ledger_destination_mismatch',
  'destination_not_eligible',
  'payout_outcome_unresolved',
  'submission_history_unknown',
  'provider_refused',
  'provider_accepted_unconfirmed',
  'provider_outcome_ambiguous',
  'payout_already_sent',
  'no_submittable_payout',
  'simulation_not_permitted',
  'disbursement_wallet_missing',
  'wallet_routing_refused',
  'item_on_hold',
  'payout_recording_failed',
  'internal_error',
];

describe('Phase 3 — every refusal is specific, actionable and never a retry promise', () => {
  it('covers every required code with a non-empty message and next action', () => {
    for (const code of CODES) {
      const refusal = describeSettlementRefusal(code);
      expect(refusal.code, code).toBe(code);
      expect(refusal.operator_message.length, code).toBeGreaterThan(20);
      expect(refusal.next_action.length, code).toBeGreaterThan(10);
      expect(refusal.automatic_retry, code).toBe(false);
    }
  });

  it('never promises an automatic retry or claims success', () => {
    for (const code of CODES) {
      const text = JSON.stringify(describeSettlementRefusal(code)).toLowerCase();
      expect(text, code).not.toContain('will retry');
      expect(text, code).not.toContain('retried automatically for you');
      expect(text, code).not.toContain('successfully paid');
      expect(text, code).not.toMatch(/"paid":true/);
    }
  });

  it('keeps a detail string but never invents a different code', () => {
    const refusal = describeSettlementRefusal('ledger_amount_mismatch', 'finder row LED-1');
    expect(refusal.code).toBe('ledger_amount_mismatch');
    expect(refusal.operator_message).toContain('finder row LED-1');
    expect(refusal.next_action).toContain('never edit the ledger amount');
  });

  it('the route body has a stable shape and always disables automatic retry', () => {
    const body = settlementRefusalBody('provider_outcome_ambiguous');
    expect(body).toMatchObject({
      reason_code: 'provider_outcome_ambiguous',
      automatic_retry: false,
    });
    expect(body.operator_message).toContain('may already have been executed');
    expect(body.next_action).toContain('Verify the transaction with the provider');
  });
});

describe('Phase 3 — an unresolved row is classified by what is recorded', () => {
  it.each([
    ['completed', 'payout_already_sent'],
    ['accepted', 'payout_already_sent'],
    ['rejected', 'provider_refused'],
    ['submitting', 'provider_accepted_unconfirmed'],
    ['unknown', 'provider_outcome_ambiguous'],
    [null, 'submission_history_unknown'],
    ['not_submitted', 'payout_outcome_unresolved'],
  ])('maps outcome %s to %s', (outcome, expected) => {
    expect(classifyUnresolvedPayoutRow({ status: 'pending', payout_outcome: outcome as any })).toBe(
      expected,
    );
  });

  it('a NULL outcome is never described as "never submitted"', () => {
    const refusal = describeSettlementRefusal(
      classifyUnresolvedPayoutRow({ status: 'pending', payout_outcome: null }),
    );
    expect(refusal.operator_message).toContain('cannot prove whether the provider executed it');
    expect(refusal.next_action).toContain('Do not resend');
  });

  it('every settlement failure response on the server carries the stable reason code', () => {
    const server = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');
    expect(server).toContain('...settlementRefusalBody(result.reason_code ?? \'internal_error\')');
    expect(server).toContain("reason_code: unresolvedRefusal.reason_code");
    expect(server).toContain('automatic_retry: false');
    // The old generic sentence is gone.
    expect(server).not.toContain('Settlement not completed - ${unresolvedPayout.type} is unresolved');
  });
});
