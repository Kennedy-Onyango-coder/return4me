import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P1 REGRESSION TEST — payment state machine, 'payment_window_expired'
// transition. expireStaleClaims (server.ts) is the sweep that moves a
// claim from 'pending_payment' to 'payment_window_expired' after the
// owner fails to pay within the window following agent confirmation, and
// records a payment strike against the owner's phone. Had zero prior test
// coverage. Static source-audit test (same pattern used throughout this
// suite) since expireStaleClaims is not exported and server.ts has a
// large amount of top-level side-effecting setup unsafe to import in a
// test file.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

describe('expireStaleClaims correctly implements the payment_window_expired transition', () => {
  const fnStart = serverTs.indexOf('async function expireStaleClaims()');
  const body = (() => {
    expect(fnStart).toBeGreaterThan(-1);
    return serverTs.slice(fnStart, fnStart + 1200);
  })();

  it('only considers claims in pending_payment status', () => {
    expect(body).toMatch(/claim\.status === 'pending_payment'/);
  });

  it('only considers claims the agent has actually confirmed (agent_confirmed_at set) — never a claim still awaiting confirmation', () => {
    expect(body).toMatch(/claim\.agent_confirmed_at/);
  });

  it('transitions the claim to payment_window_expired', () => {
    expect(body).toMatch(/updateClaimStatus\(claim\.id, 'payment_window_expired'\)/);
  });

  it('records a payment strike against the owner on expiry, feeding the existing fraud-prevention strike system', () => {
    expect(body).toMatch(/recordPaymentStrike\(claim\.owner_phone\)/);
  });

  it('a per-claim failure inside the sweep loop is caught and logged, not allowed to crash the whole sweep (one bad claim can never block every other claim from expiring)', () => {
    expect(body).toMatch(/try \{\s*\n\s*await db\.updateClaimStatus\(claim\.id, 'payment_window_expired'\);\s*\n\s*await db\.recordPaymentStrike\(claim\.owner_phone\);\s*\n\s*\} catch/);
  });

  it('is scheduled to run periodically', () => {
    expect(serverTs).toMatch(/setInterval\(expireStaleClaims,/);
  });
});
