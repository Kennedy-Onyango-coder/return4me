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
  });

  it('no mutation permission is defined while no mutation endpoint exists', () => {
    // Defining one would be an unenforced "fake permission"; see the module
    // comment. This test fails loudly if someone adds the string without also
    // building the endpoint that enforces it.
    expect(Object.values(ADMIN_PERMISSIONS)).not.toContain('claims.manage');
    expect(Object.keys(ADMIN_PERMISSIONS).sort()).toEqual(['CLAIMS_DETAIL', 'CLAIMS_READ']);
  });

  it('every non-admin role holds nothing', () => {
    for (const role of ['owner', 'finder', 'agent', 'admin_pending_2fa', '', undefined]) {
      expect(permissionsForAdminUser({ role } as any)).toEqual([]);
      expect(adminHasPermission({ role } as any, ADMIN_PERMISSIONS.CLAIMS_READ)).toBe(false);
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

  it('the guard denies 403 for a non-admin role and for a missing principal', () => {
    for (const req of [{ user: { role: 'owner' } }, { user: { role: 'admin_pending_2fa' } }, {} as any]) {
      const res = fakeRes();
      let nexted = false;
      requireAdminPermission(ADMIN_PERMISSIONS.CLAIMS_READ)(req, res, () => { nexted = true; });
      expect(nexted).toBe(false);
      expect(res.state.status).toBe(403);
      expect(res.state.body).toEqual({ error: 'Ruhusa imekataliwa.' });
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
