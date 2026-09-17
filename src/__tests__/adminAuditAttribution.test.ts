import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';

// Regression coverage for the Phase 5A audit-attribution fix (Phase 4 finding
// D5). Two consequential admin actions previously recorded the WRONG actor:
//
//   rejectItem              -> always "SYSTEM", even when an authenticated
//                              administrator performed the rejection
//   clearPhoneReputation    -> the hard-coded literal "ADMIN"
//
// An audit trail whose entries cannot name the responsible administrator does
// not answer the question an audit trail exists to answer. These tests assert
// the actual recorded attribution value, not merely that a row was written.

const RUN = Math.floor(10000000 + Math.random() * 89999999).toString();
const ITEM_ADMIN = `TEST-P5A-ITEM-ADMIN-${RUN}`;
const ITEM_DEFAULT = `TEST-P5A-ITEM-DEFAULT-${RUN}`;
const ITEM_AGENT = `TEST-P5A-ITEM-AGENT-${RUN}`;
const PHONE = '+2547' + RUN.slice(-8);

const ADMIN_UNDER_TEST = `audit-admin-${RUN}`;
const SECOND_ADMIN = `audit-admin-2-${RUN}`;

function itemRow(id: string) {
  return {
    id,
    category_id: 'national-id',
    photo_url: 'photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: 'National ID',
    location_description: 'Nairobi CBD',
    latitude: null,
    longitude: null,
    finder_phone: PHONE,
    assigned_agent_id: null,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: true,
    rejection_reason: null,
  } as any;
}

async function auditEntriesFor(action: string, needle: string) {
  const logs = await db.getAuditLogs();
  return logs.filter((l) => l.action === action && l.details.includes(needle));
}

describe('audit attribution: item rejection records the acting administrator', () => {
  it('records the authenticated admin identity, not SYSTEM', async () => {
    await db.createItem(itemRow(ITEM_ADMIN));

    await db.rejectItem(ITEM_ADMIN, 'Rejected during admin review', ADMIN_UNDER_TEST);

    const entries = await auditEntriesFor('REJECT_ITEM', ITEM_ADMIN);
    expect(entries).toHaveLength(1);
    expect(entries[0].admin_user).toBe(ADMIN_UNDER_TEST);
    expect(entries[0].admin_user).not.toBe('SYSTEM');
    expect(entries[0].admin_user).not.toBe('ADMIN');
  });

  it('distinguishes an agent rejection from a system action', async () => {
    await db.createItem(itemRow(ITEM_AGENT));

    await db.rejectItem(ITEM_AGENT, 'Agent rejected the drop-off', 'AGENT');

    const entries = await auditEntriesFor('REJECT_ITEM', ITEM_AGENT);
    expect(entries).toHaveLength(1);
    expect(entries[0].admin_user).toBe('AGENT');
    expect(entries[0].admin_user).not.toBe('SYSTEM');
  });

  it('still defaults to an explicit SYSTEM identity when no actor is supplied', async () => {
    await db.createItem(itemRow(ITEM_DEFAULT));

    await db.rejectItem(ITEM_DEFAULT, 'Internal sweep rejection');

    const entries = await auditEntriesFor('REJECT_ITEM', ITEM_DEFAULT);
    expect(entries).toHaveLength(1);
    expect(entries[0].admin_user).toBe('SYSTEM');
  });
});

describe('audit attribution: phone reputation clearing records the acting administrator', () => {
  it('records the authenticated admin identity, not the literal ADMIN', async () => {
    await db.clearPhoneReputation(PHONE, SECOND_ADMIN);

    const entries = await auditEntriesFor('CLEAR_PHONE_REPUTATION', PHONE);
    expect(entries).toHaveLength(1);
    expect(entries[0].admin_user).toBe(SECOND_ADMIN);
    expect(entries[0].admin_user).not.toBe('ADMIN');
  });
});

// ---------------------------------------------------------------------------
// Wiring guards. The runtime tests above prove the DB layer records whatever
// actor it is given; these prove each CALLER actually supplies the real
// identity (the original bug was the admin route computing adminIdentifier and
// then not passing it).
// ---------------------------------------------------------------------------
describe('audit attribution wiring: callers pass an explicit identity', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverTs = fs.readFileSync(path.resolve(repoRoot, 'src/server.ts'), 'utf8');
  const databaseTs = fs.readFileSync(path.resolve(repoRoot, 'src/db/database.ts'), 'utf8');

  it('the admin item-rejection route passes the authenticated admin identity', () => {
    const start = serverTs.indexOf("app.post('/api/admin/items/:id/reject'");
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 1200);
    expect(body).toMatch(/const adminIdentifier = req\.user\?\.username/);
    expect(body).toMatch(/db\.rejectItem\(itemId,\s*[^)]*adminIdentifier\)/);
    expect(body).not.toMatch(/db\.rejectItem\(itemId,\s*reason \|\| 'Admin manual review rejection'\)/);
  });

  it('the admin reputation-clearing route passes the authenticated admin identity', () => {
    const start = serverTs.indexOf("app.post('/api/admin/reputations/:phone/clear'");
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 1000);
    expect(body).toMatch(/db\.clearPhoneReputation\(phone,\s*adminIdentifier\)/);
    expect(body).not.toMatch(/db\.clearPhoneReputation\(phone\)/);
  });

  it('the agent drop-off rejection route no longer impersonates a system action', () => {
    const start = serverTs.indexOf("app.post('/api/agents/reject-dropoff'");
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 2000);
    expect(body).toMatch(/db\.rejectItem\(dropoffCode,\s*reason,\s*'AGENT'\)/);
  });

  it('the database layer no longer hard-codes SYSTEM / ADMIN for these two actions', () => {
    const rejectStart = databaseTs.indexOf('public async rejectItem(');
    expect(rejectStart).toBeGreaterThan(-1);
    const rejectBody = databaseTs.slice(rejectStart, rejectStart + 1200);
    // Phase 6G moved this audit write into the same transaction as the status
    // change (logAuditInTx). Actor attribution is unchanged: the actor must
    // still be the caller, never a hard-coded SYSTEM/ADMIN.
    expect(rejectBody).toMatch(/logAuditInTx\(tx,\s*actor,\s*"REJECT_ITEM"/);
    expect(rejectBody).not.toMatch(/logAuditInTx\(tx,\s*"SYSTEM",\s*"REJECT_ITEM"/);
    expect(rejectBody).not.toMatch(/logAudit\("SYSTEM",\s*"REJECT_ITEM"/);

    const repStart = databaseTs.indexOf('public async clearPhoneReputation(');
    expect(repStart).toBeGreaterThan(-1);
    const repBody = databaseTs.slice(repStart, repStart + 1400);
    expect(repBody).toMatch(/logAudit\(actor,\s*"CLEAR_PHONE_REPUTATION"/);
    expect(repBody).not.toMatch(/logAudit\("ADMIN",\s*"CLEAR_PHONE_REPUTATION"/);
  });
});

