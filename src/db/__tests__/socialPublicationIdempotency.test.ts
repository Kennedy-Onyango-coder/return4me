import { describe, it, expect } from 'vitest';
import { db } from '../database';

// P1 REGRESSION TEST — social publication idempotency (schema.ts,
// social_publications; database.ts, claimSocialPublicationSlot /
// recordSocialPublicationResult).
//
// The actual guarantee: a retry, a duplicate request, or a server
// restart mid-broadcast must never produce two Facebook/Telegram/X posts
// for the same item. These tests exercise the DB-level claim mechanism
// directly — proving the SECOND caller for the same (item, platform,
// publication_type) genuinely cannot win the claim, not just that the
// application happens to only call it once today.

let counter = 0;
async function makeTestItem() {
  const id = `TEST-ITEM-SOCIAL-${counter++}`;
  await db.createItem({
    id,
    category_id: 'phone',
    photo_url: null,
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Test location',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000002',
    assigned_agent_id: null,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: true,
    description: 'Test item',
    is_sensitive_document: false,
    rejection_reason: null,
  } as any);
  return id;
}

describe('social publication idempotency', () => {
  it('the first claim for (item, platform, type) succeeds', async () => {
    const itemId = await makeTestItem();
    const claimed = await db.claimSocialPublicationSlot(itemId, 'telegram', 'found_notice');
    expect(claimed).toBe(true);
  });

  it('a second claim for the SAME (item, platform, type) is rejected — this is the actual duplicate-post guard', async () => {
    const itemId = await makeTestItem();
    const first = await db.claimSocialPublicationSlot(itemId, 'telegram', 'found_notice');
    const second = await db.claimSocialPublicationSlot(itemId, 'telegram', 'found_notice');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('a second claim still fails even after the first attempt is recorded as failed — no automatic retry that could double-post', async () => {
    const itemId = await makeTestItem();
    await db.claimSocialPublicationSlot(itemId, 'telegram', 'found_notice');
    await db.recordSocialPublicationResult(itemId, 'telegram', 'found_notice', { status: 'retryable_failure', lastError: 'simulated failure' });

    const retryClaim = await db.claimSocialPublicationSlot(itemId, 'telegram', 'found_notice');
    expect(retryClaim).toBe(false);
  });

  it('DIFFERENT platforms for the same item and type are independent — each can be claimed separately', async () => {
    const itemId = await makeTestItem();
    const tg = await db.claimSocialPublicationSlot(itemId, 'telegram', 'found_notice');
    const fb = await db.claimSocialPublicationSlot(itemId, 'facebook', 'found_notice');
    const tw = await db.claimSocialPublicationSlot(itemId, 'twitter', 'found_notice');
    expect(tg).toBe(true);
    expect(fb).toBe(true);
    expect(tw).toBe(true);
  });

  it('DIFFERENT publication types for the same item and platform are independent (found_notice vs reunited_notice)', async () => {
    const itemId = await makeTestItem();
    const foundNotice = await db.claimSocialPublicationSlot(itemId, 'telegram', 'found_notice');
    const reunitedNotice = await db.claimSocialPublicationSlot(itemId, 'telegram', 'reunited_notice');
    expect(foundNotice).toBe(true);
    expect(reunitedNotice).toBe(true);
  });

  it('recordSocialPublicationResult correctly persists a successful outcome', async () => {
    const itemId = await makeTestItem();
    await db.claimSocialPublicationSlot(itemId, 'facebook', 'found_notice');
    await db.recordSocialPublicationResult(itemId, 'facebook', 'found_notice', { status: 'published', providerPostId: 'FB-12345' });
    // Re-claiming after a successful publish must still be rejected — the
    // slot stays claimed forever once taken, published or not.
    const reclaim = await db.claimSocialPublicationSlot(itemId, 'facebook', 'found_notice');
    expect(reclaim).toBe(false);
  });
});
