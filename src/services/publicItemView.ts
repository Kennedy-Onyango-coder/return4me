import { administrativeUnitById } from '../config/kenyaAdministrativeUnits';

// Hand-built, whitelisted DTO for a found item.
//
// WHY THIS EXISTS (Phase 7B): the public item-detail page (/item/:id) needs the
// exact same "recognition clues only" representation the masked Owner search
// results (GET /api/items/search) already return. Those fields used to be
// assembled inline inside that route, which meant a second, inevitably-drifting
// copy would have been needed for the new detail route. Two copies of
// "hide the photo for a sensitive document" is precisely the kind of
// duplication that silently drifts (the same reasoning behind
// services/ownerSafeViews.ts).
//
// Every function here enumerates its allowed fields explicitly and never
// spreads a raw row. What is deliberately ABSENT: ocr_extracted_number,
// ocr_extracted_name, document_number_hash, finder_phone, finder_email,
// latitude, longitude, locked_*_fee, declared_value, assigned_agent_id,
// rejection_reason, verification/audit columns — and, for sensitive documents,
// the photo and any free-text description.
//
// WHAT IS PRESENT AT COUNTY LEVEL (Phase 16.1 / GEO-16-03): `found_county` — the
// canonical county the Finder chose. It is the COARSEST geography the product
// models and carries no sub-county, city, ward, coordinates or address detail;
// adding it does not widen the whitelist to any finer location fact.
//
// NOTE: this is the PUBLIC (unauthenticated) surface. It is intentionally
// narrower than toOwnerSafeItemView in ownerSafeViews.ts, which additionally
// serves the claim/owner flows.

/**
 * Address -> village/estate-level label ("Moi Avenue, Nairobi" -> "Moi Avenue").
 *
 * Moved verbatim out of server.ts in Phase 7B so both the public search route
 * and the new public item-detail route share one implementation. Behaviour is
 * unchanged. This is the coarse-area transform used for public listings — the
 * finer-grained transform used for social/public-recognition posts lives in
 * services/publicRecognition.ts (safePublicLocation) and is not this function.
 */
export function getRoughArea(address: string): string {
  if (!address) return 'Nairobi';
  const parts = address.split(',');
  if (parts.length > 0 && parts[0].trim().length > 3) {
    return parts[0].trim();
  }
  const words = address.split(/\s+/).slice(0, 3).join(' ');
  return words || 'Nairobi';
}

/**
 * The public, unauthenticated view of a found item.
 *
 * `agent` is optional: pass the assigned Agent row (or null/undefined when the
 * item has none yet) and it is reduced to the hub's business name plus a coarse
 * area. The Agent's contact phone, exact address and GPS coordinates are NEVER
 * part of this shape — they belong to the ownership-gated pickup-details
 * surface (routes/publicItems.ts) and the authenticated customer dashboard.
 */
export function toPublicItemView(item: any, agent?: any | null): any {
  if (!item) return null;
  const isSensitive = item.is_sensitive_document !== false;
  return {
    id: item.id,
    category_id: item.category_id,
    // Sensitive documents (national ID, logbook, licence) never publish their
    // photo — the browser cannot "unhide" what the server never sent.
    photo_url: isSensitive ? null : (item.photo_url ?? null),
    is_sensitive_document: isSensitive,
    document_name_fuzzy: item.isDescriptionOnly
      ? 'Bidhaa ya Maelezo'
      : item.document_name_fuzzy || (isSensitive ? 'Mwenye ID' : 'Bidhaa Bila Hati'),
    // PHASE 16.1 (GEO-16-03): the FINER-grain-free canonical county — the
    // county-level fact the Finder selected and the API boundary canonicalised.
    // It is deliberately the county ONLY: no sub-county, no city, no ward, no
    // coordinates, and no finer geographic detail than the level the product
    // actually models. A row that has none (legacy, pre-Phase-9D) publishes
    // null rather than a guessed county.
    found_county: item.found_county ?? null,
    administrative_unit_id: item.administrative_unit_id ?? null,
    administrative_unit_name: administrativeUnitById(item.administrative_unit_id)?.name ?? null,
    location_description: item.location_description ?? null,
    description: (item.isDescriptionOnly || !isSensitive) ? (item.description ?? null) : null,
    isDescriptionOnly: !!item.isDescriptionOnly,
    created_at: item.created_at ?? null,
    status: item.status,
    agent: agent
      ? {
          business_name: agent.business_name ?? null,
          rough_area: getRoughArea(agent.location_address),
        }
      : null,
  };
}
