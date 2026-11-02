// =============================================================================
// STAGE 3B-6 — THE ONE PLACE THAT COMPARES AN AGENT'S SERVICE GEOGRAPHY WITH AN
// ITEM'S DECLARED GEOGRAPHY.
//
// WHY THIS MODULE EXISTS
// ----------------------
// Before this stage, "the Agent serves this item's county" was expressed as
// `agent.county === item.found_county` — in the matcher (services/agent.ts) and
// in the admin console — and `===` is the wrong test for a value that arrives
// from three different writers:
//
//   * `agents.county`  — chosen at registration (canonicalised by
//                        resolveCountyName()), left NULL on a legacy row, or
//                        corrected by an administrator (Stage 3B-6A);
//   * `items.found_county` — chosen by the Finder and re-validated server-side;
//   * `lost_reports.county` — same rule, different table.
//
// Every one of those is *supposed* to be canonical, but "supposed to be" is not
// a fact a comparison may rely on. A row written before the canonicaliser
// existed, or by a hand-run correction, can hold `nairobi`, `Nairobi ` or
// `Nairobi City`. Those are the SAME county; `===` says they are three
// different ones, and the operational consequence is an agent that exists, is
// active and serves the item's county, yet is never matched.
//
// WHAT THIS IS NOT
// ----------------
//   * It is NOT a boundary engine. There is no polygon, no GeoJSON, no
//     point-in-polygon and no PostGIS here. Two values match because they name
//     the same county in the canonical dataset, never because a shape contains
//     a point.
//   * It NEVER guesses a county. `resolveCountyName()` is the only resolver and
//     it returns null for anything that is not a Kenyan county; the comparison
//     below then answers `unknown`, which is the honest answer, not `same`.
//   * It does NOT introduce a distance limit, an automatic assignment policy or
//     a new eligibility rule. Eligibility remains isAgentActionable()'s
//     decision alone (Stage 3B-1); this module describes geography, and the
//     administrator still decides.
//   * It persists nothing. No column, no migration.
// =============================================================================

import { resolveCountyName } from '../config/kenyaCounties';
import {
  administrativeUnitNameForCounty,
  resolveAdministrativeUnitId,
} from '../config/kenyaAdministrativeUnits';

/**
 * The three answers a county comparison can give.
 *
 * `unknown` is a first-class result, not a failure: when either side has no
 * recorded county there is nothing to compare, and calling that `different`
 * would invent a mismatch (and, in the admin route, demand an acknowledgement
 * for a disagreement that does not exist).
 */
export type CountyMatch = 'same' | 'different' | 'unknown';

/** The canonical name when the value names a Kenyan county, otherwise null. */
export function canonicalCounty(value: unknown): string | null {
  return resolveCountyName(typeof value === 'string' ? value : null);
}

/**
 * The comparison key for a county-like value: the canonical county name in
 * lower case, or — for a value that does not name a Kenyan county — the value
 * itself, trimmed, whitespace-collapsed and lower-cased.
 *
 * The fallback exists so two identical non-canonical values still compare equal
 * (`Nairobii` vs `Nairobii`). It can never make two DIFFERENT places match: the
 * canonical resolver always wins first, so an alias and its canonical name
 * collapse together, while a misspelling stays a different key.
 *
 * Returns null when there is nothing to compare (absent, blank, non-string).
 */
export function countyComparisonKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const canonical = canonicalCounty(value);
  if (canonical) return canonical.toLowerCase();
  const collapsed = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return collapsed === '' ? null : collapsed;
}

/**
 * `same` / `different` / `unknown` for two county-like values.
 *
 * Case, surrounding whitespace, internal runs of whitespace, and the documented
 * spelling aliases (config/kenyaCounties.ts) are all tolerated; nothing else is.
 */
export function compareCounties(left: unknown, right: unknown): CountyMatch {
  const leftKey = countyComparisonKey(left);
  const rightKey = countyComparisonKey(right);
  if (!leftKey || !rightKey) return 'unknown';
  return leftKey === rightKey ? 'same' : 'different';
}

/** True ONLY for a positive match. `unknown` is deliberately not "same". */
export function isSameCounty(left: unknown, right: unknown): boolean {
  return compareCounties(left, right) === 'same';
}

/**
 * Sub-county identity comparison.
 *
 * Administrative unit ids are configured data (`KE-47-SC-01`), not user text,
 * so trimming and case-folding is the whole rule — there is no alias table and
 * this must never invent one. Returns false when either side is absent, because
 * "no sub-county recorded" is not evidence of the same sub-county.
 */
export function isSameAdministrativeUnit(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftId = left.trim().toLowerCase();
  const rightId = right.trim().toLowerCase();
  if (!leftId || !rightId) return false;
  return leftId === rightId;
}

/** A display label for a stored geography, never a claim that it is verified. */
export function describeGeographyLabel(county: unknown, administrativeUnitId: unknown): string | null {
  if (typeof county !== 'string' || county.trim() === '') return null;
  const canonical = canonicalCounty(county) ?? county.trim();
  const unitName =
    typeof administrativeUnitId === 'string'
      ? administrativeUnitNameForCounty(canonical, administrativeUnitId)
      : null;
  return unitName ? `${canonical} — ${unitName}` : canonical;
}

// -----------------------------------------------------------------------------
// STAGE 3B-6A — VALIDATING AN ADMINISTRATOR'S GEOGRAPHY CORRECTION.
//
// The route and the data-layer writer both go through this one function, for the
// same reason the county resolver is shared everywhere else: a second, looser
// copy of "is this a real county with a real sub-county" is how a row ends up
// holding a value no other code path can match.
//
// The sub-county is REQUIRED, matching agent registration (POST
// /api/agents/register, which refuses a county without a unit). Allowing a
// correction to clear it would let an administrator make a hub *less* matchable
// than the registration flow ever permits, while the console reported success.
// -----------------------------------------------------------------------------

export const AGENT_GEOGRAPHY_COUNTY_REQUIRED_MESSAGE =
  'Choose the county this Agent hub serves. No geography was changed.';

export const AGENT_GEOGRAPHY_UNIT_REQUIRED_MESSAGE =
  'Choose the sub-county this Agent hub serves. No geography was changed.';

export const AGENT_GEOGRAPHY_UNIT_MISMATCH_MESSAGE =
  'That sub-county does not belong to the selected county. No geography was changed.';

export interface AgentGeographyCorrection {
  /** Canonical county name from config/kenyaCounties.ts. */
  county: string;
  /** Canonical administrative unit id belonging to `county`. */
  administrativeUnitId: string;
}

/**
 * The validator's verdict — a flat object, deliberately.
 *
 * `strictNullChecks` is off in this repository, so a boolean literal
 * discriminant does not narrow a union and every caller would have to assert the
 * shape it had just checked (the same reasoning recorded in
 * config/adminAssignmentReasonPolicy.ts). `ok` decides; `error` is safe to
 * return verbatim; `field` names the input the operator must fix.
 */
export interface AgentGeographyCorrectionValidation {
  ok: boolean;
  /** Populated only when `ok` is true. */
  correction: AgentGeographyCorrection | null;
  /** Operator-safe refusal message. Empty string when `ok` is true. */
  error: string;
  /** Which submitted field failed, or null when the correction is accepted. */
  field: 'county' | 'administrativeUnitId' | null;
}

export function validateAgentGeographyCorrection(input: {
  county?: unknown;
  administrativeUnitId?: unknown;
}): AgentGeographyCorrectionValidation {
  const canonical = canonicalCounty(input?.county);
  if (!canonical) {
    return {
      ok: false,
      correction: null,
      error: AGENT_GEOGRAPHY_COUNTY_REQUIRED_MESSAGE,
      field: 'county',
    };
  }

  const rawUnit = input?.administrativeUnitId;
  const submittedUnit = typeof rawUnit === 'string' ? rawUnit.trim() : '';
  if (!submittedUnit) {
    return {
      ok: false,
      correction: null,
      error: AGENT_GEOGRAPHY_UNIT_REQUIRED_MESSAGE,
      field: 'administrativeUnitId',
    };
  }

  const unitId = resolveAdministrativeUnitId(canonical, submittedUnit);
  if (!unitId) {
    return {
      ok: false,
      correction: null,
      error: AGENT_GEOGRAPHY_UNIT_MISMATCH_MESSAGE,
      field: 'administrativeUnitId',
    };
  }

  return {
    ok: true,
    correction: { county: canonical, administrativeUnitId: unitId },
    error: '',
    field: null,
  };
}

// -----------------------------------------------------------------------------
// STAGE 3B-6D — DESCRIBING AN ADMINISTRATOR'S CHOSEN ASSIGNMENT.
//
// The admin review route used to say nothing at all about geography: an
// administrator could point an item at a hub in another county and the console
// reported success. That is a legitimate decision in some cases (there is no hub
// in the item's county, or the finder picked the wrong county), so this stage
// does NOT forbid it — it makes the disagreement EXPLICIT and requires the
// administrator to acknowledge it, which is the difference between an override
// and a mistake.
//
// The acknowledgement rule is exactly this narrow:
//   requires_acknowledgement === (both sides hold a county) && (they differ).
// A missing county on either side is NOT a mismatch, and a same-county
// assignment never asks for anything. No distance threshold is consulted and
// none is introduced: MAX_AGENT_ASSIGNMENT_RADIUS_KM stays disabled.
// -----------------------------------------------------------------------------

export const OUT_OF_COUNTY_ASSIGNMENT_ACKNOWLEDGEMENT_MESSAGE =
  'The selected Agent hub serves a different county from the one recorded on this item. Confirm the out-of-county assignment to continue, or choose a hub in the item’s county. No assignment was made.';

/** The admin console's view of the geography behind one assignment decision. */
export interface AssignmentGeographyAssessment {
  /** Canonical when resolvable; null when nothing usable was recorded. */
  item_county: string | null;
  agent_county: string | null;
  item_administrative_unit_id: string | null;
  agent_administrative_unit_id: string | null;
  county_match: CountyMatch;
  /** null when either side records no sub-county — never a guess. */
  sub_county_match: boolean | null;
  /** True only for a KNOWN disagreement (see the block comment above). */
  requires_acknowledgement: boolean;
  /** Always false. This platform holds no authoritative boundary data. */
  boundary_verified: false;
  /** A sentence an administrator can read; states the rule, never a boundary. */
  summary: string;
}

function displayCounty(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return canonicalCounty(value) ?? value.trim();
}

function displayUnitId(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

/**
 * Compares the item's declared geography with the chosen Agent hub's service
 * geography. Pure: no database read, no geocoder, no boundary data.
 */
export function assessAssignmentGeography(params: {
  itemCounty?: unknown;
  itemAdministrativeUnitId?: unknown;
  agentCounty?: unknown;
  agentAdministrativeUnitId?: unknown;
}): AssignmentGeographyAssessment {
  const itemCounty = displayCounty(params?.itemCounty);
  const agentCounty = displayCounty(params?.agentCounty);
  const itemUnitId = displayUnitId(params?.itemAdministrativeUnitId);
  const agentUnitId = displayUnitId(params?.agentAdministrativeUnitId);

  const countyMatch = compareCounties(itemCounty, agentCounty);
  const subCountyMatch =
    itemUnitId && agentUnitId ? isSameAdministrativeUnit(itemUnitId, agentUnitId) : null;

  let summary: string;
  if (countyMatch === 'different') {
    summary = `The Agent hub serves ${agentCounty}, not ${itemCounty}, which is the county recorded on this item.`;
  } else if (countyMatch === 'same') {
    if (subCountyMatch === true) {
      summary = 'The Agent hub serves the same county and sub-county as this item.';
    } else if (subCountyMatch === false) {
      summary = 'The Agent hub serves the same county but a different sub-county from this item.';
    } else {
      summary = 'The Agent hub serves the same county as this item.';
    }
  } else {
    summary =
      'This item has no recorded county, so the Agent hub’s service county cannot be compared with it.';
  }

  return {
    item_county: itemCounty,
    agent_county: agentCounty,
    item_administrative_unit_id: itemUnitId,
    agent_administrative_unit_id: agentUnitId,
    county_match: countyMatch,
    sub_county_match: subCountyMatch,
    requires_acknowledgement: countyMatch === 'different',
    boundary_verified: false,
    summary,
  };
}
