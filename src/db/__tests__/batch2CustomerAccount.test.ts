import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db as drizzleDb } from '../../db/index.ts';
import {
  customers as customersTable,
  customer_sessions as sessionsTable,
  customer_otps as customerOtpsTable,
  customer_identity_changes as identityChangesTable,
  customer_claim_links as linksTable,
  claims as claimsTable,
  customer_notifications as notificationsTable,
  items as itemsTable,
} from '../../db/schema.ts';
import { hashCode, toE164Kenyan } from '../../services/auth.ts';
import {
  CUSTOMER_SESSION_INACTIVITY_TIMEOUT_MS,
  deriveDeviceLabel,
  isIdentityChangeUsable,
  isSessionIdle,
  CUSTOMER_ACCOUNT_STRINGS,
} from '../../config/customerAccountPolicy.ts';
import { db } from '../../db/database.ts';

// =============================================================================
// BATCH 2 - CUSTOMER ACCOUNT DATA & SESSION SECURITY.
//
// PURE-POLICY tests run with no database at all: the inactivity boundary and the
// device-label derivation are decisions, and testing them here pins the exact
// millisecond and the exact wording rather than only exercising them through a
// request.
//
// DATABASE tests use REAL ROWS, because what is under test is almost entirely
// WHERE clauses: who a session list can contain, whose identifier an update can
// touch, and whether a purge removes PII without removing the financial record.
// A mock would pass all of those and prove nothing.
// =============================================================================

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-01T12:00:00.000Z');

let seq = 0;
const nextId = (p: string) => `${p}-B2-${String(++seq).padStart(6, '0')}`;

async function seedCustomer(overrides: Partial<typeof customersTable.$inferInsert> = {}) {
  const id = overrides.id ?? nextId('CUS');
  await drizzleDb.insert(customersTable).values({
    id,
    full_name: 'Batch Two Customer',
    phone: `+254711${String(100000 + seq).slice(-6)}`,
    status: 'active',
    email: `${id.toLowerCase()}@example.test`,
    ...overrides,
  } as any);
  return id;
}

async function seedSession(opts: {
  customerId: string;
  lastSeenAt?: Date | null;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
  userAgent?: string | null;
}) {
  const id = nextId('CSES');
  await drizzleDb.insert(sessionsTable).values({
    id,
    customer_id: opts.customerId,
    token_hash: hashCode('token-' + id),
    expires_at: opts.expiresAt ?? new Date(NOW.getTime() + 7 * DAY),
    last_seen_at: opts.lastSeenAt ?? NOW,
    revoked_at: opts.revokedAt ?? null,
    user_agent: opts.userAgent ?? null,
  });
  return id;
}

// ---------------------------------------------------------------------------
// H10 - INACTIVITY BOUNDARY (pure, exact)
// ---------------------------------------------------------------------------
describe('B2 H10 - session inactivity rule', () => {
  it('a fresh session is not idle', () => {
    expect(isSessionIdle(NOW, new Date(NOW.getTime() + 1000))).toBe(false);
  });

  it('just BELOW the timeout is still accepted', () => {
    const idle = CUSTOMER_SESSION_INACTIVITY_TIMEOUT_MS - 1;
    expect(isSessionIdle(new Date(NOW.getTime() - idle), NOW)).toBe(false);
  });

  it('EXACTLY at the timeout is still accepted (strict comparison)', () => {
    // The boundary is decided explicitly rather than left to chance: idle only
    // once the duration is strictly GREATER than the window.
    expect(isSessionIdle(new Date(NOW.getTime() - CUSTOMER_SESSION_INACTIVITY_TIMEOUT_MS), NOW)).toBe(
      false,
    );
  });

  it('one millisecond BEYOND the timeout is rejected', () => {
    const idle = CUSTOMER_SESSION_INACTIVITY_TIMEOUT_MS + 1;
    expect(isSessionIdle(new Date(NOW.getTime() - idle), NOW)).toBe(true);
  });

  it('a long-idle session is rejected', () => {
    expect(isSessionIdle(new Date(NOW.getTime() - 30 * DAY), NOW)).toBe(true);
  });

  it('a NULL last-seen is NOT treated as idle', () => {
    // Failing the other way would lock out legacy sessions on the strength of a
    // missing value, which is the wrong direction to fail.
    expect(isSessionIdle(null, NOW)).toBe(false);
    expect(isSessionIdle(undefined, NOW)).toBe(false);
  });

  it('accepts an ISO string as well as a Date', () => {
    expect(isSessionIdle(new Date(NOW.getTime() - 30 * DAY).toISOString(), NOW)).toBe(true);
  });

  it('the window is strictly shorter than the absolute session lifetime', () => {
    // CUSTOMER_SESSION_TTL_MS (7 days) is the absolute cap; inactivity must be the
    // stricter rule or it could never fire.
    expect(CUSTOMER_SESSION_INACTIVITY_TIMEOUT_MS).toBeLessThan(7 * DAY);
  });

  it('the idle message names no middleware, timeout or internal term', () => {
    const text = CUSTOMER_ACCOUNT_STRINGS.sessionIdle.en.toLowerCase();
    for (const banned of ['middleware', 'token', 'session cookie', 'timeout', 'api', 'provider', 'retry']) {
      expect(text).not.toContain(banned);
    }
    expect(text).toContain('sign in again');
  });
});

// ---------------------------------------------------------------------------
// H9-a - DEVICE LABELS (pure)
// ---------------------------------------------------------------------------
describe('B2 H9-a - device label derivation', () => {
  it('names a common desktop browser and system', () => {
    const d = deriveDeviceLabel(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    );
    expect(d.label).toBe('Chrome on Windows');
    expect(d.platform).toBe('desktop');
  });

  it('names a mobile browser', () => {
    const d = deriveDeviceLabel(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
    );
    expect(d.platform).toBe('mobile');
    expect(d.browser).toBe('Chrome');
  });

  it('distinguishes Edge from Chrome, which both advertise Safari', () => {
    const edge = deriveDeviceLabel(
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120',
    );
    expect(edge.browser).toBe('Edge');
  });

  it('an unrecognised agent yields an honest label, never a blank', () => {
    const d = deriveDeviceLabel('something-unheard-of/1.0');
    expect(d.label).toBeTruthy();
  });

  it('a missing agent yields Unknown device', () => {
    expect(deriveDeviceLabel(null).label).toBe('Unknown device');
    expect(deriveDeviceLabel('').label).toBe('Unknown device');
  });

  it('NEVER returns any part of the raw agent', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36';
    const serialised = JSON.stringify(deriveDeviceLabel(ua));
    expect(serialised).not.toContain('Mozilla');
    expect(serialised).not.toContain('537.36');
  });
});

// ---------------------------------------------------------------------------
// G3 - IDENTITY CHANGE USABILITY (pure)
// ---------------------------------------------------------------------------
describe('B2 G3 - identity change usability', () => {
  const base = { expires_at: new Date(NOW.getTime() + 60_000), consumed_at: null };

  it('a live change is usable', () => {
    expect(isIdentityChangeUsable(base, NOW)).toBe(true);
  });

  it('a consumed change is not usable', () => {
    expect(isIdentityChangeUsable({ ...base, consumed_at: NOW }, NOW)).toBe(false);
  });

  it('an expired change is not usable', () => {
    expect(isIdentityChangeUsable({ ...base, expires_at: new Date(NOW.getTime() - 1) }, NOW)).toBe(false);
  });

  it('a missing change is not usable', () => {
    expect(isIdentityChangeUsable(null, NOW)).toBe(false);
    expect(isIdentityChangeUsable(undefined, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H9-a / H9-b - SESSIONS (real rows: the WHERE clause IS the product)
// ---------------------------------------------------------------------------
describe('B2 H9 - session scoping and revoke-others', () => {
  let mine: string;
  let theirs: string;

  beforeEach(async () => {
    await drizzleDb.delete(sessionsTable);
    await drizzleDb.delete(customersTable);
    mine = await seedCustomer();
    theirs = await seedCustomer();
  });

  afterEach(async () => {
    await drizzleDb.delete(sessionsTable);
    await drizzleDb.delete(customersTable);
  });

  it('lists ONLY the requesting customer sessions', async () => {
    await seedSession({ customerId: mine });
    await seedSession({ customerId: mine });
    await seedSession({ customerId: theirs });

    const rows = await db.listCustomerSessions(mine);
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.customer_id === mine)).toBe(true);
  });

  it('an unknown customer id yields an empty list, never another customer data', async () => {
    await seedSession({ customerId: theirs });
    expect(await db.listCustomerSessions('CUS-DOES-NOT-EXIST')).toEqual([]);
  });

  it('stores the device but truncates an over-long agent', async () => {
    // Exercised through the REAL creation path, not a hand-written insert: the
    // truncation is createCustomerSession's job, so a test that seeded the column
    // directly would assert nothing about it.
    const long = 'x'.repeat(2000);
    const id = nextId('CSES');
    await db.createCustomerSession(id, mine, hashCode('tok-' + id), new Date(NOW.getTime() + 7 * DAY), long);
    const [row] = await drizzleDb.select().from(sessionsTable).where(eq(sessionsTable.id, id));
    expect(row.user_agent!.length).toBe(512);
  });

  it('createCustomerSession stores the agent it is given', async () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36';
    const id = nextId('CSES');
    await db.createCustomerSession(id, mine, hashCode('tok-' + id), new Date(NOW.getTime() + 7 * DAY), ua);
    const [row] = await drizzleDb.select().from(sessionsTable).where(eq(sessionsTable.id, id));
    expect(row.user_agent).toBe(ua);
  });

  it('createCustomerSession without an agent leaves it NULL', async () => {
    const id = nextId('CSES');
    await db.createCustomerSession(id, mine, hashCode('tok-' + id), new Date(NOW.getTime() + 7 * DAY));
    const [row] = await drizzleDb.select().from(sessionsTable).where(eq(sessionsTable.id, id));
    expect(row.user_agent).toBeNull();
  });

  it('a session with no agent stores NULL, not an empty string', async () => {
    const id = await seedSession({ customerId: mine, userAgent: null });
    const [row] = await drizzleDb.select().from(sessionsTable).where(eq(sessionsTable.id, id));
    expect(row.user_agent).toBeNull();
  });

  it('revoke-others keeps the CURRENT session and revokes the rest', async () => {
    const current = await seedSession({ customerId: mine });
    const other = await seedSession({ customerId: mine });
    expect(await db.revokeAllOtherCustomerSessions(mine, current, NOW)).toBe(1);

    const kept = (await drizzleDb.select().from(sessionsTable).where(eq(sessionsTable.id, current)))[0];
    const gone = (await drizzleDb.select().from(sessionsTable).where(eq(sessionsTable.id, other)))[0];
    expect(kept.revoked_at).toBeNull(); // survives by construction
    expect(gone.revoked_at).not.toBeNull();
  });

  it('revoke-others NEVER touches another customer session', async () => {
    const current = await seedSession({ customerId: mine });
    const theirSession = await seedSession({ customerId: theirs });
    await db.revokeAllOtherCustomerSessions(mine, current, NOW);
    const [row] = await drizzleDb.select().from(sessionsTable).where(eq(sessionsTable.id, theirSession));
    expect(row.revoked_at).toBeNull();
  });

  it('revoke-others is safely repeatable', async () => {
    const current = await seedSession({ customerId: mine });
    await seedSession({ customerId: mine });
    expect(await db.revokeAllOtherCustomerSessions(mine, current, NOW)).toBe(1);
    // Second call finds nothing left to revoke, and must not restamp or error.
    expect(await db.revokeAllOtherCustomerSessions(mine, current, NOW)).toBe(0);
    const [row] = await drizzleDb.select().from(sessionsTable).where(eq(sessionsTable.id, current));
    expect(row.revoked_at).toBeNull();
  });

  it('an already-revoked session keeps its ORIGINAL revocation time', async () => {
    const older = new Date(NOW.getTime() - DAY);
    const other = await seedSession({ customerId: mine, revokedAt: older });
    const current = await seedSession({ customerId: mine });
    await db.revokeAllOtherCustomerSessions(mine, current, NOW);
    const [row] = await drizzleDb.select().from(sessionsTable).where(eq(sessionsTable.id, other));
    expect(new Date(row.revoked_at!).getTime()).toBe(older.getTime());
  });

  it('a session id belonging to another customer cannot be revoked by guessing', async () => {
    // revokeAllOtherCustomerSessions takes the CUSTOMER id, not a session id, so
    // there is no path that accepts an arbitrary session identifier at all.
    const theirSession = await seedSession({ customerId: theirs });
    const myCurrent = await seedSession({ customerId: mine });
    await db.revokeAllOtherCustomerSessions(mine, theirSession, NOW);
    const [row] = await drizzleDb.select().from(sessionsTable).where(eq(sessionsTable.id, theirSession));
    expect(row.revoked_at).toBeNull();
    expect(myCurrent).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// G1 - DATA EXPORT (real rows; the deny-list is the point)
// ---------------------------------------------------------------------------
describe('B2 G1 - customer data export', () => {
  let mine: string;
  let theirs: string;
  let minePhone: string;

  beforeEach(async () => {
    await drizzleDb.delete(notificationsTable);
    await drizzleDb.delete(linksTable);
    await drizzleDb.delete(claimsTable);
    await drizzleDb.delete(sessionsTable);
    await drizzleDb.delete(customersTable);
    minePhone = '+254712220001';
    mine = await seedCustomer({ phone: minePhone });
    theirs = await seedCustomer({ phone: '+254712220002' });
  });

  afterEach(async () => {
    await drizzleDb.delete(notificationsTable);
    await drizzleDb.delete(linksTable);
    await drizzleDb.delete(claimsTable);
    await drizzleDb.delete(sessionsTable);
    await drizzleDb.delete(customersTable);
  });

  async function seedClaim(id: string, ownerPhone: string, status = 'pending_verification') {
    await drizzleDb.insert(claimsTable).values({
      id,
      owner_phone: ownerPhone,
      security_answers: {},
      status,
      paid_at: null,
    } as any);
  }

  it('exports the customer own profile', async () => {
    const data = await db.exportCustomerData(mine);
    expect(data.account.id).toBe(mine);
    expect(data.account.phone).toBe(minePhone);
  });

  it('exports ONLY linked claims', async () => {
    await seedClaim('CLM-MINE-1', minePhone);
    await seedClaim('CLM-THEIRS-1', '+254712220002');
    await drizzleDb.insert(linksTable).values({
      id: nextId('LNK'),
      customer_id: mine,
      claim_id: 'CLM-MINE-1',
      linked_via: 'claim_otp',
    });

    const data = await db.exportCustomerData(mine);
    expect(data.claims.map((c: any) => c.id)).toEqual(['CLM-MINE-1']);
    // Another customer's claim is absent even though it exists in the table.
    expect(JSON.stringify(data)).not.toContain('CLM-THEIRS-1');
  });

  it('an UNLINKED claim is not exported even for the same phone', async () => {
    // "My claims" means linked claims, never "every claim on this number".
    await seedClaim('CLM-NOT-LINKED', minePhone);
    const data = await db.exportCustomerData(mine);
    expect(data.claims).toEqual([]);
  });

  it('exports the customer own sessions WITHOUT the token hash', async () => {
    await seedSession({ customerId: mine, userAgent: 'Mozilla/5.0 Chrome/120' });
    const data = await db.exportCustomerData(mine);
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].device).toBeTruthy();
    const serialised = JSON.stringify(data);
    expect(serialised).not.toContain('token_hash');
    expect(serialised).not.toContain(hashCode('token-'));
  });

  it('exports no OTHER customer session', async () => {
    await seedSession({ customerId: theirs });
    const data = await db.exportCustomerData(mine);
    expect(data.sessions).toEqual([]);
  });

  it('DENY-LIST: no secret, credential or infrastructure field appears', async () => {
    await seedClaim('CLM-MINE-1', minePhone);
    await drizzleDb.insert(linksTable).values({
      id: nextId('LNK'),
      customer_id: mine,
      claim_id: 'CLM-MINE-1',
      linked_via: 'claim_otp',
    });
    await seedSession({ customerId: mine });
    const data = await db.exportCustomerData(mine);
    const serialised = JSON.stringify(data).toLowerCase();

    for (const banned of [
      'token_hash',
      'code_hash',
      'otp',
      'password',
      'secret',
      'apikey',
      'api_key',
      'credential',
      'provider',
      'webhook',
      'retry',
      'last_error',
      'idempotency',
      'next_attempt',
      'user_agent',
      'ocr',
    ]) {
      expect(serialised).not.toContain(banned);
    }
  });

  it('DENY-LIST: the raw device string is never exported', async () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36';
    const id = nextId('CSES');
    await db.createCustomerSession(id, mine, hashCode('tok-' + id), new Date(Date.now() + DAY), ua);
    const data = await db.exportCustomerData(mine);
    const serialised = JSON.stringify(data);
    expect(serialised).not.toContain('Mozilla');
    expect(serialised).not.toContain('537.36');
  });

  it('an unknown customer yields null, not an empty-but-truthy payload', async () => {
    expect(await db.exportCustomerData('CUS-NOBODY')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// G2 - ERASURE (PII removed, financial/audit PRESERVED)
// ---------------------------------------------------------------------------
describe('B2 G2 - account erasure', () => {
  let cust: string;
  let phone: string;

  beforeEach(async () => {
    await drizzleDb.delete(notificationsTable);
    await drizzleDb.delete(linksTable);
    await drizzleDb.delete(claimsTable);
    await drizzleDb.delete(customersTable);
    phone = '+254713330001';
    cust = await seedCustomer({ phone, full_name: 'Erasure Subject' });
  });

  afterEach(async () => {
    await drizzleDb.delete(notificationsTable);
    await drizzleDb.delete(linksTable);
    await drizzleDb.delete(claimsTable);
    await drizzleDb.delete(customersTable);
  });

  it('redacts the customer PII but PRESERVES the claim record', async () => {
    await drizzleDb.insert(claimsTable).values({
      id: 'CLM-KEEP-1',
      owner_phone: phone,
      security_answers: {},
      status: 'escrow_held',
    } as any);
    await drizzleDb.insert(linksTable).values({
      id: nextId('LNK'),
      customer_id: cust,
      claim_id: 'CLM-KEEP-1',
      linked_via: 'claim_otp',
    });

    await db.purgeUserData(phone);

    const [claim] = await drizzleDb.select().from(claimsTable).where(eq(claimsTable.id, 'CLM-KEEP-1'));
    // The FINANCIAL/audit claim survives; only the owner PII is redacted. This is
    // the locked principle from docs/DATA_RETENTION_POLICY.md, asserted directly.
    expect(claim).toBeTruthy();
    expect(claim.status).toBe('escrow_held');
    expect(claim.owner_phone).toBe('[REDACTED-DPA-2019]');

    const [customer] = await drizzleDb.select().from(customersTable).where(eq(customersTable.id, cust));
    expect(customer.full_name).toBe('[REDACTED-DPA-2019]');
    expect(customer.status).toBe('suspended');
  });

  it('removes the account-to-claim LINK while keeping the claim', async () => {
    await drizzleDb.insert(claimsTable).values({
      id: 'CLM-KEEP-2',
      owner_phone: phone,
      security_answers: {},
      status: 'released',
    } as any);
    await drizzleDb.insert(linksTable).values({
      id: nextId('LNK'),
      customer_id: cust,
      claim_id: 'CLM-KEEP-2',
      linked_via: 'claim_otp',
    });

    await db.purgeUserData(phone);

    expect(await drizzleDb.select().from(linksTable)).toHaveLength(0);
    expect(await drizzleDb.select().from(claimsTable).where(eq(claimsTable.id, 'CLM-KEEP-2'))).toHaveLength(1);
  });

  it('removes this customer notifications, preferences and their audit', async () => {
    // purgeUserData predates the Batch 1 tables, so without the Batch 2 step an
    // erased account would keep its full message history.
    await drizzleDb.insert(notificationsTable).values({
      id: nextId('CN'),
      customer_id: cust,
      category: 'claim_status',
      title: 'Claim update',
      expires_at: new Date(Date.now() + DAY),
      created_via_fallback: false,
      created_at: new Date(),
    } as any);

    await db.purgeCustomerNotifications(cust);

    expect(await drizzleDb.select().from(notificationsTable)).toHaveLength(0);
  });

  it('purgeCustomerNotifications removes ONLY this customer rows', async () => {
    const other = await seedCustomer({ phone: '+254713330002' });
    await drizzleDb.insert(notificationsTable).values({
      id: nextId('CN'),
      customer_id: cust,
      category: 'claim_status',
      title: 'Mine',
      expires_at: new Date(Date.now() + DAY),
      created_via_fallback: false,
      created_at: new Date(),
    } as any);
    await drizzleDb.insert(notificationsTable).values({
      id: nextId('CN'),
      customer_id: other,
      category: 'claim_status',
      title: 'Theirs',
      expires_at: new Date(Date.now() + DAY),
      created_via_fallback: false,
      created_at: new Date(),
    } as any);

    await db.purgeCustomerNotifications(cust);

    const left = await drizzleDb.select().from(notificationsTable);
    expect(left).toHaveLength(1);
    expect(left[0].customer_id).toBe(other);
  });

  it('erasure is safe to repeat', async () => {
    await drizzleDb.insert(claimsTable).values({
      id: 'CLM-KEEP-3',
      owner_phone: phone,
      security_answers: {},
      status: 'refunded',
    } as any);
    await db.purgeUserData(phone);
    await db.purgeUserData(phone);
    const claims = await drizzleDb.select().from(claimsTable).where(eq(claimsTable.id, 'CLM-KEEP-3'));
    expect(claims).toHaveLength(1); // still preserved after a second pass
  });

  it('does not touch ANOTHER customer on the same erasure', async () => {
    const other = await seedCustomer({ phone: '+254713330003', full_name: 'Untouched Person' });
    await db.purgeUserData(phone);
    const [row] = await drizzleDb.select().from(customersTable).where(eq(customersTable.id, other));
    expect(row.full_name).toBe('Untouched Person');
    expect(row.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// G3 - PROFILE + IDENTITY VERIFICATION (the old identifier rule)
// ---------------------------------------------------------------------------
describe('B2 G3 - profile and identity changes', () => {
  let cust: string;
  let phone: string;

  beforeEach(async () => {
    await drizzleDb.delete(identityChangesTable);
    await drizzleDb.delete(customersTable);
    phone = '+254714440001';
    cust = await seedCustomer({ phone, email: 'original@example.test', full_name: 'Original Name' });
  });

  afterEach(async () => {
    await drizzleDb.delete(identityChangesTable);
    await drizzleDb.delete(customersTable);
  });

  const readCustomer = async () =>
    (await drizzleDb.select().from(customersTable).where(eq(customersTable.id, cust)))[0];

  async function recordChange(kind: 'email' | 'phone', target: string, code: string) {
    const id = nextId('CICH');
    await db.createCustomerIdentityChange({
      id,
      customerId: cust,
      kind,
      targetValue: target,
      codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    return id;
  }

  it('a name update takes effect immediately', async () => {
    expect(await db.updateCustomerName(cust, 'Updated Name')).toBe(true);
    expect((await readCustomer()).full_name).toBe('Updated Name');
  });

  it('a name update is scoped to one customer', async () => {
    const other = await seedCustomer({ phone: '+254714440002', full_name: 'Other Name' });
    await db.updateCustomerName(other, 'Should Not Apply');
    expect((await readCustomer()).full_name).toBe('Original Name');
  });

  it('recording a change does NOT alter the authoritative row', async () => {
    // The core identity rule: until the new value is proven, nothing moves.
    await recordChange('phone', '+254714440099', '123456');
    expect((await readCustomer()).phone).toBe(phone);
  });

  it('only the CODE HASH is stored, never the code', async () => {
    await recordChange('email', 'new@example.test', '654321');
    const rows = await drizzleDb.select().from(identityChangesTable);
    expect(JSON.stringify(rows)).not.toContain('654321');
    expect(rows[0].code_hash).toBe(hashCode('654321'));
  });

  it('a second change SUPERSEDES the first for the same identifier', async () => {
    const first = await recordChange('phone', '+254714440098', '111111');
    await recordChange('phone', '+254714440099', '222222');
    // The abandoned attempt can no longer be redeemed.
    expect(await db.consumeCustomerIdentityChange({ id: first, customerId: cust })).toBe(false);
  });

  it('a change cannot be redeemed by ANOTHER customer', async () => {
    const other = await seedCustomer({ phone: '+254714440003' });
    const changeId = await recordChange('phone', '+254714440099', '333333');
    expect(await db.consumeCustomerIdentityChange({ id: changeId, customerId: other })).toBe(false);
    expect(await db.consumeCustomerIdentityChange({ id: changeId, customerId: cust })).toBe(true);
  });

  it('a change is single-use', async () => {
    const changeId = await recordChange('phone', '+254714440099', '444444');
    expect(await db.consumeCustomerIdentityChange({ id: changeId, customerId: cust })).toBe(true);
    expect(await db.consumeCustomerIdentityChange({ id: changeId, customerId: cust })).toBe(false);
  });

  it('a VERIFIED phone change replaces the identifier', async () => {
    const changeId = await recordChange('phone', '+254714440099', '555555');
    await db.consumeCustomerIdentityChange({ id: changeId, customerId: cust });
    await db.applyVerifiedCustomerIdentifier(cust, 'phone', '+254714440099');
    expect((await readCustomer()).phone).toBe('+254714440099');
  });

  it('a VERIFIED email change COMMITS the new address as VERIFIED', async () => {
    // E1-H2: redeeming the code sent to the new address IS proof of control of
    // that mailbox, so the address and its verified stamp are committed in the
    // SAME statement. The pre-E1-H2 behaviour cleared the stamp, which left the
    // account unloginable (the activation gate reads a NULL stamp on an account
    // that HAS an email as "not activated") with no flow able to set it again.
    await drizzleDb
      .update(customersTable)
      .set({ email_verified_at: new Date() })
      .where(eq(customersTable.id, cust));

    const changeId = await recordChange('email', 'new@example.test', '666666');
    await db.consumeCustomerIdentityChange({ id: changeId, customerId: cust });
    await db.applyVerifiedCustomerIdentifier(cust, 'email', 'new@example.test');

    const row = await readCustomer();
    expect(row.email).toBe('new@example.test');
    expect(row.email_verified_at).not.toBeNull();
    expect(new Date(row.email_verified_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('a VERIFIED phone change leaves the email verification stamp untouched', async () => {
    // The new phone number was never a proof of the mailbox, so it must not
    // disturb the state the email verification flows own.
    const stamped = new Date(Date.now() - 60_000);
    await drizzleDb
      .update(customersTable)
      .set({ email_verified_at: stamped })
      .where(eq(customersTable.id, cust));

    const changeId = await recordChange('phone', '+254714440097', '565656');
    await db.consumeCustomerIdentityChange({ id: changeId, customerId: cust });
    await db.applyVerifiedCustomerIdentifier(cust, 'phone', '+254714440097');

    const row = await readCustomer();
    expect(row.phone).toBe('+254714440097');
    expect(new Date(row.email_verified_at).getTime()).toBe(stamped.getTime());
  });

  it('an identifier already held by ANOTHER account is detected as taken', async () => {
    await seedCustomer({ phone: '+254714440004', email: 'taken@example.test' });
    expect(await db.isCustomerIdentifierTaken('email', 'taken@example.test', cust)).toBe(true);
    expect(await db.isCustomerIdentifierTaken('phone', '+254714440004', cust)).toBe(true);
    expect(await db.isCustomerIdentifierTaken('email', 'free@example.test', cust)).toBe(false);
  });

  it('keeping your OWN identifier is not treated as a conflict', async () => {
    expect(await db.isCustomerIdentifierTaken('email', 'original@example.test', cust)).toBe(false);
    expect(await db.isCustomerIdentifierTaken('phone', phone, cust)).toBe(false);
  });

  it('getIdentityChangeById is scoped to its owner', async () => {
    const other = await seedCustomer({ phone: '+254714440005' });
    const changeId = await recordChange('phone', '+254714440099', '777777');
    expect(await db.getIdentityChangeById(changeId, cust)).toBeTruthy();
    expect(await db.getIdentityChangeById(changeId, other)).toBeUndefined();
    expect(await db.getIdentityChangeById('CICH-NOPE', cust)).toBeUndefined();
  });

  it('a FAILED verification leaves the existing identity completely intact', async () => {
    const before = await readCustomer();
    await recordChange('phone', '+254714440099', '888888');
    // The customer simply never redeems it.
    const after = await readCustomer();
    expect(after.phone).toBe(before.phone);
    expect(after.email).toBe(before.email);
  });

  it('an EXPIRED change is not usable even with the correct code', async () => {
    const id = nextId('CICH');
    await db.createCustomerIdentityChange({
      id,
      customerId: cust,
      kind: 'phone',
      targetValue: '+254714440099',
      codeHash: hashCode('999999'),
      expiresAt: new Date(Date.now() - 1000),
    });
    const row = await db.getIdentityChangeById(id, cust);
    expect(isIdentityChangeUsable(row, new Date())).toBe(false);
    expect((await readCustomer()).phone).toBe(phone);
  });
});
