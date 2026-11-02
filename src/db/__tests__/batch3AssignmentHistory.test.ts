import { describe, it, expect } from 'vitest';
import { db, type Agent, type FoundItem } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// =============================================================================
// PHASE 16.1 BATCH 3 — STAGE 3B-2: THE APPEND-ONLY ASSIGNMENT HISTORY.
//
// `items.assigned_agent_id` answers "who holds this item now". Before this stage
// nothing structured answered "who held it before, who moved it, how, why, and
// when" — the manual route wrote free text into audit_log and the two automatic
// paths recorded no previous holder at all. `item_agent_assignments` is that
// record, and this file pins the properties that make it trustworthy:
//
//   1. ONE EVENT PER MUTATION THAT ACTUALLY COMMITTED. A successful automatic
//      assignment, a successful manual assignment and a report-time match each
//      write exactly one event; a losing CAS, a refused call, a no-op re-save and
//      an unassignment write none.
//   2. ATTRIBUTION IS REAL. previous/new holder, method, trigger/source, actor,
//      actor role, reason and distance are the values that were actually used —
//      never defaults invented to fill a column.
//   3. APPEND-ONLY. Later assignments add rows; earlier rows are never rewritten.
//   4. THE EVENT AND THE MUTATION SHARE ONE TRANSACTION (see the last describe,
//      which also states the one property the in-memory harness cannot model).
//
// The three production paths this exercises are the complete set that writes
// `items.assigned_agent_id`:
//   * db.createItem()               — a report-time match (trigger finder_report)
//   * db.attemptAutoAgentAssignment() — the guarded CAS (agent_now_operational)
//   * db.adminUpdateItem()          — an administrator's decision (admin_manual)
// =============================================================================

const RUN = `B3H-${testRunId}`;
let counter = 0;

/** An agent created through the real writer, so NOT NULL/default rules apply. */
async function makeAgent(overrides: Record<string, unknown> = {}): Promise<Agent> {
  const id = `${RUN}-AGENT-${counter++}`;
  await db.createAgent({
    id,
    business_name: `History Hub ${id}`,
    contact_phone: `+254${testRunId}${counter}`,
    location_address: 'Ngong Road, Nairobi',
    county: 'Nairobi City',
    administrative_unit_id: 'KE-47-SC-01',
    latitude: -1.2921,
    longitude: 36.8219,
    mpesa_till_or_paybill: '000123',
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-b3-history',
    needs_manual_geocoding: false,
    contact_email: `hub-${id}@example.com`,
    ...overrides,
  } as any);
  return (await db.getAgent(id))!;
}

/**
 * An item created through the real writer. Defaults to an UNASSIGNED item in the
 * manual queue, i.e. exactly what the automatic CAS is allowed to claim.
 */
async function makeItem(overrides: Record<string, unknown> = {}): Promise<FoundItem> {
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
    finder_phone: '+254700000081',
    found_county: 'Nairobi City',
    administrative_unit_id: 'KE-47-SC-01',
    location_source: 'user_selected',
    assigned_agent_id: null,
    status: 'awaiting_dropoff',
    flaggedForReview: true,
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

/** The admin review route's exact write, including the attribution it now supplies. */
async function adminAssign(
  itemId: string,
  agentId: string | null,
  reason: string = 'An administrator re-pointed this item.',
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.adminUpdateItem(
    itemId,
    {
      category_id: 'phone',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      description: 'Black phone',
      isDescriptionOnly: false,
      flaggedForReview: false,
      assigned_agent_id: agentId,
      agent_assignment_method: 'manual_override',
      needs_manual_agent_reassignment: false,
      agent_assignment_distance_km: null,
      ...extra,
    } as any,
    {
      method: 'manual_override',
      triggerSource: 'admin_manual',
      actorId: 'ADMIN-B3-2',
      actorRole: 'admin',
      reason,
    },
  );
}

/** The ONLY reader of the history table, and its chronological-order contract. */
const historyOf = (itemId: string) => db.getItemAssignmentHistory(itemId);

// =============================================================================
// 1. REPORT-TIME ASSIGNMENT — THE THIRD PATH (createItem).
//
// An item the finder's report matched is assigned BY THE INSERT, so this is the
// only way its first assignment can ever be recorded.
// =============================================================================
describe('B3-2 — a report-time match is recorded at creation', () => {
  it('writes one event with trigger finder_report and no actor', async () => {
    const agent = await makeAgent();
    const item = await makeItem({
      assigned_agent_id: agent.id,
      agent_assignment_method: 'gps_haversine',
      agent_assignment_distance_km: 1.75,
      needs_manual_agent_reassignment: false,
    });

    const events = await historyOf(item.id);
    expect(events).toHaveLength(1);
    expect(events[0].previous_agent_id).toBeNull();
    expect(events[0].new_agent_id).toBe(agent.id);
    expect(events[0].event_type).toBe('assigned');
    expect(events[0].assignment_method).toBe('gps_haversine');
    expect(events[0].trigger_source).toBe('finder_report');
    expect(events[0].actor_id).toBeNull();
    expect(events[0].actor_role).toBe('system');
    expect(events[0].reason).toBeNull();
    expect(events[0].distance_km).toBe('1.75');
  });

  it('writes no event when the report matched no agent', async () => {
    const item = await makeItem();
    expect(await historyOf(item.id)).toHaveLength(0);
  });

  it('writes no event for an item created with a holder but no recorded method', async () => {
    // A row that is assigned without saying HOW cannot be described truthfully,
    // so it is left unrecorded rather than recorded with a guessed method. Every
    // production caller supplies one (routes/finderReport.ts passes
    // matchingResult.method); this is the pre-existing fixture inconsistency.
    const agent = await makeAgent();
    const item = await makeItem({
      assigned_agent_id: agent.id,
      agent_assignment_method: undefined,
    });

    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agent.id);
    expect(await historyOf(item.id)).toHaveLength(0);
  });
});

// =============================================================================
// 2. ADMINISTRATOR ASSIGNMENT AND REASSIGNMENT.
// =============================================================================
describe('B3-2 — an administrator decision is recorded with its attribution', () => {
  it('records a first manual assignment: actor, role, trigger, method and reason', async () => {
    const agent = await makeAgent();
    const item = await makeItem();

    await adminAssign(item.id, agent.id, 'Nearest hub agreed to receive the item.');

    const events = await historyOf(item.id);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.previous_agent_id).toBeNull();
    expect(event.new_agent_id).toBe(agent.id);
    expect(event.event_type).toBe('assigned');
    expect(event.assignment_method).toBe('manual_override');
    expect(event.trigger_source).toBe('admin_manual');
    expect(event.actor_id).toBe('ADMIN-B3-2');
    expect(event.actor_role).toBe('admin');
    // The administrator's own words, verbatim — never a synthesized reason.
    expect(event.reason).toBe('Nearest hub agreed to receive the item.');
    // A manual decision has no measured distance.
    expect(event.distance_km).toBeNull();
  });

  it('records a reassignment with BOTH holders, and leaves the earlier event intact', async () => {
    const agentA = await makeAgent();
    const agentB = await makeAgent();
    const item = await makeItem();

    // 1st: the automatic path puts the item at A.
    expect(await db.attemptAutoAgentAssignment(item.id, agentA.id, 'gps_haversine', 4)).toBe(true);
    // 2nd: an administrator moves it to B.
    await adminAssign(item.id, agentB.id, 'Hub A is closing for the holiday.');

    const events = await historyOf(item.id);
    expect(events).toHaveLength(2);

    // Nothing about the first event changed — history was appended, not edited.
    expect(events[0].new_agent_id).toBe(agentA.id);
    expect(events[0].previous_agent_id).toBeNull();
    expect(events[0].trigger_source).toBe('agent_now_operational');
    expect(events[0].reason).toBeNull();

    expect(events[1].previous_agent_id).toBe(agentA.id);
    expect(events[1].new_agent_id).toBe(agentB.id);
    expect(events[1].event_type).toBe('reassigned');
    expect(events[1].trigger_source).toBe('admin_manual');
    expect(events[1].actor_id).toBe('ADMIN-B3-2');
    expect(events[1].reason).toBe('Hub A is closing for the holiday.');

    // Distinct events, distinct ids, non-decreasing timestamps: chronological.
    expect(events[0].id).not.toBe(events[1].id);
    expect(Date.parse(events[0].created_at)).toBeLessThanOrEqual(Date.parse(events[1].created_at));

    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agentB.id);
  });
});


// =============================================================================
// 3. FIRST ASSIGNMENT — THE AUTOMATIC CAS.
// =============================================================================
describe('B3-2 — a successful automatic assignment records exactly one event', () => {
  it('stores the new holder, the method, the trigger and the distance, with no predecessor', async () => {
    const agent = await makeAgent();
    const item = await makeItem();

    expect(await db.attemptAutoAgentAssignment(item.id, agent.id, 'gps_haversine', 2.5)).toBe(true);

    const events = await historyOf(item.id);
    expect(events).toHaveLength(1);

    const [event] = events;
    expect(event.item_id).toBe(item.id);
    // FIRST assignment: nothing was replaced, so the previous holder is NULL —
    // not the empty string, and not the new agent repeated.
    expect(event.previous_agent_id).toBeNull();
    expect(event.new_agent_id).toBe(agent.id);
    expect(event.event_type).toBe('assigned');
    // The same method string the item row now carries.
    expect(event.assignment_method).toBe('gps_haversine');
    expect((await db.getItem(item.id))!.agent_assignment_method).toBe(event.assignment_method);
    // The trigger is the one this primitive's only production caller uses, and
    // the same string that caller gives the notification service.
    expect(event.trigger_source).toBe('agent_now_operational');
    // No human actor, so no actor and no invented reason.
    expect(event.actor_id).toBeNull();
    expect(event.actor_role).toBe('system');
    expect(event.reason).toBeNull();
    // Distance evidence was available, so it is present.
    expect(event.distance_km).toBe('2.5');
    expect(Number.isNaN(Date.parse(event.created_at))).toBe(false);
  });

  it('stores a null distance when the matcher measured none — it never invents one', async () => {
    const agent = await makeAgent();
    const item = await makeItem();

    expect(await db.attemptAutoAgentAssignment(item.id, agent.id, 'geocoded_text', null)).toBe(true);

    const [event] = await historyOf(item.id);
    expect(event.assignment_method).toBe('geocoded_text');
    expect(event.distance_km).toBeNull();
  });
});

// =============================================================================
// 5. A REFUSED ADMINISTRATOR ASSIGNMENT WRITES NOTHING AT ALL.
// =============================================================================
describe('B3-2 — a refused administrator assignment changes nothing', () => {
  /** The route's write, minus the attribution the route now always supplies. */
  const unattributed = (itemId: string, agentId: string) => ({
    category_id: 'phone',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    description: 'Black phone',
    isDescriptionOnly: false,
    flaggedForReview: false,
    assigned_agent_id: agentId,
    agent_assignment_method: 'manual_override',
    needs_manual_agent_reassignment: false,
  });

  it('refuses an assignment with no attribution, leaving the item exactly as it was', async () => {
    const agent = await makeAgent();
    const item = await makeItem();

    await expect(
      db.adminUpdateItem(item.id, unattributed(item.id, agent.id) as any),
    ).rejects.toThrow(/requires an ItemAssignmentEventContext/);

    const after = (await db.getItem(item.id))!;
    // Not even the OTHER fields were written: the refusal happens before any
    // statement is issued.
    expect(after.assigned_agent_id).toBeNull();
    expect(after.needs_manual_agent_reassignment).toBe(true);
    expect(after.flaggedForReview).toBe(true);
    expect(await historyOf(item.id)).toHaveLength(0);
  });

  it('refuses a column method that disagrees with the attribution', async () => {
    const agent = await makeAgent();
    const item = await makeItem();

    await expect(
      db.adminUpdateItem(
        item.id,
        // The COLUMN would say 'gps_haversine' while the event says
        // 'manual_override'. One of them must be wrong, so neither is written.
        { ...unattributed(item.id, agent.id), agent_assignment_method: 'gps_haversine' } as any,
        {
          method: 'manual_override',
          triggerSource: 'admin_manual',
          actorId: 'ADMIN-B3-2',
          actorRole: 'admin',
          reason: 'Mismatched method.',
        },
      ),
    ).rejects.toThrow(/disagree/);

    expect((await db.getItem(item.id))!.assigned_agent_id).toBeNull();
    expect(await historyOf(item.id)).toHaveLength(0);
  });

  it('refuses an assignment to an item that does not exist, instead of recording a phantom', async () => {
    const agent = await makeAgent();
    const missingId = `${RUN}-MISSING-${counter++}`;

    await expect(
      db.adminUpdateItem(
        missingId,
        unattributed(missingId, agent.id) as any,
        {
          method: 'manual_override',
          triggerSource: 'admin_manual',
          actorId: 'ADMIN-B3-2',
          actorRole: 'admin',
          reason: 'Assigning an item that is not there.',
        },
      ),
    ).rejects.toThrow(/Failed to update item by admin|does not exist/);

    expect(await historyOf(missingId)).toHaveLength(0);
  });

  it('does not record a re-save that keeps the SAME holder', async () => {
    const agent = await makeAgent();
    const item = await makeItem();

    // A real first assignment (one event)...
    await adminAssign(item.id, agent.id, 'Assigned to the nearest hub.');
    expect(await historyOf(item.id)).toHaveLength(1);

    // ...then the SAME holder saved again through the review form.
    await adminAssign(item.id, agent.id, 'Saving the review form again.');

    // The write happened, but the HOLDER never moved, so no second event: a
    // re-save is not a reassignment.
    const events = await historyOf(item.id);
    expect(events).toHaveLength(1);
    expect(events[0].new_agent_id).toBe(agent.id);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agent.id);
  });

  it('STAGE 3B-3 - REFUSES to clear the holder through this method, so no holder can change unseen', async () => {
    const agent = await makeAgent();
    const item = await makeItem();

    await adminAssign(item.id, agent.id, 'Assigned to the nearest hub.');
    expect(await historyOf(item.id)).toHaveLength(1);

    // STAGE 3B-3: a removal must go through adminUnassignAgent(), which records
    // the `unassigned` event in the same transaction. This method REFUSES the
    // call, so the item is left exactly as it was.
    await expect(
      adminAssign(item.id, null, 'Returned to the queue.', {
        needs_manual_agent_reassignment: true,
      }),
    ).rejects.toThrow(/unassignment/i);

    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agent.id);
    const events = await historyOf(item.id);
    expect(events).toHaveLength(1);
    expect(events[0].new_agent_id).toBe(agent.id);
    expect((await db.getItem(item.id))!.needs_manual_agent_reassignment).toBe(false);
  });
});
// =============================================================================
// 6. REFUSED AND LOSING AUTOMATIC ATTEMPTS RECORD NOTHING.
// =============================================================================
describe('B3-2 — an automatic assignment that did not happen leaves no event', () => {
  it('a failed CAS on an already-assigned item writes no event', async () => {
    const existing = await makeAgent();
    const challenger = await makeAgent();
    const item = await makeItem({ assigned_agent_id: existing.id });

    expect(await db.attemptAutoAgentAssignment(item.id, challenger.id, 'gps_haversine', 1)).toBe(false);

    expect(await historyOf(item.id)).toHaveLength(0);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(existing.id);
  });

  it('an item that is not in the manual queue writes no event', async () => {
    const agent = await makeAgent();
    const item = await makeItem({ needs_manual_agent_reassignment: false });

    expect(await db.attemptAutoAgentAssignment(item.id, agent.id, 'gps_haversine', 1)).toBe(false);

    expect(await historyOf(item.id)).toHaveLength(0);
  });

  it('an item whose custody state moved on writes no event', async () => {
    const agent = await makeAgent();
    const item = await makeItem({ status: 'at_agent' });

    expect(await db.attemptAutoAgentAssignment(item.id, agent.id, 'gps_haversine', 1)).toBe(false);

    expect(await historyOf(item.id)).toHaveLength(0);
  });

  it('five simultaneous attempts produce ONE event, naming the one winner', async () => {
    const agents = [await makeAgent(), await makeAgent(), await makeAgent(), await makeAgent(), await makeAgent()];
    const item = await makeItem();

    const results = await Promise.all(
      agents.map((agent) => db.attemptAutoAgentAssignment(item.id, agent.id, 'gps_haversine', 3)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const winners = agents.filter((_, index) => results[index]);
    expect(winners).toHaveLength(1);

    const events = await historyOf(item.id);
    // The four losers recorded nothing at all: no event, no second holder.
    expect(events).toHaveLength(1);
    expect(events[0].new_agent_id).toBe(winners[0].id);
    expect(events[0].previous_agent_id).toBeNull();
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(winners[0].id);
  });
});

// =============================================================================
// 7. ATOMICITY — NO EVENT WITHOUT ITS MUTATION, AND NO SILENTLY LOST WRITE.
//
// Each assignment path runs its item write and its event insert on ONE
// transaction handle (asserted structurally in
// batch3AssignmentHistorySchema.test.ts, because a source check is the only way
// to prove which statements share a handle). The test below pins the part that
// IS observable here: a history-write failure is never swallowed.
// =============================================================================
describe('B3-2 — a failed history write surfaces to the caller', () => {
  it('propagates the failure instead of silently committing an untraceable assignment', async () => {
    const agent = await makeAgent();
    const item = await makeItem();

    const instance = db as any;
    const original = instance.insertItemAssignmentEventInTx;
    instance.insertItemAssignmentEventInTx = async () => {
      throw new Error('simulated history write failure');
    };

    try {
      await expect(
        db.attemptAutoAgentAssignment(item.id, agent.id, 'gps_haversine', 1),
      ).rejects.toThrow(/Failed to auto-assign/);
    } finally {
      instance.insertItemAssignmentEventInTx = original;
    }

    // The caller is told, and no event exists for the attempt: nothing was
    // reported as successful that could not be recorded.
    expect(await historyOf(item.id)).toHaveLength(0);

    // HARNESS LIMITATION — STATED, NOT HIDDEN. The in-memory double strips
    // BEGIN/COMMIT/ROLLBACK (see executeMockQuery), so it cannot undo the UPDATE
    // that already ran inside the aborted transaction. On PostgreSQL that abort
    // rolls the UPDATE back and the item stays unassigned, which is the whole
    // point of sharing a transaction. This assertion therefore documents the
    // double's divergence instead of claiming rollback was proven here.
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agent.id);
  });
});
