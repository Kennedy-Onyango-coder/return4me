// =============================================================================
// AGENT PAYOUT DESTINATION CHANGES — ADMIN PRESENTATION RULES
// =============================================================================
// PURE. No React, no I/O. These helpers decide what the Phase 2 admin panel
// says and which control it offers; they never decide whether a destination may
// activate. The server's policy and compare-and-swap transactions remain the
// only authority.
//
// Two rules are load-bearing:
//   1. An attestation is NOT phone verification. Nothing here may label an
//      attestation "verified", claim a code was sent, or suggest that an email
//      OTP proves control of a mobile number.
//   2. The attester and the approver must be different administrators. The
//      client-side check below explains the rule; the server refuses the
//      approval regardless of what this browser renders.
// =============================================================================

import type {
  AgentPayoutAdminTimelineEvent,
  AgentPayoutAdminView,
  AgentPayoutChangeState,
} from '../../../config/agentPayoutVerification';

export const AGENT_PAYOUT_STATE_LABELS: Record<AgentPayoutChangeState, string> = {
  pending_verification: 'Awaiting review',
  pending_admin_approval: 'Awaiting administrator approval',
  ready_to_activate: 'Ready to activate',
  attester_approver_conflict: 'Blocked — same administrator recorded both steps',
  activated: 'Activated',
  rejected: 'Rejected',
  expired: 'Expired',
};

export function agentPayoutStateVariant(
  state: AgentPayoutChangeState,
): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (state === 'activated') return 'success';
  if (state === 'rejected' || state === 'expired' || state === 'attester_approver_conflict') {
    return 'danger';
  }
  if (state === 'ready_to_activate') return 'info';
  return 'warning';
}

export function isLiveAgentPayoutChange(view: AgentPayoutAdminView): boolean {
  return view.status === 'pending_verification' || view.status === 'pending_admin_approval';
}

/** Normalised administrator identity, matching the server's comparison rule. */
export function normalizeAdministrator(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.toLowerCase();
}

export type AgentPayoutActionBlock =
  | 'terminal'
  | 'already_attested'
  | 'attestation_required'
  | 'already_approved'
  | 'same_administrator'
  | 'conflict'
  | 'identity_unknown';

export interface AgentPayoutActionDecision {
  allowed: boolean;
  reason: AgentPayoutActionBlock | null;
}

export const AGENT_PAYOUT_ACTION_BLOCK_MESSAGES: Record<AgentPayoutActionBlock, string> = {
  terminal: 'This request is in a terminal state. No further decision can be recorded.',
  already_attested: 'A complete phone-call attestation is already on file. It cannot be replaced from this screen.',
  attestation_required:
    'A complete administrator phone-call attestation must be recorded before this request can be approved.',
  already_approved: 'An administrator approval is already on file for this request.',
  same_administrator:
    'You recorded the phone-call attestation for this request. A DIFFERENT administrator must approve it.',
  conflict:
    'The same administrator recorded the attestation and the approval. This request cannot activate; it must be rejected and re-proposed.',
  identity_unknown:
    'This session does not carry an administrator username, so the two-administrator rule cannot be shown. The server will still refuse an invalid approval.',
};

/** Can this administrator record the phone-call attestation? */
export function attestationActionFor(
  view: AgentPayoutAdminView,
  currentAdministrator: string | null | undefined,
): AgentPayoutActionDecision {
  if (!isLiveAgentPayoutChange(view)) return { allowed: false, reason: 'terminal' };
  if (view.attestation === 'attested') return { allowed: false, reason: 'already_attested' };
  const approver = normalizeAdministrator(view.admin_approved_by);
  const actor = normalizeAdministrator(currentAdministrator);
  if (approver !== null && actor !== null && approver === actor) {
    return { allowed: false, reason: 'conflict' };
  }
  return { allowed: true, reason: null };
}

/**
 * Can this administrator record the SEPARATE approval?
 *
 * A missing identity fails CLOSED: the panel cannot prove the two-administrator
 * rule, and the server will refuse a conflicted approval anyway. This is UI
 * gating only; the server re-checks the persisted attester against the
 * authenticated approver.
 */
export function approvalActionFor(
  view: AgentPayoutAdminView,
  currentAdministrator: string | null | undefined,
): AgentPayoutActionDecision {
  if (!isLiveAgentPayoutChange(view)) return { allowed: false, reason: 'terminal' };
  if (view.admin_approval === 'approved') return { allowed: false, reason: 'already_approved' };
  if (view.attester_approver_conflict) return { allowed: false, reason: 'conflict' };
  if (view.attestation !== 'attested') return { allowed: false, reason: 'attestation_required' };
  const actor = normalizeAdministrator(currentAdministrator);
  if (actor === null) return { allowed: false, reason: 'identity_unknown' };
  const attester = normalizeAdministrator(view.attested_by);
  if (attester !== null && attester === actor) {
    return { allowed: false, reason: 'same_administrator' };
  }
  return { allowed: true, reason: null };
}

/** Can this administrator reject the request? Rejection is terminal. */
export function rejectionActionFor(view: AgentPayoutAdminView): AgentPayoutActionDecision {
  if (!isLiveAgentPayoutChange(view)) return { allowed: false, reason: 'terminal' };
  return { allowed: true, reason: null };
}

export type AgentPayoutTerminalTimelineEvent = Omit<AgentPayoutAdminTimelineEvent, 'key'> & {
  key: 'requested' | 'attested' | 'approved' | 'activated' | 'rejected' | 'expired';
};

/**
 * The server's four-step timeline, plus the terminal event it reports through
 * the row's own status/timestamps. The terminal event is built from server
 * fields only; no state is inferred from the browser's clock or from intent.
 *
 * When a request was rejected or expired, any step the server still marked
 * `current` or `pending` is rendered `blocked`: a terminal request can never
 * advance, and a "next: approve" prompt on a rejected row would be false.
 */
export function buildAgentPayoutTimeline(
  view: AgentPayoutAdminView,
): AgentPayoutTerminalTimelineEvent[] {
  const terminal = view.status === 'rejected' || view.status === 'expired';
  const base: AgentPayoutTerminalTimelineEvent[] = view.timeline.map((event) => ({
    ...event,
    state:
      terminal && (event.state === 'current' || event.state === 'pending')
        ? 'blocked'
        : event.state,
  }));

  if (view.status === 'rejected') {
    base.push({
      key: 'rejected',
      state: 'done',
      label: 'Request rejected by an administrator',
      at: view.admin_rejected_at,
      actor: view.admin_rejected_by,
      note: view.rejection_reason,
      next_action: null,
    });
  } else if (view.status === 'expired') {
    base.push({
      key: 'expired',
      state: 'done',
      label: 'Request expired before completion',
      at: view.expires_at,
      actor: null,
      note: 'The review window elapsed. The current payout destination remains in use.',
      next_action: null,
    });
  }

  return base;
}

/** Human label for one activation blocker, from the server's vocabulary. */
export const ACTIVATION_BLOCKER_LABELS: Record<string, string> = {
  already_activated: 'The destination was already activated.',
  rejected: 'The request was rejected.',
  expired: 'The review window elapsed before the request completed.',
  destination_not_eligible: 'The proposed destination is not a Personal M-Pesa phone number.',
  attestation_required: 'No complete administrator phone-call attestation is on file.',
  admin_approval_required: 'No administrator approval is on file.',
  attester_approver_conflict: 'The same administrator attested and approved the change.',
};

export function describeActivationBlocker(code: string): string {
  return ACTIVATION_BLOCKER_LABELS[code] ?? code;
}
