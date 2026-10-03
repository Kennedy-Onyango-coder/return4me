// FINDER FLOW: photo pre-analysis (OCR) and found-item report.
//
// P2-A1 — MECHANICAL EXTRACTION. This module was carved out of server.ts
// verbatim so the two Finder entry points become independently mountable for
// real HTTP integration testing. NO behaviour was changed: the handler bodies,
// their validation order, their middleware order, their error handling, their
// status codes and their response bodies are byte-identical to what they were
// inline in server.ts.
//
// WHY THIS IS A SEPARATE MODULE
// server.ts constructs the whole application and boots it at import time
// (Vite middleware, background sweeps and listeners), so it cannot be imported
// by a test. These routes are therefore registered into the caller's Express
// app, which lets an integration test mount a REAL Express app around the REAL
// handlers — the same pattern already established by
// routes/customerClaims.ts, routes/publicItems.ts, routes/adminClaims.ts,
// routes/adminDisputes.ts, routes/adminLostReports.ts, routes/categories.ts
// and routes/lostReports.ts. This module must therefore never boot anything
// itself.
//
// INJECTED, NOT RE-IMPLEMENTED (see registerFinderReportRoutes below)
//   sendServerError  — error-disclosure behaviour must be IDENTICAL to every
//                      inline route, so it is passed through rather than copied.
//   pause helpers    — the emergency-pause kill switch. Injecting it keeps this
//                      module from re-reading the admin settings table through a
//                      second, divergent code path.
//   the two limiters — these live in server.ts because several other routes
//                      share them; passing the SAME middleware objects
//                      guarantees a request is limited exactly once, in exactly
//                      the same bucket, whichever route answered it.
//
// ORDERING GUARANTEES PRESERVED FROM server.ts (do not "tidy" these):
//   1. emergency-pause check
//   2. required-field check
//   3. canonical county + administrative unit   (BEFORE any paid/side-effecting work)
//   4. declared-value ceiling parse             (never rejects the report)
//   5. account/terms check
//   6. image-signature check
//   7. active-category lookup                   (BEFORE upload — P12-F1, so a
//                                               bad category can never orphan a
//                                               stored photo object)
//   8. agent matching -> S3 upload -> hashing -> fee -> createItem
import rateLimit from 'express-rate-limit';
import { db } from '../db/database.ts';
import { AgentMatchingService } from '../services/agent.ts';
import { renderSendAdminNewReassignmentRequestEmail } from '../services/email.ts';
import { NotificationService, buildNotificationIdempotencyKey } from '../services/notificationService.ts';
import { getAdminNotificationEmail } from '../config/adminNotificationEmail.ts';
import { OcrService } from '../services/ocr.ts';
import { uploadBase64Image } from '../services/storage.ts';
import { computeRecoveryFee } from '../services/feeEngine.ts';
import { hashDocument } from '../services/documentHash.ts';
import { maskName } from '../services/social.ts';
import { resolveFoundCountyInput } from '../services/foundItemCounty.ts';
import { resolveAdministrativeUnitId } from '../config/kenyaAdministrativeUnits.ts';
import { normalizeCoordinateInput } from '../services/coordinates.ts';
import { isValidImageSignature } from '../services/imageSignature.ts';

export function registerFinderReportRoutes(
  app: any,
  deps: {
    // Shared, not re-implemented: identical error disclosure to every inline
    // route (generic message in production, detailed only in development).
    sendServerError: (res: any, error: any, context: string) => void;
    // The emergency admin pause. Injected so this route keeps reading the same
    // admin setting through the same fail-safe helper.
    pauseSettingKey: (scope: 'reports' | 'claims' | 'payments' | 'payouts' | 'handovers' | 'social_publishing') => string;
    isPlatformOperationPaused: (settingKey: string) => Promise<boolean>;
    PAUSED_MESSAGES: Record<string, string>;
    // The SAME limiter instances server.ts already uses. Sharing the object (not
    // the options) is what keeps the bucket shared and the request limited once.
    reportLimiter: any;
    ocrAnalyzeLimiter: any;
  }
) {
  const { sendServerError, pauseSettingKey, isPlatformOperationPaused, PAUSED_MESSAGES, reportLimiter, ocrAnalyzeLimiter } = deps;

  // 3. FINDER FLOW: PRE-ANALYZE PHOTO USING GEMINI OCR
  app.post('/api/items/analyze', ocrAnalyzeLimiter, async (req, res) => {
    const { photoBase64 } = req.body;
    if (!photoBase64) {
      return res.status(400).json({ error: 'Picha inahitajika kufanya OCR.' });
    }
    if (!isValidImageSignature(photoBase64)) {
      return res.status(400).json({ error: 'Aina ya picha haikubaliki. Tafadhali pakia picha halisi ya JPEG, PNG, WEBP, au HEIC.' });
    }

    try {
      const ocrResult = await OcrService.extractDocumentDetails(photoBase64);
      res.json(ocrResult);
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });
  // 4. FINDER FLOW: REPORT / SAVE FOUND ITEM (Rate Limited)
  app.post('/api/items/report', reportLimiter, async (req, res) => {
    const {
      categoryId,
      photoBase64,
      extractedNumber,
      extractedName,
      locationDescription,
      latitude,
      longitude,
      foundCounty,
      administrativeUnitId,
      finderPhone,
      createAccount,
      termsAccepted,
      description,
      finderEmail,
      declaredValue,
    } = req.body;

    if (await isPlatformOperationPaused(pauseSettingKey('reports'))) {
      return res.status(503).json({ error: PAUSED_MESSAGES.reports });
    }

    if (!categoryId || !photoBase64 || !locationDescription || !finderPhone) {
      return res.status(400).json({ error: 'Tafadhali jaza sehemu zote zinazohitajika.' });
    }

    // -----------------------------------------------------------------------
    // PHASE 9D — FOUND-ITEM COUNTY (required, canonical, user-declared)
    // -----------------------------------------------------------------------
    // The Finder must now state WHICH COUNTY the item was found in. This is the
    // authoritative found-side geographic field.
    //
    // WHY IT IS REQUIRED RATHER THAN INFERRED: before Phase 9D the found side
    // had no county at all, so the matcher guessed one by scanning the free-text
    // location for county names. That produced a real, reproducible false
    // positive — "Mombasa Road" (a Nairobi street) read as Mombasa County and
    // "Kiambu Road" read as Kiambu County — which could then wrongly ELIMINATE
    // a correct candidate. Asking the Finder removes the guess at its source.
    //
    // VALIDATION IS SERVER-SIDE AND AUTHORITATIVE. The browser may pre-validate
    // for UX, but nothing from the client is trusted: `resolveCountyName()` is
    // the SAME canonical resolver (and the same 47-county list) the lost-report
    // route uses, and it never guesses a nearby county. A value that does not
    // resolve is REJECTED — it is never silently stored, dropped, or coerced.
    //
    // ORDER MATTERS: this runs before image validation and before any agent
    // matching/geocoding, so an invalid county cannot trigger the paid OCR path
    // or an outbound geocoding request.
    const foundCountyResolution = resolveFoundCountyInput(foundCounty);
    if (!foundCountyResolution.ok) {
      return res.status(400).json({ error: foundCountyResolution.error });
    }
    const canonicalFoundCounty = foundCountyResolution.county;
    const canonicalFoundAdministrativeUnit = resolveAdministrativeUnitId(canonicalFoundCounty, administrativeUnitId);
    if (!canonicalFoundAdministrativeUnit) {
      return res.status(400).json({ error: 'Tafadhali chagua kaunti ndogo inayohusiana na kaunti uliyochagua. / Please choose a sub-county belonging to the selected county.' });
    }

    // Declared value is an OPTIONAL, unverified estimate the finder can give
    // of what the item would cost to replace. It is never treated as fact —
    // it only ever feeds the Recovery Fee Engine's ceiling calculation
    // (src/services/feeEngine.ts), and the ceiling only ever pulls the fee
    // DOWN, never up. Silently ignore anything that isn't a sane positive
    // number rather than rejecting the whole report over it.
    let parsedDeclaredValue: number | null = null;
    if (declaredValue !== undefined && declaredValue !== null && declaredValue !== '') {
      const n = parseFloat(declaredValue);
      if (!isNaN(n) && n > 0 && n < 100_000_000) {
        parsedDeclaredValue = n;
      }
    }

    if (createAccount && !termsAccepted) {
      return res.status(400).json({ error: 'Ni lazima ukubali Vigezo na Masharti ili kufungua akaunti.' });
    }

    if (!isValidImageSignature(photoBase64)) {
      return res.status(400).json({ error: 'Aina ya picha haikubaliki. Tafadhali pakia picha halisi ya JPEG, PNG, WEBP, au HEIC.' });
    }

    try {
      // PHASE 16.1 BATCH 2 (CAT-04) — ACTIVE categories only. A deactivated
      // category must not be selectable for a NEW found-item report, and this is
      // the authoritative boundary (the browser is never trusted): an inactive
      // id is refused here even if a client replays it. The lookup itself is
      // unchanged — only the list it is checked against is narrower — so the
      // P12-F1 ordering guarantee (reject before any upload/insert) still holds.
      const categories = await db.getActiveCategories();

      // -----------------------------------------------------------------------
      // PHASE 12 (P12-F1): the category is validated BEFORE any side effect.
      //
      // This route previously looked the category up and then carried on even
      // when it did not exist: `cat` was undefined, `isSensitive` fell back to
      // its fail-closed `true`, and execution continued through agent matching
      // and `uploadBase64Image()` — a REAL storage write — before `db.createItem`
      // finally failed the `items_category_id_fkey` constraint. The catch below
      // then reported it as a 500 "Failed to save found item.", so a trivially
      // malformed public request produced (a) a 5xx instead of a 4xx, (b) a full
      // stack trace in the error log for a client input error, and (c) an
      // orphaned uploaded photo object with no item row referencing it.
      //
      // The lost-report route has always rejected an unknown category up front
      // (routes/lostReports.ts -> validateLostReportPayload -> MESSAGES.categoryInvalid);
      // this makes the found-item route behave the same way, with the same
      // wording, and keeps the rejection free of side effects.
      // -----------------------------------------------------------------------
      const cat = categories.find(c => c.id === categoryId);
      if (!cat) {
        return res.status(400).json({ error: 'Aina ya kitu haikubaliki. / That item category is not valid.' });
      }
      const isSensitive = cat.is_sensitive_document !== false;

      // 1. Assign nearest physical Return4me agent
      //
      // PHASE 9D: the optional device-supplied pair is validated ONCE, here, by
      // the shared validator. A malformed, non-finite or out-of-range value now
      // yields `null` for BOTH halves instead of a NaN or an absurd number
      // reaching the distance comparison and the database. A legitimate
      // coordinate of exactly 0 is preserved rather than treated as absent.
      //
      // This is validation ONLY. It deliberately does not give the pair a
      // meaning: `items.latitude/longitude` keep exactly the semantic they had
      // (an optional, best-effort device position used to route the drop-off to
      // a nearby Agent hub). Nothing downstream may treat it as the item's
      // found location, as a county, or as evidence about ownership.
      const coordinates = normalizeCoordinateInput(
        latitude ?? null,
        longitude ?? null,
      );
      const numericLat = coordinates ? coordinates.latitude : null;
      const numericLon = coordinates ? coordinates.longitude : null;

      const matchingResult = await AgentMatchingService.assignNearestAgent(numericLat, numericLon, locationDescription, canonicalFoundCounty, canonicalFoundAdministrativeUnit);
      const assignedAgent = matchingResult.agent;

      // Upload found-item photo to S3 storage
      const photoUrl = await uploadBase64Image(photoBase64, 'items');

      // 2. Generate secure unique drop-off code
      const dropoffCode = 'R4M-' + Math.floor(100 + Math.random() * 900) + Math.random().toString(36).substr(2, 3).toUpperCase();

      // 3. Create document hashes for privacy-safe exact matching via secure HMAC-SHA256
      // Skip OCR and salted hashing entirely for non-sensitive items
      const saltedHash = (isSensitive && extractedNumber) ? hashDocument(extractedNumber) : null;
      const fuzzyMaskedName = (isSensitive && extractedName) ? maskName(extractedName) : (isSensitive ? null : (extractedName || (cat ? cat.name_en : 'Found Item')));

      // Get finder phone reputation
      const reputation = await db.getPhoneReputation(finderPhone);

      // Determine flagged status - default to true if key details are missing (only for sensitive docs), category requires elevated review (cash/children's-property), agent assignment could not be made with any real confidence, or client specifies, or reputation auto-flags
      const isFlagged = reputation.autoFlag || 
                        (cat ? cat.elevated_review : false) ||
                        matchingResult.needsManualAgentReassignment ||
                        (req.body.flaggedForReview !== undefined ? !!req.body.flaggedForReview : (isSensitive ? (!extractedNumber || !extractedName) : false));

      // RECOVERY FEE ENGINE: an admin who has explicitly hand-set a flat fee
      // for this category (is_admin_modified) keeps that override verbatim —
      // unchanged legacy behaviour. Otherwise compute the fee from the
      // category's engine config: base + complexity + delay, capped at
      // ceiling_percent of the finder's declared value when one was given.
      // See src/services/feeEngine.ts for the full reasoning.
      let lockedTotalFee: number | null = cat ? cat.total_fee : null;
      let lockedFinderShare: number | null = cat ? cat.finder_share : null;
      let lockedAgentShare: number | null = cat ? cat.agent_share : null;
      let lockedPlatformShare: number | null = cat ? cat.platform_share : null;
      let feeCeilingApplied = false;

      if (cat && !cat.is_admin_modified) {
        const breakdown = computeRecoveryFee({
          base_fee: cat.base_fee,
          complexity_fee: cat.complexity_fee,
          delay_fee: cat.delay_fee,
          ceiling_percent: cat.ceiling_percent,
          finder_pct: cat.finder_pct,
          agent_pct: cat.agent_pct,
          platform_pct: cat.platform_pct,
          finder_reward_cap: cat.finder_reward_cap,
        }, parsedDeclaredValue);
        lockedTotalFee = breakdown.totalFee;
        lockedFinderShare = breakdown.finderAmount;
        lockedAgentShare = breakdown.agentAmount;
        lockedPlatformShare = breakdown.platformAmount;
        feeCeilingApplied = breakdown.ceilingApplied;
      }

      const newItem = await db.createItem({
        id: dropoffCode,
        category_id: categoryId,
        photo_url: photoUrl,
        ocr_extracted_number: isSensitive ? (extractedNumber || null) : null,
        ocr_extracted_name: isSensitive ? (extractedName ? extractedName.toUpperCase() : null) : null,
        document_number_hash: saltedHash,
        document_name_fuzzy: fuzzyMaskedName,
        location_description: locationDescription,
        // PHASE 9D: the Finder's explicit, canonical, server-validated county.
        // `locationDescription` above is stored UNCHANGED — the user's own
        // wording is never replaced, normalized in place, or overwritten by any
        // provider result (see §8 of the Phase 9D brief).
        found_county: canonicalFoundCounty,
        administrative_unit_id: canonicalFoundAdministrativeUnit,
        latitude: numericLat,
        longitude: numericLon,
        finder_phone: finderPhone,
        // No arbitrary/fallback agent is ever assigned — assignNearestAgent
        // returns agent: null whenever it can't confidently match one, and
        // that null is preserved here rather than being papered over. The
        // item enters the admin manual-assignment queue instead (see
        // needs_manual_agent_reassignment below and the
        // POST /api/admin/items/:id/review endpoint, which an admin uses to
        // actually assign an agent once one is confidently selected).
        assigned_agent_id: assignedAgent ? assignedAgent.id : null,
        status: 'awaiting_dropoff',
        flaggedForReview: isFlagged,
        isDescriptionOnly: !isSensitive,
        description: (!isSensitive) ? (description || extractedName || (cat ? cat.name_en : 'Found item')) : null,
        is_sensitive_document: isSensitive,
        rejection_reason: null,
        locked_total_fee: lockedTotalFee,
        locked_finder_share: lockedFinderShare,
        locked_agent_share: lockedAgentShare,
        locked_platform_share: lockedPlatformShare,
        agent_assignment_method: matchingResult.method,
        agent_assignment_distance_km: matchingResult.distanceKm,
        needs_manual_agent_reassignment: matchingResult.needsManualAgentReassignment,
        finder_email: finderEmail || null,
        declared_value: parsedDeclaredValue,
        fee_ceiling_applied: feeCeilingApplied,
      });

if (matchingResult.method === 'manual_required') {
        // N8: routed through the notification boundary. The admin recipient is
        // resolved by this caller (it used to be read inside the email provider);
        // when unset the event is rejected with `missing_recipient` and nothing
        // is sent, exactly as before.
        //
        // Idempotency identity: the REPORTED ITEM. `newItem.id` is the drop-off
        // code the admin sees in the subject, it is the item whose assignment
        // failed, and an item is reassigned once — so it is the stable business
        // identity here. It contains no secret, address, or timestamp.
        NotificationService.notify({
          eventType: 'ADMIN_REASSIGNMENT',
          recipient: getAdminNotificationEmail(),
          // N9: the reported item. Its own id, location description and finder
          // phone are durable, so this notification can be rebuilt exactly.
          businessReference: newItem.id,
          idempotencyKey: buildNotificationIdempotencyKey('ADMIN_REASSIGNMENT', newItem.id),
          render: () =>
            renderSendAdminNewReassignmentRequestEmail(
              newItem.id,
              locationDescription,
              finderPhone
            ),
        }).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Admin reassignment email failed:', err));
      }

      if (createAccount && termsAccepted) {
        await db.logAudit(
          finderPhone,
          'TERMS_ACCEPTED',
          `Finder account terms and privacy accepted for phone ${finderPhone} during item report`
        );
      }

      res.json({
        success: true,
        item: {
          id: newItem.id,
          // assignedAgent is null when the item is awaiting manual admin
          // assignment — the frontend must handle this case with honest
          // messaging ("we're finding the right agent for you") rather
          // than assuming an agent object is always present.
          assignedAgent,
        },
        message: assignedAgent
          ? 'Ripoti yako imepokelewa kikamilifu! Msimbo wako wa kuwasilisha bidhaa kwa Agent umezalishwa.'
          : 'Ripoti yako imepokelewa! Tunatafuta Agent anayefaa karibu nawe na tutakujulisha hivi karibuni. / Your report has been received! We\'re finding the right Agent near you and will notify you shortly.',
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

}
