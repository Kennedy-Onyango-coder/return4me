import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// REGRESSION TEST — refund reconciliation endpoints authorization + no-auto-retry.
//
// server.ts deliberately does not export its Express app separately from
// startServer()'s bootstrap (the established, documented reason every route-level
// test in this repo is a static source-audit — see adminRouteAudit.test.ts,
// activeAgentAuthorization.test.ts). The reconciliation DB behavior itself
// (list/finalize/revert guards, idempotency, audit) is tested behaviorally in
// src/db/__tests__/refundReconciliation.test.ts. This file pins the HTTP
// surface: every reconciliation route is admin-only (authenticateJWT +
// requireCurrentAdminSession + role check) and — critically — neither the
// finalize nor the revert route can ever trigger a refund (no PaymentService /
// auto-retry path exists on them).

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

const RECON_START = serverTs.indexOf('// REFUND RECONCILIATION (A1 unknown-outcome operational workflow)');
const recBody = (() => {
  expect(RECON_START).toBeGreaterThan(-1);
  return serverTs.slice(RECON_START, RECON_START + 9000);
})();

describe('refund reconciliation endpoints are admin-only and can never trigger a refund', () => {
  it('lists refunding claims via GET /api/admin/refund-reconciliation mounted with authenticateJWT + requireCurrentAdminSession', () => {
    expect(recBody).toMatch(/app\.get\('\/api\/admin\/refund-reconciliation', authenticateJWT, requireCurrentAdminSession, async/);
    expect(recBody).toMatch(/db\.getRefundReconciliationClaims\(\)/);
    expect(recBody).toMatch(/req\.user\?\.role !== 'admin'/);
  });

  it('finalize endpoint is mounted with authenticateJWT + requireCurrentAdminSession + role check, and finalizes via the guarded DB method', () => {
    expect(recBody).toMatch(/app\.post\('\/api\/admin\/refund-reconciliation\/:claimId\/finalize', authenticateJWT, requireCurrentAdminSession, async/);
    expect(recBody).toMatch(/db\.finalizeClaimRefund\(/);
    expect(recBody).toMatch(/req\.user\?\.role !== 'admin'/);
  });

  it('revert endpoint is mounted with authenticateJWT + requireCurrentAdminSession + role check, and reverts via the guarded DB method', () => {
    expect(recBody).toMatch(/app\.post\('\/api\/admin\/refund-reconciliation\/:claimId\/revert', authenticateJWT, requireCurrentAdminSession, async/);
    expect(recBody).toMatch(/db\.revertClaimRefundLock\(/);
    expect(recBody).toMatch(/req\.user\?\.role !== 'admin'/);
  });

  it('NO reconciliation route can trigger a refund / auto-retry (they only record an already-resolved outcome)', () => {
    expect(recBody).not.toMatch(/triggerIntasendRefund|triggerMpesaStkPush|PaymentService/);
    // Both actions surface an explicit conflict (409) when the target claim is
    // not actually in the refunding state (no silent success / false success).
    expect(recBody).toMatch(/status\(409\)/);
  });
});
