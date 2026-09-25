// HAND-BUILT, WHITELISTED DTOs for customer lost reports (Phase 9A).
//
// WHY THIS EXISTS: a lost report carries private free text (description,
// distinctive marks, the reporter's own account identity) and a protected
// identifier hash. Every other whitelisted surface on this platform
// (ownerSafeViews.ts, publicItemView.ts, adminSafeViews.ts) exists so a raw row
// can never leak by accidental spread. This is the same rule for the
// lost-report domain: each function enumerates its allowed fields explicitly
// and never spreads a raw row.
//
// WHAT IS DELIBERATELY ABSENT FROM EVERY SHAPE HERE:
//   customer_id             — internal account identity
//   document_number_hash    — the protected identifier (never leaves the server)
//   anything else internal  — no hashes, no security metadata, no internals
//
// The caller's OWN free text (description, distinctive_marks) IS returned to
// the authenticated owner — it is their own data and the customer-private
// bucket of the privacy model. It is never part of any public/finder DTO, and
// no public lost-report discovery endpoint exists in this phase.
import { administrativeUnitById } from '../config/kenyaAdministrativeUnits';

function toIso(value: any): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The creation response — the minimum the reporter needs to acknowledge a
 * submitted report: a public reference they can quote, its initial status and
 * when it was created. Nothing internal.
 */
export function toLostReportCreationResponse(report: any): any {
  if (!report) return null;
  return {
    success: true,
    reference: report.id,
    status: report.status,
    created_at: toIso(report.created_at),
  };
}

/**
 * The authenticated owner's view of their OWN lost report. Used by the
 * owner-scoped retrieval routes. Enumeration is exhaustive and explicit.
 *
 * `has_document_number` is a BOOLEAN derived from the presence of the hash —
 * it lets the owner (and a future UI) confirm a protected identifier was
 * recorded without the hash or the plaintext ever crossing the wire.
 */
export function toCustomerSafeLostReportView(report: any): any {
  if (!report) return null;
  return {
    id: report.id,
    status: report.status,
    category_id: report.category_id,
    county: report.county,
    administrative_unit_id: report.administrative_unit_id ?? null,
    administrative_unit_name: administrativeUnitById(report.administrative_unit_id)?.name ?? null,
    location_area: report.location_area,
    location_landmark: report.location_landmark ?? null,
    lost_at_from: toIso(report.lost_at_from),
    lost_at_to: toIso(report.lost_at_to),
    brand: report.brand ?? null,
    model: report.model ?? null,
    colour: report.colour ?? null,
    material: report.material ?? null,
    description: report.description ?? null,
    distinctive_marks: report.distinctive_marks ?? null,
    document_type: report.document_type ?? null,
    has_document_number: Boolean(report.document_number_hash),
    created_at: toIso(report.created_at),
    updated_at: toIso(report.updated_at),
  };
}

/**
 * PHASE 11A — the ADMIN console's view of one lost report.
 *
 * READ-ONLY operational visibility. The Phase 11 forensic audit found that lost
 * reports had NO administrative surface at all, so an administrator could not
 * see, count or triage them. This DTO is the smallest shape that fixes that.
 *
 * WHAT IT DELIBERATELY OMITS (and why)
 *   customer_id          — internal account identity. An admin triaging a report
 *                          does not need it, and it is exactly the kind of
 *                          correlation key that turns a read-only view into a
 *                          de-anonymisation surface.
 *   document_number_hash — the PROTECTED identifier. Even though it is a hash,
 *                          it must never be presented in a console screen. Only
 *                          its PRESENCE is exposed, as a boolean, so an
 *                          administrator can tell that a protected identifier
 *                          was recorded without ever seeing it.
 *   description / distinctive_marks / brand / model / colour / material /
 *   document_type        — the reporter's own private free text and attributes.
 *                          They are the customer-private bucket of the privacy
 *                          model: they are the OWNER's data and belong on the
 *                          owner's screen, not in a bulk operational list. A
 *                          future phase that genuinely needs them must add them
 *                          through a deliberate, separately-reviewed detail DTO
 *                          (the same on-demand principle as
 *                          toAdminSafeAgentDocumentsView) — not by widening this
 *                          one.
 *
 * `possible_match_count` is passed IN rather than computed here: the count comes
 * from the existing Phase 9B engine (services/lostReportMatching.ts) via the
 * same claimability rule the customer-facing matches route uses. No second
 * matching algorithm is introduced, and this module stays free of matching logic.
 */
export function toAdminSafeLostReportView(report: any, possibleMatchCount?: number | null): any {
  if (!report) return null;
  return {
    id: report.id,
    status: report.status,
    category_id: report.category_id,
    county: report.county,
    administrative_unit_id: report.administrative_unit_id ?? null,
    administrative_unit_name: administrativeUnitById(report.administrative_unit_id)?.name ?? null,
    location_area: report.location_area,
    location_landmark: report.location_landmark ?? null,
    lost_at_from: toIso(report.lost_at_from),
    lost_at_to: toIso(report.lost_at_to),
    // Presence only. The hash itself is never selected into this shape.
    has_document_number: Boolean(report.document_number_hash),
    // null means "not applicable / not computed" (e.g. a closed report, which
    // the platform is no longer matching), which is deliberately distinct from 0
    // ("computed, and there are none").
    possible_match_count: typeof possibleMatchCount === 'number' ? possibleMatchCount : null,
    created_at: toIso(report.created_at),
    updated_at: toIso(report.updated_at),
  };
}
