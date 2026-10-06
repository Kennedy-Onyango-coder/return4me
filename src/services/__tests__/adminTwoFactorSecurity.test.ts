import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as OTPAuth from 'otpauth';
import {
  encryptTOTPSecret,
  decryptTOTPSecret,
  isEncryptedTOTPSecret,
  resolveTotpEncryptionKey,
  TOTP_CIPHER_PREFIX,
} from '../totpCrypto';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from '../totpRecoveryCodes';
import { db } from '../../db/database';

// =============================================================================
// ADMINISTRATIVE 2FA HARDENING — BEHAVIOURAL TESTS.
//
// Scope: the security properties the batch introduced —
//   * authenticated encryption of the admin TOTP secret at rest;
//   * the ENABLED -> re-enrollment state machine that never downgrades live 2FA;
//   * single-use recovery codes (generation, hashing, atomic redemption);
//   * the route wiring that enforces all of the above (source audit, because
//     server.ts boots the app at import time and cannot be imported by a test —
//     the same constraint every existing admin/auth audit in this repo works
//     under; see __tests__/adminRouteAudit.test.ts and
//     services/__tests__/adminSessionRevocation.test.ts).
//
// Encryption/recovery primitives are tested directly. The database layer is
// tested against the real data-access methods (mock/real DB per the suite's
// standard DATABASE_URL rule), because the properties under test (state
// transitions, CAS single-use) ARE the queries.
// =============================================================================

const serverTs = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');

let seq = 0;
const uniqueName = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function makeAdmin(): Promise<string> {
  const username = uniqueName('adm2fa');
  await db.createAdminUser('ADM-' + uniqueName('2FA').toUpperCase().slice(0, 30), username, 'x'.repeat(60), 'Two Factor Admin');
  const admin = await db.getAdminByUsername(username);
  if (!admin) throw new Error('failed to create admin fixture');
  return username;
}

// ---------------------------------------------------------------------------
// ENCRYPTION AT REST (AES-256-GCM)
// ---------------------------------------------------------------------------
describe('admin TOTP secret encryption at rest', () => {
  const ORIGINAL_KEY = process.env.TOTP_ENCRYPTION_KEY;
  const ORIGINAL_ENV = process.env.NODE_ENV;
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
    else process.env.TOTP_ENCRYPTION_KEY = ORIGINAL_KEY;
    process.env.NODE_ENV = ORIGINAL_ENV;
  });

  it('stores ciphertext, not plaintext, and round-trips back to the exact secret', () => {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const stored = encryptTOTPSecret(secret);
    expect(stored).not.toBe(secret);
    expect(stored.startsWith(TOTP_CIPHER_PREFIX)).toBe(true);
    expect(isEncryptedTOTPSecret(stored)).toBe(true);
    expect(decryptTOTPSecret(stored)).toBe(secret);
  });

  it('uses a fresh IV per encryption (same secret -> different ciphertext)', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(encryptTOTPSecret(secret)).not.toBe(encryptTOTPSecret(secret));
  });

  it('rejects a tampered ciphertext (GCM authentication)', () => {
    const stored = encryptTOTPSecret('JBSWY3DPEHPK3PXP');
    const tampered = stored.slice(0, -4) + (stored.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => decryptTOTPSecret(tampered)).toThrow();
  });

  it('tolerates a legacy plaintext value (transition safety net) without decrypting it', () => {
    expect(isEncryptedTOTPSecret('JBSWY3DPEHPK3PXP')).toBe(false);
    expect(decryptTOTPSecret('JBSWY3DPEHPK3PXP')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('requires a 32-byte key in production and fails closed without one', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.TOTP_ENCRYPTION_KEY;
    expect(() => resolveTotpEncryptionKey()).toThrow(/TOTP_ENCRYPTION_KEY/);
  });

  it('rejects a malformed key rather than silently deriving one', () => {
    process.env.TOTP_ENCRYPTION_KEY = 'too-short';
    expect(() => resolveTotpEncryptionKey()).toThrow();
  });

  it('accepts a 64-character hex key and a base64 key', () => {
    process.env.TOTP_ENCRYPTION_KEY = 'a'.repeat(64);
    expect(resolveTotpEncryptionKey().length).toBe(32);
    process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    expect(resolveTotpEncryptionKey().length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// RECOVERY CODE PRIMITIVES
// ---------------------------------------------------------------------------
describe('recovery code generation, hashing and single-use primitives', () => {
  it('generates a fixed number of well-formed, high-entropy codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes.length).toBe(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT); // no duplicates
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/); // no I/O/0/1
    }
  });

  it('normalizes case and separators, so a code can be typed in any form', () => {
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK');
  });

  it('stores only a one-way hash and verifies against it (case/format-insensitive)', async () => {
    const [code] = generateRecoveryCodes(1);
    const hash = await hashRecoveryCode(code);
    expect(hash).not.toContain(normalizeRecoveryCode(code));
    expect(await verifyRecoveryCode(code, hash)).toBe(true);
    expect(await verifyRecoveryCode(code.toLowerCase().replace('-', ' '), hash)).toBe(true);
    expect(await verifyRecoveryCode('WRONG-WRONG', hash)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TOTP ENROLLMENT STATE MACHINE (data layer)
// ---------------------------------------------------------------------------
describe('2FA enrollment state machine never downgrades live 2FA', () => {
  it('NOT CONFIGURED -> setup stages a secret but does NOT enable 2FA', async () => {
    const username = await makeAdmin();
    const admin = (await db.getAdminByUsername(username))!;
    expect(admin.totp_enabled).toBe(false);

    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await db.setAdminPendingTotpSecret(admin.id, encryptTOTPSecret(secret));

    const after = (await db.getAdminByUsername(username))!;
    expect(after.totp_enabled).toBe(false);          // not enabled before confirm
    expect(after.totp_secret).toBeNull();            // active secret untouched
    expect(isEncryptedTOTPSecret(after.totp_pending_secret!)).toBe(true);
    expect(decryptTOTPSecret(after.totp_pending_secret!)).toBe(secret);
  });

  it('confirm promotes the staged secret to active and enables 2FA atomically', async () => {
    const username = await makeAdmin();
    const admin = (await db.getAdminByUsername(username))!;
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const staged = encryptTOTPSecret(secret);
    await db.setAdminPendingTotpSecret(admin.id, staged);

    expect(await db.promotePendingAdminTotpSecret(admin.id, staged)).toBe(true);

    const after = (await db.getAdminByUsername(username))!;
    expect(after.totp_enabled).toBe(true);
    expect(after.totp_secret).toBe(staged);          // active == the confirmed staged value
    expect(after.totp_pending_secret).toBeNull();    // pending slot cleared
    // The active secret still yields working TOTP codes.
    const totp = new OTPAuth.TOTP({ issuer: 'Return4me', label: username, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(decryptTOTPSecret(after.totp_secret!)) });
    expect(totp.validate({ token: totp.generate(), window: 1 })).not.toBeNull();
  });

  it('ENABLED -> a new setup STAGES a replacement but the ACTIVE secret stays valid until confirm', async () => {
    const username = await makeAdmin();
    const admin = (await db.getAdminByUsername(username))!;
    const oldSecret = new OTPAuth.Secret({ size: 20 }).base32;
    const oldStored = encryptTOTPSecret(oldSecret);
    await db.setAdminPendingTotpSecret(admin.id, oldStored);
    await db.promotePendingAdminTotpSecret(admin.id, oldStored);
    expect((await db.getAdminByUsername(username))!.totp_enabled).toBe(true);

    // A re-enrollment begins. This MUST NOT disable or replace the active secret.
    const newStored = encryptTOTPSecret(new OTPAuth.Secret({ size: 20 }).base32);
    await db.setAdminPendingTotpSecret(admin.id, newStored);

    const staged = (await db.getAdminByUsername(username))!;
    expect(staged.totp_enabled).toBe(true);          // still enabled — no silent downgrade
    expect(staged.totp_secret).toBe(oldStored);      // active secret unchanged

    // Confirming the new secret is what finally replaces the active one.
    expect(await db.promotePendingAdminTotpSecret(admin.id, newStored)).toBe(true);
    const replaced = (await db.getAdminByUsername(username))!;
    expect(replaced.totp_enabled).toBe(true);
    expect(replaced.totp_secret).toBe(newStored);
  });

  it('a failed promotion (stale/never-validated pending value) cannot enable or replace 2FA', async () => {
    const username = await makeAdmin();
    const admin = (await db.getAdminByUsername(username))!;
    await db.setAdminPendingTotpSecret(admin.id, encryptTOTPSecret('JBSWY3DPEHPK3PXP'));

    const promoted = await db.promotePendingAdminTotpSecret(admin.id, encryptTOTPSecret('DIFFERENTVAL'));
    expect(promoted).toBe(false);
    const after = (await db.getAdminByUsername(username))!;
    expect(after.totp_enabled).toBe(false);
    expect(after.totp_secret).toBeNull();
  });

  it('disable clears the active secret, any staged secret, and totp_enabled', async () => {
    const username = await makeAdmin();
    const admin = (await db.getAdminByUsername(username))!;
    const stored = encryptTOTPSecret(new OTPAuth.Secret({ size: 20 }).base32);
    await db.setAdminPendingTotpSecret(admin.id, stored);
    await db.promotePendingAdminTotpSecret(admin.id, stored);
    await db.setAdminPendingTotpSecret(admin.id, encryptTOTPSecret('STAGEDSTAGED'));

    await db.disableAdminTotp(admin.id);
    const after = (await db.getAdminByUsername(username))!;
    expect(after.totp_enabled).toBe(false);
    expect(after.totp_secret).toBeNull();
    expect(after.totp_pending_secret).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RECOVERY CODES AT THE DATA LAYER (single-use, replace, delete)
// ---------------------------------------------------------------------------
describe('recovery codes are single-use at the data layer', () => {
  it('stores hashed codes, lists only unused ones, and consumes each exactly once', async () => {
    const username = await makeAdmin();
    const admin = (await db.getAdminByUsername(username))!;
    const codes = ['AAAAA-AAAAA', 'BBBBB-BBBBB', 'CCCCC-CCCCC'];
    const hashes = await Promise.all(codes.map((c) => hashRecoveryCode(c)));
    await db.replaceAdminRecoveryCodes(admin.id, hashes);

    const unused = await db.getUnusedAdminRecoveryCodes(admin.id);
    expect(unused.length).toBe(3);
    for (const row of unused) {
      expect(row.code_hash).not.toBe('AAAAA-AAAAA');       // never plaintext
      expect(row.code_hash.startsWith('$2')).toBe(true);   // bcrypt hash
    }

    // Consume the first code once — succeeds — and never again.
    const target = unused[0];
    expect(await db.consumeAdminRecoveryCode(target.id)).toBe(true);
    expect(await db.consumeAdminRecoveryCode(target.id)).toBe(false);

    const after = await db.getUnusedAdminRecoveryCodes(admin.id);
    expect(after.length).toBe(2);
    expect(after.map((r) => r.id)).not.toContain(target.id);
  });

  it('a concurrent double-redemption of the same code yields exactly one success', async () => {
    const username = await makeAdmin();
    const admin = (await db.getAdminByUsername(username))!;
    await db.replaceAdminRecoveryCodes(admin.id, [await hashRecoveryCode('XXXXX-XXXXX')]);
    const [row] = await db.getUnusedAdminRecoveryCodes(admin.id);

    const results = await Promise.all([
      db.consumeAdminRecoveryCode(row.id),
      db.consumeAdminRecoveryCode(row.id),
    ]);
    expect(results.filter(Boolean).length).toBe(1);
  });

  it('re-enrollment replaces the whole set; disabling removes every code', async () => {
    const username = await makeAdmin();
    const admin = (await db.getAdminByUsername(username))!;
    await db.replaceAdminRecoveryCodes(admin.id, [await hashRecoveryCode('AAAAA-AAAAA')]);
    await db.replaceAdminRecoveryCodes(admin.id, [await hashRecoveryCode('BBBBB-BBBBB'), await hashRecoveryCode('CCCCC-CCCCC')]);
    expect((await db.getUnusedAdminRecoveryCodes(admin.id)).length).toBe(2);

    await db.deleteAdminRecoveryCodes(admin.id);
    expect((await db.getUnusedAdminRecoveryCodes(admin.id)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ROUTE WIRING (source audit — server.ts cannot be imported by a test)
// ---------------------------------------------------------------------------
describe('route wiring enforces the hardened lifecycle', () => {
  const routeSlice = (marker: string, len = 2600) => {
    const start = serverTs.indexOf(marker);
    expect(start, `route not found: ${marker}`).toBeGreaterThan(-1);
    return serverTs.slice(start, start + len);
  };

  it('setup requires a password re-check and stages into the pending column only', () => {
    const body = routeSlice("app.post('/api/auth/admin-2fa/setup'");
    expect(body).toContain('bcrypt.compare(password, admin.password_hash)');
    expect(body).toContain('setAdminPendingTotpSecret');
    // Must NEVER reach for the old active-secret setter, nor force enabled=false
    // merely because setup began (the silent-downgrade defect).
    expect(body).not.toContain('setAdminTotpSecret');
    expect(body).not.toMatch(/totp_enabled:\s*false/);
  });

  it('confirm validates the PENDING secret and promotes it via the CAS method', () => {
    const body = routeSlice("app.post('/api/auth/admin-2fa/confirm'");
    expect(body).toContain('admin.totp_pending_secret');
    expect(body).toContain('decryptTOTPSecret');
    expect(body).toContain('promotePendingAdminTotpSecret');
    // Returns recovery codes exactly once; never returns the active secret value.
    expect(body).toContain('recoveryCodes');
    expect(body).toContain('hashRecoveryCode');
    expect(body).not.toMatch(/secret:\s*admin\.totp_secret/);
  });

  it('verify-2fa accepts a recovery code without bypassing the pending-token (password) stage', () => {
    const body = routeSlice("app.post('/api/auth/admin-login/verify-2fa'", 3200);
    expect(body).toContain('recoveryCode');
    expect(body).toContain("role !== 'admin_pending_2fa'");
    expect(body).toContain('consumeAdminRecoveryCode');
  });

  it('all three 2FA management routes are rate-limited', () => {
    for (const route of ['setup', 'confirm', 'disable']) {
      const body = routeSlice(`app.post('/api/auth/admin-2fa/${route}'`, 220);
      expect(body, route).toContain('adminTwoFactorLimiter');
    }
  });

  it('disable keeps the session-revoking tokenVersion bump after disableAdminTotp', () => {
    const body = routeSlice("app.post('/api/auth/admin-2fa/disable'", 2600);
    const disableIdx = body.indexOf('disableAdminTotp');
    const bumpIdx = body.indexOf('bumpAdminTokenVersion');
    expect(disableIdx).toBeGreaterThan(-1);
    expect(bumpIdx).toBeGreaterThan(disableIdx);
  });

  it('emits the required audit events', () => {
    for (const action of ['ADMIN_2FA_ENABLED', 'ADMIN_2FA_DISABLED', 'ADMIN_2FA_RECOVERY_USED']) {
      expect(serverTs, action).toContain(action);
    }
  });

  it('never logs the secret, provisioning URI, recovery codes or password', () => {
    for (const leak of ['secret.base32', 'otpauthUrl', 'recoveryCodes', 'password_hash']) {
      const pattern = new RegExp(`(console\\.(?:log|warn|error)|logAudit)\\([^;]*${leak.replace('.', '\\.')}`);
      expect(serverTs, `log call must not reference ${leak}`).not.toMatch(pattern);
    }
  });
});
