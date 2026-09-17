import { describe, it, expect } from 'vitest';
import { readAdminSessionIdentity, adminIdentityLabel, ADMIN_IDENTITY_CLAIM_NAMES } from '../adminSession';

// =============================================================================
// PHASE 9 — §10 "Signed in as" (admin identity) regression suite
// =============================================================================
// The console must be able to say WHO is signed in without ever weakening the
// security model. The two failure modes this protects against:
//   1. fabricating an identity (a name/email/avatar the session never carried);
//   2. leaking the credential itself into the UI (rendering the token).
// readAdminSessionIdentity therefore returns display claims only.

function b64url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A structurally valid, unsigned JWT-shaped string (no signature is verified here). */
function tokenWith(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.signature-not-read`;
}

describe('readAdminSessionIdentity reads display claims only', () => {
  it('reads the username and role the admin login actually puts in the token', () => {
    // server.ts /api/auth/admin-login signs { role: 'admin', username: admin.username }.
    const identity = readAdminSessionIdentity(tokenWith({ role: 'admin', username: 'kennedy', userId: 'usr_1' }));
    expect(identity).toEqual({ username: 'kennedy', userId: 'usr_1', role: 'admin' });
    expect(adminIdentityLabel(identity)).toBe('kennedy');
  });

  it('never returns the token, its signature or its header — only the three display claims', () => {
    const token = tokenWith({ role: 'admin', username: 'kennedy' });
    const identity = readAdminSessionIdentity(token);
    const serialized = JSON.stringify(identity);
    expect(serialized).not.toContain('signature-not-read');
    expect(serialized).not.toContain('HS256');
    expect(serialized).not.toContain(token);
    expect(Object.keys(identity).sort()).toEqual(['role', 'userId', 'username']);
    expect(ADMIN_IDENTITY_CLAIM_NAMES).toEqual(['username', 'userId', 'role']);
  });

  it('ignores any other claim, however sensitive it looks', () => {
    const identity = readAdminSessionIdentity(tokenWith({
      username: 'kennedy',
      role: 'admin',
      password: 'super-secret',
      adminPasscode: '4114',
      refreshToken: 'rt_123',
      iat: 1700000000,
    })) as unknown as Record<string, unknown>;
    expect(identity.password).toBeUndefined();
    expect(identity.adminPasscode).toBeUndefined();
    expect(identity.refreshToken).toBeUndefined();
    expect(JSON.stringify(identity)).not.toContain('super-secret');
  });

  it('invents no identity when the session carries none — the UI must not be told a name', () => {
    expect(readAdminSessionIdentity(tokenWith({ role: 'admin' }))).toEqual({ username: null, userId: null, role: 'admin' });
    expect(adminIdentityLabel({ username: null, userId: null, role: 'admin' })).toBe('Administrator');

    // A pending-2FA token (issued BEFORE the TOTP check) carries no admin role;
    // nothing about it is turned into a fabricated administrator either.
    const pending = readAdminSessionIdentity(tokenWith({ role: 'admin_pending_2fa', username: 'kennedy' }));
    expect(pending.role).toBe('admin_pending_2fa');
  });

  it('degrades safely for a missing, empty or malformed token', () => {
    for (const bad of [null, undefined, '', 'not-a-jwt', 'a.b', 'a.b.c.d', '..']) {
      const identity = readAdminSessionIdentity(bad as any);
      expect(identity).toEqual({ username: null, userId: null, role: null });
      expect(adminIdentityLabel(identity)).toBe('Administrator');
    }
    // A payload that is valid base64url but not JSON.
    expect(readAdminSessionIdentity(`${b64url('{}')}.${b64url('not json')}.x`)).toEqual({
      username: null, userId: null, role: null,
    });
  });

  it('renders claims as inert text (no HTML injection through a login name)', () => {
    const identity = readAdminSessionIdentity(tokenWith({ role: 'admin', username: '<img src=x onerror=alert(1)>' }));
    expect(identity.username).not.toContain('<');
    expect(identity.username).not.toContain('>');
    expect(identity.username).not.toContain('"');
  });

  it('caps an absurdly long claim instead of rendering it', () => {
    const identity = readAdminSessionIdentity(tokenWith({ role: 'admin', username: 'x'.repeat(500) }));
    expect(identity.username!.length).toBe(64);
  });
});
