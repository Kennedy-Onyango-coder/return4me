import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P0 REGRESSION TEST — handover photo order. POST
// /api/agents/confirm-handover used to upload and persist the handover
// evidence photo (db.setHandoverPhoto) BEFORE the pickup code was actually
// verified against its hash — the pickup-code presence check only
// confirmed a non-empty string was supplied, not that it was CORRECT. That
// meant a wrong pickup code (a typo, a scam attempt, an agent testing the
// flow) still left a real uploaded evidence photo stored against the claim
// even though the handover never actually happened, and the claim never
// progressed. Correct order: authorize the agent and the claim/item,
// validate claim state, validate the pickup code against its hash, THEN —
// and only then — validate and upload the photo.
//
// Static source-audit test (same pattern used throughout this suite)
// since server.ts doesn't export its Express app separately from
// startServer()'s bootstrap.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

function routeBody(method: 'get' | 'post', route: string): string {
  const marker = `app.${method}('${route}'`;
  const start = serverTs.indexOf(marker);
  expect(start, `route ${method.toUpperCase()} ${route} not found in server.ts`).toBeGreaterThan(-1);
  return serverTs.slice(start, start + 7000);
}

describe('confirm-handover validates the pickup code hash BEFORE uploading any photo', () => {
  const body = routeBody('post', '/api/agents/confirm-handover');

  it('pickup code hash verification (timingSafeEqualHex) appears before the photo upload call (uploadBase64Image)', () => {
    const pickupCheckIdx = body.indexOf('timingSafeEqualHex(hashCode(pickupCode.trim())');
    const uploadIdx = body.indexOf('uploadBase64Image(handoverPhotoBase64');
    expect(pickupCheckIdx, 'pickup code hash check not found').toBeGreaterThan(-1);
    expect(uploadIdx, 'photo upload call not found').toBeGreaterThan(-1);
    expect(pickupCheckIdx).toBeLessThan(uploadIdx);
  });

  it('the pickup code is marked verified before the photo is uploaded', () => {
    const verifiedIdx = body.indexOf('markPickupCodeVerified(claimId)');
    const uploadIdx = body.indexOf('uploadBase64Image(handoverPhotoBase64');
    expect(verifiedIdx, 'markPickupCodeVerified call not found').toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(-1);
    expect(verifiedIdx).toBeLessThan(uploadIdx);
  });

  it('setHandoverPhoto (persisting the photo to the claim) happens after, not before, pickup code hash verification', () => {
    const pickupCheckIdx = body.indexOf('timingSafeEqualHex(hashCode(pickupCode.trim())');
    const setPhotoIdx = body.indexOf('setHandoverPhoto(claimId, handoverPhotoUrl)');
    expect(pickupCheckIdx).toBeGreaterThan(-1);
    expect(setPhotoIdx, 'setHandoverPhoto call not found').toBeGreaterThan(-1);
    expect(pickupCheckIdx).toBeLessThan(setPhotoIdx);
  });

  it('claim/item authorization and claim-state validation still happen before the pickup code check (order of the earlier gates is unchanged)', () => {
    const agentAuthIdx = body.indexOf("item.assigned_agent_id !== req.user.agentId");
    const claimStateIdx = body.indexOf("claim.status !== 'escrow_held'");
    const pickupPresenceIdx = body.indexOf('!pickupCode || typeof pickupCode');
    expect(agentAuthIdx).toBeGreaterThan(-1);
    expect(claimStateIdx).toBeGreaterThan(-1);
    expect(pickupPresenceIdx).toBeGreaterThan(-1);
    expect(agentAuthIdx).toBeLessThan(claimStateIdx);
    expect(claimStateIdx).toBeLessThan(pickupPresenceIdx);
  });

  it('settlement is entered only after both the pickup code and the photo have been validated (order of the final gate is unchanged)', () => {
    const uploadIdx = body.indexOf('uploadBase64Image(handoverPhotoBase64');
    const settlementIdx = body.indexOf('enterPendingSettlement(claimId');
    expect(uploadIdx).toBeGreaterThan(-1);
    expect(settlementIdx, 'enterPendingSettlement call not found').toBeGreaterThan(-1);
    expect(uploadIdx).toBeLessThan(settlementIdx);
  });
});
