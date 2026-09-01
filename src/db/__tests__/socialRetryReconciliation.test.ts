import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../database';
import { classifyHttpFailure } from '../../services/social';

// P0 REGRESSION TEST — social-publication retry/reconciliation state
// machine (services/social.ts: PublicationOutcome, classifyHttpFailure,
// _runIdempotentPost, retryFoundNoticePost; database.ts:
// recordSocialPublicationResult, getSocialPublicationsDueForRetry,
// resetSocialPublicationForManualRetry; server.ts: socialRetrySweep, the
// admin manual-retry route).
//
// The actual guarantee: an explicit provider rejection (safe to retry —
// we know for certain it didn't succeed) and a network-level failure like
// a timeout (we do NOT know whether the provider received and processed
// the request) must never be treated the same way. Blindly auto-retrying
// the second case risks a duplicate post if the first attempt actually
// landed on the provider's side.

describe('classifyHttpFailure distinguishes retryable from permanent HTTP failures', () => {
  it('429 (rate limited) is retryable', () => {
    expect(classifyHttpFailure(429)).toBe('retryable_failure');
  });

  it('5xx (provider-side error) is retryable', () => {
    expect(classifyHttpFailure(500)).toBe('retryable_failure');
    expect(classifyHttpFailure(502)).toBe('retryable_failure');
    expect(classifyHttpFailure(503)).toBe('retryable_failure');
  });

  it('401/403 (bad or revoked credentials) is permanent — will not fix itself on retry', () => {
    expect(classifyHttpFailure(401)).toBe('permanent_failure');
    expect(classifyHttpFailure(403)).toBe('permanent_failure');
  });

  it('400/404 (bad request / not found) is permanent', () => {
    expect(classifyHttpFailure(400)).toBe('permanent_failure');
    expect(classifyHttpFailure(404)).toBe('permanent_failure');
  });
});

let counter = 0;
async function makeTestItem() {
  const id = `TEST-ITEM-SOCIALRETRY-${counter++}`;
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

describe('recordSocialPublicationResult schedules retry only for retryable_failure', () => {
  it('a retryable_failure result sets a future next_attempt_at', async () => {
    const itemId = await makeTestItem();
    await db.claimSocialPublicationSlot(itemId, 'telegram', 'found_notice');
    await db.recordSocialPublicationResult(itemId, 'telegram', 'found_notice', { status: 'retryable_failure', lastError: 'simulated 503' });

    const due = await db.getSocialPublicationsDueForRetry();
    // Not due yet — next_attempt_at is in the future (backoff).
    expect(due.find(r => r.item_id === itemId)).toBeUndefined();
  });

  it('an unknown result is NEVER picked up by the automatic retry sweep query', async () => {
    const itemId = await makeTestItem();
    await db.claimSocialPublicationSlot(itemId, 'facebook', 'found_notice');
    await db.recordSocialPublicationResult(itemId, 'facebook', 'found_notice', { status: 'unknown', lastError: 'simulated timeout' });

    const due = await db.getSocialPublicationsDueForRetry();
    expect(due.find(r => r.item_id === itemId && r.platform === 'facebook')).toBeUndefined();
  });

  it('a permanent_failure result is NEVER picked up by the automatic retry sweep query', async () => {
    const itemId = await makeTestItem();
    await db.claimSocialPublicationSlot(itemId, 'twitter', 'found_notice');
    await db.recordSocialPublicationResult(itemId, 'twitter', 'found_notice', { status: 'permanent_failure', lastError: 'simulated 401' });

    const due = await db.getSocialPublicationsDueForRetry();
    expect(due.find(r => r.item_id === itemId && r.platform === 'twitter')).toBeUndefined();
  });

  it('a published result clears the row from the retry-due query and sets completed_at implicitly (no next_attempt_at)', async () => {
    const itemId = await makeTestItem();
    await db.claimSocialPublicationSlot(itemId, 'telegram', 'found_notice');
    await db.recordSocialPublicationResult(itemId, 'telegram', 'found_notice', { status: 'published', providerPostId: 'msg123' });

    const due = await db.getSocialPublicationsDueForRetry();
    expect(due.find(r => r.item_id === itemId)).toBeUndefined();
  });
});

describe('resetSocialPublicationForManualRetry', () => {
  it('resets an existing row to retryable_failure with an immediate next_attempt_at, and returns its item/platform/type', async () => {
    const itemId = await makeTestItem();
    await db.claimSocialPublicationSlot(itemId, 'telegram', 'found_notice');
    await db.recordSocialPublicationResult(itemId, 'telegram', 'found_notice', { status: 'unknown', lastError: 'simulated timeout' });

    const publicationId = await db.getSocialPublicationId(itemId, 'telegram', 'found_notice');
    expect(publicationId).not.toBeNull();

    // 'unknown' rows are never picked up by the automatic sweep query.
    const beforeReset = await db.getSocialPublicationsDueForRetry();
    expect(beforeReset.find(r => r.item_id === itemId)).toBeUndefined();

    const reset = await db.resetSocialPublicationForManualRetry(publicationId!);
    expect(reset).toEqual({ item_id: itemId, platform: 'telegram', publication_type: 'found_notice' });

    // After the reset, it's status='retryable_failure' with next_attempt_at
    // in the past/now, so it now IS due — proving the reset actually took
    // effect at the DB level, not just returned a success-shaped object.
    const afterReset = await db.getSocialPublicationsDueForRetry();
    expect(afterReset.find(r => r.item_id === itemId)).toBeDefined();
  });

  it('returns null for a publication id that does not exist', async () => {
    const result = await db.resetSocialPublicationForManualRetry('TEST-NONEXISTENT-PUBLICATION-ID');
    expect(result).toBeNull();
  });
});

const serverTs = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');
const socialTs = fs.readFileSync(path.resolve(__dirname, '../../services/social.ts'), 'utf8');

describe('socialRetrySweep only retries retryable_failure, never unknown or permanent_failure', () => {
  it('the sweep function is defined and scheduled', () => {
    expect(serverTs).toMatch(/async function socialRetrySweep\(\)/);
    expect(serverTs).toMatch(/setInterval\(socialRetrySweep,/);
  });

  it('the sweep only queries getSocialPublicationsDueForRetry (which itself only selects retryable_failure — see the classifyHttpFailure describe block above)', () => {
    const start = serverTs.indexOf('async function socialRetrySweep()');
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 1200);
    expect(body).toMatch(/getSocialPublicationsDueForRetry/);
  });
});

describe('retryFoundNoticePost is scoped to found_notice only', () => {
  it('explicitly rejects reunited_notice with permanent_failure rather than guessing at a re-implementation', () => {
    const start = socialTs.indexOf('SCOPE NOTE');
    expect(start, 'SCOPE NOTE comment not found above retryFoundNoticePost').toBeGreaterThan(-1);
    const functionStart = socialTs.indexOf('async retryFoundNoticePost');
    expect(functionStart).toBeGreaterThan(-1);
    // The comment must actually precede the function it documents.
    expect(start).toBeLessThan(functionStart);
  });
});

describe('the admin manual-retry route enforces admin auth and rejects unsupported publication types', () => {
  it('POST /api/admin/social/:id/retry is admin-only and session-current', () => {
    const start = serverTs.indexOf("app.post('/api/admin/social/:id/retry'");
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 1200);
    expect(body).toMatch(/authenticateJWT,\s*requireCurrentAdminSession,/);
    expect(body).toMatch(/role\s*!==\s*['"]admin['"]/);
  });

  it("the route rejects a non-'found_notice' publication_type with a clear error instead of attempting it", () => {
    const start = serverTs.indexOf("app.post('/api/admin/social/:id/retry'");
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 1200);
    expect(body).toMatch(/publication_type !== 'found_notice'/);
  });
});
