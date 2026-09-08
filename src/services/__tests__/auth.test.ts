import { describe, it, expect, vi } from 'vitest';
import { toE164Kenyan, hashCode, timingSafeEqualHex, generateToken, verifyToken, sendCodeViaSms, maskPhoneForLog, isAdminSessionCurrent } from '../auth';

// These four functions were chosen deliberately: they're pure (no DB, no
// network), but they sit directly behind three of the security fixes made
// during this audit — toE164Kenyan is what the /api/claims/:id/pay
// ownership check and the dispute-refund destination both rely on;
// hashCode/timingSafeEqualHex protect OTPs and pickup codes from timing
// attacks and plaintext storage; generateToken/verifyToken are the entire
// session-auth mechanism. A regression in any of these is a security
// regression, not just a bug, so they get direct coverage even though the
// rest of server.ts isn't unit-testable without a live Postgres instance.

describe('toE164Kenyan', () => {
  it('converts a 07... local number to +254 format', () => {
    expect(toE164Kenyan('0712345678')).toBe('+254712345678');
  });

  it('converts a 01... local number to +254 format', () => {
    expect(toE164Kenyan('0112345678')).toBe('+254112345678');
  });

  it('adds a + to a bare 254... number', () => {
    expect(toE164Kenyan('254712345678')).toBe('+254712345678');
  });

  it('leaves an already-E.164 number unchanged', () => {
    expect(toE164Kenyan('+254712345678')).toBe('+254712345678');
  });

  it('strips internal whitespace before normalizing', () => {
    expect(toE164Kenyan('0712 345 678')).toBe('+254712345678');
  });

  // This is the exact property the /api/claims/:id/pay ownership check
  // (added during the security pass) depends on: two different textual
  // representations of the SAME real phone number must normalize to the
  // same string, or the phone-match comparison silently breaks and either
  // rejects legitimate owners or lets the STK-push-redirect abuse back in.
  it('normalizes different formats of the same number to the same value', () => {
    const local = toE164Kenyan('0712345678');
    const withCountryCode = toE164Kenyan('254712345678');
    const e164 = toE164Kenyan('+254712345678');
    expect(local).toBe(withCountryCode);
    expect(local).toBe(e164);
  });

  it('does not silently mangle an unrecognized format', () => {
    // Falls through to the final `return clean` branch — asserting this
    // explicitly so a future change to the fallback behavior is a visible
    // test failure, not a silent behavior change.
    expect(toE164Kenyan('12345')).toBe('12345');
  });
});

describe('hashCode', () => {
  it('is deterministic for the same input', () => {
    expect(hashCode('1234')).toBe(hashCode('1234'));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashCode('1234')).not.toBe(hashCode('5678'));
  });

  it('never returns the plaintext code itself', () => {
    const hashed = hashCode('1234');
    expect(hashed).not.toBe('1234');
    expect(hashed).not.toContain('1234');
  });

  it('produces a 64-character hex string (HMAC-SHA256)', () => {
    expect(hashCode('1234')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('timingSafeEqualHex', () => {
  it('returns true for two equal hex strings', () => {
    const h = hashCode('1234');
    expect(timingSafeEqualHex(h, h)).toBe(true);
  });

  it('returns false for two different hex strings of the same length', () => {
    expect(timingSafeEqualHex(hashCode('1234'), hashCode('5678'))).toBe(false);
  });

  it('returns false (not throws) for mismatched lengths', () => {
    // crypto.timingSafeEqual throws on unequal-length buffers — the
    // wrapper must catch that shape mismatch and return false rather than
    // let a raw exception bubble up through an OTP-verification code path.
    expect(() => timingSafeEqualHex('ab', 'abcd')).not.toThrow();
    expect(timingSafeEqualHex('ab', 'abcd')).toBe(false);
  });
});

describe('generateToken / verifyToken', () => {
  const payload = {
    userId: 'test-user-1',
    phone: '+254712345678',
    role: 'owner' as const,
  };

  it('round-trips a signed token back to the original payload', () => {
    const token = generateToken(payload);
    const decoded = verifyToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.userId).toBe(payload.userId);
    expect(decoded?.phone).toBe(payload.phone);
    expect(decoded?.role).toBe(payload.role);
  });

  it('rejects a tampered token', () => {
    const token = generateToken(payload);
    const tampered = token.slice(0, -2) + (token.slice(-2) === 'aa' ? 'bb' : 'aa');
    expect(verifyToken(tampered)).toBeNull();
  });

  it('rejects garbage input instead of throwing', () => {
    expect(() => verifyToken('not-a-real-token')).not.toThrow();
    expect(verifyToken('not-a-real-token')).toBeNull();
  });

  // Every admin-only route in server.ts guards itself with
  // `req.user?.role !== 'admin'` — that guard is only meaningful if the
  // intermediate 'admin_pending_2fa' role (issued after password
  // verification but before the TOTP code is checked) round-trips through
  // signing and verification EXACTLY, and is never silently upgraded to
  // 'admin'. This is the property the entire admin-2FA security model
  // rests on: a leaked/replayed pending-2FA token must never pass as a
  // full admin session.
  it('preserves the admin_pending_2fa role exactly — never upgrades it to admin', () => {
    const pendingToken = generateToken({
      userId: 'admin-1',
      phone: '+254700000000',
      role: 'admin_pending_2fa' as any,
      username: 'testadmin',
    }, '5m');
    const decoded = verifyToken(pendingToken);
    expect(decoded?.role).toBe('admin_pending_2fa');
    expect(decoded?.role).not.toBe('admin');
  });

  it('honors a custom short expiry (used for the 5-minute pending-2FA window and 4-hour admin sessions)', () => {
    const token = generateToken(payload, '1ms');
    // Give the 1ms expiry time to actually elapse before verifying.
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy-wait a few ms */ }
    expect(verifyToken(token)).toBeNull();
  });
});

// P0 regression coverage for the admin-login "accepted then immediately logged
// out" bug. An admin JWT is minted with tokenVersion: admin.token_version (see
// server.ts /api/auth/admin-login and /api/auth/admin-login/verify-2fa).
// verifyToken() must preserve that value on decode, because
// requireCurrentAdminSession() re-checks req.user.tokenVersion against the
// live account on every protected admin request and isAdminSessionCurrent()
// deliberately fails closed when tokenVersion is missing. If verifyToken()
// drops it, every validly-signed admin token is rejected the moment it hits
// /api/admin/dashboard (401 -> the frontend shows "session expired or invalid").
// These tests would fail on the buggy build: verifyToken returned
// tokenVersion === undefined, so the round-trip and the active-account
// acceptance assertions below both fail.
describe('admin session tokenVersion — generateToken → verifyToken → isAdminSessionCurrent propagation', () => {
  const buildAdminToken = (tokenVersion: number, role: 'admin' = 'admin') =>
    generateToken(
      { userId: 'admin-1', phone: '+254700000000', role, username: 'return4me_admin', tokenVersion },
      '4h'
    );

  it('verifyToken preserves the tokenVersion that was embedded at signing time', () => {
    const token = buildAdminToken(7);
    const decoded = verifyToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.role).toBe('admin');
    expect(decoded?.tokenVersion).toBe(7);
  });

  it('an admin token minted at tokenVersion N is accepted for an active account at version N', () => {
    const token = buildAdminToken(3);
    const decoded = verifyToken(token);
    expect(decoded).not.toBeNull();
    const admin = { is_active: true, token_version: 3 };
    expect(isAdminSessionCurrent(admin, decoded?.tokenVersion)).toBe(true);
  });

  it('an admin token whose tokenVersion is missing (undefined on decode) is rejected — fails closed', () => {
    const admin = { is_active: true, token_version: 1 };
    // undefined is exactly what requireCurrentAdminSession receives when
    // verifyToken() drops the field on a real, validly-signed admin token.
    expect(isAdminSessionCurrent(admin, undefined)).toBe(false);
  });

  it('an admin token whose tokenVersion mismatches the account is rejected', () => {
    const token = buildAdminToken(1); // minted at version 1
    const decoded = verifyToken(token);
    expect(decoded?.tokenVersion).toBe(1);
    // The account has since been bumped (e.g. 2FA disabled) to version 2.
    const adminAtVersion2 = { is_active: true, token_version: 2 };
    expect(isAdminSessionCurrent(adminAtVersion2, decoded?.tokenVersion)).toBe(false);
  });

  it('an inactive admin is rejected even when the tokenVersion matches', () => {
    const token = buildAdminToken(2);
    const decoded = verifyToken(token);
    const inactive = { is_active: false, token_version: 2 };
    expect(isAdminSessionCurrent(inactive, decoded?.tokenVersion)).toBe(false);
  });
});

// This sandbox has no real Africa's Talking credentials configured (see
// "[AFRICASTALKING] Placeholder or missing keys detected" in the test
// output), so sendCodeViaSms always takes its simulation branch here —
// there's no way to exercise the real-delivery branch without live
// credentials. What IS fully testable and worth pinning down: the
// simulation branch reports success (so callers like the claim-OTP route
// don't fail just because dev/sandbox has no SMS provider configured),
// and — the actual point of sendCodeViaSms existing — every caller gets
// real delivery through the same single code path instead of each one
// separately (and, as happened with the claim-OTP route before this
// fix) potentially forgetting to actually send anything at all.
describe('sendCodeViaSms', () => {
  it('reports success in simulation mode (no real SMS credentials configured)', async () => {
    const result = await sendCodeViaSms('0712345678', '1234', 'TEST', 'A test message');
    expect(result.success).toBe(true);
    expect(result.message).toBe('A test message');
  });

  it('logs the simulated send with an unmistakable SIMULATION label, not silently', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await sendCodeViaSms('0712345678', '1234', 'TEST', 'A test message');
      const loggedSomethingLabeled = logSpy.mock.calls.some(call =>
        typeof call[0] === 'string' && call[0].includes('SIMULATION')
      );
      expect(loggedSomethingLabeled).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('maskPhoneForLog', () => {
  it('masks the middle digits, keeping enough to correlate a specific request without printing the full number', () => {
    expect(maskPhoneForLog('+254712345678')).toBe('+254712***678');
  });

  it('masks a 07... format number', () => {
    expect(maskPhoneForLog('0712345678')).toBe('0712***678');
  });

  it('never reveals the full original number as a substring longer than the kept prefix/suffix', () => {
    const masked = maskPhoneForLog('+254712345678');
    expect(masked).not.toContain('345678'); // the masked middle+tail digits
    expect(masked).not.toBe('+254712345678');
  });

  it('handles null/undefined/empty without throwing', () => {
    expect(maskPhoneForLog(null)).toBe('(no phone)');
    expect(maskPhoneForLog(undefined)).toBe('(no phone)');
    expect(maskPhoneForLog('')).toBe('(no phone)');
  });

  it('falls back to full masking for numbers too short to safely partially reveal', () => {
    expect(maskPhoneForLog('12345')).toBe('***');
  });
});
