import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  toAdminSafeAgentView,
  toAdminSafeItemView,
  toAdminSafeDisputeView,
  toAdminSafeAgentDocumentsView,
} from '../services/adminSafeViews';

// Regression coverage for the Phase 5A privacy remediation of the BULK admin
// dashboard payload (GET /api/admin/dashboard).
//
// The dashboard is fetched on every console page-load, so anything it carries
// reaches the browser on every refresh. These tests prove that the explicit
// admin whitelists drop the sensitive/unused database columns, and that the
// remaining operational fields the console actually renders are preserved
// (so the fix cannot silently gut the payload into uselessness).
//
// Sentinel values are deliberately distinctive strings: asserting they are
// absent from the SERIALISED object also catches the same data reappearing
// under a different key, nested inside another object, or via an alias.

const S = {
  nationalIdHash: 'NATIONAL-ID-HASH-SECRET-VALUE',
  idDocumentPhotoUrl: 'https://secret.example/agent-national-id-DOC.png',
  shopPhotoUrl: 'https://secret.example/agent-shop-front-DOC.png',
  termsAccepted: '2026-03-03T03:03:03.003Z',
  documentNumberHash: 'DOCUMENT-NUMBER-HASH-SECRET-VALUE',
  documentNameFuzzy: 'FUZZY-NAME-SECRET-VALUE',
  finderEmail: 'finder-secret@example.test',
  rejectionReason: 'INTERNAL-REJECTION-NOTE-SECRET',
  lockedTotalFee: '999.99',
  lockedFinderShare: '111.11',
  declaredValue: '12345.67',
  feeCeilingApplied: true,
  claimant1ProofUrl: 'https://secret.example/claimant-1-ID-PROOF.png',
  claimant2ProofUrl: 'https://secret.example/claimant-2-ID-PROOF.png',
  adminNotes: 'INTERNAL-DISPUTE-NOTE-SECRET',
};

// A fully-populated agent row, i.e. exactly what parseAgent() produces.
function fullAgentRow() {
  return {
    id: 'AGENT-1',
    business_name: 'Test Hub Ltd',
    contact_phone: '+254700000001',
    location_address: 'Kimathi Street, Nairobi',
    latitude: -1.28,
    longitude: 36.82,
    mpesa_till_or_paybill: '123456',
    payout_method_type: 'Till Number',
    status: 'pending',
    refundable_deposit: 500,
    rating: 4.5,
    rating_count: 12,
    needs_manual_geocoding: false,
    contact_email: 'hub@example.test',
    warning_count: 2,
    last_warning_reason: 'Late handover',
    last_warning_at: '2026-02-02T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    // fields that must NOT reach the bulk payload
    national_id_hash: S.nationalIdHash,
    id_document_photo_url: S.idDocumentPhotoUrl,
    shop_photo_url: S.shopPhotoUrl,
    terms_accepted_at: S.termsAccepted,
  };
}

// A fully-populated item row, i.e. exactly what parseFoundItem() produces.
function fullItemRow() {
  return {
    id: 'ITEM-1',
    category_id: 'national-id',
    photo_url: 'photo-key.jpg',
    ocr_extracted_number: '12345678',
    ocr_extracted_name: 'JOHN DOE',
    location_description: 'Nairobi CBD',
    latitude: -1.28,
    longitude: 36.82,
    finder_phone: '+254700000002',
    assigned_agent_id: 'AGENT-1',
    status: 'at_agent',
    flaggedForReview: true,
    isDescriptionOnly: false,
    description: 'Found near the bus stop',
    is_sensitive_document: true,
    agent_assignment_method: 'gps',
    agent_assignment_distance_km: 1.2,
    needs_manual_agent_reassignment: false,
    created_at: '2026-01-01T00:00:00.000Z',
    // fields that must NOT reach the bulk payload
    document_number_hash: S.documentNumberHash,
    document_name_fuzzy: S.documentNameFuzzy,
    finder_email: S.finderEmail,
    rejection_reason: S.rejectionReason,
    locked_total_fee: S.lockedTotalFee,
    locked_finder_share: S.lockedFinderShare,
    locked_agent_share: '222.22',
    locked_platform_share: '333.33',
    declared_value: S.declaredValue,
    fee_ceiling_applied: S.feeCeilingApplied,
  };
}

// A fully-populated dispute row, i.e. exactly what parseDispute() produces.
function fullDisputeRow() {
  return {
    id: 'DISPUTE-1',
    item_id: 'ITEM-1',
    claimant_1_claim_id: 'CLAIM-A',
    claimant_2_claim_id: 'CLAIM-B',
    resolved_by: null,
    resolved_claim_id: null,
    resolved_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    // fields that must NOT reach the bulk payload
    claimant_1_id_proof_url: S.claimant1ProofUrl,
    claimant_2_id_proof_url: S.claimant2ProofUrl,
    admin_notes: S.adminNotes,
  };
}

describe('admin dashboard bulk payload — agent DTO', () => {
  it('omits national_id_hash, the ID-document photo URL, the shop photo URL and terms_accepted_at', () => {
    const view = toAdminSafeAgentView(fullAgentRow(), { total_earned: 1500, completed_payouts_count: 3 });

    // Properties must be absent entirely, not merely undefined.
    const keys = Object.keys(view);
    expect(keys).not.toContain('national_id_hash');
    expect(keys).not.toContain('id_document_photo_url');
    expect(keys).not.toContain('shop_photo_url');
    expect(keys).not.toContain('terms_accepted_at');

    // No sentinel value survives anywhere in the serialised object (this also
    // catches the same value re-appearing nested or under an alias).
    const json = JSON.stringify(view);
    expect(json).not.toContain(S.nationalIdHash);
    expect(json).not.toContain(S.idDocumentPhotoUrl);
    expect(json).not.toContain(S.shopPhotoUrl);
    expect(json).not.toContain(S.termsAccepted);
  });

  it('preserves the operational fields the Agents Hub renders', () => {
    const view = toAdminSafeAgentView(fullAgentRow(), { total_earned: 1500, completed_payouts_count: 3 });
    expect(view.id).toBe('AGENT-1');
    expect(view.business_name).toBe('Test Hub Ltd');
    expect(view.contact_phone).toBe('+254700000001');
    expect(view.contact_email).toBe('hub@example.test');
    expect(view.status).toBe('pending');
    expect(view.mpesa_till_or_paybill).toBe('123456');
    expect(view.warning_count).toBe(2);
    expect(view.last_warning_reason).toBe('Late handover');
    expect(view.latitude).toBeCloseTo(-1.28);
    expect(view.total_earned).toBe(1500);
    expect(view.completed_payouts_count).toBe(3);
  });

  it('serves the vetting documents through a separate, explicitly-scoped DTO', () => {
    const docs = toAdminSafeAgentDocumentsView(fullAgentRow());
    expect(docs.shop_photo_url).toBe(S.shopPhotoUrl);
    expect(docs.id_document_photo_url).toBe(S.idDocumentPhotoUrl);
    // ...and still never the hash.
    expect('national_id_hash' in docs).toBe(false);
    expect(JSON.stringify(docs)).not.toContain(S.nationalIdHash);
  });
});

describe('admin dashboard bulk payload — item DTO', () => {
  it('omits document_number_hash and the other unused/derived fields', () => {
    const view = toAdminSafeItemView(fullItemRow(), { total_reports: 4, rejected_reports: 2, autoFlag: true });

    const keys = Object.keys(view);
    expect(keys).not.toContain('document_number_hash');
    expect(keys).not.toContain('document_name_fuzzy');
    expect(keys).not.toContain('finder_email');
    expect(keys).not.toContain('rejection_reason');
    expect(keys).not.toContain('locked_total_fee');
    expect(keys).not.toContain('locked_finder_share');
    expect(keys).not.toContain('locked_agent_share');
    expect(keys).not.toContain('locked_platform_share');
    expect(keys).not.toContain('declared_value');
    expect(keys).not.toContain('fee_ceiling_applied');

    const json = JSON.stringify(view);
    expect(json).not.toContain(S.documentNumberHash);
    expect(json).not.toContain(S.documentNameFuzzy);
    expect(json).not.toContain(S.finderEmail);
    expect(json).not.toContain(S.rejectionReason);
    expect(json).not.toContain(S.lockedTotalFee);
    expect(json).not.toContain(S.declaredValue);
  });

  it('preserves the fields the Found Items and Manual Review tabs render', () => {
    const view = toAdminSafeItemView(fullItemRow(), { total_reports: 4, rejected_reports: 2, autoFlag: true });
    expect(view.id).toBe('ITEM-1');
    expect(view.category_id).toBe('national-id');
    expect(view.photo_url).toBe('photo-key.jpg');
    expect(view.ocr_extracted_number).toBe('12345678');
    expect(view.ocr_extracted_name).toBe('JOHN DOE');
    expect(view.finder_phone).toBe('+254700000002');
    expect(view.assigned_agent_id).toBe('AGENT-1');
    expect(view.status).toBe('at_agent');
    expect(view.flaggedForReview).toBe(true);
    expect(view.agent_assignment_distance_km).toBe(1.2);
    expect(view.reputation).toEqual({ total_reports: 4, rejected_reports: 2, autoFlag: true });
  });
});

describe('admin dashboard bulk payload — dispute DTO', () => {
  it('omits both claimant ID-proof URLs and the internal admin notes', () => {
    const view = toAdminSafeDisputeView(fullDisputeRow());

    const keys = Object.keys(view);
    expect(keys).not.toContain('claimant_1_id_proof_url');
    expect(keys).not.toContain('claimant_2_id_proof_url');
    expect(keys).not.toContain('admin_notes');

    const json = JSON.stringify(view);
    expect(json).not.toContain(S.claimant1ProofUrl);
    expect(json).not.toContain(S.claimant2ProofUrl);
    expect(json).not.toContain(S.adminNotes);
  });

  it('preserves the operational dispute summary, now as an explicit claimants array', () => {
    const view = toAdminSafeDisputeView(fullDisputeRow());
    expect(view.id).toBe('DISPUTE-1');
    expect(view.item_id).toBe('ITEM-1');
    // Phase 5B replaced the ambiguous flat claim-id fields with an explicitly
    // role-labelled claimant summary (claimant 1 = original claim).
    expect('claimant_1_claim_id' in view).toBe(false);
    expect('claimant_2_claim_id' in view).toBe(false);
    expect(view.claimants.map((c: any) => c.role)).toEqual(['original', 'contesting']);
    expect(view.claimants[0].claim_id).toBe('CLAIM-A');
    expect(view.claimants[1].claim_id).toBe('CLAIM-B');
    expect(view.resolved_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Static guards. These catch the specific regression this remediation removes:
// the dashboard rebuilt by spreading raw database rows again, which is the
// mechanism that leaked every extra column in the first place.
// ---------------------------------------------------------------------------
describe('admin dashboard source: no raw row spreading in the bulk payload', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverTs = fs.readFileSync(path.resolve(repoRoot, 'src/server.ts'), 'utf8');

  const dashStart = serverTs.indexOf("app.get('/api/admin/dashboard'");
  const dashEnd = serverTs.indexOf("app.post('/api/admin/agents/:id/approve'");
  const dashBody = serverTs.slice(dashStart, dashEnd);
  // Comments are stripped before the spread check: the handler legitimately
  // documents the removed pattern (`{ ...agent }`) in prose, and a guard that
  // matched its own documentation would be useless.
  const dashCode = dashBody
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
    .join('\n');

  it('locates the dashboard handler (sanity check that the parser itself works)', () => {
    expect(dashStart).toBeGreaterThan(-1);
    expect(dashEnd).toBeGreaterThan(dashStart);
  });

  it('never spreads a raw agent or item row into the response', () => {
    expect(dashCode).not.toMatch(/\.\.\.\s*agent\b/);
    expect(dashCode).not.toMatch(/\.\.\.\s*item\b/);
    expect(dashCode).not.toMatch(/\.\.\.\s*dispute\b/);
  });

  it('builds agents, items and disputes through the explicit admin whitelists', () => {
    expect(dashBody).toContain('toAdminSafeAgentView(');
    expect(dashBody).toContain('toAdminSafeItemView(');
    // The dispute DTO now also receives the already-loaded claims map so each
    // claimant can be summarised without a per-dispute query.
    expect(dashBody).toContain('toAdminSafeDisputeView(d, claimsById)');
  });

  it('the on-demand agent documents route keeps the full admin authorization stack', () => {
    const start = serverTs.indexOf("app.get('/api/admin/agents/:id/documents'");
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 1200);
    expect(body).toMatch(/authenticateJWT,\s*requireCurrentAdminSession/);
    expect(body).toMatch(/role\s*!==\s*['"]admin['"]/);
    // ...and must not re-introduce the national-ID hash.
    expect(body).not.toContain('national_id_hash');
  });
});


