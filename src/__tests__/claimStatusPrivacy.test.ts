import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
// Phase 7C.7 (R1): the disclosure gate is the canonical pickup-eligibility
// predicate and the canonical owner-safe agent whitelist — the matrix below is
// exercised through those REAL exports, not a re-declared copy.
import { CLAIM_STATUS_VALUES, isPickupEligibleClaimStatus } from '../config/claimStatuses';
import { toOwnerSafeAgentView } from '../services/ownerSafeViews';

// ---------------------------------------------------------------------------
// P0 REGRESSION TEST — claim-status privacy (Phase 7B).
//
// WHY SOURCE-LEVEL: server.ts calls startServer() at import time, so it cannot
// be imported by a test without booting Vite middleware, listeners and
// background sweeps. The behaviours that CAN be exercised over real HTTP are
// covered in publicItemJourney.test.ts (routes/publicItems.ts). What this file
// pins is the server.ts side of the boundary, which only source inspection can
// reach: the status route must (a) never return agent contact/location data,
// (b) never return anything beyond the minimal public status DTO, and (c) be
// rate-limited like every other claim-ID-guessable route.
//
// The original defect: GET /api/claims/:id/status was unauthenticated AND
// returned `agent: toOwnerSafeAgentView(agent)` — the assigned agent's full
// contact phone number, exact pickup address and GPS latitude/longitude — to
// anyone holding a claim ID. Claim IDs are 6-digit numeric codes
// (under 900,000 values), so the ID was guessable/enumerable and the
// operational data was effectively public.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname, '../..');
const serverTs = fs.readFileSync(path.resolve(repoRoot, 'src/server.ts'), 'utf8');
const ownerViewTsx = fs.readFileSync(path.resolve(repoRoot, 'src/components/OwnerView.tsx'), 'utf8');
const publicItemsTs = fs.readFileSync(path.resolve(repoRoot, 'src/routes/publicItems.ts'), 'utf8');
const ownerSafeViewsTs = fs.readFileSync(path.resolve(repoRoot, 'src/services/ownerSafeViews.ts'), 'utf8');

function statusRouteBody(len = 3000): string {
  const marker = "app.get('/api/claims/:id/status'";
  const start = serverTs.indexOf(marker);
  expect(start, 'GET /api/claims/:id/status not found in server.ts').toBeGreaterThan(-1);
  return serverTs.slice(start, start + len);
}

describe('GET /api/claims/:id/status is a minimal, public-safe status DTO', () => {
  it('is rate-limited by its OWN dedicated polling policy, NOT the discrete claimGuessLimiter', () => {
    // F1 (Phase 7B.2): the status route used to share claimGuessLimiter's
    // 20/15-min bucket with /lookup, /pay, /payment-auth, /payment-session and
    // /:id/rate, which starved the legitimate owner's own polling + payment.
    expect(serverTs).toMatch(/app\.get\('\/api\/claims\/:id\/status',\s*claimStatusPollLimiter,/);
    expect(serverTs).not.toMatch(/app\.get\('\/api\/claims\/:id\/status',\s*claimGuessLimiter,/);
    // The dedicated module must supply this limiter. Expressed as "imported FROM
    // this module" rather than as one exact brace string: Phase 12 added a second
    // named export to the SAME module (paymentSessionStatusLimiter, for the other
    // polled claim route), so pinning the exact single-symbol import text would
    // fail on a legitimate co-import while proving nothing the two assertions
    // above do not already prove. Those two — which are what actually encode the
    // F1 fix — are unchanged.
    expect(serverTs).toMatch(/import \{[^}]*\bclaimStatusPollLimiter\b[^}]*\} from '\.\/config\/claimStatusPollLimiter';/);
  });

  it('the discrete claim limiter still guards its own routes and is unchanged (20/15min)', () => {
    const discreteRoutes = [
      "app.post('/api/claims/:id/payment-auth', claimGuessLimiter,",
      "app.post('/api/claims/:id/payment-session', claimGuessLimiter,",
      "app.post('/api/claims/:id/pay', claimGuessLimiter,",
      // PHASE 16 — /lookup now resolves the customer session FIRST; the
      // discrete limiter is unchanged and still applied behind that boundary.
      "app.post('/api/claims/lookup', requireCustomerAuth, claimGuessLimiter,",
      // PHASE 16.1 Batch 2A — /rate gained the same customer authentication
      // boundary as /lookup (it is the other owner-journey claim route, and it
      // writes to a real agent's public reputation, so it must not be reachable
      // anonymously). The pinned contract is untouched: the discrete limiter is
      // still applied to this route, now behind that boundary.
      "app.post('/api/claims/:id/rate', requireCustomerAuth, claimGuessLimiter,",
    ];
    for (const route of discreteRoutes) {
      expect(serverTs, `discrete limit removed from ${route}`).toContain(route);
    }
    const limiterStart = serverTs.indexOf('const claimGuessLimiter = rateLimit({');
    expect(limiterStart).toBeGreaterThan(-1);
    const limiterBody = serverTs.slice(limiterStart, limiterStart + 400);
    expect(limiterBody).toMatch(/windowMs:\s*15 \* 60 \* 1000/);
    expect(limiterBody).toMatch(/max:\s*20(,|\s)/);
  });

  it('no longer returns an `agent` object at all', () => {
    const body = statusRouteBody();
    // The exact removed shape.
    expect(body).not.toMatch(/agent:\s*toOwnerSafeAgentView/);
    expect(body).not.toMatch(/\bagent\s*:/);
    // ...and it must not go looking for the agent either.
    expect(body).not.toMatch(/db\.getAgent\(/);
  });

  it('returns only the whitelisted status fields — never a raw claim row', () => {
    const body = statusRouteBody();
    expect(body).toMatch(/claim:\s*\{\s*id:\s*claim\.id,\s*status:\s*claim\.status,\s*agent_confirmed_at:\s*claim\.agent_confirmed_at,\s*\}/);
    expect(body).not.toMatch(/\.\.\.claim\b/);
    for (const field of ['security_answers', 'owner_phone', 'owner_email', 'owner_identifying_details', 'owner_id_proof_url', 'payment_reference']) {
      expect(body, `status response leaks ${field}`).not.toContain(field);
    }
  });
});

describe('the ownership-gated replacement supplies the pickup details instead', () => {
  it('server.ts registers the public item / pickup-details routes with the central claimability rule', () => {
    expect(serverTs).toContain("import { registerPublicItemRoutes } from './routes/publicItems';");
    expect(serverTs).toMatch(/registerPublicItemRoutes\(app,\s*\{\s*canCreateClaim,\s*sendServerError\s*\}\)/);
  });

  it('the public item route reuses the shared masked DTO and checks claimability before resolving the agent', () => {
    const canCreateIdx = publicItemsTs.indexOf('canCreateClaim(item, disputes');
    const agentIdx = publicItemsTs.indexOf('db.getAgent(item.assigned_agent_id)');
    expect(canCreateIdx).toBeGreaterThan(-1);
    expect(agentIdx).toBeGreaterThan(-1);
    expect(canCreateIdx).toBeLessThan(agentIdx);
    expect(publicItemsTs).toContain('toPublicItemView(item, agent)');
    // Every non-public outcome is the SAME 404 body, so the endpoint cannot be
    // used to probe whether a private record exists.
    expect((publicItemsTs.match(/MESSAGES\.itemNotPublic/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('the pickup-details route requires the claim phone match before touching the item/agent, and is rate-limited', () => {
    expect(publicItemsTs).toMatch(/app\.post\('\/api\/claims\/:id\/pickup-details',\s*pickupDetailsLimiter,/);
    const phoneCheckIdx = publicItemsTs.indexOf('normalizedInput !== normalizedOwner');
    const itemIdx = publicItemsTs.indexOf('db.getItem(claim.item_id)');
    expect(phoneCheckIdx).toBeGreaterThan(-1);
    expect(itemIdx).toBeGreaterThan(-1);
    // Authorization is decided BEFORE any sensitive lookup can happen.
    expect(phoneCheckIdx).toBeLessThan(itemIdx);
    // Only the established owner-safe agent whitelist is returned.
    expect(publicItemsTs).toContain('toOwnerSafeAgentView(agent)');
    expect(publicItemsTs).not.toMatch(/res\.json\(\{\s*agent:\s*agent\s*\}\)/);
  });
});

describe('the browser no longer relies on the public status response for agent data', () => {
  it('OwnerView fetches pickup details from the ownership-gated route', () => {
    expect(ownerViewTsx).toContain('/pickup-details');
    expect(ownerViewTsx).toMatch(/body:\s*JSON\.stringify\(\{\s*phone:\s*ownerPhoneRef\.current\s*\}\)/);
  });

  it('OwnerView never reads an agent off the polled status response', () => {
    expect(ownerViewTsx).not.toMatch(/data\.agent/);
    // The gated fetch is the only source of hub details, and it is initiated by
    // the steps that render them (plus the explicit retry affordance).
    expect((ownerViewTsx.match(/fetchAgentPickupDetails\(claimId\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 7C.5 — pickup-details contract hardening (F4 / F7 / F9 / F8).
//
// Same rationale as above: server.ts boots the app at import time and there is
// no DOM test framework, so the invariants that only source inspection can
// reach are pinned here. The behaviours that CAN be exercised over real HTTP
// (uniform failures, the eligibility matrix, item_id) are asserted in
// publicItemJourney.test.ts.
// ---------------------------------------------------------------------------
describe('pickup-details contract hardening (F4 / F7 / F9)', () => {
  // Everything from the route registration onwards — not the module header.
  const pickupRoute = publicItemsTs.slice(
    publicItemsTs.indexOf("app.post('/api/claims/:id/pickup-details'")
  );

  it('F4 — the unknown-claim and wrong-phone failures share ONE status and ONE message', () => {
    expect(pickupRoute.length).toBeGreaterThan(100);
    // Both ownership failures return the identical response — exactly two
    // branches, one status, one message.
    expect((pickupRoute.match(/res\.status\(404\)\.json\(\{ error: MESSAGES\.claimUnavailable \}\)/g) || []).length).toBe(2);
    // The distinguishable pair is gone for good.
    expect(pickupRoute).not.toContain('MESSAGES.claimNotFound');
    expect(pickupRoute).not.toContain('MESSAGES.phoneMismatch');
    // This route no longer uses 403 at all.
    expect(pickupRoute).not.toMatch(/res\.status\(403\)/);
  });

  it('F4 — the missing-phone guard still runs BEFORE any claim lookup', () => {
    const phoneRequiredIdx = pickupRoute.indexOf('MESSAGES.phoneRequired');
    const claimLookupIdx = pickupRoute.indexOf('db.getClaim(claimId)');
    expect(phoneRequiredIdx).toBeGreaterThan(-1);
    expect(claimLookupIdx).toBeGreaterThan(-1);
    expect(phoneRequiredIdx).toBeLessThan(claimLookupIdx);
    expect(pickupRoute).toMatch(/if \(!phone\) \{\s*return res\.status\(400\)/);
  });

  it('F9 — the status gate runs AFTER the phone comparison and BEFORE the item lookup', () => {
    const phoneIdx = pickupRoute.indexOf('normalizedInput !== normalizedOwner');
    const gateIdx = pickupRoute.indexOf('isPickupEligibleClaimStatus(claim.status)');
    const itemIdx = pickupRoute.indexOf('db.getItem(claim.item_id)');
    expect(phoneIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(itemIdx).toBeGreaterThan(-1);
    // Ownership first: a non-owner must never learn claim state.
    expect(phoneIdx).toBeLessThan(gateIdx);
    // Eligibility next: an ineligible claim never reaches the hub lookup.
    expect(gateIdx).toBeLessThan(itemIdx);
  });

  it('F9 — eligibility comes from the canonical config vocabulary, never an inline copy in the route', () => {
    expect(publicItemsTs).toContain("import { isPickupEligibleClaimStatus } from '../config/claimStatuses.ts';");
    for (const status of ['pending_verification', 'payment_window_expired', 'disputed', 'rejected', 'refunding', 'refunded']) {
      expect(pickupRoute, `the route must not inline the status '${status}'`).not.toContain(`'${status}'`);
    }
  });

  it('F9 — the ineligible response discloses no state, item or hub data', () => {
    expect(pickupRoute).toMatch(/res\.status\(409\)\.json\(\{ error: MESSAGES\.claimNotEligible, agent: null \}\)/);
  });

  it('F7 — the success response adds item_id and nothing else', () => {
    expect(pickupRoute).toMatch(/res\.json\(\{ item_id: claim\.item_id, agent: toOwnerSafeAgentView\(agent\) \}\)/);
    expect(pickupRoute).not.toMatch(/\{\s*\.\.\.claim\b/);
  });
});

// ---------------------------------------------------------------------------
// Phase 7C.7 — /api/claims/lookup disclosure consistency (R1 + R2).
//
// WHY WIRING + REAL-EXPORT COMPOSITION: this route lives INSIDE startServer()
// in server.ts, which boots the app at import time, so it cannot be mounted in
// a test the way routes/publicItems.ts can (that module exists precisely so the
// pickup-details handler is HTTP-testable), and server.ts cannot be refactored
// in this phase. So, exactly like the rest of this file:
//   * the route WIRING is asserted against the real source, and
//   * the STATUS MATRIX is exercised by composing the REAL canonical exports the
//     route calls (isPickupEligibleClaimStatus + toOwnerSafeAgentView), which
//     together are the expression the route evaluates verbatim.
// The per-status policy is additionally pinned in claimStatusVocabulary.test.ts.
// ---------------------------------------------------------------------------
describe('R1/R2 — POST /api/claims/lookup disclosure policy (Phase 7C.7)', () => {
  // Bounded to THIS route body only — an unbounded slice would run to the end of
  // server.ts and pick up every later route's status codes and status strings.
  const lookupStart = serverTs.indexOf("app.post('/api/claims/lookup'");
  const lookupRoute = serverTs.slice(lookupStart, serverTs.indexOf('\n  app.', lookupStart + 10));

  // The exact expression the route evaluates, built from the real exports.
  const gatedAgentView = (status: string, agent: any): any =>
    isPickupEligibleClaimStatus(status) ? toOwnerSafeAgentView(agent) : null;

  // A full agent row, INCLUDING the operational/financial fields the owner-safe
  // whitelist must never pass through.
  const RAW_AGENT = {
    id: 'AGENT-7C7',
    business_name: 'Test Hub',
    contact_phone: '+254700000001',
    location_address: 'Moi Avenue, Nairobi CBD, Shop 14B',
    latitude: -1.28,
    longitude: 36.82,
    rating: 4.5,
    rating_count: 21,
    mpesa_till_or_paybill: 'TILL-SECRET',
    national_id_hash: 'HASH-SECRET',
    refundable_deposit: 5000,
    warning_count: 3,
    last_warning_reason: 'secret',
    id_document_photo_url: 'https://secret.example/id.png',
    contact_email: 'agent-secret@example.com',
    shop_photo_url: 'https://secret.example/shop.png',
    payout_method_type: 'till',
    status: 'active',
  };

  const ELIGIBLE_STATUSES = [
    'awaiting_agent_confirmation',
    'pending_payment',
    'escrow_held',
    'pending_settlement',
    'releasing',
    'released',
  ];
  const INELIGIBLE_STATUSES = [
    'pending_verification',
    'payment_window_expired',
    'disputed',
    'rejected',
    'refunding',
    'refunded',
  ];

  it('the lookup route gates the agent on the canonical helper — no second status list', () => {
    expect(lookupRoute.length).toBeGreaterThan(500);
    expect(lookupRoute).toContain('isPickupEligibleClaimStatus(claim.status) ? toOwnerSafeAgentView(agent) : null');
    // The predicate comes from the shared vocabulary, not a private copy.
    expect(serverTs).toMatch(/import \{[^}]*\bisPickupEligibleClaimStatus\b[^}]*\} from '\.\/config\/claimStatuses'/);
    for (const status of CLAIM_STATUS_VALUES) {
      expect(lookupRoute, `the lookup route must not inline the status '${status}'`).not.toContain(`'${status}'`);
    }
  });

  it('the lookup response still carries agent + claim + item, and never becomes a 409', () => {
    expect(lookupRoute).toMatch(/agent: isPickupEligibleClaimStatus/);
    expect(lookupRoute).toMatch(/claim: toOwnerSafeClaimView\(claim\)/);
    expect(lookupRoute).toMatch(/item: toOwnerSafeItemView\(item\)/);
    expect(lookupRoute).not.toMatch(/res\.status\(409\)/);
    // The agent KEY is preserved (null, not removed) so the Track UI's
    // `trackResult.agent &&` guard keeps working unchanged.
    expect(lookupRoute).toMatch(/:\s*null,/);
  });

  it('only the agent is gated — the claim DTO still carries the status', () => {
    const claimViewBody = ownerSafeViewsTs.slice(
      ownerSafeViewsTs.indexOf('export function toOwnerSafeClaimView'),
      ownerSafeViewsTs.indexOf('export function toOwnerSafeItemView')
    );
    expect(claimViewBody).toContain('status: claim.status');
    expect(claimViewBody).toContain('agent_confirmed_at: claim.agent_confirmed_at');
    // The gate is applied to the agent expression only.
    expect(lookupRoute).not.toMatch(/claim: isPickupEligibleClaimStatus/);
    expect(lookupRoute).not.toMatch(/item: isPickupEligibleClaimStatus/);
  });

  it('per-status matrix: every ELIGIBLE status yields the owner-safe DTO', () => {
    for (const status of ELIGIBLE_STATUSES) {
      const view = gatedAgentView(status, RAW_AGENT);
      expect(view, `${status} must disclose the hub`).not.toBeNull();
      // Exact whitelist — unchanged by this phase.
      expect(Object.keys(view).sort(), status).toEqual([
        'business_name', 'contact_phone', 'id', 'latitude', 'location_address',
        'longitude', 'rating', 'rating_count',
      ]);
      expect(view.location_address).toBe(RAW_AGENT.location_address);
      expect(view.contact_phone).toBe(RAW_AGENT.contact_phone);
    }
  });

  it('per-status matrix: every INELIGIBLE status yields agent === null, with no operational fields', () => {
    for (const status of INELIGIBLE_STATUSES) {
      const view = gatedAgentView(status, RAW_AGENT);
      expect(view, `${status} must NOT disclose the hub`).toBeNull();
      // agent === null ⇒ the operational fields are unreachable entirely.
      const serialized = JSON.stringify(view);
      for (const field of [
        'latitude', 'longitude', 'location_address', 'contact_phone',
        'business_name', 'id', 'rating', 'rating_count',
      ]) {
        expect(serialized, `${status} must not expose ${field}`).not.toContain(field);
      }
    }
  });

  it('the matrix covers the complete claim vocabulary, exactly once', () => {
    // Disjoint + exhaustive: no status can fall through either branch.
    expect([...ELIGIBLE_STATUSES, ...INELIGIBLE_STATUSES].sort()).toEqual([...CLAIM_STATUS_VALUES].sort());
    for (const status of ELIGIBLE_STATUSES) {
      expect(INELIGIBLE_STATUSES, `${status} must not be in both sets`).not.toContain(status);
    }
  });

  it('the whitelist itself is unchanged — the raw agent row never passes through', () => {
    const view = gatedAgentView('escrow_held', RAW_AGENT);
    const serialized = JSON.stringify(view);
    for (const secret of [
      'TILL-SECRET', 'HASH-SECRET', 'agent-secret@example.com',
      'https://secret.example/id.png', 'https://secret.example/shop.png',
      'last_warning_reason', 'refundable_deposit', 'mpesa_till_or_paybill',
      'payout_method_type', 'national_id_hash', 'warning_count',
    ]) {
      expect(serialized, `agent view leaked ${secret}`).not.toContain(secret);
    }
  });

  it('an UNKNOWN status is refused by the gate (fail closed)', () => {
    expect(gatedAgentView('some_future_status', RAW_AGENT)).toBeNull();
  });
});
