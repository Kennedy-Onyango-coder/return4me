import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P1-1 / P1-4 / P2-2 REGRESSION — agent ownership scoping and handover gating.
//
// requireActiveAgent (already covered by activeAgentAuthorization.test.ts) only
// proves the caller is a *currently active* agent. It does NOT prove the caller
// may act on a *particular* item/claim. Every state-changing Agent route must
// independently re-scope to the target resource's assigned_agent_id and reject
// with 403 (so an active Agent B can never mutate Agent A's assignment), and the
// ownership check must run BEFORE any custody/payout DB mutation. confirm-handover
// must additionally re-check current claim/item eligibility (stolen / legal hold /
// unresolved dispute) and win a compare-and-swap before any settlement is booked.
//
// Static source-audit test (same hermetic pattern as the rest of this suite —
// server.ts does not export its Express app).

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
// P2-A3.4A: four agent operational routes moved verbatim into routes/agentOps.ts.
// This test defends the IDOR property (a non-assigned active Agent gets 403
// BEFORE any mutation), so it must keep covering every mutation route. The only
// change is WHICH FILE each route is read from — assertions are unchanged.
const agentOpsTs = fs.readFileSync(path.resolve(__dirname, '../routes/agentOps.ts'), 'utf8');

/** Strips comments so a module header that *documents* a rule is not itself
 *  counted as an occurrence of that rule. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function agentRouteBody(route: string): string {
  const marker = `app.post('${route}', authenticateJWT, requireActiveAgent,`;
  // Read from whichever file currently owns the route.
  const src = agentOpsTs.indexOf(marker) > -1 ? agentOpsTs : serverTs;
  const start = src.indexOf(marker);
  expect(start, `route POST ${route} with agent middleware not found in server.ts or routes/agentOps.ts`).toBeGreaterThan(-1);
  // One handler: from its opening marker to the next route registration.
  const nextRouteIdx = src.indexOf('\n  app.', start + marker.length);
  return src.slice(start, nextRouteIdx > start ? nextRouteIdx : start + 6000);
}

const ASSIGNED_OWNERSHIP = "item.assigned_agent_id !== req.user.agentId";

// P2-A3.4A + P2-A3.4B extraction integrity. Structural, not behavioural: this
// proves the moves happened exactly once and that nothing was dragged along.
// P2-A3.4B completed the set by moving confirm-viewing and confirm-handover in,
// so ALL SIX Agent lifecycle routes are now owned by this one module.
describe('P2-A3.4: all six Agent lifecycle routes are owned by routes/agentOps.ts', () => {
  const MOVED = [
    { method: 'get', route: '/api/agents/queue' },
    { method: 'post', route: '/api/agents/verify-item' },
    { method: 'post', route: '/api/agents/confirm-dropoff' },
    { method: 'post', route: '/api/agents/reject-dropoff' },
    { method: 'post', route: '/api/agents/claims/:claimId/confirm-viewing' },
    { method: 'post', route: '/api/agents/confirm-handover' },
  ];

  it('each moved route is registered in the module and absent from server.ts', () => {
    for (const { method, route } of MOVED) {
      const marker = `app.${method}('${route}', authenticateJWT, requireActiveAgent,`;
      expect(agentOpsTs, marker).toContain(marker);
      // No duplicate: the route must not still exist inline.
      expect(serverTs, marker).not.toContain(marker);
    }
  });

  it('each moved route is registered exactly once across the whole source tree', () => {
    for (const { method, route } of MOVED) {
      const marker = `app.${method}('${route}', authenticateJWT, requireActiveAgent,`;
      expect(agentOpsTs.split(marker).length - 1, marker).toBe(1);
    }
  });

  it('the module holds exactly six registrations and never boots the app', () => {
    const registrations = agentOpsTs.match(/app\.(get|post|put|delete)\(/g) || [];
    expect(registrations).toHaveLength(6);
    expect(agentOpsTs).not.toContain('startServer(');
    expect(agentOpsTs).not.toMatch(/from\s+['"].*server['"]/);
  });

  it('server.ts registers the module exactly once', () => {
    expect(serverTs).toContain('registerAgentOperationalRoutes(app, {');
    expect(serverTs.split('registerAgentOperationalRoutes(app, {').length - 1).toBe(1);
  });

  it('the IDOR assignment guard travelled with the code (5 occurrences)', () => {
    // verify-item, confirm-dropoff, reject-dropoff, confirm-viewing and
    // confirm-handover each re-scope to the assigned agent. If a future edit
    // drops one, this fails. Checked against comment-stripped code so the
    // module header's own explanation of the guard is not counted twice.
    expect(stripComments(agentOpsTs).split(ASSIGNED_OWNERSHIP).length - 1).toBe(5);
  });

  it('P2-A3.4B: confirm-viewing keeps its SEC-2B-02 explicit output projection', () => {
    // Never a spread of the claim row: a future column must not be able to leak
    // a presigned ID-proof URL, security_answers, owner_phone or owner_email.
    const body = agentOpsTs;
    expect(body).toContain('id: updatedClaim.id');
    expect(body).toContain('status: updatedClaim.status');
    expect(body).toContain('agent_confirmed_at: updatedClaim.agent_confirmed_at');
    expect(body).not.toContain('claim: updatedClaim,');
    expect(body).not.toMatch(/claim:\s*updatedClaim\s*\n\s*\}\s*,?\s*$/m);
  });

  it('P2-A3.4B: confirm-handover keeps proof-before-evidence ordering', () => {
    // The pickup code must be verified BEFORE the evidence photo is stored, so
    // a wrong code can never leave a real photo on a claim that never moved.
    const b = agentOpsTs;
    const check = b.indexOf('timingSafeEqualHex(hashCode(pickupCode.trim())');
    const upload = b.indexOf('uploadBase64Image(');
    const settle = b.indexOf('enterPendingSettlement(');
    expect(check).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(check);
    expect(settle).toBeGreaterThan(upload);
    // Money does not move here — only the pending_settlement transition.
    expect(b).not.toContain('executeClaimSettlement');
    expect(b).not.toContain('attemptSettlementRelease');
  });

  it('the shared server-owned helpers are INJECTED, not redefined in the module', () => {
    // One definition each, still in server.ts.
    for (const helper of [
      'requireActiveAgent', 'sendServerError', 'checkClaimExpiry', 'isSocialPublishingPaused',
      'pauseSettingKey', 'canCreateClaim', 'claimabilityErrorMessage', 'isPlatformOperationPaused',
    ]) {
      expect(stripComments(agentOpsTs), helper).not.toMatch(new RegExp('(function|const|async function)\\s+' + helper + '\\b'));
    }
    expect(serverTs).toMatch(/function requireActiveAgent\(/);
    expect(serverTs).toMatch(/async function checkClaimExpiry\(/);
    expect(serverTs).toMatch(/async function canCreateClaim\(/);
  });

  it('no payment, webhook or boot logic was pulled into this module', () => {
    for (const forbidden of [
      '/api/webhooks/intasend',
      'processClaimPaymentConfirmed',
      'attemptClaimEscrowHold',
      'executeClaimSettlement',
      '/api/dev/simulate-payment',
    ]) {
      expect(stripComments(agentOpsTs), forbidden).not.toContain(forbidden);
    }
  });
});

describe('P1-1: every state-changing agent route scopes to the assigned agent', () => {
  const mutationRoutes: Array<{ route: string; mutation: string }> = [
    { route: '/api/agents/verify-item', mutation: 'recordItemVerification' },
    { route: '/api/agents/confirm-dropoff', mutation: 'updateItemStatus' },
    // Phase 6C: confirm-viewing now moves the claim through the central
    // transition contract (transitionClaimStatus) instead of the unguarded
    // updateClaimStatus. The property this test defends is unchanged — the
    // ownership gate must still run BEFORE the state change.
    { route: '/api/agents/claims/:claimId/confirm-viewing', mutation: 'transitionClaimStatus' },
    { route: '/api/agents/confirm-handover', mutation: 'enterPendingSettlement' },
  ];

  for (const { route, mutation } of mutationRoutes) {
    it(`POST ${route} rejects a non-assigned active agent with 403 before mutating state`, () => {
      const body = agentRouteBody(route);
      // 1) The resource is scoped to req.user.agentId (the JWT-embedded agent id).
      expect(body).toContain(ASSIGNED_OWNERSHIP);
      // 2) It returns 403 (authorization failure, not 404/200).
      expect(body).toMatch(/res\.status\(403\)/);
      // 3) The ownership gate runs BEFORE the route's custody/payout DB mutation,
      //    so Agent B's attempt never reaches a state change.
      const gateIdx = body.indexOf(ASSIGNED_OWNERSHIP);
      const mutationIdx = body.indexOf(`db.${mutation}(`);
      expect(gateIdx, 'ownership check present').toBeGreaterThan(-1);
      expect(mutationIdx, `mutation db.${mutation} present`).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(mutationIdx);
    });
  }
});

describe('P1-4/P2-2: confirm-handover re-checks eligibility and uses a compare-and-swap before settlement', () => {
  const body = agentRouteBody('/api/agents/confirm-handover');

  it('re-checks current item/claim eligibility for stolen / legal-hold / unresolved-dispute before releasing', () => {
    expect(body).toMatch(/canCreateClaim\(item\)/);
    expect(body).toMatch(/claimability\.reason === 'suspected_stolen'/);
    expect(body).toMatch(/claimability\.reason === 'legal_hold'/);
    expect(body).toMatch(/claimability\.reason === 'unresolved_dispute'/);
    // The staleness check runs before the financial compare-and-swap.
    const staleIdx = body.indexOf("canCreateClaim(item)");
    const casIdx = body.indexOf('enterPendingSettlement(');
    expect(staleIdx).toBeGreaterThan(-1);
    expect(casIdx).toBeGreaterThan(-1);
    expect(staleIdx).toBeLessThan(casIdx);
  });

  it('wins the claim-into-settlement transition atomically via enterPendingSettlement (no duplicate payout)', () => {
    expect(body).toMatch(/await db\.enterPendingSettlement\(claimId/);
    // If the compare-and-swap loses the race the route must stop before any
    // further financial effect.
    expect(body).toMatch(/if \(!settlement\.success\)/);
  });
});
