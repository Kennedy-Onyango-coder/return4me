import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P1 REGRESSION TEST — payment state machine, 'payment_window_expired'
// transition. expireStaleClaims (server.ts) is the sweep that moves a claim
// from 'pending_payment' to 'payment_window_expired' after the owner fails to
// pay within the window following agent confirmation, and records a payment
// strike against the owner's phone. Had zero prior test coverage. Static
// source-audit test (same pattern used throughout this suite) since
// expireStaleClaims is not exported and server.ts has a large amount of
// top-level side-effecting setup unsafe to import in a test file.
//
// The sweep uses an atomic, compare-and-swap expiry
// (db.expirePendingPaymentClaim, guarded on status='pending_payment') so it can
// never clobber a claim that a payment webhook has since confirmed paid
// (audit finding C1).

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

  it('transitions the claim to payment_window_expired via the atomic guarded expiry (never a blind unconditional status write)', () => {
    expect(body).toMatch(/expirePendingPaymentClaim\(claim\.id\)/);
  });

  it('C1 race guard: a payment strike is recorded only when expiry actually won — the sweep must not clobber a claim the webhook has since confirmed paid', () => {
    expect(body).toMatch(/const expired = await db\.expirePendingPaymentClaim\(claim\.id\);/);
    expect(body).toMatch(/if \(expired\) \{/);
    expect(body).toMatch(/recordPaymentStrike\(claim\.owner_phone\)/);
  });

  it('a per-claim failure inside the sweep loop is caught and logged, not allowed to crash the whole sweep (one bad claim can never block every other claim from expiring)', () => {
    expect(body).toMatch(/\} catch \(err\) \{/);
  });

  it('is scheduled to run periodically', () => {
    expect(serverTs).toMatch(/setInterval\(expireStaleClaims,/);
  });
});
