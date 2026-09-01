import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isAgentActionable } from '../auth';

// P0 fix: authenticateJWT only proves a token was validly signed and
// hasn't expired — it says nothing about whether the Agent it names is
// still allowed to act *right now*. Before this fix, every Agent
// operational route (verify-item, confirm-dropoff, reject-dropoff,
// confirm-viewing, confirm-handover) only checked req.user?.role ===
// 'agent' (trusting the JWT claim alone), so a suspended or still-pending
// Agent whose JWT happened to still have hours of validity left could keep
// performing every one of those operations right up until the token's
// natural expiry. requireActiveAgent (server.ts) now re-loads the Agent
// from the DB on every request and re-checks status via
// isAgentActionable(), extracted here specifically so the decision logic
// itself — not just "the middleware exists" — can be unit-tested without
// importing server.ts (which has no exports and a large amount of
// top-level side-effecting setup unsafe to trigger from a test file).

describe('isAgentActionable — the decision logic behind requireActiveAgent', () => {
  it('active Agent = allowed', () => {
    expect(isAgentActionable({ status: 'active' })).toBe(true);
  });

  it('pending Agent = denied', () => {
    expect(isAgentActionable({ status: 'pending' })).toBe(false);
  });

  it('suspended Agent = denied', () => {
    expect(isAgentActionable({ status: 'suspended' })).toBe(false);
  });

  it('unknown Agent (no record found, e.g. deleted or a forged agentId) = denied', () => {
    expect(isAgentActionable(undefined)).toBe(false);
    expect(isAgentActionable(null)).toBe(false);
  });

  it('an unrecognized/garbage status string = denied (fails closed, not open, on unexpected data)', () => {
    expect(isAgentActionable({ status: 'something-unexpected' })).toBe(false);
  });
});

// "wrong agentId = denied" is a routing property, not a decision-logic
// property: requireActiveAgent always loads the Agent by
// req.user.agentId (the value embedded in the JWT itself, which the Agent
// cannot forge without the server's JWT_SECRET — see verifyToken/
// generateToken), then separately every route's own item/claim ownership
// check (assigned_agent_id === agentId) rejects action on a
// resource belonging to a *different* Agent. Verified statically below:
// every operational route is wired to requireActiveAgent, so "wrong
// agentId" for one Agent attempting another Agent's item/claim is still
// caught by the pre-existing, separately-tested ownership checks on top of
// this new active-status gate — this test proves the gate itself is
// present on every route that needs it, closing the actual P0 gap (a
// suspended/pending Agent's still-valid token being usable at all).

const serverTs = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');

describe('requireActiveAgent is wired into every Agent operational route', () => {
  const operationalRoutes: Array<{ method: 'get' | 'post'; route: string }> = [
    { method: 'get', route: '/api/agents/queue' },
    { method: 'post', route: '/api/agents/verify-item' },
    { method: 'post', route: '/api/agents/confirm-dropoff' },
    { method: 'post', route: '/api/agents/reject-dropoff' },
    { method: 'post', route: "/api/agents/claims/:claimId/confirm-viewing" },
    { method: 'post', route: '/api/agents/confirm-handover' },
  ];

  for (const { method, route } of operationalRoutes) {
    it(`${method.toUpperCase()} ${route} is mounted with authenticateJWT, requireActiveAgent`, () => {
      const marker = `app.${method}('${route}', authenticateJWT, requireActiveAgent,`;
      expect(serverTs.includes(marker), `expected to find: ${marker}`).toBe(true);
    });
  }

  it('none of the operational routes still contain the old inline role-only check (would indicate a regression back to trusting the JWT claim alone)', () => {
    for (const { route } of operationalRoutes) {
      const routeStart = serverTs.indexOf(`'${route}'`);
      expect(routeStart, `route not found: ${route}`).toBeGreaterThan(-1);
      const body = serverTs.slice(routeStart, routeStart + 600);
      // The old pattern this replaced, inline in the handler body itself
      // (as opposed to being handled by the requireActiveAgent middleware
      // mounted on the route).
      expect(body).not.toMatch(/if \(req\.user\?\.role !== 'agent' \|\| !req\.user\.agentId\)/);
    }
  });
});
