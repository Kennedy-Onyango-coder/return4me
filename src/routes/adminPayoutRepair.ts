// Payout repair administration routes (Phase 1 — payout readiness).
//
// WHY THIS IS A SEPARATE MODULE
// -----------------------------
// Same reason as routes/adminClaims.ts and routes/adminDisputes.ts: server.ts
// constructs the whole application and calls startServer() at import time, so an
// HTTP integration test cannot import it. The caller injects the REAL middleware
// and the REAL error helper, so a test can mount an app around the REAL handlers.
//
// LAYERING
//   route layer   : authentication, authorization, validation, HTTP mapping
//   service layer : authorization again, input normalisation, error mapping
//   data layer    : evidence read + the one atomic repair transaction
//   policy layer  : config/payoutRepairPolicy.ts (the ONE eligibility rule)
//
// AUTHORIZATION — DENIED TO EVERY ROLE BY DEFAULT
// ----------------------------------------------
//   authenticateJWT             -> signature + expiry
//   requireCurrentAdminSession  -> live admin account (is_active + token_version)
//   requireAdminPermission(..)  -> claims.payout_repair_propose / _confirm
//   inline role check           -> req.user?.role === 'admin'
//
// Both permissions are granted to NO role (see adminPermissions.ts), so in
// production these routes currently answer 403 for everyone, including the
// seeded administrator. That is intentional: granting them is a separate,
// reviewed decision, and the endpoints must exist and be enforceable before
// anyone is allowed to use them.
//
// WHAT THESE ROUTES CANNOT DO
// ---------------------------
// No provider call, no payout submission, no arbitrary ledger edit. The confirm
// route's only effect is the single CHECK-constrained transition applied by the
// data layer, for a DIFFERENT administrator than the proposer.
//
// PRIVACY
// -------
// No response body or log line contains a full phone number, wallet identifier,
// credential or free-text provider statement. Refusals name stable codes and,
// for an ineligible row, the PII-free blocking code list.
import type { Express } from 'express';
import { authenticateJWT } from '../services/auth.ts';
import { ADMIN_PERMISSIONS, requireAdminPermission } from '../services/adminPermissions.ts';
import {
  proposePayoutRepair,
  confirmPayoutRepair,
  PAYOUT_REPAIR_RESULT_CODES,
  type PayoutRepairServiceDeps,
} from '../services/payoutRepair.ts';

export interface AdminPayoutRepairRouteDeps {
  /** The real requireCurrentAdminSession from server.ts (not importable). */
  requireCurrentAdminSession: (req: any, res: any, next: any) => void;
  /** The real sendServerError helper from server.ts. */
  sendServerError: (res: any, error: any, context: string) => void;
  /**
   * Optional override of the permission guard. Production omits it and gets the
   * REAL requireAdminPermission; it exists so an HTTP test can exercise the
   * genuine 403 branch, and so the authorized branch can be exercised at all
   * while no role holds the permission.
   */
  requireAdminPermission?: (permission: string) => (req: any, res: any, next: any) => void;
  /** Optional service seam (see PayoutRepairServiceDeps). Production omits it. */
  serviceDeps?: PayoutRepairServiceDeps;
  /** Optional operation seams. Production omits them and gets the real service. */
  propose?: typeof proposePayoutRepair;
  confirm?: typeof confirmPayoutRepair;
}

/**
 * HTTP status for each stable result code. Deliberately explicit: a new code
 * must be classified here rather than silently defaulting to 200/500, and 409 is
 * used for every "the world moved" conflict so a client can distinguish it from
 * a malformed request (400) or an ineligible row (422).
 */
const HTTP_STATUS_BY_CODE: Record<string, number> = {
  [PAYOUT_REPAIR_RESULT_CODES.PROPOSED]: 201,
  [PAYOUT_REPAIR_RESULT_CODES.CONFIRMED]: 200,
  [PAYOUT_REPAIR_RESULT_CODES.FORBIDDEN]: 403,
  [PAYOUT_REPAIR_RESULT_CODES.MISSING_ACTOR]: 403,
  [PAYOUT_REPAIR_RESULT_CODES.INVALID_LEDGER_ENTRY_ID]: 400,
  [PAYOUT_REPAIR_RESULT_CODES.INVALID_REASON]: 400,
  [PAYOUT_REPAIR_RESULT_CODES.INVALID_REQUEST_ID]: 400,
  [PAYOUT_REPAIR_RESULT_CODES.NOT_FOUND]: 404,
  [PAYOUT_REPAIR_RESULT_CODES.INELIGIBLE]: 422,
  [PAYOUT_REPAIR_RESULT_CODES.EXPIRED]: 409,
  [PAYOUT_REPAIR_RESULT_CODES.SELF_CONFIRMATION_FORBIDDEN]: 409,
  [PAYOUT_REPAIR_RESULT_CODES.ALREADY_CONFIRMED]: 409,
  [PAYOUT_REPAIR_RESULT_CODES.REQUEST_NOT_OPEN]: 409,
  [PAYOUT_REPAIR_RESULT_CODES.REQUEST_TAMPERED]: 409,
  [PAYOUT_REPAIR_RESULT_CODES.UNSUPPORTED_OPERATION]: 409,
  [PAYOUT_REPAIR_RESULT_CODES.STALE_TARGET_STATE]: 409,
  [PAYOUT_REPAIR_RESULT_CODES.DUPLICATE_OPEN_REQUEST]: 409,
  [PAYOUT_REPAIR_RESULT_CODES.WRITE_FAILED]: 503,
};

/** Short, PII-free explanation per code. Never echoes input. */
const MESSAGE_BY_CODE: Record<string, string> = {
  [PAYOUT_REPAIR_RESULT_CODES.FORBIDDEN]: 'Access denied.',
  [PAYOUT_REPAIR_RESULT_CODES.MISSING_ACTOR]: 'Access denied.',
  [PAYOUT_REPAIR_RESULT_CODES.INVALID_LEDGER_ENTRY_ID]: 'A valid ledgerEntryId is required.',
  [PAYOUT_REPAIR_RESULT_CODES.INVALID_REASON]: 'A reason of 10 to 1000 characters is required.',
  [PAYOUT_REPAIR_RESULT_CODES.INVALID_REQUEST_ID]: 'A valid repair request id is required.',
  [PAYOUT_REPAIR_RESULT_CODES.NOT_FOUND]: 'Repair request not found.',
  [PAYOUT_REPAIR_RESULT_CODES.INELIGIBLE]: 'The payout row is not eligible for an audited repair.',
  [PAYOUT_REPAIR_RESULT_CODES.EXPIRED]: 'The repair proposal has expired.',
  [PAYOUT_REPAIR_RESULT_CODES.SELF_CONFIRMATION_FORBIDDEN]:
    'A repair must be confirmed by a different administrator than the proposer.',
  [PAYOUT_REPAIR_RESULT_CODES.ALREADY_CONFIRMED]: 'The repair request has already been confirmed.',
  [PAYOUT_REPAIR_RESULT_CODES.REQUEST_NOT_OPEN]: 'The repair request is no longer open.',
  [PAYOUT_REPAIR_RESULT_CODES.REQUEST_TAMPERED]: 'The repair request failed its integrity check.',
  [PAYOUT_REPAIR_RESULT_CODES.UNSUPPORTED_OPERATION]: 'The repair operation is not supported.',
  [PAYOUT_REPAIR_RESULT_CODES.STALE_TARGET_STATE]:
    'The payout row changed after the proposal; propose the repair again.',
  [PAYOUT_REPAIR_RESULT_CODES.DUPLICATE_OPEN_REQUEST]:
    'An open repair request already exists for this payout row.',
  [PAYOUT_REPAIR_RESULT_CODES.WRITE_FAILED]: 'The repair could not be recorded. Nothing was applied.',
};

function statusFor(code: string): number {
  return HTTP_STATUS_BY_CODE[code] ?? 500;
}

/**
 * The authenticated administrator's identity, or null.
 *
 * Deliberately NO `'admin'` fallback: this endpoint's entire safety property is
 * that two DISTINCT administrators act, so an identity that cannot be named
 * cannot confirm anything.
 */
function actorFromRequest(req: any): { username: string; role: string } | null {
  const username = req?.user?.username || req?.user?.userId;
  const role = req?.user?.role;
  if (typeof username !== 'string' || username.trim() === '') return null;
  if (typeof role !== 'string') return null;
  return { username: username.trim(), role };
}

function refusal(res: any, code: string, extra: Record<string, unknown> = {}) {
  return res.status(statusFor(code)).json({
    success: false,
    code,
    error: MESSAGE_BY_CODE[code] ?? 'The payout repair request was refused.',
    ...extra,
  });
}

/**
 * The eligibility summary a client may see: the decision and the PII-free
 * blocking codes/reasons. `evidence` (which holds the masked destination and
 * internal counts) is intentionally excluded from HTTP responses.
 */
function eligibilitySummary(eligibility: any) {
  if (!eligibility) return undefined;
  return {
    eligible: Boolean(eligibility.eligible),
    blockingCodes: Array.isArray(eligibility.blockingCodes) ? eligibility.blockingCodes : [],
    blockingReasons: Array.isArray(eligibility.blockingReasons) ? eligibility.blockingReasons : [],
  };
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

export function registerAdminPayoutRepairRoutes(app: Express, deps: AdminPayoutRepairRouteDeps): void {
  const { requireCurrentAdminSession, sendServerError } = deps;
  const permissionGuard = deps.requireAdminPermission ?? requireAdminPermission;
  const serviceDeps = deps.serviceDeps;
  const propose = deps.propose ?? proposePayoutRepair;
  const confirm = deps.confirm ?? confirmPayoutRepair;

  // POST /api/admin/payout-repairs
  //
  // Proposes an audited repair of ONE payout leg. Creates a 24-hour request and
  // an audit row; changes NOTHING about the payout. Body: { ledgerEntryId, reason }.
  app.post(
    '/api/admin/payout-repairs',
    authenticateJWT,
    requireCurrentAdminSession,
    permissionGuard(ADMIN_PERMISSIONS.CLAIMS_PAYOUT_REPAIR_PROPOSE),
    async (req, res) => {
      try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Access denied.' });

        const actor = actorFromRequest(req);
        if (!actor) return refusal(res, PAYOUT_REPAIR_RESULT_CODES.MISSING_ACTOR);

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const result = await propose(
          { ledgerEntryId: body.ledgerEntryId, reason: body.reason, actor },
          serviceDeps,
        );

        if (!result.ok) {
          return refusal(res, result.code, {
            blockingCodes: result.eligibility?.blockingCodes,
            blockingReasons: result.eligibility?.blockingReasons,
          });
        }

        // NOTE: no destination, amount or phone number in the response.
        return res.status(statusFor(result.code)).json({
          success: true,
          code: result.code,
          data: {
            requestId: result.requestId,
            expiresAt: result.expiresAt,
            decision: eligibilitySummary(result.eligibility),
          },
        });
      } catch (e: any) {
        sendServerError(res, e, 'UNHANDLED_PAYOUT_REPAIR_PROPOSE_ERROR');
      }
    },
  );

  // POST /api/admin/payout-repairs/:requestId/confirm
  //
  // Confirms ANOTHER administrator's proposal. The data layer re-reads and
  // re-evaluates everything inside one transaction. Body: none required.
  app.post(
    '/api/admin/payout-repairs/:requestId/confirm',
    authenticateJWT,
    requireCurrentAdminSession,
    permissionGuard(ADMIN_PERMISSIONS.CLAIMS_PAYOUT_REPAIR_CONFIRM),
    async (req, res) => {
      try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Access denied.' });

        const actor = actorFromRequest(req);
        if (!actor) return refusal(res, PAYOUT_REPAIR_RESULT_CODES.MISSING_ACTOR);

        const result = await confirm({ requestId: req.params?.requestId, actor }, serviceDeps);

        if (!result.ok) {
          return refusal(res, result.code, {
            blockingCodes: result.eligibility?.blockingCodes,
            blockingReasons: result.eligibility?.blockingReasons,
          });
        }

        return res.status(statusFor(result.code)).json({
          success: true,
          code: result.code,
          data: {
            requestId: result.requestId,
            confirmedBy: result.confirmedBy,
            decision: eligibilitySummary(result.eligibility),
          },
        });
      } catch (e: any) {
        sendServerError(res, e, 'UNHANDLED_PAYOUT_REPAIR_CONFIRM_ERROR');
      }
    },
  );
}
