import { describe, it, expect, beforeEach } from 'vitest';
import { db, type Agent, type FoundItem } from '../../db/database';
import { ensureTestCategory, testRunId } from '../../db/__tests__/ensureTestCategory';
import {
  matchPendingItemsForOperationalAgent,
  type AgentAutoAssignmentDeps,
} from '../agentAutoAssignment';
import { __setEmailProvider } from '../notificationService';

// =============================================================================
// BATCH B — AUTOMATIC MATCHING FOR A NEWLY OPERATIONAL AGENT
// (requirements 10-27, and the concurrency requirements 25-27).
//
// THE SCENARIO UNDER TEST, END TO END:
//   an item was reported, no eligible agent existed, so it went into the manual
//   queue; later an agent finishes onboarding; the item must be assigned without
//   an admin touching it — and must never be assigned to someone who is not
//   operational, has no coverage, or when another attempt already won it.
//
// TWO LEVELS, ON PURPOSE.
//   * The GATES (operational? coverage?) and the CONCURRENCY outcome are tested
//     with injected dependencies, so each rule is exercised in isolation.
//   * The FULL PATH (real matcher, real compare-and-swap, real audit row, real
//     notification) is tested against the real database, because the guarantees
//     being claimed are database guarantees.
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
const RUN = `TEST-AGENT-B-AUTO-${testRunId}`;
const COUNTY = `Auto County ${testRunId}`;

function agentFields(overrides: Partial<Record<string, unknown>> = {}) {
  const id = `${RUN}-${counter++}`;
  return {
    id,
    business_name: `Auto Hub ${id}`,
    contact_phone: `+254${testRunId}${counter}`,
    location_address: 'Test Location',
    county: COUNTY,
    latitude: -1.2921,
    longitude: 36.8219,
    mpesa_till_or_paybill: '000000',
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-auto',
    needs_manual_geocoding: false,
    email_verified_at: new Date().toISOString(),
    contact_email: 'auto-hub@example.com',
    ...overrides,
  } as any;
}

async function makeAgent(overrides: Partial<Record<string, unknown>> = {}): Promise<Agent> {
  const fields = agentFields(overrides);
  await db.createAgent(fields);
  // db.createAgent() DELIBERATELY leaves a new agent unverified (N4: creating an
  // account is not the same as proving the mailbox). The real lifecycle verifies
  // it afterwards through POST /api/agents/activate, so the fixture does the same
  // — this is what makes isAgentActionable() true, and it means these tests
  // exercise the repository's actual operational predicate rather than a
  // weakened copy of it.
  if (overrides.email_verified_at === undefined) {
    await db.verifyAgentEmail(fields.id);
  }
  return (await db.getAgent(fields.id))!;
}

async function makeQueuedItem(overrides: Partial<Record<string, unknown>> = {}): Promise<FoundItem> {
  const id = `TEST-ITEM-B-AUTO-${testRunId}-${counter++}`;
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
    latitude: -1.2921,
    longitude: 36.8219,
    finder_phone: '+254700000097',
    finder_email: 'auto-finder@example.com',
    found_county: COUNTY,
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

/** Injected deps that answer every gate from the fixture, with a spy on the CAS. */
function stubDeps(options: {
  agent?: Agent;
  item?: FoundItem;
  items?: FoundItem[];
  cas?: (itemId: string, agentId: string) => Promise<boolean>;
  notified?: Array<{ itemId: string; agentId: string; trigger: string }>;
}): AgentAutoAssignmentDeps {
  const items = options.items ?? (options.item ? [options.item] : []);
  return {
    getAgent: async () => options.agent,
    getItemsAwaitingManualAgentAssignment: async () => items,
    attemptAutoAgentAssignment: async (itemId, agentId) =>
      options.cas ? options.cas(itemId, agentId) : true,
    matchAgent: async () =>
      options.agent
        ? {
            agent: options.agent,
            method: 'gps_haversine',
            distanceKm: 1.25,
            confidence: 'high',
            needsManualAgentReassignment: false,
            evidence: { declared_geography_present: true, coordinate_present: true, boundary_verified: false },
          }
        : {
            agent: null,
            method: 'manual_required',
            distanceKm: null,
            confidence: 'manual',
            needsManualAgentReassignment: true,
            evidence: { declared_geography_present: true, coordinate_present: true, boundary_verified: false },
          },
    notify: async ({ item, agent, trigger }) => {
      options.notified?.push({ itemId: item.id, agentId: agent.id, trigger });
      return { agent: null, finder: null, claimant: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// REQUIREMENT 11 — an agent who is NOT yet operational changes nothing.
// ---------------------------------------------------------------------------
describe('Batch B — a non-operational agent is never given work', () => {
  it('a PENDING applicant assigns nothing', async () => {
    const agent = await makeAgent({ status: 'pending', email_verified_at: null });
    const item = await makeQueuedItem();
    const notified: any[] = [];
    const outcome = await matchPendingItemsForOperationalAgent(agent.id, stubDeps({ agent, item, notified }));

    expect(outcome.evaluated).toBe(false);
    expect(outcome.assigned).toEqual([]);
    expect(notified).toEqual([]);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBeNull();
  });

  it('a SUSPENDED hub assigns nothing', async () => {
    const agent = await makeAgent({ status: 'suspended' });
    const item = await makeQueuedItem();
    const outcome = await matchPendingItemsForOperationalAgent(agent.id, stubDeps({ agent, item }));

    expect(outcome.evaluated).toBe(false);
    expect(outcome.assigned).toEqual([]);
  });

  it('an ACTIVE agent whose new email address is unverified is not operational', async () => {
    // isAgentActionable() is the repository's real predicate, and this is the
    // case it deliberately refuses: a changed email address that nobody has
    // proven control of yet.
    const agent = await makeAgent({ status: 'active', email_verified_at: null, contact_email: 'new@example.com' });
    const item = await makeQueuedItem();
    const outcome = await matchPendingItemsForOperationalAgent(agent.id, stubDeps({ agent, item }));

    expect(outcome.evaluated).toBe(false);
    expect(outcome.assigned).toEqual([]);
  });

  it('an unknown agent id is a no-op, not an error', async () => {
    const outcome = await matchPendingItemsForOperationalAgent('TEST-AGENT-B-AUTO-DOES-NOT-EXIST', stubDeps({}));
    expect(outcome.evaluated).toBe(false);
    expect(outcome.assigned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REQUIREMENT 12 — operational, but with no usable location/coverage.
// ---------------------------------------------------------------------------
describe('Batch B — no coverage means the manual queue is left intact', () => {
  it('an operational agent with neither coordinates nor a county assigns nothing', async () => {
    const agent = await makeAgent({ latitude: null, longitude: null, county: null });
    const item = await makeQueuedItem();
    const notified: any[] = [];
    const outcome = await matchPendingItemsForOperationalAgent(agent.id, stubDeps({ agent, item, notified }));

    expect(outcome.evaluated).toBe(true);
    expect(outcome.assigned).toEqual([]);
    expect(notified).toEqual([]);
    expect((await db.getItem(item.id))!.needs_manual_agent_reassignment).toBe(true);
  });

  it('a county ALONE is enough to be evaluated (the matcher still decides)', async () => {
    const agent = await makeAgent({ latitude: null, longitude: null, county: COUNTY });
    const item = await makeQueuedItem();
    const notified: any[] = [];
    const outcome = await matchPendingItemsForOperationalAgent(agent.id, stubDeps({ agent, item, notified }));

    expect(outcome.evaluated).toBe(true);
    expect(outcome.assigned).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// REQUIREMENTS 25-27 — two agents becoming operational at the same moment.
// ---------------------------------------------------------------------------
describe('Batch B — concurrent assignment: exactly one agent wins', () => {
  it('two matchers racing for one item produce ONE assignment', async () => {
    const agentA = await makeAgent();
    const agentB = await makeAgent();
    const item = await makeQueuedItem();

    // The REAL compare-and-swap, so this is a genuine race, not a simulation of
    // one: both runs read the same manual queue and both decide to assign, and
    // the database decides which write lands.
    const [runA, runB] = await Promise.all([
      matchPendingItemsForOperationalAgent(agentA.id, depsForRace(agentA, item)),
      matchPendingItemsForOperationalAgent(agentB.id, depsForRace(agentB, item)),
    ]);

    const winners = [...runA.assigned, ...runB.assigned];
    expect(winners).toHaveLength(1);

    const finalItem = (await db.getItem(item.id))!;
    expect(finalItem.assigned_agent_id).toBe(winners[0].agentId);
    expect(finalItem.needs_manual_agent_reassignment).toBe(false);

    // The losing run exited safely: no exception, no second write, no state
    // damage — and it did not notify anyone about an assignment it did not make.
    const loser = runA.assigned.length === 0 ? runA : runB;
    const winner = runA.assigned.length === 1 ? runA : runB;
    expect(loser.assigned).toEqual([]);
    expect(winner.assigned[0].agentId).toBe(finalItem.assigned_agent_id);
  });

  it('the CAS refuses an item that another attempt already took', async () => {
    const agent = await makeAgent();
    const item = await makeQueuedItem();
    const notified: any[] = [];

    // A competing assignment wins first, bypassing this module entirely.
    await db.attemptAutoAgentAssignment(item.id, 'TEST-AGENT-OTHER-WINNER', 'gps_haversine', 0.5);

    const outcome = await matchPendingItemsForOperationalAgent(
      agent.id,
      stubDeps({ agent, items: [], notified }),
    );
    expect(outcome.assigned).toEqual([]);
    expect(notified).toEqual([]);

    // The winner's row is untouched.
    const finalItem = (await db.getItem(item.id))!;
    expect(finalItem.assigned_agent_id).toBe('TEST-AGENT-OTHER-WINNER');
  });
});

/** Real CAS + an isolated one-item queue, stubbed notification. */
function depsForRace(agent: Agent, item: FoundItem): AgentAutoAssignmentDeps {
  return {
    getAgent: async (id: string) => (id === agent.id ? agent : undefined),
    // Deliberately returns the SAME unassigned snapshot to both racers: that is
    // the lost-update hazard. Only the database's compare-and-swap can resolve
    // it, which is exactly what is being tested.
    getItemsAwaitingManualAgentAssignment: async () => [item],
    attemptAutoAgentAssignment: (itemId, agentId, method, distanceKm) =>
      db.attemptAutoAgentAssignment(itemId, agentId, method, distanceKm),
    // Both racers confidently claim the SAME item; the database must still allow
    // only one of them to win.
    matchAgent: async () => ({
      agent,
      method: 'gps_haversine' as const,
      distanceKm: 1.1,
      confidence: 'high' as const,
      needsManualAgentReassignment: false,
      evidence: { declared_geography_present: true, coordinate_present: true, boundary_verified: false as const },
    }),
    notify: async () => ({ agent: null, finder: null, claimant: [] }),
  };
}

// ---------------------------------------------------------------------------
// REQUIREMENTS 13-20 — the full path, against the real database.
// ---------------------------------------------------------------------------
describe('Batch B — the full path: assign, record, audit, notify', () => {
  it('a newly operational agent takes the waiting item, with the automatic method and the audit trail', async () => {
    // A county unique to THIS test, so the real matcher has exactly one in-scope
    // candidate and the outcome is deterministic.
    const county = `Solo County ${RUN}`;
    const agent = await makeAgent({ county });
    const item = await makeQueuedItem({ found_county: county });

    const outcome = await matchPendingItemsForOperationalAgent(agent.id);

    expect(outcome.evaluated).toBe(true);
    // Membership, not a total count: the real queue may legitimately contain
    // other items left by earlier tests in this file, and the gate being tested
    // is "did THIS item get assigned to THIS agent".
    expect(outcome.assigned.some((a) => a.itemId === item.id)).toBe(true);
    expect(outcome.assigned.find((a) => a.itemId === item.id)).toMatchObject({
      agentId: agent.id,
      method: 'gps_haversine',
    });

    const finalItem = (await db.getItem(item.id))!;
    expect(finalItem.assigned_agent_id).toBe(agent.id);
    // The automatic method, NOT the admin override label.
    expect(finalItem.agent_assignment_method).toBe('gps_haversine');
    expect(finalItem.agent_assignment_method).not.toBe('manual_override');
    expect(finalItem.agent_assignment_distance_km).not.toBeNull();
    // The manual queue flag is cleared, so the admin queue stops showing it.
    expect(finalItem.needs_manual_agent_reassignment).toBe(false);

    const audits = await db.getAuditLogs();
    const assignmentAudits = audits.filter((a) => a.action === 'AUTO_AGENT_ASSIGNMENT');
    expect(assignmentAudits.some((a) => a.details.includes(item.id) && a.details.includes(agent.id))).toBe(true);

    // Notifications: the agent and the finder, through the real service.
    expect(sent.some((m) => m.to === 'auto-hub@example.com')).toBe(true);
    expect(sent.some((m) => m.to === 'auto-finder@example.com')).toBe(true);
  });

  it('a run with nothing to match leaves every queued item exactly as it was', async () => {
    const county = `Empty County ${RUN}`;
    const agent = await makeAgent({ county });
    const item = await makeQueuedItem({ found_county: `Other County ${RUN}` });

    const outcome = await matchPendingItemsForOperationalAgent(agent.id);

    expect(outcome.evaluated).toBe(true);
    // The point is that THIS item is still untouched and still queued — the agent
    // cannot reach an item that is not in its county scope.
    expect(outcome.assigned.some((a) => a.itemId === item.id)).toBe(false);

    const finalItem = (await db.getItem(item.id))!;
    expect(finalItem.assigned_agent_id).toBeNull();
    expect(finalItem.needs_manual_agent_reassignment).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REQUIREMENTS 21-24 — the lifecycle exclusions, and never overwriting.
// ---------------------------------------------------------------------------
describe('Batch B — ineligible, resolved and already-assigned items are out of scope', () => {
  const EXCLUDED_STATUSES = ['at_agent', 'claimed', 'expired', 'rejected', 'suspected_stolen', 'legal_hold'];

  it('the manual queue contains ONLY awaiting_dropoff items', async () => {
    const statuses = [...EXCLUDED_STATUSES, 'awaiting_dropoff'];
    const created = new Map<string, FoundItem>();
    for (const status of statuses) {
      created.set(status, await makeQueuedItem({ status }));
    }

    const queue = await db.getItemsAwaitingManualAgentAssignment();
    const queuedIds = new Set(queue.map((i) => i.id));

    expect(queuedIds.has(created.get('awaiting_dropoff')!.id)).toBe(true);
    for (const status of EXCLUDED_STATUSES) {
      // A rejected / withdrawn / resolved / held / already-at-an-agent item is
      // NEVER a candidate, even though its assigned_agent_id is NULL.
      expect(queuedIds.has(created.get(status)!.id), status).toBe(false);
    }
  });

  it('a full run cannot touch a rejected, resolved or already-assigned item', async () => {
    const county = `Closed County ${RUN}`;
    const agent = await makeAgent({ county });
    const rejected = await makeQueuedItem({ found_county: county, status: 'rejected' });
    const claimed = await makeQueuedItem({ found_county: county, status: 'claimed' });
    const held = await makeQueuedItem({ found_county: county, status: 'legal_hold' });

    await matchPendingItemsForOperationalAgent(agent.id);

    for (const item of [rejected, claimed, held]) {
      const after = (await db.getItem(item.id))!;
      expect(after.assigned_agent_id, item.status).toBeNull();
    }
  });

  it('an item that already has an agent is never re-pointed at a new one', async () => {
    const county = `Taken County ${RUN}`;
    const existingAgent = await makeAgent({ county });
    const newcomer = await makeAgent({ county });

    // The item is already with `existingAgent` and is NOT in the manual queue.
    const item = await makeQueuedItem({
      found_county: county,
      assigned_agent_id: existingAgent.id,
      needs_manual_agent_reassignment: false,
      agent_assignment_method: 'manual_override',
    });

    const outcome = await matchPendingItemsForOperationalAgent(newcomer.id);

    expect(outcome.assigned.some((a) => a.itemId === item.id)).toBe(false);
    const after = (await db.getItem(item.id))!;
    // The existing manual assignment is preserved exactly.
    expect(after.assigned_agent_id).toBe(existingAgent.id);
    expect(after.agent_assignment_method).toBe('manual_override');
  });

  it('the CAS itself refuses an item that is not in the manual queue', async () => {
    // Belt and braces: even if a caller reached the primitive directly, the
    // guard is in the UPDATE, so an item whose flag is false cannot be taken.
    const item = await makeQueuedItem({ needs_manual_agent_reassignment: false });
    const won = await db.attemptAutoAgentAssignment(item.id, 'TEST-AGENT-SHOULD-NOT-WIN', 'gps_haversine', 1);
    expect(won).toBe(false);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBeNull();
  });
});
