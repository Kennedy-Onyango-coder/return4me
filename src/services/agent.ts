import { db, Agent } from '../db/database';
import { geocodeForward } from './geocoding/index.ts';
import { isValidCoordinatePair } from './coordinates.ts';

// Haversine distance formula in kilometers
function calculateHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Forward-geocodes an Agent's free-text address.
 *
 * PHASE 9D — this function is now a THIN ADAPTER over the provider-neutral
 * geocoding boundary (services/geocoding/index.ts). It exists only to preserve
 * the tiny legacy return shape the agent-signup route already consumes.
 *
 * What changed, and why:
 *   * the hard-coded Nominatim URL is gone from this file — all provider
 *     knowledge now lives behind the boundary, so no business-logic module
 *     contains a provider endpoint;
 *   * the outbound request now has a bounded TIMEOUT, a CACHE, a THROTTLE and
 *     IN-FLIGHT DEDUPLICATION, and its coordinates are VALIDATED (finite,
 *     in-range) before being returned;
 *   * the caller can DISABLE geocoding entirely by configuration, in which case
 *     no request is made and `needsManual: true` is returned.
 *
 * FAILURE IS UNCHANGED IN SHAPE AND INTENT: every failure mode still yields
 * `{ latitude: null, longitude: null, needsManual: true }`, which the existing
 * callers already handle by routing the Agent to the manual review queue rather
 * than inventing a location. This function never throws.
 *
 * SEMANTIC NOTE: an Agent's coordinates mean "where this Agent hub operates".
 * That is the only coordinate meaning this codebase actually establishes, and
 * nothing here widens it.
 */
export async function geocodeAddress(address: string): Promise<{ latitude: number | null; longitude: number | null; needsManual: boolean }> {
  const outcome = await geocodeForward(address);
  if (outcome.status === 'ok') {
    return { latitude: outcome.latitude, longitude: outcome.longitude, needsManual: false };
  }
  return { latitude: null, longitude: null, needsManual: true };
}

export const AgentMatchingService = {
  /**
   * Find nearest active agent based on strict fallback algorithm.
   *
   * IMPORTANT: this NEVER pretends an arbitrary agent is the nearest one.
   * If GPS matching fails, address geocoding fails, no active agents
   * exist, or the active agents that do exist have no coordinates on
   * file, this returns agent: null with needsManualAgentReassignment:
   * true — the caller (POST /api/items/report in server.ts) must create
   * the item with assigned_agent_id: null and route it into the admin
   * manual-assignment queue, not silently attach a real (possibly
   * far-away, possibly wrong) agent and let the Finder be sent there
   * under the false impression it was confidently matched.
   */
  async assignNearestAgent(
    lat: number | null,
    lon: number | null,
    locationDescription: string
  ): Promise<{
    agent: Agent | null;
    method: 'gps_haversine' | 'geocoded_text' | 'manual_required';
    distanceKm: number | null;
    needsManualAgentReassignment: boolean;
  }> {
    const agents = await db.getAgents();
    const activeAgents = agents.filter(a => a.status === 'active');

    // Scenario D (no active agents at all): this used to throw, which
    // failed the Finder's entire report submission with a hard error.
    // Reporting a found item should never fail outright just because
    // agent capacity is temporarily at zero — queue it for manual
    // assignment instead, same as any other "couldn't confidently match"
    // outcome.
    if (activeAgents.length === 0) {
      console.log('[AGENT ASSIGNMENT] No active agents available — routing to manual assignment queue.');
      return { agent: null, method: 'manual_required', distanceKm: null, needsManualAgentReassignment: true };
    }

    // Fallback 1: GPS Haversine assignment (no cutoff)
    //
    // PHASE 9D: the caller-supplied pair is now VALIDATED (finite + in range)
    // before any distance is computed. Previously a non-numeric or absurd
    // latitude reached this loop and produced an all-NaN comparison, which
    // silently behaved like "no agent is near" — correct by accident, but for
    // the wrong reason. An invalid pair is now treated as "no coordinates
    // supplied", which is exactly the same safe outcome, made explicit.
    if (isValidCoordinatePair(lat, lon)) {
      let nearestAgent: Agent | null = null;
      let minDistance = Infinity;

      for (const agent of activeAgents) {
        // PHASE 9D: an agent's stored coordinates are also validated on read,
        // so a legacy row holding an out-of-range or non-numeric value is
        // treated as "this hub has no coordinates" rather than being fed into
        // the Haversine formula. Its meaning is never guessed or corrected.
        if (isValidCoordinatePair(agent.latitude, agent.longitude)) {
          const distance = calculateHaversineDistance(lat, lon, agent.latitude, agent.longitude);
          if (distance < minDistance) {
            minDistance = distance;
            nearestAgent = agent;
          }
        }
      }

      if (nearestAgent) {
        console.log(`[AGENT ASSIGNMENT] Assigned ${nearestAgent.business_name} via GPS Haversine. Distance: ${minDistance.toFixed(2)}km`);
        return {
          agent: nearestAgent,
          method: 'gps_haversine',
          distanceKm: parseFloat(minDistance.toFixed(2)),
          needsManualAgentReassignment: false,
        };
      }
    }

    // Fallback 2: Geocode free-text description
    if (locationDescription && locationDescription.trim() !== '') {
      const geoResult = await geocodeAddress(locationDescription);
      if (isValidCoordinatePair(geoResult.latitude, geoResult.longitude)) {
        let nearestAgent: Agent | null = null;
        let minDistance = Infinity;

        for (const agent of activeAgents) {
          if (isValidCoordinatePair(agent.latitude, agent.longitude)) {
            const distance = calculateHaversineDistance(geoResult.latitude, geoResult.longitude, agent.latitude, agent.longitude);
            if (distance < minDistance) {
              minDistance = distance;
              nearestAgent = agent;
            }
          }
        }

        if (nearestAgent) {
          console.log(`[AGENT ASSIGNMENT] Assigned ${nearestAgent.business_name} via Geocoded Text. Distance: ${minDistance.toFixed(2)}km`);
          return {
            agent: nearestAgent,
            method: 'geocoded_text',
            distanceKm: parseFloat(minDistance.toFixed(2)),
            needsManualAgentReassignment: false,
          };
        }
      }
    }

    // Fallback 3 (was the actual bug): GPS matching failed, geocoding
    // failed or wasn't possible, OR active agents exist but scenario E
    // applies — none of them have coordinates on file, so a distance
    // comparison genuinely can't be made even though agents technically
    // exist. In every one of these cases, NEVER fall back to
    // activeAgents[0] or any other arbitrary pick. Return null and let
    // an admin — who can see the actual reported location and the real
    // list of agents — make the call.
    console.log('[AGENT ASSIGNMENT] Could not confidently match any agent (no GPS match, no geocoding match, or no agents with usable coordinates) — routing to manual assignment queue.');
    return { agent: null, method: 'manual_required', distanceKm: null, needsManualAgentReassignment: true };
  },
};
