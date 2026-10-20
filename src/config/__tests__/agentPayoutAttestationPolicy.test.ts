import { describe, it, expect } from 'vitest';
import {
  AGENT_PAYOUT_ATTESTATION_METHOD,
  AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH,
  AGENT_PAYOUT_PHONE_VERIFICATION_ADAPTER_IMPLEMENTED,
  agentPayoutAttesterApproverConflict,
  describeAgentPayoutChangeForAudit,
  evaluateAgentPayoutActivation,
  evaluateAgentPayoutAttestation,
  getAgentPayoutPhoneVerificationAdapter,
  resolveAgentPayoutChangeState,
  toAgentPayoutAdminView,
  toAgentPayoutChangeView,
} from '../agentPayoutVerification';

// =============================================================================
// PHASE 2 — THE ADMIN PHONE-CALL ATTESTATION POLICY
// =============================================================================
// These are PURE tests: no database, no provider, no route. They pin the one
// rule that must never be softened — an attestation is NOT phone verification,
// it must be COMPLETE, and the administrator who approves must be a DIFFERENT
// person from the one who attested.

const FUTURE = new Date(Date.now() + 60_000);
const ATTESTER = 'admin-one';
const APPROVER = 'admin-two';

function base(overrides: Record<string, unknown> = {}) {
  return {
    id: 'APDC-P2-PURE',
    agent_id: 'AGENT-P2',
    proposed_destination: '254712345678',
    proposed_payout_method: 'Personal M-Pesa',
    destination_format_eligible: true,
    status: 'pending_verification',
    expires_at: FUTURE,
    created_at: new Date(),
    ...overrides,
  };
}

function completeAttestation(overrides: Record<string, unknown> = {}) {
  return {
    attested_at: new Date(),
    attested_by: ATTESTER,
    attestation_method: AGENT_PAYOUT_ATTESTATION_METHOD,
    attestation_note: 'Called the number; the agent answered and confirmed control.',
    ...overrides,
  };
}

function approvedBy(actor: string) {
  return { admin_approved_at: new Date(), admin_approved_by: actor };
}

describe('Phase 2 — a complete administrator phone-call attestation', () => {
  it('is complete only when time, actor, method and a bounded note are all present', () => {
    expect(evaluateAgentPayoutAttestation(completeAttestation())).toEqual({
      complete: true,
      reason: null,
    });
  });

  it.each([
    ['attestation_time_missing', { attested_at: null }],
    ['attestation_actor_missing', { attested_by: '   ' }],
    ['attestation_missing', { attestation_method: null }],
    ['attestation_method_unsupported', { attestation_method: 'sms_otp' }],
    ['attestation_note_missing', { attestation_note: '   ' }],
    [
      'attestation_note_too_long',
      { attestation_note: 'x'.repeat(AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH + 1) },
    ],
  ])('reports %s rather than treating a partial claim as evidence', (reason, override) => {
    expect(evaluateAgentPayoutAttestation(completeAttestation(override)).reason).toBe(reason);
  });

  it('accepts a note of exactly the maximum length and trims it', () => {
    const note = 'n'.repeat(AGENT_PAYOUT_ATTESTATION_NOTE_MAX_LENGTH);
    expect(
      evaluateAgentPayoutAttestation(completeAttestation({ attestation_note: `  ${note}  ` }))
        .complete,
    ).toBe(true);
  });
});

describe('Phase 2 — activation requires dual control', () => {
  it('activates only with format eligibility + attestation + a different approver', () => {
    const change = base({ ...completeAttestation(), ...approvedBy(APPROVER) });
    expect(resolveAgentPayoutChangeState(change)).toBe('ready_to_activate');
    expect(evaluateAgentPayoutActivation(change)).toEqual({
      allowed: true,
      reason: null,
      blockers: [],
    });
  });

  it('refuses when the attester and approver are the same person, case-insensitively', () => {
    const change = base({ ...completeAttestation(), ...approvedBy('ADMIN-ONE') });
    expect(agentPayoutAttesterApproverConflict(change)).toBe(true);
    expect(resolveAgentPayoutChangeState(change)).toBe('attester_approver_conflict');
    expect(evaluateAgentPayoutActivation(change).blockers).toEqual([
      'attester_approver_conflict',
    ]);
  });

  it('refuses a format-ineligible destination even with both administrative decisions', () => {
    const change = base({
      destination_format_eligible: false,
      ...completeAttestation(),
      ...approvedBy(APPROVER),
    });
    expect(evaluateAgentPayoutActivation(change).blockers).toContain('destination_not_eligible');
  });

  it('refuses an expired request even with both administrative decisions', () => {
    const change = base({
      expires_at: new Date(Date.now() - 1_000),
      ...completeAttestation(),
      ...approvedBy(APPROVER),
    });
    expect(resolveAgentPayoutChangeState(change)).toBe('expired');
    expect(evaluateAgentPayoutActivation(change).blockers).toContain('expired');
  });

  it('does not require phone_verified_at (that fact needs an adapter this build does not have)', () => {
    const change = base({ ...completeAttestation(), ...approvedBy(APPROVER) });
    expect(change).not.toHaveProperty('phone_verified_at');
    expect(evaluateAgentPayoutActivation(change).allowed).toBe(true);
  });
});

describe('Phase 2 — no false verification claim, no live adapter', () => {
  it('keeps the delivery-adapter boundary explicitly false and returns no adapter', () => {
    expect(AGENT_PAYOUT_PHONE_VERIFICATION_ADAPTER_IMPLEMENTED).toBe(false);
    expect(getAgentPayoutPhoneVerificationAdapter()).toBeNull();
  });

  it('an attestation never appears as phone_verification in the agent projection', () => {
    const view = toAgentPayoutChangeView(
      base({ ...completeAttestation(), ...approvedBy(APPROVER) }),
    );
    expect(view.attestation).toBe('attested');
    expect(view.phone_verification).toBe('not_verified');
    expect(view.phone_verified_at).toBeNull();
    // The administrator's note is not part of the agent's view at all.
    expect(JSON.stringify(view)).not.toContain('agent answered');
    expect(JSON.stringify(view)).not.toContain('254712345678');
  });

  it('the administrator view carries the evidence and a truthful timeline', () => {
    const adminView = toAgentPayoutAdminView(
      base({ ...completeAttestation(), ...approvedBy(APPROVER) }),
    );
    expect(adminView.attested_by).toBe(ATTESTER);
    expect(adminView.attestation_note).toContain('agent answered');
    expect(adminView.attester_approver_conflict).toBe(false);
    const byKey = Object.fromEntries(
      adminView.timeline.map((event) => [event.key, event.state]),
    );
    expect(byKey).toEqual({
      requested: 'done',
      attested: 'done',
      approved: 'done',
      activated: 'current',
    });
  });

  it('the audit description names the attestation and the actors but never the note', () => {
    const text = describeAgentPayoutChangeForAudit(
      base({ ...completeAttestation(), ...approvedBy(APPROVER) }),
    );
    expect(text).toContain('admin phone-call attested: yes');
    expect(text).toContain(ATTESTER);
    expect(text).toContain(APPROVER);
    expect(text).not.toContain('agent answered');
    expect(text).not.toContain('254712345678');
  });
});
