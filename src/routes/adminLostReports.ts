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
// READ, PLUS EXACTLY ONE MUTATION.
//
// Until Phase 16.1 Batch 1 this module was GET-only. It now also exposes
//   PATCH /api/admin/lost-reports/:id/classify
// and nothing else. That one endpoint exists because a lost report can be
// submitted WITHOUT a category ("unclassified"), which makes classification a
// necessary administrative action rather than an optional nicety: without it an
// unclassified report could never become classifiable, and category-dependent
// matching would be permanently deferred for it.
//
// It is deliberately the SMALLEST possible mutation: it changes `category_id`
// (including back to NULL) and writes its audit row in the same transaction. There
// is still no admin edit of a report's text, no delete, no status transition, no
// matching override, no refund and no claim action here — those remain separate
// product decisions with their own phases, and src/__tests__/adminRouteAudit.test.ts
// still asserts the role check on every route in this file.
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
import { selectLostReportCandidates, isLostReportClassified } from '../services/lostReportMatching.ts';
import { loadClaimableItems } from './lostReports.ts';
// PHASE 16.1 (GEO-16-04): the county filter reuses the ONE canonical resolver
// and the ONE canonical error message rather than keeping a county list, an
// alias table or a second set of strings of its own.
import { resolveCountyName } from '../config/kenyaCounties.ts';
import { FOUND_COUNTY_MESSAGES } from '../services/foundItemCounty.ts';

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
    return { value: fallback, error: 'Duplicate or malformed parameter.' };
  }
  if (!/^\d+$/.test(raw)) {
    return { value: fallback, error: 'Value must be a whole number.' };
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    return { value: fallback, error: 'Numeric value is too large.' };
  }
  if (n < min || n > max) {
    return { value: fallback, error: `Value must be between ${min} and ${max}.` };
  }
  return { value: n, error: null };
}

/**
 * PHASE 16.1 (GEO-16-04) — the optional county filter.
 *
 * `undefined` means "not supplied" -> no county constraint (all 47 counties).
 * Anything supplied must resolve through the ONE canonical resolver
 * (`resolveCountyName`), so an alias such as 'nairobi' or 'muranga' reaches the
 * data layer as its canonical name and the caller cannot invent a value that
 * will never match a row. A supplied value that is not a Kenyan county —
 * including a blank one or a repeated parameter — is REFUSED with a 400 rather
 * than silently ignored, because an ignored filter would show an administrator
 * reports from counties they did not ask for while looking like a filter that
 * worked.
 */
function countyFilter(raw: unknown): { value: string | null; error: string | null } {
  if (raw === undefined) return { value: null, error: null };
  if (typeof raw !== 'string') {
    return { value: null, error: 'Duplicate or malformed parameter.' };
  }
  const canonical = resolveCountyName(raw);
  if (!canonical) {
    return { value: null, error: FOUND_COUNTY_MESSAGES.invalid };
  }
  return { value: canonical, error: null };
}

/**
 * PHASE 16.1 (BATCH 1) — the classification endpoint's own words.
 *
 * `categoryInvalid` is deliberately byte-identical to the message
 * routes/lostReports.ts and routes/finderReport.ts already use for the same
 * condition, so "this category is not valid" reads the same wherever an operator
 * or a customer meets it.
 */
const CLASSIFY_MESSAGES = {
  notFound: 'That lost report could not be found.',
  categoryMissing: 'A category selection is required.',
  categoryInvalid: 'That item category is not valid.',
} as const;

/**
 * PHASE 16.1 (BATCH 1) — the optional UNCLASSIFIED-ONLY filter.
 *
 * `undefined` means "not supplied" -> no category constraint, which is what the
 * console sends when the box is unticked, so the default request is unchanged.
 *
 * Only the two literal spellings are accepted. Anything else is a 400 rather
 * than being coerced with `Boolean(raw)`: `?unclassified=no` must not silently
 * mean `true`, and `?unclassified=0` must not silently mean `false`. An
 * administrator asking for unclassified reports and being shown classified ones
 * (or the reverse) would be a worse outcome than an honest error.
 */
function unclassifiedFilter(raw: unknown): { value: boolean; error: string | null } {
  if (raw === undefined) return { value: false, error: null };
  if (raw === 'true') return { value: true, error: null };
  if (raw === 'false') return { value: false, error: null };
  return { value: false, error: 'Value must be true or false.' };
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
        return res.status(403).json({ error: 'Access denied.' });
      }

      const q = (req.query ?? {}) as Record<string, unknown>;

      const limit = boundedInt(q.limit, 1, ADMIN_LOST_REPORTS_MAX_LIMIT, ADMIN_LOST_REPORTS_DEFAULT_LIMIT);
      if (limit.error) return res.status(400).json({ error: limit.error });

      const offset = boundedInt(q.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      if (offset.error) return res.status(400).json({ error: offset.error });

      // PHASE 16.1 (GEO-16-04): an optional canonical county filter, validated
      // before the query is built. `county` is a plain equality on the indexed
      // `lost_reports.county` column (idx_lost_reports_county), applied to the
      // SAME bounded page query as `limit`/`offset` — so the page, the resulting
      // `hasMore` and the possible-match counts all describe the filtered set.
      const county = countyFilter(q.county);
      if (county.error) return res.status(400).json({ error: county.error });

      // PHASE 16.1 (BATCH 1): the unclassified-only filter, validated the same
      // way as every other query parameter and composed with `county` in the
      // SAME bounded query — so the page, `hasMore` and the possible-match
      // counts all describe the filtered set rather than an unfiltered one.
      const unclassifiedOnly = unclassifiedFilter(q.unclassified);
      if (unclassifiedOnly.error) return res.status(400).json({ error: unclassifiedOnly.error });

      const { rows, hasMore } = await db.listAdminLostReports({
        limit: limit.value,
        offset: offset.value,
        county: county.value,
        unclassifiedOnly: unclassifiedOnly.value,
      });

      // POSSIBLE-MATCH COUNTS.
      // Computed only for reports the platform is actually matching (the one
      // status the backend produces candidates for). A closed report gets null,
      // which the UI renders as "not applicable" rather than a misleading 0.
      //
      // PHASE 16.1 (BATCH 1): an UNCLASSIFIED active report also gets null, for
      // the same reason it gets no candidates — category-dependent matching is
      // deferred until it is classified. Reporting "0" would read as "we looked
      // and found nothing", which is not what happened; the truth is "we cannot
      // look yet". The engine is asked about classified reports only, so no
      // guessed category is ever involved.
      //
      // The claimable-item set is loaded AT MOST ONCE per request, and only if
      // the page actually contains a classifiable active report — so a page of
      // closed or unclassified reports costs no item query at all. Complexity is
      // the same as the customer-facing matches route: one indexed query plus one
      // batched dispute lookup, then a deterministic in-memory comparison per row.
      const activeRows = rows.filter(
        (report) => report.status === DEFAULT_LOST_REPORT_STATUS && isLostReportClassified(report),
      );
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

  // ---------------------------------------------------------------------------
  // PATCH /api/admin/lost-reports/:id/classify   (PHASE 16.1 — BATCH 1)
  //
  // Sets, changes, or CLEARS a lost report's item category.
  //
  // AUTHORIZATION: identical to every other route in this module —
  // authenticateJWT (signature + expiry) -> requireCurrentAdminSession (live
  // admin account: is_active + token_version) -> the inline `role !== 'admin'`
  // check. The role check is REQUIRED, not decorative: authenticateJWT does not
  // look at the role, so without it an 'admin_pending_2fa' token would reach a
  // mutation.
  //
  // REQUEST BODY: `{ categoryId: string | null }`, and the KEY MUST BE PRESENT.
  //   - a non-empty string   -> classify (must be a live, ACTIVE category);
  //   - `null` (or '')       -> UNCLASSIFY, i.e. return it to the unclassified
  //                             queue deliberately.
  // A body with no `categoryId` key at all is REFUSED rather than read as
  // "clear it": the route cannot tell "the operator chose nothing" from "the
  // client sent the wrong field name", and silently wiping a classification is
  // the one destructive outcome this endpoint must never produce by accident.
  //
  // RESPONSE: `{ success: true, previousCategory, newCategory }` where each
  // value is a category id or null. No other report field is echoed, so this
  // endpoint cannot be used to read a report.
  //
  // IDEMPOTENT BY NATURE: classifying to the category a report already has is a
  // successful no-op, so a doubled request cannot corrupt anything. The console
  // additionally guards against duplicate submission per row.
  // ---------------------------------------------------------------------------
  app.patch('/api/admin/lost-reports/:id/classify', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied.' });
      }

      // The reference is used EXACTLY as received (trimmed only). It is the
      // table's primary key and the console sends back the value the list
      // returned, so there is no case folding here: guessing at case could make
      // this endpoint act on a value the caller never sent.
      const reference = String(req.params.id || '').trim();
      // NOTE: there is deliberately no separate reference-SHAPE check here. The
      // lookup below IS the check: the reference is the table's primary key, so a
      // malformed value is simply a miss, and a miss gets the same 404 as an
      // unknown one. That keeps this endpoint from becoming a "is this reference
      // well-formed?" oracle, and keeps it consistent with the customer routes'
      // rule that malformed and unknown are indistinguishable.

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(body, 'categoryId')) {
        return res.status(400).json({ error: CLASSIFY_MESSAGES.categoryMissing });
      }

      const raw = body.categoryId;
      if (raw !== null && raw !== undefined && typeof raw !== 'string') {
        return res.status(400).json({ error: CLASSIFY_MESSAGES.categoryInvalid });
      }
      const supplied = typeof raw === 'string' ? raw.trim() : '';
      const categoryId = supplied ? supplied : null;

      // Only a SUPPLIED category is validated. `null` is a valid request: it is
      // how a report is deliberately returned to unclassified.
      if (categoryId) {
        const categories = await db.getActiveCategories();
        if (!categories.some((category: any) => category && category.id === categoryId)) {
          return res.status(400).json({ error: CLASSIFY_MESSAGES.categoryInvalid });
        }
      }

      const existing = await db.getLostReportById(reference);
      if (!existing) {
        return res.status(404).json({ error: CLASSIFY_MESSAGES.notFound });
      }

      const previousCategory = existing.category_id ?? null;
      const actor = req.user?.username || req.user?.userId || 'admin';
      const updated = await db.classifyLostReport(reference, categoryId, actor);

      return res.json({
        success: true,
        previousCategory,
        // Read back what was actually stored rather than echoing the request, so
        // the console can never show a classification the database did not take.
        newCategory: updated ? (updated.category_id ?? null) : categoryId,
      });
    } catch (e: any) {
      return sendServerError(res, e, 'ADMIN_LOST_REPORT_CLASSIFY_ERROR');
    }
  });
}
