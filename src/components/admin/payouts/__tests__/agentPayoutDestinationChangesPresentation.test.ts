import { describe, it, expect } from 'vitest';
import type { AgentPayoutAdminView } from '../../../../config/agentPayoutVerification';
import {
  AGENT_PAYOUT_STATE_LABELS,
  approvalActionFor,
  attestationActionFor,
  buildAgentPayoutTimeline,
  rejectionActionFor,
} from '../agentPayoutDestinationChangesPresentation';

// =============================================================================
// PHASE 2 — ADMIN PRESENTATION / DUAL-CONTROL RULES
// =============================================================================
// The server enforces the two-administrator rule in policy, the attestation
// writer and the activation transaction. These tests pin the UI's agreement with
// it: the console must not offer an approval to the administrator who attested,
// and a terminal request must not invite another decision.
// =============================================================================

const BASE = {
  id: 'APDC-1',
  agent_id: 'agent-1',
  status: 'pending_verification',
  masked_proposed_destination: '0712***678',
  proposed_payout_method: 'personal_mpesa',
  destination_format_eligible: true,
  phone_verification: 'not_verified',
  phone_verified_at: null,
  attestation: 'not_attested',
  attested_at: null,
  attestation_method: null,
  admin_approval: 'not_requested',
  admin_approved_at: null,
  admin_rejected_at: null,
  rejection_reason: null,
  created_at: '2026-10-01T08:30:00.000Z',
  expires_at: '2026-10-15T08:30:00.000Z',
  activated_at: null,
  can_activate: false,
  activation_blockers: [],
  attested_by: null,
  attestation_note: null,
  attestation_failure: null,
  admin_approved_by: null,
  admin_rejected_by: null,
  attester_approver_conflict: false,
  timeline: [
    {
      key: 'requested',
      state: 'done',
      label: 'Change requested by the agent (format check only)',
      at: '2026-10-01T08:30:00.000Z',
      actor: null,
      note: null,
      next_action: null,
    },
    {
      key: 'attested',
      state: 'current',
      label: 'Administrator phone call to the proposed number',
      at: null,
      actor: null,
      note: null,
      next_action: 'Call the proposed number.',
    },
    {
      key: 'approved',
      state: 'pending',
      label: 'Second administrator approval',
      at: null,
      actor: null,
      note: null,
      next_action: null,
    },
    {
      key: 'activated',
      state: 'pending',
      label: 'Destination written to the agent record',
      at: null,
      actor: null,
      note: null,
      next_action: null,
    },
  ],
} as unknown as AgentPayoutAdminView;

const attested = (attester: string): AgentPayoutAdminView =>
  ({
    ...BASE,
    attestation: 'attested',
    attested_at: '2026-10-02T09:00:00.000Z',
    attestation_method: 'admin_phone_call',
    attested_by: attester,
    attestation_note: 'Called the agent and confirmed the number.',
  }) as AgentPayoutAdminView;

describe('state labels never dress an attestation up as verification', () => {
  it('uses review/approval language for pending states', () => {
    expect(AGENT_PAYOUT_STATE_LABELS.pending_verification).toBe('Awaiting review');
    expect(AGENT_PAYOUT_STATE_LABELS.pending_admin_approval).toBe('Awaiting administrator approval');
    for (const label of Object.values(AGENT_PAYOUT_STATE_LABELS)) {
      expect(label.toLowerCase()).not.toContain('sms verified');
      expect(label.toLowerCase()).not.toContain('email verified');
    }
  });
});

describe('the two-administrator rule is visible before the server refuses', () => {
  it('requires a complete attestation before offering approval', () => {
    expect(approvalActionFor(BASE, 'admin-b')).toEqual({
      allowed: false,
      reason: 'attestation_required',
    });
  });

  it('refuses the attester as approver, case-insensitively and after trimming', () => {
    expect(approvalActionFor(attested('Alice'), '  alice ')).toEqual({
      allowed: false,
      reason: 'same_administrator',
    });
  });

  it('allows a DIFFERENT administrator to approve', () => {
    expect(approvalActionFor(attested('Alice'), 'Bob')).toEqual({ allowed: true, reason: null });
  });

  it('fails closed when the session carries no administrator identity', () => {
    expect(approvalActionFor(attested('Alice'), null)).toEqual({
      allowed: false,
      reason: 'identity_unknown',
    });
  });

  it('does not offer an attestation that would create a conflict with an approval', () => {
    const approvedFirst = {
      ...BASE,
      admin_approval: 'approved',
      admin_approved_at: '2026-10-02T09:00:00.000Z',
      admin_approved_by: 'Alice',
    } as AgentPayoutAdminView;
    expect(attestationActionFor(approvedFirst, 'alice')).toEqual({
      allowed: false,
      reason: 'conflict',
    });
    expect(attestationActionFor(attested('Alice'), 'Alice')).toEqual({
      allowed: false,
      reason: 'already_attested',
    });
  });

  it('offers nothing on a terminal request', () => {
    const rejected = {
      ...BASE,
      status: 'rejected',
      admin_approval: 'rejected',
      admin_rejected_at: '2026-10-03T09:00:00.000Z',
    } as AgentPayoutAdminView;
    expect(approvalActionFor(rejected, 'Bob').reason).toBe('terminal');
    expect(attestationActionFor(rejected, 'Bob').reason).toBe('terminal');
    expect(rejectionActionFor(rejected).reason).toBe('terminal');
  });
});

describe('the timeline states terminal outcomes truthfully', () => {
  it('appends a rejection with its persisted reason and blocks every pending step', () => {
    const rejected = {
      ...BASE,
      status: 'rejected',
      admin_approval: 'rejected',
      admin_rejected_at: '2026-10-03T09:00:00.000Z',
      admin_rejected_by: 'Alice',
      rejection_reason: 'The number does not belong to this agent.',
    } as AgentPayoutAdminView;

    const timeline = buildAgentPayoutTimeline(rejected);
    expect(timeline.some((event) => event.state === 'current' || event.state === 'pending')).toBe(false);
    const terminal = timeline[timeline.length - 1];
    expect(terminal.key).toBe('rejected');
    expect(terminal.actor).toBe('Alice');
    expect(terminal.note).toBe('The number does not belong to this agent.');
  });

  it('appends an expiry at the server-supplied expires_at', () => {
    const expired = { ...BASE, status: 'expired' } as AgentPayoutAdminView;
    const timeline = buildAgentPayoutTimeline(expired);
    const terminal = timeline[timeline.length - 1];
    expect(terminal.key).toBe('expired');
    expect(terminal.at).toBe('2026-10-15T08:30:00.000Z');
  });

  it('adds no terminal event to a live request', () => {
    expect(buildAgentPayoutTimeline(attested('Alice')).map((event) => event.key)).toEqual([
      'requested',
      'attested',
      'approved',
      'activated',
    ]);
  });
});
