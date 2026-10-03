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

export interface AgentEarnings {
  totalEarned: number;
  completedPayoutsCount: number;
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
