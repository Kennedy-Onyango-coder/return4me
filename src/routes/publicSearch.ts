// PUBLIC DISCOVERY SEARCH — GET /api/items/search.
//
// P2-A2 — MECHANICAL EXTRACTION. This handler was moved VERBATIM out of
// server.ts so it can be mounted for real HTTP integration testing. NOTHING was
// redesigned: the query-parameter names, defaults, validation order, filters,
// claimability gate, privacy masking, status codes, response shape and error
// handling are all byte-identical to the inline version it replaces.
//
// WHY THIS IS A SEPARATE MODULE
// server.ts constructs the whole application and boots it at import time
// (Vite middleware, background sweeps and listeners), so it cannot be imported
// by a test. This route is therefore registered into the caller's Express app,
// which lets an integration test mount a REAL Express app around the REAL
// handler — the same pattern already established by routes/finderReport.ts,
// routes/customerClaims.ts, routes/publicItems.ts, routes/lostReports.ts,
// routes/adminClaims.ts, routes/adminDisputes.ts, routes/adminLostReports.ts
// and routes/categories.ts. This module must never boot anything itself.
//
// SECURITY CONTRACT PRESERVED FROM server.ts (do not "tidy" these):
//  - The public list is gated by the SAME canCreateClaim() rule the claim
//    endpoint applies, so this route can never drift from what the claim
//    endpoint would actually accept. canCreateClaim is INJECTED, never
//    re-implemented — that rule is shared with routes/publicItems.ts and
//    routes/lostReports.ts, which inject the very same function instance.
//  - `county` and `categoryId` are STRICT: a value that is not canonical is
//    REFUSED with a 400, never silently downgraded to a free-text search. A typo
//    must never quietly return "everything".
//  - `q` performs an exact HMAC match first and only then a fuzzy fallback.
//  - Every returned row goes through toPublicItemView, the same masked read
//    model GET /api/items/:id/public uses. No raw row, no OCR identity fields,
//    no finder contact, no GPS, no sensitive-document photo.
import { db } from '../db/database.ts';
import { resolveCountyName } from '../config/kenyaCounties.ts';
import { resolveAdministrativeUnitId } from '../config/kenyaAdministrativeUnits.ts';
import { FOUND_COUNTY_MESSAGES, itemMatchesCanonicalCounty } from '../services/foundItemCounty.ts';
import { CATEGORY_MESSAGES, resolveCategoryId } from '../services/categoryValidation.ts';
import { hashDocument } from '../services/documentHash.ts';
import { toPublicItemView } from '../services/publicItemView.ts';

export function registerPublicSearchRoutes(
  app: any,
  deps: {
    // Shared, not re-implemented: identical error disclosure to every inline
    // route (generic in production, detailed only in development).
    sendServerError: (res: any, error: any, context: string) => void;
    // The single claimability rule, injected so this route, routes/publicItems.ts
    // and routes/lostReports.ts can never disagree about what is claimable.
    canCreateClaim: (item: any, preFetchedDisputes?: any[]) => Promise<{ allowed: boolean; reason: string }>;
  }
) {
  const { sendServerError, canCreateClaim } = deps;
  // 5. OWNER SEARCH: PRIVACY-MASKED RESULTS
  app.get('/api/items/search', async (req, res) => {
    const { q, categoryId, area, county, administrativeUnitId } = req.query;

    // PHASE 16.1 (GEO-16-01) — STRUCTURED COUNTY FILTER.
    //
    // `county` filters on the item's DECLARED county (`items.found_county`)
    // alone. It is NOT a synonym for `area`/`q`: those still search free text,
    // and nothing here ever infers a county from text, coordinates or an agent
    // address. A request that names a county which is not one of the canonical
    // 47 is REFUSED rather than silently downgraded to a free-text search —
    // a typo must never quietly return "everything".
    //
    // Absent parameter = no county constraint, so every existing caller (and
    // every legacy item whose `found_county` is NULL) keeps its current results.
    let countyFilter: string | null = null;
    if (county !== undefined) {
      const canonicalCounty = typeof county === 'string' ? resolveCountyName(county) : null;
      if (!canonicalCounty) {
        return res.status(400).json({ error: FOUND_COUNTY_MESSAGES.invalid });
      }
      countyFilter = canonicalCounty;
    }
     // Public discovery geography is structured but remains additive to the
     // existing free-text search: county and sub-county are exact filters;
     // `q`/`area` still search user-facing text and never infer geography.
     let administrativeUnitFilter: string | null = null;
    if (administrativeUnitId !== undefined) {
      if (typeof countyFilter !== 'string') return res.status(400).json({ error: 'Please choose a county before filtering by sub-county.' });
      administrativeUnitFilter = resolveAdministrativeUnitId(countyFilter, administrativeUnitId);
      if (!administrativeUnitFilter) return res.status(400).json({ error: 'The selected sub-county does not belong to the selected county.' });
    }

    try {
      // PHASE 16.1 BATCH 1 (CAT-07) — STRICT CATEGORY FILTER.
      //
      // `categoryId` filters on the item's own classification and is a CANONICAL
      // category ID (the `categories.id` primary key) — never a display name,
      // never a partial/fuzzy match, never inferred from text. This mirrors the
      // county contract immediately above: an absent parameter means "no
      // constraint", and anything present that is not a canonical value is
      // REFUSED rather than silently downgraded.
      //
      // WHY THE OLD BEHAVIOUR WAS WRONG: it compared the raw query value with
      // `===` and returned whatever fell out. A typo, a category NAME
      // ("?categoryId=Laptop"), a stale id, a repeated parameter
      // ("?categoryId=laptop&categoryId=phone", which Express hands over as an
      // array) and an array-shaped value all produced exactly the same empty
      // result set as a legitimate "no matches" search — a search that quietly
      // lies about what it did.
      //
      // Resolution happens here, before any query work, and uses the SAME live
      // list every other category boundary uses (db.getCategories()); this file
      // still holds no category dataset of its own.
      //
      // The value must already BE a canonical category id, verbatim — the
      // resolved id has to equal the raw parameter. That exactness is not
      // cosmetic: the filter below compares the item's stored classification
      // against this same `categoryId` value, so accepting a padded or otherwise
      // non-identical variant here would accept a request that then matched
      // nothing — exactly the silent-empty-result behaviour this change exists
      // to remove.
      if (categoryId !== undefined) {
        const resolvedCategory = resolveCategoryId(categoryId, await db.getCategories());
        if (!resolvedCategory.ok || resolvedCategory.id !== categoryId) {
          return res.status(400).json({ error: CATEGORY_MESSAGES.invalid });
        }
      }

      // PERFORMANCE: canCreateClaim() only ever returns allowed:true for
      // status==='at_agent' — every other status (awaiting_dropoff,
      // claimed, expired, rejected, suspected_stolen, legal_hold) always
      // returns allowed:false. So fetching only 'at_agent' rows at the SQL
      // level (via getItemsByStatus, replacing an unfiltered
      // db.getItems() table scan) produces an identical final result set
      // while skipping every row that could never have passed anyway —
      // see the comment on getItemsByStatus in database.ts.
      const allItems = await db.getItemsByStatus('at_agent');
      // Public search must only ever show items that are CURRENTLY
      // claimable — routed through the same canCreateClaim() rule used at
      // claim-submission time, so this list can never drift from what the
      // claim endpoint will actually accept. Previously this allowed
      // 'awaiting_dropoff' items through: a Finder's report on its own,
      // before any Agent has physically verified the item exists. That is
      // not a verified found item and must never be publicly claimable.
      //
      // PERFORMANCE: canCreateClaim's dispute check used to run as its own
      // db.getDisputesByItem() query per item inside this Promise.all — an
      // N+1 pattern where every search request fired one dispute query per
      // result. Batched into a single db.getDisputesByItemIds() call up
      // front instead; see that method's comment.
      const disputesByItem = await db.getDisputesByItemIds(allItems.map(item => item.id));
      const claimabilityChecks = await Promise.all(allItems.map(async item => ({ item, result: await canCreateClaim(item, disputesByItem.get(item.id) ?? []) })));
      let items = claimabilityChecks.filter(c => c.result.allowed).map(c => c.item);

      // Filter by category — CAT-07: `categoryId` here is the canonical id the
      // boundary above already resolved against the live list, so this remains a
      // plain equality against the item's stored classification and can never
      // silently compare an array/undefined/unknown value.
      if (categoryId) {
        items = items.filter(item => item.category_id === categoryId);
      }

      // Filter by area text
      if (area) {
        const areaLower = (area as string).toLowerCase();
        items = items.filter(item => item.location_description.toLowerCase().includes(areaLower));
      }

      // PHASE 16.1 (GEO-16-01) — Filter by DECLARED county.
      // Applied AFTER the claimability/public-visibility filter above, so a
      // county search can never surface an item the public search would not
      // otherwise return. Combination with `q` is an AND: "County: Mombasa" +
      // "Nyali" returns Mombasa-county items whose searchable text says Nyali.
      if (countyFilter) {
        items = items.filter(item => itemMatchesCanonicalCounty(item, countyFilter as string));
      }

      // If search query is provided
      if (administrativeUnitFilter) {
        items = items.filter(item => item.administrative_unit_id === administrativeUnitFilter);
      }
      if (q) {
        const queryStr = (q as string).trim().toUpperCase();

        // Exact match via secure HMAC-SHA256 hash
        const queryHash = hashDocument(queryStr);
        // Exclude description-only items from exact hash matches
        const exactMatches = items.filter(item => !item.isDescriptionOnly && item.document_number_hash === queryHash);

        if (exactMatches.length > 0) {
          items = exactMatches;
        } else {
          // Fuzzy name matching fallback OR description-only search
          items = items.filter(item => {
            if (item.isDescriptionOnly || item.is_sensitive_document === false) {
              const desc = (item.description || '').toUpperCase();
              const loc = (item.location_description || '').toUpperCase();
              const title = (item.document_name_fuzzy || '').toUpperCase();
              return desc.includes(queryStr) || loc.includes(queryStr) || title.includes(queryStr);
            }
            if (!item.ocr_extracted_name) return false;
            // Check if parts of query exist in extracted name
            const nameParts = item.ocr_extracted_name.split(/\s+/);
            const queryParts = queryStr.split(/\s+/);
            return queryParts.some(qp => nameParts.some(np => np.includes(qp) || qp.includes(np)));
          });
        }
      }

      // Privacy Mask: Never send plaintext names/numbers or finder details to public searchers
      // Limit agent details to business_name and rough_area for privacy (Item 1)
      //
      // This used to call db.getAgent(item.assigned_agent_id) once per item
      // inside the map below — on the public search endpoint, almost
      // certainly the highest-traffic route in the app. A 50-item result
      // page meant 50 separate DB round-trips, even though there are far
      // fewer physical agent hubs nationally than there are found items, so
      // most of those round-trips were re-fetching the same handful of
      // agents over and over. One bulk fetch + an in-memory lookup turns N
      // round-trips into 1, regardless of how many items are in the page.
      const allAgentsForSearch = await db.getAgents();
      const agentByIdForSearch = new Map(allAgentsForSearch.map(a => [a.id, a]));

      const maskedResults = items.map(item => {
        const rawAgent = item.assigned_agent_id ? agentByIdForSearch.get(item.assigned_agent_id) : null;
        // Phase 7B: the masking itself now lives in services/publicItemView.ts
        // (toPublicItemView) so this route and GET /api/items/:id/public return
        // byte-for-byte the same shape. Behaviour is unchanged here.
        return toPublicItemView(item, rawAgent);
      });

      res.json(maskedResults);
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });
}
