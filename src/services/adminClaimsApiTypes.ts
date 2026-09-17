// Explicit types for the Phase 6E Claims Administration read API.
//
// These mirror the DTOs enumerated in src/services/adminSafeViews.ts
// (toAdminSafeClaimListView / toAdminSafeClaimDetailView) field for field.
// They exist so the UI cannot silently start consuming a field the safe DTO
// does not define — and so a field REMOVED from the DTO breaks the build here
// rather than rendering as `undefined` in an admin's browser.
//
// Deliberately NOT modelled (they do not exist in the API, and the UI must
// never require them): payment_reference, security_answers, owner_id_proof_url,
// owner_identifying_details, owner_email, OTP values/hashes, session or token
// material, pickup-code hashes, evidence storage keys or signed URLs.
//
// React-free and dependency-free on purpose, so a node-environment vitest can
// import it (this repo has no jsdom / React Testing Library).

export interface AdminClaimItemView {
  id: string;
  category_id: string;
  category_name_en: string | null;
  status: string;
  is_sensitive_document: boolean;
  flagged_for_review: boolean;
}

export interface AdminClaimItemDetailView extends AdminClaimItemView {
  description: string | null;
  location_description: string | null;
}

export interface AdminClaimAgentView {
  id: string;
  business_name: string;
}

export interface AdminClaimAgentDetailView extends AdminClaimAgentView {
  contact_phone: string | null;
}

/** Current dispute state only — the historical snapshot is detail-only. */
export interface AdminClaimDisputeView {
  state: 'none' | 'open' | 'resolved';
  id: string | null;
  role: string | null;
  /** R1: true when this dispute predates the 6C snapshot, so the historical
   *  payment/status state is UNKNOWN — never "unpaid". */
  snapshot_incomplete: boolean;
}

export interface AdminClaimListView {
  id: string;
  status: string;
  /** false for terminal/inactive statuses (INACTIVE_CLAIM_STATUSES). */
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
  /** Already masked by the server. Display verbatim; never unmask. */
  claimant_phone: string | null;
  verification_tier: number | null;
  /** Authoritative: derived from claims.paid_at alone. */
  has_paid: boolean;
  /** Authoritative payment timestamp. null means NOT paid. */
  paid_at: string | null;
  /** Display alias of has_paid ('paid' | 'unpaid'), never a substitute for it. */
  payment_state: 'paid' | 'unpaid';
  /** Lifecycle bucket derived from status — NOT a monetary amount. */
  financial_state: string;
  agent_confirmed_at: string | null;
  item: AdminClaimItemView | null;
  agent: AdminClaimAgentView | null;
  dispute: AdminClaimDisputeView;
}

/** One participant of a dispute, as recorded when the dispute was filed. */
export interface AdminClaimHistoricalClaimView {
  claim_id: string | null;
  role: string | null;
  /** Detail DTO only — the CURRENT state of this participant. */
  current_status?: string | null;
  current_paid_at?: string | null;
  /** State AT DISPUTE CREATION. null + snapshot_incomplete=true means UNKNOWN. */
  status_at_dispute: string | null;
  paid_at_dispute: string | null;
}

export interface AdminClaimDetailDisputeView extends AdminClaimDisputeView {
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_claim_id: string | null;
  this_claim: AdminClaimHistoricalClaimView;
  other_claim: AdminClaimHistoricalClaimView;
}

export interface AdminClaimVerificationView {
  tier: number | null;
  agent_confirmed_at: string | null;
  /** Presence flags only — the values themselves are never in the DTO. */
  identifying_detail_present: boolean;
  id_proof_present: boolean;
  handover_photo_present: boolean;
}

export interface AdminClaimSettlementView {
  settle_at: string | null;
  /** Lifecycle bucket from status, NOT an amount. */
  state: string;
}

export interface AdminClaimSiblingView {
  id: string;
  status: string;
  has_paid: boolean;
  paid_at: string | null;
  claimant_phone: string | null;
  created_at: string | null;
}

export interface AdminClaimDetailView extends Omit<AdminClaimListView, 'item' | 'agent' | 'dispute'> {
  item: AdminClaimItemDetailView | null;
  agent: AdminClaimAgentDetailView | null;
  verification: AdminClaimVerificationView;
  settlement: AdminClaimSettlementView;
  /** null when this claim is not party to any dispute. */
  dispute: AdminClaimDetailDisputeView | null;
  sibling_claims: AdminClaimSiblingView[];
}

/**
 * Filters the 6E endpoint accepts. Every value is validated server-side; the
 * client only decides which are present. `claimantPhone` is passed through as
 * typed (the server normalises to E.164 and rejects malformed input with 400),
 * so no phone-parsing logic is duplicated in the browser.
 */
export interface AdminClaimsListFilters {
  status?: string;
  hasPaid?: boolean;
  disputeState?: 'none' | 'open' | 'resolved';
  claimId?: string;
  itemId?: string;
  claimantPhone?: string;
  createdFrom?: string;
  createdTo?: string;
}
