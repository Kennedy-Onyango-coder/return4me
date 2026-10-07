// GEO-E1 — AGENT-MATCHING CONTRACT VOCABULARY.
// ============================================
// This module holds the SMALL, explicit vocabulary the nearest-agent matcher
// uses to describe HOW STRONG its routing evidence is, plus the ONE
// configuration seam this batch is allowed to add (a maximum assignment
// radius that is DELIBERATELY DISABLED — see below).
//
// WHAT THIS IS NOT
//   * It is NOT spatial authority. Nothing here contains, or can contain, a
//     polygon, a boundary, a point-in-polygon test, a GeoJSON document or a
//     PostGIS call. The platform has no authoritative boundary engine, and
//     GEO-E1 does not invent one.
//   * It is NOT a claim about where an item was found. A confidence tier
//     describes the strength of the ROUTING EVIDENCE that produced an Agent
//     assignment. It never asserts that a finder picked the right county, that
//     a coordinate IS the found location, or that an Agent is responsible for
//     an item.
//   * It is NOT persisted. No column, no migration and no backfill live here
//     (see the radius note and the matcher for why).

// ---------------------------------------------------------------------------
// ASSIGNMENT CONFIDENCE — how strong the routing evidence is.
//
// Terminology is chosen so it can NEVER be read as geographic certainty:
//   high   — a COORDINATE-BASED match (the finder's/device's validated
//            coordinate pair, compared by Haversine against a validated Agent
//            coordinate pair, inside the declared county scope). Strong
//            ROUTING evidence only.
//   medium — a FORWARD-GEOCODED match: the free-text report location was
//            resolved to a validated coordinate pair, then compared by
//            Haversine inside the declared county scope. Useful INFERRED
//            routing evidence only.
//   manual — the matcher could not establish sufficiently useful routing
//            evidence (no eligible active agent, no usable coordinate, a
//            failed/empty geocode, or a future safety policy rejecting the
//            distance). A human administrator makes the call.
//
// A tier is never fabricated to avoid manual review.
// ---------------------------------------------------------------------------

export type AgentAssignmentConfidence = 'high' | 'medium' | 'manual';

export const AGENT_ASSIGNMENT_CONFIDENCES: readonly AgentAssignmentConfidence[] = [
  'high',
  'medium',
  'manual',
] as const;

/** Runtime guard for an untrusted confidence value. */
export function isAgentAssignmentConfidence(value: unknown): value is AgentAssignmentConfidence {
  return typeof value === 'string' && (AGENT_ASSIGNMENT_CONFIDENCES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// DERIVED ADMIN OBSERVABILITY.
//
// An administrator reading a STORED item must be able to understand WHY an
// Agent was selected without a new column being added. The item stores only
// `agent_assignment_method` (the matcher's own method string), so the
// confidence tier is DERIVED from it on read rather than persisted. This keeps
// GEO-E1 a pure contract/observability change: no assignment evidence is
// written to the database in this batch (that is a separate GEO-E2 decision).
//
// Only the three matcher methods — plus the admin manual-override action —
// map to a tier. Any OTHER (legacy or unrecognised) method yields `null`: the
// honest answer is "the confidence of this historical assignment is unknown",
// never a guess.
// ---------------------------------------------------------------------------
export function deriveAssignmentConfidence(method: unknown): AgentAssignmentConfidence | null {
  switch (method) {
    case 'gps_haversine':
      return 'high';
    case 'geocoded_text':
      return 'medium';
    case 'manual_required':
    case 'manual_override':
      return 'manual';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// MAXIMUM ASSIGNMENT RADIUS — DELIBERATELY DISABLED (GEO-E1).
//
// The prerequisite audit identified a REAL weakness: the matcher has no upper
// distance bound, so a same-county Agent arbitrarily far away is still the
// "nearest" and is assigned. GEO-E1 does NOT fix this by inventing a number.
//
// There is currently NO evidence in this repository from which a safe
// threshold could be chosen: no operational distance policy, no production
// aggregate of real assignment distances, and no configuration already
// present. Picking 10 km, 25 km or 50 km out of the air would change real
// assignment outcomes for a reason nobody can defend.
//
// So this batch adds the SEAM ONLY: the matcher already consults
// `exceedsAssignmentRadius()`, but `MAX_AGENT_ASSIGNMENT_RADIUS_KM` is `null`,
// which means DISABLED, which means NO existing outcome changes. A later
// phase (GEO-E2) may set a real, evidence-backed value after deciding whether
// assignment evidence should also be persisted and reviewed operationally.
//
// HARD RULE: do not "activate" this by choosing a number without evidence.
// `null` is a deliberate, documented decision, not an unfinished one.
// ---------------------------------------------------------------------------
export const MAX_AGENT_ASSIGNMENT_RADIUS_KM: number | null = null;

/** The configured maximum assignment radius, or `null` when the pole is disabled. */
export function getMaxAssignmentRadiusKm(): number | null {
  return MAX_AGENT_ASSIGNMENT_RADIUS_KM;
}

/**
 * True only when a maximum radius is CONFIGURED (non-null) AND the Haversine
 * distance exceeds it. With the current `null` default this is ALWAYS false, so
 * the matcher's behaviour is unchanged.
 */
export function exceedsAssignmentRadius(distanceKm: number): boolean {
  const max = getMaxAssignmentRadiusKm();
  if (max === null) return false;
  return distanceKm > max;
}
