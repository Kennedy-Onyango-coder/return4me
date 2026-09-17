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
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const disputeId = String(req.params.disputeId || '').trim();
      if (!disputeId) {
        return res.status(400).json({ error: 'Kitambulisho cha mzozo kinahitajika. / Dispute ID is required.' });
      }
      const dispute = await db.getDispute(disputeId);
      if (!dispute) {
        return res.status(404).json({ error: 'Mzozo haukupatikana. / Dispute not found.' });
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
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
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
        return res.status(400).json({ error: 'Kitambulisho cha mzozo kinahitajika. / Dispute ID is required.' });
      }
      if (!winningClaimId) {
        return res.status(400).json({ error: 'Chagua mdai atakayeshinda kabla ya kusuluhisha. / Select the winning claimant before resolving.' });
      }

      const dispute = await db.getDispute(disputeId);
      if (!dispute) {
        return res.status(404).json({ error: 'Mzozo haukupatikana. / Dispute not found.' });
      }
      if (dispute.resolved_by || dispute.resolved_at) {
        return res.status(409).json({ error: 'Mzozo huu tayari umetatuliwa. / This dispute has already been resolved.' });
      }
      if (winningClaimId !== dispute.claimant_1_claim_id && winningClaimId !== dispute.claimant_2_claim_id) {
        return res.status(400).json({ error: 'Claim hii haihusiani na mzozo huu. / That claim does not belong to this dispute.' });
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
            error: 'Mzozo huu umetatuliwa na msimamizi mwingine hivi punde. Pakia upya. / This dispute was just resolved by another admin. Please refresh.',
          });
        }
        if (resolveErr?.conflictCode === 'INVALID_TRANSITION') {
          return res.status(409).json({
            error: 'Hali ya claim haikubali hatua hii. / The claim state does not permit this action.',
          });
        }
        throw resolveErr;
      }

      // If the losing claimant had already paid into escrow, they were
      // locked into 'refunding' by resolveDispute above. Trigger the real
      // M-Pesa refund now — outside the DB transaction, since it's a
      // network call to IntaSend — and only mark the refund complete once
      // the transfer actually succeeds. A definite provider rejection does
      // NOT roll back the dispute decision (the winner has already been
      // decided); it reverts just the loser's claim to 'rejected' and flags
      // it in the audit log for manual admin reconciliation, exactly like a
      // failed payout during normal escrow release.
      if (result.refundNeededForClaimId && result.refundAmount && result.refundPhone) {
        const refundResult = await PaymentService.triggerIntasendRefund(
          result.refundPhone,
          parseFloat(result.refundAmount),
          result.refundNeededForClaimId
        );
        if (refundResult.outcome === 'completed') {
          await db.finalizeClaimRefund(result.refundNeededForClaimId, result.refundAmount, result.refundPhone, adminIdentifier);
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
          await db.logAudit(
            adminIdentifier,
            'REFUND_UNKNOWN_OUTCOME',
            `Claim ${result.refundNeededForClaimId}: refund request to IntaSend ended in an ambiguous outcome (timeout/network error). The claim remains locked in 'refunding'. No automatic retry has been issued. Manual provider reconciliation is required: confirm with IntaSend whether the refund executed, then finalizeClaimRefund (executed) or revertClaimRefundLock (not executed).`
          );
          return res.status(207).json({
            success: true,
            message: 'Mzozo umetatuliwa, lakini hali ya urejeshaji wa fedha wa mdai aliyeshindwa haijathibitishwa (hitilafu ya mtandao). Msimamizi anahitaji kuthibitisha na IntaSend kabla ya hatua nyingine. / Dispute resolved, but the losing claimant\'s refund outcome is unverified (network error). The claim remains in refunding — confirm with IntaSend before any further action.',
            refundUnknown: true,
          });
        } else {
          // Definite provider rejection (IntaSend received the request and
          // refused it) — the refund was NOT executed, so reverting the
          // claim's refund lock is safe.
          await db.revertClaimRefundLock(result.refundNeededForClaimId, 'IntaSend refund disbursement rejected by provider', adminIdentifier);
          return res.status(207).json({
            success: true,
            message: 'Mzozo umetatuliwa, lakini urejeshaji wa fedha wa mdai aliyeshindwa umeshindwa kufaulu. Msimamizi anahitaji kufuatilia kwa mkono. / Dispute resolved, but the losing claimant\'s refund failed to go through. Manual admin follow-up is required.',
            refundFailed: true,
          });
        }
      }

      res.json({ success: true, message: 'Mzozo umetatuliwa kikamilifu kulingana na ushahidi uliowasilishwa.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });
}
