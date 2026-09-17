// ADMIN LOST-REPORT READ ROUTES (Phase 11A)
// =========================================
//   GET /api/admin/lost-reports   — a bounded, read-only page of lost reports
//
// WHY THIS MODULE EXISTS
// The Phase 11 forensic audit established that lost reports had NO
// administrative surface whatsoever: no endpoint, no console section. An
// administrator could not see, count or triage them, while the audit trail and
// every other operational entity (items, claims, disputes, agents) is visible.
// This module is that missing read.
//
// READ-ONLY, and deliberately so. It exposes GET only. There is no admin edit,
// delete, status transition, matching override, refund or claim action here —
// those are separate product decisions with their own phases. Adding a mutation
// to this file would be out of scope by construction.
//
// WHY IT IS A SEPARATE MODULE
// Same reason as routes/adminClaims.ts: server.ts constructs the whole
// application and calls startServer() at import time, so an HTTP integration
// test cannot import it. Registering into the caller's Express app lets the
// tests mount the REAL handlers behind the REAL authenticateJWT and the REAL
// role check over a real socket.
//
// AUTHORIZATION MODEL (identical to every comparable sensitive admin route)
//   authenticateJWT            -> signature + expiry (mounted by this module)
//   requireCurrentAdminSession -> live admin account (is_active + token_version),
//                                 injected from server.ts
//   inline role check          -> req.user?.role !== 'admin' -> 403
//
// The inline role check is REQUIRED, not decorative: authenticateJWT does not
// check role, so without it an 'admin_pending_2fa' token (or any other
// authenticated role) would reach this route. src/__tests__/adminRouteAudit.test.ts
// asserts this file keeps that check.
import type { Express } from 'express';
import { db, ADMIN_LOST_REPORTS_DEFAULT_LIMIT, ADMIN_LOST_REPORTS_MAX_LIMIT } from '../db/database.ts';
import { authenticateJWT } from '../services/auth.ts';
import { toAdminSafeLostReportView } from '../services/lostReportView.ts';
import { DEFAULT_LOST_REPORT_STATUS } from '../config/lostReportStatuses.ts';
// The SAME candidate selector and the SAME claimable-item loader the
// customer-facing matches route uses. Reused, never re-implemented: the admin
// value is a count, and it must be the count of exactly the candidates the
// customer would be shown. No second matching algorithm exists.
import { selectLostReportCandidates } from '../services/lostReportMatching.ts';
import { loadClaimableItems } from './lostReports.ts';

export interface AdminLostReportRouteDeps {
  /** The real requireCurrentAdminSession from server.ts (not importable). */
  requireCurrentAdminSession: (req: any, res: any, next: any) => void;
  /** The real sendServerError helper from server.ts. */
  sendServerError: (res: any, error: any, context: string) => void;
  /**
   * server.ts's CENTRAL claimability rule, injected rather than duplicated —
   * exactly as routes/lostReports.ts and routes/publicItems.ts receive it. It is
   * what guarantees a possible-match count can only ever describe items the
   * public search and the claim endpoint would each accept.
   */
  canCreateClaim: (item: any, preFetchedDisputes?: any[]) => Promise<{ allowed: boolean; reason: string }>;
}

// ---------------------------------------------------------------------------
// STRICT QUERY VALIDATION
// ---------------------------------------------------------------------------
// A repeated parameter arrives as an array and is ambiguous, so it is treated as
// malformed rather than silently taking one member. A value is only accepted as
// plain digits — '1e9', '-5', ' 5 ' and '5.5' are all refused, never coerced.
// Nothing here is ever interpolated into SQL: validated numbers are handed to
// the Drizzle query builder, which parameterises them.

/** `undefined` means "not supplied" (the caller applies a default). */
function boundedInt(raw: unknown, min: number, max: number, fallback: number): { value: number; error: string | null } {
  if (raw === undefined) return { value: fallback, error: null };
  if (typeof raw !== 'string') {
    return { value: fallback, error: 'Kigezo kimerudiwa au si sahihi. / Duplicate or malformed parameter.' };
  }
  if (!/^\d+$/.test(raw)) {
    return { value: fallback, error: 'Thamani lazima iwe nambari kamili. / Value must be a whole number.' };
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    return { value: fallback, error: 'Thamani ya nambari ni kubwa kupita kiasi. / Numeric value is too large.' };
  }
  if (n < min || n > max) {
    return { value: fallback, error: `Thamani lazima iwe kati ya ${min} na ${max}. / Value must be between ${min} and ${max}.` };
  }
  return { value: n, error: null };
}

export function registerAdminLostReportRoutes(app: Express, deps: AdminLostReportRouteDeps): void {
  const { requireCurrentAdminSession, sendServerError, canCreateClaim } = deps;

  // GET /api/admin/lost-reports
  //
  // Bounded, newest-first page of lost reports. NOT audit-logged, for the same
  // documented reason as the claims list: it is a triage view fetched on tab
  // entry, and auditing every page-load would produce a log storm that swamps
  // the mutation records the audit trail exists to protect.
  app.get('/api/admin/lost-reports', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

      const q = (req.query ?? {}) as Record<string, unknown>;

      const limit = boundedInt(q.limit, 1, ADMIN_LOST_REPORTS_MAX_LIMIT, ADMIN_LOST_REPORTS_DEFAULT_LIMIT);
      if (limit.error) return res.status(400).json({ error: limit.error });

      const offset = boundedInt(q.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      if (offset.error) return res.status(400).json({ error: offset.error });

      const { rows, hasMore } = await db.listAdminLostReports({ limit: limit.value, offset: offset.value });

      // POSSIBLE-MATCH COUNTS.
      // Computed only for reports the platform is actually matching (the one
      // status the backend produces candidates for). A closed report gets null,
      // which the UI renders as "not applicable" rather than a misleading 0.
      //
      // The claimable-item set is loaded AT MOST ONCE per request, and only if
      // the page actually contains an active report — so a page of closed
      // reports costs no item query at all. Complexity is the same as the
      // customer-facing matches route: one indexed query plus one batched
      // dispute lookup, then a deterministic in-memory comparison per row.
      const activeRows = rows.filter((report) => report.status === DEFAULT_LOST_REPORT_STATUS);
      let matchCounts = new Map<string, number>();
      if (activeRows.length > 0) {
        const claimableItems = await loadClaimableItems(canCreateClaim);
        matchCounts = new Map(
          activeRows.map((report) => [report.id, selectLostReportCandidates(report, claimableItems).length]),
        );
      }

      return res.json({
        success: true,
        data: rows.map((report) => toAdminSafeLostReportView(report, matchCounts.get(report.id) ?? null)),
        pagination: { limit: limit.value, offset: offset.value, hasMore },
      });
    } catch (e: any) {
      return sendServerError(res, e, 'ADMIN_LOST_REPORT_LIST_ERROR');
    }
  });
}
