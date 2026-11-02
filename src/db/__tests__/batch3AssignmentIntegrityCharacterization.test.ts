import { describe, it, expect } from 'vitest';
import { db, type Agent, type FoundItem } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';
import { isAgentActionable } from '../../services/auth';

// =============================================================================
// PHASE 16.1 BATCH 3 — STAGE 3B-0: CHARACTERIZATION OF THE MANUAL ASSIGNMENT
// WRITE PATH (test-only; no production behaviour is changed by this file).
//
// WHY THIS FILE EXISTS. The Batch 3 audit found that agent assignment is
// decided and persisted in three unrelated places:
//   * the guarded auto path  -> db.attemptAutoAgentAssignment()  (CAS)
//   * the admin review route -> db.adminUpdateItem()             (this file)
//   * item creation          -> db.createItem()                  (audit prose)
// The admin path is the one without any precondition, so before anything is
// hardened its CURRENT behaviour has to be pinned exactly. These tests are
// written against the primitive the route calls (`db.adminUpdateItem`), not
// against a re-implementation of the route, so they keep describing the real
// storage contract when the route changes.
//
// WHAT IS CHARACTERIZED (Batch 3 gaps G2, G3, G4, G10):
//   1. Reassignment overwrites the previous holder with no conflict signal.
//   2. Custody state (status) is not part of the decision at all.
//   3. A `pending` agent, or an active-but-unverified agent whom
//      `isAgentActionable()` rejects, is accepted as the target.
//   4. Assignment history is prose only: `ADMIN_UPDATE_ITEM` names neither the
//      previous nor the new agent and carries no reason, and the dedicated
//      `MANUAL_AGENT_ASSIGNMENT` event is written by the ROUTE, so a
//      primitive-level write produces no assignment event whatsoever.
//   5. The queue flag (`needs_manual_agent_reassignment`) is only cleared when
//      the caller explicitly says so — the holder and the queue flag can
//      therefore disagree.
//   6. Clearing the holder is possible at this layer (null is written) but has
//      no event, no reason and no route that reaches it.
//   7. Two concurrent manual writes both succeed: last write wins.
//   8. The guarded auto primitive refuses exactly what the manual primitive
//      overwrites.
//
// EXPECTATIONS HERE DESCRIBE TODAY'S BEHAVIOUR ON PURPOSE. If Stage 3B-3
// hardens this primitive, these tests must be UPDATED DELIBERATELY — a silent
// change to any of them is a change to the assignment contract.
//
// STAGE 3B-1 NOTE. 3B-1 hardened the ROUTE, not this primitive: the admin review
// endpoint now validates its target with isAgentActionable() and refuses a
// non-actionable agent before any write (see
// src/__tests__/batch3AdminAssignmentRouteContract.test.ts). `adminUpdateItem()`
// itself was deliberately left exactly as characterized below — it still writes
// whatever a caller sends, which is why items 3, 5, 6 and 7 still describe it.
// Putting a precondition INSIDE the primitive is Stage 3B-3 territory.
// =============================================================================

let counter = 0;
const RUN = `TEST-B3-CHAR-${testRunId}`;
const COUNTY = 'Nairobi City';
const SUB_COUNTY = 'KE-47-SC-01';

/** An agent row created through the real writer, so NOT NULL/defaults apply. */
async function makeAgent(overrides: Partial<Record<string, unknown>> = {}): Promise<Agent> {
  const id = `${RUN}-AGENT-${counter++}`;
  await db.createAgent({
    id,
    business_name: `Characterization Hub ${id}`,
    contact_phone: `+254${testRunId}${counter}`,
    location_address: 'Ngong Road, Nairobi',
    county: COUNTY,
    administrative_unit_id: SUB_COUNTY,
    latitude: -1.2921,
    longitude: 36.8219,
    mpesa_till_or_paybill: '000123',
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-b3-characterization',
    needs_manual_geocoding: false,
    contact_email: `hub-${id}@example.com`,
    ...overrides,
  } as any);
  return (await db.getAgent(id))!;
}

/**
 * An agent whose email is genuinely verified, using the repository's real
 * activation write (`verifyAgentEmail`) rather than a pre-set column —
 * `createAgent()` deliberately always stores NULL there (N4).
 */
async function makeVerifiedAgent(overrides: Partial<Record<string, unknown>> = {}): Promise<Agent> {
  const created = await makeAgent(overrides);
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
    finder_phone: '+254700000091',
    finder_email: 'b3-finder@example.com',
    found_county: COUNTY,
    administrative_unit_id: SUB_COUNTY,
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

/**
 * The exact write the admin review route performs (`server.ts` — the
 * `db.adminUpdateItem(...)` call inside POST /api/admin/items/:id/review):
 * assignment columns only, no status, no precondition.
 *
 * BATCH 3 (3B-2) added the third argument: the route now has to state who made
 * the assignment, through which trigger and with what reason, because the
 * history event is written with it. `assignedAgentId === null` (clearing the
 * holder) needs no attribution and writes no event — unassignment belongs to
 * Stage 3B-3, so this helper passes the context unconditionally and the
 * primitive ignores it in that case.
 */
async function adminAssign(
  itemId: string,
  agentId: string | null,
  extra: Partial<Record<string, unknown>> = {},
): Promise<void> {
  await db.adminUpdateItem(itemId, {
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
  } as any, {
    method: 'manual_override',
    triggerSource: 'admin_manual',
    actorId: 'B3-ADMIN',
    actorRole: 'admin',
    reason: 'Re-pointed by an administrator through the review route.',
  });
}

/** Every audit action whose prose mentions this item, sorted for stable comparison. */
async function auditActionsFor(itemId: string): Promise<string[]> {
  const all = await db.getAuditLogs();
  return all
    .filter((row) => row.details.includes(itemId))
    .map((row) => row.action)
    .sort();
}
// =============================================================================
// 1 + 3. CUSTODY STATE AND TARGET ELIGIBILITY ARE NOT PART OF THE DECISION.
// =============================================================================

describe('B3-3 — the manual write REFUSES a custody state it cannot honestly change', () => {
  it('refuses to re-point an item that is ALREADY AT AN AGENT, and changes nothing', async () => {
    const agentA = await makeVerifiedAgent();
    const agentB = await makeVerifiedAgent();
    const item = await makeItem({
      status: 'at_agent',
      assigned_agent_id: agentA.id,
      agent_assignment_method: 'gps_haversine',
      needs_manual_agent_reassignment: false,
    });

    // 3B-0 pinned the opposite: this call used to succeed and leave the database
    // asserting that B held an item physically at A. The custody policy now
    // refuses it inside the same transaction as the write, so nothing changes.
    // (The row already carries its creation event: `makeItem` sets the holder at
    // insert time with a recognised method.)
    const historyBefore = await db.getItemAssignmentHistory(item.id);
    expect(historyBefore).toHaveLength(1);

    await expect(adminAssign(item.id, agentB.id)).rejects.toThrow(/received by an agent hub/i);

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id).toBe(agentA.id);
    expect(after.status).toBe('at_agent');
    expect(after.agent_assignment_method).toBe('gps_haversine');
    // No history event was added by the refused attempt, so the history still ends
    // at the last assignment that actually happened.
    expect(await db.getItemAssignmentHistory(item.id)).toHaveLength(1);
  });

  it('refuses to re-point a CLAIMED item, and preserves its lifecycle state', async () => {
    const agentA = await makeVerifiedAgent();
    const agentB = await makeVerifiedAgent();
    const item = await makeItem({
      status: 'claimed',
      assigned_agent_id: agentA.id,
      needs_manual_agent_reassignment: false,
    });

    await expect(adminAssign(item.id, agentB.id)).rejects.toThrow(/already been claimed/i);

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id).toBe(agentA.id);
    expect(after.status).toBe('claimed');
    // No history event for a refusal, so the history still ends at the last real
    // assignment (there is none here: the row was created already assigned).
    expect(await db.getItemAssignmentHistory(item.id)).toHaveLength(0);
  });
});

describe('B3-0 — the manual write accepts any target agent', () => {
  it('assigns work to a PENDING agent, whom the operational gate rejects', async () => {
    const pending = await makeAgent({ status: 'pending' });
    const item = await makeItem();
    expect(isAgentActionable(pending)).toBe(false);

    await adminAssign(item.id, pending.id);

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id).toBe(pending.id);
    // The route's write also clears the manual queue flag, so the item is no
    // longer discoverable as "needs an agent" while sitting at an agent who
    // cannot sign in to process it.
    expect(after.needs_manual_agent_reassignment).toBe(false);
  });

  it('assigns work to an ACTIVE but EMAIL-UNVERIFIED agent (the G1 shape)', async () => {
    // NOT verified on purpose: createAgent() always stores NULL, and no
    // verifyAgentEmail() call follows.
    const unverified = await makeAgent({ status: 'active' });
    const item = await makeItem();
    expect(unverified.status).toBe('active');
    expect(isAgentActionable(unverified)).toBe(false);

    await adminAssign(item.id, unverified.id);

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id).toBe(unverified.id);
    expect(after.needs_manual_agent_reassignment).toBe(false);
  });
});

// =============================================================================
// 4 + 5. WHAT THE WRITE RECORDS (AND WHAT IT DOES NOT).
// =============================================================================

describe('B3-0 — assignment history is prose, and is not produced here at all', () => {
  it('records only ADMIN_UPDATE_ITEM, naming neither agent and carrying no reason', async () => {
    const agentA = await makeVerifiedAgent();
    const item = await makeItem({ assigned_agent_id: agentA.id });

    await adminAssign(item.id, agentA.id);

    const all = await db.getAuditLogs();
    const adminRows = all.filter(
      (row) => row.action === 'ADMIN_UPDATE_ITEM' && row.details.includes(item.id),
    );
    expect(adminRows).toHaveLength(1);
    expect(adminRows[0].details).not.toContain(agentA.id);
    expect(adminRows[0].details).not.toContain('Reason');

    // The dedicated assignment event belongs to the ROUTE, so a primitive-level
    // assignment produces no assignment event at all. This is the asymmetry
    // Stage 3B-2 has to remove.
    const manualRows = all.filter(
      (row) => row.action === 'MANUAL_AGENT_ASSIGNMENT' && row.details.includes(item.id),
    );
    expect(manualRows).toHaveLength(0);
  });

  it('leaves a transfer invisible: A->B records two rows and neither is an assignment event', async () => {
    const agentA = await makeVerifiedAgent();
    const agentB = await makeVerifiedAgent();
    // Created already assigned, the way the finder-time auto path does it.
    const item = await makeItem({
      assigned_agent_id: agentA.id,
      agent_assignment_method: 'gps_haversine',
      needs_manual_agent_reassignment: false,
    });

    await adminAssign(item.id, agentB.id);

    expect(await auditActionsFor(item.id)).toEqual(['ADMIN_UPDATE_ITEM', 'CREATE_ITEM']);

    const all = await db.getAuditLogs();
    const createRow = all.find(
      (row) => row.action === 'CREATE_ITEM' && row.details.includes(item.id),
    )!;
    // The ONLY mention of an agent in this item's history is prose in the
    // creation line, and it names the FIRST agent. Nothing anywhere names B,
    // and nothing states that the holder changed.
    expect(createRow.details).toContain(agentA.id);
    const history = all.filter((row) => row.details.includes(item.id));
    expect(history.some((row) => row.details.includes(agentB.id))).toBe(false);
  });

  it('does not clear the manual-queue flag unless the caller explicitly asks', async () => {
    const agent = await makeVerifiedAgent();
    const item = await makeItem({ needs_manual_agent_reassignment: true });

    await db.adminUpdateItem(item.id, {
      category_id: 'phone',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      description: 'Black phone',
      isDescriptionOnly: false,
      flaggedForReview: false,
      assigned_agent_id: agent.id,
      agent_assignment_method: 'manual_override',
      // needs_manual_agent_reassignment deliberately omitted.
    } as any, {
      // BATCH 3 (3B-2) — attribution is required for an assignment; the queue
      // flag is still deliberately NOT supplied, which is what this test pins.
      method: 'manual_override',
      triggerSource: 'admin_manual',
      actorId: 'B3-ADMIN',
      actorRole: 'admin',
      reason: 'Assignment without touching the manual-queue flag.',
    });

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id).toBe(agent.id);
    // Holder and queue flag now disagree — the item is assigned AND still in
    // the "needs an agent" queue. The route always sends `false`, which is why
    // this only shows up when a caller forgets it.
    expect(after.needs_manual_agent_reassignment).toBe(true);
  });
});

// =============================================================================
// 6. UNASSIGNMENT.
// =============================================================================

describe('B3-3 — clearing the holder has ONE supported path, and it records everything', () => {
  it('refuses to clear the holder here, and the dedicated unassignment path records it instead', async () => {
    const agent = await makeVerifiedAgent();
    const item = await makeItem({
      assigned_agent_id: agent.id,
      agent_assignment_method: 'manual_override',
      needs_manual_agent_reassignment: false,
    });

    // STAGE 3B-3: `adminUpdateItem(..., null)` used to write NULL with no event,
    // no admin and no reason - the one untraceable assignment mutation. It is now
    // REFUSED, so no holder can change without a history row.
    await expect(
      adminAssign(item.id, null, { needs_manual_agent_reassignment: true }),
    ).rejects.toThrow(/unassignment/i);

    const untouched = (await db.getItem(item.id))!;
    expect(untouched.assigned_agent_id).toBe(agent.id);
    expect(await db.getItemAssignmentHistory(item.id)).toHaveLength(1);

    // The supported route: one atomic removal that records everything.
    const outcome = await db.adminUnassignAgent(item.id, {
      method: 'manual_override',
      triggerSource: 'admin_manual',
      actorId: 'B3-3-ADMIN',
      actorRole: 'admin',
      reason: 'Hub closed for the week; returning the item to the queue.',
    });

    expect(outcome.eventType).toBe('unassigned');
    expect(outcome.previousAgentId).toBe(agent.id);
    expect(outcome.newAgentId).toBeNull();

    const after = (await db.getItem(item.id))!;
    expect(after.assigned_agent_id).toBeNull();
    // The primitive now OWNS "returned to the queue": the flag is set by the
    // operation itself rather than by whichever caller remembered to pass it.
    expect(after.needs_manual_agent_reassignment).toBe(true);
    // Lifecycle is untouched.
    expect(after.status).toBe('awaiting_dropoff');

    const events = await db.getItemAssignmentHistory(item.id);
    expect(events).toHaveLength(2);
    expect(events[1].event_type).toBe('unassigned');
    expect(events[1].previous_agent_id).toBe(agent.id);
    expect(events[1].new_agent_id).toBeNull();
    expect(events[1].actor_id).toBe('B3-3-ADMIN');
    expect(events[1].reason).toContain('Hub closed');

    // And the audit trail now names the removal, with the reason.
    const all = await db.getAuditLogs();
    const forItem = all.filter((row) => row.details.includes(item.id));
    expect(forItem.some((row) => row.action === 'MANUAL_AGENT_UNASSIGNMENT')).toBe(true);
    expect(forItem.some((row) => /unassign/i.test(row.details) && row.details.includes('Hub closed'))).toBe(true);
  });

  it('re-freed items are CAS-eligible again through the dedicated removal', async () => {
    const agentA = await makeVerifiedAgent();
    const agentB = await makeVerifiedAgent();
    const item = await makeItem({ needs_manual_agent_reassignment: true });

    expect(await db.attemptAutoAgentAssignment(item.id, agentA.id, 'gps_haversine', 1.5)).toBe(true);

    await db.adminUnassignAgent(item.id, {
      method: 'manual_override',
      triggerSource: 'admin_manual',
      actorId: 'B3-3-ADMIN',
      actorRole: 'admin',
      reason: 'Routing the item to a nearer hub in the same county.',
    });

    // The guarded primitive will now assign the item again, because every one
    // of its preconditions is true once more.
    expect(await db.attemptAutoAgentAssignment(item.id, agentB.id, 'gps_haversine', 1.5)).toBe(true);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agentB.id);
  });
});

// =============================================================================
// 7. CONCURRENCY: THE MANUAL PATH HAS NO WINNER, ONLY A LAST WRITER.
// =============================================================================

describe('B3-0 — the manual write has no lost-update protection', () => {
  it('sequential reassignment silently overwrites the previous holder', async () => {
    const agentA = await makeVerifiedAgent();
    const agentB = await makeVerifiedAgent();
    const item = await makeItem();

    await adminAssign(item.id, agentA.id);
    await adminAssign(item.id, agentB.id);

    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agentB.id);
    const all = await db.getAuditLogs();
    const adminRows = all.filter(
      (row) => row.action === 'ADMIN_UPDATE_ITEM' && row.details.includes(item.id),
    );
    // Two writes, two identical prose rows: nothing distinguishes them, and
    // nothing says which agent each one installed.
    expect(adminRows).toHaveLength(2);
    expect(new Set(adminRows.map((row) => row.details)).size).toBe(1);
  });

  it('two simultaneous manual writes both succeed — neither is told it lost', async () => {
    const agentA = await makeVerifiedAgent();
    const agentB = await makeVerifiedAgent();
    const item = await makeItem();

    const results = await Promise.allSettled([
      adminAssign(item.id, agentA.id),
      adminAssign(item.id, agentB.id),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const final = (await db.getItem(item.id))!.assigned_agent_id;
    expect([agentA.id, agentB.id]).toContain(final);
  });

  it('the GUARDED auto primitive refuses exactly what the manual primitive overwrites', async () => {
    const agentA = await makeVerifiedAgent();
    const agentB = await makeVerifiedAgent();
    const item = await makeItem({
      assigned_agent_id: agentA.id,
      needs_manual_agent_reassignment: false,
    });

    // Auto path: refused, because the row is already assigned.
    expect(await db.attemptAutoAgentAssignment(item.id, agentB.id, 'gps_haversine', 1)).toBe(false);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agentA.id);

    // Manual path: accepted, same item, same target.
    await adminAssign(item.id, agentB.id);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agentB.id);
  });
});
