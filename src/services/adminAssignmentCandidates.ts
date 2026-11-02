// =============================================================================
// STAGE 3B-6D — THE ADMINISTRATOR'S CANDIDATE LIST, DESCRIBED AND ORDERED.
//
// WHY THIS MODULE EXISTS
// ----------------------
// The item-review panel let an administrator choose an Agent hub from a dropdown
// that showed a name, a street address and (since Stage 3B-6D) a service area —
// and nothing else. The operator could not see, before choosing:
//   * whether that hub may receive work at all (the list filtered on
//     `status === 'active'`, which is NOT the eligibility rule);
//   * how the hub's service geography relates to the item's county and
//     sub-county (the same county? a different sub-county? a different county?);
//   * how far the hub is, or whether a distance is knowable at all.
// Deciding "nearest hub" or "the one in the next county is the only one
// answering the phone" was guesswork, and an accidental cross-county assignment
// was one mis-click away.
//
// WHAT THIS IS NOT — and this is the important part
// -------------------------------------------------
//   * It is NOT an assignment service. It writes nothing, reads no database,
//     decides nothing about who holds an item, and cannot assign. The only path
//     that assigns remains POST /api/admin/items/:id/review →
//     db.adminUpdateItem() (history + audit included).
//   * It is NOT an eligibility rule. `actionable` is COPIED from the server's
//     DTO, which computes it with isAgentActionable() — the one authority
//     (Stage 3B-1). This module never inspects `status`, `email_verified_at` or
//     anything else to form its own opinion, and a missing verdict (`null`) is
//     reported as "not stated" rather than guessed in either direction.
//   * It does NOT change automatic assignment policy, and it invents NO maximum
//     radius: every hub the server listed is returned, however far away
//     (MAX_AGENT_ASSIGNMENT_RADIUS_KM stays disabled — config/geoMatching.ts).
//   * It does NOT fabricate a distance. A number appears only when BOTH sides
//     hold a valid coordinate pair (`isValidCoordinatePair()`); otherwise the
//     answer is `null` and the label says the distance is unavailable. A county
//     centroid, a hub address or "0 km" is never substituted.
//   * It does NOT treat mixed administrative levels as equal. An item with a
//     sub-county and a hub without one is `same_county_unit_unknown`, never
//     `same_county_same_unit`.
//
// ORDERING (the brief's priorities, in this order):
//   1. selectable (actionable) candidates before ones that cannot receive work;
//   2. the item's county before an unknown county before another county;
//   3. within the same county, the same sub-county before a comparable-unknown
//      sub-county before a different sub-county;
//   4. a known distance ascending before an unavailable one;
//   5. ascending id — the SAME deterministic tie-break the matcher uses
//      (selectNearestAgent in services/agent.ts), so the console's list and the
//      automatic result never disagree about who is "first" at equal distance.
// =============================================================================

import { compareCounties, describeGeographyLabel, isSameAdministrativeUnit } from './agentGeography';
import { administrativeUnitNameForCounty } from '../config/kenyaAdministrativeUnits';
import { isValidCoordinatePair } from './coordinates';
import { calculateHaversineDistance } from './geoDistance';

/**
 * How a candidate's service geography relates to the item's declared geography.
 *
 * `county_unknown` is a first-class answer: when either side records no usable
 * county there is nothing to compare, and calling that `different_county` would
 * invent a mismatch (and, in the review panel, demand an acknowledgement for a
 * disagreement that does not exist).
 */
export type AssignmentGeographyRelation =
  | 'same_county_same_unit'
  | 'same_county_unit_unknown'
  | 'same_county_different_unit'
  | 'county_unknown'
  | 'different_county';


/** One Agent hub, described for the administrator who is choosing it. */
export interface AssignmentCandidate {
  id: string;
  businessName: string;
  locationAddress: string | null;
  /** The stored status, copied verbatim. NOT an eligibility verdict. */
  status: string | null;
  /**
   * The server's isAgentActionable() verdict. null means the payload did not
   * state one — which is reported, never resolved by guessing.
   */
  actionable: boolean | null;
  /** True only when the server said this hub may receive work. */
  selectable: boolean;
  /** Canonical county when resolvable, otherwise the stored text. */
  county: string | null;
  administrativeUnitId: string | null;
  administrativeUnitName: string | null;
  /** e.g. "Nairobi City — Westlands", or null when no county is recorded. */
  geographyLabel: string | null;
  relation: AssignmentGeographyRelation;
  /** A short phrase for the option label. */
  relationShortLabel: string;
  /** A full sentence for the review panel. */
  relationLabel: string;
  /** Kilometres, or null when no honest distance exists. */
  distanceKm: number | null;
  /** e.g. "3.4 km", or the explicit not-available wording. */
  distanceLabel: string;
}

/** What the panel knows about the item being assigned. */
export interface AssignmentCandidateItem {
  found_county?: unknown;
  administrative_unit_id?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

export const DISTANCE_UNAVAILABLE_LABEL = 'Distance not available';

/** How each geography relation reads in the option label (kept short). */
const RELATION_SHORT_LABELS: Record<AssignmentGeographyRelation, string> = {
  same_county_same_unit: 'same sub-county',
  same_county_unit_unknown: 'same county, sub-county not comparable',
  same_county_different_unit: 'same county, different sub-county',
  county_unknown: 'county not comparable',
  different_county: 'different county',
};

/** Priority of each relation when ordering (lower sorts first). */
const RELATION_RANK: Record<AssignmentGeographyRelation, number> = {
  same_county_same_unit: 0,
  same_county_unit_unknown: 1,
  same_county_different_unit: 2,
  county_unknown: 3,
  different_county: 4,
};

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}


/**
 * The county to DISPLAY for a stored value.
 *
 * Unlike the comparison key (which lower-cases), this keeps the human-facing
 * canonical name — "Nairobi City" — and falls back to the stored text for a
 * value the county resolver does not recognise, so the operator can see what the
 * row actually holds instead of a blank.
 */
function displayCounty(value: unknown): string | null {
  const text = optionalText(value);
  if (!text) return null;
  return describeGeographyLabel(text, null) ?? text;
}

/**
 * The relation between an item's declared geography and a hub's service
 * geography. Pure: value comparisons only — no boundary data, no proximity
 * inference, no guessing.
 */
export function describeAssignmentRelation(params: {
  itemCounty?: unknown;
  itemAdministrativeUnitId?: unknown;
  agentCounty?: unknown;
  agentAdministrativeUnitId?: unknown;
}): AssignmentGeographyRelation {
  const countyMatch = compareCounties(params?.itemCounty, params?.agentCounty);
  if (countyMatch === 'unknown') return 'county_unknown';
  if (countyMatch === 'different') return 'different_county';

  // Same county. A sub-county is comparable only when BOTH sides record one: a
  // missing id is never evidence of a match (see services/agentGeography.ts), and
  // comparing an item's sub-county against a hub's absent one would present two
  // different administrative levels as if they were the same thing.
  const itemUnit = optionalText(params?.itemAdministrativeUnitId);
  const agentUnit = optionalText(params?.agentAdministrativeUnitId);
  if (!itemUnit || !agentUnit) return 'same_county_unit_unknown';
  return isSameAdministrativeUnit(itemUnit, agentUnit)
    ? 'same_county_same_unit'
    : 'same_county_different_unit';
}

/**
 * Kilometres between the item's recorded report position and the hub's recorded
 * operational location — or null. Null is returned unless BOTH pairs are valid,
 * and no substitute origin is ever used (see the module header).
 */
export function candidateDistanceKm(item: AssignmentCandidateItem | null | undefined, agent: any): number | null {
  const itemPairValid = isValidCoordinatePair(item?.latitude, item?.longitude);
  const agentPairValid = isValidCoordinatePair(agent?.latitude, agent?.longitude);
  if (!itemPairValid || !agentPairValid) return null;
  return calculateHaversineDistance(
    item.latitude as number,
    item.longitude as number,
    agent.latitude as number,
    agent.longitude as number,
  );
}

/** "3.4 km", or the explicit "Distance not available". Never "0 km" by default. */
export function formatCandidateDistance(distanceKm: number | null): string {
  if (typeof distanceKm !== 'number' || !Number.isFinite(distanceKm)) return DISTANCE_UNAVAILABLE_LABEL;
  return distanceKm.toFixed(1) + ' km';
}


function relationLabelFor(relation: AssignmentGeographyRelation, agentCounty: string | null, itemCounty: string | null): string {
  switch (relation) {
    case 'same_county_same_unit':
      return 'Serves the same county and the same sub-county as this item.';
    case 'same_county_unit_unknown':
      return 'Serves the same county as this item, but the sub-county is not comparable because one side records none.';
    case 'same_county_different_unit':
      return 'Serves the same county as this item, in a different sub-county.';
    case 'different_county':
      return 'Serves ' + (agentCounty ?? 'a different county') + ', not ' +
        (itemCounty ?? 'the county recorded on this item') + '. Assigning this item here is a cross-county override.';
    default:
      return 'County cannot be compared: no usable county is recorded on the item or the hub.';
  }
}

/**
 * Projects the server's Agent list into ordered, described candidates.
 *
 * EVERY agent the caller passes is returned — eligibility, distance and county
 * ordering change the POSITION and the `selectable` flag, never the population,
 * so a hub cannot vanish from the console without an explanation. `agents` may be
 * null/undefined (a dashboard that has not loaded yet); a non-object entry or one
 * without a string id is skipped rather than rendered as a nameless option.
 */
export function buildAssignmentCandidates(params: {
  item?: AssignmentCandidateItem | null;
  agents?: any[] | null;
}): AssignmentCandidate[] {
  const item = params?.item ?? null;
  const agents = Array.isArray(params?.agents) ? params.agents : [];
  const itemCounty = displayCounty(item?.found_county);

  const candidates: AssignmentCandidate[] = [];
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object') continue;
    if (typeof agent.id !== 'string' || agent.id === '') continue;

    const relation = describeAssignmentRelation({
      itemCounty: item?.found_county,
      itemAdministrativeUnitId: item?.administrative_unit_id,
      agentCounty: agent.county,
      agentAdministrativeUnitId: agent.administrative_unit_id,
    });
    const county = displayCounty(agent.county);
    const administrativeUnitId = optionalText(agent.administrative_unit_id);
    const distanceKm = candidateDistanceKm(item, agent);
    // The verdict is COPIED, never derived: only an explicit `true` from the
    // server makes a hub selectable, and `null` ("not stated") is not `false`.
    const actionable = agent.actionable === true ? true : agent.actionable === false ? false : null;

    candidates.push({
      id: agent.id,
      businessName: optionalText(agent.business_name) ?? agent.id,
      locationAddress: optionalText(agent.location_address),
      status: optionalText(agent.status),
      actionable,
      selectable: actionable === true,
      county,
      administrativeUnitId,
      administrativeUnitName: administrativeUnitNameForCounty(county ?? '', administrativeUnitId),
      geographyLabel: describeGeographyLabel(agent.county, administrativeUnitId),
      relation,
      relationShortLabel: RELATION_SHORT_LABELS[relation],
      relationLabel: relationLabelFor(relation, county, itemCounty),
      distanceKm,
      distanceLabel: formatCandidateDistance(distanceKm),
    });
  }

  return candidates.sort(compareAssignmentCandidates);
}

/**
 * The ordering documented in the module header. Total and deterministic: two
 * candidates can only be "equal" when they are the same hub, so the list never
 * reshuffles between renders for data that has not changed.
 */
export function compareAssignmentCandidates(a: AssignmentCandidate, b: AssignmentCandidate): number {
  if (a.selectable !== b.selectable) return a.selectable ? -1 : 1;

  const rankDelta = RELATION_RANK[a.relation] - RELATION_RANK[b.relation];
  if (rankDelta !== 0) return rankDelta;

  // Known distances ascending; an unavailable distance sorts after every known
  // one, because "we do not know" is not "zero kilometres away".
  if (a.distanceKm !== null || b.distanceKm !== null) {
    if (a.distanceKm === null) return 1;
    if (b.distanceKm === null) return -1;
    if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
  }

  // Ascending id — the same tie-break selectNearestAgent() applies.
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** The hubs the console may offer as an assignment target. */
export function selectableAssignmentCandidates(candidates: AssignmentCandidate[] | null | undefined): AssignmentCandidate[] {
  return (Array.isArray(candidates) ? candidates : []).filter(candidate => candidate.selectable === true);
}

/** The hubs that are listed but cannot be chosen, so the panel can say why. */
export function excludedAssignmentCandidates(candidates: AssignmentCandidate[] | null | undefined): AssignmentCandidate[] {
  return (Array.isArray(candidates) ? candidates : []).filter(candidate => candidate.selectable !== true);
}

/** The candidate for an id, or null. Used to describe the current selection. */
export function findAssignmentCandidate(
  candidates: AssignmentCandidate[] | null | undefined,
  agentId: string | null | undefined,
): AssignmentCandidate | null {
  if (!agentId) return null;
  return (Array.isArray(candidates) ? candidates : []).find(candidate => candidate.id === agentId) ?? null;
}


/**
 * One line for the option itself, so the operator sees the geography BEFORE
 * choosing: the hub, its recorded service area, the relationship to this item and
 * — only when it is knowable — the distance.
 *
 * The eligibility verdict is NOT repeated here: the console excludes hubs that
 * cannot receive work from the selectable list entirely (see
 * selectableAssignmentCandidates), so every option in the list is eligible.
 */
export function describeAssignmentCandidate(candidate: AssignmentCandidate): string {
  const parts = [candidate.businessName];
  if (candidate.locationAddress) parts.push('(' + candidate.locationAddress + ')');
  const geography = candidate.geographyLabel ?? 'service county not recorded';
  return parts.join(' ') + ' — ' + geography + ' · ' + candidate.relationShortLabel + ' · ' + candidate.distanceLabel;
}
