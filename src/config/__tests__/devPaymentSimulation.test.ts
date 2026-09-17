import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  resolveDevPaymentSimulationEnabled,
  DEV_SIMULATION_ENVS,
} from '../devPaymentSimulation';

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
});
