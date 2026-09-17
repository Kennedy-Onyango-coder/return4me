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
