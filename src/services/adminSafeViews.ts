import { INACTIVE_CLAIM_STATUSES } from '../config/claimStatuses';


// Hand-built, whitelisted DTOs for the ADMIN console's bulk dashboard endpoint.
//
// WHY THIS MODULE EXISTS
// The admin dashboard is a BULK operational endpoint: every console page-load
// fetches it. It previously built its payload by spreading raw database rows
// (`{ ...agent }`, `{ ...item }`) and by returning `db.getDisputes()` verbatim,
// which meant every database column reached the browser on every refresh —
// including fields no admin screen reads and several that are sensitive
// evidence rather than operational data:
//
//   agents   : national_id_hash, id_document_photo_url, shop_photo_url
//   items    : document_number_hash, finder_email, ...
//   disputes : claimant_1_id_proof_url, claimant_2_id_proof_url, admin_notes
//
// This is the same problem ownerSafeViews.ts already solves for the
// owner/claimant surfaces. These are the admin equivalents: every function
// enumerates its allowed fields EXPLICITLY and never spreads a raw row.
//
// PRINCIPLE: sensitive evidence is retrieved on demand, when an administrator
// is actually performing the operation that needs it — not bundled into every
// dashboard refresh. Agent vetting documents therefore live behind
// GET /api/admin/agents/:id/documents (see toAdminSafeAgentDocumentsView).
//
// These DTOs are ADMIN-specific on purpose. They are not the owner/customer
// whitelists: the console legitimately needs operational/financial fields
// (till numbers, deposits, warning history, finder contact, OCR plaintext for
// the review queue) that an owner or customer must never see.

// Whitelists an Agent row down to the fields the Agents Hub actually renders
// and the admin actions in that tab actually need. Deliberately excludes:
//   - national_id_hash       — a privacy-preserving HMAC with no admin use
//   - id_document_photo_url  — sensitive identity evidence (on-demand only)
//   - shop_photo_url         — only shown inside an expanded row (on-demand)
//   - terms_accepted_at      — never rendered
export function toAdminSafeAgentView(
  agent: any,
  metrics?: { total_earned?: number; completed_payouts_count?: number }
): any {
  if (!agent) return null;
  return {
    id: agent.id,
    business_name: agent.business_name,
    contact_phone: agent.contact_phone,
    contact_email: agent.contact_email ?? null,
    location_address: agent.location_address,
    latitude: agent.latitude,
    longitude: agent.longitude,
    mpesa_till_or_paybill: agent.mpesa_till_or_paybill,
    payout_method_type: agent.payout_method_type,
    status: agent.status,
    refundable_deposit: agent.refundable_deposit,
    rating: agent.rating,
    rating_count: agent.rating_count,
    needs_manual_geocoding: agent.needs_manual_geocoding ?? false,
    warning_count: agent.warning_count ?? 0,
    last_warning_reason: agent.last_warning_reason ?? null,
    last_warning_at: agent.last_warning_at ?? null,
    created_at: agent.created_at,
    total_earned: metrics?.total_earned ?? 0,
    completed_payouts_count: metrics?.completed_payouts_count ?? 0,
  };
}
// =========================================================================
// Admin dashboard — safe DTOs for ledger and audit log entries.
// =========================================================================
// The admin dashboard is a bulk endpoint fetched on every console page-load.
// For that reason it must never ship raw database objects. This is the same
// privacy principle already applied to agents, items and disputes above.
//
// LEDGER — the bulk dashboard shows the recent financial transaction history.
// The raw LedgerEntry carries provider references, internal failure reasons,
// and the recipient phone/till number, none of which belong in every refresh.
//
//   EXPOSED in bulk: id, type, amount, status, created_at
//   HIDDEN in bulk : phone_or_till, provider_batch_id,
//                    provider_transaction_id, failure_reason
//   (Some admin tabs display recipient/target info on demand; that remains a
//    separate concern and is not folded into this bulk whitelist.)
//
// AUDIT LOG — the raw AuditLog.details field is unconstrained free text written
// by every logAudit() call in the system. Some callers embed PII (phone numbers,
// emails) in those strings. The bulk dashboard must NOT ship raw details on
// every refresh. We ship a sanitised version that redacts obvious phone/email
// patterns so the console still shows a useful human-readable line.
//
//   EXPOSED in bulk : id, action, admin_user (actor attribution is legitimate
//                     audit data), created_at, details (sanitised)
//   HIDDEN in bulk  : raw, unsanitised details; updated_at (not rendered here)

/**
 * Returns a privacy-safe version of a ledger entry for the admin dashboard.
 * Only the fields the ledger tab actually renders are included.
 */
export function toAdminSafeLedgerEntry(entry: any): any {
  if (!entry) return null;
  return {
    id: entry.id,
    claim_id: entry.claim_id ?? null,
    type: entry.type,
    amount: entry.amount,
    status: entry.status,
    created_at: entry.created_at,
  };
}

/**
 * Redacts obvious PII patterns from audit-detail free text so the bulk
 * dashboard can show a human-readable "what happened" line without exposing
 * raw phone numbers or emails in every console refresh.
 */
function sanitizeAuditDetails(details: string): string {
  if (!details) return '';
  let s = details;
  // Kenyan mobile numbers — E.164 (+2547...) and local (07...) forms.
  s = s.replace(/(\+?2547\d{8})/g, '[phone]');
  s = s.replace(/(07\d{8})/g, '[phone]');
  // Basic email addresses.
  s = s.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]');
  return s;
}

/**
 * Returns a privacy-safe version of an audit log entry for the admin dashboard.
 * actor attribution (admin_user) is legitimate audit data and is retained;
 * the free-text details field is sanitised.
 */
export function toAdminSafeAuditLog(log: any): any {
  if (!log) return null;
  return {
    id: log.id,
    action: log.action,
    admin_user: log.admin_user,
    created_at: log.created_at,
    details: sanitizeAuditDetails(log.details),
  };
}

// On-demand agent vetting evidence, served only by
// GET /api/admin/agents/:id/documents. This is the mechanism that replaced
// bulk-shipping these two URLs to every console load; it exists because an
// administrator reviewing a pending agent application genuinely needs to see
// the uploaded national ID document and the shop photo before approving them.
export function toAdminSafeAgentDocumentsView(agent: any): any {
  if (!agent) return null;
  return {
    id: agent.id,
    business_name: agent.business_name,
    shop_photo_url: agent.shop_photo_url ?? null,
    id_document_photo_url: agent.id_document_photo_url ?? null,
  };
}

// Whitelists a FoundItem row down to what the Found Items / Manual Review tabs
// render. Deliberately excludes:
//   - document_number_hash    — internal matching hash, never displayed
//   - document_name_fuzzy     — owner-facing masked name, not used here
//   - finder_email            — never displayed (finder_phone is the contact
//                               channel the console actually shows)
//   - rejection_reason        — not rendered anywhere in the console
//   - locked_* / declared_value / fee_ceiling_applied
//                             — financial-engine internals; the console reads
//                               the category fee, not these per-item locks
// OCR plaintext (ocr_extracted_number / ocr_extracted_name) is RETAINED: the
// Manual Review queue edits and resubmits exactly those values.
export function toAdminSafeItemView(
  item: any,
  reputation?: { total_reports: number; rejected_reports: number; autoFlag: boolean }
): any {
  if (!item) return null;
  return {
    id: item.id,
    category_id: item.category_id,
    photo_url: item.photo_url,
    ocr_extracted_number: item.ocr_extracted_number ?? null,
    ocr_extracted_name: item.ocr_extracted_name ?? null,
    found_county: item.found_county ?? null,
    administrative_unit_id: item.administrative_unit_id ?? null,
    location_description: item.location_description,
    latitude: item.latitude,
    longitude: item.longitude,
    finder_phone: item.finder_phone,
    assigned_agent_id: item.assigned_agent_id ?? null,
    status: item.status,
    flaggedForReview: item.flaggedForReview ?? false,
    isDescriptionOnly: item.isDescriptionOnly ?? false,
    description: item.description ?? null,
    is_sensitive_document: item.is_sensitive_document !== false,
    agent_assignment_method: item.agent_assignment_method ?? null,
    agent_assignment_distance_km: item.agent_assignment_distance_km ?? null,
    needs_manual_agent_reassignment: item.needs_manual_agent_reassignment ?? false,
    created_at: item.created_at,
    reputation: reputation ?? { total_reports: 0, rejected_reports: 0, autoFlag: false },
  };
}

// Whitelists a Dispute row down to the operational summary the Open Disputes
// tab renders, plus an explicit, semantically-labelled summary of each
// contending claimant.
//
// CLAIMANT SEMANTICS (established from the dispute-creation site in
// server.ts's POST /api/claims/submit, not guessed):
//   claimant_1_claim_id  = the claim that already existed on the item
//                          ("original" claim)
//   claimant_2_claim_id  = the claim that was filed afterwards and contested
//                          it ("contesting" claim)
// The DTO states that ordering explicitly via `role`, so the console never has
// to infer which claimant is which from array position or field naming.
//
// Each claimant is enriched from the claim row the caller already loaded
// (status / owner_phone / whether escrow was actually paid). `has_paid_escrow`
// mirrors the exact signal resolveDispute() uses to decide whether a losing
// claimant needs a real refund or is simply rejected — an administrator
// resolving a dispute should know which of those two outcomes the decision
// will trigger.
//
// Deliberately excludes:
//   - claimant_1_id_proof_url / claimant_2_id_proof_url
//       Government-ID proof images. These are the most sensitive artefact in
//       the system and are NOT needed to list disputes. The existing
//       GET /api/admin/disputes/:disputeId/evidence endpoint (admin-only, same
//       session validation) remains the on-demand mechanism for evidence.
//   - admin_notes
//       Free-text internal notes written during resolution. No list/card
//       rendering reads them, so they do not belong in the bulk payload.
//   - security_answers / owner_id_proof_url / owner_identifying_details /
//     owner_email / payment_reference
//       Never disclosed in bulk; a claimant is identified by claim id, phone
//       and status only.
export function toAdminSafeDisputeView(
  dispute: any,
  claimsById?: Map<string, any>
): any {
  if (!dispute) return null;

  const buildClaimant = (role: 'original' | 'contesting', claimId: any) => {
    const id = typeof claimId === 'string' ? claimId : '';
    const claim = (id && claimsById?.get(id)) || null;
    return {
      role,
      claim_id: id,
      owner_phone: claim?.owner_phone ?? null,
      claim_status: claim?.status ?? null,
      // SC-4/SC-6: payment truth is `paid_at` — the marker written ONLY by
      // attemptClaimEscrowHold()'s guarded CAS. This previously read
      // `payment_reference`, which the legacy /pay route writes at STK
      // INITIATION and the auto-reject loop once wrote a rejection message
      // into, so an unpaid claimant could be shown (and refunded) as paid.
      // Field name kept for response compatibility.
      has_paid_escrow: !!(claim && claim.paid_at),
    };
  };

  return {
    id: dispute.id,
    item_id: dispute.item_id,
    created_at: dispute.created_at,
    resolved_by: dispute.resolved_by ?? null,
    resolved_claim_id: dispute.resolved_claim_id ?? null,
    resolved_at: dispute.resolved_at ?? null,
    claimants: [
      buildClaimant('original', dispute.claimant_1_claim_id),
      buildClaimant('contesting', dispute.claimant_2_claim_id),
    ],
  };
}

// =============================================================================
// PHASE 6D — CLAIMS ADMINISTRATION READ DTOs
// =============================================================================
// The ONLY shapes the future Claims Administration console may receive. Both
// are hand-built allowlists over the narrow projections returned by
// db.listAdminClaims()/db.getAdminClaimDetail() — never a raw claim row, never
// `{ ...claim }`.
//
// The projections already exclude security_answers, owner_id_proof_url,
// owner_identifying_details, owner_email, payment_reference and every
// OTP/token/pickup-code hash. These DTOs additionally mask the claimant phone,
// expose payment truth as `has_paid` derived from `paid_at` ONLY, and reduce
// sensitive artifacts to presence booleans.
//
// A local phone mask is used rather than importing services/auth.ts, for the
// same reason database.ts and payments.ts each carry their own copy: it keeps
// this module dependency-free, so a pure DTO unit test cannot accidentally boot
// the auth/database layer. The format is identical to maskPhoneForLog.

function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const clean = phone.toString().replace(/\s+/g, '');
  if (clean.length < 7) return '***';
  return clean.slice(0, -6) + '***' + clean.slice(-3);
}

/** Payment truth: `paid_at` is the ONLY source. has_paid cannot disagree with it. */
function paymentFields(row: any) {
  const paidAt = row?.paid_at ?? null;
  return {
    has_paid: paidAt !== null,
    paid_at: paidAt,
    // Display-oriented alias, deliberately ALONGSIDE has_paid, never instead of
    // it — has_paid is the authoritative boolean.
    payment_state: paidAt === null ? 'unpaid' : 'paid',
  };
}

/**
 * Financial lifecycle summary derived from the claim STATUS (itself only
 * reachable through guarded transitions). NOT a money amount: this system has
 * no escrow-balance record, and this DTO must not imply one.
 */
function financialState(status: string): string {
  switch (status) {
    case 'escrow_held': return 'escrow_held';
    case 'pending_settlement':
    case 'releasing': return 'settling';
    case 'released': return 'settled';
    case 'refunding': return 'refunding';
    case 'refunded': return 'refunded';
    case 'rejected': return 'rejected';
    default: return 'unpaid';
  }
}

/** Dispute summary for the list. Current state only; the snapshot lives in detail. */
function disputeSummary(dispute: any) {
  if (!dispute) return { state: 'none' as const, id: null, role: null, snapshot_incomplete: false };
  return {
    state: dispute.is_open ? ('open' as const) : ('resolved' as const),
    id: dispute.id,
    // This claim's role: claimant_1 = original, claimant_2 = contesting —
    // never derived from array position.
    role: dispute.claimant_role,
    // R1 marker: the dispute predates the Phase 6C snapshot, so this claimant's
    // payment state AT DISPUTE CREATION is UNKNOWN (not "unpaid").
    snapshot_incomplete: dispute.snapshot_incomplete === true,
  };
}

/** Admin Claims LIST DTO. Minimal operational data; nothing sensitive. */
export function toAdminSafeClaimListView(row: any): any {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    is_active: !INACTIVE_CLAIM_STATUSES.has(String(row.status)),
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Masked. The raw number never reaches a list response.
    claimant_phone: maskPhone(row.owner_phone),
    verification_tier: row.verification_tier,
    ...paymentFields(row),
    financial_state: financialState(String(row.status)),
    agent_confirmed_at: row.agent_confirmed_at ?? null,
    item: row.item
      ? {
          id: row.item.id,
          category_id: row.item.category_id,
          category_name_en: row.category?.name_en ?? null,
          status: row.item.status,
          is_sensitive_document: row.item.is_sensitive_document === true,
          flagged_for_review: row.item.flaggedForReview === true,
        }
      : null,
    agent: row.agent ? { id: row.agent.id, business_name: row.agent.business_name } : null,
    dispute: disputeSummary(row.dispute ?? null),
  };
}



/**
 * Admin Claims DETAIL DTO. Adds operational context but still no secrets, no
 * signed URLs, no provider references and no storage keys.
 */
export function toAdminSafeClaimDetailView(row: any): any {
  if (!row) return null;
  const list = toAdminSafeClaimListView(row);
  const dispute = row.dispute ?? null;
  const isOriginal = dispute?.claimant_role === 'original';
  const {
    verification_tier: _listVerificationTier,
    ...listWithoutVerificationTier
  } = list;
  return {
    ...listWithoutVerificationTier,
    item: row.item
      ? {
          ...list.item,
          description: row.item.description ?? null,
          location_description: row.item.location_description ?? null,
        }
      : null,
    // Operational contact for the hub handling the item. Admin-only surface.
    agent: row.agent
      ? {
          id: row.agent.id,
          business_name: row.agent.business_name,
          contact_phone: row.agent.contact_phone ?? null,
        }
      : null,
    verification: {
      tier: row.verification_tier,
      agent_confirmed_at: row.agent_confirmed_at ?? null,
      // Presence only — the identifying detail / ID proof / handover photo
      // VALUES are never part of this DTO.
      identifying_detail_present: row.identifying_detail_present === true,
      id_proof_present: row.id_proof_present === true,
      handover_photo_present: row.handover_photo_present === true,
    },
    settlement: {
      settle_at: row.settle_at ?? null,
      // Derived from status, not a monetary balance — see financialState().
      state: financialState(String(row.status)),
    },
    dispute: dispute
      ? {
          ...disputeSummary(dispute),
          resolved_at: dispute.resolved_at ?? null,
          resolved_by: dispute.resolved_by ?? null,
          resolved_claim_id: dispute.resolved_claim_id ?? null,
          // CURRENT state of each participant AND the HISTORICAL state captured
          // when the dispute was filed. The two are never merged, and the
          // historical values are never inferred from mutable columns.
          this_claim: {
            claim_id: row.id,
            role: dispute.claimant_role,
            current_status: row.status,
            current_paid_at: row.paid_at ?? null,
            status_at_dispute: isOriginal
              ? dispute.claimant_1_status_at_dispute
              : dispute.claimant_2_status_at_dispute,
            paid_at_dispute: isOriginal
              ? dispute.claimant_1_paid_at_dispute
              : dispute.claimant_2_paid_at_dispute,
          },
          other_claim: {
            claim_id: isOriginal ? dispute.claimant_2_claim_id : dispute.claimant_1_claim_id,
            role: isOriginal ? 'contesting' : 'original',
            status_at_dispute: isOriginal
              ? dispute.claimant_2_status_at_dispute
              : dispute.claimant_1_status_at_dispute,
            paid_at_dispute: isOriginal
              ? dispute.claimant_2_paid_at_dispute
              : dispute.claimant_1_paid_at_dispute,
          },
        }
      : null,
    sibling_claims: Array.isArray(row.sibling_claims)
      ? row.sibling_claims.map((s: any) => ({
          id: s.id,
          status: s.status,
          has_paid: (s.paid_at ?? null) !== null,
          paid_at: s.paid_at ?? null,
          claimant_phone: maskPhone(s.owner_phone),
          created_at: s.created_at,
        }))
      : [],
  };
}
