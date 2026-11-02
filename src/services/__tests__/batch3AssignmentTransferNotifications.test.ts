import { describe, it, expect, beforeEach } from 'vitest';
import { db, type Agent, type FoundItem } from '../../db/database';
import { ensureTestCategory, testRunId } from '../../db/__tests__/ensureTestCategory';
import {
  notifyAgentAssignedToItem,
  notifyAgentUnassignedFromItem,
} from '../agentAssignmentNotifications';
import { __setEmailProvider } from '../notificationService';

// =============================================================================
// PHASE 16.1 BATCH 3 — STAGE 3B-3 CHECKPOINT 3: TRANSFER NOTIFICATIONS.
//
// THE MATRIX THIS FILE PINS (see the final report's table):
//
//   initial assignment   agent + finder + live claimant
//   reassignment         incoming agent + finder + live claimant + OUTGOING agent
//   unassignment         outgoing agent + finder + live claimant (no replacement)
//
// and, for every one of them, the IDENTITY rule: the idempotency key is built
// from the committed assignment-history event, so
//   * the SAME event delivered twice is suppressed (a retry is not a resend);
//   * two DIFFERENT events for the same item are both delivered (a transfer is
//     not a duplicate of the first assignment — the 3B-0 gap).
//
// NO REAL MESSAGE IS SENT: the email provider is a test double for every test.
// =============================================================================

let sent: Array<{ to: string; subject: string; html: string }> = [];
let providerAccepts = true;
let providerThrows = false;

beforeEach(() => {
  sent = [];
  providerAccepts = true;
  providerThrows = false;
  __setEmailProvider({
    name: 'test-email',
    send: async (to: string, subject: string, html: string) => {
      if (providerThrows) throw new Error('transport unavailable');
      if (!providerAccepts) {
        return { accepted: false, providerMessageId: null, error: 'provider_refused', failureClass: 'retryable_failure' };
      }
      sent.push({ to, subject, html });
      return { accepted: true, providerMessageId: `msg-${sent.length}` };
    },
  } as any);
});

let counter = 0;
const RUN = `TEST-B3-3-NOTIFY-${testRunId}`;

async function makeAgent(label: string): Promise<Agent> {
  const id = `${RUN}-AGENT-${label}-${counter++}`;
  await db.createAgent({
    id,
    business_name: `Transfer Hub ${label}`,
    contact_phone: `+254${testRunId}${counter}`,
    location_address: 'Ngong Road, Nairobi',
    county: 'Nairobi City',
    latitude: -1.2921,
    longitude: 36.8219,
    mpesa_till_or_paybill: '000123',
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-b3-3-notify',
    needs_manual_geocoding: false,
    contact_email: `transfer-${label}-${id}@example.com`,
  } as any);
  await db.verifyAgentEmail(id);
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
    latitude: null,
    longitude: null,
    finder_phone: '+254700000095',
    finder_email: `transfer-finder-${id}@example.com`,
    found_county: 'Nairobi City',
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

/** A live claim with an owner email, so the claimant branch is exercised. */
async function makeClaim(itemId: string, status = 'escrow_held'): Promise<string> {
  const id = `${RUN}-CLAIM-${counter++}`;
  const ownerEmail = `transfer-owner-${id}@example.com`.toLowerCase();
  await db.createClaim({
    id,
    item_id: itemId,
    owner_phone: '+254700000096',
    security_answers: { lastDigits: '0002', color: 'black', lostDetails: 'fixture' },
    verification_tier: 1,
    status,
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
    owner_email: ownerEmail,
    agent_confirmed_at: null,
  } as any);
  return ownerEmail;
}

/** Perform a REAL manual assignment through the data layer, returning its event. */
async function assign(
  itemId: string,
  agentId: string,
  reason = 'Nearest hub is closed; routing to the next hub in the same county.',
) {
  const outcome = await db.adminUpdateItem(
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
  if (!outcome) throw new Error('expected a committed assignment event');
  return outcome;
}

function recipients(): string[] {
  return sent.map((message) => message.to.toLowerCase()).sort();
}

describe('3B-3 checkpoint 3 — initial assignment (behaviour preserved)', () => {
  it('tells the agent, the finder and the live claimant exactly once', async () => {
    const agent = await makeAgent('a');
    const item = await makeItem();
    const ownerEmail = await makeClaim(item.id);

    const outcome = await assign(item.id, agent.id);
    const assignedItem = (await db.getItem(item.id))!;
    const notified = await notifyAgentAssignedToItem({
      item: assignedItem,
      agent,
      trigger: 'admin_manual',
      assignmentEventId: outcome.eventId,
    });

    expect(notified.agent?.status).toBe('sent');
    expect(notified.finder?.status).toBe('sent');
    expect(notified.claimant.map((n) => n.status)).toEqual(['sent']);
    // No predecessor, so no revocation message.
    expect(notified.previousAgent).toBeNull();

    expect(recipients()).toEqual(
      [agent.contact_email!, assignedItem.finder_email!, ownerEmail].map((e) => e.toLowerCase()).sort(),
    );
  });

  it('keys each message on the COMMITTED event, not on the item', async () => {
    const agent = await makeAgent('a');
    const item = await makeItem();
    const outcome = await assign(item.id, agent.id);

    await notifyAgentAssignedToItem({
      item: (await db.getItem(item.id))!,
      agent,
      trigger: 'admin_manual',
      assignmentEventId: outcome.eventId,
    });

    expect(
      await db.getNotificationEventByIdempotencyKey(`AGENT_ITEM_ASSIGNED:${outcome.eventId}`),
    ).toBeTruthy();
    expect(
      await db.getNotificationEventByIdempotencyKey(`FINDER_AGENT_ASSIGNED:${outcome.eventId}`),
    ).toBeTruthy();
  });

  it('notifies nobody when the claim is terminal, and no claimant when there is none', async () => {
    const agentA = await makeAgent('a');
    const agentB = await makeAgent('b');

    const withoutClaim = await makeItem();
    const outcomeA = await assign(withoutClaim.id, agentA.id);
    const notifiedA = await notifyAgentAssignedToItem({
      item: (await db.getItem(withoutClaim.id))!,
      agent: agentA,
      trigger: 'admin_manual',
      assignmentEventId: outcomeA.eventId,
    });
    expect(notifiedA.claimant).toEqual([]);

    const terminalClaim = await makeItem();
    await makeClaim(terminalClaim.id, 'released');
    sent = [];
    const outcomeB = await assign(terminalClaim.id, agentB.id);
    const notifiedB = await notifyAgentAssignedToItem({
      item: (await db.getItem(terminalClaim.id))!,
      agent: agentB,
      trigger: 'admin_manual',
      assignmentEventId: outcomeB.eventId,
    });
    expect(notifiedB.claimant).toEqual([]);
    expect(sent).toHaveLength(2); // agent + finder only
  });
});

describe('3B-3 checkpoint 3 — reassignment notifies the incoming AND outgoing agents', () => {
  it('delivers four messages: new agent, finder, claimant and the agent who lost the item', async () => {
    const agentA = await makeAgent('a');
    const agentB = await makeAgent('b');
    const item = await makeItem();
    const ownerEmail = await makeClaim(item.id);

    const first = await assign(item.id, agentA.id);
    await notifyAgentAssignedToItem({
      item: (await db.getItem(item.id))!,
      agent: agentA,
      trigger: 'admin_manual',
      assignmentEventId: first.eventId,
    });
    sent = [];

    const transfer = await assign(item.id, agentB.id, 'Hub A is at capacity; moving to Hub B.');
    const notified = await notifyAgentAssignedToItem({
      item: (await db.getItem(item.id))!,
      agent: agentB,
      trigger: 'admin_manual',
      assignmentEventId: transfer.eventId,
      previousAgent: agentA,
    });

    expect(notified.agent?.status).toBe('sent');
    expect(notified.finder?.status).toBe('sent');
    expect(notified.claimant.map((n) => n.status)).toEqual(['sent']);
    expect(notified.previousAgent?.status).toBe('sent');

    expect(sent).toHaveLength(4);
    expect(recipients()).toEqual(
      [agentB.contact_email!, agentA.contact_email!, item.finder_email!, ownerEmail].map((e) =>
        e.toLowerCase(),
      ).sort(),
    );

    // The outgoing agent's message says the assignment ended, and does not name
    // the replacement hub.
    const outgoing = sent.find((m) => m.to.toLowerCase() === agentA.contact_email!.toLowerCase())!;
    expect(outgoing.subject).toMatch(/reassigned/i);
    expect(outgoing.html).not.toContain(agentB.business_name);
  });

  it('keeps telling the truth to the finder and claimant on the SECOND transfer', async () => {
    const agentA = await makeAgent('a');
    const agentB = await makeAgent('b');
    const agentC = await makeAgent('c');
    const item = await makeItem();
    const ownerEmail = await makeClaim(item.id);

    const events = [];
    events.push(await assign(item.id, agentA.id));
    events.push(await assign(item.id, agentB.id, 'Hub A closed without notice; moving to Hub B.'));
    events.push(await assign(item.id, agentC.id, 'Hub B is full for the day; moving to Hub C.'));

    // Deliver each committed event once, in order.
    const agents = [agentA, agentB, agentC];
    for (let i = 0; i < events.length; i += 1) {
      await notifyAgentAssignedToItem({
        item: (await db.getItem(item.id))!,
        agent: agents[i],
        trigger: 'admin_manual',
        assignmentEventId: events[i].eventId,
        previousAgent: i > 0 ? agents[i - 1] : null,
      });
    }

    // 3 (initial) + 4 (transfer) + 4 (transfer) = 11 distinct messages.
    expect(sent).toHaveLength(11);
    const toC = sent.filter((m) => m.to.toLowerCase() === agentC.contact_email!.toLowerCase());
    expect(toC).toHaveLength(1);
    const toOwner = sent.filter((m) => m.to.toLowerCase() === ownerEmail.toLowerCase());
    expect(toOwner).toHaveLength(3);
  });
});


describe('3B-3 checkpoint 3 — unassignment notifies the outgoing agent', () => {
  it('tells the outgoing agent, the finder and the live claimant, and invents no replacement', async () => {
    const agent = await makeAgent('a');
    const item = await makeItem();
    const ownerEmail = await makeClaim(item.id);

    const assignment = await assign(item.id, agent.id);
    await notifyAgentAssignedToItem({
      item: (await db.getItem(item.id))!,
      agent,
      trigger: 'admin_manual',
      assignmentEventId: assignment.eventId,
    });
    sent = [];

    const removal = await db.adminUnassignAgent(
      item.id,
      {
        method: 'manual_override',
        triggerSource: 'admin_manual',
        actorId: 'B3-3-ADMIN',
        actorRole: 'admin',
        reason: 'Hub closed for the week; returning the item to the assignment queue.',
      },
      agent.id,
    );

    const notified = await notifyAgentUnassignedFromItem({
      item: (await db.getItem(item.id))!,
      previousAgent: agent,
      assignmentEventId: removal.eventId,
    });

    expect(notified.agent?.status).toBe('sent');
    expect(notified.finder?.status).toBe('sent');
    expect(notified.claimant.map((n) => n.status)).toEqual(['sent']);
    expect(sent).toHaveLength(3);
    expect(recipients()).toEqual(
      [agent.contact_email!, item.finder_email!, ownerEmail].map((e) => e.toLowerCase()).sort(),
    );

    // The messages are the REMOVAL events, never the assignment ones: telling the
    // finder "a hub will receive your item" would now be false.
    expect(
      await db.getNotificationEventByIdempotencyKey(`AGENT_ITEM_UNASSIGNED:${removal.eventId}`),
    ).toBeTruthy();
    expect(
      await db.getNotificationEventByIdempotencyKey(`FINDER_AGENT_UNASSIGNED:${removal.eventId}`),
    ).toBeTruthy();
    expect(
      await db.getNotificationEventByIdempotencyKey(`AGENT_ITEM_ASSIGNED:${removal.eventId}`),
    ).toBeUndefined();

    const toAgent = sent.find((m) => m.to.toLowerCase() === agent.contact_email!.toLowerCase())!;
    expect(toAgent.subject).toMatch(/assignment removed/i);
  });
});


describe('3B-3 checkpoint 3 — idempotency and failure behaviour', () => {
  it('suppresses a REPEAT of the same committed event, and delivers nothing again', async () => {
    const agent = await makeAgent('a');
    const item = await makeItem();
    await makeClaim(item.id);
    const outcome = await assign(item.id, agent.id);
    const assignedItem = (await db.getItem(item.id))!;

    await notifyAgentAssignedToItem({
      item: assignedItem,
      agent,
      trigger: 'admin_manual',
      assignmentEventId: outcome.eventId,
    });
    expect(sent).toHaveLength(3);

    sent = [];
    const repeat = await notifyAgentAssignedToItem({
      item: assignedItem,
      agent,
      trigger: 'admin_manual',
      assignmentEventId: outcome.eventId,
    });

    expect(sent).toHaveLength(0);
    expect(repeat.agent?.status).toBe('duplicate');
    expect(repeat.finder?.status).toBe('duplicate');
    expect(repeat.claimant[0].status).toBe('duplicate');
  });

  it('does not duplicate messages when the SAME event is dispatched concurrently', async () => {
    const agent = await makeAgent('a');
    const item = await makeItem();
    await makeClaim(item.id);
    const outcome = await assign(item.id, agent.id);
    const assignedItem = (await db.getItem(item.id))!;

    await Promise.all([
      notifyAgentAssignedToItem({
        item: assignedItem,
        agent,
        trigger: 'admin_manual',
        assignmentEventId: outcome.eventId,
      }),
      notifyAgentAssignedToItem({
        item: assignedItem,
        agent,
        trigger: 'admin_manual',
        assignmentEventId: outcome.eventId,
      }),
    ]);

    // Three recipients, three messages - the second dispatch resolved to the
    // existing rows.
    expect(sent).toHaveLength(3);
  });

  it('never throws when the transport fails, so a committed assignment is never reported as failed', async () => {
    const agent = await makeAgent('a');
    const item = await makeItem();
    const outcome = await assign(item.id, agent.id);

    providerThrows = true;
    const notified = await notifyAgentAssignedToItem({
      item: (await db.getItem(item.id))!,
      agent,
      trigger: 'admin_manual',
      assignmentEventId: outcome.eventId,
    });

    expect(notified.agent).not.toBeNull();
    expect(notified.agent!.accepted).toBe(false);
    // The assignment itself is untouched.
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agent.id);
  });

  it('records a provider refusal as a failed event, not as a delivered one', async () => {
    const agent = await makeAgent('a');
    const item = await makeItem();
    const outcome = await assign(item.id, agent.id);

    providerAccepts = false;
    const notified = await notifyAgentAssignedToItem({
      item: (await db.getItem(item.id))!,
      agent,
      trigger: 'admin_manual',
      assignmentEventId: outcome.eventId,
    });

    expect(notified.agent?.status).toBe('failed');
    expect(notified.agent?.accepted).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('sends NOTHING for an assignment that was refused by the custody policy', async () => {
    const agentA = await makeAgent('a');
    const agentB = await makeAgent('b');
    const item = await makeItem({ status: 'at_agent', assigned_agent_id: agentA.id });

    // The route can only notify after a COMMITTED outcome, and the primitive
    // throws instead, so there is nothing to announce.
    await expect(assign(item.id, agentB.id)).rejects.toThrow(/received by an agent hub/i);

    expect(sent).toHaveLength(0);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe(agentA.id);
  });

  it('sends no transfer message for a same-agent re-save', async () => {
    const agent = await makeAgent('a');
    const item = await makeItem();
    await assign(item.id, agent.id);

    const outcome = await db.adminUpdateItem(
      item.id,
      {
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
        needs_manual_agent_reassignment: false,
      } as any,
      {
        method: 'manual_override',
        triggerSource: 'admin_manual',
        actorId: 'B3-3-ADMIN',
        actorRole: 'admin',
        reason: 'Saving the review form again without changing the hub.',
      },
    );

    // No event, therefore no outcome, therefore no message.
    expect(outcome).toBeNull();
    expect(sent).toHaveLength(0);
  });
});
