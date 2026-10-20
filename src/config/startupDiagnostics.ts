// =============================================================================
// PHASE 4 — TRUTHFUL STARTUP AND COLLECTION-FAILURE DIAGNOSTICS
// =============================================================================
// The boot banner used to print `[OK] Configured` for a wallet outside
// production (where the value is neither sent nor enforced) and masked nothing.
// The collection failure path called every HTTP failure a "Sandbox API error",
// even in production.
//
// These helpers are PURE and return one truthful line each. They never expose a
// secret, a full phone number or a full wallet ID: a wallet is shown as its last
// four characters only (`***1234`), and only when it is long enough for that to
// be non-identifying.
// =============================================================================

import {
  isConfiguredWalletId,
  readWalletId,
  type PayoutWalletRouting,
} from './walletRouting';

/** The last four characters only, or `(none)` / `***` for unusable values. */
export function maskWalletIdForStartup(raw: string | null | undefined): string {
  const id = readWalletId(raw);
  if (id === null) return '(none)';
  if (id.length < 8) return '***';
  return `***${id.slice(-4)}`;
}

/** The observed NODE_ENV, stated exactly, including the unset case. */
export function describeNodeEnvForStartup(env: Record<string, string | undefined>): string {
  const raw = env?.NODE_ENV;
  if (raw === undefined || raw === null || String(raw).trim() === '') return '(unset)';
  return `"${String(raw)}"`;
}

export function isProductionStartup(env: Record<string, string | undefined>): boolean {
  return env?.NODE_ENV === 'production';
}

/**
 * The disbursement (debited) wallet. Configuration and ENFORCEMENT are separate
 * facts and are stated separately.
 */
export function describeDisbursementWalletForStartup(
  env: Record<string, string | undefined>,
): string {
  const production = isProductionStartup(env);
  const raw = env?.INTASEND_DISBURSEMENT_WALLET_ID;
  const configured = isConfiguredWalletId(raw);
  const masked = maskWalletIdForStartup(raw);

  if (production) {
    return configured
      ? `[SET] Configured (${masked}) — ENFORCED: production payouts require this working wallet`
      : `[MISSING] Not configured or placeholder-shaped — production payouts will refuse to start`;
  }
  return configured
    ? `[INFO] Declared (${masked}) — NOT enforced outside NODE_ENV=production; no wallet ID is sent to a sandbox provider`
    : `[INFO] Not configured — not required outside NODE_ENV=production`;
}

/** The optional settlement-wallet DECLARATION (identity only; routes nothing). */
export function describeSettlementWalletForStartup(
  env: Record<string, string | undefined>,
): string {
  const raw = env?.INTASEND_SETTLEMENT_WALLET_ID;
  const declared = isConfiguredWalletId(raw);
  return declared
    ? `[DECLARED] ${maskWalletIdForStartup(raw)} — used only to check that payouts do not debit the collection wallet`
    : `[UNDECLARED] no settlement-wallet identity supplied — the payout wallet cannot be compared with the collection wallet`;
}

/**
 * PHASE 5 — the optional collection-wallet SELECTOR. It is off by default and
 * only ever sent in production; this line says which of those is true rather
 * than reporting a bare "configured".
 */
export function describeCollectionWalletForStartup(
  env: Record<string, string | undefined>,
): string {
  const production = isProductionStartup(env);
  const raw = env?.INTASEND_COLLECTION_WALLET_ID;
  const configured = isConfiguredWalletId(raw);
  const supplied = readWalletId(raw) !== null;
  const masked = maskWalletIdForStartup(raw);

  if (production) {
    if (configured) {
      return `[SET] Configured (${masked}) — ENFORCED: production STK requests append wallet_id (provider support must be confirmed by the account owner)`;
    }
    if (supplied) {
      return '[INVALID] Placeholder-shaped — production STK requests will REFUSE until this is removed, left blank, or replaced with a real wallet ID';
    }
    return '[DEFAULT] Not configured — production STK requests omit wallet_id and IntaSend uses the account default settlement wallet';
  }

  return configured
    ? `[INFO] Declared (${masked}) — NOT sent outside NODE_ENV=production; no wallet ID reaches a sandbox/test provider`
    : `[INFO] Not configured — optional outside NODE_ENV=production; the four-field STK body is unchanged`;
}

/**
 * The routing-guard state. This is the fact an operator needs: is the equality
 * guard actually enforced for this environment?
 */
export function describeWalletRoutingGuardForStartup(
  routing: PayoutWalletRouting,
  env: Record<string, string | undefined>,
): string {
  if (!routing?.production) {
    return `[NOT ENFORCED] NODE_ENV=${describeNodeEnvForStartup(env)} — routing is enforced only in production`;
  }
  switch (routing.code) {
    case 'ready':
      return '[ENFORCED] production routing is ready (payout wallet configured and distinct from the declared settlement wallet)';
    case 'payout_wallet_missing':
      return '[ENFORCED] production routing REFUSES payouts: the disbursement wallet is missing or placeholder-shaped';
    case 'payout_wallet_is_settlement_wallet':
      return '[ENFORCED] production routing REFUSES payouts: the payout wallet equals the declared settlement wallet';
    default:
      return `[ENFORCED] production routing state: ${String(routing?.code ?? 'unknown')}`;
  }
}

/**
 * A collection HTTP failure, named against the environment it actually ran in.
 * `baseUrl` is reduced to its host; no secret, header or query is included.
 */
export function describeCollectionGatewayFailure(
  env: Record<string, string | undefined>,
  status: number,
  baseUrl?: string | null,
): string {
  const production = isProductionStartup(env);
  const environmentLabel = production
    ? 'PRODUCTION'
    : env?.NODE_ENV === 'development' || env?.NODE_ENV === 'test'
      ? 'sandbox/test'
      : `UNRECOGNISED (NODE_ENV=${describeNodeEnvForStartup(env)})`;
  let host = '(unknown endpoint)';
  if (typeof baseUrl === 'string' && baseUrl.trim() !== '') {
    try {
      host = new URL(baseUrl).host;
    } catch {
      host = '(unparseable endpoint)';
    }
  }
  return (
    `[INTASEND GATEWAY] Collection request failed (HTTP ${status}) against the ${environmentLabel} endpoint ${host}. ` +
    `NODE_ENV=${describeNodeEnvForStartup(env)}. No payment was collected by this request.`
  );
}
