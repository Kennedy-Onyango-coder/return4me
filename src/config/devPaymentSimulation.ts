// THE DEV PAYMENT-SIMULATION GATE (Phase 10, F-4)
// ===============================================
// POST /api/dev/simulate-payment/:claimId fabricates an AUTHORITATIVE payment
// confirmation: it drives the same confirmation path the real M-Pesa webhook uses
// and moves a claim to `escrow_held`, stamping `paid_at` — with no money moving
// at all. Because the effect is indistinguishable from a real payment to every
// downstream reader, the gate in front of it must never be loosened by accident.
//
// It requires ALL THREE of:
//   1. NODE_ENV explicitly 'development' or 'test' — NOT unset, NOT production.
//      An unset NODE_ENV is the classic configuration mistake, so it must not
//      count as "not production".
//   2. ALLOW_MOCK_OTP_BYPASS === 'true'          (the existing dev convenience)
//   3. ENABLE_DEV_PAYMENT_SIMULATION === 'true'  (dedicated, money-specific)
// Condition 3 is deliberately separate from condition 2 so that a NON-money
// convenience switch can never, on its own, expose a money-faking endpoint.
//
// WHY THIS PREDICATE WAS EXTRACTED (Phase 10, F-4)
// The logic previously lived in a private function inside server.ts, which boots
// the whole application on import and therefore cannot be imported by a test —
// so the gate had NO regression coverage at all. The extraction is
// behaviour-preserving: server.ts keeps its `isDevPaymentSimulationEnabled()`
// call sites exactly as they were and simply delegates to this function with the
// same three process.env values. Nothing about payment amounts, escrow,
// webhooks, authorisation or production behaviour changes; only the gate's
// location, so that "under which conditions can this endpoint run?" is testable.
//
// The production boot refusal that pairs with this gate lives in server.ts
// (it throws when NODE_ENV=production and condition 3 is set, rather than merely
// ignoring it) and is asserted in the accompanying test.

/** NODE_ENV values that count as explicitly non-production. */
export const DEV_SIMULATION_ENVS = ['development', 'test'] as const;

/**
 * Whether the money-faking dev payment simulator may run in this configuration.
 *
 * Pure: takes the three values explicitly. Every operand is compared with `===`
 * against a literal, so any absent/undefined/other value fails closed.
 */
export function resolveDevPaymentSimulationEnabled(
  nodeEnv: string | undefined,
  allowMockOtpBypass: string | undefined,
  enableDevPaymentSimulation: string | undefined,
): boolean {
  const isExplicitNonProductionEnv =
    nodeEnv === 'development' || nodeEnv === 'test';

  return (
    isExplicitNonProductionEnv &&
    allowMockOtpBypass === 'true' &&
    enableDevPaymentSimulation === 'true'
  );
}
