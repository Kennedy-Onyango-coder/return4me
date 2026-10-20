import { describe, it, expect } from 'vitest';
import {
  describeCollectionGatewayFailure,
  describeCollectionWalletForStartup,
  describeDisbursementWalletForStartup,
  describeNodeEnvForStartup,
  describeSettlementWalletForStartup,
  describeWalletRoutingGuardForStartup,
  maskWalletIdForStartup,
} from '../startupDiagnostics';
import { resolvePayoutWalletRouting } from '../walletRouting';

// =============================================================================
// PHASE 4 — TRUTHFUL STARTUP / COLLECTION-FAILURE FORMATTING
// =============================================================================

const WALLET = '12345678-ABCD-4EFG-9012-ABCDEF123456';
const SETTLEMENT = '99999999-ZZZZ-4YYY-8111-QQQQQQ654321';

describe('Phase 4 — wallet masking', () => {
  it('keeps only the last four characters of a long wallet ID', () => {
    expect(maskWalletIdForStartup(WALLET)).toBe('***3456');
    expect(maskWalletIdForStartup(WALLET)).not.toContain(WALLET);
    expect(maskWalletIdForStartup(WALLET)).not.toContain('12345678');
  });

  it('shows nothing identifying for an absent or short value', () => {
    expect(maskWalletIdForStartup(null)).toBe('(none)');
    expect(maskWalletIdForStartup('   ')).toBe('(none)');
    expect(maskWalletIdForStartup('ABC123')).toBe('***');
  });
});

describe('Phase 4 — startup states distinguish configuration from enforcement', () => {
  it('states the observed NODE_ENV, including unset', () => {
    expect(describeNodeEnvForStartup({ NODE_ENV: 'production' })).toBe('"production"');
    expect(describeNodeEnvForStartup({})).toBe('(unset)');
  });

  it('production: a configured wallet is SET and ENFORCED; a missing one is a refusal', () => {
    const configured = describeDisbursementWalletForStartup({
      NODE_ENV: 'production',
      INTASEND_DISBURSEMENT_WALLET_ID: WALLET,
    });
    expect(configured).toContain('[SET]');
    expect(configured).toContain('ENFORCED');
    expect(configured).toContain('***3456');
    expect(configured).not.toContain(WALLET);

    const missing = describeDisbursementWalletForStartup({
      NODE_ENV: 'production',
      INTASEND_DISBURSEMENT_WALLET_ID: 'REPLACE_WITH_KES_WORKING_WALLET_ID',
    });
    expect(missing).toContain('[MISSING]');
    expect(missing).toContain('refuse to start');
    expect(missing).not.toContain('[OK]');
  });

  it('outside production a declared wallet is explicitly NOT enforced', () => {
    const line = describeDisbursementWalletForStartup({
      NODE_ENV: 'development',
      INTASEND_DISBURSEMENT_WALLET_ID: WALLET,
    });
    expect(line).toContain('[INFO]');
    expect(line).toContain('NOT enforced');
    expect(line).not.toContain('[OK]');
    expect(line).not.toContain(WALLET);
  });

  it('states whether the settlement wallet is declared, masked', () => {
    expect(
      describeSettlementWalletForStartup({ INTASEND_SETTLEMENT_WALLET_ID: SETTLEMENT }),
    ).toContain('[DECLARED] ***4321');
    expect(describeSettlementWalletForStartup({})).toContain('[UNDECLARED]');
  });

  it('states the routing guard as ENFORCED only in production', () => {
    const devRouting = resolvePayoutWalletRouting({ nodeEnv: 'development' });
    expect(describeWalletRoutingGuardForStartup(devRouting, { NODE_ENV: 'development' })).toContain(
      '[NOT ENFORCED]',
    );

    const prodRouting = resolvePayoutWalletRouting({
      nodeEnv: 'production',
      payoutWalletId: WALLET,
      settlementWalletId: SETTLEMENT,
    });
    expect(
      describeWalletRoutingGuardForStartup(prodRouting, { NODE_ENV: 'production' }),
    ).toContain('[ENFORCED]');

    const equalRouting = resolvePayoutWalletRouting({
      nodeEnv: 'production',
      payoutWalletId: WALLET,
      settlementWalletId: WALLET,
    });
    expect(
      describeWalletRoutingGuardForStartup(equalRouting, { NODE_ENV: 'production' }),
    ).toContain('REFUSES payouts');
  });
});

describe('Phase 4 — collection failures name the real environment', () => {
  it('never calls a production failure a sandbox error', () => {
    const line = describeCollectionGatewayFailure(
      { NODE_ENV: 'production' },
      400,
      'https://api.intasend.com',
    );
    expect(line).toContain('PRODUCTION endpoint api.intasend.com');
    expect(line).not.toContain('Sandbox API error');
    expect(line).toContain('No payment was collected');
  });

  it('names a development/test failure as sandbox/test, not as production', () => {
    const line = describeCollectionGatewayFailure(
      { NODE_ENV: 'development' },
      500,
      'https://sandbox.intasend.com',
    );
    expect(line).toContain('sandbox/test endpoint sandbox.intasend.com');
    expect(line).toContain('NODE_ENV="development"');
  });

  it('names an unrecognised environment instead of guessing', () => {
    const line = describeCollectionGatewayFailure(
      { NODE_ENV: 'staging' },
      502,
      'https://api.intasend.com',
    );
    expect(line).toContain('UNRECOGNISED');
    expect(line).toContain('NODE_ENV="staging"');
  });

  it('does not expose an unparseable base URL or any secret', () => {
    const line = describeCollectionGatewayFailure({ NODE_ENV: 'production' }, 500, 'not a url');
    expect(line).toContain('(unparseable endpoint)');
    expect(line).not.toContain('API_KEY');
  });
});

describe('Phase 5 — the optional collection wallet is reported truthfully', () => {
  it('production + a real selector: SET, ENFORCED, masked, and no full ID', () => {
    const line = describeCollectionWalletForStartup({
      NODE_ENV: 'production',
      INTASEND_COLLECTION_WALLET_ID: WALLET,
    });
    expect(line).toContain('[SET]');
    expect(line).toContain('ENFORCED');
    expect(line).toContain('wallet_id');
    expect(line).toContain('***3456');
    expect(line).not.toContain(WALLET);
    expect(line).not.toContain('[OK]');
  });

  it('production without a selector: DEFAULT, four-field body unchanged', () => {
    for (const value of [undefined, '', '   ']) {
      const line = describeCollectionWalletForStartup({
        NODE_ENV: 'production',
        INTASEND_COLLECTION_WALLET_ID: value,
      });
      expect(line).toContain('[DEFAULT]');
      expect(line).toContain('omit wallet_id');
      expect(line).not.toContain('ENFORCED');
    }
  });

  it('production with a placeholder: INVALID and a refusal, never a silent default', () => {
    const line = describeCollectionWalletForStartup({
      NODE_ENV: 'production',
      INTASEND_COLLECTION_WALLET_ID: 'REPLACE_WITH_KES_COLLECTION_WALLET_ID',
    });
    expect(line).toContain('[INVALID]');
    expect(line).toContain('REFUSE');
    expect(line).not.toContain('[SET]');
    expect(line).not.toContain('[DEFAULT]');
  });

  it('outside production: declared is INFO and explicitly not sent', () => {
    const declared = describeCollectionWalletForStartup({
      NODE_ENV: 'development',
      INTASEND_COLLECTION_WALLET_ID: WALLET,
    });
    expect(declared).toContain('[INFO]');
    expect(declared).toContain('NOT sent');
    expect(declared).toContain('***3456');
    expect(declared).not.toContain(WALLET);

    const absent = describeCollectionWalletForStartup({ NODE_ENV: 'test' });
    expect(absent).toContain('[INFO]');
    expect(absent).toContain('four-field');
    expect(absent).not.toContain('[DEFAULT]');
  });
});
