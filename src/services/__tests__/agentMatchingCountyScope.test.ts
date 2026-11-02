import { describe, expect, it } from 'vitest';
import type { Agent } from '../../db/database';
import {
  AgentMatchingService,
  preferSubCountyAgents,
  scopeCandidateAgents,
} from '../agent';

// =============================================================================
// STAGE 3B-6C — COUNTY NORMALIZATION IN THE MATCHER.
//
// THE BUG THIS PINS. `scopeCandidateAgents()` filtered candidates with
// `agent.county === itemCounty`. Both sides are *supposed* to hold a canonical
// county, but rows written before the canonicaliser existed — or by a hand-run
// correction — can hold `nairobi`, ` Nairobi City ` or `NAIROBI CITY`. Those name
// the SAME county as the finder's `Nairobi City`, and `===` treated them as three
// different counties, so an active, verified hub that genuinely serves the area
// could never be matched. Nothing about eligibility, the county filter itself or
// the manual-assignment fallback changed in this stage; only how "serves this
// county" is decided.
//
// Every agent fixture here passes isAgentActionable() (active + email verified)
// unless a test deliberately withholds verification, so the ONLY variable is the
// stored geography.
// =============================================================================

let counter = 0;

function agent(overrides: Partial<Record<string, unknown>> = {}): Agent {
  const id = `AGENT-${counter++}`;
  return {
    id,
    business_name: `Hub ${id}`,
    contact_phone: '+254700000100',
    location_address: 'Ngong Road, Nairobi',
    county: 'Nairobi City',
    administrative_unit_id: 'KE-47-SC-01',
    latitude: -1.2921,
    longitude: 36.8219,
    mpesa_till_or_paybill: '000123',
    payout_method_type: 'Personal M-Pesa',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash',
    rating: 5,
    rating_count: 0,
    needs_manual_geocoding: false,
    email_verified_at: '2026-01-01T00:00:00.000Z',
    contact_email: `${id}@example.com`,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as any;
}

describe('B6-C — the county scope tolerates aliases, case and padding', () => {
  it('includes a hub whose stored county is an alias, differently cased or padded', () => {
    for (const stored of ['nairobi', 'NAIROBI CITY', '  Nairobi   City  ', 'Nairobi City']) {
      const hub = agent({ county: stored });
      const { scopedAgents } = scopeCandidateAgents([hub], 'Nairobi City');
      expect(scopedAgents.map(a => a.id), `stored=${JSON.stringify(stored)}`).toEqual([hub.id]);
    }
  });

  it('still excludes a hub serving a different county', () => {
    const mombasa = agent({ county: 'Mombasa', administrative_unit_id: 'KE-01-SC-01' });
    const { scopedAgents, scopedToCounty } = scopeCandidateAgents([mombasa], 'Nairobi City');
    expect(scopedToCounty).toBe(true);
    expect(scopedAgents).toHaveLength(0);
  });

  it('does not treat a misspelling as the same county', () => {
    const typo = agent({ county: 'Nairobii' });
    const { scopedAgents } = scopeCandidateAgents([typo], 'Nairobi City');
    expect(scopedAgents).toHaveLength(0);
  });

  it('excludes a hub with no recorded county when the item declares one', () => {
    // Unchanged behaviour, asserted on purpose: "no county" is not evidence that
    // the hub serves this one, so the item goes to the manual queue instead.
    const unknown = agent({ county: null, administrative_unit_id: null });
    const { scopedAgents } = scopeCandidateAgents([unknown], 'Nairobi City');
    expect(scopedAgents).toHaveLength(0);
  });

  it('keeps the operational gate independent of geography', () => {
    const unverified = agent({ county: 'Nairobi City', email_verified_at: null });
    const { activeAgents, scopedAgents } = scopeCandidateAgents([unverified], 'Nairobi City');
    expect(activeAgents).toHaveLength(1);
    expect(scopedAgents).toHaveLength(0);
  });

  it('applies no county filter when the item declares none', () => {
    const hub = agent({ county: null });
    const { scopedAgents, scopedToCounty } = scopeCandidateAgents([hub], null);
    expect(scopedToCounty).toBe(false);
    expect(scopedAgents.map(a => a.id)).toEqual([hub.id]);
  });
});
describe('B6-C — the sub-county preference uses the same tolerant comparison', () => {
  it('prefers the hub holding the item’s sub-county, whatever its stored casing', () => {
    const sameUnit = agent({ administrative_unit_id: 'ke-47-sc-01' });
    const otherUnit = agent({ administrative_unit_id: 'KE-47-SC-02' });
    const preferred = preferSubCountyAgents([otherUnit, sameUnit], 'KE-47-SC-01');
    expect(preferred.map(a => a.id)).toEqual([sameUnit.id]);
  });

  it('falls back to the whole county scope when no hub holds the sub-county', () => {
    const otherUnit = agent({ administrative_unit_id: 'KE-47-SC-02' });
    const preferred = preferSubCountyAgents([otherUnit], 'KE-47-SC-01');
    expect(preferred.map(a => a.id)).toEqual([otherUnit.id]);
  });

  it('never treats a missing sub-county as a match', () => {
    const noUnit = agent({ administrative_unit_id: null });
    const sameUnit = agent({ administrative_unit_id: 'KE-47-SC-01' });
    const preferred = preferSubCountyAgents([noUnit, sameUnit], 'KE-47-SC-01');
    expect(preferred.map(a => a.id)).toEqual([sameUnit.id]);
  });
});

describe('B6-C — a hub with a non-canonical county is now actually assignable', () => {
  const deps = (agents: Agent[]) => ({
    getAgents: async () => agents,
    forwardGeocode: async () => ({ latitude: null, longitude: null }),
  });

  it('assigns the nearest hub whose stored county is an alias of the item county', async () => {
    const dirty = agent({ county: ' nairobi ', administrative_unit_id: ' ke-47-sc-01 ' });

    const result = await AgentMatchingService.assignNearestAgent(
      -1.2921,
      36.8219,
      '',
      'Nairobi City',
      'KE-47-SC-01',
      deps([dirty]) as any,
    );

    // Before Stage 3B-6C this was `manual_required`: the hub was excluded by
    // `===` and the item waited for an administrator.
    expect(result.agent?.id).toBe(dirty.id);
    expect(result.method).toBe('gps_haversine');
    expect(result.needsManualAgentReassignment).toBe(false);
  });

  it('still refuses to widen the scope to another county', async () => {
    const mombasa = agent({ county: 'Mombasa', administrative_unit_id: 'KE-01-SC-01' });

    const result = await AgentMatchingService.assignNearestAgent(
      -1.2921,
      36.8219,
      '',
      'Nairobi City',
      'KE-47-SC-01',
      deps([mombasa]) as any,
    );

    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
    expect(result.needsManualAgentReassignment).toBe(true);
  });
});
