// Claims Administration permission boundary (Phase 6E).
//
// WHY THIS IS NOT A DATABASE-BACKED ROLE/PERMISSION SYSTEM
// -------------------------------------------------------
// docs/ROLE_SEPARATION_PLAN.md establishes, and the code confirms, that this
// repository has exactly ONE admin role (`req.user?.role === 'admin'`) and no
// permissions column anywhere. That document is explicit that introducing
// privilege TIERS is a product decision (which route belongs to which tier,
// what happens to the existing seeded admin, how the console reorganises) and
// must not be guessed at by an engineer.
//
// So this module does the smallest thing that is genuinely useful and creates
// no new product decisions:
//
//   * NAMED permissions, so a route can declare what it needs;
//   * ENFORCED server-side by requireAdminPermission();
//   * resolved from the AUTHENTICATED identity only — never from the request
//     body, query string or a client-supplied header;
//   * today the single `admin` role holds every claims permission, which is
//     exactly the documented flat model (so no admin loses access and no
//     schema migration is required).
//
// The resolver below is the ONE seam a future tier/grant list plugs into: when
// product sign-off arrives, `ADMIN_ROLE_GRANTS` (or a DB-backed grant lookup)
// changes and every already-enforced route starts honouring it. Nothing else
// in the Claims Administration surface needs to change.
//
// WHY `claims.manage` IS DELIBERATELY ABSENT
// ------------------------------------------
// Phase 6E adds no claim MUTATION endpoint (lifecycle mutations remain the
// exclusive province of transitionClaimStatus()/the existing admin actions).
// Defining a mutation permission that nothing enforces would be exactly the
// "fake permission" the phase brief forbids, so it is not defined. It belongs
// with the first mutation endpoint, whenever that is built.

export const ADMIN_PERMISSIONS = {
  /** Read the Claims Administration list (bounded, filtered, masked). */
  CLAIMS_READ: 'claims.read',
  /** Read one claim's operational detail record. */
  CLAIMS_DETAIL: 'claims.detail',
} as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS];

/**
 * Role -> granted permissions. Deliberately in-code: the repository has no
 * permissions storage, and adding one is a product/schema decision (see the
 * module comment). `admin_pending_2fa` and every non-admin role are absent by
 * construction, so they grant nothing.
 */
const ADMIN_ROLE_GRANTS: Record<string, readonly string[]> = {
  admin: [ADMIN_PERMISSIONS.CLAIMS_READ, ADMIN_PERMISSIONS.CLAIMS_DETAIL],
};

/** Permissions held by this authenticated principal. Unknown roles hold none. */
export function permissionsForAdminUser(user: any): readonly string[] {
  const role = typeof user?.role === 'string' ? user.role : '';
  return ADMIN_ROLE_GRANTS[role] ?? [];
}

export function adminHasPermission(user: any, permission: string): boolean {
  return permissionsForAdminUser(user).includes(permission);
}

/**
 * Express middleware factory. Denies with 403 using the repository's existing
 * 403 body (`{ error: 'Ruhusa imekataliwa.' }`, identical to every other admin
 * route) so the console's error handling needs no special case.
 *
 * Checks `role === 'admin'` as well: a token whose role is not `admin` (e.g.
 * `admin_pending_2fa`, or a customer/agent token) must never satisfy a claims
 * permission, independent of what the grant table says.
 *
 * 403 (not 404) is correct here: the caller IS authenticated, they simply are
 * not authorized. The repository does not use 404-masking on admin routes.
 */
export function requireAdminPermission(permission: string) {
  return function adminPermissionGuard(req: any, res: any, next: any) {
    if (req.user?.role !== 'admin' || !adminHasPermission(req.user, permission)) {
      return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
    }
    return next();
  };
}
