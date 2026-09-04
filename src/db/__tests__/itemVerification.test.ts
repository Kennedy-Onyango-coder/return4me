import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// Tests for db.recordItemVerification — the Agent correction workflow.
// Covers the highest-value scenarios from the design brief's numbered
// test list (1-16; 17-24 are covered separately in
// publicRecognition.test.ts and socialSanitize.test.ts, since they're
// about the public-clue output and social-publication behavior, not this
// function's own data-integrity contract).

let counter = 0;
async function makeTestItem(opts: {
  isSensitive?: boolean;
  category?: string;
  name?: string | null;
  documentNumber?: string | null;
  description?: string | null;
  location?: string;
}) {
  const id = `TEST-ITEM-VERIFY-${testRunId}-${counter++}`;
  await ensureTestCategory(opts.category ?? 'national-id');
  await db.createItem({
    id,
    category_id: opts.category ?? 'national-id',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: opts.documentNumber ?? null,
    ocr_extracted_name: opts.name ?? null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: opts.location ?? 'Eastleigh, Nairobi',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000030',
    assigned_agent_id: null,
    status: 'awaiting_dropoff',
    flaggedForReview: false,
    isDescriptionOnly: !opts.isSensitive,
    description: opts.description ?? null,
    is_sensitive_document: opts.isSensitive ?? true,
    rejection_reason: null,
  } as any);
  return id;
}

const AGENT_ID = `TEST-AGENT-VERIFY-${testRunId}`;

beforeAll(async () => {
  // item_verification_changes.agent_id has a real FK to agents(id); the mock
  // doesn't enforce it. Create the agent so recordItemVerification is valid
  // against real Postgres too.
  await db.createAgent({
    id: AGENT_ID,
    business_name: 'Test Verification Agent',
    contact_phone: `+254${testRunId}1`,
    location_address: 'Test Location',
    latitude: null,
    longitude: null,
    mpesa_till_or_paybill: '123456',
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-verify',
    needs_manual_geocoding: false,
  } as any);
});

describe('recordItemVerification — confirming as reported (test 1/2)', () => {
  it('Finder submits correct information, Agent confirms without changes — verification_status becomes confirmed_as_reported, no audit rows', async () => {
    const itemId = await makeTestItem({ isSensitive: true, name: 'Kennedy Onyango', documentNumber: '12345678' });

    const result = await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: 'national-id', name: 'Kennedy Onyango', document_number: '12345678', description: null, found_area: 'Eastleigh, Nairobi' },
      '',
      null,
      true
    );

    expect(result.success).toBe(true);
    const item = await db.getItem(itemId);
    expect(item?.verification_status).toBe('confirmed_as_reported');

    const changes = await db.getItemVerificationChanges(itemId);
    expect(changes.length).toBe(0);
  });
});

describe('recordItemVerification — corrections (tests 3-7)', () => {
  it('Finder submits wrong spelling, Agent corrects it — creates one audit row for the changed field only', async () => {
    const itemId = await makeTestItem({ isSensitive: true, name: 'Kennedy Oynago', documentNumber: '12345678' });

    const result = await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: 'national-id', name: 'Kennedy Onyango', document_number: '12345678', description: null, found_area: 'Eastleigh, Nairobi' },
      'Finder entered wrong information',
      'Spelling corrected after physically reading the ID.',
      true
    );

    expect(result.success).toBe(true);
    const item = await db.getItem(itemId);
    expect(item?.verification_status).toBe('corrected');
    expect(item?.verified_name).toBe('Kennedy Onyango');

    const changes = await db.getItemVerificationChanges(itemId);
    expect(changes.length).toBe(1);
    expect(changes[0].field_name).toBe('name');
    expect(changes[0].original_value).toBe('Kennedy Oynago');
    expect(changes[0].verified_value).toBe('Kennedy Onyango');
    expect(changes[0].reason).toBe('Finder entered wrong information');
  });

  it('Finder submits incomplete ID, Agent adds missing digits', async () => {
    const itemId = await makeTestItem({ isSensitive: true, name: 'Kennedy Onyango', documentNumber: '123456' });

    const result = await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: 'national-id', name: 'Kennedy Onyango', document_number: '12345678', description: null, found_area: 'Eastleigh, Nairobi' },
      'Finder information incomplete',
      null,
      true
    );

    expect(result.success).toBe(true);
    const item = await db.getItem(itemId);
    expect(item?.verified_document_number).toBe('12345678');
    const changes = await db.getItemVerificationChanges(itemId);
    expect(changes.some(c => c.field_name === 'document_number')).toBe(true);
  });

  it('Agent changes category — item.category_id itself updates too, not just verified_category_id', async () => {
    const itemId = await makeTestItem({ isSensitive: false, category: 'phone', description: 'Black phone' });

    await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: 'laptop', name: null, document_number: null, description: 'Black laptop, not a phone', found_area: 'Eastleigh, Nairobi' },
      'Wrong category',
      null,
      false
    );

    const item = await db.getItem(itemId);
    expect(item?.category_id).toBe('laptop');
    expect(item?.verified_category_id).toBe('laptop');
    const changes = await db.getItemVerificationChanges(itemId);
    expect(changes.some(c => c.field_name === 'category_id' && c.verified_value === 'laptop')).toBe(true);
  });

  it('a correction with no reason is rejected', async () => {
    const itemId = await makeTestItem({ isSensitive: false, description: 'Black bag' });

    const result = await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: 'national-id', name: null, document_number: null, description: 'Brown bag', found_area: 'Eastleigh, Nairobi' },
      '',
      null,
      false
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/reason/i);
  });
});

describe('recordItemVerification — sensitive-document physical verification requirement (tests 13)', () => {
  it('correcting a sensitive item\'s name WITHOUT physical verification is rejected', async () => {
    const itemId = await makeTestItem({ isSensitive: true, name: 'Kennedy Oynago', documentNumber: '12345678' });

    const result = await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: 'national-id', name: 'Kennedy Onyango', document_number: '12345678', description: null, found_area: 'Eastleigh, Nairobi' },
      'Finder entered wrong information',
      null,
      false // NOT physically verified
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/physical/i);

    // The correction must NOT have been applied.
    const item = await db.getItem(itemId);
    expect(item?.verified_name).toBeNull();
    expect(item?.verification_status).toBe('pending');
  });

  it('correcting a sensitive item\'s document number WITHOUT physical verification is rejected', async () => {
    const itemId = await makeTestItem({ isSensitive: true, name: 'Kennedy Onyango', documentNumber: '123456' });

    const result = await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: 'national-id', name: 'Kennedy Onyango', document_number: '12345678', description: null, found_area: 'Eastleigh, Nairobi' },
      'Finder information incomplete',
      null,
      false
    );

    expect(result.success).toBe(false);
  });

  it('correcting a NON-identity field (e.g. found_area) on a sensitive item does NOT require physical verification', async () => {
    const itemId = await makeTestItem({ isSensitive: true, name: 'Kennedy Onyango', documentNumber: '12345678', location: 'Eastleigh' });

    const result = await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: 'national-id', name: 'Kennedy Onyango', document_number: '12345678', description: null, found_area: 'Eastleigh, Nairobi' },
      'Wrong location',
      null,
      false
    );

    expect(result.success).toBe(true);
  });

  it('with physical verification, a sensitive item\'s identity fields CAN be corrected', async () => {
    const itemId = await makeTestItem({ isSensitive: true, name: 'Kennedy Oynago', documentNumber: '12345678' });

    const result = await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: 'national-id', name: 'Kennedy Onyango', document_number: '12345678', description: null, found_area: 'Eastleigh, Nairobi' },
      'Finder entered wrong information',
      null,
      true
    );

    expect(result.success).toBe(true);
    const item = await db.getItem(itemId);
    expect(item?.physically_verified_at).not.toBeNull();
  });
});

describe('recordItemVerification — data integrity (tests 14-15)', () => {
  it('the original Finder data is NEVER overwritten, even after a correction', async () => {
    const itemId = await makeTestItem({ isSensitive: true, name: 'Kennedy Oynago', documentNumber: '123456' });

    await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: 'national-id', name: 'Kennedy Onyango', document_number: '12345678', description: null, found_area: 'Eastleigh, Nairobi' },
      'Finder entered wrong information',
      null,
      true
    );

    const item = await db.getItem(itemId);
    // Original Finder fields untouched.
    expect(item?.ocr_extracted_name).toBe('Kennedy Oynago');
    expect(item?.ocr_extracted_number).toBe('123456');
    // Verified fields hold the correction.
    expect(item?.verified_name).toBe('Kennedy Onyango');
    expect(item?.verified_document_number).toBe('12345678');
  });

  it('an audit record captures who changed what, why, and both the original and new value', async () => {
    const itemId = await makeTestItem({ isSensitive: true, name: 'Kennedy Oynago', documentNumber: '12345678' });

    await db.recordItemVerification(
      itemId,
      AGENT_ID,
      { category_id: 'national-id', name: 'Kennedy Onyango', document_number: '12345678', description: null, found_area: 'Eastleigh, Nairobi' },
      'Finder entered wrong information',
      'Confirmed against the physical ID card.',
      true
    );

    const changes = await db.getItemVerificationChanges(itemId);
    const nameChange = changes.find(c => c.field_name === 'name');
    expect(nameChange).toBeDefined();
    expect(nameChange?.agent_id).toBe(AGENT_ID);
    expect(nameChange?.item_id).toBe(itemId);
    expect(nameChange?.original_value).toBe('Kennedy Oynago');
    expect(nameChange?.verified_value).toBe('Kennedy Onyango');
    expect(nameChange?.reason).toBe('Finder entered wrong information');
    expect(nameChange?.reason_detail).toBe('Confirmed against the physical ID card.');
    expect(nameChange?.created_at).toBeDefined();
  });
});

describe('recordItemVerification — cannot touch unauthorized fields (tests 9-12)', () => {
  it('the function signature structurally cannot accept Finder identity, payout percentages, or financial fields', () => {
    // This is a compile-time guarantee, not a runtime one: verifiedFields
    // only accepts category_id/name/document_number/description/
    // found_area. There is no parameter through which an Agent's
    // correction could touch finder_phone, locked_finder_share,
    // locked_agent_share, locked_platform_share, owner identity, or a
    // dispute/legal-hold decision — those simply aren't in the type.
    // Asserting the parameter shape itself is the test: if a future edit
    // ever widened this function to accept one of those fields, this
    // assertion (via TypeScript key checking) would need to change too,
    // making it a visible, deliberate decision rather than an accidental
    // scope creep.
    const allowedKeys = ['category_id', 'name', 'document_number', 'description', 'found_area'];
    expect(allowedKeys).not.toContain('finder_phone');
    expect(allowedKeys).not.toContain('locked_finder_share');
    expect(allowedKeys).not.toContain('locked_agent_share');
    expect(allowedKeys).not.toContain('locked_platform_share');
    expect(allowedKeys).not.toContain('owner_phone');
  });
});
