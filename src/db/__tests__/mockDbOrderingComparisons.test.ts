import { describe, it, expect } from 'vitest';
import { db } from '../database';

// Regression test for a real bug found and fixed while building the social
// retry sweep: the in-memory mock query engine (src/db/index.ts,
// evaluateWhere) had NO handling at all for ordering comparisons (<=, <,
// >=, >) — only '=' and '<>'/'!='. Any WHERE clause using one of these
// (e.g. drizzle's lte()/lt()/gte()/gt(), which getSocialPublicationsDueForRetry
// depends on) fell through every branch and hit the function's
// unconditional `return true` at the end, meaning every row silently
// matched regardless of the actual comparison — a query meant to select
// "next_attempt_at in the past" would return every row, including ones
// scheduled hours in the future.
//
// This is NOT a production bug — production always talks to a real
// Postgres via ResilientPool, never this mock — but it's a real defect in
// the shared test double that could make any test using a range
// comparison pass or fail for the wrong reason without anyone noticing,
// since the failure mode is "matches everything" rather than an error.

let counter = 0;
async function makeTestItem() {
  const id = `TEST-ITEM-MOCKCMP-${counter++}`;
  await db.createItem({
    id,
    category_id: 'phone',
    photo_url: null,
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'x',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000002',
    assigned_agent_id: null,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: true,
    description: 'x',
    is_sensitive_document: false,
    rejection_reason: null,
  } as any);
  return id;
}

describe('mock DB ordering comparisons (lte) correctly exclude future-dated rows', () => {
  it('a retryable_failure row scheduled minutes in the future is NOT returned by a "due now" query', async () => {
    const itemId = await makeTestItem();
    await db.claimSocialPublicationSlot(itemId, 'telegram', 'found_notice');
    // First attempt's backoff schedules next_attempt_at ~5 minutes ahead —
    // see recordSocialPublicationResult's exponential backoff comment.
    await db.recordSocialPublicationResult(itemId, 'telegram', 'found_notice', { status: 'retryable_failure', lastError: 'simulated' });

    const due = await db.getSocialPublicationsDueForRetry();
    expect(due.find(r => r.item_id === itemId)).toBeUndefined();
  });

  it('a manually reset row (next_attempt_at = now) IS returned by the same query', async () => {
    const itemId = await makeTestItem();
    await db.claimSocialPublicationSlot(itemId, 'facebook', 'found_notice');
    await db.recordSocialPublicationResult(itemId, 'facebook', 'found_notice', { status: 'unknown', lastError: 'simulated' });

    const publicationId = await db.getSocialPublicationId(itemId, 'facebook', 'found_notice');
    expect(publicationId).not.toBeNull();
    await db.resetSocialPublicationForManualRetry(publicationId!);

    const due = await db.getSocialPublicationsDueForRetry();
    expect(due.find(r => r.item_id === itemId)).toBeDefined();
  });
});
