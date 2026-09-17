import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';
import { hashDocument } from '../../services/documentHash';
import { generateLostReportReference, isLostReportReference } from '../../services/lostReportReference';
import { DEFAULT_LOST_REPORT_STATUS } from '../../config/lostReportStatuses';

// Phase 9A — runtime persistence tests for the lost-report data model.
//
// These exercise the REAL DatabaseEngine methods against the in-memory mock
// (no DATABASE_URL in CI), the same level customerAccount.test.ts /
// claimPaymentAuth.test.ts test at. They prove the record actually persists,
// the protected identifier is stored ONLY as a hash, and the owner-scoped read
// is scoped by the query rather than by the caller remembering to compare.

const RUN = testRunId;
const CUSTOMER_A = `TEST-9A-CUS-A-${RUN}`;
const CUSTOMER_B = `TEST-9A-CUS-B-${RUN}`;

function draft(overrides: Record<string, any> = {}) {
  return {
    id: generateLostReportReference(),
    customer_id: CUSTOMER_A,
    category_id: 'national-id',
    status: DEFAULT_LOST_REPORT_STATUS,
    county: 'Nairobi City',
    location_area: 'Westlands',
    location_landmark: null,
    lost_at_from: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    lost_at_to: null,
    brand: null,
    model: null,
    colour: null,
    material: null,
    description: null,
    distinctive_marks: null,
    document_type: null,
    document_number_hash: null,
    ...overrides,
  } as any;
}

describe('lost reports: public reference generation', () => {
  it('produces LR- plus six unambiguous characters', () => {
    const ref = generateLostReportReference();
    expect(ref).toMatch(/^LR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(isLostReportReference(ref)).toBe(true);
  });

  it('is not sequential or predictable across calls', () => {
    const refs = new Set<string>();
    for (let i = 0; i < 200; i++) refs.add(generateLostReportReference());
    // 200 crypto-random draws from a ~887M keyspace must be all distinct.
    expect(refs.size).toBe(200);
  });

  it('rejects shapes that do not match the reference format', () => {
    expect(isLostReportReference('LR-12345')).toBe(false);      // too short
    expect(isLostReportReference('LR-000000')).toBe(false);     // ambiguous chars
    expect(isLostReportReference('CLM-123456')).toBe(false);    // wrong prefix
    expect(isLostReportReference('')).toBe(false);
  });
});

describe('lost reports: persistence and retrieval', () => {
  it('persists a report and reads it back owner-scoped', async () => {
    await ensureTestCategory('national-id');
    await db.createCustomer(CUSTOMER_A, 'Lost Reporter A', `+2547${String(Math.floor(10000000 + Math.random() * 89999999)).slice(-8)}`);

    const record = draft();
    const created = await db.createLostReport(record);

    expect(created.id).toBe(record.id);
    expect(created.customer_id).toBe(CUSTOMER_A);
    expect(created.category_id).toBe('national-id');
    expect(created.status).toBe('active');
    expect(created.county).toBe('Nairobi City');
    expect(created.location_area).toBe('Westlands');
    // Timestamps must be real on creation.
    expect(created.created_at).toBeTruthy();
    expect(created.updated_at).toBeTruthy();
    expect(new Date(created.created_at).getTime()).not.toBeNaN();

    const all = await db.getLostReportsByCustomer(CUSTOMER_A);
    expect(all.some((r) => r.id === record.id)).toBe(true);

    const one = await db.getLostReportByIdForCustomer(record.id, CUSTOMER_A);
    expect(one).toBeDefined();
    expect(one!.id).toBe(record.id);
  });

  it('CRITICAL: a report is invisible to any OTHER customer, even with the exact reference', async () => {
    const record = draft();
    await db.createLostReport(record);

    // Same reference, different account -> undefined (the ownership predicate
    // is part of the query, not a post-fetch comparison).
    const crossRead = await db.getLostReportByIdForCustomer(record.id, CUSTOMER_B);
    expect(crossRead).toBeUndefined();

    // And it never appears in another account's list.
    const otherList = await db.getLostReportsByCustomer(CUSTOMER_B);
    expect(otherList.some((r) => r.id === record.id)).toBe(false);

    // A non-existent reference behaves identically.
    expect(await db.getLostReportByIdForCustomer('LR-ZZZZZZ', CUSTOMER_A)).toBeUndefined();
  });

  it('stores the protected identifier as a hash and NEVER as plaintext', async () => {
    const plaintext = `9999${String(Math.floor(100000 + Math.random() * 899999))}`;
    const record = draft({ document_number_hash: hashDocument(plaintext) });
    const created = await db.createLostReport(record);

    expect(created.document_number_hash).toBe(hashDocument(plaintext));
    expect(created.document_number_hash).toHaveLength(64);
    // The plaintext must not be recoverable from the stored row.
    expect(JSON.stringify(created)).not.toContain(plaintext);
  });

  it('persists the lost-time WINDOW (from and to), not a single false-precision instant', async () => {
    const from = new Date('2026-02-01T11:00:00.000Z');
    const to = new Date('2026-02-01T14:00:00.000Z');
    const record = draft({ lost_at_from: from.toISOString(), lost_at_to: to.toISOString() });
    const created = await db.createLostReport(record);

    expect(new Date(created.lost_at_from).toISOString()).toBe(from.toISOString());
    expect(new Date(created.lost_at_to!).toISOString()).toBe(to.toISOString());
    expect(new Date(created.lost_at_to!).getTime() - new Date(created.lost_at_from).getTime())
      .toBe(3 * 60 * 60 * 1000);
  });

  it('retains private free text for the owner (description / distinctive marks)', async () => {
    const record = draft({
      description: 'Black leather handbag with a broken zip',
      distinctive_marks: 'Sticker of a lion on the front pocket',
    });
    const created = await db.createLostReport(record);
    expect(created.description).toBe('Black leather handbag with a broken zip');
    expect(created.distinctive_marks).toBe('Sticker of a lion on the front pocket');
  });
});
