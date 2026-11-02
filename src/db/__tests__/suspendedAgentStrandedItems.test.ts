import { describe, expect, it } from 'vitest';
import { db, type Agent, type FoundItem, ItemAssignmentRefusedError } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';
import { summariseStrandedItems } from '../../services/agentStrandedItems';
import { buildStrandedItemsQueue } from '../../services/strandedItemsQueue';

// =============================================================================
// STAGE 3B-6B — ITEMS STRANDED AT A SUSPENDED HUB (THE DATA LAYER).
//
// WHAT IS EXERCISED, AGAINST THE REAL DATA LAYER (in-memory harness when
// DATABASE_URL is empty):
//
//   1. db.getItemsAssignedToAgent() returns EVERY item pointing at one hub, in
//      every status, and no other hub's items — the read the stranded summary is
//      built from.
//   2. After a real suspendAgent(), that hub's items split exactly as
//      services/agentStrandedItems.ts says: `awaiting_dropoff` is releasable, an
//      item the hub already received (`at_agent`) is NOT.
//   3. Releasing the releasable items — the exact primitive the release route
//      calls — returns them to the manual-assignment queue, preserves their
//      lifecycle status, and records an `unassigned` history event plus the
//      administrator's reason.
//   4. The `at_agent` item is refused by that SAME primitive (custody_blocked),
//      which is why the console lists it separately instead of offering it.
//   5. A stale release decision (holder changed since the read) is refused with
//      holder_changed, so a release can never erase a newer assignment.
//
// LIMITATION, STATED PLAINLY: the in-memory harness strips
// BEGIN/COMMIT/ROLLBACK, so "the item write and its history row roll back
// together" is not demonstrated here. That guarantee lives in the primitive's
// own transaction and is covered by the Stage 3B-3 characterization suite.
// =============================================================================

let counter = 0;
const RUN = `TEST-B6B-${testRunId}`;
const ADMIN = 'admin.b6b';
const RELEASE_REASON = 'Hub suspended for a verification failure; items returned to the queue.';

async function makeVerifiedAgent(): Promise<Agent> {
  const id = `${RUN}-AGENT-${counter++}`;
  await db.createAgent({
    id,
    business_name: `Stranded Hub ${id}`,
    contact_phone: `+2547${testRunId}${counter}`,
    location_address: 'Ngong Road, Nairobi',
    county: 'Nairobi City',
    administrative_unit_id: 'KE-47-SC-01',
    latitude: -1.2921,
    longitude: 36.8219,
    mpesa_till_or_paybill: '000777',
    payout_method_type: 'Personal M-Pesa',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: `test-hash-${id}`,
    needs_manual_geocoding: false,
    contact_email: `stranded-${id}@example.com`,
  } as any);
  await db.verifyAgentEmail(id);
  return (await db.getAgent(id))!;
}

async function makeItem(assignedAgentId: string | null, overrides: Partial<Record<string, unknown>> = {}): Promise<FoundItem> {
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
    latitude: null,
    longitude: null,
    finder_phone: '+254700000095',
    finder_email: 'b6b-finder@example.com',
    found_county: 'Nairobi City',
    administrative_unit_id: 'KE-47-SC-01',
    location_source: 'user_selected',
    assigned_agent_id: assignedAgentId,
    status: 'awaiting_dropoff',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: 'Black phone',
    is_sensitive_document: false,
    rejection_reason: null,
    agent_assignment_method: assignedAgentId ? 'manual_override' : 'manual_required',
    needs_manual_agent_reassignment: assignedAgentId ? false : true,
    ...overrides,
  } as any);
  return (await db.getItem(id))!;
}


describe('B6-B — the read returns one hub’s items, in every status', () => {
  it('returns items assigned to this agent only', async () => {
    const agent = await makeVerifiedAgent();
    const other = await makeVerifiedAgent();
    const mine = await makeItem(agent.id);
    const alsoMine = await makeItem(agent.id, { status: 'at_agent' });
    const theirs = await makeItem(other.id);

    const rows = await db.getItemsAssignedToAgent(agent.id);
    const ids = rows.map(row => row.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(alsoMine.id);
    expect(ids).not.toContain(theirs.id);
  });
});

describe('B6-B — suspending a hub reports, and does not move, what it was holding', () => {
  it('splits the hub’s items into releasable and physically-held', async () => {
    const agent = await makeVerifiedAgent();
    const waiting = await makeItem(agent.id);
    const received = await makeItem(agent.id, { status: 'at_agent' });

    await db.suspendAgent(agent.id, ADMIN);
    const suspended = await db.getAgent(agent.id);
    expect(suspended!.status).toBe('suspended');

    const summary = summariseStrandedItems(await db.getItemsAssignedToAgent(agent.id), agent.id);
    expect(summary.releasable.map(entry => entry.item_id)).toEqual([waiting.id]);
    expect(summary.held_at_hub.map(entry => entry.item_id)).toEqual([received.id]);

    // THE SUSPENSION ITSELF MOVED NOTHING: both items still point at the hub.
    const stillWaiting = await db.getItem(waiting.id);
    const stillReceived = await db.getItem(received.id);
    expect(stillWaiting!.assigned_agent_id).toBe(agent.id);
    expect(stillReceived!.assigned_agent_id).toBe(agent.id);
    expect(stillWaiting!.status).toBe('awaiting_dropoff');
    expect(stillReceived!.status).toBe('at_agent');
  });
});

describe('B6-B — releasing the stranded items returns them to the queue, with history', () => {
  it('unassigns every releasable item and records the decision', async () => {
    const agent = await makeVerifiedAgent();
    const first = await makeItem(agent.id);
    const second = await makeItem(agent.id);

    const summary = summariseStrandedItems(await db.getItemsAssignedToAgent(agent.id), agent.id);
    const released: string[] = [];
    for (const target of summary.releasable) {
      const outcome = await db.adminUnassignAgent(
        target.item_id,
        {
          method: 'manual_override',
          triggerSource: 'admin_manual',
          actorId: ADMIN,
          actorRole: 'admin',
          reason: RELEASE_REASON,
        },
        agent.id,
      );
      expect(outcome.previousAgentId).toBe(agent.id);
      expect(outcome.newAgentId).toBeNull();
      expect(outcome.eventType).toBe('unassigned');
      released.push(target.item_id);
    }

    expect(released.sort()).toEqual([first.id, second.id].sort());

    for (const itemId of released) {
      const item = await db.getItem(itemId);
      // Back in the manual-assignment queue, with the stale routing evidence gone.
      expect(item!.assigned_agent_id).toBeNull();
      expect(item!.needs_manual_agent_reassignment).toBe(true);
      expect(item!.agent_assignment_method).toBe('manual_required');
      // The lifecycle status is untouched: releasing an assignment is not a
      // custody event and must not pretend the item moved.
      expect(item!.status).toBe('awaiting_dropoff');

      const history = await db.getItemAssignmentHistory(itemId);
      const last = history[history.length - 1] as any;
      expect(last.event_type ?? last.eventType).toBe('unassigned');
      expect(last.reason).toBe(RELEASE_REASON);
    }

    // Nothing is left pointing at the suspended hub.
    const remaining = summariseStrandedItems(await db.getItemsAssignedToAgent(agent.id), agent.id);
    expect(remaining.releasable).toHaveLength(0);
  });
});

describe('B6-B — an item the hub already received cannot be released', () => {
  it('refuses with custody_blocked, which is why it is listed separately', async () => {
    const agent = await makeVerifiedAgent();
    const received = await makeItem(agent.id, { status: 'at_agent' });

    const summary = summariseStrandedItems(await db.getItemsAssignedToAgent(agent.id), agent.id);
    expect(summary.releasable).toHaveLength(0);
    expect(summary.held_at_hub.map(entry => entry.item_id)).toEqual([received.id]);

    await expect(
      db.adminUnassignAgent(
        received.id,
        {
          method: 'manual_override',
          triggerSource: 'admin_manual',
          actorId: ADMIN,
          actorRole: 'admin',
          reason: RELEASE_REASON,
        },
        agent.id,
      ),
    ).rejects.toMatchObject({ code: 'custody_blocked' });

    const after = await db.getItem(received.id);
    expect(after!.assigned_agent_id).toBe(agent.id);
    expect(after!.status).toBe('at_agent');
  });
});

describe('B6-B — a stale release cannot erase a newer assignment', () => {
  it('refuses with holder_changed when the hub in the URL is no longer the holder', async () => {
    const agent = await makeVerifiedAgent();
    const replacement = await makeVerifiedAgent();
    const item = await makeItem(replacement.id);

    await expect(
      db.adminUnassignAgent(
        item.id,
        {
          method: 'manual_override',
          triggerSource: 'admin_manual',
          actorId: ADMIN,
          actorRole: 'admin',
          reason: RELEASE_REASON,
        },
        agent.id,
      ),
    ).rejects.toMatchObject({ code: 'holder_changed' });

    const after = await db.getItem(item.id);
    expect(after!.assigned_agent_id).toBe(replacement.id);
  });

  it('is the repository’s typed refusal, not a bare Error', async () => {
    const agent = await makeVerifiedAgent();
    const item = await makeItem(agent.id, { status: 'claimed' });
    await expect(
      db.adminUnassignAgent(
        item.id,
        { method: 'manual_override', triggerSource: 'admin_manual', actorId: ADMIN, actorRole: 'admin', reason: RELEASE_REASON },
        agent.id,
      ),
    ).rejects.toBeInstanceOf(ItemAssignmentRefusedError);
  });
});

// =============================================================================
// B6-C — THE CONSOLE-WIDE QUEUE, OVER THE REAL DATA LAYER.
//
// The blocks above exercise the PER-AGENT read (db.getItemsAssignedToAgent),
// which answers "what does THIS hub hold?" once an administrator already suspects
// a hub. The admin-console section does not start there: it asks the opposite
// question first, and only then classifies. That path is
//
//   db.getItemsAwaitingAgentAction()            -> platform-wide candidates
//   db.getLatestAssignmentEventsForItems(ids)   -> how long each has waited
//   buildStrandedItemsQueue({...})              -> the rows the console renders
//
// and every DECISION in the third step is delegated to isAgentActionable() and
// describeManualUnassignmentRefusal(). This block proves the three line up on
// real rows: nothing is duplicated from those predicates, and the queue that
// comes out can be emptied with the same primitive the release route calls.
//
// Rows are filtered to this run's prefix before the classifier is called,
// because the real read is deliberately platform-wide.
// =============================================================================

/** The console's read, filtered to this suite's own rows, then classified. */
async function classifyConsoleQueue() {
  const candidates = (await db.getItemsAwaitingAgentAction())
    .filter(row => row.id.startsWith(RUN));
  const holderIds = Array.from(new Set(
    candidates.map(row => row.assigned_agent_id).filter((id): id is string => Boolean(id)),
  ));
  const holders = (await Promise.all(holderIds.map(id => db.getAgent(id))))
    .filter((agent): agent is Agent => Boolean(agent));
  const latestEvents = await db.getLatestAssignmentEventsForItems(candidates.map(row => row.id));
  return buildStrandedItemsQueue({
    items: candidates,
    agents: holders,
    latestEvents,
    // An injected clock: the age assertions below must not depend on wall time.
    now: '2026-12-31T00:00:00.000Z',
  });
}

describe('B6-C — the console queue is built from real rows and the shared policy', () => {
  it('lists what a non-actionable hub still holds, and nothing an active hub holds', async () => {
    const suspended = await makeVerifiedAgent();
    const active = await makeVerifiedAgent();
    const waiting = await makeItem(suspended.id);
    const received = await makeItem(suspended.id, { status: 'at_agent' });
    const activeWaiting = await makeItem(active.id);

    await db.suspendAgent(suspended.id, ADMIN);
    const queue = await classifyConsoleQueue();
    const ids = queue.rows.map(row => row.item_id);

    expect(ids).toContain(waiting.id);
    expect(ids).toContain(received.id);
    // An ACTIVE hub's waiting item is ordinary work, not a stranded queue entry.
    expect(ids).not.toContain(activeWaiting.id);

    // The queue is not "every item": the claimed and unheld items this run made
    // earlier are never candidates, whatever the read returned.
    const claimed = await makeItem(suspended.id, { status: 'claimed' });
    const unheld = await makeItem(null);
    const after = await classifyConsoleQueue();
    const afterIds = after.rows.map(row => row.item_id);
    expect(afterIds).not.toContain(claimed.id);
    expect(afterIds).not.toContain(unheld.id);
  });

  it('says which rows a human must resolve, and offers only the others', async () => {
    const suspended = await makeVerifiedAgent();
    const waiting = await makeItem(suspended.id);
    const received = await makeItem(suspended.id, { status: 'at_agent' });
    await db.suspendAgent(suspended.id, ADMIN);

    const queue = await classifyConsoleQueue();
    const byId = new Map(queue.rows.map(row => [row.item_id, row]));

    const releasableRow = byId.get(waiting.id)!;
    expect(releasableRow.releasable).toBe(true);
    expect(releasableRow.refusal).toBeNull();
    expect(releasableRow.review_required).toBe(false);
    expect(releasableRow.custody).toBe('not_yet_received');
    expect(releasableRow.agent_actionable).toBe(false);

    const heldRow = byId.get(received.id)!;
    expect(heldRow.releasable).toBe(false);
    expect(heldRow.review_required).toBe(true);
    expect(heldRow.custody).toBe('received_at_hub');
    expect(heldRow.refusal).toBe(
      'This item is physically held by its assigned agent hub, so the assignment cannot be removed. No unassignment was made.',
    );

    // The totals describe the rows actually in the queue.
    expect(queue.totals.stranded).toBe(queue.rows.length);
    expect(queue.totals.releasable).toBe(queue.rows.filter(row => row.releasable).length);
    expect(queue.totals.custody_review_required)
      .toBe(queue.rows.filter(row => row.review_required).length);
    expect(queue.totals.hubs).toBe(queue.rows.length > 0
      ? new Set(queue.rows.map(row => row.agent_id)).size
      : 0);
    expect(typeof queue.headline).toBe('string');
    expect(queue.headline.length).toBeGreaterThan(0);
  });
});

describe('B6-C — one audited release at a time empties the queue it listed', () => {
  it('releases the row the queue offered, records the event, and drops the row on re-read', async () => {
    const suspended = await makeVerifiedAgent();
    const waiting = await makeItem(suspended.id);
    await makeItem(suspended.id, { status: 'at_agent' });
    await db.suspendAgent(suspended.id, ADMIN);

    const before = await classifyConsoleQueue();
    const offered = before.rows.filter(row => row.releasable);
    expect(offered.map(row => row.item_id)).toContain(waiting.id);

    // ONE row per call, exactly as the console's dialog does it: the primitive the
    // route calls, with the administrator's reason.
    for (const target of offered) {
      const outcome = await db.adminUnassignAgent(
        target.item_id,
        {
          method: 'manual_override',
          triggerSource: 'admin_manual',
          actorId: ADMIN,
          actorRole: 'admin',
          reason: RELEASE_REASON,
        },
        target.agent_id,
      );
      expect(outcome.eventType).toBe('unassigned');
      expect(outcome.newAgentId).toBeNull();
    }

    const after = await classifyConsoleQueue();
    const afterIds = after.rows.map(row => row.item_id);
    // The releasable row is gone, so the queue can actually empty.
    expect(afterIds).not.toContain(waiting.id);
    expect(after.rows.every(row => row.item_id !== waiting.id)).toBe(true);
    // The physically-held row was never offered, and is still listed for review.
    expect(after.rows.some(row => row.custody === 'received_at_hub')).toBe(true);

    const item = await db.getItem(waiting.id);
    expect(item!.assigned_agent_id).toBeNull();
    expect(item!.status).toBe('awaiting_dropoff');
  });

  it('reads the newest assignment event for an item, and admits when there is none', async () => {
    const suspended = await makeVerifiedAgent();
    const createdWithHolder = await makeItem(suspended.id);
    const released = await makeItem(suspended.id);

    await db.suspendAgent(suspended.id, ADMIN);
    await db.adminUnassignAgent(
      released.id,
      {
        method: 'manual_override',
        triggerSource: 'admin_manual',
        actorId: ADMIN,
        actorRole: 'admin',
        reason: RELEASE_REASON,
      },
      suspended.id,
    );

    const events = await db.getLatestAssignmentEventsForItems([
      createdWithHolder.id,
      released.id,
      // An id with no committed event at all.
      `${RUN}-NO-SUCH-ITEM`,
      '',
    ]);

    const assignedEvent = events.get(createdWithHolder.id);
    expect(assignedEvent).toBeDefined();
    expect(['assigned', 'reassigned']).toContain(
      assignedEvent!.event_type ?? (assignedEvent as any).eventType,
    );
    expect(typeof assignedEvent!.created_at).toBe('string');

    // The newest committed event wins: after the release, that is the unassignment.
    const newest = events.get(released.id);
    expect(newest).toBeDefined();
    expect(newest!.event_type ?? (newest as any).eventType).toBe('unassigned');
    expect(typeof newest!.created_at).toBe('string');

    // An item with no event is ABSENT from the map - never a synthetic
    // "assigned just now" - so the classifier reports its age as unknown.
    expect(events.has(`${RUN}-NO-SUCH-ITEM`)).toBe(false);

    // An empty list must not become `IN ()`; it is answered without a query.
    expect((await db.getLatestAssignmentEventsForItems([])).size).toBe(0);
  });
});
