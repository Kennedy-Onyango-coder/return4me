import { describe, it, expect } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  adminHasPermission,
  permissionsForAdminUser,
  requireAdminPermission,
} from '../adminPermissions';

// Phase 6E — the Claims Administration permission boundary.
//
// These are unit tests of the resolver and the guard, standing beside the
// end-to-end HTTP 403 in adminClaimsEndpoints.test.ts. Together they show the
// boundary is real: the grant table, not the route, decides, and a principal
// that lacks a permission is stopped with 403 before any handler runs.
describe('adminPermissions', () => {
  it('the single admin role holds every defined claims permission (documented flat model)', () => {
    const perms = permissionsForAdminUser({ role: 'admin', username: 'a' });
    expect(perms).toContain(ADMIN_PERMISSIONS.CLAIMS_READ);
    expect(perms).toContain(ADMIN_PERMISSIONS.CLAIMS_DETAIL);
    // D-2B-B — the two settlement actions are the ONLY claim mutations and
    // the single admin role holds both (the flat model, unchanged).
    expect(perms).toContain(ADMIN_PERMISSIONS.CLAIMS_SETTLEMENT_APPROVE);
    expect(perms).toContain(ADMIN_PERMISSIONS.CLAIMS_SETTLEMENT_INITIATE);
  });

  it('exactly the defined permissions exist and `claims.manage` is still deliberately absent', () => {
    // D-2B-B adds exactly two settlement ACTION permissions, and both are
    // enforced server-side by their endpoints (in server.ts, beside the
    // payout executor). `claims.manage` remains deliberately ABSENT: no broad
    // "manage everything" permission exists, and defining one would be the
    // unenforced "fake permission" the module comment forbids. This test
    // fails loudly if someone adds the string without an enforcing endpoint.
    expect(Object.values(ADMIN_PERMISSIONS)).not.toContain('claims.manage');
    expect(Object.keys(ADMIN_PERMISSIONS).sort()).toEqual([
      'CLAIMS_DETAIL',
      'CLAIMS_READ',
      'CLAIMS_SETTLEMENT_APPROVE',
      'CLAIMS_SETTLEMENT_INITIATE',
    ]);
  });

  it('every non-admin role holds nothing', () => {
    for (const role of ['owner', 'finder', 'agent', 'admin_pending_2fa', '', undefined]) {
      expect(permissionsForAdminUser({ role } as any)).toEqual([]);
      expect(adminHasPermission({ role } as any, ADMIN_PERMISSIONS.CLAIMS_READ)).toBe(false);
      // The settlement actions are denied to every non-admin role too — an
      // admin_pending_2fa / customer / agent token can never satisfy them.
      expect(adminHasPermission({ role } as any, ADMIN_PERMISSIONS.CLAIMS_SETTLEMENT_APPROVE)).toBe(false);
      expect(adminHasPermission({ role } as any, ADMIN_PERMISSIONS.CLAIMS_SETTLEMENT_INITIATE)).toBe(false);
    }
    expect(permissionsForAdminUser(null)).toEqual([]);
  });

  it('an unknown permission is never granted', () => {
    expect(adminHasPermission({ role: 'admin' }, 'claims.manage')).toBe(false);
    expect(adminHasPermission({ role: 'admin' }, 'anything.else')).toBe(false);
  });

  function fakeRes() {
    const state: { status: number; body: any } = { status: 200, body: null };
    return {
      state,
      status(code: number) { state.status = code; return this; },
      json(body: any) { state.body = body; return this; },
    };
  }

  it('the guard allows an admin holding the permission', () => {
    const res = fakeRes();
    let nexted = false;
    requireAdminPermission(ADMIN_PERMISSIONS.CLAIMS_READ)({ user: { role: 'admin' } }, res, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(res.state.status).toBe(200);
  });

  it('the guard enforces the two settlement action permissions identically (allow admin, deny everyone else)', () => {
    // D-2B-B — the same guard that protects the read routes protects the
    // approval/initiation actions; a token that lacks the role (or the
    // permission) is stopped with the repository's standard 403 body.
    for (const p of [ADMIN_PERMISSIONS.CLAIMS_SETTLEMENT_APPROVE, ADMIN_PERMISSIONS.CLAIMS_SETTLEMENT_INITIATE]) {
      const allowed = fakeRes();
      let allowedNexted = false;
      requireAdminPermission(p)({ user: { role: 'admin' } }, allowed, () => { allowedNexted = true; });
      expect(allowedNexted).toBe(true);
      expect(allowed.state.status).toBe(200);

      for (const req of [{ user: { role: 'agent' } }, { user: { role: 'admin_pending_2fa' } }, {} as any]) {
        const denied = fakeRes();
        let deniedNexted = false;
        requireAdminPermission(p)(req, denied, () => { deniedNexted = true; });
        expect(deniedNexted).toBe(false);
        expect(denied.state.status).toBe(403);
        expect(denied.state.body).toEqual({ error: 'Access denied.' });
      }
    }
  });

  it('the guard denies 403 for a non-admin role and for a missing principal', () => {
    for (const req of [{ user: { role: 'owner' } }, { user: { role: 'admin_pending_2fa' } }, {} as any]) {
      const res = fakeRes();
      let nexted = false;
      requireAdminPermission(ADMIN_PERMISSIONS.CLAIMS_READ)(req, res, () => { nexted = true; });
      expect(nexted).toBe(false);
      expect(res.state.status).toBe(403);
      expect(res.state.body).toEqual({ error: 'Access denied.' });
    }
  });

  it('a caller cannot grant themselves a permission through the request', () => {
    // The guard reads only req.user, which is populated by the verified JWT —
    // never a body/query/header field.
    const res = fakeRes();
    let nexted = false;
    requireAdminPermission(ADMIN_PERMISSIONS.CLAIMS_DETAIL)(
      { body: { role: 'admin' }, query: { role: 'admin' }, headers: { role: 'admin' }, user: { role: 'owner' } },
      res,
      () => { nexted = true; },
    );
    expect(nexted).toBe(false);
    expect(res.state.status).toBe(403);
  });
});
