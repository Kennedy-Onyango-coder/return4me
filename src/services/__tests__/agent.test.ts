import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentMatchingService } from '../agent';
import { db, type Agent } from '../../db/database';
import { ensureTestCategory, testRunId } from '../../db/__tests__/ensureTestCategory';

// P0 REGRESSION TEST — src/services/agent.ts, assignNearestAgent().
//
// The actual bug (raised twice across this project's hardening passes,
// because the first fix only partially closed it): when GPS matching and
// address geocoding both fail to confidently identify a nearby agent, the
// code used to fall back to activeAgents[0] — an arbitrary agent, possibly
// nowhere near where the item was actually found — and present it to the
// Finder as if it had been confidently matched. It also threw an
// exception entirely when there were no active agents, which failed the
// Finder's whole report submission outright rather than gracefully
// queuing it.
//
// These tests prove: whenever confident matching isn't possible,
// assignNearestAgent returns agent: null with
// needsManualAgentReassignment: true — never an arbitrary pick, and never
// a thrown error that would fail the Finder's report.

let counter = 0;
function stubAgents(agents: Array<Partial<Agent>>) {
  vi.spyOn(db, 'getAgents').mockResolvedValue(agents as Agent[]);
}

async function makeTestAgent(opts: { status?: 'active' | 'suspended' | 'pending'; lat?: number | null; lon?: number | null }) {
  const id = `TEST-AGENT-MATCHING-${testRunId}-${counter++}`;
  await db.createAgent({
    id,
    business_name: `Test Agent ${id}`,
    contact_phone: `+254${testRunId}${counter}`,
    location_address: 'Test Location',
    latitude: opts.lat ?? null,
    longitude: opts.lon ?? null,
    mpesa_till_or_paybill: '654321',
    payout_method_type: 'Till Number',
    status: opts.status ?? 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-matching',
    needs_manual_geocoding: false,
  } as any);
  return id;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AgentMatchingService.assignNearestAgent — never assigns an arbitrary agent', () => {
  it('D. No active agents at all → NO automatic assignment, and does NOT throw (would otherwise fail the Finder\'s report outright)', async () => {
    stubAgents([]);
    const result = await AgentMatchingService.assignNearestAgent(null, null, '');
    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
    expect(result.needsManualAgentReassignment).toBe(true);
  });

  it('E. Active agents exist but NONE have coordinates on file → NO automatic assignment (can\'t compute distance to nothing)', async () => {
    stubAgents([{ status: 'active', latitude: null, longitude: null }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    const result = await AgentMatchingService.assignNearestAgent(-1.3, 36.8, 'irrelevant text, geocoding also fails');
    // Even though an active agent exists, none has usable coordinates, so
    // GPS/geocoded matching (which requires comparing against an agent's
    // own lat/lon) cannot find one — this must fall through to manual,
    // not silently pick that agent anyway.
    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
  });

  it('F. A suspended agent must never be matched, even if it has coordinates and is the only agent in range', async () => {
    stubAgents([{ status: 'suspended', latitude: -1.2921, longitude: 36.8219 }]);
    const result = await AgentMatchingService.assignNearestAgent(-1.2921, 36.8219, '');
    expect(result.agent).toBeNull();
  });

  it('A. GPS location available and an agent with coordinates exists → confidently matched via GPS', async () => {
    stubAgents([{ status: 'active', latitude: -1.2921, longitude: 36.8219 }]);
    const result = await AgentMatchingService.assignNearestAgent(-1.2921, 36.8219, '');
    expect(result.agent).not.toBeNull();
    expect(result.method).toBe('gps_haversine');
    expect(result.needsManualAgentReassignment).toBe(false);
  });

  it('B. GPS unavailable but address geocoding succeeds → confidently matched via geocoded text', async () => {
    stubAgents([{ status: 'active', latitude: -1.2921, longitude: 36.8219 }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '-1.2921', lon: '36.8219' }],
    }));
    const result = await AgentMatchingService.assignNearestAgent(null, null, 'Nairobi CBD');
    expect(result.agent).not.toBeNull();
    expect(result.method).toBe('geocoded_text');
    expect(result.needsManualAgentReassignment).toBe(false);
  });

  it('C. an agent DOES exist and is matchable via GPS, but this call deliberately supplies neither coordinates nor geocodable text → NO automatic assignment', async () => {
    stubAgents([{ status: 'active', latitude: -1.2921, longitude: 36.8219 }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    const result = await AgentMatchingService.assignNearestAgent(null, null, '');
    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
    expect(result.needsManualAgentReassignment).toBe(true);
  });

  it('G. Manual assignment via adminUpdateItem succeeds and clears needs_manual_agent_reassignment', async () => {
    const agentId = await makeTestAgent({ status: 'active', lat: -1.28, lon: 36.82 });
    const itemId = `TEST-ITEM-MANUAL-ASSIGN-${testRunId}`;
    await ensureTestCategory('phone');
    await db.createItem({
      id: itemId,
      category_id: 'phone',
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'Unrecognizable location',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000021',
      assigned_agent_id: null,
      status: 'awaiting_dropoff',
      flaggedForReview: true,
      isDescriptionOnly: true,
      description: 'Test item awaiting manual assignment',
      is_sensitive_document: false,
      rejection_reason: null,
      agent_assignment_method: 'manual_required',
      needs_manual_agent_reassignment: true,
    } as any);

    await db.adminUpdateItem(itemId, {
      category_id: 'phone',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      description: 'Test item awaiting manual assignment',
      isDescriptionOnly: true,
      flaggedForReview: false,
      assigned_agent_id: agentId,
      agent_assignment_method: 'manual_override',
      needs_manual_agent_reassignment: false,
      agent_assignment_distance_km: null,
    });

    const item = await db.getItem(itemId);
    expect(item?.assigned_agent_id).toBe(agentId);
    expect(item?.needs_manual_agent_reassignment).toBe(false);
    expect(item?.flaggedForReview).toBe(false);
  });
});
