// Claims Administration read routes (Phase 6E).
//
// WHY THIS IS A SEPARATE MODULE
// Same reason as routes/adminDisputes.ts: server.ts constructs the whole
// application and calls startServer() at import time, so an HTTP integration
// test cannot import it. The caller injects the REAL middleware and the REAL
// error helper, so a test can mount an app around the REAL handlers.
//
// LAYERING (kept separate on purpose)
//   route layer   : authentication, authorization, validation, pagination
//                   envelope, read-audit                       (this file)
//   data layer    : db.listAdminClaims / db.getAdminClaimDetail
//   privacy layer : toAdminSafeClaimListView / toAdminSafeClaimDetailView
//
// AUTHORIZATION MODEL
//   authenticateJWT             -> signature + expiry
//   requireCurrentAdminSession  -> live admin account (is_active + token_version)
//   requireAdminPermission(..)  -> claims.read / claims.detail
//   inline role check           -> req.user?.role === 'admin'
//
// READ-ONLY: GET handlers only. No claim mutation endpoint is added here;
// lifecycle changes remain the exclusive province of transitionClaimStatus()
// and the existing admin actions.
import type { Express } from 'express';
import { db, ADMIN_CLAIMS_MAX_LIMIT, ADMIN_CLAIMS_DEFAULT_LIMIT } from '../db/database.ts';
import type { AdminClaimListFilters } from '../db/database.ts';
import { authenticateJWT, toE164Kenyan } from '../services/auth.ts';
import { toAdminSafeClaimListView, toAdminSafeClaimDetailView } from '../services/adminSafeViews.ts';
import { ADMIN_PERMISSIONS, requireAdminPermission } from '../services/adminPermissions.ts';
import { CLAIM_STATUS_VALUES } from '../config/claimStatuses.ts';

export interface AdminClaimRouteDeps {
  /** The real requireCurrentAdminSession from server.ts (not importable). */
  requireCurrentAdminSession: (req: any, res: any, next: any) => void;
  /** The real sendServerError helper from server.ts. */
  sendServerError: (res: any, error: any, context: string) => void;
  /**
   * Optional override of the permission guard. Production omits it and gets the
   * REAL requireAdminPermission; it exists so an HTTP test can exercise the
   * genuine 403 branch without inventing a second authentication mechanism.
   */
  requireAdminPermission?: (permission: string) => (req: any, res: any, next: any) => void;
}

// ---------------------------------------------------------------------------
// QUERY VALIDATION
// ---------------------------------------------------------------------------
// Every query parameter is untrusted. These helpers are intentionally strict:
// they accept only the exact shapes below and never silently coerce, so
// 'abc' / 'NaN' / 'Infinity' / '-5' / '1e9' cannot become a number, and an
// array (a duplicated parameter) is rejected rather than silently taking a
// member.
//
// They never build SQL. Validated values are handed to the Drizzle query
// builder, which parameterises them; no value is ever interpolated into a
// statement.

// NOTE ON THE RETURN SHAPE: `{ value, error }` rather than a discriminated
// union. tsconfig.json does not enable `strict`/`strictNullChecks`, and under
// that configuration TypeScript does not reliably narrow a union on a boolean
// literal discriminant — a helper (and every caller) would silently treat
// `message` as possibly-absent. A plain nullable `error` field is checked the
// same way everywhere and needs no narrowing.

type Parsed<T> = { value: T; error: string | null };

/**
 * A single, non-repeated string parameter.
 * `undefined` means "not supplied" and is reported as such (so a caller can
 * apply a default); an array means the parameter was repeated, which is
 * ambiguous input and is always an error.
 */
function singleString(raw: unknown): Parsed<string | undefined> {
  if (raw === undefined) return { value: undefined, error: null };
  if (typeof raw !== 'string') {
    // Express turns a repeated parameter into an array — ambiguous input.
    return { value: undefined, error: 'Kigezo kimerudiwa au si sahihi. / Duplicate or malformed parameter.' };
  }
  return { value: raw, error: null };
}

/** A non-negative integer, accepted only as plain digits (no sign, dot or exponent). */
function boundedInt(raw: unknown, min: number, max: number, fallback: number): Parsed<number> {
  const s = singleString(raw);
  if (s.error) return { value: fallback, error: s.error };
  if (s.value === undefined) return { value: fallback, error: null };
  // An explicitly empty value (`?limit=`) is malformed, never a default.
  if (!/^\d+$/.test(s.value)) {
    return { value: fallback, error: 'Thamani lazima iwe nambari kamili. / Value must be a whole number.' };
  }
  const n = Number(s.value);
  if (!Number.isSafeInteger(n)) {
    return { value: fallback, error: 'Thamani ya nambari ni kubwa kupita kiasi. / Numeric value is too large.' };
  }
  if (n < min || n > max) {
    return { value: fallback, error: `Thamani lazima iwe kati ya ${min} na ${max}. / Value must be between ${min} and ${max}.` };
  }
  return { value: n, error: null };
}

/** Strict boolean: only the literal strings 'true' / 'false'. */
function strictBoolean(raw: unknown): Parsed<boolean | undefined> {
  const s = singleString(raw);
  if (s.error) return { value: undefined, error: s.error };
  if (s.value === undefined) return { value: undefined, error: null };
  if (s.value === 'true') return { value: true, error: null };
  if (s.value === 'false') return { value: false, error: null };
  return { value: undefined, error: 'Thamani lazima iwe true au false. / Value must be true or false.' };
}

/**
 * Repository identifiers are varchar(50) keys (e.g. `CLM-123456`). The accepted
 * charset deliberately allows `.`, `:` and `_` so a legitimate future ID format
 * is not rejected, while spaces, quotes, semicolons, backslashes and slashes —
 * the characters that make injection or path-shaped payloads interesting — are
 * refused outright.
 */
function repositoryId(raw: unknown, field: string): Parsed<string | undefined> {
  const s = singleString(raw);
  if (s.error) return { value: undefined, error: s.error };
  if (s.value === undefined) return { value: undefined, error: null };
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(s.value)) {
    return { value: undefined, error: `Kitambulisho si sahihi (${field}). / Malformed identifier (${field}).` };
  }
  return { value: s.value, error: null };
}

/** Date string that must actually parse. */
function parsedDate(raw: unknown, field: string): Parsed<Date | undefined> {
  const s = singleString(raw);
  if (s.error) return { value: undefined, error: s.error };
  if (s.value === undefined) return { value: undefined, error: null };
  const d = new Date(s.value);
  if (isNaN(d.getTime())) {
    return { value: undefined, error: `Tarehe si sahihi (${field}). / Malformed date (${field}).` };
  }
  return { value: d, error: null };
}

/** Exact claimant phone, normalised to E.164 the same way the rest of the app does. */
function claimantPhone(raw: unknown): Parsed<string | undefined> {
  const s = singleString(raw);
  if (s.error) return { value: undefined, error: s.error };
  if (s.value === undefined) return { value: undefined, error: null };
  const normalized = toE164Kenyan(s.value.replace(/\s+/g, ''));
  if (!/^\+254\d{9}$/.test(normalized)) {
    return { value: undefined, error: 'Nambari ya simu ya mdai si sahihi. / Malformed claimant phone number.' };
  }
  return { value: normalized, error: null };
}

/** `status` may be repeated and/or comma-separated; every value must be a real status. */
function statusList(raw: unknown): Parsed<string[] | undefined> {
  if (raw === undefined) return { value: undefined, error: null };
  const parts: string[] = [];
  const collect = (v: unknown): boolean => {
    if (typeof v !== 'string') return false;
    for (const piece of v.split(',')) {
      const t = piece.trim();
      if (t !== '') parts.push(t);
    }
    return true;
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!collect(entry)) return { value: undefined, error: 'Kigezo cha hali si sahihi. / Malformed status parameter.' };
    }
  } else if (!collect(raw)) {
    return { value: undefined, error: 'Kigezo cha hali si sahihi. / Malformed status parameter.' };
  }
  if (parts.length === 0) return { value: undefined, error: null };
  for (const s of parts) {
    if (!CLAIM_STATUS_VALUES.includes(s as any)) {
      return { value: undefined, error: 'Hali ya claim haijulikani. / Unknown claim status.' };
    }
  }
  return { value: Array.from(new Set(parts)), error: null };
}

const DISPUTE_STATES = ['none', 'open', 'resolved'] as const;

function disputeState(raw: unknown): Parsed<'none' | 'open' | 'resolved' | undefined> {
  const s = singleString(raw);
  if (s.error) return { value: undefined, error: s.error };
  if (s.value === undefined) return { value: undefined, error: null };
  if (!(DISPUTE_STATES as readonly string[]).includes(s.value)) {
    return { value: undefined, error: 'Kigezo cha mzozo si sahihi. / Malformed dispute state.' };
  }
  return { value: s.value as 'none' | 'open' | 'resolved', error: null };
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

export function registerAdminClaimRoutes(app: Express, deps: AdminClaimRouteDeps): void {
  const { requireCurrentAdminSession, sendServerError } = deps;
  const permissionGuard = deps.requireAdminPermission ?? requireAdminPermission;

  // GET /api/admin/claims
  //
  // Bounded, filtered, deterministically ordered page of claims. Reads only —
  // it never mutates a claim, never triggers a lifecycle transition, never
  // consumes an OTP and never touches payment state.
  //
  // NOT audit-logged, deliberately. Every admin console page-load and every
  // pagination step would otherwise write an audit row, producing a log storm
  // that would swamp the mutation records the audit trail exists to protect.
  // List access is a triage view; the meaningful read-audit event is opening
  // ONE claim (see the detail route below). This decision is documented in the
  // Phase 6E report.
  app.get('/api/admin/claims', authenticateJWT, requireCurrentAdminSession, permissionGuard(ADMIN_PERMISSIONS.CLAIMS_READ), async (req, res) => {
      try {
        if (req.user?.role !== 'admin') {
          return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
        }

        const q = (req.query ?? {}) as Record<string, unknown>;

        const limit = boundedInt(q.limit, 1, ADMIN_CLAIMS_MAX_LIMIT, ADMIN_CLAIMS_DEFAULT_LIMIT);
        if (limit.error) return res.status(400).json({ error: limit.error });

        const offset = boundedInt(q.offset, 0, Number.MAX_SAFE_INTEGER, 0);
        if (offset.error) return res.status(400).json({ error: offset.error });

        const hasPaid = strictBoolean(q.hasPaid);
        if (hasPaid.error) return res.status(400).json({ error: hasPaid.error });

        const statuses = statusList(q.status);
        if (statuses.error) return res.status(400).json({ error: statuses.error });

        const dispute = disputeState(q.disputeState);
        if (dispute.error) return res.status(400).json({ error: dispute.error });

        const claimIdFilter = repositoryId(q.claimId, 'claimId');
        if (claimIdFilter.error) return res.status(400).json({ error: claimIdFilter.error });

        const itemIdFilter = repositoryId(q.itemId, 'itemId');
        if (itemIdFilter.error) return res.status(400).json({ error: itemIdFilter.error });

        const phoneFilter = claimantPhone(q.claimantPhone);
        if (phoneFilter.error) return res.status(400).json({ error: phoneFilter.error });

        const createdFrom = parsedDate(q.createdFrom, 'createdFrom');
        if (createdFrom.error) return res.status(400).json({ error: createdFrom.error });

        const createdTo = parsedDate(q.createdTo, 'createdTo');
        if (createdTo.error) return res.status(400).json({ error: createdTo.error });

        // Query parameters that are not part of this contract are ignored, the
        // same way every other route in this repository treats them. They are
        // never forwarded into the query builder.

        const filters: AdminClaimListFilters = {
          statuses: statuses.value,
          hasPaid: hasPaid.value,
          itemId: itemIdFilter.value,
          claimId: claimIdFilter.value,
          claimantPhone: phoneFilter.value,
          createdFrom: createdFrom.value,
          createdTo: createdTo.value,
          disputeState: dispute.value,
        };

        const { rows, hasMore } = await db.listAdminClaims({
          filters,
          limit: limit.value,
          offset: offset.value,
        });

        return res.json({
          success: true,
          data: rows.map((row) => toAdminSafeClaimListView(row)),
          pagination: { limit: limit.value, offset: offset.value, hasMore },
        });
      } catch (e: any) {
        sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
      }
    },
  );

  // GET /api/admin/claims/:claimId
  //
  // One claim's operational record. This is the read that IS audited: it is a
  // deliberate, targeted look at a single claimant's case, and the audit entry
  // names the acting administrator.
  //
  // The audit row is written BEFORE the response is sent, so a failed audit can
  // never yield an unaudited 200. Nothing sensitive is recorded: the claim id,
  // its status and the acting admin only.
  app.get('/api/admin/claims/:claimId', authenticateJWT, requireCurrentAdminSession, permissionGuard(ADMIN_PERMISSIONS.CLAIMS_DETAIL), async (req, res) => {
      try {
        if (req.user?.role !== 'admin') {
          return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
        }

        const claimId = repositoryId(req.params.claimId, 'claimId');
        if (claimId.error) return res.status(400).json({ error: claimId.error });
        if (!claimId.value) {
          return res.status(400).json({ error: 'Kitambulisho cha claim kinahitajika. / Claim ID is required.' });
        }

        const row = await db.getAdminClaimDetail(claimId.value);
        if (!row) {
          return res.status(404).json({ error: 'Claim haikupatikana. / Claim not found.' });
        }

        // Authenticated identity only — never a body/query/header-supplied actor.
        const actor = req.user?.username || req.user?.userId || 'admin';
        await db.logAudit(
          actor,
          'CLAIM_DETAIL_VIEWED',
          `Admin ${actor} viewed claim ${row.id} (status ${row.status}).`,
        );

        return res.json({ success: true, claim: toAdminSafeClaimDetailView(row) });
      } catch (e: any) {
        sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
      }
    },
  );
}


