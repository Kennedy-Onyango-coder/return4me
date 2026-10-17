import type { FoundItem } from '../db/database';

export type AgentAssociatedClaimStatus =
  | 'escrow_held'
  | 'released'
  | 'disputed'
  | 'awaiting_agent_confirmation'
  | 'pending_payment';

export interface AgentAssociatedClaim {
  id: string;
  status: AgentAssociatedClaimStatus;
  agent_confirmed_at: string | null;
  owner_identifying_details: string | null;
  security_answers: Record<string, unknown>;
}

export type AgentPendingDropoff = FoundItem;

export type AgentHoldingPickup = FoundItem & {
  associatedClaim?: AgentAssociatedClaim;
};

/**
 * The Agent Hub's earnings projection.
 *
 * TWO STATES, DELIBERATELY SEPARATE (Issue B): a confirmed handover books an
 * `agent_payout` ledger row as PENDING and nothing is disbursed until the
 * dispute window closes. Reporting that as KES 0 "earned" hid a real, owed
 * payout from the agent, so pending settlement and completed (genuinely paid)
 * earnings are published as distinct figures.
 *
 *   totalEarned               — completed, provider-confirmed payouts only
 *   completedPayoutsCount     — how many payouts make up totalEarned
 *   pendingSettlementEarnings — booked payouts still inside their window
 *   pendingSettlementsCount   — how many are still pending
 *
 * A failed payout is in NEITHER figure. An 'unknown' provider outcome is stored
 * as a pending row, so it is counted as pending and never as completed.
 */
export interface AgentEarnings {
  totalEarned: number;
  completedPayoutsCount: number;
  pendingSettlementEarnings: number;
  pendingSettlementsCount: number;
}

/**
 * B2 — the signed-in agent's own identity, as the dashboard actually consumes
 * it. This is the explicit allowlist for GET /api/agents/queue's `agent` field;
 * nothing else from the database agent record is serialized.
 */
export interface AgentQueueSelf {
  business_name: string;
  location_address: string;
  payout_method_type: string;
  mpesa_till_or_paybill: string;
}

export interface AgentQueueResponse {
  agent: AgentQueueSelf;
  earnings: AgentEarnings;
  pendingDropoffs: AgentPendingDropoff[];
  holdingItems: AgentHoldingPickup[];
}

export interface AgentMutationResponse {
  success: true;
  message: string;
  settleAt?: string;
}

export interface VerifyAgentItemPayload {
  dropoffCode: string;
  categoryId: string;
  name: string | null;
  documentNumber: string | null;
  description: string | null;
  foundArea: string;
  reason: string;
  reasonDetail: string | null;
  physicallyVerified: boolean;
}

export interface ConfirmDropoffPayload {
  dropoffCode: string;
}

export interface RejectDropoffPayload {
  dropoffCode: string;
  reason: string;
}

export interface ConfirmHandoverPayload {
  claimId: string;
  pickupCode: string;
  handoverPhotoBase64: string | null;
}

// ---------------------------------------------------------------------------
// AGENT DASHBOARD BATCH 2 — PAYOUT SETTINGS
//
// The change view is re-exported from the ONE policy module instead of being
// restated here: the server projection and the dashboard must not be able to
// drift on which fields exist or what `status` can mean. Every destination in
// these DTOs is MASKED; no response type has a field for a full number, a code
// or a hash.
// ---------------------------------------------------------------------------
export type {
  AgentPayoutChangeView,
  AgentPayoutVerificationStatus,
} from '../config/agentPayoutVerification';
import type {
  AgentPayoutChangeView,
  AgentPayoutVerificationStatus,
} from '../config/agentPayoutVerification';

export interface AgentPayoutSettingsCurrent {
  /** The active method. Only `Personal M-Pesa` is eligible for payout. */
  method: string;
  /** Masked (never the full number). */
  masked_destination: string;
  /** FORMAT + METHOD eligibility. NOT a verification. */
  eligible: boolean;
  risk_class: string;
  /** Always true: states explicitly that this is a format check only. */
  format_check_only: true;
  /** True only when an activated change recorded a real phone attestation. */
  phone_ownership_verified: boolean;
  phone_ownership_verified_at: string | null;
}

export interface AgentPayoutSettingsResponse {
  payout: AgentPayoutSettingsCurrent;
  verification: AgentPayoutVerificationStatus;
  /** LIVE only: the request still occupying this agent's single slot. */
  pending_request: AgentPayoutChangeView | null;
  /**
   * MEDIUM-2 — the newest request for this agent in ANY state, including the
   * terminal outcomes `pending_request` stops reporting (rejected / expired /
   * activated). Masked exactly like every other view; `rejection_reason` is the
   * administrator's text when one was recorded. Scoped server-side to the
   * caller's own agent id.
   */
  latest_request: AgentPayoutChangeView | null;
}

export interface AgentPayoutChangeRequestResponse {
  success: boolean;
  created: boolean;
  duplicate: boolean;
  request: AgentPayoutChangeView;
  verification: AgentPayoutVerificationStatus;
  message: string;
}
