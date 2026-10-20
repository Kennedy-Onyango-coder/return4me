import { describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { db, ProvisionAdminError } from '../database';
import { db as drizzleDb } from '../index';
import { admin_users as adminUsersTable, audit_log as auditLogTable } from '../schema';
import { eq } from 'drizzle-orm';

// db.provisionSecondAdmin (POST /api/admin/provision-admin) against the
// in-memory mock database. Each test starts from a clean slate because
// provisioning is gated on the exact administrator count.

const BOOTSTRAP = 'bootstrap-admin';
const BOOTSTRAP_PASSWORD = 'bootstrap-P@ssw0rd-12345';
const NEW_PASSWORD = 'second-Admin-pw-67890';
const NEW_FULL_NAME = 'Second Administrator';

async function bootstrapAdmin(username = BOOTSTRAP): Promise<void> {
  await db.createAdminUser(
    'ADM-PROV-BOOTSTRAP',
    username,
    await bcrypt.hash(BOOTSTRAP_PASSWORD, 4),
    'Bootstrap Administrator',
  );
}

async function adminCount(): Promise<number> {
  const rows = await drizzleDb.select().from(adminUsersTable);
  return rows.length;
}

async function provisionAuditRows(): Promise<any[]> {
  const rows = await drizzleDb.select().from(auditLogTable);
  return rows.filter((row: any) => row.action === 'PROVISION_ADMIN');
}

async function findAdmin(username: string): Promise<any | undefined> {
  const rows = await drizzleDb.select().from(adminUsersTable).where(eq(adminUsersTable.username, username));
  return rows[0];
}

beforeEach(async () => {
  await drizzleDb.delete(auditLogTable);
  await drizzleDb.delete(adminUsersTable);
});

async function expectProvisionError(params: { actorUsername: string; username: string; password: string; fullName: string }, status: number, code: string): Promise<void> {
  await expect(db.provisionSecondAdmin(params)).rejects.toMatchObject({ status, code });
}

describe('db.provisionSecondAdmin — one-time second administrator', () => {
  it('creates the second administrator and returns only safe fields', async () => {
    await bootstrapAdmin();
    expect(await adminCount()).toBe(1);

    const provisioned = await db.provisionSecondAdmin({
      actorUsername: BOOTSTRAP,
      username: 'second-admin',
      password: NEW_PASSWORD,
      fullName: NEW_FULL_NAME,
    });

    expect(provisioned.username).toBe('second-admin');
    expect(provisioned.full_name).toBe(NEW_FULL_NAME);
    expect(provisioned.is_active).toBe(true);
    expect(provisioned.totp_enabled).toBe(false);
    expect(provisioned.token_version).toBe(1);
    expect(provisioned.created_at).toBeDefined();
    expect(Object.keys(provisioned)).not.toContain('password_hash');

    const row = await findAdmin('second-admin');
    expect(row).toBeDefined();
    expect(String(row.password_hash)).toMatch(/^\$2[ab]\$/); // bcrypt hash
    expect(await bcrypt.compare(NEW_PASSWORD, String(row.password_hash))).toBe(true);
    expect(await adminCount()).toBe(2);
  });

  it('writes a credential-safe audit record', async () => {
    await bootstrapAdmin();
    await db.provisionSecondAdmin({
      actorUsername: BOOTSTRAP,
      username: 'second-admin',
      password: NEW_PASSWORD,
      fullName: NEW_FULL_NAME,
    });

    const audits = await provisionAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].admin_user).toBe(BOOTSTRAP);
    expect(String(audits[0].details)).toContain('second-admin');
    expect(String(audits[0].details)).toContain(NEW_FULL_NAME);
    expect(String(audits[0].details)).toContain(BOOTSTRAP);
    expect(String(audits[0].details)).not.toContain(NEW_PASSWORD);
    expect(String(audits[0].details)).not.toContain(BOOTSTRAP_PASSWORD);
  });

  it('is one-time: a second provisioning attempt is refused (409 provisioning_closed)', async () => {
    await bootstrapAdmin();
    await db.provisionSecondAdmin({
      actorUsername: BOOTSTRAP,
      username: 'second-admin',
      password: NEW_PASSWORD,
      fullName: NEW_FULL_NAME,
    });

    await expectProvisionError(
      { actorUsername: BOOTSTRAP, username: 'another-admin', password: NEW_PASSWORD, fullName: 'Another Administrator' },
      409,
      'provisioning_closed',
    );
    expect(await adminCount()).toBe(2);
    expect(await provisionAuditRows()).toHaveLength(1);
  });

  it('refuses when no bootstrap administrator exists (409 no_bootstrap_admin)', async () => {
    expect(await adminCount()).toBe(0);

    await expectProvisionError(
      { actorUsername: BOOTSTRAP, username: 'second-admin', password: NEW_PASSWORD, fullName: NEW_FULL_NAME },
      409,
      'no_bootstrap_admin',
    );
    expect(await adminCount()).toBe(0);
    expect(await provisionAuditRows()).toHaveLength(0);
  });

  it('refuses when more than one administrator already exists (409 provisioning_closed)', async () => {
    await bootstrapAdmin();
    await db.createAdminUser('ADM-PROV-OTHER', 'other-admin', await bcrypt.hash('other-pw', 4), 'Other Administrator');
    expect(await adminCount()).toBe(2);

    await expectProvisionError(
      { actorUsername: BOOTSTRAP, username: 'second-admin', password: NEW_PASSWORD, fullName: NEW_FULL_NAME },
      409,
      'provisioning_closed',
    );
    expect(await adminCount()).toBe(2);
  });

  it('refuses when the caller is not the bootstrap administrator (403)', async () => {
    await bootstrapAdmin();
    expect(await adminCount()).toBe(1);

    await expectProvisionError(
      { actorUsername: 'someone-else', username: 'second-admin', password: NEW_PASSWORD, fullName: NEW_FULL_NAME },
      403,
      'not_the_bootstrap_administrator',
    );
    expect(await adminCount()).toBe(1);
    expect(await provisionAuditRows()).toHaveLength(0);
  });

  it('refuses a duplicate target username (409 admin_username_exists) and rolls back', async () => {
    await bootstrapAdmin();
    expect(await adminCount()).toBe(1);

    await expectProvisionError(
      { actorUsername: BOOTSTRAP, username: BOOTSTRAP, password: NEW_PASSWORD, fullName: NEW_FULL_NAME },
      409,
      'admin_username_exists',
    );
    expect(await adminCount()).toBe(1);
    expect(await provisionAuditRows()).toHaveLength(0);
  });

  it.each([
    ['username_required', { username: '', password: NEW_PASSWORD, fullName: NEW_FULL_NAME }],
    ['password_required', { username: 'second-admin', password: '', fullName: NEW_FULL_NAME }],
    ['password_too_long', { username: 'second-admin', password: 'x'.repeat(201), fullName: NEW_FULL_NAME }],
    ['full_name_required', { username: 'second-admin', password: NEW_PASSWORD, fullName: '' }],
    ['full_name_too_long', { username: 'second-admin', password: NEW_PASSWORD, fullName: 'x'.repeat(101) }],
    ['username_too_long', { username: 'x'.repeat(51), password: NEW_PASSWORD, fullName: NEW_FULL_NAME }],
  ])('rejects invalid input with 400 %s and writes nothing', async (_code, fields) => {
    await bootstrapAdmin();
    const before = await adminCount();
    const beforeAudits = await provisionAuditRows();

    await expect(
      db.provisionSecondAdmin({ actorUsername: BOOTSTRAP, ...fields } as any),
    ).rejects.toMatchObject({ status: 400, code: _code });

    expect(await adminCount()).toBe(before);
    expect(await provisionAuditRows()).toHaveLength(beforeAudits.length);
  });

  it('concurrency: two simultaneous attempts for the same username produce exactly one administrator', async () => {
    await bootstrapAdmin();
    expect(await adminCount()).toBe(1);

    const results = await Promise.allSettled([
      db.provisionSecondAdmin({ actorUsername: BOOTSTRAP, username: 'shared-admin', password: 'pw-one-AAA', fullName: 'First Attempt' }),
      db.provisionSecondAdmin({ actorUsername: BOOTSTRAP, username: 'shared-admin', password: 'pw-two-BBB', fullName: 'Second Attempt' }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ProvisionAdminError);
    expect(rejected[0].reason.status).toBe(409);

    expect(fulfilled[0].value.username).toBe('shared-admin');
    expect(await adminCount()).toBe(2);
    expect(await provisionAuditRows()).toHaveLength(1);
  });

  it('does not reference payout, ledger, claims or agent-destination tables (payout safeguards untouched)', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../database.ts'), 'utf8');
    const start = source.indexOf('public async provisionSecondAdmin');
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const next = rest.indexOf('\n  public async ', 1);
    const methodSource = next === -1 ? rest : rest.slice(0, next);

    for (const table of [
      'agentPayoutDestinationChangesTable',
      'payoutRepairRequestsTable',
      'ledgerTable',
      'claimsTable',
      'itemsTable',
    ]) {
      expect(methodSource).not.toContain(table);
    }
  });
});