import { describe, it, expect, vi } from 'vitest';
import { db, type Agent, type FoundItem, ItemAssignmentRefusedError } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';
import {
  ITEM_ASSIGNABLE_STATUSES,
  describeManualAssignmentRefusal,
  describeManualUnassignmentRefusal,
  isItemAssignableStatus,
} from '../../config/itemAgentAssignmentPolicy';

// =============================================================================
// PHASE 16.1 BATCH 3 — STAGE 3B-3 CHECKPOINTS 1 + 2:
// MANUAL-ASSIGNMENT CUSTODY PROTECTION AND SAFE UNASSIGNMENT.
//
// CHECKPOINT 1 — CUSTODY
//   * an item that has not been physically received can be assigned/reassigned;
//   * an item already received by a hub (`at_agent`) cannot be reassigned;
//   * a claimed item cannot be reassigned;
//   * EVERY other status fails closed, including ones added later
//     (`suspected_stolen`, `legal_hold`), because the policy is an allow-list;
//   * a refused attempt leaves the item, the history and the audit trail
//     completely untouched.
//
// CHECKPOINT 2 — HISTORY INTEGRITY AND UNASSIGNMENT
//   * an unassignment records the PREVIOUS agent, a NULL incoming agent, the
//     `unassigned` event type, the administrator, the reason and the trigger;
//   * the item's lifecycle/custody status is preserved, and the item returns to
//     the manual queue with its stale routing evidence cleared;
//   * a reason is mandatory, and a refused reason changes nothing;
//   * a stale removal (the holder changed since the administrator looked) is
//     REFUSED, so an unassignment cannot erase a newer assignment;
//   * two concurrent removals produce exactly ONE event;
//   * a same-agent re-save produces NO reassignment event.
//
// THE ONE THING THIS HARNESS CANNOT SHOW, AND DOES NOT CLAIM: the in-memory
// double strips BEGIN/COMMIT/ROLLBACK, so "the item write and its event roll back
// together" is demonstrated by (a) the write and the event being issued on the
// same transaction handle — asserted statically in
// batch3AssignmentHistorySchema.test.ts — and (b) every refusal being raised
// BEFORE the first write. Real PostgreSQL transaction semantics were NOT
// exercised here.
//
// H-1 (POST-AUDIT CORRECTION) NARROWS THAT LIMITATION FOR THE AUDIT ROW. Both
// manual audit lines are now written with logAuditInTx(tx, ...) on the
// mutation's own transaction handle and BEFORE the mutation is issued, so an
// audit-write failure is observable HERE: when the audit insert fails, nothing
// has been written yet. The H-1 block at the end of this file exercises exactly
// that, for the assignment and for the removal.
//
// H-2 (POST-AUDIT CORRECTION) makes an explicitly observed `null` holder a
// CONSTRAINT rather than "no opinion": a removal decided against a holder-less
// item is refused (409 holder_changed) if an agent was assigned in the
// meantime, instead of silently erasing that newer assignment.
// =============================================================================

let counter = 0;
const RUN = `TEST-B3-3-${testRunId}`;

async function makeAgent(overrides: Partial<Record<string, unknown>> = {}): Promise<Agent> {
  const id = `${RUN}-AGENT-${counter++}`;
  await db.createAgent({
    id,
    business_name: `Custody Hub ${id}`,
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
    national_id_hash: 'test-hash-b3-3-custody',
    needs_manual_geocoding: false,
    contact_email: `hub-${id}@example.com`,
    ...overrides,
  } as any);
  return (await db.getAgent(id))!;
}

/** An agent that really passes isAgentActionable() (email verified via the real writer). */
async function makeActionableAgent(): Promise<Agent> {
  const created = await makeAgent();
  await db.verifyAgentEmail(created.id);
  return (await db.getAgent(created.id))!;
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
    finder_phone: '+254700000094',
    finder_email: 'b3-3-finder@example.com',
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


/** The exact write the admin review route performs for an assignment. */
async function adminAssign(
  itemId: string,
  agentId: string,
  reason = 'Nearest hub is closed; routing to the next hub in the same county.',
) {
  return db.adminUpdateItem(
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
    } as any,
    {
      method: 'manual_override',
      triggerSource: 'admin_manual',
      actorId: 'B3-3-ADMIN',
      actorRole: 'admin',
      reason,
    },
  );
}

/**
 * The exact write the new unassign route performs.
 *
 * `expectedPreviousAgentId` defaults to `undefined` — "the caller has no
 * expectation" — and NOT to `null`: since H-2 an explicit `null` means "the
 * caller LOOKED and saw nobody", which is a constraint, not the absence of one.
 * A test that wants the route's real behaviour passes the holder it read.
 */
async function adminUnassign(
  itemId: string,
  reason = 'Hub closed for the week; returning the item to the assignment queue.',
  expectedPreviousAgentId: string | null | undefined = undefined,
) {
  return db.adminUnassignAgent(
    itemId,
    {
      method: 'manual_override',
      triggerSource: 'admin_manual',
      actorId: 'B3-3-ADMIN',
      actorRole: 'admin',
      reason,
    },
    expectedPreviousAgentId,
  );
}

describe('3B-3 checkpoint 1 - the custody policy itself', () => {
  it('allows exactly one status, and fails CLOSED for every other value', () => {
    expect(ITEM_ASSIGNABLE_STATUSES).toEqual(['awaiting_dropoff']);
    expect(isItemAssignableStatus('awaiting_dropoff')).toBe(true);

    for (const status of [
      'at_agent',
      'claimed',
      'expired',
      'rejected',
      'suspected_stolen',
      'legal_hold',
      // A status that does not exist yet must also be refused: that is the whole
      // point of an allow-list.
      'some_future_status',
      undefined,
      null,
      '',
    ]) {
      expect(isItemAssignableStatus(status), String(status)).toBe(false);
      expect(describeManualAssignmentRefusal(status), String(status)).toBeTruthy();
      expect(describeManualUnassignmentRefusal(status), String(status)).toBeTruthy();
    }
  });

  it('names the physical-custody reason for at_agent, and the claimed state for claimed', () => {
    expect(describeManualAssignmentRefusal('at_agent')).toMatch(/received by an agent hub/i);
    expect(describeManualAssignmentRefusal('claimed')).toMatch(/already been claimed/i);
    expect(describeManualUnassignmentRefusal('at_agent')).toMatch(/physically held/i);
    expect(describeManualUnassignmentRefusal('claimed')).toMatch(/already been claimed/i);
  });
});

describe('3B-3 checkpoint 1 - before physical custody, assignment and reassignment work', () => {
  it('assigns an awaiting_dropoff item and records the assignment event', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem();

    const outcome = await adminAssign(item.id, agent.id);
    expect(outcome?.eventType).toBe('assigned');
    expect(outcome?.previousAgentId).toBeNull();
    expect(outcome?.newAgentId).toBe(agent.id);

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id).toBe(agent.id);
    expect(after.needs_manual_agent_reassignment).toBe(false);
    expect(after.status).toBe('awaiting_dropoff');

    const events = await db.getItemAssignmentHistory(item.id);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('assigned');
    expect(events[0].new_agent_id).toBe(agent.id);
  });

  it('reassigns an awaiting_dropoff item, recording the real previous holder', async () => {
    const agentA = await makeActionableAgent();
    const agentB = await makeActionableAgent();
    const item = await makeItem();

    await adminAssign(item.id, agentA.id);
    const outcome = await adminAssign(item.id, agentB.id, 'Hub A is at capacity; moving to Hub B.');

    expect(outcome?.eventType).toBe('reassigned');
    expect(outcome?.previousAgentId).toBe(agentA.id);
    expect(outcome?.newAgentId).toBe(agentB.id);

    const events = await db.getItemAssignmentHistory(item.id);
    expect(events).toHaveLength(2);
    expect(events[1].event_type).toBe('reassigned');
    expect(events[1].previous_agent_id).toBe(agentA.id);
    expect(events[1].new_agent_id).toBe(agentB.id);
    expect(events[1].reason).toContain('Hub A is at capacity');
  });
});

describe('3B-3 checkpoint 1 - physical custody blocks every assignment change', () => {
  for (const status of ['at_agent', 'claimed', 'expired', 'rejected', 'suspected_stolen', 'legal_hold']) {
    it(`refuses to reassign an item in status ${status}, and changes nothing at all`, async () => {
      const agentA = await makeActionableAgent();
      const agentB = await makeActionableAgent();
      const item = await makeItem({
        status,
        assigned_agent_id: agentA.id,
        agent_assignment_method: 'gps_haversine',
        needs_manual_agent_reassignment: false,
      });
      const historyBefore = await db.getItemAssignmentHistory(item.id);

      await expect(adminAssign(item.id, agentB.id)).rejects.toThrow();

      const after = (await db.getItem(item.id))!;
      expect(after.assigned_agent_id, 'holder must not move').toBe(agentA.id);
      expect(after.status, 'custody/lifecycle must not change').toBe(status);
      expect(after.agent_assignment_method).toBe('gps_haversine');

      // No history event for a refused mutation.
      expect((await db.getItemAssignmentHistory(item.id)).length).toBe(historyBefore.length);

      // No assignment audit line either: the audit is written only after the
      // transaction that refused.
      const all = await db.getAuditLogs();
      const forItem = all.filter((row) => row.details.includes(item.id));
      expect(forItem.some((row) => row.action === 'MANUAL_AGENT_ASSIGNMENT')).toBe(false);
    });
  }

  it('refuses to assign an item that is already at a hub even when it has NO holder', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem({ status: 'at_agent', assigned_agent_id: null });

    await expect(adminAssign(item.id, agent.id)).rejects.toThrow(/received by an agent hub/i);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBeNull();
  });
});

describe('3B-3 checkpoint 2 - unassignment records a complete, honest event', () => {
  it('records previous agent, NULL incoming agent, event type, actor, reason and trigger', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem();
    await adminAssign(item.id, agent.id);

    const outcome = await adminUnassign(item.id, 'Hub closed for the week; queueing the item again.');

    expect(outcome.eventType).toBe('unassigned');
    expect(outcome.previousAgentId).toBe(agent.id);
    expect(outcome.newAgentId).toBeNull();
    expect(outcome.eventId).toMatch(/^ASG-/);

    const events = await db.getItemAssignmentHistory(item.id);
    expect(events).toHaveLength(2);
    const unassigned = events[1];
    expect(unassigned.event_type).toBe('unassigned');
    expect(unassigned.previous_agent_id).toBe(agent.id);
    expect(unassigned.new_agent_id).toBeNull();
    expect(unassigned.actor_id).toBe('B3-3-ADMIN');
    expect(unassigned.actor_role).toBe('admin');
    expect(unassigned.trigger_source).toBe('admin_manual');
    expect(unassigned.assignment_method).toBe('manual_override');
    expect(unassigned.reason).toContain('Hub closed for the week');
    // No distance evidence is invented for a manual decision.
    expect(unassigned.distance_km).toBeNull();
  });

  it('preserves the item lifecycle, returns it to the queue and clears stale routing evidence', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem();
    await adminAssign(item.id, agent.id);

    await adminUnassign(item.id);

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id).toBeNull();
    // Lifecycle/custody untouched: this operation moves responsibility, not goods.
    expect(after.status).toBe('awaiting_dropoff');
    // Back in the manual queue, with no stale method/distance claiming otherwise.
    expect(after.needs_manual_agent_reassignment).toBe(true);
    expect(after.agent_assignment_method).toBe('manual_required');
    expect(after.agent_assignment_distance_km).toBeNull();
  });

  it('writes an audit line that names the removal, the agent and the reason', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem();
    await adminAssign(item.id, agent.id);

    await adminUnassign(item.id, 'Agent asked to be removed from this route.');

    const all = await db.getAuditLogs();
    const removal = all.find(
      (row) => row.action === 'MANUAL_AGENT_UNASSIGNMENT' && row.details.includes(item.id),
    );
    expect(removal).toBeTruthy();
    expect(removal!.details).toContain(agent.id);
    expect(removal!.details).toContain('B3-3-ADMIN');
    expect(removal!.details).toContain('Agent asked to be removed');
  });
});


describe('3B-3 checkpoint 2 - unassignment is refused where it must be', () => {
  it('requires a reason, and changes nothing without one', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem();
    await adminAssign(item.id, agent.id);

    await expect(adminUnassign(item.id, '   ')).rejects.toThrow(/reason/i);

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id).toBe(agent.id);
    expect(await db.getItemAssignmentHistory(item.id)).toHaveLength(1);
  });

  it('refuses to remove a holder from an item that is already at a hub', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem({ status: 'at_agent', assigned_agent_id: agent.id });

    await expect(adminUnassign(item.id)).rejects.toThrow(/physically held/i);

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id, 'the physical custodian must never be erased').toBe(agent.id);
    expect(after.status).toBe('at_agent');
    expect(await db.getItemAssignmentHistory(item.id)).toHaveLength(0);
  });

  it('refuses to remove a holder from a claimed item', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem({ status: 'claimed', assigned_agent_id: agent.id });

    await expect(adminUnassign(item.id)).rejects.toThrow(/already been claimed/i);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agent.id);
  });

  it('refuses when the item has no holder at all, and records no event', async () => {
    const item = await makeItem({ assigned_agent_id: null });

    await expect(adminUnassign(item.id)).rejects.toThrow(/nothing to remove/i);
    expect(await db.getItemAssignmentHistory(item.id)).toHaveLength(0);
  });

  it('refuses for an item that does not exist', async () => {
    await expect(adminUnassign(`${RUN}-MISSING-ITEM`)).rejects.toThrow(/does not exist/i);
  });
});

describe('3B-3 checkpoint 2 - concurrency and stale decisions', () => {
  it('cannot erase a NEWER assignment: a stale removal is refused', async () => {
    const agentA = await makeActionableAgent();
    const agentB = await makeActionableAgent();
    const item = await makeItem();

    await adminAssign(item.id, agentA.id);
    // The administrator is looking at "A"; meanwhile A -> B happens.
    await adminAssign(item.id, agentB.id, 'Hub A closed without notice; moving to Hub B.');

    // The removal that was decided against A is now stale.
    await expect(adminUnassign(item.id, undefined, agentA.id)).rejects.toThrow(/changed/i);

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id).toBe(agentB.id);
    const events = await db.getItemAssignmentHistory(item.id);
    expect(events).toHaveLength(2);
    expect(events.some((event) => event.event_type === 'unassigned')).toBe(false);
  });

  it('two concurrent removals produce exactly ONE event and one winner', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem();
    await adminAssign(item.id, agent.id);

    const results = await Promise.allSettled([adminUnassign(item.id), adminUnassign(item.id)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const events = await db.getItemAssignmentHistory(item.id);
    expect(events.filter((event) => event.event_type === 'unassigned')).toHaveLength(1);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBeNull();
  });

  it('a same-agent re-save is a NO-OP: no second event, and no transfer outcome', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem();
    await adminAssign(item.id, agent.id);

    const outcome = await adminAssign(item.id, agent.id, 'Saving the review form again unchanged.');

    // A re-save returns no outcome, which is what stops the route announcing a
    // transfer that never happened.
    expect(outcome).toBeNull();
    const events = await db.getItemAssignmentHistory(item.id);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('assigned');
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agent.id);
  });

  it('two concurrent reassignments produce one winner and a coherent history', async () => {
    const agentA = await makeActionableAgent();
    const agentB = await makeActionableAgent();
    const item = await makeItem();

    await Promise.allSettled([
      adminAssign(item.id, agentA.id, 'Routing to Hub A for this trial.'),
      adminAssign(item.id, agentB.id, 'Routing to Hub B for this trial.'),
    ]);

    const after = (await db.getItem(item.id))!;
    expect([agentA.id, agentB.id]).toContain(after.assigned_agent_id);

    // Whatever won, every recorded event names THIS item and at most one of them
    // is a first assignment; the current holder is the last one recorded.
    const events = await db.getItemAssignmentHistory(item.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.filter((event) => event.event_type === 'assigned')).toHaveLength(1);
    expect(events[events.length - 1].new_agent_id).toBe(after.assigned_agent_id);
  });
});

// =============================================================================
// H-1 (POST-AUDIT CORRECTION) — THE AUDIT ROW COMMITS WITH THE MUTATION, OR NOT
// AT ALL.
//
// THE FAILURE THIS PREVENTS. The audit line used to be a separate statement
// issued AFTER the transaction had committed. When that statement failed, the
// assignment or removal stayed committed while the audit trail said nothing, the
// notification was never sent, and the administrator's retry was then refused as
// a stale decision — a change nobody could describe, made permanent.
//
// HOW IT IS PROVEN. The audit write is now issued on the mutation's own
// transaction handle and BEFORE the mutation is issued, so injecting an audit
// failure must leave the holder, its assignment history and the audit trail
// exactly as they were. (Ordering is what makes the guarantee observable in this
// harness, which cannot model BEGIN/ROLLBACK; in PostgreSQL the transaction is
// what enforces it.)
// =============================================================================
describe('H-1 - an audit-write failure leaves nothing behind', () => {
  /**
   * Makes the NEXT in-transaction audit write fail, once, and returns the
   * restore function. Spying through the prototype (rather than the instance)
   * mirrors the established pattern in __tests__/payoutRepairService.test.ts, so
   * the real writer is intercepted however it is reached.
   */
  function failNextAuditWrite(): () => void {
    const proto = Object.getPrototypeOf(db);
    const spy = vi.spyOn(proto, 'logAuditInTx').mockRejectedValueOnce(
      new Error('audit storage unavailable'),
    );
    return () => spy.mockRestore();
  }

  it('assignment: the holder does not move and no history event is recorded', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem();
    const auditsBefore = (await db.getAuditLogs()).length;

    const restore = failNextAuditWrite();
    let failure: unknown;
    try {
      await adminAssign(item.id, agent.id);
    } catch (error) {
      failure = error;
    } finally {
      restore();
    }

    // An infrastructure failure, not a refusal: the route answers 500, not 409,
    // and no caller can mistake it for "someone else already assigned this".
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof ItemAssignmentRefusedError).toBe(false);

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id, 'holder must not move').toBeNull();
    expect(await db.getItemAssignmentHistory(item.id)).toHaveLength(0);
    expect((await db.getAuditLogs()).length, 'no audit row outlives its failed write').toBe(
      auditsBefore,
    );
  });

  it('unassignment: the holder stays, and no unassigned event is recorded', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem();
    await adminAssign(item.id, agent.id);

    const historyBefore = await db.getItemAssignmentHistory(item.id);
    const auditsBefore = (await db.getAuditLogs()).length;

    const restore = failNextAuditWrite();
    let failure: unknown;
    try {
      await adminUnassign(item.id, 'Audit failure probe.', agent.id);
    } catch (error) {
      failure = error;
    } finally {
      restore();
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof ItemAssignmentRefusedError).toBe(false);

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id, 'holder must not move').toBe(agent.id);
    // Not returned to the manual queue either: nothing about the item moved.
    expect(after.needs_manual_agent_reassignment).toBe(false);
    expect((await db.getItemAssignmentHistory(item.id)).length).toBe(historyBefore.length);
    expect((await db.getAuditLogs()).length, 'no audit row outlives its failed write').toBe(
      auditsBefore,
    );
  });

  it('a change that commits still records its audit row exactly once', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem();

    await adminAssign(item.id, agent.id);
    const afterAssignment = (await db.getAuditLogs()).filter(
      (row) => row.action === 'ADMIN_UPDATE_ITEM' && row.details.includes(item.id),
    );
    expect(afterAssignment, 'one line per committed assignment').toHaveLength(1);

    await adminUnassign(item.id, 'Committed removal is still audited.', agent.id);
    const all = await db.getAuditLogs();
    // The removal has its own line, and the assignment line was not rewritten.
    expect(
      all.filter((row) => row.action === 'ADMIN_UPDATE_ITEM' && row.details.includes(item.id)),
    ).toHaveLength(1);
    expect(
      all.filter(
        (row) => row.action === 'MANUAL_AGENT_UNASSIGNMENT' && row.details.includes(item.id),
      ),
    ).toHaveLength(1);
  });
});

// =============================================================================
// H-2 (POST-AUDIT CORRECTION) — AN EXPLICITLY OBSERVED "NO HOLDER" IS A
// CONSTRAINT.
//
// The route passes `existingItem.assigned_agent_id ?? null`, i.e. it always says
// what it saw. The racy window is therefore: the administrator's read saw
// nobody, another administrator assigns the item, and the removal that was
// decided against "nobody" arrives. Before H-2 that `null` was read as "no
// opinion" and the removal deleted the NEWER assignment.
// =============================================================================
describe('H-2 - an explicitly observed "no holder" is a constraint', () => {
  it('refuses a removal decided against "nobody" once an agent has been assigned', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem();

    // Exactly what the unassign route reads when it renders the decision.
    const observedHolder = (await db.getItem(item.id))!.assigned_agent_id ?? null;
    expect(observedHolder).toBeNull();

    // Meanwhile another administrator assigns the item.
    await adminAssign(item.id, agent.id);

    await expect(
      adminUnassign(item.id, 'Removal decided against a holder-less item.', observedHolder),
    ).rejects.toMatchObject({ code: 'holder_changed' });

    // The NEWER assignment survives, and no unassignment is recorded.
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agent.id);
    const events = await db.getItemAssignmentHistory(item.id);
    expect(events).toHaveLength(1);
    expect(events.filter((event) => event.event_type === 'unassigned')).toHaveLength(0);
  });

  it('still answers "nothing to remove" when the item really has no holder', async () => {
    const item = await makeItem();

    await expect(adminUnassign(item.id, 'Nothing to remove.', null)).rejects.toMatchObject({
      code: 'no_current_holder',
    });
    expect(await db.getItemAssignmentHistory(item.id)).toHaveLength(0);
  });

  it('undefined means "no expectation": a removal proceeds without one', async () => {
    const agent = await makeActionableAgent();
    const item = await makeItem();
    await adminAssign(item.id, agent.id);

    await expect(
      adminUnassign(item.id, 'No expectation supplied.', undefined),
    ).resolves.toBeTruthy();

    expect((await db.getItem(item.id))!.assigned_agent_id).toBeNull();
  });
});
