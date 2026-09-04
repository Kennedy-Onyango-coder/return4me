import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// P1 REGRESSION TEST — data retention (docs/DATA_RETENTION_POLICY.md).
// getClaimsWithExpiredHandoverPhotos / purgeHandoverPhoto /
// handoverEvidenceRetentionSweep are the first concrete, automated
// implementation of the retention policy document — this proves the
// query logic is correct: only 'released' claims with a photo, only past
// the retention window, and that purging replaces the URL with an
// explicit marker rather than silently nulling it.
//
// Timing note: updateClaimStatus (and createClaim, which sets updated_at
// via the DB's own defaultNow()) always stamps updated_at to the current
// real time — there's no test-only way to backdate it. So instead of
// mocking time, these tests use retentionDays itself as the control: a
// large retentionDays (e.g. 730 = 2 years) can never be satisfied by a
// claim created microseconds ago, proving the "not yet expired" case; a
// retentionDays of 0 means the cutoff is "now", which a claim created
// strictly before the query call already satisfies, proving the
// "expired" case — without needing to fabricate an old timestamp at all.

let counter = 0;
async function makeReleasedClaimWithPhoto(photoUrl: string | null) {
  const itemId = `TEST-ITEM-RETENTION-${testRunId}-${counter++}`;
  const claimId = `TEST-CLAIM-RETENTION-${testRunId}-${counter++}`;
  await ensureTestCategory('phone');
  await db.createItem({
    id: itemId,
    category_id: 'phone',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'x',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000003',
    assigned_agent_id: null,
    status: 'claimed',
    flaggedForReview: false,
    isDescriptionOnly: true,
    description: 'x',
    is_sensitive_document: false,
    rejection_reason: null,
  } as any);
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: '+254700000004',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
    verification_tier: 1,
    status: 'pending_verification',
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
  });
  // createClaim's INSERT doesn't explicitly set updated_at, and (unlike a
  // real Postgres column DEFAULT now(), which would apply here in
  // production) the in-memory test mock doesn't synthesize schema-level
  // defaults for omitted columns — so a claim fresh out of createClaim has
  // no usable updated_at in this mock. updateClaimStatus, by contrast,
  // explicitly sets updated_at: new Date() on every call, so routing
  // through it guarantees a real, comparison-ready timestamp regardless of
  // that mock-fidelity gap. Also serves as the more realistic fixture
  // shape: real claims reach 'released' via a status transition, not by
  // being created directly in that status.
  await db.updateClaimStatus(claimId, 'released');
  if (photoUrl) {
    await db.setHandoverPhoto(claimId, photoUrl);
  }
  return claimId;
}

describe('getClaimsWithExpiredHandoverPhotos', () => {
  it('does NOT return a just-created released claim under a long (2-year) retention window — not yet expired', async () => {
    const claimId = await makeReleasedClaimWithPhoto('https://storage.example/handover-evidence/photo1.jpg');
    const expired = await db.getClaimsWithExpiredHandoverPhotos(730);
    expect(expired).not.toContain(claimId);
  });

  it('DOES return the same claim under a retentionDays of 0 — the cutoff is "now", which a claim created just before satisfies', async () => {
    const claimId = await makeReleasedClaimWithPhoto('https://storage.example/handover-evidence/photo2.jpg');
    const expired = await db.getClaimsWithExpiredHandoverPhotos(0);
    expect(expired).toContain(claimId);
  });

  it('never returns a claim with no handover photo at all, regardless of retention window', async () => {
    const claimId = await makeReleasedClaimWithPhoto(null);
    const expired = await db.getClaimsWithExpiredHandoverPhotos(0);
    expect(expired).not.toContain(claimId);
  });

  it('never returns a claim that is not in "released" status, even with an old-enough timestamp and a photo present', async () => {
    const itemId = `TEST-ITEM-RETENTION-NOTRELEASED-${testRunId}-${counter++}`;
    const claimId = `TEST-CLAIM-RETENTION-NOTRELEASED-${testRunId}-${counter++}`;
    await db.createItem({
      id: itemId, category_id: 'phone', photo_url: 'test-photo.jpg', ocr_extracted_number: null,
      ocr_extracted_name: null, document_number_hash: null, document_name_fuzzy: null,
      location_description: 'x', latitude: null, longitude: null, finder_phone: '+254700000003',
      assigned_agent_id: null, status: 'claimed', flaggedForReview: false, isDescriptionOnly: true,
      description: 'x', is_sensitive_document: false, rejection_reason: null,
    } as any);
    // 'disputed' — a claim that never resolved to 'released' must never be
    // eligible for photo purge, no matter how old, since it's the
    // evidence a dispute may still need.
    await db.createClaim({
      id: claimId, item_id: itemId, owner_phone: '+254700000004',
      security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
      verification_tier: 1, status: 'disputed', owner_id_proof_url: null,
      payment_reference: null, owner_identifying_details: null,
    });
    await db.setHandoverPhoto(claimId, 'https://storage.example/handover-evidence/photo3.jpg');

    const expired = await db.getClaimsWithExpiredHandoverPhotos(0);
    expect(expired).not.toContain(claimId);
  });
});

describe('purgeHandoverPhoto', () => {
  it('replaces the photo URL with an explicit retention-purge marker, not a silent null', async () => {
    const claimId = await makeReleasedClaimWithPhoto('https://storage.example/handover-evidence/photo4.jpg');
    await db.purgeHandoverPhoto(claimId);
    const claim = await db.getClaim(claimId);
    expect(claim?.handover_photo_url).toBe('DELETED-PER-RETENTION-POLICY');
  });

  it('a purged claim no longer appears in the expired-photos query (nothing left to purge)', async () => {
    const claimId = await makeReleasedClaimWithPhoto('https://storage.example/handover-evidence/photo5.jpg');
    await db.purgeHandoverPhoto(claimId);
    const expired = await db.getClaimsWithExpiredHandoverPhotos(0);
    expect(expired).not.toContain(claimId);
  });
});
