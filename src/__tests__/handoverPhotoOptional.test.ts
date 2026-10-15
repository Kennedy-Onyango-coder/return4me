import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// AW BATCH — HANDOVER PHOTO IS OPTIONAL.
//
// This is the source-audit counterpart to the P0 order test
// (handoverPhotoOrder.test.ts). That test proves the photo is still uploaded
// AFTER the pickup code is verified when one is supplied; this test proves the
// photo is no longer a precondition for confirming a handover at all — neither
// on the client nor on the server — and that a photo-less handover still
// reaches the same pending_settlement transition.

const agentOpsTs = fs.readFileSync(path.resolve(__dirname, '../routes/agentOps.ts'), 'utf8');
const hookTs = fs.readFileSync(path.resolve(__dirname, '../hooks/useAgentOperations.ts'), 'utf8');
const viewTs = fs.readFileSync(path.resolve(__dirname, '../components/AgentView.tsx'), 'utf8');

function routeBody(route: string): string {
  const marker = `app.post('${route}'`;
  const start = agentOpsTs.indexOf(marker);
  expect(start, `route ${route} not found`).toBeGreaterThan(-1);
  return agentOpsTs.slice(start, start + 7000);
}

describe('AW batch — handover photo is optional end-to-end', () => {
  const body = routeBody('/api/agents/confirm-handover');

  it('the server no longer rejects a handover for a missing photo', () => {
    expect(body).not.toContain("if (!handoverPhotoBase64 || typeof handoverPhotoBase64 !== 'string'");
    expect(body).not.toContain('Take a photo of the claimant with the item before handing it over');
  });

  it('the server still uploads and persists the photo only when one is supplied', () => {
    expect(body).toContain("if (handoverPhotoBase64 && typeof handoverPhotoBase64 === 'string' && handoverPhotoBase64.trim() !== '') {");
    expect(body).toContain("uploadBase64Image(handoverPhotoBase64, 'handover-evidence')");
    expect(body).toContain('setHandoverPhoto(claimId, handoverPhotoUrl)');
  });

  it('settlement is entered regardless of whether a photo was supplied', () => {
    const setPhotoIdx = body.indexOf('setHandoverPhoto(claimId, handoverPhotoUrl)');
    const enterIdx = body.indexOf('enterPendingSettlement(claimId');
    expect(setPhotoIdx, 'setHandoverPhoto call not found').toBeGreaterThan(-1);
    expect(enterIdx, 'enterPendingSettlement call not found').toBeGreaterThan(-1);
    // The photo write is the last statement of the OPTIONAL photo block, and
    // settlement still follows it — so settlement is reached with or without a
    // photo, never blocked behind one.
    expect(setPhotoIdx).toBeLessThan(enterIdx);
  });

  it('the client no longer blocks the handover when no photo is captured', () => {
    expect(hookTs).not.toContain("if (!photoBase64) { setOperationError('Take a photo of the claimant");
    // Still sends the same typed payload, with photoBase64 allowed to be null.
    expect(hookTs).toContain('handoverPhotoBase64: photoBase64');
  });

  it('the modal labels the photo as optional, never required', () => {
    expect(viewTs).toContain("Photo of claimant with the item (optional");
    expect(viewTs).not.toContain("Photo of claimant with the item (required)");
  });
});
