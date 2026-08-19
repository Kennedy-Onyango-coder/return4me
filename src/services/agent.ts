import { db, Agent } from '../db/database';

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

export async function geocodeAddress(address: string): Promise<{ latitude: number | null; longitude: number | null; needsManual: boolean }> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address + ', Kenya')}&format=json&limit=1`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Return4me-Kenya-Lost-and-Found-Platform/1.0 (contact@return4me.co.ke)'
      }
    });

    if (!response.ok) {
      console.error(`Nominatim API returned non-200: ${response.status}`);
      return { latitude: null, longitude: null, needsManual: true };
    }

    const data = await response.json() as any[];
    if (data && data.length > 0) {
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      if (!isNaN(lat) && !isNaN(lon)) {
        return { latitude: lat, longitude: lon, needsManual: false };
      }
    }

    return { latitude: null, longitude: null, needsManual: true };
  } catch (error) {
    console.error('Nominatim geocoding error:', error);
    return { latitude: null, longitude: null, needsManual: true };
  }
}

export const AgentMatchingService = {
  /**
   * Find nearest active agent based on strict fallback algorithm
   */
  async assignNearestAgent(
    lat: number | null,
    lon: number | null,
    locationDescription: string
  ): Promise<{
    agent: Agent;
    method: 'gps_haversine' | 'geocoded_text' | 'manual_fallback';
    distanceKm: number | null;
    needsManualAgentReassignment: boolean;
  }> {
    const agents = await db.getAgents();
    const activeAgents = agents.filter(a => a.status === 'active');

    if (activeAgents.length === 0) {
      throw new Error('No active Return4me agents available in the system currently.');
    }

    // Fallback 1: GPS Haversine assignment (no cutoff)
    if (lat !== null && lon !== null) {
      let nearestAgent: Agent | null = null;
      let minDistance = Infinity;

      for (const agent of activeAgents) {
        if (agent.latitude !== null && agent.longitude !== null) {
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
      if (geoResult.latitude !== null && geoResult.longitude !== null) {
        let nearestAgent: Agent | null = null;
        let minDistance = Infinity;

        for (const agent of activeAgents) {
          if (agent.latitude !== null && agent.longitude !== null) {
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

    // Fallback 3: Oldest active agent in list as catch-all (never fail dropoff flow)
    const fallbackAgent = activeAgents[0];
    console.log(`[AGENT ASSIGNMENT] Assigned ${fallbackAgent.business_name} via Default Fallback.`);
    return {
      agent: fallbackAgent,
      method: 'manual_fallback',
      distanceKm: null,
      needsManualAgentReassignment: true,
    };
  },
};
