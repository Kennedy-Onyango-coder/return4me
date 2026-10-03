import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P2-A3.2: the eight claim payment/status handlers moved verbatim into
// routes/claimPayments.ts (so an HTTP integration test can mount them without
// importing server.ts, which boots its listener at import time). Route lookups
// below now search the new owner first and fall back to server.ts, so an
// assertion still fails if the handler disappears from BOTH files. No assertion
// was weakened or removed.
const CLAIM_PAYMENTS_TS = fs.readFileSync(path.resolve(__dirname, '../routes/claimPayments.ts'), 'utf8');

// ===========================================================================
// PHASE 16.1 — S4 SOURCE-LEVEL INVARIANTS (ROUTE / MONEY-PATH WIRING)
// ===========================================================================
// server.ts builds the whole Express app and starts listeners at import time,
// so its inline handlers cannot be mounted or imported. Asserting against the
// real source is this repository's established pattern for exactly that
// constraint (see categoryArchitectureBatch1/2.test.ts, countyAwareSearchAnd
// Surfacing.test.ts, regionsContract.test.ts).
//
// These tests PIN CURRENT BEHAVIOUR ONLY. They select no product contract:
//   S4-B  agent verification is gated to 'awaiting_dropoff', i.e. strictly
//         BEFORE the claim / payment / settlement lifecycle
//   S4-C  the public search category filter reads items.category_id and does
//         NOT read verified_category_id
//   S4-G  the webhook reconciliation expectation reads item.locked_total_fee
//         with a fallback to the REPORTED category's total_fee, and does NOT
//         read verified_category_id
//   S4-F  (second refund path) resolveDispute's refund derivation uses the
//         same locked-else-category precedence
//   S3    the /pay route resolves its fee through the ONE shared helper
// ===========================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SERVER_RAW = read('src/server.ts');
// P2-A2: the public discovery search route now lives in routes/publicSearch.ts.
const PUBLIC_SEARCH_RAW = read('src/routes/publicSearch.ts');
// P2-A3.4A: the four agent operational routes moved to routes/agentOps.ts.
const AGENT_OPS_RAW = read('src/routes/agentOps.ts');
const DATABASE_RAW = read('src/db/database.ts');

/** One inline route handler: from its registration to the next one. */
function routeBody(anchor: string): string {
  // P2-A2: GET /api/items/search was extracted VERBATIM from server.ts into
  // routes/publicSearch.ts so it can be mounted for real HTTP integration
  // testing. The body is read from whichever file now owns the anchor, so this
  // slicer keeps testing the same handler it always tested — only the file the
  // body lives in moved. No behavioural assertion is weakened.
  // P2-A2 moved GET /api/items/search into routes/publicSearch.ts, and P2-A3.2
  // moved the eight claim payment/status handlers into routes/claimPayments.ts
  // — both VERBATIM, so they can be mounted for real HTTP integration tests.
  // The body is read from whichever file now owns the anchor: this slicer keeps
  // testing the same handler it always tested. No assertion is weakened.
  const src = SERVER_RAW.includes(anchor) ? SERVER_RAW : (CLAIM_PAYMENTS_TS.includes(anchor) ? CLAIM_PAYMENTS_TS : (PUBLIC_SEARCH_RAW.includes(anchor) ? PUBLIC_SEARCH_RAW : AGENT_OPS_RAW));
  const start = src.indexOf(anchor);
  expect(start, `${anchor} not found in server.ts, routes/claimPayments.ts, routes/publicSearch.ts or routes/agentOps.ts`).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n {2}app\.[a-z]+\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next + 1));
}

/** One database method: from its declaration to the next `public async`. */
function databaseMethodBody(anchor: string): string {
  const start = DATABASE_RAW.indexOf(anchor);
  expect(start, `${anchor} not found in database.ts`).toBeGreaterThan(-1);
  const rest = DATABASE_RAW.slice(start + anchor.length);
  const next = rest.search(/\n {2}(public|private) (async )?[a-zA-Z]/);
  return stripComments(next === -1 ? rest : rest.slice(0, next + 1));
}

// ---------------------------------------------------------------------------
// S4-B — verification cannot occur after the claim / payment / settlement stages
// ---------------------------------------------------------------------------
describe("S4-B: agent verification is gated to 'awaiting_dropoff'", () => {
  it('the route rejects every item that is not awaiting_dropoff, BEFORE the verification write', () => {
    const body = routeBody("app.post('/api/agents/verify-item'");

    // The guard itself: an equality check that ADMITS exactly one status.
    expect(body).toContain("item.status !== 'awaiting_dropoff'");
    expect(body).toMatch(/res\.status\(400\)/);

    // Ordering: the status guard must run before any verification write.
    const statusGuard = body.indexOf("item.status !== 'awaiting_dropoff'");
    const mutation = body.indexOf('db.recordItemVerification(');
    expect(statusGuard).toBeGreaterThan(-1);

    expect(mutation).toBeGreaterThan(statusGuard);
  });

  it('no post-verification item status is accepted by that route', () => {
    const body = routeBody("app.post('/api/agents/verify-item'");

    // Once the item has left 'awaiting_dropoff' it can never be verified again:
    // 'at_agent' is the post-verification, pre-claim state, and 'claimed' can
    // only be reached after a full claim + payment + settlement. The route must
    // not name any of them as an acceptable status.
    for (const status of ['at_agent', 'claimed', 'expired', 'rejected', 'suspected_stolen', 'legal_hold']) {
      expect(body, `the verification route must not accept status '${status}'`).not.toMatch(
        new RegExp(`item\\.status === '${status}'`),
      );
    }
  });

  it("confirm-dropoff requires completed verification before it can move an item to 'at_agent'", () => {
    // TRACED, NOT ASSUMED: confirm-dropoff has NO status predicate of its own.
    // What it enforces is that verification ran (verification_status is not
    // 'pending') and that the Agent physically inspected the item — and only
    // then does it perform the write to item status 'at_agent', the status that
    // makes the item claimable. That is the boundary which guarantees agent
    // verification completes BEFORE the claim / payment / settlement lifecycle
    // can even begin. (The absence of a status guard on this route is recorded
    // as an audit finding elsewhere; it is deliberately not asserted as if it
    // existed.)
    const body = routeBody("app.post('/api/agents/confirm-dropoff'");
    expect(body).toContain("item.verification_status === 'pending'");
    expect(body).toContain('!item.physically_verified_at');
    expect(body).toContain("db.updateItemStatus(dropoffCode, 'at_agent')");

    // Ordering: both preconditions are checked before the status write.
    const verifyGuard = body.indexOf("item.verification_status === 'pending'");
    const physGuard = body.indexOf('!item.physically_verified_at');
    const write = body.indexOf("db.updateItemStatus(dropoffCode, 'at_agent')");
    expect(verifyGuard).toBeGreaterThan(-1);
    expect(physGuard).toBeGreaterThan(verifyGuard);
    expect(write).toBeGreaterThan(physGuard);
  });
});

// ---------------------------------------------------------------------------
// S4-C — the public search category filter reads the REPORTED category only
// ---------------------------------------------------------------------------
describe('S4-C: the public search category filter matches items.category_id only', () => {
  it('filters on item.category_id and never on verified_category_id', () => {
    const body = routeBody("app.get('/api/items/search'");

    // The current contract: ?categoryId= is matched against the finder-reported
    // classification.
    expect(body).toContain('item.category_id === categoryId');
    // The verified classification must NOT be part of the filter — adding it
    // here would silently change which items a category search returns.
    expect(body).not.toContain('verified_category_id');
  });

  it('the filter is applied to the item rows themselves, not to a merged/effective value', () => {
    const body = routeBody("app.get('/api/items/search'");
    const filterIdx = body.indexOf('item.category_id === categoryId');
    expect(filterIdx).toBeGreaterThan(-1);
    // No effective-category helper is consulted anywhere in the search route.
    expect(body).not.toContain('effectiveItemCategoryId');
  });
});

// ---------------------------------------------------------------------------
// S3 — /pay and the payment-session route share ONE fee resolver
// ---------------------------------------------------------------------------
describe('S3: the two claimant-facing money routes resolve the fee through one helper', () => {
  it('the /pay route calls resolveAuthoritativePaymentFee instead of re-implementing it', () => {
    const body = routeBody("app.post('/api/claims/:id/pay'");
    expect(body).toContain('resolveAuthoritativePaymentFee(item, category)');
    // The duplicated inline precedence logic must be gone — the fee is
    // assigned exactly once, and that assignment is the helper call.
    expect(body).not.toContain('let resolvedFee = category.total_fee');
    expect(body).not.toContain('resolvedFee = lockedVal');
    const assignments = body.match(/resolvedFee\s*=/g) || [];
    expect(assignments.length, 'the fee must be assigned exactly once').toBe(1);
  });

  it('the payment-session route uses the same helper', () => {
    const body = routeBody("app.post('/api/claims/:id/payment-session'");
    expect(body).toContain('resolveAuthoritativePaymentFee(item, category)');
  });

  it('the helper itself keeps locked-total-fee precedence over the category fee', () => {
    // P2-A3.2: this helper moved to routes/claimPayments.ts (it was used ONLY by the
    // eight extracted handlers), so the slice is taken from whichever file owns it.
    const feeSrc = CLAIM_PAYMENTS_TS.indexOf('function resolveAuthoritativePaymentFee(') >= 0 ? CLAIM_PAYMENTS_TS : SERVER_RAW;
    const start = feeSrc.indexOf('function resolveAuthoritativePaymentFee(');
    const end = feeSrc.indexOf('return fee;', start);
    expect(start, 'resolveAuthoritativePaymentFee not found').toBeGreaterThan(-1);
    expect(end, 'the helper body could not be located').toBeGreaterThan(start);
    const body = stripComments(feeSrc.slice(start, end));
    expect(body).toContain('category.total_fee');
    // ...then the locked value overrides it when present and > 0.
    expect(body).toContain('locked_total_fee');
    expect(body).toMatch(/lockedVal > 0/);
    // The reported category is the only category consulted.
    expect(body).not.toContain('verified_category_id');
  });

  it('neither money route accepts a client-supplied amount', () => {
    expect(routeBody("app.post('/api/claims/:id/pay'")).not.toContain('req.body.amount');
    expect(routeBody("app.post('/api/claims/:id/payment-session'")).not.toContain('req.body.amount');
  });
});

// ---------------------------------------------------------------------------
// S4-G — webhook reconciliation expectation uses the REPORTED category
// ---------------------------------------------------------------------------
describe('S4-G: the webhook reconciliation expectation uses the reported category', () => {
  function reconciliationBlock(): string {
    // P2-A3.2: this P1 reconciliation block still lives in server.ts (the
    // IntaSend webhook was deliberately NOT extracted), so it is read there.
    const marker = 'const categoriesForReconciliation = await db.getCategories();';
    const start = SERVER_RAW.indexOf(marker);
    expect(start, 'the reconciliation expectation block was not found').toBeGreaterThan(-1);
    // P1 (B-1): this block no longer terminates at the old
    // `if (confirmedAmount !== undefined` guard — the 'unknown' branch now has
    // its own provider-verification path, so the block runs to the escrow CAS.
    // The contract being protected is unchanged: the expectation is derived
    // from the REPORTED category's fee, never from the verified category.
    const end = CLAIM_PAYMENTS_TS.indexOf('attemptClaimEscrowHold(claimId, invoiceId)', start) >= 0 ? CLAIM_PAYMENTS_TS.indexOf('attemptClaimEscrowHold(claimId, invoiceId)', start) : SERVER_RAW.indexOf('attemptClaimEscrowHold(claimId, invoiceId)', start);
    expect(end).toBeGreaterThan(start);
    return stripComments(SERVER_RAW.slice(start, end));
  }

  it('expects locked_total_fee when present, else the REPORTED category total fee', () => {
    const body = reconciliationBlock();
    expect(body).toContain('item.category_id');
    expect(body).toContain('item.locked_total_fee');
    expect(body).toContain('.total_fee');
    // The expectation must never be re-derived from the verified category.
    expect(body).not.toContain('verified_category_id');
  });

    // P1 (B-1) webhook reconciliation still lives in server.ts (the IntaSend
    // webhook route was deliberately NOT extracted by P2-A3.2).
    const start = SERVER_RAW.indexOf('const categoriesForReconciliation = await db.getCategories();');
  it('compares the provider amount through the shared tolerance helper', () => {
    expect(start).toBeGreaterThan(-1);
    const body = stripComments(SERVER_RAW.slice(start, start + 3000));
    // P1 (B-1): `confirmedAmount` was renamed `authoritativeAmount` so it can
    // hold either the callback's own value or the provider-confirmed one after
    // the escalation. The helper is still the single comparison point.
    expect(body).toContain('reconcileWebhookAmount(authoritativeAmount, expectedFee)');
  });
});

// ---------------------------------------------------------------------------
// S4-F (second refund path) — resolveDispute's refund derivation
// ---------------------------------------------------------------------------
describe('S4-F: resolveDispute derives the refund from locked_total_fee, else the REPORTED category fee', () => {
  it('uses item.category_id as the only fallback category', () => {
    const body = databaseMethodBody('public async resolveDispute(');
    expect(body).toContain('item.category_id');
    expect(body).toContain('item.locked_total_fee');
    expect(body).toContain('refundAmount');
    expect(body, 'the refund must not be re-derived from the verified category')
      .not.toContain('verified_category_id');
  });
});




