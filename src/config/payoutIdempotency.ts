// PAYOUT LEG IDEMPOTENCY KEY (Phase 1 — payout readiness remediation)
//
// WHY THIS IS A CONFIG MODULE
// ---------------------------
// The key is part of the LOCAL CONTRACT between a ledger row and a provider
// submission. Three places must agree about it:
//   * `src/services/payments.ts`  — builds it for every submitted transaction;
//   * `src/config/payoutRepairPolicy.ts` — checks that externally imported
//     refusal evidence names THIS key (F7);
//   * tests and the dry-run review — explain which key a repair would re-use.
//
// It is therefore a pure function of the leg's stable local identity, with no
// provider call and no clock:
//
//   `PAYOUT_LEG_<ROLE>:<claimId>`   (role = FINDER | AGENT)
//
// The provider documentation quoted in payments.ts says a repeat request with
// the same key is rejected. What it does NOT establish — locally, today — is
// whether a REFUSED attempt consumes the key. That question is unresolved (F7)
// and is why repair eligibility requires explicit evidence of the key's
// disposition; nothing here assumes either answer.

/** The recipient roles the provider payload is keyed by. */
export type PayoutRecipientRole = 'finder' | 'agent';

/**
 * The provider idempotency key for one payout leg.
 *
 * Deterministic, distinct per role, PII-free (claim id + role only).
 * A blank claim id yields `PAYOUT_LEG_<ROLE>:`; that cannot occur for a real
 * settlement (the claim row must exist before a payout is built), and the
 * provider answers a duplicate key with a refusal, which fails closed.
 */
export function buildPayoutLegIdempotencyKey(
  claimId: string,
  recipientType: PayoutRecipientRole,
): string {
  return `PAYOUT_LEG_${recipientType.toUpperCase()}:${String(claimId ?? '').trim()}`;
}

/**
 * The same key, derived from a ledger row's `type`.
 *
 * `ledger.type` is `finder_payout` / `agent_payout`, while the provider payload
 * uses `finder` / `agent`. The mapping lives here so the policy can compare
 * imported evidence with the key the submission path would actually send,
 * without importing the provider service (which would make a pure module
 * depend on network configuration).
 *
 * Returns null for a row that is not a payout leg — the policy blocks those for
 * a different, earlier reason, and a null here must never be treated as a key.
 */
export function payoutLegIdempotencyKeyForEntryType(
  claimId: string | null | undefined,
  entryType: string | null | undefined,
): string | null {
  const role: PayoutRecipientRole | null =
    entryType === 'finder_payout' ? 'finder' : entryType === 'agent_payout' ? 'agent' : null;
  if (!role || !claimId) return null;
  return buildPayoutLegIdempotencyKey(String(claimId), role);
}
