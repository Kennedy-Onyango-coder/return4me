import { describe, it, expect } from 'vitest';
import { db } from '../database';

// Regression test for a real performance gap: db.getPhoneReputation() —
// called on every single item report submission (POST /api/items/report)
// — used to call the unfiltered db.getItems() (every item, every status,
// every historical row) purely to filter down to one finder's own items in
// application code. getItemsByFinderPhone() pushes that filter into the
// WHERE clause instead. This test proves it's behaviorally identical to
// the old getItems() + application-level filter, and that
// getPhoneReputation() itself still produces correct autoFlag results
// after the refactor.

let counter = 0;
async function makeTestItem(phone: string, status: 'at_agent' | 'rejected') {
  const id = `TEST-ITEM-PHONESCOPED-${counter++}`;
  await db.createItem({
    id,
    category_id: 'national-id',
    photo_url: null,
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Test location',
    latitude: null,
    longitude: null,
    finder_phone: phone,
    assigned_agent_id: null,
    status,
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: true,
    rejection_reason: null,
  } as any);
  return id;
}

describe('getItemsByFinderPhone returns exactly the matching-phone subset', () => {
  it('returns only items reported by the given phone number', async () => {
    const phoneA = '+254700111001';
    const phoneB = '+254700111002';
    const itemA = await makeTestItem(phoneA, 'at_agent');
    const itemB = await makeTestItem(phoneB, 'at_agent');

    const result = await db.getItemsByFinderPhone(phoneA);
    const ids = result.map(i => i.id);

    expect(ids).toContain(itemA);
    expect(ids).not.toContain(itemB);
    expect(result.every(i => i.finder_phone === phoneA)).toBe(true);
  });

  it('matches what getItems() + an application-level phone filter would return (parity)', async () => {
    const phone = '+254700111003';
    await makeTestItem(phone, 'at_agent');

    const all = await db.getItems();
    const expected = all.filter(i => i.finder_phone === phone).map(i => i.id).sort();

    const scoped = await db.getItemsByFinderPhone(phone);
    const actual = scoped.map(i => i.id).sort();

    expect(actual).toEqual(expected);
  });
});

describe('getPhoneReputation still computes correct autoFlag after the scoped-query refactor', () => {
  it('flags a phone with >=3 reports and >30% rejection rate', async () => {
    const phone = '+254700111004';
    await makeTestItem(phone, 'rejected');
    await makeTestItem(phone, 'rejected');
    await makeTestItem(phone, 'at_agent');

    const reputation = await db.getPhoneReputation(phone);

    expect(reputation.total_reports).toBe(3);
    expect(reputation.rejected_reports).toBe(2);
    expect(reputation.autoFlag).toBe(true);
  });

  it('does not flag a phone below the report-count threshold', async () => {
    const phone = '+254700111005';
    await makeTestItem(phone, 'rejected');
    await makeTestItem(phone, 'rejected');

    const reputation = await db.getPhoneReputation(phone);

    expect(reputation.autoFlag).toBe(false);
  });
});
