import { describe, it, expect } from 'vitest';
import { AgentMatchingService, scopeCandidateAgents } from '../agent';
import { isAgentActionable } from '../auth';
import { matchPendingItemsForOperationalAgent, type AgentAutoAssignmentDeps } from '../agentAutoAssignment';
import type { Agent, FoundItem } from '../../db/database';

// =============================================================================
// PHASE 16.1 BATCH 3 — STAGE 3B-0 (characterization) + STAGE 3B-1 (the fix).
//
// THE FINDING THIS PINS (audit gap G1). Two different predicates decided whether
// an agent may receive work, and they did not agree:
//
//   services/agent.ts      scopeCandidateAgents()  ->  status === 'active'
//   services/auth.ts       isAgentActionable()     ->  status === 'active'
//                                                      AND (email verified OR
//                                                           no email on file)
//
// The email axis was the difference. An agent who registered after N4 (so has a
// contact_email) but has not activated yet was `active` for the matcher and NOT
// actionable for every operational route. The matcher handed them an item,
// cleared `needs_manual_agent_reassignment`, and the item left the manual queue
// while the agent could not sign in to process it.
//
// STAGE 3B-1 CLOSED THAT: `scopeCandidateAgents()` now filters the pool with
// `isAgentActionable()` (the one authority, re-used — not re-derived), and
// `assignNearestAgent()` gained an explicit "no operationally eligible agents"
// guard. These tests now assert the UNIFIED rule; the 3B-0 versions that
// asserted the split were deliberately inverted here.
//
// WHAT MUST SURVIVE (asserted so a later stage cannot widen it):
//   * county is a HARD filter — no expansion;
//   * sub-county is a PREFERENCE inside that county, never an expansion;
//   * tie-breaking stays deterministic (ascending id);
//   * the pre-N4 grandfathered agent (no contact_email) stays actionable;
//   * pending/suspended agents are never candidates, even with a verified email;
//   * no eligible candidate still means the manual queue, never an arbitrary agent.
// =============================================================================

/** A complete Agent, so the pure decision core is exercised without a database. */
function agent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    business_name: `Eligibility Hub ${overrides.id}`,
    contact_phone: '+254700000000',
    location_address: 'Test Hub Address',
    county: 'Nairobi City',
    administrative_unit_id: 'KE-47-SC-01',
    latitude: -1.2921,
    longitude: 36.8219,
    mpesa_till_or_paybill: '000123',
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-b3-eligibility',
    rating: 5,
    rating_count: 0,
    needs_manual_geocoding: false,
    email_verified_at: '2026-01-01T00:00:00.000Z',
    contact_email: `hub-${overrides.id}@example.com`,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Agent;
}

/** Dependency-injected matcher call: no database, no geocoder, no network. */
function matchWith(candidates: Agent[], county: string | null, unit: string | null = null) {
  return AgentMatchingService.assignNearestAgent(
    -1.2921,
    36.8219,
    '',
    county,
    unit,
    {
      getAgents: async () => candidates,
      forwardGeocode: async () => ({ latitude: null, longitude: null }),
    },
  );
}

describe('B3-1 — isAgentActionable() is the ONE candidate-eligibility authority', () => {
  it('selects an active, email-verified agent', async () => {
    const verified = agent({ id: 'B3-VERIFIED', status: 'active' });
    expect(isAgentActionable(verified)).toBe(true);

    const { scopedAgents } = scopeCandidateAgents([verified], 'Nairobi City');
    expect(scopedAgents.map((a) => a.id)).toEqual(['B3-VERIFIED']);

    const result = await matchWith([verified], 'Nairobi City');

    expect(result.agent?.id).toBe('B3-VERIFIED');
    expect(result.method).toBe('gps_haversine');
    expect(result.needsManualAgentReassignment).toBe(false);
  });

  it('EXCLUDES an active but EMAIL-UNVERIFIED agent from the candidate pool (G1 closed)', () => {
    const unverified = agent({
      id: 'B3-UNVERIFIED',
      status: 'active',
      contact_email: 'new-agent@example.com',
      email_verified_at: null,
    });

    expect(isAgentActionable(unverified)).toBe(false);

    const { activeAgents, scopedAgents } = scopeCandidateAgents([unverified], 'Nairobi City');

    // It is still `active` — which is precisely why a status-only filter was
    // not enough — but it is not in the pool that may receive work.
    expect(activeAgents.map((a) => a.id)).toEqual(['B3-UNVERIFIED']);
    expect(scopedAgents).toHaveLength(0);
  });

  it('never assigns an item to that agent, and leaves the item in the manual queue', async () => {
    const unverified = agent({
      id: 'B3-UNVERIFIED',
      status: 'active',
      contact_email: 'new-agent@example.com',
      email_verified_at: null,
    });

    const result = await matchWith([unverified], 'Nairobi City');

    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
    expect(result.confidence).toBe('manual');
    expect(result.needsManualAgentReassignment).toBe(true);
  });

  it('excludes it even when it is the only in-county agent and the verified agent is in another county', async () => {
    const unverifiedInCounty = agent({
      id: 'B3-UNVERIFIED-IN-COUNTY',
      status: 'active',
      contact_email: 'new-agent@example.com',
      email_verified_at: null,
    });
    const verifiedOtherCounty = agent({ id: 'B3-VERIFIED-OTHER', county: 'Mombasa' });

    const result = await matchWith([unverifiedInCounty, verifiedOtherCounty], 'Nairobi City');

    // Eligibility excludes the first, the hard county filter excludes the
    // second. The two rules compose without either widening the other.
    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
    expect(result.needsManualAgentReassignment).toBe(true);
  });

  it('agrees with isAgentActionable() for EVERY status / verification combination', async () => {
    const fixtures: Agent[] = [
      agent({ id: 'B3-M-ACTIVE-VERIFIED', status: 'active' }),
      agent({
        id: 'B3-M-ACTIVE-UNVERIFIED',
        status: 'active',
        contact_email: 'a@example.com',
        email_verified_at: null,
      }),
      agent({
        id: 'B3-M-ACTIVE-NOEMAIL',
        status: 'active',
        contact_email: null,
        email_verified_at: null,
      }),
      agent({ id: 'B3-M-PENDING', status: 'pending' }),
      // A suspended hub that HAS verified its email: status must still win.
      agent({ id: 'B3-M-SUSPENDED-VERIFIED', status: 'suspended' }),
      // Defensive: the column is free text, so an unrecognised status must also
      // fall outside the pool (only 'active' is ever actionable).
      { ...agent({ id: 'B3-M-UNKNOWN-STATUS' }), status: 'archive' } as unknown as Agent,
    ];

    for (const candidate of fixtures) {
      const expected = isAgentActionable(candidate);

      const { scopedAgents } = scopeCandidateAgents([candidate], 'Nairobi City');
      expect(scopedAgents.length, `${candidate.id} candidate-pool membership`).toBe(expected ? 1 : 0);

      const result = await matchWith([candidate], 'Nairobi City');
      expect(result.agent?.id ?? null, `${candidate.id} assignment`).toBe(expected ? candidate.id : null);
      expect(result.needsManualAgentReassignment, `${candidate.id} manual flag`).toBe(!expected);
    }
  });

  it('excludes a non-actionable agent when NO county is declared too', async () => {
    const unverified = agent({
      id: 'B3-UNVERIFIED-OPEN',
      status: 'active',
      contact_email: 'open@example.com',
      email_verified_at: null,
    });

    expect(scopeCandidateAgents([unverified], null).scopedAgents).toHaveLength(0);

    const result = await matchWith([unverified], null);
    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
    expect(result.needsManualAgentReassignment).toBe(true);
  });
});

describe('B3-1 — properties the unified rule must NOT widen', () => {
  it('keeps the pre-N4 grandfathered agent actionable and selectable (no contact_email)', async () => {
    const grandfathered = agent({
      id: 'B3-GRANDFATHERED',
      status: 'active',
      contact_email: null,
      email_verified_at: null,
    });

    expect(isAgentActionable(grandfathered)).toBe(true);
    const result = await matchWith([grandfathered], 'Nairobi City');
    expect(result.agent?.id).toBe('B3-GRANDFATHERED');
  });

  it('never treats a pending or suspended agent as a candidate', async () => {
    const pending = agent({ id: 'B3-PENDING', status: 'pending' });
    const suspended = agent({ id: 'B3-SUSPENDED', status: 'suspended' });

    expect(scopeCandidateAgents([pending, suspended], 'Nairobi City').scopedAgents).toHaveLength(0);
    const result = await matchWith([pending, suspended], 'Nairobi City');
    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
    expect(result.needsManualAgentReassignment).toBe(true);
  });

  it('never lets a NEARER ineligible agent beat a farther eligible one', async () => {
    // Eligibility is a precondition of candidacy, not a ranking signal: the
    // nearer hub is not "ranked lower", it is not in the pool at all.
    const nearerUnverified = agent({
      id: 'B3-NEARER-UNVERIFIED',
      status: 'active',
      contact_email: 'near@example.com',
      email_verified_at: null,
      latitude: -1.2922,
      longitude: 36.8219,
    });
    const fartherVerified = agent({
      id: 'B3-FARTHER-VERIFIED',
      status: 'active',
      latitude: -1.4000,
      longitude: 36.9000,
    });

    const result = await matchWith([nearerUnverified, fartherVerified], 'Nairobi City');

    expect(result.agent?.id).toBe('B3-FARTHER-VERIFIED');
    expect(result.needsManualAgentReassignment).toBe(false);
  });

  it('keeps the county as a HARD scope: a nearer agent in another county is not chosen', async () => {
    const otherCountyNearer = agent({
      id: 'B3-OTHER-COUNTY',
      county: 'Mombasa',
      latitude: -1.2922,
      longitude: 36.8219,
    });
    const sameCountyFarther = agent({
      id: 'B3-SAME-COUNTY',
      county: 'Nairobi City',
      latitude: -1.4000,
      longitude: 36.9000,
    });

    const result = await matchWith([otherCountyNearer, sameCountyFarther], 'Nairobi City');

    expect(result.agent?.id).toBe('B3-SAME-COUNTY');
    expect(result.evidence.declared_geography_present).toBe(true);
  });

  it('keeps sub-county as a PREFERENCE inside the county, not an expansion of it', async () => {
    const sameUnitFarther = agent({
      id: 'B3-SAME-UNIT',
      administrative_unit_id: 'KE-47-SC-01',
      latitude: -1.4000,
      longitude: 36.9000,
    });
    const otherUnitNearer = agent({
      id: 'B3-OTHER-UNIT',
      administrative_unit_id: 'KE-47-SC-02',
      latitude: -1.2922,
      longitude: 36.8219,
    });

    const result = await matchWith(
      [sameUnitFarther, otherUnitNearer],
      'Nairobi City',
      'KE-47-SC-01',
    );

    expect(result.agent?.id).toBe('B3-SAME-UNIT');
  });

  it('keeps tie-breaking deterministic: equal distance resolves to the lower agent id', async () => {
    const first = agent({ id: 'B3-TIE-A' });
    const second = agent({ id: 'B3-TIE-B' });

    expect((await matchWith([second, first], 'Nairobi City')).agent?.id).toBe('B3-TIE-A');
    expect((await matchWith([first, second], 'Nairobi City')).agent?.id).toBe('B3-TIE-A');
  });

  it('falls back to the manual queue — never to an arbitrary active agent', async () => {
    // Active and in-county, but with no usable coordinate pair.
    const noCoordinates = agent({ id: 'B3-NO-COORDS', latitude: null, longitude: null });

    const result = await matchWith([noCoordinates], 'Nairobi City');

    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
    expect(result.confidence).toBe('manual');
    expect(result.needsManualAgentReassignment).toBe(true);
  });
});

// =============================================================================
// B3-1 — THE AUTOMATIC TRIGGER USES THE SAME RULE.
//
// `matchPendingItemsForOperationalAgent` already re-checked the agent whose
// arrival triggered it, but the decision it acted on came from the MATCHER —
// which could pick a different, non-actionable hub. These tests run the REAL
// matcher through the REAL trigger with only the database boundary injected, so
// both gates are exercised together rather than separately.
// =============================================================================
describe('B3-1 — the agent-now-operational trigger never assigns to an ineligible agent', () => {
  /** Queued item: only the fields the trigger and the matcher actually read. */
  function queuedItem(id: string, county: string | null): FoundItem {
    return {
      id,
      latitude: -1.2921,
      longitude: 36.8219,
      location_description: 'Ngong Road',
      found_county: county,
      administrative_unit_id: 'KE-47-SC-01',
    } as unknown as FoundItem;
  }

  /**
   * The real trigger with the real matcher; only the storage boundary, the CAS
   * and the notification sink are injected — nothing about eligibility is faked.
   */
  function triggerHarness(agents: Agent[], queue: FoundItem[]) {
    const attempts: Array<{ itemId: string; agentId: string }> = [];
    const notified: Array<{ itemId: string; agentId: string; trigger: string }> = [];

    const deps = {
      getAgent: async (id: string) => agents.find((a) => a.id === id),
      getItemsAwaitingManualAgentAssignment: async () => queue,
      attemptAutoAgentAssignment: async (itemId: string, agentId: string) => {
        attempts.push({ itemId, agentId });
        return true;
      },
      matchAgent: (lat, lon, locationDescription, county, unit) =>
        AgentMatchingService.assignNearestAgent(lat, lon, locationDescription, county, unit, {
          getAgents: async () => agents,
          forwardGeocode: async () => ({ latitude: null, longitude: null }),
        }),
      notify: async (payload: { item: FoundItem; agent: Agent; trigger: string }) => {
        notified.push({
          itemId: payload.item.id,
          agentId: payload.agent.id,
          trigger: payload.trigger,
        });
      },
    } as unknown as AgentAutoAssignmentDeps;

    return { attempts, notified, deps };
  }

  it('assigns the queued item to the eligible hub, not the nearer ineligible one', async () => {
    const eligible = agent({ id: 'B3-TRIG-ELIGIBLE', status: 'active', latitude: -1.4, longitude: 36.9 });
    const nearerUnverified = agent({
      id: 'B3-TRIG-NEARER-UNVERIFIED',
      status: 'active',
      contact_email: 'near@example.com',
      email_verified_at: null,
      latitude: -1.2922,
      longitude: 36.8219,
    });

    const harness = triggerHarness([eligible, nearerUnverified], [queuedItem('B3-TRIG-ITEM-1', 'Nairobi City')]);
    const outcome = await matchPendingItemsForOperationalAgent('B3-TRIG-ELIGIBLE', harness.deps);

    expect(harness.attempts).toEqual([{ itemId: 'B3-TRIG-ITEM-1', agentId: 'B3-TRIG-ELIGIBLE' }]);
    expect(outcome.assigned.map((a) => a.agentId)).toEqual(['B3-TRIG-ELIGIBLE']);
    expect(harness.notified).toEqual([
      { itemId: 'B3-TRIG-ITEM-1', agentId: 'B3-TRIG-ELIGIBLE', trigger: 'agent_now_operational' },
    ]);
  });

  it('leaves the item queued when the only hub in its county is not actionable', async () => {
    // The triggering hub is eligible, but it serves ANOTHER county; the hub that
    // serves the item's county has not verified its email.
    const eligibleElsewhere = agent({ id: 'B3-TRIG-ELIGIBLE-ELSEWHERE', status: 'active' });
    const ineligibleInCounty = agent({
      id: 'B3-TRIG-INELIGIBLE-IN-COUNTY',
      status: 'active',
      county: 'Mombasa',
      contact_email: 'mombasa@example.com',
      email_verified_at: null,
    });

    const harness = triggerHarness(
      [eligibleElsewhere, ineligibleInCounty],
      [queuedItem('B3-TRIG-ITEM-2', 'Mombasa')],
    );
    const outcome = await matchPendingItemsForOperationalAgent('B3-TRIG-ELIGIBLE-ELSEWHERE', harness.deps);

    expect(harness.attempts).toEqual([]);
    expect(outcome.assigned).toEqual([]);
    expect(outcome.stillUnmatched).toBe(1);
    expect(harness.notified).toEqual([]);
  });

  it('does nothing at all when the TRIGGERING agent is not actionable', async () => {
    const unverified = agent({
      id: 'B3-TRIG-UNVERIFIED',
      status: 'active',
      contact_email: 'unverified@example.com',
      email_verified_at: null,
    });

    const harness = triggerHarness([unverified], [queuedItem('B3-TRIG-ITEM-3', 'Nairobi City')]);
    const outcome = await matchPendingItemsForOperationalAgent('B3-TRIG-UNVERIFIED', harness.deps);

    expect(outcome.evaluated).toBe(false);
    expect(harness.attempts).toEqual([]);
    expect(harness.notified).toEqual([]);
  });
});
