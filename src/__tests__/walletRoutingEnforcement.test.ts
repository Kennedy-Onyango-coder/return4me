import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// BATCH 2 — WALLET ROUTING IS ENFORCED WHERE IT MATTERS, AND NOWHERE ELSE.
// =============================================================================
// The pure rules live in config/walletRouting.ts and are unit-tested there. These
// assertions pin the SEAMS: that the settlement executor and the payout request
// build both consult the rule, that the executor refuses BEFORE it writes any
// durable submission marker, and that the application still contains no second
// money path (no wallet transfer, no balance read).
//
// The last group is the most important one for this batch: the safe code-side
// change is a GUARD, not a transfer engine. A future change that adds an
// intra-wallet transfer or a wallet-balance lookup to the app would reintroduce
// exactly the unaudited money path this batch deliberately does not build, so it
// fails here first.
// =============================================================================

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const SERVER = read('src/server.ts');
const PAYMENTS = read('src/services/payments.ts');
const ENV_EXAMPLE = read('.env.example');

/** The executor, from its declaration to the end of the file. */
const EXECUTOR = (() => {
  const start = SERVER.indexOf('async function executeClaimSettlement');
  expect(start, 'executeClaimSettlement must exist').toBeGreaterThan(-1);
  return SERVER.slice(start);
})();

describe('the settlement executor consults the routing rule before any marker', () => {
  it('calls the shared resolver', () => {
    expect(EXECUTOR).toContain('resolveConfiguredPayoutWalletRouting()');
  });

  it('refuses with abandonRelease (the release lock is returned, not stranded)', () => {
    const gateStart = EXECUTOR.indexOf('const walletRouting = resolveConfiguredPayoutWalletRouting();');
    expect(gateStart).toBeGreaterThan(-1);

    const gateEnd = EXECUTOR.indexOf('markPayoutSubmissionStarted(', gateStart);
    expect(gateEnd, 'the marker must follow the gate').toBeGreaterThan(gateStart);

    const gate = EXECUTOR.slice(gateStart, gateEnd);
    expect(gate).toContain('if (!walletRouting.ok) {');
    expect(gate).toContain('return await abandonRelease(');
    // The refusal is auditable, and the audit line carries the masked summary.
    expect(gate).toContain("'PAYOUT_WALLET_ROUTING_REFUSED'");
    expect(gate).toContain('describePayoutWalletRoutingForAudit(walletRouting)');
  });

  it('runs AFTER the pre-existing "is a working wallet configured?" gate', () => {
    const configuredGate = EXECUTOR.indexOf('INTASEND_DISBURSEMENT_WALLET_ID is not configured in production');
    const routingGate = EXECUTOR.indexOf('const walletRouting = resolveConfiguredPayoutWalletRouting();');
    expect(configuredGate).toBeGreaterThan(-1);
    expect(routingGate).toBeGreaterThan(configuredGate);
  });
});

describe('the payout request seam consults the same rule', () => {
  it('resolves the routing before the request body exists and throws on refusal', () => {
    const routingAt = PAYMENTS.indexOf('const walletRouting = resolveConfiguredPayoutWalletRouting();');
    const requestBodyAt = PAYMENTS.indexOf('const requestBody = {');
    expect(routingAt, 'the routing gate must exist in payments.ts').toBeGreaterThan(-1);
    expect(requestBodyAt).toBeGreaterThan(routingAt);

    const gate = PAYMENTS.slice(routingAt, requestBodyAt);
    expect(gate).toContain('if (!walletRouting.ok) {');
    expect(gate).toContain('throw new Error(`FATAL: ${walletRouting.message}`);');
  });

  it('still injects wallet_id ONLY in production, from the one accessor', () => {
    expect(PAYMENTS).toContain(
      "process.env.NODE_ENV === 'production' ? getDisbursementWalletId() : null"
    );
    expect(PAYMENTS).toContain('...(disbursementWalletId !== null ? { wallet_id: disbursementWalletId } : {})');
  });
});

describe('the settlement wallet identity is configuration only', () => {
  it('is documented in .env.example, empty by default', () => {
    expect(ENV_EXAMPLE).toMatch(/^INTASEND_SETTLEMENT_WALLET_ID=""$/m);
    expect(ENV_EXAMPLE).toContain('IDENTITY CHECK ONLY');
  });

  it('is never added to the provider request', () => {
    // The request body is built from `payload` plus `wallet_id`; the settlement
    // ID appears only in the identity reader and the routing module.
    const bodyStart = PAYMENTS.indexOf('const requestBody = {');
    const bodyEnd = PAYMENTS.indexOf('console.log', bodyStart);
    const requestBody = PAYMENTS.slice(bodyStart, bodyEnd);
    expect(requestBody).not.toContain('INTASEND_SETTLEMENT_WALLET_ID');
    expect(requestBody).not.toContain('getSettlementWalletId');
  });
});

describe('no second money path exists in the application', () => {
  /** Every non-test source file (the test files name the forbidden endpoints on purpose). */
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        out.push(...sourceFiles(full));
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      out.push(full);
    }
    return out;
  }

  // Constructed so this assertion file does not match its own needle.
  const TRANSFER_NEEDLE = 'intra' + '_transfer';
  const WALLETS_API_NEEDLE = '/wal' + 'lets/';

  it('contains no settlement-to-working-wallet transfer call', () => {
    const offenders = sourceFiles(path.join(REPO_ROOT, 'src'))
      .filter((file) => fs.readFileSync(file, 'utf8').includes(TRANSFER_NEEDLE))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('contains no provider wallet-balance or wallet-list call', () => {
    const offenders = sourceFiles(path.join(REPO_ROOT, 'src'))
      .filter((file) => fs.readFileSync(file, 'utf8').includes(WALLETS_API_NEEDLE))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('uses the one documented initiation path, defined once and shared by exactly two money paths', () => {
    // The path is a single constant (never a second literal), so the payout batch
    // and the single-transaction refund cannot drift apart.
    expect(PAYMENTS.match(/const INTASEND_SEND_MONEY_INITIATE_PATH =/g)?.length).toBe(1);
    // Exactly two call sites exist today: triggerIntasendPayout and
    // triggerIntasendRefund. A third would be a new money path and must be
    // reviewed, not silently added.
    expect(
      PAYMENTS.match(/`\$\{INTASEND_BASE_URL\}\$\{INTASEND_SEND_MONEY_INITIATE_PATH\}`/g)?.length
    ).toBe(2);
  });
});
