import { describe, it, expect, beforeEach } from 'vitest';
import { db, type Agent, type FoundItem } from '../../db/database';
import { ensureTestCategory, testRunId } from '../../db/__tests__/ensureTestCategory';
import { notifyAgentAssignedToItem } from '../agentAssignmentNotifications';
import { __setEmailProvider } from '../notificationService';
import { getNotificationPolicy } from '../../config/notificationEvents';

// =============================================================================
// PHASE 16.1 BATCH 3 — STAGE 3B-0: CHARACTERIZATION OF TRANSFER NOTIFICATIONS
// (test-only; no production behaviour is changed by this file).
//
// STAGE 3B-3 (CHECKPOINT 3) INVERTS THIS FILE ON PURPOSE. The gap described
// below is CLOSED: the notification identity is now the committed
// assignment-history event (falling back to `item:agent` on the automatic path),
// the outgoing agent receives its own event, and a removal has its own event
// types. The expectations were deliberately rewritten rather than deleted, so
// the record of what used to happen stays beside what happens now.
//
// THE FINDING THIS PINNED (audit gap G5). `notifyAgentAssignedToItem()` describes
// THE FIRST assignment of an item extremely well — agent, finder and live
// claimant are each told once. It has no concept of a TRANSFER, and the
// idempotency keys are the reason:
//
//   AGENT_ITEM_ASSIGNED:<item id>       (agent)
//   FINDER_AGENT_ASSIGNED:<item id>     (finder)
//   CLAIMANT_AGENT_ASSIGNED:<claim id>  (claimant)
//
// The first two key on the ITEM, so the second assignment of the same item can
// never be announced: the durable row already exists and NotificationService
// returns `duplicate`. The practical consequences, all pinned below:
//
//   * the INCOMING agent of a transfer is told nothing;
//   * the OUTGOING agent is told nothing (there is no revocation event at all);
//   * the finder is not told the drop-off point moved;
//   * the claimant is not told the handling agent changed.
//
// The notification catalogue is also asserted to have no transfer / revocation
// / unassignment vocabulary, so Stage 3B-4 has to add one deliberately rather
// than quietly reusing an assignment event.
// =============================================================================

let sent: Array<{ to: string; subject: string; html: string }> = [];

beforeEach(() => {
  sent = [];
  __setEmailProvider({
    name: 'test-email',
    send: async (to: string, subject: string, html: string) => {
      sent.push({ to, subject, html });
      return { accepted: true, providerMessageId: `msg-${sent.length}` };
    },
  });
});

let counter = 0;
const RUN = `TEST-B3-TRANSFER-${testRunId}`;

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
    national_id_hash: 'test-hash-b3-transfer',
    needs_manual_geocoding: false,
    contact_email: `transfer-${label}-${id}@example.com`,
  } as any);
  await db.verifyAgentEmail(id);
  return (await db.getAgent(id))!;
}

async function makeItem(): Promise<FoundItem> {
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
    finder_phone: '+254700000092',
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
  } as any);
  return (await db.getItem(id))!;
}

async function makeClaim(itemId: string): Promise<string> {
  const id = `${RUN}-CLAIM-${counter++}`;
  const ownerEmail = `transfer-owner-${id}@example.com`.toLowerCase();
  await db.createClaim({
    id,
    item_id: itemId,
    owner_phone: '+254700000093',
    security_answers: { lastDigits: '0001', color: 'black', lostDetails: 'fixture' },
    verification_tier: 1,
    status: 'escrow_held',
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
    owner_email: ownerEmail,
    agent_confirmed_at: null,
  } as any);
  return ownerEmail;
}


describe('B3-0 — the first assignment notifies three parties exactly once', () => {
  it('tells the agent, the finder and the live claimant', async () => {
    const agentA = await makeAgent('a');
    const item = await makeItem();
    const ownerEmail = await makeClaim(item.id);

    const outcome = await notifyAgentAssignedToItem({ item, agent: agentA, trigger: 'admin_manual' });

    expect(outcome.agent?.status).toBe('sent');
    expect(outcome.finder?.status).toBe('sent');
    expect(outcome.claimant.map((n) => n.status)).toEqual(['sent']);
    expect(sent).toHaveLength(3);
    // Recipients are normalized (lower-cased) by NotificationService, so the
    // comparison is made on the same normalized form the service stores.
    expect(sent.map((m) => m.to.toLowerCase()).sort()).toEqual(
      [agentA.contact_email!, item.finder_email!, ownerEmail].map((e) => e.toLowerCase()).sort(),
    );
  });

});

describe('B3-0 -> B3-3 — a TRANSFER is now announced (this file changed sides on purpose)', () => {
  it('delivers the second assignment instead of suppressing it as a duplicate', async () => {
    const agentA = await makeAgent('a');
    const agentB = await makeAgent('b');
    const item = await makeItem();
    await makeClaim(item.id);

    await notifyAgentAssignedToItem({ item, agent: agentA, trigger: 'admin_manual' });
    expect(sent).toHaveLength(3);

    // The holder changes. The service is called again with the NEW agent —
    // exactly what the review route does after a committed reassignment.
    sent = [];
    const transfer = await notifyAgentAssignedToItem({ item, agent: agentB, trigger: 'admin_manual' });

    // 3B-0 pinned the opposite (three duplicates and nothing delivered). The
    // identity the key is built from is now the assignment event / `item:agent`,
    // so this is a genuinely new logical event and it IS delivered.
    expect(transfer.agent?.status).toBe('sent');
    expect(transfer.finder?.status).toBe('sent');
    expect(transfer.claimant.map((n) => n.status)).toEqual(['sent']);

    expect(sent).toHaveLength(3);
    expect(sent.some((m) => m.to === agentB.contact_email)).toBe(true);
  });

  it('tells the OUTGOING agent that responsibility has changed, without naming the replacement', async () => {
    const agentA = await makeAgent('a');
    const agentB = await makeAgent('b');
    const item = await makeItem();

    await notifyAgentAssignedToItem({ item, agent: agentA, trigger: 'admin_manual' });
    sent = [];
    await notifyAgentAssignedToItem({
      item,
      agent: agentB,
      trigger: 'admin_manual',
      previousAgent: agentA,
    });

    const toOutgoing = sent.filter((m) => m.to === agentA.contact_email);
    // Exactly one revocation message: 3B-0 pinned that this never happened.
    expect(toOutgoing).toHaveLength(1);
    expect(toOutgoing[0].subject).toMatch(/reassign/i);
    // It does not name the incoming hub: the outgoing agent needs to know the
    // work is gone, not who took it.
    expect(toOutgoing[0].html).not.toContain(agentB.business_name);
  });
});

describe('B3-3 — the notification vocabulary now HAS the transfer/removal events', () => {
  it('resolves every transfer-shaped event type to a definition', () => {
    // 3B-0 asserted these were ABSENT, and named their absence as the reason a
    // transfer was silent. Stage 3B-3 adds them deliberately.
    for (const eventType of [
      'AGENT_ITEM_REASSIGNED',
      'AGENT_ITEM_UNASSIGNED',
      'FINDER_AGENT_UNASSIGNED',
      'CLAIMANT_AGENT_UNASSIGNED',
    ]) {
      expect(getNotificationPolicy(eventType), `${eventType} must exist now`).not.toBeNull();
    }
  });

  it('does have the three assignment events the service uses', () => {
    expect(getNotificationPolicy('AGENT_ITEM_ASSIGNED')).not.toBeNull();
    expect(getNotificationPolicy('FINDER_AGENT_ASSIGNED')).not.toBeNull();
    expect(getNotificationPolicy('CLAIMANT_AGENT_ASSIGNED')).not.toBeNull();
  });
});
