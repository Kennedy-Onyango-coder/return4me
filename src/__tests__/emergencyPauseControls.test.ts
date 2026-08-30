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

function routeBody(method: 'get' | 'post', route: string): string {
  const marker = `app.${method}('${route}'`;
  const start = serverTs.indexOf(marker);
  expect(start, `route ${method.toUpperCase()} ${route} not found in server.ts`).toBeGreaterThan(-1);
  return serverTs.slice(start, start + 2500);
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
