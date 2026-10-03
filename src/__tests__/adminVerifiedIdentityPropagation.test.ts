// =============================================================================
// PI-1 / B5 — Agent correction → Admin representation propagation.
// =============================================================================
//
// A real DATA-PATH test (not a source-string assertion): it writes an item with
// an original OCR identity, runs the Agent correction through
// db.recordItemVerification, then reads the item back through the SAME
// toAdminSafeItemView projection the Admin console consumes.
//
// It proves two things at once:
//   1. the verified (operational) value reaches the Admin DTO, so the console
//      can show the CURRENT identity rather than the stale OCR value; and
//   2. the original OCR value is RETAINED and available for review — the
//      correction never destroys the historical extraction.
// =============================================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/database';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';
import { toAdminSafeItemView } from '../services/adminSafeViews';

let counter = 0;
const AGENT_ID = `TEST-AGENT-ADMINPROP-${testRunId}`;

beforeAll(async () => {
  await db.createAgent({
    id: AGENT_ID,
    business_name: 'Propagation Agent',
    contact_phone: `+254${testRunId}9`,
    location_address: 'Test',
    latitude: null,
    longitude: null,
    mpesa_till_or_paybill: '123456',
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-prop',
    needs_manual_geocoding: false,
  } as any);
});

describe('PI-1 B5 — verified identity reaches the Admin projection without losing OCR', () => {
  it('agent-corrected name and number surface as verified, with original OCR retained', async () => {
    const itemId = `TEST-ITEM-ADMINPROP-${testRunId}-${counter++}`;
    await ensureTestCategory('national-id');
    await db.createItem({
      id: itemId,
      category_id: 'national-id',
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: '12345678',
      ocr_extracted_name: 'JOHN DOE',
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'Eastleigh, Nairobi',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000030',
      assigned_agent_id: null,
      status: 'awaiting_dropoff',
      flaggedForReview: false,
      isDescriptionOnly: false,
      description: null,
      is_sensitive_document: true,
    } as any);

    // Agent corrects BOTH identity fields (physically verified, as required for
    // a sensitive document).
    const result = await db.recordItemVerification(
      itemId,
      AGENT_ID,
      {
        category_id: 'national-id',
        name: 'JOHN KAMAU',
        document_number: '99999999',
        description: null,
        found_area: 'Eastleigh, Nairobi',
      },
      'Corrected spelling and number',
      null,
      true,
    );
    expect(result.success).toBe(true);

    // Re-read the item as the Admin console would.
    const item = await db.getItem(itemId);
    const view = toAdminSafeItemView(item);

    // The CURRENT operational identity is the verified value…
    expect(view.verified_name).toBe('JOHN KAMAU');
    expect(view.verified_document_number).toBe('99999999');
    expect(view.verification_status).toBe('corrected');

    // …and the ORIGINAL OCR extraction is still present and distinct.
    expect(view.ocr_extracted_name).toBe('JOHN DOE');
    expect(view.ocr_extracted_number).toBe('12345678');

    // The two are never conflated: original ≠ verified.
    expect(view.ocr_extracted_name).not.toBe(view.verified_name);
    expect(view.ocr_extracted_number).not.toBe(view.verified_document_number);
  });

  it('an uncorrected item exposes OCR values with NO phantom verified identity', async () => {
    const itemId = `TEST-ITEM-ADMINPROP-${testRunId}-${counter++}`;
    await ensureTestCategory('national-id');
    await db.createItem({
      id: itemId,
      category_id: 'national-id',
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: '11111111',
      ocr_extracted_name: 'UNVERIFIED NAME',
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'Eastleigh, Nairobi',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000031',
      assigned_agent_id: null,
      status: 'awaiting_dropoff',
      flaggedForReview: false,
      isDescriptionOnly: false,
      description: null,
      is_sensitive_document: true,
    } as any);

    const view = toAdminSafeItemView(await db.getItem(itemId));

    expect(view.ocr_extracted_name).toBe('UNVERIFIED NAME');
    // No invented verified value: the projection returns null, not the OCR text.
    expect(view.verified_name).toBeNull();
    expect(view.verified_document_number).toBeNull();
    // Still pending verification — the operative fact is that it is NOT
    // 'corrected'/'confirmed_as_reported'.
    expect(view.verification_status).toBe('pending');
  });
});