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
const ownerViewTsx = fs.readFileSync(path.resolve(__dirname, '../components/OwnerView.tsx'), 'utf8');

function routeBody(method: 'get' | 'post', route: string, len = 4000): string {
  const marker = `app.${method}('${route}'`;
  const start = serverTs.indexOf(marker);
  expect(start, `route ${method.toUpperCase()} ${route} not found in server.ts`).toBeGreaterThan(-1);
  return serverTs.slice(start, start + len);
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
    const start = serverTs.indexOf('function toOwnerSafeClaimView');
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 400);
    expect(body).toMatch(/function toOwnerSafeClaimView/);
    // It must enumerate the allowed fields, never spread the whole row.
    expect(body).toMatch(/id: claim\.id/);
    expect(body).toMatch(/status: claim\.status/);
    expect(body).toMatch(/agent_confirmed_at: claim\.agent_confirmed_at/);
    expect(body).not.toMatch(/\.\.\.claim/);
  });

  it('defines toOwnerSafeItemView that hides photos/OCR details for sensitive documents', () => {
    const start = serverTs.indexOf('function toOwnerSafeItemView');
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 600);
    expect(body).toMatch(/function toOwnerSafeItemView/);
    expect(body).not.toMatch(/\.\.\.item/);
    // Sensitive-document rows never expose a photo or OCR-derived identity fields.
    expect(body).toMatch(/photo_url: isSensitive \? null : item\.photo_url/);
  });
});

describe('owner-facing claim routes return the safe DTOs, never raw rows', () => {
  const lookup = routeBody('post', '/api/claims/lookup');

  it('POST /api/claims/lookup wraps claim, item, and agent in safe views', () => {
    expect(lookup).toMatch(/claim: toOwnerSafeClaimView\(claim\)/);
    expect(lookup).toMatch(/item: toOwnerSafeItemView\(item\)/);
    expect(lookup).toMatch(/agent: toOwnerSafeAgentView\(agent\)/);
    for (const secret of NEVER_IN_OWNER_RESPONSE) {
      expect(lookup).not.toMatch(new RegExp(`${secret}:`, 'i'));
    }
  });

  it('POST /api/claims/lookup still enforces the phone-match before returning anything', () => {
    expect(lookup).toMatch(/toE164Kenyan\(cleanPhone\)/);
    expect(lookup).toMatch(/403/);
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
      const start = serverTs.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const body = serverTs.slice(start, start + 4000);
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
    const bodyStart = ownerViewTsx.indexOf('body: JSON.stringify({');
    expect(bodyStart).toBeGreaterThan(-1);
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
});
