import { describe, expect, it } from 'vitest';
import { db, type Agent, type FoundItem } from '../db/database';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';
import { AgentMatchingService, scopeCandidateAgents } from '../services/agent';
import { assessAssignmentGeography, compareCounties } from '../services/agentGeography';
import { summariseStrandedItems } from '../services/agentStrandedItems';
import { getMaxAssignmentRadiusKm } from '../config/geoMatching';
import { administrativeUnitsForCounty } from '../config/kenyaAdministrativeUnits';
import { KENYA_COUNTIES, resolveCountyName } from '../config/kenyaCounties';
import { matchPendingItemsForOperationalAgent } from '../services/agentAutoAssignment';

// =============================================================================
// STAGE 3B-6E — GEOGRAPHIC REGRESSION TESTS (END TO END, ON REAL ROWS).
//
// The four stage suites each pin one mechanism in isolation. This one exercises
// the chain those mechanisms form, against the repository's real data layer and
// the real service functions, so a later edit cannot quietly break the JOINT
// behaviour while every unit test still passes:
//
//   6A correction  →  6C matching  : a hub whose county was missing becomes a
//                                    candidate for that county after an
//                                    administrator corrects it;
//   6A correction  →  matcher      : the post-correction matching pass assigns
//                                    only within the new county, never over an
//                                    existing holder, and never twice;
//   6B suspension  →  release      : a suspended hub's waiting items can be
//                                    returned to the queue, and its physically
//                                    received items cannot;
//   6D assessment  →  6A correction: an out-of-county warning disappears once the
//                                    hub's service geography is corrected, which
//                                    is the whole point of 6A;
//   plus the invariants this batch must NOT have changed: no distance threshold,
//   no county guessing, and 47 canonical counties that still resolve.
//
// LIMITATION: the in-memory harness does not model BEGIN/COMMIT/ROLLBACK, so these
// tests prove ORDER and OUTCOME, not transactional rollback. Real PostgreSQL
// transaction semantics were not exercised.
// =============================================================================

let counter = 0;
const RUN = `TEST-B6E-${testRunId}`;
const ADMIN = 'admin.b6e';

async function makeAgent(overrides: Partial<Record<string, unknown>> = {}): Promise<Agent> {
  const id = `${RUN}-AGENT-${counter++}`;
  await db.createAgent({
    id,
    business_name: `Regression Hub ${id}`,
    contact_phone: `+2547${testRunId}${counter}`,
    location_address: 'Ngong Road, Nairobi',
    county: 'Nairobi City',
    administrative_unit_id: 'KE-47-SC-01',
    latitude: -1.2921,
    longitude: 36.8219,
    mpesa_till_or_paybill: '000555',
    payout_method_type: 'Personal M-Pesa',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: `test-hash-${id}`,
    needs_manual_geocoding: false,
    contact_email: `regression-${id}@example.com`,
    ...overrides,
  } as any);
  if (overrides.email_verified_at !== null) {
    await db.verifyAgentEmail(id);
  }
  return (await db.getAgent(id))!;
}

async function makeItem(overrides: Partial<Record<string, unknown>> = {}): Promise<FoundItem> {
  const id = `${RUN}-ITEM-${counter++}`;
  await ensureTestCategory('phone');
  await db.createItem({
    id,
    category_id: 'phone',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Ngong Road',
    latitude: -1.2921,
    longitude: 36.8219,
    finder_phone: '+254700000096',
    finder_email: 'b6e-finder@example.com',
    found_county: 'Nairobi City',
    administrative_unit_id: 'KE-47-SC-01',
    location_source: 'user_selected',
    assigned_agent_id: null,
    status: 'awaiting_dropoff',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: 'Black phone',
    is_sensitive_document: false,
    rejection_reason: null,
    agent_assignment_method: 'manual_required',
    needs_manual_agent_reassignment: true,
    ...overrides,
  } as any);
  return (await db.getItem(id))!;
}

describe('B6-E — 6A + 6C: correcting a hub’s county makes it matchable', () => {
  it('a hub with no county is excluded, then included once corrected', async () => {
    const hub = await makeAgent({ county: null, administrative_unit_id: null });
    const before = scopeCandidateAgents(await db.getAgents(), 'Nairobi City').scopedAgents;
    expect(before.map(a => a.id)).not.toContain(hub.id);

    const corrected = await db.updateAgentServiceGeography(
      hub.id,
      { county: 'nairobi', administrativeUnitId: 'KE-47-SC-01' },
      ADMIN,
    );
    expect(corrected!.county).toBe('Nairobi City');

    const after = scopeCandidateAgents(await db.getAgents(), 'Nairobi City').scopedAgents;
    expect(after.map(a => a.id)).toContain(hub.id);
  });

  it('a stored alias counts as the same county for matching, without a correction', async () => {
    // Simulates a LEGACY row: the write path stores what it is given, so the
    // alias is introduced directly and only the comparison is exercised.
    const legacy = await makeAgent({ county: 'nairobi' });
    const { scopedAgents } = scopeCandidateAgents([legacy], 'Nairobi City');
    expect(scopedAgents.map(a => a.id)).toEqual([legacy.id]);
    expect(compareCounties(legacy.county, 'Nairobi City')).toBe('same');
  });

describe('B6-E — 6B: a suspended hub’s waiting items leave, its received items stay', () => {
  it('releases what can be released and preserves what the hub physically holds', async () => {
    const hub = await makeAgent();
    const waiting = await makeItem({ assigned_agent_id: hub.id });
    const received = await makeItem({ assigned_agent_id: hub.id, status: 'at_agent' });

    await db.suspendAgent(hub.id, ADMIN);
    const summary = summariseStrandedItems(await db.getItemsAssignedToAgent(hub.id), hub.id);

    const released: string[] = [];
    for (const target of summary.releasable) {
      await db.adminUnassignAgent(
        target.item_id,
        {
          method: 'manual_override',
          triggerSource: 'admin_manual',
          actorId: ADMIN,
          actorRole: 'admin',
          reason: 'Hub suspended; returning its waiting items to the assignment queue.',
        },
        hub.id,
      );
      released.push(target.item_id);
    }

    expect(released).toEqual([waiting.id]);

    const waitingAfter = await db.getItem(waiting.id);
    const receivedAfter = await db.getItem(received.id);
    expect(waitingAfter!.assigned_agent_id).toBeNull();
    expect(waitingAfter!.needs_manual_agent_reassignment).toBe(true);
    expect(receivedAfter!.assigned_agent_id).toBe(hub.id);
    expect(receivedAfter!.status).toBe('at_agent');
    // The hub itself is untouched by the release.
    expect((await db.getAgent(hub.id))!.status).toBe('suspended');
  });
});

describe('B6-E — 6D + 6A: the out-of-county warning is cleared by a correction', () => {
  it('warns while the hub serves another county, and stops once corrected', async () => {
    const hub = await makeAgent({ county: 'Mombasa', administrative_unit_id: 'KE-01-SC-01' });
    const item = await makeItem();

    const before = assessAssignmentGeography({
      itemCounty: item.found_county,
      itemAdministrativeUnitId: item.administrative_unit_id,
      agentCounty: hub.county,
      agentAdministrativeUnitId: hub.administrative_unit_id,
    });
    expect(before.county_match).toBe('different');
    expect(before.requires_acknowledgement).toBe(true);

    const corrected = await db.updateAgentServiceGeography(
      hub.id,
      { county: 'Nairobi City', administrativeUnitId: 'KE-47-SC-01' },
      ADMIN,
    );

    const after = assessAssignmentGeography({
      itemCounty: item.found_county,
      itemAdministrativeUnitId: item.administrative_unit_id,
      agentCounty: corrected!.county,
      agentAdministrativeUnitId: corrected!.administrative_unit_id,
    });
    expect(after.county_match).toBe('same');
    expect(after.requires_acknowledgement).toBe(false);
    expect(after.sub_county_match).toBe(true);
  });
});

describe('B6-E — the invariants this batch must not have changed', () => {
  it('still has NO maximum assignment radius configured', () => {
    // Stage 3B-6D asks for an acknowledgement; it never introduces a distance
    // limit, and this is the assertion that keeps it that way.
    expect(getMaxAssignmentRadiusKm()).toBeNull();
  });

  it('still resolves all 47 canonical counties, and guesses none', () => {
    expect(KENYA_COUNTIES).toHaveLength(47);
    for (const county of KENYA_COUNTIES) {
      expect(resolveCountyName(county.name), county.name).toBe(county.name);
    }
    expect(resolveCountyName('Kampala')).toBeNull();
  });

  it('still sends an item with no eligible hub in its county to the manual queue', async () => {
    const elsewhere = await makeAgent({ county: 'Mombasa', administrative_unit_id: 'KE-01-SC-01' });

    const result = await AgentMatchingService.assignNearestAgent(
      -1.2921,
      36.8219,
      'Ngong Road',
      'Nairobi City',
      'KE-47-SC-01',
      {
        getAgents: async () => [elsewhere],
        forwardGeocode: async () => ({ latitude: null, longitude: null }),
      } as any,
    );

    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
    expect(result.needsManualAgentReassignment).toBe(true);
    expect(result.confidence).toBe('manual');
  });
});

});

// =============================================================================
// STAGE 3B-6A §4 — THE POST-CORRECTION MATCHING PASS, END TO END.
//
// The route contract suite proves WHERE the trigger is called. This block proves
// WHAT it can and cannot change, against the real data layer: a hub that was not
// a candidate for a county becomes one after a correction, and the pass still
// cannot take an item another hub holds, cannot override an administrator's
// placement, cannot act for a non-operational hub, and cannot duplicate history.
//
// Each case uses a county no other case (and no other fixture in this file) puts
// a hub in, so "which hub won" is deterministic even though the matcher scans the
// whole manual queue.
// =============================================================================

const TURKANA_UNIT = administrativeUnitsForCounty('Turkana')[0].id;
const MANDERA_UNIT = administrativeUnitsForCounty('Mandera')[0].id;
const ISIOLO_UNIT = administrativeUnitsForCounty('Isiolo')[0].id;
const LAMU_UNIT = administrativeUnitsForCounty('Lamu')[0].id;

describe('B6-E — 6A §4: the correction re-runs the matcher, within the new county', () => {
  it('assigns a queued item only after the hub is corrected into that county', async () => {
    const hub = await makeAgent({ county: 'Mombasa', administrative_unit_id: 'KE-01-SC-01' });
    const queued = await makeItem({
      found_county: 'Turkana',
      administrative_unit_id: TURKANA_UNIT,
    });

    // Before the correction the hub serves another county, so the item stays put.
    const before = await matchPendingItemsForOperationalAgent(hub.id);
    expect(before.evaluated).toBe(true);
    expect(before.assigned.map(a => a.itemId)).not.toContain(queued.id);
    expect((await db.getItem(queued.id))!.assigned_agent_id).toBeNull();

    await db.updateAgentServiceGeography(
      hub.id,
      { county: 'Turkana', administrativeUnitId: TURKANA_UNIT },
      ADMIN,
    );

    const after = await matchPendingItemsForOperationalAgent(hub.id);
    expect(after.assigned.map(a => a.itemId)).toContain(queued.id);

    const stored = (await db.getItem(queued.id))!;
    expect(stored.assigned_agent_id).toBe(hub.id);
    expect(stored.needs_manual_agent_reassignment).toBe(false);
    // The matcher assigns; it does not move the item's lifecycle on.
    expect(stored.status).toBe('awaiting_dropoff');

    const history = await db.getItemAssignmentHistory(queued.id);
    expect(history).toHaveLength(1);
    expect(history[0].new_agent_id).toBe(hub.id);
    expect(history[0].previous_agent_id).toBeNull();
    expect(history[0].trigger_source).toBe('agent_now_operational');
    expect(history[0].actor_role).toBe('system');
  });

  it('never takes an item another hub holds, nor one an administrator placed', async () => {
    const holder = await makeAgent({ county: 'Mandera', administrative_unit_id: MANDERA_UNIT });
    const held = await makeItem({
      found_county: 'Mandera',
      administrative_unit_id: MANDERA_UNIT,
      assigned_agent_id: holder.id,
      needs_manual_agent_reassignment: false,
    });
    const placedByAdmin = await makeItem({
      found_county: 'Mandera',
      administrative_unit_id: MANDERA_UNIT,
    });
    await db.adminUpdateItem(
      placedByAdmin.id,
      {
        category_id: 'phone',
        ocr_extracted_number: null,
        ocr_extracted_name: null,
        document_number_hash: null,
        document_name_fuzzy: null,
        description: 'Black phone',
        isDescriptionOnly: false,
        flaggedForReview: false,
        assigned_agent_id: holder.id,
        agent_assignment_method: 'manual_override',
        needs_manual_agent_reassignment: false,
      } as any,
      {
        method: 'manual_override',
        triggerSource: 'admin_manual',
        actorId: ADMIN,
        actorRole: 'admin',
        reason: 'Administrator placed this item explicitly; the matcher must not move it.',
      },
    );

    const heldHistory = await db.getItemAssignmentHistory(held.id);
    const placedHistory = await db.getItemAssignmentHistory(placedByAdmin.id);

    const newcomer = await makeAgent({ county: 'Mandera', administrative_unit_id: MANDERA_UNIT });
    const outcome = await matchPendingItemsForOperationalAgent(newcomer.id);

    expect(outcome.assigned.map(a => a.itemId)).not.toContain(held.id);
    expect(outcome.assigned.map(a => a.itemId)).not.toContain(placedByAdmin.id);
    expect((await db.getItem(held.id))!.assigned_agent_id).toBe(holder.id);
    expect((await db.getItem(placedByAdmin.id))!.assigned_agent_id).toBe(holder.id);
    expect(await db.getItemAssignmentHistory(held.id)).toHaveLength(heldHistory.length);
    expect(await db.getItemAssignmentHistory(placedByAdmin.id)).toHaveLength(placedHistory.length);
  });

  it('a repeated correction records no duplicate assignment history', async () => {
    const hub = await makeAgent({ county: 'Mombasa', administrative_unit_id: 'KE-01-SC-01' });
    const queued = await makeItem({
      found_county: 'Isiolo',
      administrative_unit_id: ISIOLO_UNIT,
    });
    const geography = { county: 'Isiolo', administrativeUnitId: ISIOLO_UNIT };

    await db.updateAgentServiceGeography(hub.id, geography, ADMIN);
    await matchPendingItemsForOperationalAgent(hub.id);
    expect(await db.getItemAssignmentHistory(queued.id)).toHaveLength(1);

    // Correct it again — the same values, the same trigger, the same queue.
    await db.updateAgentServiceGeography(hub.id, geography, ADMIN);
    const second = await matchPendingItemsForOperationalAgent(hub.id);

    expect(second.assigned.map(a => a.itemId)).not.toContain(queued.id);
    expect((await db.getItem(queued.id))!.assigned_agent_id).toBe(hub.id);
    expect(await db.getItemAssignmentHistory(queued.id)).toHaveLength(1);
  });

  it('does not hand work to a hub that is not operational, even after a correction', async () => {
    const hub = await makeAgent({ county: 'Mombasa', administrative_unit_id: 'KE-01-SC-01' });
    await db.suspendAgent(hub.id, ADMIN);
    const queued = await makeItem({
      found_county: 'Lamu',
      administrative_unit_id: LAMU_UNIT,
    });

    // The correction itself is legitimate even for a suspended hub …
    await db.updateAgentServiceGeography(
      hub.id,
      { county: 'Lamu', administrativeUnitId: LAMU_UNIT },
      ADMIN,
    );

    // … but isAgentActionable() is the only authority on who may receive work.
    const outcome = await matchPendingItemsForOperationalAgent(hub.id);
    expect(outcome.evaluated).toBe(false);
    expect(outcome.assigned).toHaveLength(0);

    const stored = (await db.getItem(queued.id))!;
    expect(stored.assigned_agent_id).toBeNull();
    expect(stored.needs_manual_agent_reassignment).toBe(true);
    expect(stored.agent_assignment_method).toBe('manual_required');
  });
});
