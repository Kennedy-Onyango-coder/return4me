// =============================================================================
// BATCH 2 — WALLET ROUTING: WHICH WALLET COLLECTS, WHICH WALLET PAYS.
// =============================================================================
//
// WHAT THIS MODULE IS
//   The single, testable statement of the platform's wallet routing, and the
//   fail-closed rule that stops a payout from being debited against the wallet
//   that receives collections.
//
// THE COLLECTION SIDE (A) — OPTIONAL, DEFAULT-OFF, PRODUCTION-ONLY
//   The collection request built in services/payments.ts is
//   POST {base}/payment/mpesa-stk-push/. Its default body has exactly four
//   fields: public_key, phone_number, amount and api_ref. It carries NO wallet
//   selector unless the operator explicitly configures one.
//
//   PHASE 5 adds one optional selector: INTASEND_COLLECTION_WALLET_ID. When it
//   is a real (non-blank, non-placeholder-shaped) ID AND NODE_ENV is exactly
//   'production', the request gains a fifth field, wallet_id. In every other
//   configuration the request is byte-for-byte the original four-field body:
//     * unset / blank in production      -> provider default settlement wallet;
//     * set outside production            -> never sent to a sandbox/test provider;
//     * placeholder-shaped in production  -> REFUSED before any provider call,
//       so a copied .env.example can never silently fall back to the default.
//
//   PROVIDER SUPPORT IS NOT VERIFIED BY THIS REPOSITORY. The wallet_id selector
//   on the STK endpoint is enabled only for an account whose owner has confirmed
//   IntaSend accepts it. The code cannot verify that remotely, and these docs do
//   not claim it. Leaving the variable unset is the safe, backward-compatible
//   default.
//
// THE PAYOUT SIDE (B/F) — THE ONE RULE THIS MODULE ENFORCES
//   A payout batch debits the wallet named by INTASEND_DISBURSEMENT_WALLET_ID
//   (documented `wallet_id` field of POST /send-money/initiate/). Every payout
//   gate already fails closed when that value is missing, blank or
//   placeholder-shaped. This module adds the configuration fact the old gate
//   could not see: if the operator ALSO declares the settlement wallet's
//   identity (INTASEND_SETTLEMENT_WALLET_ID, optional, identity-only), then the
//   two IDs must differ. A deployment whose payout wallet IS the collection
//   wallet is refused before any provider request — because that configuration
//   re-creates the provider default the dedicated working wallet exists to
//   avoid, mixing collected funds with payout float and destroying the ability
//   to reconcile either.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//   * It moves no money. There is no transfer, sweep, balance read or wallet
//     list call here or anywhere else in src/: moving collected funds from the
//     settlement wallet into the working wallet remains the provider-side,
//     operator-run procedure in docs/operations.md. A second money path inside
//     the application would be a new, unaudited route to the same funds.
//   * It never reads a wallet balance, so a settlement balance can never be
//     mistaken for available working-wallet float by this code.
//   * It does not verify that a wallet exists, is KES-denominated, or has
//     can_disburse enabled. Those are provider-side properties, checked by the
//     provider at request time.
//   * It does not enforce anything outside NODE_ENV=production. Non-production
//     never sends a configured wallet ID to the sandbox/test provider, so there
//     is no routing decision to protect there; the states are still reported so
//     an operator can see them.
//
// COMPARISON SEMANTICS
//   Wallet IDs are opaque provider identifiers. They are compared after trimming
//   outer whitespace and BYTE FOR BYTE otherwise: no case folding, no internal
//   whitespace collapsing, no normalisation. "KES-WALLET-1" and "kes-wallet-1"
//   are different IDs, and treating them as equal would be a guess.
//
// NO SECRETS, NO PII
//   Wallet IDs are operator configuration, not customer data, but they are still
//   rendered masked (see maskWalletId) in every log, audit row and refusal
//   message produced from this module. The raw value is used only for
//   comparison and for the provider request itself.

// WHY THE PLACEHOLDER RULE IS DUPLICATED HERE (and not imported from
// services/payments.ts): that module sits in a real import cycle
// (payments -> db/database -> paymentStrikePolicy -> services/auth -> payments)
// and calls its own copy during module evaluation, so the predicate it uses must
// stay self-contained. Importing it back would create a second cycle, and the
// same constraint already justifies the duplicated phone masker there. The two
// implementations are pinned to the same answers by
// payoutInitiationContract.test.ts.
function isPlaceholderValue(key: string | null | undefined): boolean {
  if (!key || key.trim() === '') return true;
  const normalized = key.trim().toLowerCase();
  return (
    normalized.includes('replace_with') ||
    normalized.includes('placeholder') ||
    normalized.includes('your_key') ||
    normalized.includes('your-key') ||
    normalized.includes('changeme') ||
    normalized.includes('change_me') ||
    normalized === 'xxx' ||
    normalized === 'todo' ||
    normalized === 'tbd'
  );
}

/** The production payout wallet (the wallet payouts are debited FROM). */
export const DISBURSEMENT_WALLET_ENV_KEY = 'INTASEND_DISBURSEMENT_WALLET_ID';
/** The optional, identity-only declaration of the collection wallet. */
export const SETTLEMENT_WALLET_ENV_KEY = 'INTASEND_SETTLEMENT_WALLET_ID';
/**
 * PHASE 5 — optional selector for the wallet a collection is requested to
 * settle into. Default-off; used only in production and only when valid.
 */
export const COLLECTION_WALLET_ENV_KEY = 'INTASEND_COLLECTION_WALLET_ID';

/**
 * Trimmed wallet ID, or null when absent/blank. Never returns a
 * whitespace-only string: a blank value is "not set", not an ID.
 */
export function readWalletId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * True only for a present, non-blank, non-placeholder-shaped wallet ID.
 * This is the SAME placeholder convention the payment gates use — it is not a
 * wallet-specific rule.
 */
export function isConfiguredWalletId(raw: string | null | undefined): boolean {
  const id = readWalletId(raw);
  return id !== null && !isPlaceholderValue(id);
}

/**
 * The wallet ID rendered for a log, an audit row or an error message.
 *
 * WHY THIS IS NOT maskPayoutDestinationForLog(): that helper is tuned for a
 * 9–12 character phone number and keeps everything except the last six
 * characters — applied to a 36-character wallet UUID it would disclose 30 of the
 * 36 characters. A wallet ID is an opaque provider identifier, not a phone
 * number, so it is masked on its own terms: at most four leading and four
 * trailing characters, and nothing at all for a short value. An absent value is
 * rendered '(none)'.
 */
export function maskWalletId(raw: string | null | undefined): string {
  const id = readWalletId(raw);
  if (id === null) return '(none)';
  if (id.length < 12) return '***';
  return `${id.slice(0, 4)}***${id.slice(-4)}`;
}

/** How the settlement-wallet identity was supplied. */
export type SettlementWalletState = 'declared' | 'undeclared';

/** Why the payout wallet routing is (or is not) usable. */
export type PayoutWalletRoutingCode =
  /** Production, payout wallet configured and distinct from a declared settlement wallet. */
  | 'ready'
  /** Not production: no configured wallet is sent to the provider, nothing to enforce. */
  | 'not_required'
  /** Production, and the payout wallet is absent, blank or placeholder-shaped. */
  | 'payout_wallet_missing'
  /** Production, and the payout wallet is the declared collection/settlement wallet. */
  | 'payout_wallet_is_settlement_wallet';

export interface PayoutWalletRouting {
  /** False ONLY in production, and only when a payout must not be attempted. */
  ok: boolean;
  code: PayoutWalletRoutingCode;
  /** True only for NODE_ENV exactly 'production' — the same test the gates use. */
  production: boolean;
  /** Trimmed payout wallet ID as supplied (may be placeholder-shaped). */
  payoutWalletId: string | null;
  /** Trimmed settlement wallet ID as supplied (may be placeholder-shaped). */
  settlementWalletId: string | null;
  payoutWalletState: 'configured' | 'not_configured';
  settlementWalletState: SettlementWalletState;
  /** Operator-facing explanation. Contains no unmasked wallet ID. */
  message: string;
}

export interface WalletRoutingInput {
  nodeEnv?: string | null;
  payoutWalletId?: string | null;
  settlementWalletId?: string | null;
}

const PAYOUT_WALLET_MISSING_MESSAGE =
  'INTASEND_DISBURSEMENT_WALLET_ID is not configured in production. ' +
  'Configure a non-blank, non-placeholder working-wallet ID before initiating payouts (IntaSend requires it to be ' +
  'KES-denominated with can_disburse enabled; that is enforced by the provider, not checked here).';

const PAYOUT_WALLET_IS_SETTLEMENT_MESSAGE =
  'INTASEND_DISBURSEMENT_WALLET_ID names the same wallet as INTASEND_SETTLEMENT_WALLET_ID. ' +
  'Payouts must debit the dedicated working wallet, never the wallet that receives collections: ' +
  'configure two distinct wallet IDs before initiating payouts.';

/**
 * Resolve the payout wallet routing for ONE observable configuration.
 *
 * Pure: every input is a parameter, nothing is read from process.env here (use
 * resolveConfiguredPayoutWalletRouting for the live environment). That is what
 * makes the whole matrix — missing, placeholder, equal, different, non-production
 * — assertable in a unit test.
 *
 * ORDER MATTERS and mirrors the established gate:
 *   1. not production                        -> 'not_required' (ok, nothing is sent)
 *   2. payout wallet unusable                -> 'payout_wallet_missing' (refuse)
 *   3. declared settlement wallet equals it  -> refusal (refuse)
 *   4. otherwise                             -> 'ready'
 */
export function resolvePayoutWalletRouting(input: WalletRoutingInput): PayoutWalletRouting {
  const production = input?.nodeEnv === 'production';
  const payoutWalletId = readWalletId(input?.payoutWalletId);
  const settlementWalletId = readWalletId(input?.settlementWalletId);
  const payoutConfigured = isConfiguredWalletId(payoutWalletId);
  const settlementDeclared = isConfiguredWalletId(settlementWalletId);

  const base = {
    production,
    payoutWalletId,
    settlementWalletId,
    payoutWalletState: payoutConfigured ? ('configured' as const) : ('not_configured' as const),
    settlementWalletState: settlementDeclared ? ('declared' as const) : ('undeclared' as const),
  };

  if (!production) {
    return {
      ...base,
      ok: true,
      code: 'not_required',
      message:
        'Wallet routing is not enforced outside NODE_ENV=production: a configured wallet ID is never sent to the ' +
        'sandbox/test provider, so no payout routing decision is made there.',
    };
  }

  if (!payoutConfigured) {
    return { ...base, ok: false, code: 'payout_wallet_missing', message: PAYOUT_WALLET_MISSING_MESSAGE };
  }

  if (settlementDeclared && payoutWalletId === settlementWalletId) {
    return {
      ...base,
      ok: false,
      code: 'payout_wallet_is_settlement_wallet',
      message: PAYOUT_WALLET_IS_SETTLEMENT_MESSAGE,
    };
  }

  return {
    ...base,
    ok: true,
    code: 'ready',
    message:
      'Payouts debit the configured working wallet. Collection routing is a separate, optional selector ' +
      '(INTASEND_COLLECTION_WALLET_ID), and the wallet identity is checked only as far as ' +
      'INTASEND_SETTLEMENT_WALLET_ID is declared.',
  };
}

/**
 * Resolve the routing from the live process environment (or an explicit env
 * object, for tests). This is the function every money seam calls, so the gates
 * cannot diverge.
 */
export function resolveConfiguredPayoutWalletRouting(
  env: Record<string, string | undefined> = process.env,
): PayoutWalletRouting {
  return resolvePayoutWalletRouting({
    nodeEnv: env.NODE_ENV,
    payoutWalletId: env[DISBURSEMENT_WALLET_ENV_KEY],
    settlementWalletId: env[SETTLEMENT_WALLET_ENV_KEY],
  });
}

/** How the optional collection-wallet selector was supplied. */
export type CollectionWalletState = 'configured' | 'not_configured' | 'placeholder';

/** Why a collection request will (or will not) carry `wallet_id`. */
export type CollectionWalletRoutingCode =
  /** Production, valid selector: append wallet_id to the STK request. */
  | 'ready'
  /** Not production: never send the selector to a sandbox/test provider. */
  | 'not_required'
  /** Production, unset/blank: omit wallet_id and use the provider default. */
  | 'not_configured'
  /** Production, non-blank but placeholder-shaped: refuse before any request. */
  | 'collection_wallet_placeholder';

export interface CollectionWalletRouting {
  /** False ONLY in production, and only when the supplied value is unusable. */
  ok: boolean;
  code: CollectionWalletRoutingCode;
  /** True only for NODE_ENV exactly 'production' — the same test payouts use. */
  production: boolean;
  /** Trimmed selector as supplied (may be placeholder-shaped). */
  collectionWalletId: string | null;
  collectionWalletState: CollectionWalletState;
  /** Operator-facing explanation. Contains no unmasked wallet ID. */
  message: string;
}

export interface CollectionWalletRoutingInput {
  nodeEnv?: string | null;
  collectionWalletId?: string | null;
}

const COLLECTION_WALLET_PLACEHOLDER_MESSAGE =
  'INTASEND_COLLECTION_WALLET_ID is placeholder-shaped in production. ' +
  'Remove it (or leave it blank) to use the provider default settlement wallet, or set a real wallet ID. ' +
  'Refusing to send an STK request with an unusable selector: falling back silently could settle the collection ' +
  'in a wallet the operator did not choose.';

/**
 * Resolve the optional collection-wallet selector for ONE observable
 * configuration.
 *
 * Pure: every input is a parameter, nothing is read from process.env here (use
 * resolveConfiguredCollectionWalletRouting for the live environment).
 *
 * ORDER MATTERS:
 *   1. not production                       -> 'not_required' (never sent)
 *   2. no value supplied                    -> 'not_configured' (provider default)
 *   3. supplied but placeholder-shaped      -> refusal (ok:false)
 *   4. otherwise                            -> 'ready' (wallet_id is appended)
 */
export function resolveCollectionWalletRouting(
  input: CollectionWalletRoutingInput,
): CollectionWalletRouting {
  const production = input?.nodeEnv === 'production';
  const supplied = readWalletId(input?.collectionWalletId);
  const configured = isConfiguredWalletId(supplied);
  const collectionWalletState: CollectionWalletState =
    configured ? 'configured' : supplied === null ? 'not_configured' : 'placeholder';

  const base = {
    production,
    collectionWalletId: supplied,
    collectionWalletState,
  };

  if (!production) {
    return {
      ...base,
      ok: true,
      code: 'not_required',
      message:
        'Collection wallet selection is not enforced outside NODE_ENV=production: a configured wallet ID is never ' +
        'sent to the sandbox/test provider.',
    };
  }

  if (supplied === null) {
    return {
      ...base,
      ok: true,
      code: 'not_configured',
      message:
        'No collection wallet is configured. The STK request omits wallet_id and IntaSend uses the account default ' +
        'settlement wallet.',
    };
  }

  if (!configured) {
    return {
      ...base,
      ok: false,
      code: 'collection_wallet_placeholder',
      message: COLLECTION_WALLET_PLACEHOLDER_MESSAGE,
    };
  }

  return {
    ...base,
    ok: true,
    code: 'ready',
    message:
      'The STK request will carry wallet_id, requesting settlement into the configured collection wallet. ' +
      'Provider support for this field is verified by the account owner, not by this application.',
  };
}

/**
 * Resolve the selector from the live process environment (or an explicit env
 * object, for tests).
 */
export function resolveConfiguredCollectionWalletRouting(
  env: Record<string, string | undefined> = process.env,
): CollectionWalletRouting {
  return resolveCollectionWalletRouting({
    nodeEnv: env.NODE_ENV,
    collectionWalletId: env[COLLECTION_WALLET_ENV_KEY],
  });
}

/**
 * ONE audit-safe line: masked selector plus the routing verdict. Safe for
 * `audit_log.details`, an operator response and a log aggregator.
 */
export function describeCollectionWalletRoutingForAudit(routing: CollectionWalletRouting): string {
  const wallet =
    routing.collectionWalletState === 'configured'
      ? maskWalletId(routing.collectionWalletId)
      : routing.collectionWalletState;
  return `collection_routing=${routing.code} collection_wallet=${wallet}`;
}

/**
 * ONE audit-safe line: masked wallet identities plus the routing verdict. Safe
 * for `audit_log.details`, an operator response and a log aggregator.
 */
export function describePayoutWalletRoutingForAudit(routing: PayoutWalletRouting): string {
  const settlement =
    routing.settlementWalletState === 'declared' ? maskWalletId(routing.settlementWalletId) : 'undeclared';
  return (
    `routing=${routing.code} payout_wallet=${maskWalletId(routing.payoutWalletId)} ` +
    `settlement_wallet=${settlement}`
  );
}
