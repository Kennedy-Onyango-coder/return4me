// Admin dispute-adjudication routes: the on-demand evidence reader and the
// dispute-resolution action.
//
// WHY THIS IS A SEPARATE MODULE
// These two routes lived inline inside server.ts's startServer(), which made
// them impossible to exercise over real HTTP in a test — server.ts constructs
// the whole application and calls startServer() at import time (Vite
// middleware, background sweeps, listeners). routes/customerClaims.ts was
// extracted for exactly this reason in Phase 2, and this follows the same
// pattern: the caller passes the REAL middleware and the REAL error helper in,
// so an integration test can mount an Express app around the REAL handlers.
// The handler bodies are moved verbatim.
//
// AUTHORIZATION MODEL (unchanged)
//   authenticateJWT            -> signature + expiry only
//   requireCurrentAdminSession -> re-checks the live admin account
//                                 (is_active + token_version) on every request
//   inline role check          -> req.user?.role === 'admin'
// All three remain required; none is weakened by this move.
import type { Express } from 'express';
import { db } from '../db/database.ts';
import { authenticateJWT } from '../services/auth.ts';
// BATCH 3 - in-app customer notification producers for the refund transitions.
import {
  produceClaimNotSuccessful,
  produceRefundComplete,
} from '../services/claimNotificationProducers.ts';

import { PaymentService } from '../services/payments.ts';

export interface AdminDisputeRouteDeps {
  /** The real requireCurrentAdminSession from server.ts (not importable — it
   *  is defined inside that module, which boots the app on import). */
  requireCurrentAdminSession: (req: any, res: any, next: any) => void;
  /** The real sendServerError helper from server.ts. */
  sendServerError: (res: any, error: any, context: string) => void;
}

export function registerAdminDisputeRoutes(app: Express, deps: AdminDisputeRouteDeps): void {
  const { requireCurrentAdminSession, sendServerError } = deps;

  // Admin-only, on-demand (not bundled into the main dashboard payload,
  // which every admin page-load fetches — evidence can include photos and
  // is only actually needed when an admin opens a specific dispute).
  //
  // Returns 404 for a dispute that does not exist, rather than an empty
  // evidence list: "this dispute has no evidence" and "this dispute does not
  // exist" are different answers, and the console must be able to tell them
  // apart to show an honest state.
  app.get('/api/admin/disputes/:disputeId/evidence', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied.' });
      }
      const disputeId = String(req.params.disputeId || '').trim();
      if (!disputeId) {
        return res.status(400).json({ error: 'Dispute ID is required.' });
      }
      const dispute = await db.getDispute(disputeId);
      if (!dispute) {
        return res.status(404).json({ error: 'Dispute not found.' });
      }
      const evidence = await db.getDisputeEvidenceForDispute(disputeId);
      res.json({ success: true, evidence });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/disputes/resolve', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied.' });
      }

      // Validate BEFORE touching any state. resolveDispute() keeps its own
      // transactional guards (defence in depth), but an invalid request must
      // be a clean 4xx that mutates nothing and writes no audit entry. The
      // previous behaviour funnelled every invalid request into a 500 via
      // sendServerError, and a missing winningClaimId (which the console used
      // to send because of a field-name mismatch) could never succeed at all.
      const disputeId = typeof req.body?.disputeId === 'string' ? req.body.disputeId.trim() : '';
      const winningClaimId = typeof req.body?.winningClaimId === 'string' ? req.body.winningClaimId.trim() : '';
      const adminNotes = typeof req.body?.adminNotes === 'string' ? req.body.adminNotes.trim() : '';

      if (!disputeId) {
        return res.status(400).json({ error: 'Dispute ID is required.' });
      }
      if (!winningClaimId) {
        return res.status(400).json({ error: 'Select the winning claimant before resolving.' });
      }

      const dispute = await db.getDispute(disputeId);
      if (!dispute) {
        return res.status(404).json({ error: 'Dispute not found.' });
      }
      if (dispute.resolved_by || dispute.resolved_at) {
        return res.status(409).json({ error: 'This dispute has already been resolved.' });
      }
      if (winningClaimId !== dispute.claimant_1_claim_id && winningClaimId !== dispute.claimant_2_claim_id) {
        return res.status(400).json({ error: 'That claim does not belong to this dispute.' });
      }

      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      // D-B2: resolveDispute() throws a TYPED ClaimStateConflictError when this
      // request lost the resolved_at CAS race to a concurrent admin. That is a
      // known state conflict and must be answered 409 — it used to fall through
      // to sendServerError() and surface as a 500, which told the admin "server
      // error" for what is really "someone else already resolved it".
      // Everything else keeps the original generic 500 handling, so a genuine
      // database failure is still never disguised as a 4xx.
      let result;
      try {
        result = await db.resolveDispute(disputeId, winningClaimId, adminIdentifier, adminNotes);
      } catch (resolveErr: any) {
        if (resolveErr?.conflictCode === 'STATE_CONFLICT') {
          return res.status(409).json({
            error: 'This dispute was just resolved by another admin. Please refresh.',
          });
        }
        if (resolveErr?.conflictCode === 'INVALID_TRANSITION') {
          return res.status(409).json({
            error: 'The claim state does not permit this action.',
          });
        }
        throw resolveErr;
      }

      // BATCH 3 / P8 - customer notification for the losing, paid claimant.
      //
      // POST-COMMIT BY DESIGN. resolveDispute() above has already committed in
      // its own transaction; this runs strictly afterwards, so notification
      // success can never determine whether the dispute commits, and a producer
      // failure can never roll back an adjudicated decision. The producer itself
      // cannot throw (it catches and returns null), so the route below is
      // unaffected either way.
      //
      // Guarded on `refundNeededForClaimId`, which is the authoritative signal
      // that resolveDispute actually locked a PAID losing claim into 'refunding'.
      // An unpaid losing claimant is rejected rather than refunded and produces no
      // payment notification, which is correct: no money is being returned to them.
      //
      // resolveDispute has exactly ONE caller in this codebase (verified during
      // Batch 3 discovery), so this site is the complete choke point rather than
      // one of several. finalizeClaimRefund is called from two places and is
      // therefore wired at both.
      if (result.refundNeededForClaimId) {
        await produceClaimNotSuccessful(result.refundNeededForClaimId);
      }


      // If the losing claimant had already paid into escrow, they were
      // locked into 'refunding' by resolveDispute above. Trigger the real
      // M-Pesa refund now — outside the DB transaction, since it's a
      // network call to IntaSend.
      //
      // BATCH 1B-C1-R1 / R2 — 'completed' means ONE thing only: an authoritative
      // provider confirmation that THIS individual refund transaction settled.
      // It does NOT mean "the initiation call returned 2xx", and since
      // BATCH 1B-C1-R2 it no longer means "the initiation response contained a
      // TS100" either: PaymentService.triggerIntasendRefund reports EVERY HTTP
      // 2xx from /send-money/initiate/ as 'unknown', because an initiation
      // response is a submission receipt, not a settlement record. No
      // authoritative refund-status confirmation mechanism exists yet in this
      // codebase, so the 'completed' branch below is retained for that future
      // mechanism and is NOT reachable from an initiation response today. The
      // three results are therefore:
      //
      //   'completed' — authoritative provider-confirmed settlement (not
      //                 reachable from the initiation path today): finalize the
      //                 claim as 'refunded' and notify the customer.
      //   'unknown'   — EVERY initiation response: accepted-but-unsettled,
      //                 preview/approval-pending (BP103), pending (TP101), a
      //                 per-transaction TS100, malformed/absent evidence, or a
      //                 timeout/5xx. The money may or may not have moved. Leave
      //                 the claim LOCKED in 'refunding', audit it, notify NOBODY,
      //                 and take no automatic action (the admin
      //                 refund-reconciliation endpoints resolve it after an
      //                 operator has confirmed the transfer with the provider).
      //   'failed'    — the provider refused the request with a definite 4xx:
      //                 no transfer was executed, so the refund lock can be
      //                 released (claim 'rejected', money still flagged for a
      //                 manual refund).
      //
      // A failure or an unverified outcome does NOT roll back the dispute
      // decision (the winner has already been decided); it reverts just the
      // loser's claim, or leaves the refund lock in place, and flags it in the
      // audit log for manual admin reconciliation, exactly like a failed payout
      // during normal escrow release.
      if (result.refundNeededForClaimId && result.refundAmount && result.refundPhone) {
        const refundResult = await PaymentService.triggerIntasendRefund(
          result.refundPhone,
          parseFloat(result.refundAmount),
          result.refundNeededForClaimId
        );
        if (refundResult.outcome === 'completed') {
          const refundFinalized = await db.finalizeClaimRefund(result.refundNeededForClaimId, result.refundAmount, result.refundPhone, adminIdentifier);
          // BATCH 3 / P9 - customer notification for the completed refund.
          //
          // Guarded on the finalizeClaimRefund return value, which is true ONLY
          // for the call that actually performed the refunding -> refunded CAS.
          // That is the idempotency guard: a repeated reconciliation of a claim
          // that is no longer in 'refunding' returns false and stays silent.
          //
          // Note the deliberate distinction from the unknown branch below: an
          // UNCONFIRMED outcome (a timeout, but equally EVERY initiation
          // response — accepted-but-unsettled, preview/approval-pending (BP103),
          // pending (TP101), a per-transaction TS100, or an unreadable body)
          // leaves the claim in 'refunding' and notifies NOTHING, because an
          // initiation response cannot tell us whether the money moved. Only an
          // authoritative provider confirmation of THIS transaction — from a
          // mechanism that does not exist yet for refunds — could produce a
          // customer-visible completion through this branch.
          if (refundFinalized) {
            await produceRefundComplete(result.refundNeededForClaimId);
          }
        } else if (refundResult.outcome === 'unknown') {
          // FIX #4 (audit finding A1): a network timeout/exception means we
          // do NOT know whether IntaSend executed the refund. Treating that
          // as a definite failure (the previous behavior) moved the claim to
          // terminal 'rejected' even though the owner's money may have been
          // sent — and any retry could double-refund. Instead: leave the
          // claim locked in 'refunding' (excluded from
          // uq_claims_one_active_per_item, so the winner remains the sole
          // active claim), record an audit entry for reconciliation, and
          // take NO automatic action.
          //
          // BATCH 1B-C1-R1 widened this branch from "network error" to every
          // outcome that is not PROOF of a completed transfer. BATCH 1B-C1-R2
          // makes it the ONLY branch an initiation response can reach: every HTTP
          // 2xx from /send-money/initiate/ is reported 'unknown', whether it
          // carries acceptance, a preview/approval-pending batch (BP103), a
          // pending transaction (TP101), a per-transaction TS100, or nothing
          // readable at all. All of them are the same operational situation the
          // A1 discipline already describes: the money may have moved and we
          // cannot tell, so nothing is finalized and nobody is notified. Like a
          // timeout, none of them is auto-retried; the refund-reconciliation
          // endpoints are the way out.
          await db.logAudit(
            adminIdentifier,
            'REFUND_UNKNOWN_OUTCOME',
            `Claim ${result.refundNeededForClaimId}: the refund initiation request to IntaSend returned an UNCONFIRMED outcome. BATCH 1B-C1-R2: an initiation response is never proof that the refund was paid out — every HTTP 2xx from /send-money/initiate/ (accepted, preview/approval-pending BP103, pending TP101, a per-transaction TS100, or an unreadable body alike), plus 408/5xx and transport errors, is recorded as unresolved. The claim remains locked in 'refunding' and NO refund-completion notification has been sent. No automatic retry has been issued. Manual provider reconciliation is required: confirm with IntaSend whether the refund executed, then finalizeClaimRefund (executed) or revertClaimRefundLock (not executed).`
          );
          return res.status(207).json({
            success: true,
            message: 'Dispute resolved, but the losing claimant\'s refund is NOT confirmed: an IntaSend initiation response cannot confirm that this specific refund transaction was paid out. The claim remains in refunding and no completion notice was sent — confirm the transfer with IntaSend, then use the refund-reconciliation actions.',
            refundUnknown: true,
          });
        } else {
          // Definite provider rejection: a 4xx (excluding 408), i.e. IntaSend
          // received the request and refused it before executing anything — the
          // refund was NOT executed, so reverting the claim's refund lock is
          // safe. 5xx and 408 are deliberately NOT here: they are ambiguous and
          // are reported as 'unknown' by triggerIntasendRefund so this branch
          // can never release a lock for a refund that may have been accepted.
          await db.revertClaimRefundLock(result.refundNeededForClaimId, 'IntaSend refund disbursement rejected by provider', adminIdentifier);
          return res.status(207).json({
            success: true,
            message: 'Dispute resolved, but the losing claimant\'s refund failed to go through. Manual admin follow-up is required.',
            refundFailed: true,
          });
        }
      }

      res.json({ success: true, message: 'The dispute was resolved successfully based on the evidence submitted.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });
}
