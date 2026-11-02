import { db, Agent } from '../db/database';
import { geocodeForward } from './geocoding/index.ts';
import { isValidCoordinatePair } from './coordinates.ts';
import { exceedsAssignmentRadius, type AgentAssignmentConfidence } from '../config/geoMatching.ts';
// BATCH 3 (3B-1) — THE single operational-eligibility authority. Re-used, never
// re-derived: this module must never hold a second opinion about which agents
// may receive work.
import { isAgentActionable } from './auth.ts';
// STAGE 3B-6C — county/sub-county equality is decided by the ONE geography
// comparison (services/agentGeography.ts), not by `===`. A hub whose stored
// county predates the canonicaliser ('nairobi', ' Nairobi City ') serves the same
// county as an item recorded as 'Nairobi City', and `===` silently excluded it
// from matching for ever.
import { isSameAdministrativeUnit, isSameCounty } from './agentGeography.ts';
// STAGE 3B-6D — the single Haversine implementation, shared with the admin
// candidate projection (services/adminAssignmentCandidates.ts). Imported for
// this module's own use and re-exported below for existing callers.
import { calculateHaversineDistance } from './geoDistance.ts';

// NEAREST-AGENT MATCHING — GEO-E1 CONTRACT HARDENING.
// ===================================================
// This module decides WHICH Agent hub (if any) a found item is routed to. It is
// the ONLY place in the application that performs agent matching. The Haversine
// formula it uses lives in services/geoDistance.ts — the single implementation,
// re-exported below — so the admin candidate list (Stage 3B-6D) can show the SAME
// distance without importing this module or re-implementing the maths.
//
// THREE CONCEPTS THAT MUST NEVER BE COLLAPSED (see the GEO-E1 brief):
//   1. USER-DECLARED FOUND GEOGRAPHY — items.found_county / administrative_unit_id,
//      chosen by the finder and re-validated server-side. The COUNTY is the
//      candidate FILTER here.
//   2. REPORTER/DEVICE POSITION — items.latitude/longitude, an OPTIONAL
//      browser/device position captured at report time. It is a ROUTING HINT,
//      NOT proof of where the item was actually found.
//   3. AGENT OPERATIONAL LOCATION — agents.latitude/longitude, where the hub
//      operates.
// `items.latitude/longitude` is NEVER relabelled "item found coordinates", and
// a `user_selected` county is NEVER described as geographically verified truth.
//
// WHAT GEO-E1 ADDS (and does not):
//   * a deterministic, PURE decision core that can be tested without a database,
//     an external geocoder or global state (dependency-injected + small pure
//     functions below);
//   * an explicit `confidence` classification (high | medium | manual) and an
//     internal `evidence` object that makes county-vs-coordinate disagreement
//     OBSERVABLE without ever asserting a geographic boundary;
//   * a DISABLED maximum-radius seam (config/geoMatching.ts).
// It does NOT add polygons, boundary datasets, PostGIS, point-in-polygon, lost
// GPS, item-found GPS semantics, or any geography reconciliation. Reverse
// geocoding is NEVER used as matching evidence.

// STAGE 3B-6D — the Haversine implementation now lives in services/geoDistance.ts
// so the browser can compute the SAME distance for the administrator's candidate
// list without importing this module (and therefore pg, bcrypt and the db graph).
// It is re-exported here so every existing caller — and the matcher contract
// tests — keep importing `calculateHaversineDistance` from the matcher.
export { calculateHaversineDistance } from './geoDistance.ts';

// ---------------------------------------------------------------------------
// RESULT CONTRACT.
//
// `agent`/`method`/`distanceKm`/`needsManualAgentReassignment` are UNCHANGED
// from before, so every existing caller keeps working. GEO-E1 ADDS two fields:
//   confidence — the routing-evidence tier (see config/geoMatching.ts).
//   evidence   — INTERNAL ONLY. It records what the matcher actually knew
//                (was a county declared? was a coordinate present? was a
//                boundary verified — never, in this batch). It is NEVER
//                persisted and NEVER surfaced to a public/owner/customer/agent
//                view.
// ---------------------------------------------------------------------------

/** The single source of an assignment. No other evidence source is invented. */
export type AgentAssignmentMethod = 'gps_haversine' | 'geocoded_text' | 'manual_required';

/**
 * Internal, NON-authoritative record of what the matcher knew. `boundary_verified`
 * is the literal `false` type: this batch has no polygon engine, so it can never
 * be true. This makes a declared-county/coordinate disagreement OBSERVABLE
 * without ever claiming to detect a real boundary violation.
 */
export interface AgentAssignmentEvidence {
  declared_geography_present: boolean;
  coordinate_present: boolean;
  boundary_verified: false;
}

export interface AgentAssignmentResult {
  agent: Agent | null;
  method: AgentAssignmentMethod;
  distanceKm: number | null;
  confidence: AgentAssignmentConfidence;
  needsManualAgentReassignment: boolean;
  evidence: AgentAssignmentEvidence;
}

/** Injected collaborators, so the decision core is testable without a DB/geocoder. */
export interface AgentAssignmentDeps {
  getAgents: () => Promise<Agent[]>;
  forwardGeocode: (query: string) => Promise<{ latitude: number | null; longitude: number | null }>;
}

/**
 * Forward-geocodes an Agent's free-text address.
 *
 * PHASE 9D — a THIN ADAPTER over the provider-neutral geocoding boundary
 * (services/geocoding/index.ts). Every failure mode yields
 * `{ latitude: null, longitude: null, needsManual: true }`; it never throws and
 * never invents a location.
 *
 * SEMANTIC NOTE: an Agent's coordinates mean "where this Agent hub operates".
 * That is the only coordinate meaning this codebase establishes.
 */
export async function geocodeAddress(address: string): Promise<{ latitude: number | null; longitude: number | null; needsManual: boolean }> {
  const outcome = await geocodeForward(address);
  if (outcome.status === 'ok') {
    return { latitude: outcome.latitude, longitude: outcome.longitude, needsManual: false };
  }
  return { latitude: null, longitude: null, needsManual: true };
}

// ---------------------------------------------------------------------------
// STAGE A — CANDIDATE ELIGIBILITY (pure).
//
// BATCH 3 (3B-1) — ELIGIBILITY IS isAgentActionable(), NOT A LOCAL RULE.
// Before this stage the candidate pool was `status === 'active'` alone, which is
// strictly WEAKER than the predicate every protected agent route enforces
// (services/auth.ts). An agent approved after N4 is `active` immediately but is
// NOT actionable until their email is verified, so the matcher could hand an
// item to an account that cannot sign in to process it — and clear
// `needs_manual_agent_reassignment` while doing so, taking the item out of the
// admin queue. An unverifiable second opinion also meant the auto-assignment
// trigger (which calls isAgentActionable() on the agent whose arrival triggered
// it) could still be handed an item for a DIFFERENT, non-operational agent.
//
// There is now exactly one definition of "may receive work" in this codebase and
// it is re-used here. `activeAgents` (status only) is kept separate from
// `scopedAgents` (the real candidate pool) so the two ideas cannot be conflated
// by a future edit: `activeAgents` feeds only the "no agents at all" guard.
//
// When an item county is supplied, eligible candidates are narrowed to that
// county. The declared county is the FILTER — matching never silently expands
// outside it (if it yields no one, the result is manual).
// ---------------------------------------------------------------------------
export function scopeCandidateAgents(
  agents: Agent[],
  itemCounty?: string | null,
): { activeAgents: Agent[]; scopedAgents: Agent[]; scopedToCounty: boolean } {
  const activeAgents = agents.filter(a => a.status === 'active');
  // THE OPERATIONAL GATE — the same predicate requireActiveAgent guards every
  // agent route with, and the same one the auto-assignment trigger re-checks.
  const eligibleAgents = activeAgents.filter(a => isAgentActionable(a));
  const scopedToCounty = !!itemCounty;
  // STAGE 3B-6C — CANONICAL COUNTY COMPARISON, NOT STRING EQUALITY.
  //
  // The county filter itself is UNCHANGED: when the item declares a county, only
  // agents serving that county are candidates, and if none do the result is a
  // manual assignment. What changed is only how "serves that county" is decided.
  // `isSameCounty()` canonicalises both sides through resolveCountyName(), so an
  // alias, different casing and stray whitespace still match, while a genuinely
  // different county — or a side with no county at all — does not. It never
  // guesses: an uncanonicalisable value only matches the identical value.
  const scopedAgents = scopedToCounty
    ? eligibleAgents.filter(a => isSameCounty(a.county, itemCounty))
    : eligibleAgents;
  return { activeAgents, scopedAgents, scopedToCounty };
}

/**
 * STAGE A — sub-county PREFERENCE (pure). When a sub-county is supplied and any
 * in-scope Agent holds it, only those Agents are considered; otherwise the whole
 * county scope is used. This is a PREFERENCE inside the declared scope, never an
 * expansion of it.
 *
 * STAGE 3B-6C — the sub-county id is compared the same tolerant way (trim +
 * case-fold). Ids are configured data, so there is no alias table and none is
 * invented here; ' KE-47-SC-01 ' and 'ke-47-sc-01' are the same unit, and a
 * missing id on either side is never treated as a match.
 */
export function preferSubCountyAgents(scopedAgents: Agent[], itemAdministrativeUnitId?: string | null): Agent[] {
  if (!itemAdministrativeUnitId) return scopedAgents;
  const sameSubCounty = scopedAgents.filter(a => isSameAdministrativeUnit(a.administrative_unit_id, itemAdministrativeUnitId));
  return sameSubCounty.length > 0 ? sameSubCounty : scopedAgents;
}

/**
 * STAGE B/C — deterministic NEAREST selection (pure).
 *
 * Returns the nearest candidate that holds a VALID coordinate pair, with a
 * deterministic ascending-id tie-break for equal distances. Agents whose stored
 * coordinate is missing/out-of-range/non-numeric are simply skipped (their
 * meaning is never guessed or "corrected"). Returns `null` when no candidate has
 * a usable coordinate. The returned `distanceKm` is the raw Haversine value.
 */
export function selectNearestAgent(
  originLat: number,
  originLon: number,
  candidates: Agent[],
): { agent: Agent; distanceKm: number } | null {
  let nearestAgent: Agent | null = null;
  let minDistance = Infinity;
  for (const agent of candidates) {
    if (!isValidCoordinatePair(agent.latitude, agent.longitude)) continue;
    const distance = calculateHaversineDistance(originLat, originLon, agent.latitude as number, agent.longitude as number);
    if (distance < minDistance || (distance === minDistance && nearestAgent !== null && agent.id < nearestAgent.id)) {
      minDistance = distance;
      nearestAgent = agent;
    }
  }
  return nearestAgent ? { agent: nearestAgent, distanceKm: minDistance } : null;
}

/** Builds the internal evidence object from the call's inputs. `boundary_verified` is always false. */
export function buildAssignmentEvidence(
  itemCounty: string | null | undefined,
  lat: number | null,
  lon: number | null,
): AgentAssignmentEvidence {
  return {
    declared_geography_present: !!itemCounty,
    coordinate_present: isValidCoordinatePair(lat, lon),
    boundary_verified: false,
  };
}

/** The ONE way a non-assignment is produced: agent null, manual tier, no distance. */
function manualAssignment(evidence: AgentAssignmentEvidence): AgentAssignmentResult {
  return {
    agent: null,
    method: 'manual_required',
    distanceKm: null,
    confidence: 'manual',
    needsManualAgentReassignment: true,
    evidence,
  };
}

// Real production collaborators. Kept as the DEFAULT so existing callers pass
// nothing and keep the exact runtime behaviour, while tests can inject fakes.
const defaultAssignmentDeps: AgentAssignmentDeps = {
  getAgents: () => db.getAgents(),
  forwardGeocode: async (query: string) => {
    const geo = await geocodeAddress(query);
    return { latitude: geo.latitude, longitude: geo.longitude };
  },
};

export const AgentMatchingService = {
  /**
   * Find the nearest operationally eligible agent (isAgentActionable()) based on
   * the strict fallback algorithm.
   *
   * IMPORTANT: this NEVER pretends an arbitrary agent is the nearest one. If GPS
   * matching fails, address geocoding fails, no active agents exist, or the
   * active agents that do exist have no usable coordinates, it returns
   * `agent: null` with `needsManualAgentReassignment: true` — the caller
   * (POST /api/items/report in routes/finderReport.ts) creates the item with
   * `assigned_agent_id: null` and routes it into the admin manual-assignment
   * queue, rather than silently attaching a real (possibly far-away, possibly
   * wrong) agent.
   *
   * @param lat/lon   the OPTIONAL reporter/device coordinate pair (routing hint).
   * @param locationDescription free-text report location (forward-geocoded fallback).
   * @param itemCounty/ itemAdministrativeUnitId  the finder's declared, validated geography.
   * @param deps      injected collaborators (defaults to the real DB + geocoder).
   */
  async assignNearestAgent(
    lat: number | null,
    lon: number | null,
    locationDescription: string,
    itemCounty?: string | null,
    itemAdministrativeUnitId?: string | null,
    deps: AgentAssignmentDeps = defaultAssignmentDeps,
  ): Promise<AgentAssignmentResult> {
    const evidence = buildAssignmentEvidence(itemCounty, lat, lon);
    const { activeAgents, scopedAgents, scopedToCounty } = scopeCandidateAgents(await deps.getAgents(), itemCounty);

    // Stage A guard 1 — a county was declared, but no operationally eligible
    // Agent serves it. Never widen the scope to "any county": queue for manual
    // assignment. (3B-1: "eligible" now means isAgentActionable() — an active
    // but unverified hub counts as nobody here, which is the point.)
    if (scopedToCounty && scopedAgents.length === 0) {
      console.log('[AGENT ASSIGNMENT] No operationally eligible agents in the declared county — routing to manual assignment queue.');
      return manualAssignment(evidence);
    }

    // Stage A guard 2 — no active agents at all. (Previously this threw and
    // failed the Finder's entire report; it must never do that.)
    if (activeAgents.length === 0) {
      console.log('[AGENT ASSIGNMENT] No active agents available — routing to manual assignment queue.');
      return manualAssignment(evidence);
    }

    // Stage A guard 3 (BATCH 3 / 3B-1) — Agents exist, but NONE of them is
    // operationally eligible (e.g. every active hub is still email-unverified).
    // Assigning one of them would strand the item at an account that cannot
    // sign in, so it stays in the manual queue instead. Only reachable when no
    // county was declared, because guard 1 already covers the scoped case.
    if (scopedAgents.length === 0) {
      console.log('[AGENT ASSIGNMENT] No operationally eligible agents available — routing to manual assignment queue.');
      return manualAssignment(evidence);
    }

    // Fallback 1 — GPS Haversine (coordinate evidence → HIGH confidence).
    // The caller-supplied pair is VALIDATED (finite + in range) before any
    // distance is computed: an invalid pair is treated as "no coordinates
    // supplied", which is the same safe outcome, made explicit.
    if (isValidCoordinatePair(lat, lon)) {
      const candidates = preferSubCountyAgents(scopedAgents, itemAdministrativeUnitId);
      const match = selectNearestAgent(lat, lon, candidates);
      if (match && !exceedsAssignmentRadius(match.distanceKm)) {
        console.log(`[AGENT ASSIGNMENT] Assigned ${match.agent.business_name} via GPS Haversine. Distance: ${match.distanceKm.toFixed(2)}km`);
        return {
          agent: match.agent,
          method: 'gps_haversine',
          distanceKm: parseFloat(match.distanceKm.toFixed(2)),
          confidence: 'high',
          needsManualAgentReassignment: false,
          evidence,
        };
      }
    }

    // Fallback 2 — FORWARD-geocode the free-text description (inferred evidence
    // → MEDIUM confidence). Only a successful FORWARD geocode with a valid pair
    // is used; reverse geocoding is NEVER substituted and its output never
    // becomes matching coordinates.
    if (locationDescription && locationDescription.trim() !== '') {
      const geo = await deps.forwardGeocode(locationDescription);
      if (isValidCoordinatePair(geo.latitude, geo.longitude)) {
        const candidates = preferSubCountyAgents(scopedAgents, itemAdministrativeUnitId);
        const match = selectNearestAgent(geo.latitude, geo.longitude, candidates);
        if (match && !exceedsAssignmentRadius(match.distanceKm)) {
          console.log(`[AGENT ASSIGNMENT] Assigned ${match.agent.business_name} via Geocoded Text. Distance: ${match.distanceKm.toFixed(2)}km`);
          return {
            agent: match.agent,
            method: 'geocoded_text',
            distanceKm: parseFloat(match.distanceKm.toFixed(2)),
            confidence: 'medium',
            needsManualAgentReassignment: false,
            evidence,
          };
        }
      }
    }

    // Fallback 3 (was the actual bug) — never `activeAgents[0]` or any arbitrary
    // pick. Route to the admin manual-assignment queue instead.
    console.log('[AGENT ASSIGNMENT] Could not confidently match any agent (no GPS match, no geocoding match, or no agents with usable coordinates) — routing to manual assignment queue.');
    return manualAssignment(evidence);
  },
};
