import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../database';

// Regression test for a real, previously-unflagged gap: POST
// /api/claims/:id/rate was completely unauthenticated, unrate-limited, and
// had no check that the claim had ever reached handover — meaning anyone
// who found or guessed a claim ID (a 6-digit numeric space, under 900,000
// values) could call db.rateAgent() an unlimited number of times to
// arbitrarily inflate or tank an agent's rating average, since rateAgent()
// is a running average with no built-in dedup. Now gated three ways: rate
// limiting, a handover-has-occurred status check, and an atomic
// once-per-claim dedup via db.markClaimRatedIfNotAlready.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');

function routeBody(method: 'get' | 'post', route: string): string {
  const marker = `app.${method}('${route}'`;
  const start = serverTs.indexOf(marker);
  expect(start, `route ${method.toUpperCase()} ${route} not found in server.ts`).toBeGreaterThan(-1);
  return serverTs.slice(start, start + 2500);
}

describe('POST /api/claims/:id/rate is rate-limited, status-gated, and dedup-guarded', () => {
  const body = routeBody('post', '/api/claims/:id/rate');

  it('is rate-limited with claimGuessLimiter', () => {
    expect(serverTs).toMatch(/app\.post\('\/api\/claims\/:id\/rate',\s*claimGuessLimiter,/);
  });

  it('requires the claim status to indicate handover has actually occurred', () => {
    expect(body).toMatch(/\['pending_settlement', 'releasing', 'released'\]\.includes\(claim\.status\)/);
  });

  it('uses the atomic once-per-claim dedup guard rather than an unconditional rateAgent() call', () => {
    expect(body).toMatch(/markClaimRatedIfNotAlready/);
    expect(body).toMatch(/if \(!wonRatingSlot\)/);
  });
});

let counter = 0;
async function makeTestItemWithAgent() {
  const agentId = `AGENT-RATEDEDUP-${counter}`;
  const itemId = `TEST-ITEM-RATEDEDUP-${counter++}`;
  await db.createItem({
    id: itemId,
    category_id: 'national-id',
    photo_url: null,
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Test location',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000001',
    assigned_agent_id: agentId,
    status: 'claimed',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: true,
    rejection_reason: null,
  } as any);
  return { agentId, itemId };
}

async function makeTestClaim(itemId: string, status: 'escrow_held' | 'pending_settlement' | 'released') {
  const claimId = `TEST-CLAIM-RATEDEDUP-${counter++}`;
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: '+254700000002',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
    verification_tier: 1,
    status,
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
  });
  return claimId;
}

describe('markClaimRatedIfNotAlready enforces at most one rating per claim', () => {
  it('returns true the first time, then false on every subsequent attempt for the same claim', async () => {
    const { itemId } = await makeTestItemWithAgent();
    const claimId = await makeTestClaim(itemId, 'pending_settlement');

    const first = await db.markClaimRatedIfNotAlready(claimId);
    const second = await db.markClaimRatedIfNotAlready(claimId);
    const third = await db.markClaimRatedIfNotAlready(claimId);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(false);
  });

  it('sets agent_rated_at on the claim once won', async () => {
    const { itemId } = await makeTestItemWithAgent();
    const claimId = await makeTestClaim(itemId, 'released');

    await db.markClaimRatedIfNotAlready(claimId);
    const claim = await db.getClaim(claimId);

    expect(claim?.agent_rated_at).toBeTruthy();
  });

  it('two different claims can each be rated independently (dedup is per-claim, not global)', async () => {
    const { itemId } = await makeTestItemWithAgent();
    const claimA = await makeTestClaim(itemId, 'released');
    const claimB = await makeTestClaim(itemId, 'released');

    expect(await db.markClaimRatedIfNotAlready(claimA)).toBe(true);
    expect(await db.markClaimRatedIfNotAlready(claimB)).toBe(true);
  });
});
