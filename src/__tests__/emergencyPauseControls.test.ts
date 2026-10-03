import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Regression test for the emergency pause controls added to close a real
// gap: before this, 'social_publishing_paused' was the ONLY platform-wide
// pause switch that existed — an admin had no way to freeze new reports,
// new claims, payment initiation, payout disbursement, or handovers without
// touching code/infrastructure. See PAUSABLE_SCOPES in server.ts.
//
// Static source-audit test (same pattern as adminRouteAudit.test.ts,
// claimGuessRateLimit.test.ts, webhookSignatureTiming.test.ts) since
// server.ts doesn't export its Express app separately from startServer()'s
// bootstrap.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

// P2-A3.2: the eight claim payment/status handlers were moved VERBATIM into
// routes/claimPayments.ts so an HTTP integration test can mount them without
// importing server.ts (which boots its listener at import time). Anchored
// lookups below therefore resolve against whichever file owns the anchor.
// Assertions are unchanged — only the file the route body is read from moved.
const CLAIM_PAYMENTS_TS = fs.readFileSync(path.resolve(__dirname, '../routes/claimPayments.ts'), 'utf8');
// Resolves an anchor from whichever file now owns it.
function sourceFor(marker: string): string {
  if (serverTs.includes(marker)) return serverTs;
  if (CLAIM_PAYMENTS_TS.includes(marker)) return CLAIM_PAYMENTS_TS;
  return serverTs;
}

// P2-A1: POST /api/items/report and POST /api/items/analyze were extracted
// VERBATIM from server.ts into routes/finderReport.ts so they can be mounted for
// real HTTP integration testing. This resolver returns whichever file now OWNS
// a given route marker, so every assertion below keeps testing the same route
// body it always tested — only the file it is read from moved. No route body,
// ordering guarantee or validation is asserted differently.
const FINDER_REPORT_TS = fs.readFileSync(path.resolve(__dirname, '../routes/finderReport.ts'), 'utf8');
// P2-A3.1: POST /api/claims/submit was likewise extracted VERBATIM into
// routes/claims.ts. Same resolver, one more owner file — the pause gate it
// asserts on is unchanged.
const CLAIMS_ROUTE_TS = fs.readFileSync(path.resolve(__dirname, '../routes/claims.ts'), 'utf8');
// P2-A3.4A/4B: all six Agent lifecycle routes now live in routes/agentOps.ts.
const AGENT_OPS_TS = fs.readFileSync(path.resolve(__dirname, '../routes/agentOps.ts'), 'utf8');
function routeSourceFor(marker: string): string {
  if (serverTs.includes(marker)) return serverTs;
  if (FINDER_REPORT_TS.includes(marker)) return FINDER_REPORT_TS;
  if (CLAIMS_ROUTE_TS.includes(marker)) return CLAIMS_ROUTE_TS;
  // P2-A3.2: the claim payment/status handlers moved to routes/claimPayments.ts.
  if (CLAIM_PAYMENTS_TS.includes(marker)) return CLAIM_PAYMENTS_TS;
  // P2-A3.4A/4B: all six Agent lifecycle routes moved to routes/agentOps.ts.
  if (AGENT_OPS_TS.includes(marker)) return AGENT_OPS_TS;
  throw new Error(`route marker not found in server.ts, routes/finderReport.ts, routes/claims.ts, routes/claimPayments.ts or routes/agentOps.ts: ${marker}`);
}

function routeBody(method: 'get' | 'post', route: string): string {
  const marker = `app.${method}('${route}'`;
  // P2-A1 / P2-A3.1: resolve from whichever file now owns the route.
  const src = routeSourceFor(marker);
  const start = src.indexOf(marker);
  expect(start, `route ${method.toUpperCase()} ${route} not found in any route module`).toBeGreaterThan(-1);
  return src.slice(start, start + 2500);
}

function functionBody(name: string, windowSize: number = 2500): string {
  const marker = `async function ${name}(`;
  const start = serverTs.indexOf(marker);
  expect(start, `function ${name} not found in server.ts`).toBeGreaterThan(-1);
  return serverTs.slice(start, start + windowSize);
}

describe('emergency pause controls exist for all six scopes', () => {
  it('defines all six pausable scopes', () => {
    expect(serverTs).toMatch(
      /const PAUSABLE_SCOPES = \['reports', 'claims', 'payments', 'payouts', 'handovers', 'social_publishing'\]/
    );
  });

  it('the generic pause-scope admin route is admin-only', () => {
    const body = routeBody('post', '/api/admin/settings/pause');
    expect(body).toMatch(/req\.user\?\.role !== 'admin'/);
  });

  it('the pause-status admin route is admin-only', () => {
    const body = routeBody('get', '/api/admin/settings/pause-status');
    expect(body).toMatch(/req\.user\?\.role !== 'admin'/);
  });

  it('setSetting (used by every pause toggle) always audit-logs the change', () => {
    const dbTs = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');
    const start = dbTs.indexOf('public async setSetting(');
    expect(start).toBeGreaterThan(-1);
    const body = dbTs.slice(start, start + 800);
    expect(body).toMatch(/logAudit\(adminUser, "SETTING_CHANGED"/);
  });
});

describe('each pausable scope is actually enforced at its real gate, not just togglable', () => {
  it('reports are blocked while paused (POST /api/items/report)', () => {
    const body = routeBody('post', '/api/items/report');
    expect(body).toMatch(/isPlatformOperationPaused\(pauseSettingKey\('reports'\)\)/);
  });

  it('claims are blocked while paused (POST /api/claims/submit)', () => {
    const body = routeBody('post', '/api/claims/submit');
    expect(body).toMatch(/isPlatformOperationPaused\(pauseSettingKey\('claims'\)\)/);
  });

  it('payments are blocked while paused (POST /api/claims/:id/pay)', () => {
    const body = routeBody('post', '/api/claims/:id/pay');
    expect(body).toMatch(/isPlatformOperationPaused\(pauseSettingKey\('payments'\)\)/);
  });

  it('handovers are blocked while paused (POST /api/agents/confirm-handover)', () => {
    const body = routeBody('post', '/api/agents/confirm-handover');
    expect(body).toMatch(/isPlatformOperationPaused\(pauseSettingKey\('handovers'\)\)/);
  });

  it('payouts are blocked at the single shared executeClaimSettlement choke point, used by both the automatic sweep and the admin manual-release endpoint', () => {
    const body = functionBody('executeClaimSettlement');
    expect(body).toMatch(/isPlatformOperationPaused\(pauseSettingKey\('payouts'\)\)/);
    // Must not leave the claim stuck in the 'releasing' lock forever.
    expect(body).toMatch(/revertSettlementRelease\(claimId\)/);
  });

  it('every pause check fails safe (treats a read error as paused, never as not-paused)', () => {
    const body = functionBody('isPlatformOperationPaused', 650);
    expect(body).toMatch(/return true;\s*\n\s*}\s*\n}/);
    expect(body).not.toMatch(/return false;/);
  });
});
