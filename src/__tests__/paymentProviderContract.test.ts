import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// PROVIDER CONTRACT AUDIT.
//
// The reported incident: a real KES 200 M-Pesa collection completed at IntaSend
// while the Return4me claim stayed in `pending_payment` on every dashboard. Two
// contract mismatches caused it:
//   1. the webhook expected an HMAC-SHA256 signature, but IntaSend's collection
//      webhook authenticates with a configured CHALLENGE value, so the real
//      callback was rejected (401) and never processed; and
//   2. the authoritative status lookup used a legacy GET URL/host that the
//      current IntaSend API no longer serves, so the fallback could not recover
//      it either.
//
// These source-audit assertions pin the CORRECTED contract. Static source audit
// is the established pattern for server.ts-adjacent modules in this suite.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

const WEBHOOKS = read('src/routes/webhooks.ts');
const PAYMENTS = read('src/services/payments.ts');
const SERVER = read('src/server.ts');
const DATABASE = read('src/db/database.ts');
// BATCH 2 — the one wallet-routing rule both payout seams consult.
const WALLET_ROUTING = read('src/config/walletRouting.ts');

// =============================================================================
// SOURCE SLICING — WHY THERE IS NO CHARACTER BUDGET HERE
//
// This file previously sliced the webhook route with a fixed character budget,
// `WEBHOOKS.slice(start, start + 4200)`. That is not a contract: it is a guess
// about how long the route body happens to be. When the route gained explanatory
// comments, TWO assertions in this file began failing against entirely correct
// code — the assertions were still true, but the text that proved them had moved
// past the 4,200th character. A brittle source slice turns every future comment
// into a red test, which trains a reader to distrust the suite.
//
// The slice therefore runs from the route registration TO THE END OF THE MODULE,
// and the structural fact it depends on — that this route is the LAST
// registration in routes/webhooks.ts, so nothing unrelated can leak into the
// slice — is itself asserted below. That turns a silent-drift hazard into an
// explicit, checkable contract.
// =============================================================================
function webhookBody(): string {
  const start = WEBHOOKS.indexOf("app.post('/api/webhooks/intasend'");
  expect(start, 'webhook route not found').toBeGreaterThan(-1);
  return WEBHOOKS.slice(start);
}

describe('IntaSend collection webhook contract', () => {
  const body = webhookBody();

  it('is the LAST registration in the module (the slice above depends on it)', () => {
    // Without this, a future second route would silently join the slice and the
    // assertions below could pass on someone else's code. Asserting the
    // structural fact keeps the boundary honest instead of implicit.
    const routeStart = WEBHOOKS.indexOf("app.post('/api/webhooks/intasend'");
    expect(routeStart).toBe(WEBHOOKS.lastIndexOf('app.post('));
    // And the module holds exactly one route registration.
    expect((WEBHOOKS.match(/app\.post\(/g) || []).length).toBe(1);
  });

  it('authenticates with the configured challenge, not an HMAC signature', () => {
    expect(body).toContain('INTASEND_WEBHOOK_CHALLENGE');
    expect(body).toContain('challengeMatches(payload.challenge, configuredChallenge)');
    // The competing signature system is gone.
    expect(WEBHOOKS).not.toContain('x-intasend-signature');
    expect(WEBHOOKS).not.toContain('createHmac');
  });

  it('requires the challenge in production and rejects a missing one', () => {
    expect(body).toMatch(/NODE_ENV === 'production' && !configuredChallenge/);
    expect(body).toMatch(/status\(401\)/);
  });

  it('validates the collection topic and safely ignores other lifecycle events', () => {
    expect(body).toContain("payload.topic !== 'collection_event'");
    expect(body).toMatch(/status: 'ignored'/);
  });

  it('requires a usable invoice_id and api_ref', () => {
    expect(body).toMatch(/!invoice_id \|\| typeof invoice_id !== 'string'/);
    expect(body).toMatch(/!claimId \|\| typeof claimId !== 'string'/);
  });

  it('only processes a COMPLETE collection', () => {
    expect(body).toMatch(/if \(state !== 'COMPLETE'\)/);
  });

  it('delegates the financial decision to the ONE canonical confirmation path', () => {
    expect(body).toContain('processClaimPaymentConfirmed(claimId, invoice_id, webhookAmount)');
    // The route must not perform the escrow transition or write payment truth.
    expect(body).not.toContain('attemptClaimEscrowHold');
    expect(body).not.toContain('paid_at');
  });
});

describe('IntaSend authoritative status lookup contract', () => {
  it('POSTs { invoice_id } to the documented /payment/status/ endpoint', () => {
    expect(PAYMENTS).toContain('${INTASEND_BASE_URL}/payment/status/');
    expect(PAYMENTS).toContain("method: 'POST'");
    expect(PAYMENTS).toMatch(/JSON\.stringify\(\{ invoice_id: trimmedInvoice \}\)/);
  });

  it('uses the current production host and keeps the sandbox host', () => {
    expect(PAYMENTS).toContain("'https://api.intasend.com/api/v1'");
    expect(PAYMENTS).toContain("'https://sandbox.intasend.com/api/v1'");
    expect(PAYMENTS).not.toContain('payment.intasend.com');
  });

  it('verifies invoice identity, state, and reads provider_ref (never transaction_id-first)', () => {
    expect(PAYMENTS).toContain('provider_invoice_identity_mismatch');
    expect(PAYMENTS).toMatch(/providerState !== 'COMPLETE'/);
    expect(PAYMENTS).toContain('invoice.provider_ref');
  });

  it('enforces api_ref cross-claim isolation and keeps a bounded timeout', () => {
    expect(PAYMENTS).toContain('provider_api_ref_mismatch');
    expect(PAYMENTS).toMatch(/fetchWithTimeout\([\s\S]{0,400}?12000\s*\)/);
  });

  it('never logs the secret key or the raw provider payload', () => {
    // No console call may interpolate the secret key.
    expect(PAYMENTS).not.toMatch(/console\.[a-z]+\([^)]*secretKey/);
  });
});

describe('production boot guard requires the challenge', () => {
  it('refuses to boot on a placeholder INTASEND_WEBHOOK_CHALLENGE', () => {
    expect(SERVER).toContain('isPlaceholderKey(process.env.INTASEND_WEBHOOK_CHALLENGE)');
  });
});

describe('IntaSend payout initiation contract (Batch 1B-C1)', () => {
  it('POSTs payout initiation to the documented /send-money/initiate/ path', () => {
    // Documented: "Initiate a batch with POST /api/v1/send-money/initiate/."
    expect(PAYMENTS).toContain("'/send-money/initiate/'");
    expect(PAYMENTS).toContain('${INTASEND_BASE_URL}${INTASEND_SEND_MONEY_INITIATE_PATH}');
  });

  it('no longer posts to the bare, undocumented /send-money/ path', () => {
    // Both call sites (batch payout and single-transaction refund) used it.
    expect(PAYMENTS).not.toContain('${INTASEND_BASE_URL}/send-money/`');
  });

  it('leaves the payout status endpoint untouched', () => {
    expect(PAYMENTS).toContain('${INTASEND_BASE_URL}/send-money/status/');
  });

  it('sends the documented per-transaction idempotency_key', () => {
    // "Unique key per transaction. A repeat request with the same key is
    // rejected, so you can retry safely."
    expect(PAYMENTS).toContain('idempotency_key: leg.idempotencyKey');
    // The key FORMAT lives in the shared pure module (config/payoutIdempotency.ts)
    // so the provider submission path and the payout-repair policy agree on it.
    // Asserting the literal format against payments.ts pinned the pre-extraction
    // inline template and drifted when the builder moved; assert the call site
    // AND the one implementation instead.
    expect(PAYMENTS).toContain('idempotencyKey: buildPayoutLegIdempotencyKey(claimId, p.recipientType)');
    expect(read('src/config/payoutIdempotency.ts')).toContain(
      '`PAYOUT_LEG_${recipientType.toUpperCase()}:${String(claimId ?? \'\').trim()}`',
    );
  });

  it('never correlates provider transactions by an account suffix again', () => {
    // BATCH 1B-C1-R1 — SCOPED to the initiation block instead of the whole
    // file. A file-wide `not.toContain('endsWith(')` / `not.toContain('slice(-9)')`
    // fails on ANY future legitimate use of those ordinary string operations
    // anywhere in payments.ts (URL checks, id handling, an unrelated provider),
    // and it cannot distinguish the account-suffix correlation this test exists
    // to pin from code that has nothing to do with correlation. The suffix
    // matcher only ever lived in the initiation block, so that is where the
    // negative belongs — see the next test, which asserts the same thing on the
    // same slice plus the alternative response keys.
    const start = PAYMENTS.indexOf('async triggerIntasendPayout');
    expect(start, 'triggerIntasendPayout not found').toBeGreaterThan(-1);
    const end = PAYMENTS.indexOf('async triggerIntasendRefund', start);
    expect(end, 'triggerIntasendRefund not found').toBeGreaterThan(start);
    const initiation = PAYMENTS.slice(start, end);

    expect(initiation).not.toContain('slice(-9)');
    expect(initiation).not.toContain('endsWith(');
    // The replacement correlation is still the ONLY one, file-wide and here.
    expect(initiation).toContain('resolvePayoutTransactionBindings');
    expect(PAYMENTS).toContain('resolvePayoutTransactionBindings');
  });

  it('reads only the documented response fields in the initiation parser', () => {
    // Scoped to the INITIATION block: the status lookup keeps its own
    // (pre-existing, out-of-scope) `disbursements` fallback, so a file-wide
    // assertion would be asserting about code this batch does not own.
    const start = PAYMENTS.indexOf('async triggerIntasendPayout');
    expect(start, 'triggerIntasendPayout not found').toBeGreaterThan(-1);
    const end = PAYMENTS.indexOf('async triggerIntasendRefund', start);
    expect(end, 'triggerIntasendRefund not found').toBeGreaterThan(start);
    const initiation = PAYMENTS.slice(start, end);

    // The alternative key names the suffix matcher probed are gone.
    expect(initiation).not.toContain('data?.invoices');
    expect(initiation).not.toContain('data?.disbursements');
    expect(initiation).not.toContain('t?.phone_number');
    expect(initiation).not.toContain('match?.invoice');
    // ...and the suffix correlation itself is gone, from this block and the file.
    expect(initiation).not.toContain('slice(-9)');
    expect(initiation).not.toContain('endsWith(');
    expect(initiation).toContain('resolvePayoutTransactionBindings');
  });

  it('requests the documented automated approval mode (requires_approval: "NO")', () => {
    // BATCH P2 — a send-money batch created without `requires_approval:"NO"` can
    // be parked by the provider in the BP103 "Preview and approve" state, which
    // pays NOTHING until a separate approval. The platform's own approval gate is
    // the durable admin settlement approval (settlement_approved_at), so the
    // provider must NOT add a second human approval on top of it.
    expect(PAYMENTS).toContain("requires_approval: 'NO'");
  });

  it('handles a BP103 approval-required batch distinctly, never as accepted or completed', () => {
    // BATCH P2 — the initiation block must consult the batch-level approval check
    // and, on BP103, report every leg UNRESOLVED ('unknown') with the batch ref
    // preserved. It must not call any undocumented approval endpoint or auto-retry.
    expect(PAYMENTS).toContain('isBatchApprovalRequired(data)');
    expect(PAYMENTS).not.toContain('/send-money/approve');
    expect(PAYMENTS).not.toContain('/send-money/publish');
  });

  it('does not weaken the durable administrator settlement approval gate', () => {
    // BATCH P2 — provider approval mode is additive; the platform's own gate is
    // untouched. The settlement executor must still require settlement_approved_at
    // and the 'releasing' lock immediately before any payout submission.
    expect(SERVER).toContain("preSubmitClaim.settlement_approved_at == null");
    expect(SERVER).toContain("preSubmitClaim.status !== 'releasing'");
  });
});

// =============================================================================
// RELEASE-LOCK REGRESSION — A REFUSED WALLET GATE MUST GIVE THE LOCK BACK.
// =============================================================================
// The production wallet gate sits in the middle of the settlement executor:
// AFTER attemptSettlementRelease() has moved the claim to 'releasing', but
// BEFORE the per-row compare-and-swap markers and the provider call. Returning
// a bare failure there would strand the claim in 'releasing' — the settlement
// sweep is reporting-only and never reverts it — with nothing submitted and
// nothing written. So the gate MUST abandon the release exactly like every
// other early-abandonment path in that function (abandonRelease()), and it MUST
// do so BEFORE any row is marked as submitted and before any ledger write.
//
// HOW FAR THIS GOES: these are SOURCE-CONTRACT assertions on the real text of
// server.ts and database.ts. The ordering and the helper call are pinned
// exactly, and the state that helper finally commits is pinned on the database
// method that performs it. The TRANSITION ITSELF (a live claim moving from
// 'releasing' back to 'pending_settlement') is NOT integration-tested by this
// file: it never opens a database. That limitation is stated, not implied.
// =============================================================================
describe('production wallet gate abandons the settlement release instead of stranding it', () => {
  const guardStart = SERVER.indexOf('PRODUCTION DISBURSEMENT-WALLET CONFIGURATION GUARD');
  // The durable pre-submission markers are the next structural landmark after
  // the guard, so the slice below cannot silently grow into unrelated code.
  const guardEnd = SERVER.indexOf('DURABLE PRE-SUBMISSION MARKERS', guardStart);

  it('sits inside the submission block, among the pre-submission authorization re-checks', () => {
    const blockStart = SERVER.indexOf('if (submittable.length > 0) {');
    expect(blockStart, 'submission block not found').toBeGreaterThan(-1);
    expect(guardStart, 'wallet guard not found').toBeGreaterThan(blockStart);
    // The lock re-checks it shares a code path with, all inside that block.
    const lockRecheck = SERVER.indexOf("preSubmitClaim.status !== 'releasing'");
    expect(lockRecheck).toBeGreaterThan(blockStart);
    expect(lockRecheck).toBeLessThan(guardStart);
    expect(SERVER.indexOf('preSubmitClaim.settlement_approved_at == null')).toBeLessThan(guardStart);
  });

  it('gives the release lock back through abandonRelease() — never a bare failure return', () => {
    expect(guardEnd, 'submission markers not found after the guard').toBeGreaterThan(guardStart);
    const guard = SERVER.slice(guardStart, guardEnd);
    expect(guard).toContain('if (!disbursementWalletConfigured) {');
    expect(guard).toContain('INTASEND_DISBURSEMENT_WALLET_ID is not configured in production');
    // The recovery, not merely a refusal.
    expect(guard).toContain('return await abandonRelease(');
    // A refusal that skips the reversion is the defect this test exists for.
    expect(guard).not.toMatch(/return\s*\{\s*success:\s*false/);
  });

  it('abandons the release BEFORE the CAS markers, the provider call and the ledger writes', () => {
    const abandonIdx = SERVER.indexOf('return await abandonRelease(', guardStart);
    const markerSectionIdx = SERVER.indexOf('const claimed: typeof submittable = [];', guardStart);
    const casIdx = SERVER.indexOf('await db.markPayoutSubmissionStarted(candidate.row.id)', guardStart);
    const providerIdx = SERVER.indexOf('await PaymentService.triggerIntasendPayout(claimId, claimed.map', guardStart);
    const ledgerIdx = SERVER.indexOf('await db.recordPayoutAttempt(candidate.row.id, {', guardStart);

    expect(abandonIdx, "the guard's abandonRelease call was not found").toBeGreaterThan(-1);
    expect(markerSectionIdx, 'the durable pre-submission marker section was not found').toBeGreaterThan(-1);
    expect(casIdx, 'the per-row CAS marker was not found').toBeGreaterThan(-1);
    expect(providerIdx, 'the provider call was not found').toBeGreaterThan(-1);
    expect(ledgerIdx, 'the ledger write was not found').toBeGreaterThan(-1);

    // The lock is returned BEFORE anything is durably claimed or written, so a
    // refused wallet can never leave a payout row looking submitted.
    expect(abandonIdx).toBeLessThan(markerSectionIdx);
    expect(abandonIdx).toBeLessThan(casIdx);
    expect(abandonIdx).toBeLessThan(ledgerIdx);
    // ...and the established marker -> provider -> ledger order is untouched.
    expect(casIdx).toBeLessThan(providerIdx);
    expect(providerIdx).toBeLessThan(ledgerIdx);
  });

  it('the abandonment path really returns the claim to pending_settlement (source contract, not integration-tested)', () => {
    // The helper's signature is multi-line (it gained an optional refusal code),
    // so anchor on the declaration only — the audit line below is the structural
    // end and the body between them is asserted exactly.
    const abandonStart = SERVER.indexOf('const abandonRelease = async (');
    expect(abandonStart, 'abandonRelease was not found').toBeGreaterThan(-1);
    // Structural end of the helper: its own audit line, inside the same helper.
    const abandonEnd = SERVER.indexOf("'SETTLEMENT_RELEASE_ABANDONED'", abandonStart);
    expect(abandonEnd).toBeGreaterThan(abandonStart);
    expect(SERVER.slice(abandonStart, abandonEnd)).toContain('await db.revertSettlementRelease(claimId)');

    const revertStart = DATABASE.indexOf('public async revertSettlementRelease(claimId: string): Promise<void> {');
    expect(revertStart, 'revertSettlementRelease was not found').toBeGreaterThan(-1);
    // Structural end: the guarded UPDATE's own WHERE clause.
    const revertEnd = DATABASE.indexOf('eq(claimsTable.status, "releasing")', revertStart);
    expect(revertEnd).toBeGreaterThan(revertStart);
    const revert = DATABASE.slice(revertStart, revertEnd);

    // The ONLY transition this helper is allowed to take, and the state it writes.
    expect(revert).toContain("this.assertClaimTransitionAllowed('releasing', 'pending_settlement')");
    expect(revert).toContain('status: "pending_settlement"');
    // Nothing in it can leave the claim in the state it was abandoned from.
    expect(revert).not.toContain('status: "releasing"');
  });

  it('the service-level wallet guard is reachable on the normal production path', () => {
    const start = PAYMENTS.indexOf('async triggerIntasendPayout');
    expect(start, 'triggerIntasendPayout was not found').toBeGreaterThan(-1);
    const end = PAYMENTS.indexOf('async triggerIntasendRefund', start);
    expect(end, 'triggerIntasendRefund was not found').toBeGreaterThan(start);
    const initiation = PAYMENTS.slice(start, end);

    const simulationReturn = initiation.indexOf('SIM-BATCH-');
    const serviceGuard = initiation.indexOf('const walletRouting = resolveConfiguredPayoutWalletRouting();');
    const refusal = initiation.indexOf('if (!walletRouting.ok) {');
    const requestBody = initiation.indexOf('const requestBody = {');
    const providerCall = initiation.indexOf('await fetchWithTimeout(');
    expect(simulationReturn, 'the placeholder-key simulation branch was not found').toBeGreaterThan(-1);
    expect(serviceGuard, 'the service-level wallet guard was not found').toBeGreaterThan(-1);
    expect(refusal, 'the service-level wallet refusal was not found').toBeGreaterThan(-1);
    expect(requestBody, 'the request body was not found').toBeGreaterThan(-1);
    expect(providerCall, 'the provider call was not found').toBeGreaterThan(-1);

    // AFTER the placeholder-key branch returns, i.e. OUTSIDE it: a real
    // production key reaches the guard. Inside that branch it was dead code on
    // the only path that matters — the defect this assertion pins.
    expect(serviceGuard).toBeGreaterThan(simulationReturn);
    // ...and still before any provider request is built or sent. BATCH 2 folded
    // the "is a wallet configured?" question and the "is that wallet the
    // collection wallet?" question into ONE resolver; the refusal and its throw
    // therefore precede the request-body construction itself.
    expect(refusal).toBeGreaterThan(serviceGuard);
    expect(refusal).toBeLessThan(requestBody);
    expect(requestBody).toBeLessThan(providerCall);
    expect(initiation).toContain('throw new Error(`FATAL: ${walletRouting.message}`);');
    // The wallet itself is injected production-only, from the one accessor.
    expect(initiation).toContain("process.env.NODE_ENV === 'production' ? getDisbursementWalletId() : null");
    // The shared module carries BOTH production refusals, so moving the gate did
    // not drop the missing-wallet refusal or invent a weaker one.
    expect(WALLET_ROUTING).toContain('INTASEND_DISBURSEMENT_WALLET_ID is not configured in production');
    expect(WALLET_ROUTING).toContain('names the same wallet as INTASEND_SETTLEMENT_WALLET_ID');
  });
});
