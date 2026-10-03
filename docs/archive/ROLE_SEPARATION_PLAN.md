# Return4me — Privileged Role Separation: Current State & Migration Plan

## Why this is a plan document, not a shipped feature

The role model this codebase actually implements today is `owner | finder |
agent | admin | admin_pending_2fa` (see `SessionPayload` in
`src/services/auth.ts`). There is no REVIEWER, SUPPORT, FINANCE, or
SUPER_ADMIN role anywhere in the code — every one of the ~26 admin-gated
routes checks the same single condition, `req.user?.role !== 'admin'`, and
any admin account can reach any of them.

Introducing four new privilege tiers into a system that has exactly one
flat admin role is a real feature with real product decisions behind it —
which of ~26 routes belongs to which tier, what happens to the sole
existing seeded admin account during the transition, and how the admin
frontend's UI reorganizes around roles that don't exist in its state model
today. Building that unilaterally, without those decisions actually being
made, risks locking a future implementer into assumptions nobody signed off
on. This document does the two things that are safe to do without those
decisions: (1) confirms the current single-role admin surface is itself
secure, and (2) lays out a concrete, low-risk path to introduce the new
roles when the capability-to-role mapping is decided.

## 1. Confirming the current admin role is secure

This was verified directly, not assumed, over the course of this session's
work:

- Every one of the 26 admin/admin-2FA routes is gated by both
  `authenticateJWT` and `requireCurrentAdminSession` (added this session —
  re-checks the account is still active and the JWT's embedded
  `token_version` matches the account's current value on every request, not
  just at login), in addition to each route's own `role !== 'admin'` check.
  Enforced and regression-tested via `adminRouteAudit.test.ts` and
  `adminSessionRevocation.test.ts`.
- `admin_pending_2fa` (the intermediate state between password verification
  and completed 2FA) is a structurally distinct role value, not a flag on
  `admin` — it fails every `role !== 'admin'` check automatically, by
  construction, with no route-specific code needed to exclude it.
- Session tokens are short-lived (4h) and revocable (see above), closing
  the "old token still works after something changes" gap that existed
  before this session.

So: a single flat admin role, but one that's actually enforced correctly
everywhere it's used. The risk role separation addresses is a different
one — not "can a non-admin reach admin routes" (no), but "should every
admin be able to reach every admin route" (currently yes, by design,
because there's only one role).

## 2. What role separation would actually need to decide

Before writing code, someone with product/business authority over
Return4me needs to answer these — guessing at them risks shipping
something that doesn't match how the team actually wants to operate:

1. **Which of the ~26 admin routes belongs to which tier?** A first-pass
   grouping based on what each route actually does (not a final answer —
   this is the artifact that needs sign-off):
   - **Reviewer** (item/content review, no financial or account authority):
     item verification review queue, category browsing, item search/lookup
     for support purposes.
   - **Support** (account/operational assistance, no payout authority):
     agent approval/warning/suspension, dispute investigation (viewing,
     not resolving with financial consequence), pause/resume individual
     operational flags.
   - **Finance** (financial authority, no ownership/identity authority):
     settlement release, payout retry, ledger/reconciliation views,
     refund initiation — explicitly NOT category pricing changes (the
     prompt's own example) and NOT anything that changes who owns a claim.
   - **SuperAdmin** (reserved for exceptional platform-wide controls):
     emergency pause controls (all 6 scopes), category pricing/fee-split
     configuration, 2FA management for other admin accounts, admin account
     creation/suspension itself.
   - **Admin** (current catch-all): everything else, until reassigned.
2. **Migration of the existing seeded admin account.** Does it become
   SuperAdmin automatically, or does someone explicitly re-provision it?
   What happens to `seedAdminUser()` (currently creates one bootstrap admin
   with the flat `admin` role) once multiple tiers exist?
3. **Multi-admin support.** This codebase currently has no route to create
   additional admin accounts at all — only the one seeded bootstrap admin
   exists, found via `getAdminByUsername`. Role separation only matters
   once there's more than one admin account to separate; building the
   tiers without also building admin-account management would produce
   unused enum values with no way to actually assign them to anyone new.

## 3. Proposed technical approach (once the above is decided)

- Extend `admin_users.role` (a new column) with the tier value, alongside
  the existing `is_active`/`token_version` columns — additive, not a
  breaking schema change.
- Extend `SessionPayload.role` to include the new tier strings, or add a
  separate `adminTier` field so the existing `role: 'admin'` check keeps
  working for "is this an admin-family token at all" while a second check
  handles "which tier."
- Add a `requireAdminTier(...allowedTiers: string[])` middleware, mounted
  alongside (not replacing) `requireCurrentAdminSession` — same pattern
  already established this session for `requireActiveAgent` and
  `requireCurrentAdminSession`: a focused, testable predicate function
  extracted to `services/auth.ts`, plus a thin Express middleware wrapper
  in `server.ts`.
- Migrate routes to their assigned tier one group at a time (Reviewer
  routes first, as the lowest-risk/most contained group), each batch
  verified with its own regression tests before moving to the next — the
  same incremental, verify-as-you-go approach used for every other fix
  this session, rather than one large simultaneous cutover across all 26
  routes.
- Update `AdminView.tsx` to read the caller's tier and hide UI sections the
  current admin's tier can't act on — cosmetic, but prevents a Reviewer
  clicking a button that a `requireAdminTier` check would reject anyway,
  which is better UX than a wall of visible-but-broken controls.

## 4. Recommendation

Do not build this speculatively. The current single-admin-role system is
secure for what it is; the risk role separation reduces is operational
(a compromised or careless admin account has more reach than it needs to),
not a live vulnerability. Treat this document as ready to execute the
moment product ownership signs off on the tier-to-route mapping in Section
2 — at that point it's a scoped, well-understood, incremental piece of
work, not a research problem.
