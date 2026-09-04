import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// Regression test for a real performance gap: db.getItems() does an
// unconditional `SELECT * FROM items` with no WHERE clause — every status,
// every historical row. The public search route used to call it directly
// and filter down to just 'at_agent' items in application code (after
// cryptographically signing every single row first via signFoundItem);
// the agent-items route used to do the same for assigned_agent_id despite
// idx_items_agent already existing and going unused. getItemsByStatus()
// and getItemsByAgent() push those filters into the WHERE clause instead.
// This test proves both return exactly the subset getItems() + an
// equivalent application-level filter would have returned — i.e. the
// optimization is behavior-preserving, not just faster.

let counter = 0;
async function makeTestItem(status: 'at_agent' | 'awaiting_dropoff' | 'claimed', agentId: string | null) {
  const id = `TEST-ITEM-SCOPEDQUERY-${testRunId}-${counter++}`;
  await ensureTestCategory('national-id');
  if (agentId) {
    // items.assigned_agent_id has a real FK to agents(id); the mock doesn't
    // enforce it. Create the agent so the fixture is valid against real
    // Postgres too.
    await db.createAgent({
      id: agentId,
      business_name: 'Test Scoped Agent',
      contact_phone: `+254${testRunId}${counter}`,
      location_address: 'Test Location',
      latitude: null,
      longitude: null,
      mpesa_till_or_paybill: '123456',
      payout_method_type: 'Till Number',
      status: 'active',
      refundable_deposit: 0,
      national_id_hash: 'test-hash-scoped',
      needs_manual_geocoding: false,
    } as any);
  }
  await db.createItem({
    id,
    category_id: 'national-id',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Test location',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000001',
    assigned_agent_id: agentId,
    status,
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: true,
    rejection_reason: null,
  } as any);
  return id;
}

describe('getItemsByStatus returns exactly the matching-status subset', () => {
  it('returns only items with the given status, none with a different status', async () => {
    const atAgentId = await makeTestItem('at_agent', null);
    const droppedOffId = await makeTestItem('awaiting_dropoff', null);
    const claimedId = await makeTestItem('claimed', null);

    const result = await db.getItemsByStatus('at_agent');
    const ids = result.map(i => i.id);

    expect(ids).toContain(atAgentId);
    expect(ids).not.toContain(droppedOffId);
    expect(ids).not.toContain(claimedId);
    expect(result.every(i => i.status === 'at_agent')).toBe(true);
  });

  it('matches what getItems() + an application-level status filter would return (parity)', async () => {
    await makeTestItem('at_agent', null);
    const all = await db.getItems();
    const expected = all.filter(i => i.status === 'at_agent').map(i => i.id).sort();

    const scoped = await db.getItemsByStatus('at_agent');
    const actual = scoped.map(i => i.id).sort();

    expect(actual).toEqual(expected);
  });
});

describe('getItemsByAgent returns exactly the matching-agent subset', () => {
  it('returns only items assigned to the given agent', async () => {
    const agentAItem = await makeTestItem('at_agent', `AGENT-SCOPEDQUERY-A-${testRunId}`);
    const agentBItem = await makeTestItem('at_agent', `AGENT-SCOPEDQUERY-B-${testRunId}`);
    const unassignedItem = await makeTestItem('awaiting_dropoff', null);

    const result = await db.getItemsByAgent(`AGENT-SCOPEDQUERY-A-${testRunId}`);
    const ids = result.map(i => i.id);

    expect(ids).toContain(agentAItem);
    expect(ids).not.toContain(agentBItem);
    expect(ids).not.toContain(unassignedItem);
    expect(result.every(i => i.assigned_agent_id === `AGENT-SCOPEDQUERY-A-${testRunId}`)).toBe(true);
  });

  it('matches what getItems() + an application-level agent filter would return (parity)', async () => {
    await makeTestItem('at_agent', `AGENT-SCOPEDQUERY-PARITY-${testRunId}`);
    const all = await db.getItems();
    const expected = all.filter(i => i.assigned_agent_id === `AGENT-SCOPEDQUERY-PARITY-${testRunId}`).map(i => i.id).sort();

    const scoped = await db.getItemsByAgent(`AGENT-SCOPEDQUERY-PARITY-${testRunId}`);
    const actual = scoped.map(i => i.id).sort();

    expect(actual).toEqual(expected);
  });
});
