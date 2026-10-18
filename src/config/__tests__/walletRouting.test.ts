import { describe, it, expect } from 'vitest';
import {
  DISBURSEMENT_WALLET_ENV_KEY,
  SETTLEMENT_WALLET_ENV_KEY,
  readWalletId,
  isConfiguredWalletId,
  maskWalletId,
  resolvePayoutWalletRouting,
  resolveConfiguredPayoutWalletRouting,
  describePayoutWalletRoutingForAudit,
} from '../walletRouting';

// =============================================================================
// BATCH 2 — WALLET ROUTING, EXHAUSTIVELY.
// =============================================================================
// These are the rules the payout path depends on, asserted as ordinary
// functions rather than by reading server.ts. Every refusal below is checked to
// produce ok:false (so a caller cannot mistake it for a usable configuration) and
// a message that names the actual configuration problem.
//
// The rule under test is deliberately narrow: it does NOT claim collections can be
// routed, and it does NOT move money. It answers one question — "may a production
// payout be debited from this wallet?" — and refuses only two configurations:
// a wallet that is not configured at all, and a wallet that IS the declared
// collection wallet.
// =============================================================================

const WORKING = 'b1f4c0de-9a72-4f5c-8e11-2a3d5c7e9f01';
const SETTLEMENT = '7c2e9a10-4d33-4b6f-9a5e-1f0d8c2b4e77';

describe('readWalletId — blank is not an ID', () => {
  it.each([
    ['unset', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['tab/newline-only', '\t\n'],
  ])('returns null for %s', (_label, value) => {
    expect(readWalletId(value as any)).toBeNull();
  });

  it('trims outer whitespace and keeps the rest byte-for-byte', () => {
    expect(readWalletId('  KES-WALLET-1  ')).toBe('KES-WALLET-1');
    // Internal whitespace is preserved: these are opaque provider identifiers,
    // not free text to normalise.
    expect(readWalletId('KES WALLET 1')).toBe('KES WALLET 1');
  });

  it('never turns a non-string into an ID', () => {
    expect(readWalletId(123 as any)).toBeNull();
    expect(readWalletId({} as any)).toBeNull();
  });
});

describe('isConfiguredWalletId — the shared placeholder convention applies', () => {
  it.each([
    ['the .env.example placeholder', 'REPLACE_WITH_KES_WORKING_WALLET_ID'],
    ['padded placeholder', '  REPLACE_WITH_KES_WORKING_WALLET_ID  '],
    ['lowercase replace_with', 'replace_with_a_wallet'],
    ['placeholder', 'placeholder'],
    ['your_key convention', 'PASTE_YOUR_KEY_HERE'],
    ['changeme', 'CHANGEME'],
    ['change_me', 'change_me_wallet'],
    ['xxx', 'xxx'],
    ['todo', 'todo'],
    ['tbd', 'tbd'],
    ['empty', ''],
    ['unset', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isConfiguredWalletId(value as any)).toBe(false);
  });

  it('accepts a realistic wallet ID', () => {
    expect(isConfiguredWalletId(WORKING)).toBe(true);
    expect(isConfiguredWalletId(`  ${WORKING}  `)).toBe(true);
  });
});

describe('maskWalletId — a wallet ID leaves this module masked', () => {
  it('masks a long ID without revealing it in full', () => {
    const masked = maskWalletId(WORKING);
    expect(masked).toMatch(/^.{4}\*\*\*.{4}$/);
    expect(masked).not.toBe(WORKING);
    expect(masked.length).toBeLessThan(WORKING.length);
    // The middle of the identifier never survives.
    expect(masked).not.toContain(WORKING.slice(4, -4));
  });

  it('fully masks a short ID and reports an absent one', () => {
    expect(maskWalletId('KES-1')).toBe('***');
    expect(maskWalletId(undefined)).toBe('(none)');
    expect(maskWalletId('   ')).toBe('(none)');
  });
describe('resolvePayoutWalletRouting — the decision matrix', () => {
  it('enforces nothing outside production, even when the IDs are equal', () => {
    for (const nodeEnv of ['development', 'test', undefined, '', 'staging', 'Production']) {
      const routing = resolvePayoutWalletRouting({
        nodeEnv,
        payoutWalletId: WORKING,
        settlementWalletId: WORKING,
      });
      expect(routing.ok, `nodeEnv=${String(nodeEnv)}`).toBe(true);
      expect(routing.code).toBe('not_required');
      expect(routing.production).toBe(false);
    }
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['the documented placeholder', 'REPLACE_WITH_KES_WORKING_WALLET_ID'],
  ])('refuses a production payout when the working wallet is %s', (_label, value) => {
    const routing = resolvePayoutWalletRouting({
      nodeEnv: 'production',
      payoutWalletId: value as any,
      settlementWalletId: SETTLEMENT,
    });
    expect(routing.ok).toBe(false);
    expect(routing.code).toBe('payout_wallet_missing');
    expect(routing.payoutWalletState).toBe('not_configured');
    expect(routing.message).toContain('INTASEND_DISBURSEMENT_WALLET_ID is not configured in production');
  });

  it('refuses a production payout when the working wallet IS the settlement wallet', () => {
    const routing = resolvePayoutWalletRouting({
      nodeEnv: 'production',
      payoutWalletId: ` ${WORKING} `,
      settlementWalletId: WORKING,
    });
    expect(routing.ok).toBe(false);
    expect(routing.code).toBe('payout_wallet_is_settlement_wallet');
    expect(routing.settlementWalletState).toBe('declared');
    expect(routing.message).toContain('names the same wallet');
    // The refusal names the VARIABLES, never the values.
    expect(routing.message).not.toContain(WORKING);
  });

  it('accepts two distinct, configured wallets in production', () => {
    const routing = resolvePayoutWalletRouting({
      nodeEnv: 'production',
      payoutWalletId: WORKING,
      settlementWalletId: SETTLEMENT,
    });
    expect(routing.ok).toBe(true);
    expect(routing.code).toBe('ready');
    expect(routing.payoutWalletState).toBe('configured');
    expect(routing.settlementWalletState).toBe('declared');
  });

  it('accepts a production payout when the settlement wallet is not declared', () => {
    const routing = resolvePayoutWalletRouting({
      nodeEnv: 'production',
      payoutWalletId: WORKING,
      settlementWalletId: undefined,
    });
    expect(routing.ok).toBe(true);
    expect(routing.code).toBe('ready');
    // Declared "not checked", not "checked and fine".
    expect(routing.settlementWalletState).toBe('undeclared');
  });

  it('treats a placeholder-shaped settlement wallet as undeclared, never as a match', () => {
    const routing = resolvePayoutWalletRouting({
      nodeEnv: 'production',
      payoutWalletId: WORKING,
      settlementWalletId: 'REPLACE_WITH_KES_SETTLEMENT_WALLET_ID',
    });
    expect(routing.ok).toBe(true);
    expect(routing.code).toBe('ready');
    expect(routing.settlementWalletState).toBe('undeclared');
  });

  it('compares case-sensitively (opaque identifiers are not normalised)', () => {
    const routing = resolvePayoutWalletRouting({
      nodeEnv: 'production',
      payoutWalletId: 'KES-WALLET-1',
      settlementWalletId: 'kes-wallet-1',
    });
    // Different IDs as supplied: the collision rule does not fire, because
    // case-folding them would be a guess this module refuses to make.
    expect(routing.code).toBe('ready');
    expect(routing.ok).toBe(true);
  });

  it('reports a missing working wallet BEFORE any collision, so the operator fixes the real problem', () => {
    const routing = resolvePayoutWalletRouting({
      nodeEnv: 'production',
      payoutWalletId: undefined,
      settlementWalletId: undefined,
    });
    expect(routing.code).toBe('payout_wallet_missing');
  });
});

describe('resolveConfiguredPayoutWalletRouting — reads the documented variables', () => {
  it('reads both environment keys and the exact NODE_ENV', () => {
    const routing = resolveConfiguredPayoutWalletRouting({
      [DISBURSEMENT_WALLET_ENV_KEY]: WORKING,
      [SETTLEMENT_WALLET_ENV_KEY]: WORKING,
      NODE_ENV: 'production',
    });
    expect(routing.code).toBe('payout_wallet_is_settlement_wallet');
  });

  it('names the same keys .env.example documents', () => {
    expect(DISBURSEMENT_WALLET_ENV_KEY).toBe('INTASEND_DISBURSEMENT_WALLET_ID');
    expect(SETTLEMENT_WALLET_ENV_KEY).toBe('INTASEND_SETTLEMENT_WALLET_ID');
  });
});

describe('describePayoutWalletRoutingForAudit — audit-safe by construction', () => {
  it('names the verdict and masks both wallets', () => {
    const routing = resolvePayoutWalletRouting({
      nodeEnv: 'production',
      payoutWalletId: WORKING,
      settlementWalletId: SETTLEMENT,
    });
    const line = describePayoutWalletRoutingForAudit(routing);
    expect(line).toContain('routing=ready');
    expect(line).toContain('payout_wallet=');
    expect(line).toContain('settlement_wallet=');
    expect(line).not.toContain(WORKING);
    expect(line).not.toContain(SETTLEMENT);
  });

  it('renders an undeclared settlement wallet as a word, not as an empty mask', () => {
    const routing = resolvePayoutWalletRouting({
      nodeEnv: 'production',
      payoutWalletId: WORKING,
    });
    expect(describePayoutWalletRoutingForAudit(routing)).toContain('settlement_wallet=undeclared');
  });
});

});
