import type { Agent, FoundItem } from '../db/database';

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

export interface AgentQueueResponse {
  agent: Agent;
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
