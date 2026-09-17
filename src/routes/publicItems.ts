// Public item-detail + ownership-gated pickup-detail routes (Phase 7B).
//
// WHY THIS IS A SEPARATE MODULE
// server.ts constructs the whole application and calls startServer() at import
// time, so it cannot be imported by a test without booting Vite middleware,
// background sweeps and listeners. These routes are registered into the
// caller's Express app, which lets the HTTP integration tests mount a REAL
// Express app around the REAL handlers (same pattern as routes/customerClaims.ts,
// routes/adminClaims.ts and routes/adminDisputes.ts).
//
// WHAT LIVES HERE
//   GET  /api/items/:id/public            -> the public item-detail read model
//   POST /api/claims/:id/pickup-details   -> agent pickup contact/location, gated
//
// AUTHORIZATION MODEL FOR THE PICKUP ROUTE
// The endpoint it replaces was the anonymous GET /api/claims/:id/status, which
// returned the assigned agent's FULL contact phone, exact address and GPS
// coordinates to anyone holding a claim ID — and claim IDs are 6-digit numeric
// codes (CLM-100000..CLM-999999, under 900,000 values), i.e. trivially
// enumerable. Owners do not have logins in this flow, so the ownership proof
// used here is the SAME one every other claim route in this codebase already
// requires (/lookup, /pay, /payment-auth, /:id/request-otp): the caller must
// know the claim's own registered owner phone, E.164-normalized and compared
// server-side. No phone, or a non-matching phone, yields 403 with NO agent data
// in the body — not a partially populated object. The route is rate-limited
// like every other claim-ID-guessable route.
//
// PRIVACY RULE FOR THE ITEM ROUTE
// The public read model is exactly the masked representation the public search
// already returns (services/publicItemView.ts): never a raw row, never OCR
// identity fields, never a document hash, never the finder's contact details,
// never the item's GPS coordinates, and never the photo/description of a
// sensitive document.
import rateLimit from 'express-rate-limit';
import { db } from '../db/database.ts';
import { toE164Kenyan } from '../services/auth.ts';
import { toPublicItemView } from '../services/publicItemView.ts';
import { toOwnerSafeAgentView } from '../services/ownerSafeViews.ts';
import { isPickupEligibleClaimStatus } from '../config/claimStatuses.ts';

// Item IDs are drop-off codes ('R4M-' + 3 digits + 3 alphanumerics — see the
// report route in server.ts). This is a shape/abuse guard, NOT an authorization
// control: the lookup itself is done by primary key, and anything that doesn't
// resolve is reported as "not publicly available" rather than as a distinct
// error the caller could use to probe for internal records.
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/;

const MESSAGES = {
  // Deliberately ONE message for "no such item", "not claimable any more",
  // "disputed", "flagged stolen" and "not yet agent-verified". A caller must
  // not be able to use this public endpoint to learn whether a private or
  // withdrawn item record exists.
  itemNotPublic: 'Bidhaa hii haipatikani kwa umma kwa sasa. / This item is not publicly available right now.',
  // Deliberately ONE message for BOTH "no such claim" and "the phone does not
  // match this claim" (F4). Distinguishing them made the endpoint an existence
  // oracle: a caller who knew nothing but a candidate claim ID could tell a
  // real claim (403) from an invented one (404) without proving any ownership.
  claimUnavailable: 'Claim haikupatikana au nambari ya simu hailingani. / Claim not found, or the phone number does not match.',
  phoneRequired: 'Nambari ya simu inahitajika. / Phone number is required.',
  // F9: the claim exists and the caller proved ownership, but the claim's own
  // status no longer entitles it to active pickup instructions. The body
  // carries no status, item, agent, dispute or refund detail — the caller is
  // told the details are unavailable and nothing else.
  claimNotEligible: 'Maelezo ya kuchukua bidhaa hayapatikani kwa dai hili. / Pickup details are no longer available for this claim.',
};

// Mirrors the claimGuessLimiter thresholds in server.ts: a real owner needs a
// handful of calls per claim, so 20 per 15 minutes per connection is generous
// for them and useless for enumeration. Relaxed under test, exactly like
// claimLinkLimiter in routes/customerClaims.ts, so the integration suite is not
// throttled by its own fixtures.
const pickupDetailsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 20 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Umejaribu maombi mengi mno ya claim hii hivi karibuni. Tafadhali subiri dakika chache. / Too many claim requests from this connection recently. Please wait a few minutes.' },
});

export function registerPublicItemRoutes(
  app: any,
  deps: {
    // Injected rather than duplicated: the single central claimability rule
    // (status === 'at_agent', not disputed, not stolen/legal-hold) lives in
    // server.ts. Passing it in keeps this route's visibility rule identical to
    // the public search route's instead of maintaining a second copy that could
    // drift and expose an item the claim endpoint would refuse.
    canCreateClaim: (item: any, preFetchedDisputes?: any[]) => Promise<{ allowed: boolean; reason: string }>;
    sendServerError: (res: any, error: any, context: string) => void;
  }
) {
  const { canCreateClaim, sendServerError } = deps;

  // ---------------------------------------------------------------------------
  // PUBLIC ITEM DETAIL — GET /api/items/:id/public
  //
  // Returns the same masked shape GET /api/items/search returns for one item,
  // and ONLY for items that are currently publicly claimable. An item that is
  // awaiting drop-off, already claimed, expired, rejected, disputed,
  // suspected-stolen or under legal hold is a 404 here — the same set the
  // public search would never have shown in the first place.
  // ---------------------------------------------------------------------------
  app.get('/api/items/:id/public', async (req: any, res: any) => {
    const itemId = String(req.params.id || '').trim();
    try {
      if (!ITEM_ID_PATTERN.test(itemId)) {
        return res.status(404).json({ error: MESSAGES.itemNotPublic });
      }

      const item = await db.getItem(itemId);
      if (!item) {
        return res.status(404).json({ error: MESSAGES.itemNotPublic });
      }

      const disputes = await db.getDisputesByItem(item.id);
      const claimability = await canCreateClaim(item, disputes ?? []);
      if (!claimability.allowed) {
        return res.status(404).json({ error: MESSAGES.itemNotPublic });
      }

      const agent = item.assigned_agent_id ? await db.getAgent(item.assigned_agent_id) : null;
      return res.json({ item: toPublicItemView(item, agent) });
    } catch (e: any) {
      return sendServerError(res, e, 'PUBLIC_ITEM_DETAIL_ERROR');
    }
  });

  // ---------------------------------------------------------------------------
  // AGENT PICKUP DETAILS — POST /api/claims/:id/pickup-details
  //
  // The ONLY unauthenticated source of the assigned agent's operational contact
  // details. Requires the claim's registered owner phone (the existing
  // ownership bar on this platform). Everything here is ordered so a
  // non-owner learns nothing.
  //
  // ORDER IS A SECURITY PROPERTY. The checks run:
  //   limiter -> phone present -> claim exists -> phone matches -> claim status
  //   eligible -> resolve item -> resolve agent -> owner-safe DTO
  //
  //   * "phone present" is checked BEFORE any database read, so a malformed
  //     request cannot probe for claim existence at all.
  //   * The status gate (F9) runs AFTER the phone comparison, never before. If
  //     it ran first, a caller with a wrong phone could still tell an eligible
  //     claim (409) from an ineligible one (404) — a status oracle for a
  //     non-owner. Ownership is proven first; only then is state consulted.
  //   * The two ownership failures (F4) are the SAME status and the SAME body,
  //     so "claim does not exist" and "phone does not match" are externally
  //     indistinguishable.
  //
  // The success body is deliberately minimal — `item_id` plus the established
  // owner-safe agent whitelist — and never the raw claim or agent row.
  // ---------------------------------------------------------------------------
  app.post('/api/claims/:id/pickup-details', pickupDetailsLimiter, async (req: any, res: any) => {
    const claimId = String(req.params.id || '').trim();
    const { phone } = req.body || {};

    if (!phone) {
      return res.status(400).json({ error: MESSAGES.phoneRequired });
    }

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: MESSAGES.claimUnavailable });
      }

      const normalizedInput = toE164Kenyan(String(phone).replace(/\s+/g, ''));
      const normalizedOwner = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
      if (!normalizedInput || normalizedInput !== normalizedOwner) {
        // Same status AND same body as the unknown-claim branch above.
        return res.status(404).json({ error: MESSAGES.claimUnavailable });
      }

      // Ownership is proven. Only NOW may claim state be consulted (see the
      // ordering note above). A claim that is terminal, disputed, refunded or
      // still awaiting OTP is no longer entitled to the hub's live contact
      // details, exact address or coordinates.
      if (!isPickupEligibleClaimStatus(claim.status)) {
        return res.status(409).json({ error: MESSAGES.claimNotEligible, agent: null });
      }

      const item = await db.getItem(claim.item_id);
      const agent = item && item.assigned_agent_id ? await db.getAgent(item.assigned_agent_id) : null;

      // toOwnerSafeAgentView is the established whitelist for "agent details an
      // owner legitimately needs to collect their item" (business name,
      // contact phone, address, coordinates, rating) — it still excludes the
      // till/paybill, national-id hash, refundable deposit and warning history.
      //
      // `item_id` lets the browser assert that the agent it just received
      // belongs to the item currently on screen before displaying it (F7). It
      // is the ONLY additional field, and it is already public (item ids appear
      // in public search results and /item/:id URLs).
      return res.json({ item_id: claim.item_id, agent: toOwnerSafeAgentView(agent) });
    } catch (e: any) {
      return sendServerError(res, e, 'CLAIM_PICKUP_DETAILS_ERROR');
    }
  });
}
