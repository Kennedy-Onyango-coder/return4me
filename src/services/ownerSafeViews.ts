// Hand-built, whitelisted DTOs for the owner/claimant-facing surfaces.
//
// These were extracted VERBATIM from server.ts in Phase 2 so that the customer
// dashboard can reuse the exact same masking rules the Track Claim flow
// already uses, instead of keeping a second copy of security-relevant masking
// logic in sync. Two copies of "hide the photo for a sensitive document" is
// precisely the kind of duplication that silently drifts.
//
// Every function here enumerates its allowed fields explicitly. None of them
// ever spreads a raw row.

// Whitelists an Agent row down to what's actually safe to show an owner
// looking up where to collect their item. The full Agent record also
// carries mpesa_till_or_paybill, national_id_hash, refundable_deposit,
// warning_count/last_warning_reason, and id_document_photo_url — none of
// which an owner has any legitimate reason to see, and several of which
// (till number, deposit amount, warning history) are the agent's own
// operational/financial details. Used everywhere an `agent` object is
// returned from an owner-facing, unauthenticated route.
export function toOwnerSafeAgentView(agent: any): any {
  if (!agent) return null;
  return {
    id: agent.id,
    business_name: agent.business_name,
    contact_phone: agent.contact_phone,
    location_address: agent.location_address,
    latitude: agent.latitude,
    longitude: agent.longitude,
    rating: agent.rating,
    rating_count: agent.rating_count,
  };
}

// Public/claimant tracking DTO for a claim. Deliberately excludes
// security_answers, owner_phone/email, owner_identifying_details,
// owner_id_proof_url, payment_reference and all internal/operational fields.
// These are the only fields the OwnerView tracking modal actually reads.
export function toOwnerSafeClaimView(claim: any): any {
  if (!claim) return null;
  return {
    id: claim.id,
    status: claim.status,
    agent_confirmed_at: claim.agent_confirmed_at || null,
  };
}

// Public/claimant tracking DTO for an item. Mirrors the masked public search
// result shape: no finder contact data, no OCR-extracted identity fields, no
// plaintext document number or hash, and no photo for sensitive documents.
export function toOwnerSafeItemView(item: any): any {
  if (!item) return null;
  const isSensitive = item.is_sensitive_document !== false;
  return {
    id: item.id,
    category_id: item.category_id,
    is_sensitive_document: isSensitive,
    photo_url: isSensitive ? null : item.photo_url,
    document_name_fuzzy: item.isDescriptionOnly
      ? 'Bidhaa ya Maelezo'
      : item.document_name_fuzzy || (isSensitive ? 'Mwenye ID' : 'Bidhaa Bila Hati'),
    location_description: item.location_description,
    description: item.isDescriptionOnly || !isSensitive ? item.description : null,
    isDescriptionOnly: item.isDescriptionOnly,
    created_at: item.created_at,
  };
}
