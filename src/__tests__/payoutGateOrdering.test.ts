import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// BATCH 4 — EVERY PRE-SUBMISSION GATE COMES BEFORE THE MARKERS.
// =============================================================================
// The settlement executor refuses a payout for many reasons. Each refusal is only
// safe if it happens BEFORE the durable per-row submission markers
// (`db.markPayoutSubmissionStarted`) and before the provider call: after the
// markers, a refusal leaves the row recorded as submitted while nothing was sent,
// which no automatic recovery can undo.
//
// Batch 1 added the destination policy and the simulation refusal; Batch 1.1 added
// the booked-ledger (amount/destination) integrity refusal; Batch 2 added the
// wallet-routing refusal; Batch 3 added the approval-snapshot refusal. This file
// pins the COMBINED ordering, so moving any one gate below the markers — or
// deleting one — fails here rather than in production.
//
// It also pins that the provider call comes AFTER the markers: that order is what
// makes an interrupted attempt visible as 'submitting' instead of invisible.
// =============================================================================

const REPO_ROOT = path.resolve(__dirname, '../..');
const SERVER = fs.readFileSync(path.join(REPO_ROOT, 'src/server.ts'), 'utf8');

const EXECUTOR = (() => {
  const start = SERVER.indexOf('async function executeClaimSettlement');
  expect(start, 'executeClaimSettlement must exist').toBeGreaterThan(-1);
  return SERVER.slice(start);
})();

const MARKER_AT = EXECUTOR.indexOf('await db.markPayoutSubmissionStarted(');
const PROVIDER_AT = EXECUTOR.indexOf('await PaymentService.triggerIntasendPayout(');

/** Each refusal, the batch that introduced it, and the audit row it writes. */
const GATES: Array<{ audit: string; introducedBy: string }> = [
  { audit: 'PAYOUT_DESTINATION_NOT_ELIGIBLE', introducedBy: 'Batch 1 (phone-only policy)' },
  { audit: 'PAYOUT_AMOUNT_MISMATCH', introducedBy: 'Batch 1.1 (booked amount)' },
  { audit: 'PAYOUT_DESTINATION_MISMATCH', introducedBy: 'Batch 1.1 (booked destination)' },
  { audit: 'SETTLEMENT_AUTHORIZATION_MISMATCH', introducedBy: 'Batch 3 (approval snapshot)' },
  { audit: 'PAYOUT_SIMULATION_REFUSED', introducedBy: 'Batch 1 (simulation policy)' },
  { audit: 'PAYOUT_WALLET_ROUTING_REFUSED', introducedBy: 'Batch 2 (wallet routing)' },
];

describe('settlement pre-submission gates', () => {
  it('the structural landmarks exist and are ordered markers -> provider', () => {
    expect(MARKER_AT, 'the per-row submission marker must exist').toBeGreaterThan(-1);
    expect(PROVIDER_AT, 'the provider call must exist').toBeGreaterThan(-1);
    expect(MARKER_AT).toBeLessThan(PROVIDER_AT);
  });

  for (const gate of GATES) {
    it(`${gate.audit} (${gate.introducedBy}) is written before the markers`, () => {
      const index = EXECUTOR.indexOf(gate.audit);
      expect(index, `${gate.audit} must exist in the executor`).toBeGreaterThan(-1);
      expect(index, `${gate.audit} must precede the submission markers`).toBeLessThan(MARKER_AT);
    });
  }

  it('every refusal returns the release lock through abandonRelease()', () => {
    // One abandon path per gate (plus the wallet-config gate) — at least six
    // distinct `return await abandonRelease(` sites before the markers.
    const beforeMarkers = EXECUTOR.slice(0, MARKER_AT);
    const abandonCalls = beforeMarkers.match(/return await abandonRelease\(/g) ?? [];
    expect(abandonCalls.length).toBeGreaterThanOrEqual(GATES.length + 1);

    // Inside the submission block specifically, every failure must go through
    // abandonRelease(): a bare `return { success: false }` there would leave the
    // claim in 'releasing' with nothing to unstick it. (The paused-payout early
    // return ABOVE that block reverts the lock itself and is asserted elsewhere.)
    const blockStart = EXECUTOR.indexOf('if (submittable.length > 0) {');
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockStart).toBeLessThan(MARKER_AT);
    const submissionBlock = EXECUTOR.slice(blockStart, MARKER_AT);
    expect(submissionBlock).not.toMatch(/return\s*\{\s*success:\s*false/);
  });
});
