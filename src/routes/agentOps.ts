// P2-A3.4A - AGENT OPERATIONAL ROUTE EXTRACTION.
//
// These four routes are the Agent's physical item-handling surface: read the
// assigned queue, verify what the Finder submitted, approve it into the hub,
// or reject it. They were moved VERBATIM so a test can mount the real handlers
// over a real Express app. No behaviour, ordering, or message changes.
//
// SECURITY BOUNDARY (unchanged, and the reason these stay together)
//
//   * Every route runs `authenticateJWT` then `requireActiveAgent`, in that
//     order and before any database work.
//   * The agent identity ALWAYS comes from the verified server-side token
//     (req.user.agentId) or the resolved active-agent record (req.activeAgent).
//     No route reads an agent id from the request body, query or path.
//   * Each of verify-item / confirm-dropoff / reject-dropoff re-checks
//     `item.assigned_agent_id !== req.user.agentId` -> 403 AFTER the item is
//     read and BEFORE any mutation. That is the IDOR guard, and its position
//     relative to the mutation is load-bearing, so it was moved with the code
//     rather than re-authored.
//   * confirm-dropoff additionally refuses while verification is pending or
//     `physically_verified_at` is unset. That ordering is enforced server-side
//     specifically so it cannot be bypassed by calling the API directly.
//
// INJECTED, NOT MOVED
//
//   requireActiveAgent, sendServerError, checkClaimExpiry and
//   isSocialPublishingPaused are all defined in server.ts and still used by
//   other routes there, so they are passed in rather than duplicated. There is
//   exactly one definition of each in the codebase.
//
// DELIBERATELY NOT HERE
//
//   (P2-A3.4B moved confirm-viewing and confirm-handover in as well, so ALL SIX
//   Agent lifecycle routes now live here. Every one of them is still registered
//   exactly once, from this single module.)
//
// P2-A3.4B â€” confirm-viewing and confirm-handover
//
//   Both are here verbatim, and both are HIGH SENSITIVITY:
//   * confirm-viewing keeps the SEC-2B-02 explicit output projection (three
//     enumerated fields â€” never a spread â€” so a future column cannot leak a
//     presigned ID-proof URL, security_answers, owner_phone or owner_email).
//   * confirm-handover keeps its ordering guarantee PROOF-BEFORE-EVIDENCE:
//     assignment -> claim state -> stolen/hold/dispute fail-safe -> pickup-code
//     hash check -> photo upload -> settlement CAS. The pickup code is verified
//     BEFORE the evidence photo is stored, so a wrong code can never leave a
//     real photo attached to a claim whose handover never happened.
//   * Money still does not move here: the route only enters pending_settlement.
//     Release stays with the settlement sweep or the admin override.
import { db } from '../db/database';
import { authenticateJWT, hashCode, timingSafeEqualHex } from '../services/auth';
import { SocialService } from '../services/social';
import { toAgentVerificationEvidence } from '../services/verificationValidation';
import { resolveCategoryId } from '../services/categoryValidation';
// P2-A3.4B: confirm-handover. uploadBase64Image stores the handover evidence
// photo; EmailService sends the owner / finder / admin notifications that
// already exist for this event (NOT a new notification architecture â€” N5 owns
// that, and this batch only preserves today's behaviour).
import { uploadBase64Image } from '../services/storage';
import {
  renderSendItemHandedOverEmail,
  renderSendFinderItemCollectedEmail,
  renderSendAdminTransactionLogEmail,
} from '../services/email';
import { NotificationService, buildNotificationIdempotencyKey } from '../services/notificationService';
import { getAdminNotificationEmail } from '../config/adminNotificationEmail';
import {
  produceAgentConfirmedViewing,
  produceItemHandedOver,
} from '../services/claimNotificationProducers.ts';

import type { Request, Response, NextFunction } from 'express';

export function registerAgentOperationalRoutes(
  app: any,
  deps: {
    /** Server-defined middleware. Re-checking agent status per request is the
     *  point of it: a suspension takes effect immediately, not at token expiry. */
    requireActiveAgent: (req: Request, res: Response, next: NextFunction) => void;
    /** Shared error disclosure, identical to every other route. */
    sendServerError: (res: any, error: any, context: string) => any;
    /** Shared claim-expiry sweep. Also drives payment-window expiry. */
    checkClaimExpiry: (claim: any) => Promise<any>;
    /** Admin-controlled social-publishing kill switch. */
    isSocialPublishingPaused: () => Promise<boolean>;
    /** P2-A3.4B â€” confirm-handover. Builds the admin's pause-setting key. */
    pauseSettingKey: (scope: string) => string;
    /** P2-A3.4B â€” the operator-facing message for a paused scope. */
    PAUSED_MESSAGES: Record<string, string>;
    /** P2-A3.4B â€” the stolen / legal-hold / unresolved-dispute fail-safe. */
    canCreateClaim: (item: any, preFetchedDisputes?: any[]) => Promise<{ allowed: boolean; reason?: string }>;
    /** P2-A3.4B â€” the user-facing text for a blocked claimability reason. */
    claimabilityErrorMessage: (reason: string) => string;
    /** P2-A3.4B â€” how long a handover waits in pending_settlement before money moves. */
    DISPUTE_WINDOW_MS: number;
    /** P2-A3.4B â€” the emergency-pause fail-safe check for handovers. */
    isPlatformOperationPaused: (settingKey: string) => Promise<boolean>;
  }
) {
  const {
    requireActiveAgent,
    sendServerError,
    checkClaimExpiry,
    isSocialPublishingPaused,
    pauseSettingKey,
    PAUSED_MESSAGES,
    canCreateClaim,
    claimabilityErrorMessage,
    DISPUTE_WINDOW_MS,
    isPlatformOperationPaused,
  } = deps;

    // 8. AGENT HUB QUEUES
  app.get('/api/agents/queue', authenticateJWT, requireActiveAgent, async (req, res) => {
    try {
      const agentId = req.user!.agentId!;

      // Get items assigned to this agent
      //
      // PERFORMANCE: this used to fetch the entire items table
      // (db.getItems(), every status, every historical row) and filter by
      // assigned_agent_id in application code â€” despite idx_items_agent
      // already existing on exactly this column and sitting unused here.
      // getItemsByAgent() pushes the filter into the WHERE clause so this
      // actually uses that index instead of scanning every item in the
      // system on every agent dashboard load.
      const items = await db.getItemsByAgent(agentId);
      
      const rawClaims = await db.getClaims();
      const allClaims = [];
      for (const claim of rawClaims) {
        allClaims.push(await checkClaimExpiry(claim));
      }
      const claims = allClaims.filter(c => items.some(i => i.id === c.item_id));

      const earnings = await db.getAgentEarnings(agentId);

      res.json({
        agent: req.activeAgent,
        earnings,
        pendingDropoffs: items.filter(i => i.status === 'awaiting_dropoff'),
        holdingItems: items.filter(i => i.status === 'at_agent').map(item => {
          const associatedClaim = claims.find(c => c.item_id === item.id && (
            c.status === 'escrow_held' || 
            c.status === 'released' || 
            c.status === 'disputed' ||
            c.status === 'awaiting_agent_confirmation' ||
            c.status === 'pending_payment'
          ));
          return {
            ...item,
            associatedClaim: associatedClaim ? {
              id: associatedClaim.id,
              status: associatedClaim.status,
              agent_confirmed_at: associatedClaim.agent_confirmed_at || null,
              // Operational evidence only: the subset the assigned agent needs to
              // physically compare against the item, never the raw claim row.
              owner_identifying_details: associatedClaim.owner_identifying_details || null,
              security_answers: toAgentVerificationEvidence(item.category_id || 'other-item', associatedClaim.security_answers),
            } : undefined,
          };
        }),
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 9. AGENT CONFIRMATIONS
  /**
   * Agent correction/verification step â€” must happen BEFORE
   * confirm-dropoff (physical approve & accept). Lets the Agent, who is
   * physically looking at the item, correct or complete what the Finder
   * submitted. Original Finder data is never touched; see
   * recordItemVerification in database.ts for the full data-integrity
   * and sensitive-document rules this enforces.
   */
  app.post('/api/agents/verify-item', authenticateJWT, requireActiveAgent, async (req, res) => {
    const { dropoffCode, categoryId, name, documentNumber, description, foundArea, reason, reasonDetail, physicallyVerified } = req.body;

    try {
      const item = await db.getItem(dropoffCode);
      if (!item) {
        return res.status(404).json({ error: 'Msimbo wa kuwasilisha (Drop-off code) si sahihi.' });
      }

      if (item.assigned_agent_id !== req.user.agentId) {
        return res.status(403).json({ error: 'Bidhaa hii haijapangiwa physical hub yako.' });
      }

      if (item.status !== 'awaiting_dropoff') {
        return res.status(400).json({ error: `Bidhaa hii tayari imeshughulikiwa. Hali ya sasa: ${item.status}` });
      }

      if (!categoryId || !foundArea) {
        return res.status(400).json({ error: 'Kategoria na eneo lililopatikana ni lazima.' });
      }

      // -----------------------------------------------------------------------
      // PHASE 16.1 BATCH 1 (CAT-01) â€” THE CATEGORY MUST EXIST BEFORE ANY WRITE.
      // -----------------------------------------------------------------------
      // Before this guard, an unknown `categoryId` was written straight through
      // as the item's verified classification. Postgres then rejected it on
      // `items_category_id_fkey`, and `recordItemVerification`'s catch returned
      // the raw constraint text to the agent. This resolves the value against the
      // LIVE category list (the same list the Finder and Owner flows use) and
      // refuses an unknown/malformed one here â€” before the item update, before
      // the verification row, before the audit row, so no side effect can have
      // happened. Nothing is coerced: the canonical id from the live list is what
      // gets stored.
      //
      // PHASE 16.1 BATCH 2 (CAT-04): resolved against the ACTIVE list, so a
      // deactivated category can no longer be chosen as a NEW verification
      // classification. This ordering guarantee is unchanged â€” it still runs
      // before the item update, the verification row and the audit row.
      const resolvedCategory = resolveCategoryId(categoryId, await db.getActiveCategories());
      if (!resolvedCategory.ok) {
        return res.status(400).json({ error: resolvedCategory.error });
      }

      const result = await db.recordItemVerification(
        dropoffCode,
        req.user.agentId,
        {
          category_id: resolvedCategory.id as string,
          name: name ?? null,
          document_number: documentNumber ?? null,
          description: description ?? null,
          found_area: foundArea,
        },
        reason || '',
        reasonDetail || null,
        !!physicallyVerified
      );

      if (!result.success) {
        return res.status(400).json({ error: result.message });
      }

      res.json({ success: true, message: result.message });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/agents/confirm-dropoff', authenticateJWT, requireActiveAgent, async (req, res) => {
    const { dropoffCode } = req.body;

    try {
      const item = await db.getItem(dropoffCode);
      if (!item) {
        return res.status(404).json({ error: 'Msimbo wa kuwasilisha (Drop-off code) si sahihi.' });
      }

      if (item.assigned_agent_id !== req.user.agentId) {
        return res.status(403).json({ error: 'Bidhaa hii haijapangiwa physical hub yako.' });
      }

      // The Agent must complete verification (confirm-as-reported or
      // correct-and-save) before physically approving the item â€” this is
      // enforced here, server-side, not just by the frontend button
      // sequence, so it can't be bypassed by calling the API directly.
      if (item.verification_status === 'pending') {
        return res.status(400).json({ error: 'Tafadhali kamilisha uthibitisho wa bidhaa kabla ya kuikubali. / Please complete item verification before approving it.' });
      }
      if (!item.physically_verified_at) {
        return res.status(400).json({ error: 'Tafadhali thibitisha kimwili bidhaa hii kabla ya kuikubali. / Please physically verify this item before approving it.' });
      }

      // SOCIAL MEDIA AUTO-POSTING INTEGRATION POINT:
      // When the Facebook/Telegram auto-posting module is built, the trigger event MUST
      // be right here when the status changes from 'awaiting_dropoff' to 'at_agent'.
      // DO NOT trigger posting on initial report creation (when status is 'awaiting_dropoff')
      // as that would result in unverified, possibly fake, or spam reports being published publicly
      // before a physical human (the agent) has physically verified the item actually exists and is deposited.
      await db.updateItemStatus(dropoffCode, 'at_agent');

      // Fetch the updated item, category, and agent to trigger our auto-posting module
      try {
        const fullItem = await db.getItem(dropoffCode);
        if (fullItem) {
          const category = fullItem.category_id ? await db.getCategory(fullItem.category_id) : undefined;
          const agent = fullItem.assigned_agent_id ? await db.getAgent(fullItem.assigned_agent_id) : undefined;

          const socialPaused = await isSocialPublishingPaused();
          if (socialPaused) {
            console.log(`[SOCIAL MEDIA AUTO-POST] Skipped for item ${dropoffCode} â€” social publishing is paused by admin.`);
          } else {
            // Trigger the social media broadcast asynchronously to prevent blocking the agent's API response
            SocialService.broadcastVerifiedItem(
              fullItem,
              agent ? {
                id: agent.id,
                business_name: agent.business_name,
                location_address: agent.location_address,
                contact_phone: agent.contact_phone
              } : undefined,
              category ? {
                id: category.id,
                name_en: category.name_en,
                name_sw: category.name_sw,
                total_fee: category.total_fee,
                is_sensitive_document: category.is_sensitive_document
              } : undefined
            ).catch(socialErr => {
              console.error('[SOCIAL MEDIA AUTO-POST] Async broadcast error:', socialErr);
            });
          }
        }
      } catch (e) {
        console.error('[SOCIAL MEDIA AUTO-POST] Failed to prepare social broadcast details:', e);
      }

      res.json({ success: true, message: 'Uthibitisho umekamilika! Bidhaa sasa ipo salama kwenye hub yako.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/agents/reject-dropoff', authenticateJWT, requireActiveAgent, async (req, res) => {
    const { dropoffCode, reason } = req.body;

    if (!dropoffCode || !reason || !reason.trim() || /^Other:\s*$/i.test(reason.trim())) {
      return res.status(400).json({ error: 'Msimbo wa drop-off na sababu vinahitajika.' });
    }

    try {
      const item = await db.getItem(dropoffCode);
      if (!item) {
        return res.status(404).json({ error: 'Msimbo wa kuwasilisha (Drop-off code) si sahihi.' });
      }

      if (item.assigned_agent_id !== req.user.agentId) {
        return res.status(403).json({ error: 'Bidhaa hii haijapangiwa physical hub yako.' });
      }

      // The rejecting actor is recorded explicitly: this route is an
      // authenticated AGENT action, so it must not be attributed to an
      // administrator nor silently collapsed into "SYSTEM" (see rejectItem).
      await db.rejectItem(dropoffCode, reason, 'AGENT');
      res.json({ success: true, message: 'Bidhaa imekataliwa na kuondolewa kwenye mfumo.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/agents/claims/:claimId/confirm-viewing', authenticateJWT, requireActiveAgent, async (req, res) => {
    const claimId = req.params.claimId;

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }

      const item = await db.getItem(claim.item_id);
      if (!item || item.assigned_agent_id !== req.user.agentId) {
        return res.status(403).json({ error: 'Msimbo huu hauhusiani na hub yako.' });
      }

      if (claim.status !== 'awaiting_agent_confirmation') {
        return res.status(400).json({ error: 'Claim lazima iwe kwenye hali ya kusubiri uthibitisho wa wakala kabla ya kuthibitisha.' });
      }

      // SC-2/SC-8: status change and its audit row now commit together through
      // the central transition contract, with the expected state enforced by an
      // atomic CAS. A concurrent second confirmation loses the race and gets a
      // 409 instead of silently double-writing.
      const viewingTransition = await db.transitionClaimStatus({
        claimId,
        expected: ['awaiting_agent_confirmation'],
        to: 'pending_payment',
        actor: `AGENT_${req.user.agentId}`,
        action: 'AGENT_CONFIRMED_VIEWING',
        details: `Agent ${req.user.agentId} confirmed in-person viewing for claim ${claimId} and item ${item.id}`,
        extraSet: { agent_confirmed_at: new Date() },
      });
      if (!viewingTransition.ok) {
        return res.status(viewingTransition.code === 'NOT_FOUND' ? 404 : 409).json({
          error: 'Claim hii imeshashughulikiwa hivi punde. Tafadhali pakia upya. / This claim was handled moments ago. Please reload.',
        });
      }

      // BATCH 3 / P2 - customer notification for the in-person confirmation.
      //
      // Guarded on `ok` AND `!alreadyInState`. transitionClaimStatus returns
      // ok:true with alreadyInState:true for an explicit idempotent no-op (the
      // claim is ALREADY pending_payment), so requiring a real state CHANGE is
      // what stops a repeated confirmation from producing a second
      // customer-visible notification. There is no notification-layer dedupe
      // doing this work; the authoritative transition is.
      if (viewingTransition.ok && !viewingTransition.alreadyInState) {
        await produceAgentConfirmedViewing(claimId);
      }

      // Get updated claim to return
      //


      // SEC-2B-02 â€” EXPLICIT OUTPUT PROJECTION. This used to be
      // `res.json({ success: true, claim: updatedClaim })`, i.e. the complete
      // claim row straight from db.getClaim() â€” which passes through
      // signClaim() and therefore materialises a live presigned private-storage
      // URL into `owner_id_proof_url` (the claimant's government-ID image), and
      // also carries the raw `security_answers`, `owner_phone`, `owner_email`,
      // `owner_identifying_details`, `payment_reference` and `paid_at`.
      //
      // The authenticated agent legitimately needs NONE of that from this
      // endpoint, and no client reads it (AgentView only reads `data.error` and
      // `data.message`). Every other surface projects this same data through a
      // hand-built allowlist â€” toOwnerSafeClaimView, toCustomerSafeClaimView,
      // and GET /api/agents/queue's field-by-field associatedClaim (which maps
      // security_answers through toAgentVerificationEvidence). This route now
      // does the same, using the same `row ? {...} : null` shape /pay already
      // uses. Fields are enumerated explicitly â€” never a spread â€” so a future
      // column cannot leak here by default.
      const updatedClaim = await db.getClaim(claimId);
      return res.json({
        success: true,
        claim: updatedClaim
          ? {
              id: updatedClaim.id,
              status: updatedClaim.status,
              agent_confirmed_at: updatedClaim.agent_confirmed_at,
            }
          : null,
      });

    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/agents/confirm-handover', authenticateJWT, requireActiveAgent, async (req, res) => {
    const { claimId, userRating, pickupCode } = req.body;

    if (await isPlatformOperationPaused(pauseSettingKey('handovers'))) {
      return res.status(503).json({ error: PAUSED_MESSAGES.handovers });
    }

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }

      const item = await db.getItem(claim.item_id);
      if (!item || item.assigned_agent_id !== req.user.agentId) {
        return res.status(403).json({ error: 'Msimbo huu hauhusiani na hub yako.' });
      }

      const category = await db.getCategory(item.category_id);
      if (!category) {
        return res.status(404).json({ error: 'Ada ya kategoria haikupatikana.' });
      }

      const agent = await db.getAgent(item.assigned_agent_id);
      if (!agent) {
        return res.status(404).json({ error: 'Hub haikupatikana.' });
      }

      if (claim.status !== 'escrow_held') {
        return res.status(400).json({ error: `Huwezi kutoa bidhaa hii. Hali ya sasa ni: ${claim.status}` });
      }

      // Fail-safe: even with money already in escrow, never let the physical
      // item leave custody once it's been flagged stolen/legal-hold, or if
      // a competing claimant has opened an unresolved ownership dispute in
      // the meantime. If uncertain, do not release the item â€” escalate to
      // admin instead. (item.status is expected to still be 'at_agent' here
      // since physical custody hasn't transferred yet â€” canCreateClaim's
      // 'at_agent' requirement is not the binding condition in this case,
      // the dispute/hold checks are.)
      const claimability = await canCreateClaim(item);
      if (!claimability.allowed && (claimability.reason === 'suspected_stolen' || claimability.reason === 'legal_hold' || claimability.reason === 'unresolved_dispute')) {
        return res.status(423).json({ error: claimabilityErrorMessage(claimability.reason) });
      }

      // SECURITY: require the owner's secret pickup code (sent privately via
      // SMS/email when payment was confirmed) before releasing any money â€”
      // and, per the fix below, before uploading/storing any photo at all.
      if (!pickupCode || typeof pickupCode !== 'string' || pickupCode.trim() === '') {
        return res.status(400).json({ error: 'Muulize mmiliki msimbo wake wa siri wa kuchukua bidhaa kabla ya kuendelea. / Ask the owner for their secret pickup code before proceeding.' });
      }

      // P0: pickup-code hash verification now happens BEFORE the photo
      // upload/storage step below, not after. Previously the handover
      // photo was uploaded and persisted to the claim (db.setHandoverPhoto)
      // first, and only THEN was the pickup code actually checked against
      // its hash â€” meaning a wrong pickup code (a typo, a scam attempt, an
      // agent testing the flow) still left a real uploaded evidence photo
      // stored against the claim even though the handover never actually
      // happened. Correct order: authorize the agent and the claim/item,
      // validate claim state, validate the pickup code, THEN â€” and only
      // then â€” validate and upload the photo.
      const pickupRecord = await db.getPickupCode(claimId);
      if (!pickupRecord) {
        return res.status(400).json({ error: 'Msimbo wa kuchukua haujaanzishwa kwa dai hili. / No pickup code has been issued for this claim yet.' });
      }
      if (!timingSafeEqualHex(hashCode(pickupCode.trim()), pickupRecord.code_hash)) {
        return res.status(400).json({ error: 'Msimbo wa siri wa kuchukua si sahihi. Muulize mmiliki tena. / The secret pickup code is incorrect. Ask the owner again.' });
      }
      await db.markPickupCodeVerified(claimId);

      // Require a handover evidence photo (the claimant holding the item,
      // ideally alongside their own ID) before any payout can be triggered.
      // This is the platform's main defense against an agent colluding with
      // someone who is not the real owner: a colluding agent now has to
      // actively produce and submit fabricated evidence rather than simply
      // clicking a button with no record at all, and a genuine dispute later
      // has something concrete to review. Only reached now that the pickup
      // code has already been confirmed correct â€” see the comment above.
      const { handoverPhotoBase64 } = req.body;
      if (!handoverPhotoBase64 || typeof handoverPhotoBase64 !== 'string' || handoverPhotoBase64.trim() === '') {
        return res.status(400).json({ error: 'Piga picha ya mdai akiwa na bidhaa kabla ya kutoa. Hii inalinda dhidi ya udanganyifu. / Take a photo of the claimant with the item before handing it over. This protects against fraud.' });
      }
      let handoverPhotoUrl: string;
      try {
        handoverPhotoUrl = await uploadBase64Image(handoverPhotoBase64, 'handover-evidence');
      } catch (uploadErr: any) {
        console.error('[HANDOVER PHOTO UPLOAD ERROR]:', uploadErr);
        return res.status(500).json({ error: 'Imeshindikana kupakia picha. Tafadhali jaribu tena. / Failed to upload photo. Please try again.' });
      }
      await db.setHandoverPhoto(claimId, handoverPhotoUrl);

      // Atomically claim the exclusive right to move this claim into
      // settlement. If two (or more) confirm-handover requests arrive
      // concurrently for the same claim â€” a double-click, a retry, or a
      // scripted attack â€” only one of them will win this compare-and-swap;
      // the rest are rejected here, before anything financial is booked.
      const settlement = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
      if (!settlement.success) {
        return res.status(409).json({ error: settlement.message || 'Dai hili tayari linashughulikiwa au limekwisha kamilika. / This claim is already being processed or has already been completed.' });
      }
      // BATCH 3 / P6 - customer notification for the completed handover.
      //
      // `settlement.success` is itself the idempotency guard: enterPendingSettlement
      // only reports success for the ONE caller that won its escrow_held ->
      // pending_settlement compare-and-swap, so a double-clicked, retried or
      // scripted confirm-handover that lost the race returns early above and can
      // never produce a second customer-visible notification.
      await produceItemHandedOver(claimId);



      // NOTE: the actual M-Pesa split disbursement does NOT happen here. The
      // payout is booked in the ledger as 'pending' and will be sent by the
      // settlement sweep (releaseDueSettlements) once DISPUTE_WINDOW_HOURS
      // has elapsed with no dispute raised â€” or immediately by an admin via
      // POST /api/admin/claims/:id/release-settlement. This gives a real
      // window for a second claimant, the owner, or an admin to freeze a
      // suspicious handover before any money actually moves.

      // Close out the public listing with a short, privacy-safe follow-up notice.
      // Fired asynchronously so a social platform outage never blocks the actual
      // handover response to the agent â€” mirrors the pattern used for the
      // original found-item broadcast in /api/agents/confirm-dropoff.
      isSocialPublishingPaused().then(paused => {
        if (paused) {
          console.log(`[SOCIAL MEDIA AUTO-POST] Reunited-notice skipped for claim ${claimId} â€” social publishing is paused by admin.`);
          return;
        }
        SocialService.broadcastItemReunited(
          item,
          category ? {
            id: category.id,
            name_en: category.name_en,
            name_sw: category.name_sw,
            total_fee: category.total_fee,
            is_sensitive_document: category.is_sensitive_document
          } : undefined
        ).catch(socialErr => {
          console.error('[SOCIAL MEDIA AUTO-POST] Async reunited-notice broadcast error:', socialErr);
        });
      }).catch(pauseCheckErr => {
        console.error('[SOCIAL MEDIA AUTO-POST] Failed to check publishing-pause setting, skipping reunited-notice as a precaution:', pauseCheckErr);
      });

      const itemName = category ? category.name_en : 'Found Document / Item';
      let resolvedFee = category ? category.total_fee : '0.00';
      if (item.locked_total_fee !== undefined && item.locked_total_fee !== null) {
        resolvedFee = String(item.locked_total_fee);
      }

// 1. Send item collection email asynchronously if owner email is provided
      //
      // N8: routed through the notification boundary. The recipient guard, the
      // subject, the HTML, the owner's phone in the body and the fire-and-forget
      // shape are all unchanged â€” a handover must never fail because an email
      // provider was slow. The body is produced through render(), so the phone
      // number never reaches the durable notification row.
      if (claim.owner_email && claim.owner_email.trim() !== '') {
        const ownerEmail = claim.owner_email;
        const ownerPhone = claim.owner_phone;
        const dateStr = new Date().toLocaleDateString('en-KE', {
          timeZone: 'Africa/Nairobi',
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        // Idempotency identity: the CLAIM. A handover completes once per claim,
        // so the claim id is the stable business identity for this notification.
        NotificationService.notify({
          eventType: 'ITEM_HANDED_OVER',
          recipient: ownerEmail,
          // N9: the claim this handover belongs to.
          businessReference: claim.id,
          idempotencyKey: buildNotificationIdempotencyKey('ITEM_HANDED_OVER', claim.id),
          render: () =>
            renderSendItemHandedOverEmail(
              ownerEmail,
              ownerPhone,
              itemName,
              item.id,
              dateStr
            ),
        }).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Handover confirmation email failed:', err));
      }

      // 2. Send finder collection email asynchronously if finder email is provided
      if (item.finder_email && item.finder_email.trim() !== '') {
        const finderEmail = item.finder_email;
        // The same handover on the same claim, told to a different recipient: a
        // distinct event type, therefore a distinct notification and key.
        NotificationService.notify({
          eventType: 'FINDER_ITEM_COLLECTED',
          recipient: finderEmail,
          // N9: the claim this handover belongs to.
          businessReference: claim.id,
          idempotencyKey: buildNotificationIdempotencyKey('FINDER_ITEM_COLLECTED', claim.id),
          render: () => renderSendFinderItemCollectedEmail(finderEmail, itemName, item.id),
        }).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Finder item collected email failed:', err));
      }

      // 3. Send transaction log email to admin
      //
      // N8: the admin recipient is resolved by this caller; when unset the event
      // is rejected with `missing_recipient` and nothing is sent. The SUBTYPE is
      // part of the key so this handover log can never be suppressed as a
      // duplicate of the PAYMENT_CONFIRMED admin log for the same claim.
      NotificationService.notify({
        eventType: 'ADMIN_TRANSACTION_LOG',
        recipient: getAdminNotificationEmail(),
        // N9: subtype + claim, mirroring the payment-webhook log exactly.
        businessReference: `HANDOVER_CONFIRMED_PENDING_SETTLEMENT:${claim.id}`,
        idempotencyKey: buildNotificationIdempotencyKey(
          'ADMIN_TRANSACTION_LOG',
          `HANDOVER_CONFIRMED_PENDING_SETTLEMENT:${claim.id}`
        ),
        render: () =>
          renderSendAdminTransactionLogEmail(
            'HANDOVER_CONFIRMED_PENDING_SETTLEMENT',
            claim.id,
            item.id,
            resolvedFee,
            agent ? agent.business_name : 'Unknown Agent'
          ),
      }).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Admin handover log email failed:', err));

      if (userRating) {
        await db.rateAgent(req.user.agentId, parseFloat(userRating));
      }

      res.json({ success: true, message: settlement.message, settleAt: settlement.settleAt });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });
}
