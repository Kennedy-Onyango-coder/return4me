import { describe, it, expect } from 'vitest';
import { db, type FoundItem } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// =============================================================================
// BATCH B — THE ATOMIC ASSIGNMENT PRIMITIVE (requirements 25-27).
//
// WHY THIS FILE EXISTS SEPARATELY. The service-level matcher is tested elsewhere;
// this file pins the CONTRACT OF THE PRIMITIVE ITSELF, because that is where the
// concurrency guarantee actually lives. `attemptAutoAgentAssignment()` is a
// single guarded UPDATE ... WHERE ... RETURNING, so:
//
//   * exactly one of N simultaneous attempts can return true;
//   * every loser returns false and changes nothing;
//   * the winner's row is never subsequently overwritten by a loser;
//   * an item that is not genuinely in the manual queue is refused outright.
//
// The pattern mirrors settlementConcurrencyGuards.test.ts for
// attemptClaimEscrowHold() / attemptSettlementRelease(): the database, not the
// caller, decides the winner.
// =============================================================================

async function makeQueuedItem(overrides: Record<string, unknown> = {}): Promise<FoundItem> {
  const id = `TEST-ITEM-B-CAS-${testRunId}-${Math.random().toString(36).slice(2, 8)}`;
  await ensureTestCategory('phone');
  await db.createItem({
    id,
    category_id: 'phone',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Test location',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000096',
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

describe('Batch B — attemptAutoAgentAssignment is the single concurrency guard', () => {
  it('N simultaneous attempts on one item produce exactly ONE winner', async () => {
    const item = await makeQueuedItem();
    const contenders = ['AGENT-A', 'AGENT-B', 'AGENT-C', 'AGENT-D', 'AGENT-E'];

    const results = await Promise.all(
      contenders.map((agentId) => db.attemptAutoAgentAssignment(item.id, agentId, 'gps_haversine', 2.5)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);

    const winnerIndex = results.findIndex(Boolean);
    const finalItem = (await db.getItem(item.id))!;
    expect(finalItem.assigned_agent_id).toBe(contenders[winnerIndex]);
    expect(finalItem.needs_manual_agent_reassignment).toBe(false);
    expect(finalItem.agent_assignment_method).toBe('gps_haversine');

    // The losers left no trace: no second audit row, no second assignment.
    const audits = (await db.getAuditLogs()).filter(
      (a) => a.action === 'AUTO_AGENT_ASSIGNMENT' && a.details.includes(item.id),
    );
    expect(audits).toHaveLength(1);
  });

  it('a losing attempt cannot overwrite the winner afterwards', async () => {
    const item = await makeQueuedItem();

    expect(await db.attemptAutoAgentAssignment(item.id, 'AGENT-WINNER', 'gps_haversine', 1)).toBe(true);
    // Same item, different agent, AFTER the win — the guard now fails.
    expect(await db.attemptAutoAgentAssignment(item.id, 'AGENT-LATE', 'geocoded_text', 9)).toBe(false);

    const finalItem = (await db.getItem(item.id))!;
    expect(finalItem.assigned_agent_id).toBe('AGENT-WINNER');
    expect(finalItem.agent_assignment_method).toBe('gps_haversine');
  });

  it('refuses an item that is already assigned', async () => {
    const item = await makeQueuedItem({ assigned_agent_id: 'AGENT-EXISTING' });
    expect(await db.attemptAutoAgentAssignment(item.id, 'AGENT-NEW', 'gps_haversine', 1)).toBe(false);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBe('AGENT-EXISTING');
  });

  it('refuses an item that is not flagged for manual reassignment', async () => {
    const item = await makeQueuedItem({ needs_manual_agent_reassignment: false });
    expect(await db.attemptAutoAgentAssignment(item.id, 'AGENT-NEW', 'gps_haversine', 1)).toBe(false);
    expect((await db.getItem(item.id))!.assigned_agent_id).toBeNull();
  });

  it('refuses every item whose lifecycle status has moved on', async () => {
    for (const status of ['at_agent', 'claimed', 'expired', 'rejected', 'suspected_stolen', 'legal_hold']) {
      const item = await makeQueuedItem({ status });
      expect(await db.attemptAutoAgentAssignment(item.id, 'AGENT-NEW', 'gps_haversine', 1), status).toBe(false);
      expect((await db.getItem(item.id))!.assigned_agent_id, status).toBeNull();
    }
  });

  it('refuses an item that does not exist', async () => {
    expect(await db.attemptAutoAgentAssignment(`TEST-ITEM-B-CAS-MISSING-${testRunId}`, 'AGENT-X', 'gps_haversine', 1)).toBe(false);
  });

  it('records the assignment method and distance on the winning row, never the manual override label', async () => {
    const item = await makeQueuedItem();
    await db.attemptAutoAgentAssignment(item.id, 'AGENT-METHOD', 'geocoded_text', 3.75);

    const finalItem = (await db.getItem(item.id))!;
    expect(finalItem.agent_assignment_method).toBe('geocoded_text');
    expect(finalItem.agent_assignment_method).not.toBe('manual_override');
    expect(Number(finalItem.agent_assignment_distance_km)).toBeCloseTo(3.75, 2);
  });
});
