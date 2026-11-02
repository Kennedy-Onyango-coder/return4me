// =============================================================================
// THE ONE HAVERSINE IMPLEMENTATION.
//
// WHY THIS MODULE EXISTS
// ---------------------
// The formula used to live inside services/agent.ts, which also imports the
// database, the geocoder and the auth service. That was fine while the ONLY
// consumer was the server-side matcher, but Stage 3B-6D needs the SAME distance
// for the administrator's candidate list — a browser component cannot import
// services/agent.ts (it would pull pg, bcrypt and the whole db graph into the
// client bundle), and copying the formula into the console would create two
// implementations that can silently disagree about how far apart two hubs are.
//
// So the implementation moves here: it has NO imports, no side effects and no
// configuration. services/agent.ts re-exports it, which is why the matcher and
// its existing tests keep the exact same public function.
//
// WHAT A DISTANCE HERE MEANS — AND WHAT IT DOES NOT
//   * It is the great-circle distance between two VALIDATED numeric coordinate
//     pairs. Nothing more.
//   * It is NOT a boundary test, a catchment area or proof that an Item was
//     found near a hub. `items.latitude/longitude` is a report-time device
//     position (a ROUTING HINT), and `agents.latitude/longitude` is the hub's
//     recorded operational location; the number below is the distance between
//     those two recorded points, never a claim about the physical world.
//   * Callers must decide whether the pair is usable. `isValidCoordinatePair()`
//     (services/coordinates.ts) is the only rule for that, and no caller may
//     substitute a county centroid or any other invented position to "make" a
//     distance appear.
// =============================================================================

/** Haversine distance in kilometres between two validated coordinate pairs. */
export function calculateHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
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
