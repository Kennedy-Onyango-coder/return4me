// CUSTOMER-FACING "POSSIBLE MATCH" VIEW (Phase 9B)
// ================================================
// The ONLY place a match candidate is turned into something a customer sees.
//
// TWO HARD RULES, both implemented here rather than trusted to callers:
//
// 1. REUSE THE EXISTING PRIVACY BOUNDARY. Every candidate field is copied from
//    the output of services/publicItemView.ts — the same masked read model the
//    public search results and /item/:id already serve. That means the
//    "sensitive documents never publish a photo or description" decision, and
//    every other masking rule, has exactly ONE implementation. This module adds
//    no item fields of its own.
//
// 2. NEVER EXPOSE THE MATCH INTERNALS. The engine's numeric score and its raw
//    signal matrix stay server-side. The customer receives a short list of
//    allow-listed, human-meaningful reason keys, and the envelope carries
//    `ownership_confirmed: false` on every response.
//
// WHAT IS DELIBERATELY ABSENT FROM A CANDIDATE:
//   finder_phone, finder_email, ocr_extracted_name, ocr_extracted_number,
//   document_number_hash, latitude, longitude, assigned_agent_id, the agent
//   object, locked_*_fee, declared_value, verification/audit columns,
//   customer_id, the lost report's private text, and the internal score.
import { toPublicItemView } from './publicItemView.ts';

/**
 * Stable machine-readable notice. A client renders its own localised copy from
 * this code; the canonical wording below is the reference the UI must match.
 */
export const POSSIBLE_MATCH_NOTICE = 'possible_matches_do_not_confirm_ownership';

/** Returned when the lost report is closed (resolved/cancelled/lapsed). */
export const REPORT_NOT_ACTIVE_NOTICE = 'lost_report_not_active';

/**
 * The conservative, canonical wording for this feature. It deliberately says
 * "possible" and states plainly that ownership is NOT confirmed and that the
 * normal verification process still applies.
 *
 * The text is also kept free of the exact overclaiming substrings themselves
 * (a test asserts this), so even a naive substring scan — by a reviewer, a
 * test, or a future copy-paste — can never surface a sentence that reads like a
 * recovery claim. Note the wording avoids affirming the claim even in negated
 * form: it says the match "does not mean the item has been recovered" rather
 * than negating a phrase like "your item has been found".
 */
export const POSSIBLE_MATCH_DISCLOSURE_EN =
  'These are possible matches only. Some details look similar to your report, but this does NOT confirm ownership and it does NOT mean the item has been recovered. To collect anything you must go through the normal claim and verification process.';
export const POSSIBLE_MATCH_DISCLOSURE_SW =
  'Hizi ni mechi zinazowezekana tu. Baadhi ya maelezo yanafanana na ripoti yako, lakini hii HAITHIBITISHI umiliki na haimaanishi kitu chako kimerejeshwa. Ili kuchukua kitu chochote lazima upitie mchakato wa kawaida wa madai na uthibitisho.';

/**
 * Maps internal signals onto the short, allow-listed reasons a customer may
 * see. Order is fixed so the output is stable and testable.
 *
 * NOTE ON 'matching_identifier': it reveals only that a protected identifier
 * AGREED — never the identifier, never the hash. It is included because it is
 * the single most useful explanation for a candidate. This is not a new
 * document-number oracle on the platform: the pre-existing, UNAUTHENTICATED
 * public search (GET /api/items/search?q=) already returns exact hits for a
 * hashed document number, while this endpoint requires an authenticated
 * customer account and is rate-limited.
 */
export function safeMatchReasons(evaluation: any): string[] {
  const signals = evaluation?.signals || {};
  const reasons: string[] = [];
  if (signals.category_match === 'match') reasons.push('same_category');
  if (signals.identifier_match === 'match') reasons.push('matching_identifier');
  if (signals.document_type_match === 'match') reasons.push('matching_document_type');
  if (signals.location_match === 'match') reasons.push('similar_location');
  if (signals.time_match === 'match') reasons.push('similar_time');
  if (signals.brand_match === 'match') reasons.push('similar_brand');
  if (signals.model_match === 'match') reasons.push('similar_model');
  if (signals.colour_match === 'match') reasons.push('similar_colour');
  if (signals.material_match === 'match') reasons.push('similar_material');
  if (signals.text_signal === 'match') reasons.push('similar_description');
  return reasons;
}

/**
 * One candidate. Field-by-field from the public item read model — this function
 * never spreads a row, and carries no agent, no finder contact information, no
 * identifier (hashed or plain), and no match score.
 */
export function toLostReportMatchCandidateView(item: any, evaluation: any): any {
  const publicItem = toPublicItemView(item, null);
  if (!publicItem) return null;
  return {
    id: publicItem.id,
    category_id: publicItem.category_id,
    photo_url: publicItem.photo_url,
    is_sensitive_document: publicItem.is_sensitive_document,
    document_name_fuzzy: publicItem.document_name_fuzzy,
    location_description: publicItem.location_description,
    description: publicItem.description,
    isDescriptionOnly: publicItem.isDescriptionOnly,
    // "Approximate found date" — the same created_at the public item page shows.
    found_at: publicItem.created_at,
    match_reasons: safeMatchReasons(evaluation),
  };
}

/**
 * The match-list envelope. `ownership_confirmed` is a LITERAL false: there is no
 * code path that can set it true, because a candidate is never ownership.
 */
export function buildLostReportMatchesResponse(
  lostReport: any,
  candidates: Array<{ item: any; evaluation: any }>,
  notice: string = POSSIBLE_MATCH_NOTICE,
): any {
  return {
    lost_report_id: lostReport ? lostReport.id : null,
    ownership_confirmed: false,
    notice,
    disclosure: { en: POSSIBLE_MATCH_DISCLOSURE_EN, sw: POSSIBLE_MATCH_DISCLOSURE_SW },
    matches: (candidates || [])
      .map((candidate) => toLostReportMatchCandidateView(candidate.item, candidate.evaluation))
      .filter((view) => view !== null),
  };
}