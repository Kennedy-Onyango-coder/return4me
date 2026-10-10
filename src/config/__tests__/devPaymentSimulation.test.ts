import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  resolveDevPaymentSimulationEnabled,
  resolveSimulatedAttemptReference,
  DEV_SIMULATION_ENVS,
} from '../devPaymentSimulation';
import {
  isPaymentReconciliationEligible,
  RECONCILABLE_SESSION_STATUSES,
} from '../paymentReconciliation';

// Phase 10 (F-4). POST /api/dev/simulate-payment/:claimId fabricates an
// authoritative payment confirmation — it moves a claim to `escrow_held` and
// stamps paid_at with NO money moving, exactly like the real M-Pesa webhook
// would. The gate in front of it previously had no regression coverage at all,
// because the predicate was private to server.ts (a module that boots the whole
// application on import and cannot be imported by a test). These tests pin the
// gate's behaviour now that it is a pure, importable function.
//
// The point of these assertions is falsification in the dangerous direction: the
// simulator must be OFF in every configuration except the one deliberate
// three-condition development case.

describe('dev payment simulation is enabled ONLY under all three required conditions', () => {
  it('is enabled when NODE_ENV is explicitly development and both flags are true', () => {
    expect(resolveDevPaymentSimulationEnabled('development', 'true', 'true')).toBe(true);
  });

  it('is enabled when NODE_ENV is explicitly test and both flags are true', () => {
    expect(resolveDevPaymentSimulationEnabled('test', 'true', 'true')).toBe(true);
  });

  it('is DISABLED in production even with both flags set', () => {
    // The critical case: a deployment that copies a development .env must never
    // expose a money-faking endpoint.
    expect(resolveDevPaymentSimulationEnabled('production', 'true', 'true')).toBe(false);
  });

  it('is DISABLED when NODE_ENV is unset, even with both flags set', () => {
    // An unset NODE_ENV is the classic configuration mistake and must not be
    // treated as "not production".
    expect(resolveDevPaymentSimulationEnabled(undefined, 'true', 'true')).toBe(false);
    expect(resolveDevPaymentSimulationEnabled('', 'true', 'true')).toBe(false);
  });

  it('is DISABLED for any other NODE_ENV value', () => {
    for (const env of ['staging', 'prod', 'Development', 'TEST', 'dev', 'local']) {
      expect(resolveDevPaymentSimulationEnabled(env, 'true', 'true'), `NODE_ENV=${env}`).toBe(false);
    }
  });

  it('is DISABLED unless the money-specific flag is exactly "true"', () => {
    for (const value of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true ']) {
      expect(
        resolveDevPaymentSimulationEnabled('development', 'true', value as string | undefined),
        `ENABLE_DEV_PAYMENT_SIMULATION=${JSON.stringify(value)}`,
      ).toBe(false);
    }
  });

  it('is DISABLED unless ALLOW_MOCK_OTP_BYPASS is exactly "true"', () => {
    // The OTP bypass is a NON-money convenience switch; it must not be able to
    // enable a money-faking endpoint on its own, and it is equally required.
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      expect(
        resolveDevPaymentSimulationEnabled('development', value as string | undefined, 'true'),
        `ALLOW_MOCK_OTP_BYPASS=${JSON.stringify(value)}`,
      ).toBe(false);
    }
  });

  it('requires all three conditions together (exhaustive over the boolean cube)', () => {
    // 2 env states x 2 x 2 = every combination, so no pair of flags can
    // accidentally suffice.
    const envs: Array<string | undefined> = ['development', 'production'];
    const flags: Array<string | undefined> = ['true', 'false'];

    for (const env of envs) {
      for (const otp of flags) {
        for (const sim of flags) {
          const expected = env === 'development' && otp === 'true' && sim === 'true';
          expect(
            resolveDevPaymentSimulationEnabled(env, otp, sim),
            `env=${env} otp=${otp} sim=${sim}`,
          ).toBe(expected);
        }
      }
    }
  });

  it('treats only development and test as explicit non-production environments', () => {
    expect([...DEV_SIMULATION_ENVS]).toEqual(['development', 'test']);
  });
});

describe('the server actually uses the extracted gate and keeps its production refusal', () => {
  // This test file lives at src/config/__tests__/, so src/server.ts is two
  // levels up (and .env.example is three).
  const serverTs = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');

  it('delegates to the shared predicate with the three environment values', () => {
    const start = serverTs.indexOf('function isDevPaymentSimulationEnabled(');
    expect(start, 'the wrapper must still exist for existing call sites').toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 700);
    expect(body).toContain('resolveDevPaymentSimulationEnabled(');
    expect(body).toContain('process.env.NODE_ENV');
    expect(body).toContain('process.env.ALLOW_MOCK_OTP_BYPASS');
    expect(body).toContain('process.env.ENABLE_DEV_PAYMENT_SIMULATION');
  });

  it('still refuses to boot in production when the money-simulation flag is set', () => {
    // The gate is backed by a loud boot failure, not just a silent ignore.
    expect(serverTs).toContain("if (process.env.ENABLE_DEV_PAYMENT_SIMULATION === 'true')");
    const idx = serverTs.indexOf("if (process.env.ENABLE_DEV_PAYMENT_SIMULATION === 'true')");
    expect(serverTs.slice(idx, idx + 200)).toMatch(/throw new Error\(/);
  });

  it('never weakens the gate to a single condition', () => {
    // A regression that dropped either companion condition would show up here.
    const start = serverTs.indexOf('function isDevPaymentSimulationEnabled(');
    const body = serverTs.slice(start, start + 700);
    expect(body).not.toMatch(/\|\|\s*process\.env\.ENABLE_DEV_PAYMENT_SIMULATION/);
    expect(body).not.toMatch(/return\s+process\.env\.ENABLE_DEV_PAYMENT_SIMULATION/);
  });

  it('documents ENABLE_DEV_PAYMENT_SIMULATION in .env.example as development-only', () => {
    const envExample = fs.readFileSync(path.resolve(__dirname, '../../../.env.example'), 'utf8');
    expect(envExample).toMatch(/^ENABLE_DEV_PAYMENT_SIMULATION="false"/m);
  });

  // D-2A-H — the endpoint must confirm an attempt that EXISTS, and must be
  // gated before it reads or writes anything.
  it('confirms the claim\'s OWN persisted attempt, never a fabricated reference', () => {
    const start = serverTs.indexOf("app.post('/api/dev/simulate-payment/:claimId'");
    expect(start, 'the dev simulation endpoint must still exist').toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 4000);

    // The fabricated reference is gone: it matched no session and no receipt
    // row, so it could complete nothing while moving the claim.
    expect(serverTs).not.toContain('`TEST-SIMULATED-${Date.now()}`');

    // The attempt is resolved from THIS claim's persisted sessions...
    expect(body).toContain('await db.listPaymentSessionsForClaim(claim.id)');
    expect(body).toContain('resolveSimulatedAttemptReference(');
    // ...and the canonical confirmation is handed that attempt's own invoice AND
    // its authoritative amount (never request input).
    expect(body).toContain('processClaimPaymentConfirmed(claim.id, attempt.invoiceId, attempt.amount)');
    // A claim with no confirmable attempt is refused before anything is written.
    expect(body).toMatch(/if \(!attempt\) \{[\s\S]{0,260}status\(409\)/);
  });

  it('decides the gate BEFORE it reads a claim or writes anything', () => {
    const start = serverTs.indexOf("app.post('/api/dev/simulate-payment/:claimId'");
    const body = serverTs.slice(start, start + 1200);
    const gate = body.indexOf('if (!isDevPaymentSimulationEnabled())');
    const refused = body.indexOf('res.status(404)');
    const firstRead = body.indexOf('await db.getClaim(');

    expect(gate).toBeGreaterThan(-1);
    expect(refused).toBeGreaterThan(gate);
    // Production is decided by the gate alone: nothing is read, listed or
    // written when it does not say yes.
    expect(firstRead).toBeGreaterThan(refused);
  });
});

// -----------------------------------------------------------------------------
// D-2A-H — WHICH ATTEMPT A SIMULATED CONFIRMATION MAY STAND FOR.
// -----------------------------------------------------------------------------
// The endpoint used to confirm under a fabricated `TEST-SIMULATED-<now>`
// reference, which matched no attempt, no session and no provider record: the
// claim moved, a reference that never existed was stamped onto it, and the
// attempt's real receipt row stayed unresolved forever. These assertions are
// falsification in the dangerous direction — the simulation must only ever
// stand for ONE of THIS claim's persisted, confirmable attempts, and must stand
// for nothing at all when it cannot identify one.

const SELECTED_CLAIM = { claimId: 'TEST-CLAIM-SEL', claimStatus: 'pending_payment', paidAt: null };

/** A persisted attempt row, as db.listPaymentSessionsForClaim returns it. */
const attempt = (over: Record<string, unknown> = {}) => ({
  id: 'PS-SEL-1',
  claim_id: SELECTED_CLAIM.claimId,
  status: 'pending',
  provider_invoice_id: 'INV-SEL-1',
  amount: 500,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

describe('D-2A-H — a simulated confirmation may only stand for a confirmable existing attempt', () => {
  it('selects the attempt own persisted provider invoice, never a fabricated one', () => {
    const ref = resolveSimulatedAttemptReference([attempt()], SELECTED_CLAIM);

    // The invoice is the SESSION'S, which is the same value the attempt's
    // receipt row is stamped with — so exactly that row can be resolved by the
    // confirmation, and no other row can be touched by it.
    expect(ref).toEqual({
      sessionId: 'PS-SEL-1',
      invoiceId: 'INV-SEL-1',
      amount: 500,
      sessionStatus: 'pending',
    });
    expect(ref!.invoiceId).not.toMatch(/TEST-SIMULATED/);
  });

  it('prefers the NEWEST attempt, so a superseded attempt is not the one simulated', () => {
    const older = attempt({
      id: 'PS-SEL-OLD',
      status: 'expired',
      provider_invoice_id: 'INV-OLD',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = attempt({
      id: 'PS-SEL-NEW',
      provider_invoice_id: 'INV-NEW',
      created_at: new Date('2026-01-01T00:00:01.000Z'),
    });

    expect(resolveSimulatedAttemptReference([newer, older], SELECTED_CLAIM)!.invoiceId).toBe('INV-NEW');
    // Independent of the order the rows arrive in.
    expect(resolveSimulatedAttemptReference([older, newer], SELECTED_CLAIM)!.invoiceId).toBe('INV-NEW');
  });

  it('is deterministic when two attempts share a timestamp', () => {
    const a = attempt({ id: 'PS-SEL-A', provider_invoice_id: 'INV-A' });
    const b = attempt({ id: 'PS-SEL-B', provider_invoice_id: 'INV-B' });

    const first = resolveSimulatedAttemptReference([a, b], SELECTED_CLAIM)!.invoiceId;
    const second = resolveSimulatedAttemptReference([b, a], SELECTED_CLAIM)!.invoiceId;

    expect(first).toBe(second);
    expect(first).toBe('INV-B');
  });

  it('refuses a session carrying no provider invoice — there is nothing to correlate', () => {
    for (const invoice of [null, undefined, '', '   ']) {
      expect(
        resolveSimulatedAttemptReference([attempt({ provider_invoice_id: invoice })], SELECTED_CLAIM),
        `provider_invoice_id=${JSON.stringify(invoice)}`,
      ).toBeNull();
    }
  });

  it('refuses every session state that production recovery would not confirm', () => {
    for (const status of ['created', 'payment_initiated', 'failed', 'cancelled', 'refunded']) {
      expect(resolveSimulatedAttemptReference([attempt({ status })], SELECTED_CLAIM), status).toBeNull();
    }
  });

  it('accepts exactly the session states production recovery accepts (cannot drift)', () => {
    for (const status of RECONCILABLE_SESSION_STATUSES) {
      expect(resolveSimulatedAttemptReference([attempt({ status })], SELECTED_CLAIM), status).not.toBeNull();
    }

    // Both directions, over a superset of the states that exist.
    for (const status of [
      'created', 'payment_initiated', 'pending', 'expired', 'confirmed',
      'failed', 'cancelled', 'refunded',
    ]) {
      const selected = resolveSimulatedAttemptReference([attempt({ status })], SELECTED_CLAIM) !== null;
      const eligible = isPaymentReconciliationEligible({
        claimStatus: SELECTED_CLAIM.claimStatus,
        paidAt: SELECTED_CLAIM.paidAt,
        sessionStatus: status,
        hasProviderInvoice: true,
      });
      expect(selected, status).toBe(eligible);
    }
  });

  it('never selects a session belonging to another claim', () => {
    const foreign = attempt({
      id: 'PS-SEL-FOREIGN',
      claim_id: 'TEST-CLAIM-OTHER',
      provider_invoice_id: 'INV-FOREIGN',
    });

    expect(resolveSimulatedAttemptReference([foreign], SELECTED_CLAIM)).toBeNull();
  });

  it('refuses once the claim can no longer be reconciled', () => {
    expect(
      resolveSimulatedAttemptReference([attempt()], { ...SELECTED_CLAIM, paidAt: new Date() }),
    ).toBeNull();

    for (const claimStatus of ['escrow_held', 'released', 'refunded', 'rejected']) {
      expect(
        resolveSimulatedAttemptReference([attempt()], { ...SELECTED_CLAIM, claimStatus }),
        claimStatus,
      ).toBeNull();
    }
  });

  it('refuses when the claim has no attempt at all', () => {
    expect(resolveSimulatedAttemptReference([], SELECTED_CLAIM)).toBeNull();
    expect(resolveSimulatedAttemptReference(null, SELECTED_CLAIM)).toBeNull();
    expect(resolveSimulatedAttemptReference(undefined, SELECTED_CLAIM)).toBeNull();
  });

  it('carries the session own authoritative amount, the only amount the control may use', () => {
    expect(resolveSimulatedAttemptReference([attempt({ amount: 1250 })], SELECTED_CLAIM)!.amount).toBe(1250);
    // An amount-less session is reported as-is rather than invented: the
    // canonical path's amount reconciliation then fails closed on it.
    expect(resolveSimulatedAttemptReference([attempt({ amount: null })], SELECTED_CLAIM)!.amount).toBeNull();
  });
});
