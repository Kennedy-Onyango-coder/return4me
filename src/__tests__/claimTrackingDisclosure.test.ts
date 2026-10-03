import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Static source-audit regression tests for the owner/claimant data-exposure
// hardening (the same hermetic pattern used by claimOtpAbuseGate.test.ts and the
// rest of this suite): server.ts does not export its Express app separately from
// startServer()'s bootstrap, so behavior is asserted against the actual source.
//
// Threat modeled: every owner-facing, unauthenticated claim route used to return
// the ENTIRE raw claim/item row. Anyone who obtained a claim ID (from a URL, an
// SMS, a shared screenshot, or simple enumeration of the ~900k-combination claim
// space) could read `security_answers` (the exact answers used to prove
// ownership), plus the owner's phone, email, identifying details and ID-proof
// link — enough to impersonate the real owner on a later claim. The claim/verify/
// lookup/pay routes now return hand-built safe DTOs instead of raw rows.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
// P2-A3.1: the claim submit + claim OTP routes were extracted VERBATIM from
// server.ts into routes/claims.ts so they can be mounted for real HTTP
// integration testing. routeBody resolves a marker from whichever file now owns
// it, so every assertion keeps testing the same handler it always tested — only
// the file the body is read from moved. No behavioural assertion is weakened.
const CLAIMS_ROUTE_TS = fs.readFileSync(path.resolve(__dirname, '../routes/claims.ts'), 'utf8');
const ownerViewTsx = fs.readFileSync(path.resolve(__dirname, '../components/OwnerView.tsx'), 'utf8');
// Phase 2 moved the three owner-safe view builders into
// services/ownerSafeViews.ts (so the customer dashboard reuses the exact same
// masking rules instead of keeping a second copy). The two assertions below
// that inspect the function bodies are unchanged — they just read the file the
// functions now live in.
const ownerSafeViewsTs = fs.readFileSync(path.resolve(__dirname, '../services/ownerSafeViews.ts'), 'utf8');

// P2-A3.2: the eight claim payment/status handlers moved verbatim into
// routes/claimPayments.ts (so an HTTP integration test can mount them without
// importing server.ts, which boots its listener at import time). Route lookups
// below now search the new owner first and fall back to server.ts, so an
// assertion still fails if the handler disappears from BOTH files. No assertion
// was weakened or removed.
const CLAIM_PAYMENTS_TS = fs.readFileSync(path.resolve(__dirname, '../routes/claimPayments.ts'), 'utf8');
// P2-A3.4A: the four agent operational routes moved to routes/agentOps.ts.
const AGENT_OPS_TS = fs.readFileSync(path.resolve(__dirname, '../routes/agentOps.ts'), 'utf8');

function routeBody(method: 'get' | 'post', route: string, len = 4000): string {
  const marker = `app.${method}('${route}'`;
  const src = serverTs.includes(marker) ? serverTs : (CLAIMS_ROUTE_TS.includes(marker) ? CLAIMS_ROUTE_TS : (CLAIM_PAYMENTS_TS.includes(marker) ? CLAIM_PAYMENTS_TS : AGENT_OPS_TS));
  const start = src.indexOf(marker);
  expect(start, `route ${method.toUpperCase()} ${route} not found in server.ts or any extracted route module`).toBeGreaterThan(-1);
  // P2-A3.1 follow-up: the body runs to the NEXT route registration in the same
  // file rather than to a fixed character count. A handler that GROWS can
  // otherwise push a real assertion past the window purely by gaining a
  // docblock — which is exactly what happened when claim submit gained
  // requireCustomerAuth (+ its comment) in the claim-authentication work, while
  // a `not.toMatch` assertion on the same route can no longer be satisfied by
  // neighbouring routes leaking into an over-long slice. `len` remains the cap
  // for the LAST route in a file, which has no successor to bound it.
  const nextRoute = src.indexOf('\n  app.', start + marker.length);
  return nextRoute > -1 ? src.slice(start, nextRoute) : src.slice(start, start + len);
}

// The sensitive keys that must never be allowed to appear in an owner-facing
// JSON response's claim/item object.
const NEVER_IN_OWNER_RESPONSE = [
  'security_answers',
  'owner_phone',
  'owner_email',
  'owner_id_proof_url',
  'owner_identifying_details',
];

describe('owner-safe claim/item DTOs exist and are hand-built (not spread)', () => {
  it('defines toOwnerSafeClaimView with an explicit field whitelist', () => {
    const start = ownerSafeViewsTs.indexOf('export function toOwnerSafeClaimView');
    expect(start).toBeGreaterThan(-1);
    const body = ownerSafeViewsTs.slice(start, start + 400);
    expect(body).toMatch(/function toOwnerSafeClaimView/);
    // It must enumerate the allowed fields, never spread the whole row.
    expect(body).toMatch(/id: claim\.id/);
    expect(body).toMatch(/status: claim\.status/);
    expect(body).toMatch(/agent_confirmed_at: claim\.agent_confirmed_at/);
    expect(body).not.toMatch(/\.\.\.claim/);
  });

  it('defines toOwnerSafeItemView that hides photos/OCR details for sensitive documents', () => {
    const start = ownerSafeViewsTs.indexOf('export function toOwnerSafeItemView');
    expect(start).toBeGreaterThan(-1);
    const body = ownerSafeViewsTs.slice(start, start + 600);
    expect(body).toMatch(/function toOwnerSafeItemView/);
    expect(body).not.toMatch(/\.\.\.item/);
    // Sensitive-document rows never expose a photo or OCR-derived identity fields.
    expect(body).toMatch(/photo_url: isSensitive \? null : item\.photo_url/);
  });
});

describe('owner-facing claim routes return the safe DTOs, never raw rows', () => {
  const lookup = routeBody('post', '/api/claims/lookup');

  it('POST /api/claims/lookup wraps claim, item, and the status-gated agent in safe views', () => {
    expect(lookup).toMatch(/claim: toOwnerSafeClaimView\(claim\)/);
    expect(lookup).toMatch(/item: toOwnerSafeItemView\(item\)/);
    // Phase 7C.7 (R1): the agent view is gated by the canonical pickup
    // eligibility policy. The owner-safe whitelist itself is unchanged.
    expect(lookup).toMatch(/agent: isPickupEligibleClaimStatus\(claim\.status\) \? toOwnerSafeAgentView\(agent\) : null/);
    for (const secret of NEVER_IN_OWNER_RESPONSE) {
      expect(lookup).not.toMatch(new RegExp(`${secret}:`, 'i'));
    }
  });

  it('POST /api/claims/lookup enforces the phone-match with ONE uniform ownership failure (Phase 7C.7 R2)', () => {
    // The phone is still the credential, and the comparison is still enforced...
    expect(lookup).toMatch(/toE164Kenyan\(cleanPhone\)/);
    expect(lookup).toMatch(/claimPhoneClean !== cleanPhone/);
    // ...but "no such claim" and "wrong phone" are now externally identical.
    expect(lookup).not.toMatch(/res\.status\(403\)/);
    expect((lookup.match(/res\.status\(404\)\.json\(claimUnavailable\)/g) || []).length).toBe(2);
    // Both branches share ONE response constant, so they cannot drift apart.
    const constantIdx = lookup.indexOf('const claimUnavailable = {');
    expect(constantIdx).toBeGreaterThan(-1);
    expect(lookup.slice(constantIdx, constantIdx + 260)).toContain('Claim not found, or the phone number does not match');
    // ...and the missing-field guard still runs BEFORE any database read.
    expect(lookup).toMatch(/if \(!claimId \|\| !phone\)/);
    expect(lookup).toMatch(/res\.status\(400\)/);
    expect(lookup.indexOf('nambari ya simu zinahitajika')).toBeLessThan(lookup.indexOf('db.getClaim('));
  });

  it('POST /api/claims/submit returns toOwnerSafeClaimView, not the raw row', () => {
    const submit = routeBody('post', '/api/claims/submit', 26000);
    expect(submit).toMatch(/claim: toOwnerSafeClaimView\(claim\)/);
    expect(submit).not.toMatch(/res\.json\(\{\s*success: true,\s*claim,\s*$/m);
  });

  it('GET /api/claims/:id/status returns a hand-built whitelisted claim object', () => {
    const status = routeBody('get', '/api/claims/:id/status');
    expect(status).toMatch(/claim: \{\s*id: claim\.id,\s*status: claim\.status,\s*agent_confirmed_at: claim\.agent_confirmed_at,\s*\}/);
    expect(status).not.toMatch(/claim: (claim|updatedClaim)\b/);
  });

  it('does not leak the safe-DTO definitions into a raw row spread anywhere in an owner route', () => {
    // Regression guard: none of the DTO-returning responses may fall back to
    // `...item` / `...claim` style whole-row passthrough on owner-facing routes.
    const ownerRoutes = [
      "app.post('/api/claims/lookup'",
      "app.post('/api/claims/submit'",
      "app.get('/api/claims/:id/status'",
      "app.post('/api/claims/:id/pay'",
    ];
    for (const marker of ownerRoutes) {
      // P2-A3.1: /submit lives in routes/claims.ts; P2-A3.2 moved the payment
      // routes to routes/claimPayments.ts. Resolve per marker so the guard keeps
      const src = serverTs.includes(marker) ? serverTs : (CLAIMS_ROUTE_TS.includes(marker) ? CLAIMS_ROUTE_TS : CLAIM_PAYMENTS_TS);
      const start = src.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, start + 4000);
      expect(body).not.toMatch(/\.\.\.(claim|item)/);
    }
  });
});

describe('the agent evidence surface is filtered, not the raw claim', () => {
  it('GET /api/agents/queue builds associatedClaim evidence via toAgentVerificationEvidence', () => {
    const queue = routeBody('get', '/api/agents/queue', 9000);
    expect(queue).toMatch(/security_answers: toAgentVerificationEvidence\(/);
    expect(queue).toMatch(/owner_identifying_details: associatedClaim\.owner_identifying_details \|\| null/);
    // The agent evidence is assembled field-by-field into a fresh object, never
    // the raw claim row attached wholesale.
    expect(queue).toMatch(/associatedClaim: associatedClaim \? \{/);
    expect(queue).not.toMatch(/\.\.\.associatedClaim/);
  });
});
// ---------------------------------------------------------------------------
// SEC-2B-02 — POST /api/agents/claims/:claimId/confirm-viewing
// ---------------------------------------------------------------------------
// The handler used to end with `res.json({ success: true, claim: updatedClaim })`
// — the complete claim row from db.getClaim(), which passes through signClaim()
// and therefore carries a LIVE PRESIGNED URL in `owner_id_proof_url` (the
// claimant's government-ID image) plus the raw `security_answers`, owner
// contact/identity fields and the provider payment reference. The assigned
// agent needs none of that, and no client reads it (AgentView uses only
// data.error / data.message). Unlike GET /api/agents/queue — which maps the
// same data field-by-field and is pinned just above — this route had no output
// projection at all.
//
// Comments are stripped before the field-name assertions below: this block's
// own documentation names the very fields it forbids (the same reason
// publicNavigation.test.ts strips comments), so judging the CODE requires it.
describe('SEC-2B-02: confirm-viewing projects the claim instead of returning the raw row', () => {
  const marker = "app.post('/api/agents/claims/:claimId/confirm-viewing'";
  // P2-A3.2: confirm-viewing is an AGENT route and was deliberately NOT extracted.
  // P2-A3.4B: confirm-viewing moved verbatim into routes/agentOps.ts, so the
  // locator reads it from whichever file owns it. Assertions unchanged.
  const src = AGENT_OPS_TS.includes(marker) ? AGENT_OPS_TS : serverTs;
  const start = src.indexOf(marker);
  const after = src.slice(start);
  const nextRoute = after.indexOf('\n  app.', 10);
  const rawBody = src.slice(start, nextRoute > -1 ? start + nextRoute : start + 6000);
  const body = rawBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('the route exists (guards this test\'s own locator)', () => {
    expect(start, 'confirm-viewing route not found in server.ts or routes/agentOps.ts').toBeGreaterThan(-1);
    expect(rawBody).toContain('/api/agents/claims/:claimId/confirm-viewing');
  });

  it('returns an explicit allowlist of id / status / agent_confirmed_at', () => {
    expect(body).toMatch(/success: true/);
    expect(body).toMatch(/id: updatedClaim\.id/);
    expect(body).toMatch(/status: updatedClaim\.status/);
    expect(body).toMatch(/agent_confirmed_at: updatedClaim\.agent_confirmed_at/);
  });

  it('never returns the raw claim row (no whole-row passthrough, no spread)', () => {
    // The previous defect, in its exact shape.
    expect(body).not.toMatch(/claim:\s*updatedClaim\s*[},]/);
    // ...and no spread that would re-expose every column by default.
    expect(body).not.toMatch(/\.\.\.updatedClaim/);
    expect(body).not.toMatch(/\.\.\.claim\b/);
  });

  it('names no private claim field anywhere in its response', () => {
    for (const forbidden of [
      'owner_id_proof_url',
      'security_answers',
      'owner_phone',
      'owner_email',
      'owner_identifying_details',
      'payment_reference',
      'paid_at',
    ]) {
      expect(body, `confirm-viewing must not expose ${forbidden}`).not.toContain(forbidden);
    }
  });
});



describe('server rejects the old sandbox default and requires a real phone', () => {
  it('no sandbox placeholder phone fallback survives in server or OwnerView', () => {
    expect(serverTs).not.toMatch(/0700000000/);
    expect(ownerViewTsx).not.toMatch(/0700000000/);
    expect(serverTs).not.toMatch(/ownerPhone: ownerPhone \|\|/);
  });

  it('submit requires a valid +254 Kenyan number before creating a claim', () => {
    const submit = routeBody('post', '/api/claims/submit');
    expect(submit).toMatch(/toE164Kenyan\(String\(ownerPhone\)\.replace/);
    expect(submit).toMatch(/\+254\\d\{9\}/);
    expect(submit).toMatch(/A valid Kenyan phone number is required/);
  });

  it('OwnerView blocks claiming without a phone and sends the real phone it collected', () => {
    // Phone gate added at the top of the submit handler.
    expect(ownerViewTsx).toMatch(/if \(!ownerPhone\.trim\(\)\)/);
    expect(ownerViewTsx).toMatch(/Please enter your phone number before claiming/);

    // The real collected phone is sent in the request body, never a hardcoded
    // sandbox default.
    //
    // Phase 7B anchors this on the claim-SUBMISSION fetch specifically: the
    // public item journey added another JSON request earlier in this file (the
    // ownership-gated pickup-details call), so "the first `body: JSON.stringify({`
    // in OwnerView.tsx" is no longer necessarily the submit body. Every
    // assertion below is unchanged — this only makes the locator unambiguous.
    const submitStart = ownerViewTsx.indexOf("fetch('/api/claims/submit'");
    expect(submitStart).toBeGreaterThan(-1);
    const bodyStart = ownerViewTsx.indexOf('body: JSON.stringify({', submitStart);
    expect(bodyStart).toBeGreaterThan(submitStart);
    const body = ownerViewTsx.slice(bodyStart, bodyStart + 500);
    expect(body).toMatch(/ownerPhone,\s*\n/);
    expect(body).not.toMatch(/ownerPhone: ownerPhone \|\|/);
    expect(ownerViewTsx).not.toMatch(/0700000000/);
  });
});

describe('server-side verification validation is enforced on submit', () => {
  it('server.ts imports and applies validateVerificationAnswers against the server-known category', () => {
    const submit = routeBody('post', '/api/claims/submit');
    expect(submit).toMatch(/validateVerificationAnswers\(categoryId, securityAnswers\)/);
    expect(submit).toMatch(/sanitizedAnswers/);
    expect(submit).not.toMatch(/security_answers: securityAnswers/);
  });
  it('the validation category comes from the server-side item, never the claimant body', () => {
    const submit = routeBody('post', '/api/claims/submit');
    // The category used for validation is read off the item the server just
    // fetched by id — a claimant-supplied category cannot steer validation.
    expect(submit).toMatch(/const categoryId = item\.category_id \|\| 'other-item';/);
    expect(submit).not.toMatch(/categoryId\s*[:=][^;]*req\.body/);
    // The destructured claim body must not include a claimant-controlled category.
    // P2-A3.1: read from whichever file owns the route (see CLAIMS_ROUTE_TS).
    const submitAnchor = "app.post('/api/claims/submit'";
    const submitSrc = serverTs.includes(submitAnchor) ? serverTs : CLAIMS_ROUTE_TS;
    const bodyStart = submitSrc.indexOf(submitAnchor);
    const body = submitSrc.slice(bodyStart, bodyStart + 300);
    expect(body).not.toMatch(/category/i);
  });

});
