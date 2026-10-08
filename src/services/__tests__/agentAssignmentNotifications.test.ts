import { describe, it, expect, beforeEach } from 'vitest';
import { db, type Agent, type FoundItem } from '../../db/database';
import { ensureTestCategory, testRunId } from '../../db/__tests__/ensureTestCategory';
import { notifyAgentAssignedToItem } from '../agentAssignmentNotifications';
import { __setEmailProvider } from '../notificationService';

// =============================================================================
// BATCH B — AGENT-ASSIGNMENT NOTIFICATIONS (requirements 4-9, 18-21).
//
// THE GAP UNDER TEST. Assigning an item to an agent used to change three columns
// and write one audit line. Nobody was told. These tests pin the behaviour that
// replaces it: the AGENT, the FINDER and any live CLAIMANT are each notified, the
// three are notified independently (one being unreachable must not silence the
// other two), and a repeat of the same assignment does not send anything twice.
//
// WHY A REAL (mock) DATABASE AND A CAPTURED PROVIDER. The deduplication guarantee
// is a UNIQUE INDEX on notification_events.idempotency_key, not application code,
// so it can only be tested by actually inserting twice. The provider is replaced
// through the repository's existing N5 seam so no message leaves the process.
// =============================================================================

let sent: Array<{ to: string; subject: string; html: string }> = [];
let providerThrows = false;

beforeEach(() => {
  sent = [];
  providerThrows = false;
  __setEmailProvider({
    name: 'test-email',
    send: async (to: string, subject: string, html: string) => {
      if (providerThrows) throw new Error('transport exploded');
      sent.push({ to, subject, html });
      return { accepted: true, providerMessageId: `msg-${sent.length}` };
    },
  });
});

let counter = 0;

async function makeAgent(email: string | null = 'hub@example.com'): Promise<Agent> {
  const id = `TEST-AGENT-B-NOTIFY-${testRunId}-${counter++}`;
  await db.createAgent({
    id,
    business_name: `Notify Hub ${id}`,
    contact_phone: `+254${testRunId}${counter}`,
    location_address: 'Ngong Road, Nairobi',
    county: 'Nairobi City',
    latitude: -1.2921,
    longitude: 36.8219,
    mpesa_till_or_paybill: '000123',
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-notify',
    needs_manual_geocoding: false,
    email_verified_at: new Date().toISOString(),
    contact_email: email,
  } as any);
  return (await db.getAgent(id))!;
}

async function makeItem(opts: {
  finderEmail?: string | null;
  status?: string;
  assignedAgentId?: string | null;
  needsManual?: boolean;
}): Promise<FoundItem> {
  const id = `TEST-ITEM-B-NOTIFY-${testRunId}-${counter++}`;
  await ensureTestCategory('phone');
  await db.createItem({
    id,
    category_id: 'phone',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Unrecognizable location',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000099',
    finder_email: opts.finderEmail === undefined ? 'finder@example.com' : opts.finderEmail,
    found_county: 'Nairobi City',
    assigned_agent_id: opts.assignedAgentId ?? null,
    status: opts.status ?? 'awaiting_dropoff',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: 'Black phone',
    is_sensitive_document: false,
    rejection_reason: null,
    agent_assignment_method: 'manual_override',
    needs_manual_agent_reassignment: opts.needsManual ?? false,
  } as any);
  return (await db.getItem(id))!;
}

async function makeClaim(itemId: string, status = 'escrow_held', ownerEmail: string | null = 'owner@example.com') {
  const id = `TEST-CLAIM-B-NOTIFY-${testRunId}-${counter++}`;
  await db.createClaim({
    id,
    item_id: itemId,
    owner_phone: '+254700000098',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'fixture' },
    verification_tier: 1,
    status,
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
    owner_email: ownerEmail,
    agent_confirmed_at: null,
  } as any);
  return id;
}

describe('Batch B — manual assignment notifies the agent, the finder and the claimant', () => {
  it('produces all three notifications, each addressed to the right party', async () => {
    const agent = await makeAgent();
    const item = await makeItem({});
    await makeClaim(item.id);

    const outcome = await notifyAgentAssignedToItem({ item, agent, trigger: 'admin_manual' });

    expect(outcome.agent?.status).toBe('sent');
    expect(outcome.finder?.status).toBe('sent');
    expect(outcome.claimant).toHaveLength(1);
    expect(outcome.claimant[0].status).toBe('sent');

    expect(sent.map((m) => m.to).sort()).toEqual(['finder@example.com', 'hub@example.com', 'owner@example.com']);
    expect(sent.find((m) => m.to === 'hub@example.com')!.subject).toContain('New Item Assigned');
    expect(sent.find((m) => m.to === 'finder@example.com')!.subject).toContain('An Agent Has Been Assigned');
    expect(sent.find((m) => m.to === 'owner@example.com')!.subject).toContain('Your Claim');
  });

  it('states an AGENT WAS ASSIGNED, and never asserts an outcome that has not happened', async () => {
    const agent = await makeAgent();
    const item = await makeItem({});
    await makeClaim(item.id);

    await notifyAgentAssignedToItem({ item, agent, trigger: 'agent_now_operational' });

    for (const message of sent) {
      expect(message.html).toContain(item.id);
      // No message may claim the item was recovered, returned or handed over.
      // (The disqualifying phrases are chosen so that the disclaimers, which
      // mention these outcomes in the negative, are NOT caught.)
      expect(message.html).not.toMatch(/has been recovered|was recovered|returned to its owner|handover is complete/i);
    }

    // The finder and the claimant are told explicitly that this is an assignment,
    // so neither can read it as "your item is back".
    const finderMail = sent.find((m) => m.to === 'finder@example.com')!;
    const claimantMail = sent.find((m) => m.to === 'owner@example.com')!;
    expect(finderMail.html).toMatch(/assignment only/i);
    expect(claimantMail.html).toMatch(/assignment only/i);
    expect(finderMail.html).toMatch(/agent/i);
  });

  it('does not leak the finder phone number or the internal routing method to the agent', async () => {
    const agent = await makeAgent();
    const item = await makeItem({});
    await makeClaim(item.id);

    await notifyAgentAssignedToItem({ item, agent, trigger: 'admin_manual' });

    const agentMail = sent.find((m) => m.to === 'hub@example.com')!;
    expect(agentMail.html).not.toContain('+254700000099');
    expect(agentMail.html).not.toContain('manual_override');
    expect(agentMail.html).not.toContain('gps_haversine');
  });
});

describe('Batch B — notification recipients are resolved, never invented', () => {
  it('produces NO finder notification when the report carried no email address', async () => {
    const agent = await makeAgent();
    const item = await makeItem({ finderEmail: null });
    await makeClaim(item.id);

    const outcome = await notifyAgentAssignedToItem({ item, agent, trigger: 'admin_manual' });

    expect(outcome.finder).toBeNull();
    expect(sent.some((m) => m.to === 'finder@example.com')).toBe(false);
    // The other two are unaffected: one unreachable recipient is not a reason to
    // silence the rest.
    expect(outcome.agent?.status).toBe('sent');
    expect(outcome.claimant).toHaveLength(1);
  });

  it('produces NO claimant notification when the item has no claim at all', async () => {
    const agent = await makeAgent();
    const item = await makeItem({});

    const outcome = await notifyAgentAssignedToItem({ item, agent, trigger: 'admin_manual' });

    expect(outcome.claimant).toEqual([]);
    expect(outcome.agent?.status).toBe('sent');
  });

  it('produces NO claimant notification for a TERMINAL claim', async () => {
    const agent = await makeAgent();
    const item = await makeItem({});
    await makeClaim(item.id, 'released');

    const outcome = await notifyAgentAssignedToItem({ item, agent, trigger: 'admin_manual' });

    expect(outcome.claimant).toEqual([]);
    expect(sent.some((m) => m.to === 'owner@example.com')).toBe(false);
  });

  it('skips ONLY the agent when the agent has no contact email', async () => {
    const agent = await makeAgent(null);
    const item = await makeItem({});

    const outcome = await notifyAgentAssignedToItem({ item, agent, trigger: 'admin_manual' });

    expect(outcome.agent).toBeNull();
    expect(sent.some((m) => m.to === 'hub@example.com')).toBe(false);
    // The finder is still reachable and is still told: one party having no
    // address must never silence the others.
    expect(outcome.finder?.status).toBe('sent');
  });

  it('sends nothing at all when NO party has a destination', async () => {
    const agent = await makeAgent(null);
    const item = await makeItem({ finderEmail: null });

    const outcome = await notifyAgentAssignedToItem({ item, agent, trigger: 'admin_manual' });

    expect(outcome.agent).toBeNull();
    expect(outcome.finder).toBeNull();
    expect(outcome.claimant).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});

describe('Batch B — assignment notifications are idempotent under retries', () => {
  it('a repeated assignment sends NOTHING again, and reports the existing event as a duplicate', async () => {
    const agent = await makeAgent();
    const item = await makeItem({});
    await makeClaim(item.id);

    const first = await notifyAgentAssignedToItem({ item, agent, trigger: 'admin_manual' });
    expect(sent).toHaveLength(3);
    expect(first.agent?.status).toBe('sent');

    // The SAME assignment observed again — a retried request, a double-clicked
    // admin action, or a re-run of the matcher for the same item.
    sent = [];
    const second = await notifyAgentAssignedToItem({ item, agent, trigger: 'admin_manual' });

    expect(sent).toHaveLength(0);
    expect(second.agent?.status).toBe('duplicate');
    expect(second.finder?.status).toBe('duplicate');
    expect(second.claimant[0].status).toBe('duplicate');

    // Durable evidence: the event row exists under the canonical key.
    expect(await db.getNotificationEventByIdempotencyKey(`AGENT_ITEM_ASSIGNED:${item.id}`)).toBeTruthy();
  });
});

describe('Batch B — a notification failure never becomes an assignment failure', () => {
  it('resolves without throwing when the email transport explodes', async () => {
    const agent = await makeAgent();
    const item = await makeItem({});
    await makeClaim(item.id);

    providerThrows = true;

    const outcome = await notifyAgentAssignedToItem({ item, agent, trigger: 'admin_manual' });

    // The call completed and returned an outcome. The assignment it describes is
    // untouched, and no exception can reach the route's error handler.
    expect(outcome.agent).not.toBeNull();
    expect(outcome.agent!.accepted).toBe(false);
    expect(outcome.claimant).toHaveLength(1);
  });

  it('resolves without throwing when the active-claim lookup itself fails', async () => {
    const agent = await makeAgent();
    const item = await makeItem({});
    await makeClaim(item.id);

    const original = db.getActiveClaimsForItem.bind(db);
    (db as any).getActiveClaimsForItem = async () => {
      throw new Error('claim lookup unavailable');
    };
    try {
      const outcome = await notifyAgentAssignedToItem({ item, agent, trigger: 'admin_manual' });
      expect(outcome.claimant).toEqual([]);
      expect(outcome.agent?.status).toBe('sent');
    } finally {
      (db as any).getActiveClaimsForItem = original;
    }
  });
});
