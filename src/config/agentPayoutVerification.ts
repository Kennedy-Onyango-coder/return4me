// =============================================================================
// AGENT DASHBOARD BATCH 2 — PAYOUT DESTINATION CHANGE POLICY.
//
// PURE. No React, no I/O, no database import. Everything in this file is a
// decision that can be executed by a test, and every decision is built around
// one rule that must never be softened:
//
//   A DESTINATION FORMAT CHECK IS NOT A VERIFICATION.
//
// `normalizePersonalMpesaPhoneDestination()` (config/payoutDestinations.ts)
// proves only that a string looks like a Kenyan personal M-Pesa number. It
// proves nothing about whether the number exists, is reachable, or belongs to
// the agent proposing it. So this module keeps THREE INDEPENDENT FACTS apart:
//
//   1. destination_format_eligible — the submitted number normalises to
//      254 + nine digits and the method is the one supported method.
//   2. phone_verified_at           — proof of CONTROL of the proposed number,
//      which only a real delivery channel can produce.
//   3. admin_approved_at           — an administrator's decision.
//
// No one of them implies another, and ACTIVATION requires 1 + 2 + 3.
//
// WHY VERIFICATION IS UNAVAILABLE IN THIS BUILD
// ---------------------------------------------
// There is no configured delivery channel: SMS is disabled in this deployment
// (SMS_ENABLED !== 'true') and WhatsApp is deferred. Rather than ship a
// challenge flow that generates a code it cannot deliver, this module reports
// `verification_available: false` and the routes refuse to start a challenge.
// `AGENT_PAYOUT_PHONE_VERIFICATION_ADAPTER_IMPLEMENTED` is the explicit
// integration boundary: when a real provider adapter exists it must be wired
// here, and only then may a challenge be issued. Until that day NO route can
// set `phone_verified_at`, so no destination can ever activate — and that is
// the honest behaviour, not an incomplete one.
//
// EMAIL IS NOT PHONE OWNERSHIP
// ----------------------------
// The platform already proves control of an EMAIL mailbox for other flows. That
// proof says nothing about who controls a mobile number, so nothing in this
// module accepts an email OTP as evidence for `phone_verified_at`.
// =============================================================================

import {
  PERSONAL_MPESA_PAYOUT_METHOD,
  maskPayoutDestinationForLog,
  normalizePersonalMpesaPhoneDestination,
} from './payoutDestinations';

// ---------------------------------------------------------------------------
// VERIFICATION CHANNEL
// ---------------------------------------------------------------------------

/** The delivery channels this policy can reason about. */
export type AgentPayoutVerificationChannel = 'none' | 'sms' | 'whatsapp';

/**
 * THE INTEGRATION BOUNDARY.
 *
 * `false` means this build contains NO adapter that can deliver a one-time code
 * to a mobile number and attest that the recipient returned it. Setting this to
 * `true` without wiring a real, audited adapter would make the platform claim
 * verification it never performed, so it stays `false` until that work lands.
 */
export const AGENT_PAYOUT_PHONE_VERIFICATION_ADAPTER_IMPLEMENTED = false;

/**
 * How long a proposed destination change remains reviewable. After this, the
 * change expires and can never activate. 14 days is long enough for a real
 * administrator review and short enough that an abandoned request does not
 * linger indefinitely.
 */
export const AGENT_PAYOUT_CHANGE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** A rejection reason is operator text, not a free-text dumping ground. */
export const AGENT_PAYOUT_CHANGE_MAX_REJECTION_REASON_LENGTH = 500;

/**
 * The complete persisted lifecycle vocabulary.
 *
 * `pending_verification`     — proposed, format-eligible, awaiting proof of
 *                              control of the number (and possibly an admin
 *                              decision; the two facts are separate columns).
 * `pending_admin_approval`   — phone ownership proven, awaiting an admin.
 * `activated`                — proof + approval both satisfied and the agents
 *                              row was updated. Terminal.
 * `rejected`                 — an admin refused the change. Terminal.
 * `expired`                  — the TTL elapsed before completion. Terminal.
 */
export const AGENT_PAYOUT_CHANGE_STATUSES = [
  'pending_verification',
  'pending_admin_approval',
  'activated',
  'rejected',
  'expired',
] as const;

export type AgentPayoutChangeStatus = (typeof AGENT_PAYOUT_CHANGE_STATUSES)[number];

/** Statuses that still occupy an agent's single live-request slot. */
export const LIVE_AGENT_PAYOUT_CHANGE_STATUSES: readonly AgentPayoutChangeStatus[] = [
  'pending_verification',
  'pending_admin_approval',
];

/** A derived, human-facing state. `ready_to_activate` is transient. */
export type AgentPayoutChangeState =
  | 'pending_verification'
  | 'pending_admin_approval'
  | 'ready_to_activate'
  | 'activated'
  | 'rejected'
  | 'expired';

export interface AgentPayoutVerificationStatus {
  /** The ONLY field a client may branch on to decide whether a code can exist. */
  verification_available: boolean;
  /** The usable channel. `none` whenever verification is unavailable. */
  channel: AgentPayoutVerificationChannel;
  /** The channel named by configuration, even when it is not usable. */
  configured_channel: AgentPayoutVerificationChannel;
  reason:
    | 'available'
    | 'no_delivery_channel_configured'
    | 'delivery_adapter_not_implemented'
    | 'delivery_channel_disabled';
  /** Safe, PII-free explanation. Never claims a code was sent. */
  message: string;
}

const UNAVAILABLE_MESSAGE =
  'Phone verification is not available in this deployment: no SMS or WhatsApp delivery channel is configured. ' +
  'No verification code has been sent. A proposed payout number cannot be activated until real phone verification ' +
  'is available and completed, and an administrator has approved the change.';

/**
 * Resolve the verification status from configuration.
 *
 * FAIL CLOSED: an unrecognised value, a disabled SMS switch or a missing adapter
 * all produce `verification_available: false`. There is deliberately no path
 * that reports a channel as usable merely because a variable names one.
 */
export function resolveAgentPayoutVerificationStatus(
  env: Record<string, string | undefined> = process.env,
): AgentPayoutVerificationStatus {
  const configuredRaw = String(env.AGENT_PAYOUT_PHONE_VERIFICATION_CHANNEL ?? '').trim().toLowerCase();
  const configured: AgentPayoutVerificationChannel =
    configuredRaw === 'sms' || configuredRaw === 'whatsapp' ? configuredRaw : 'none';

  if (configured === 'none') {
    return {
      verification_available: false,
      channel: 'none',
      configured_channel: 'none',
      reason: 'no_delivery_channel_configured',
      message: UNAVAILABLE_MESSAGE,
    };
  }

  if (!AGENT_PAYOUT_PHONE_VERIFICATION_ADAPTER_IMPLEMENTED) {
    return {
      verification_available: false,
      channel: 'none',
      configured_channel: configured,
      reason: 'delivery_adapter_not_implemented',
      message: UNAVAILABLE_MESSAGE,
    };
  }

  // Even with an adapter, the transport must actually be enabled. SMS is the
  // only transport this project has ever configured; `SMS_ENABLED` is the same
  // switch the SMS delivery service reads.
  if (configured === 'sms' && env.SMS_ENABLED !== 'true') {
    return {
      verification_available: false,
      channel: 'none',
      configured_channel: 'sms',
      reason: 'delivery_channel_disabled',
      message: UNAVAILABLE_MESSAGE,
    };
  }

  return {
    verification_available: true,
    channel: configured,
    configured_channel: configured,
    reason: 'available',
    message: 'Phone verification is available for this deployment.',
  };
}

// ---------------------------------------------------------------------------
// PROPOSAL VALIDATION (format only — never a verification claim)
// ---------------------------------------------------------------------------

export type AgentPayoutProposalFailure =
  | 'destination_missing'
  | 'destination_not_a_personal_mpesa_phone'
  | 'unsupported_payout_method';

export type AgentPayoutProposalResult =
  | { ok: true; canonicalDestination: string; maskedDestination: string; payoutMethod: string }
  | { ok: false; code: AgentPayoutProposalFailure; maskedDestination: string };

/**
 * Validate a proposed destination and method.
 *
 * The method is checked BEFORE the number so a caller that submits a Till,
 * Paybill or Pochi request is told the method is unsupported even if its number
 * happens to look like a phone number. Only the one supported method is ever
 * accepted; nothing is coerced.
 */
export function resolveAgentPayoutProposal(input: {
  destination?: unknown;
  payoutMethodType?: unknown;
}): AgentPayoutProposalResult {
  const maskedDestination = maskPayoutDestinationForLog(input?.destination);

  const suppliedMethod = input?.payoutMethodType;
  if (suppliedMethod !== undefined && suppliedMethod !== null && suppliedMethod !== '') {
    if (suppliedMethod !== PERSONAL_MPESA_PAYOUT_METHOD) {
      return { ok: false, code: 'unsupported_payout_method', maskedDestination };
    }
  }

  const raw = input?.destination;
  if (raw === null || raw === undefined) {
    return { ok: false, code: 'destination_missing', maskedDestination };
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    return { ok: false, code: 'destination_missing', maskedDestination };
  }

  const canonicalDestination = normalizePersonalMpesaPhoneDestination(raw);
  if (canonicalDestination === null) {
    return { ok: false, code: 'destination_not_a_personal_mpesa_phone', maskedDestination };
  }

  return {
    ok: true,
    canonicalDestination,
    maskedDestination,
    payoutMethod: PERSONAL_MPESA_PAYOUT_METHOD,
  };
}

/** The single canonical form of a stored proposed destination. */
export function canonicalAgentPayoutDestination(value: unknown): string | null {
  return normalizePersonalMpesaPhoneDestination(value);
}

// ---------------------------------------------------------------------------
// STATE MACHINE
// ---------------------------------------------------------------------------

function toMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(time) ? time : null;
}

function isExpired(change: any, now: Date): boolean {
  const expiresAt = toMillis(change?.expires_at);
  return expiresAt !== null && expiresAt <= now.getTime();
}

/**
 * The DERIVED state of a stored change row.
 *
 * The derivation is deliberately ordered so a recorded terminal decision always
 * wins over a lapse of time: a rejected request is not "expired", and an
 * activated request can never be un-activated by a clock.
 */
export function resolveAgentPayoutChangeState(change: any, now: Date = new Date()): AgentPayoutChangeState {
  if (change?.activated_at || change?.status === 'activated') return 'activated';
  if (change?.admin_rejected_at || change?.status === 'rejected') return 'rejected';
  if (isExpired(change, now)) return 'expired';
  const verified = Boolean(change?.phone_verified_at);
  const approved = Boolean(change?.admin_approved_at);
  if (verified && approved) return 'ready_to_activate';
  if (verified) return 'pending_admin_approval';
  return 'pending_verification';
}

// ---------------------------------------------------------------------------
// TERMINAL OUTCOME NOTICE (MEDIUM-2)
// ---------------------------------------------------------------------------

export interface AgentPayoutOutcomeNotice {
  kind: 'rejected' | 'expired' | 'activated';
  title: string;
  message: string;
  /**
   * The administrator's recorded reason, verbatim. NULL when none was stored —
   * the product never invents a reason and never edits one.
   */
  reason: string | null;
}

/**
 * What an agent should be told about a FINISHED request, or null while it is
 * still in flight.
 *
 * This is the single place that turns the derived state into agent-facing copy,
 * so the dashboard and any future surface cannot describe the same outcome
 * differently. It never states a destination (the caller renders the MASKED
 * value from the safe projection) and never claims a code was sent.
 */
export function resolveAgentPayoutOutcomeNotice(
  change: any,
  now: Date = new Date(),
): AgentPayoutOutcomeNotice | null {
  const state = resolveAgentPayoutChangeState(change, now);

  if (state === 'rejected') {
    const rawReason = typeof change?.rejection_reason === 'string' ? change.rejection_reason.trim() : '';
    return {
      kind: 'rejected',
      title: 'Change request rejected',
      message:
        'An administrator rejected this payout destination change. Your current payout destination stays in use.',
      reason: rawReason ? rawReason : null,
    };
  }

  if (state === 'expired') {
    return {
      kind: 'expired',
      title: 'Change request expired',
      message:
        'This payout destination change expired before it was completed. Your current payout destination stays in use, and no number was changed.',
      reason: null,
    };
  }

  if (state === 'activated') {
    return {
      kind: 'activated',
      title: 'Change request activated',
      message:
        'This payout destination change was approved and activated. It is now the destination in use for your commission.',
      reason: null,
    };
  }

  return null;
}

export type AgentPayoutActivationBlocker =
  | 'already_activated'
  | 'rejected'
  | 'expired'
  | 'destination_not_eligible'
  | 'phone_verification_required'
  | 'admin_approval_required';

export interface AgentPayoutActivationDecision {
  allowed: boolean;
  /** The FIRST unmet requirement, in the order a change must satisfy them. */
  reason: AgentPayoutActivationBlocker | null;
  blockers: AgentPayoutActivationBlocker[];
}

/**
 * Whether this change may now be written into the authoritative `agents` row.
 *
 * BOTH proofs are required. Admin approval alone can never activate an
 * unverified destination, and verification alone can never activate one an
 * administrator has not approved.
 */
export function evaluateAgentPayoutActivation(
  change: any,
  now: Date = new Date(),
): AgentPayoutActivationDecision {
  const blockers: AgentPayoutActivationBlocker[] = [];

  if (change?.activated_at || change?.status === 'activated') blockers.push('already_activated');
  if (change?.admin_rejected_at || change?.status === 'rejected') blockers.push('rejected');
  if (!change?.activated_at && isExpired(change, now)) blockers.push('expired');
  if (change?.destination_format_eligible !== true) blockers.push('destination_not_eligible');
  if (canonicalAgentPayoutDestination(change?.proposed_destination) === null) {
    if (!blockers.includes('destination_not_eligible')) blockers.push('destination_not_eligible');
  }
  if (!change?.phone_verified_at) blockers.push('phone_verification_required');
  if (!change?.admin_approved_at) blockers.push('admin_approval_required');

  return {
    allowed: blockers.length === 0,
    reason: blockers[0] ?? null,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// SAFE PROJECTION (masked destination only)
// ---------------------------------------------------------------------------

export interface AgentPayoutChangeView {
  id: string;
  /** The owning agent. An identifier, never a destination or contact detail. */
  agent_id: string;
  status: AgentPayoutChangeState;
  masked_proposed_destination: string;
  proposed_payout_method: string;
  destination_format_eligible: boolean;
  phone_verification: 'verified' | 'not_verified';
  phone_verified_at: string | null;
  admin_approval: 'approved' | 'rejected' | 'not_requested';
  admin_approved_at: string | null;
  admin_rejected_at: string | null;
  rejection_reason: string | null;
  created_at: string | null;
  expires_at: string | null;
  activated_at: string | null;
  can_activate: boolean;
  activation_blockers: AgentPayoutActivationBlocker[];
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const time = toMillis(value);
  return time === null ? null : new Date(time).toISOString();
}

/**
 * The ONLY shape a change row may leave the server in.
 *
 * No canonical destination, no raw proposed destination, no code and no hash —
 * the row has no code/hash columns at all, deliberately, because no challenge
 * mechanism exists.
 */
export function toAgentPayoutChangeView(change: any, now: Date = new Date()): AgentPayoutChangeView {
  const activation = evaluateAgentPayoutActivation(change, now);
  return {
    id: String(change?.id ?? ''),
    agent_id: String(change?.agent_id ?? ''),
    status: resolveAgentPayoutChangeState(change, now),
    masked_proposed_destination: maskPayoutDestinationForLog(change?.proposed_destination),
    proposed_payout_method: String(change?.proposed_payout_method ?? ''),
    destination_format_eligible: change?.destination_format_eligible === true,
    phone_verification: change?.phone_verified_at ? 'verified' : 'not_verified',
    phone_verified_at: toIsoOrNull(change?.phone_verified_at),
    admin_approval: change?.admin_rejected_at
      ? 'rejected'
      : change?.admin_approved_at
        ? 'approved'
        : 'not_requested',
    admin_approved_at: toIsoOrNull(change?.admin_approved_at),
    admin_rejected_at: toIsoOrNull(change?.admin_rejected_at),
    rejection_reason: change?.rejection_reason ? String(change.rejection_reason) : null,
    created_at: toIsoOrNull(change?.created_at),
    expires_at: toIsoOrNull(change?.expires_at),
    activated_at: toIsoOrNull(change?.activated_at),
    can_activate: activation.allowed,
    activation_blockers: activation.blockers,
  };
}

/** A PII-free sentence for an audit row. Masked destination only. */
export function describeAgentPayoutChangeForAudit(change: any, now: Date = new Date()): string {
  const state = resolveAgentPayoutChangeState(change, now);
  const masked = maskPayoutDestinationForLog(change?.proposed_destination);
  const method = String(change?.proposed_payout_method ?? PERSONAL_MPESA_PAYOUT_METHOD);
  return (
    `Payout destination change ${String(change?.id ?? '(unknown)')} for agent ${String(change?.agent_id ?? '(unknown)')} ` +
    `is '${state}' (proposed ${method} ${masked}; format eligible: ${change?.destination_format_eligible === true ? 'yes' : 'no'}; ` +
    `phone verified: ${change?.phone_verified_at ? 'yes' : 'no'}; admin approved: ${change?.admin_approved_at ? 'yes' : 'no'})`
  );
}
