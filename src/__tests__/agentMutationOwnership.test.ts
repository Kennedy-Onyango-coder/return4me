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

function agentRouteBody(route: string): string {
  const marker = `app.post('${route}', authenticateJWT, requireActiveAgent,`;
  const start = serverTs.indexOf(marker);
  expect(start, `route POST ${route} with agent middleware not found in server.ts`).toBeGreaterThan(-1);
  // One handler: from its opening marker to the next route registration.
  const nextRouteIdx = serverTs.indexOf('\n  app.', start + marker.length);
  return serverTs.slice(start, nextRouteIdx > start ? nextRouteIdx : start + 6000);
}

const ASSIGNED_OWNERSHIP = "item.assigned_agent_id !== req.user.agentId";

describe('P1-1: every state-changing agent route scopes to the assigned agent', () => {
  const mutationRoutes: Array<{ route: string; mutation: string }> = [
    { route: '/api/agents/verify-item', mutation: 'recordItemVerification' },
    { route: '/api/agents/confirm-dropoff', mutation: 'updateItemStatus' },
    { route: '/api/agents/claims/:claimId/confirm-viewing', mutation: 'updateClaimStatus' },
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
