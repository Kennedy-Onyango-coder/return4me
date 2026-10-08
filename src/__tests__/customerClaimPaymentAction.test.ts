import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// THE /account CLAIM PAYMENT ACTION — the missing M-Pesa step
// =============================================================================
// The private dashboard could SHOW a claim awaiting payment (a "Payment Pending"
// badge and a "Pay before …" deadline) but offered NO way to pay: the only M-Pesa
// action in the product lived in the public owner journey (OwnerView). A
// customer who reached /account saw an actionable state with nothing to act on.
//
// This suite pins the fix. It is a SOURCE audit — this repository has no
// jsdom/React harness, so — exactly as the UX-07/UX-08 and paymentAuthGate,
// claimGuessRateLimit and adminRouteAudit suites do — the contract is asserted
// against the shipped source.
//
// The fix must satisfy five cases:
//   1. A pending-payment claim offers ONE actionable "Pay with M-Pesa" control.
//   2. Once the STK push is out, the state is PROCESSING — the pay action is
//      replaced (no path issues a second push for the same press).
//   3. A confirmation is only ever read BACK FROM THE SERVER; the browser never
//      declares a payment successful on its own.
//   4. An unauthorized/declined attempt surfaces the server's rejection and
//      changes nothing else — the amount is always the server's.
//   5. The existing customer flow is untouched: same endpoints, same order,
//      same privacy boundary, status still read only through the shared
//      vocabulary.

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
/** The same comment stripper the UX-06/07/08 suites use (keeps `://` intact). */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ACTION_TSX = read('src/components/customer/ClaimPaymentAction.tsx');
const ACTION = stripComments(ACTION_TSX);
const DASHBOARD_TSX = read('src/components/CustomerDashboard.tsx');
const DASHBOARD = stripComments(DASHBOARD_TSX);

const count = (source: string, pattern: RegExp) => (source.match(pattern) || []).length;
/** Every backend target the action can call, in source order. */
const endpoints = (source: string) =>
  Array.from(source.matchAll(/fetch\(`([^`]+)`/g)).map((m) => m[1]);
/** Every literal request body the action sends. */
const bodies = (source: string) =>
  Array.from(source.matchAll(/JSON\.stringify\((\{[^}]*\})\)/g)).map((m) => m[1]);

describe('1: a payment-pending claim offers the M-Pesa action', () => {
  it('owns the status token that unlocks the action, outside the dashboard', () => {
    // The action is offered for exactly one status. That literal lives HERE and
    // never in the dashboard, which reads status only via getClaimStatusDisplay.
    expect(ACTION).toContain("const PAYABLE_STATUS = 'pending_payment';");
    expect(ACTION).toContain('const payable = status === PAYABLE_STATUS;');
    expect(DASHBOARD).not.toContain("'pending_payment'");
  });

  it('renders nothing at all when the claim is not awaiting payment', () => {
    // Self-gating: the dashboard can mount it in every claim card harmlessly.
    expect(ACTION).toContain('if (!payable) return null;');
  });

  it('offers the pay button as the primary next step', () => {
    expect(ACTION).toContain("'Pay with M-Pesa'");
    expect(ACTION).toMatch(/onClick=\{payNow\}/);
  });

  it('runs the full three-step server flow behind the button', () => {
    const eps = endpoints(ACTION);
    expect(eps.length).toBe(5);
    expect(new Set(eps)).toEqual(
      new Set([
        '/api/claims/${claimId}/payment-auth',
        '/api/claims/${claimId}/payment-session',
        '/api/claims/${claimId}/payment-session/${sid}/initiate',
        '/api/claims/${claimId}/payment-session/${sessionId}/status',
        '/api/claims/${claimId}/status',
      ]),
    );
    // auth -> create session -> initiate, in that order (the push is last).
    const auth = ACTION.indexOf('/payment-auth');
    const session = ACTION.indexOf('/payment-session`');
    const initiate = ACTION.indexOf('/initiate');
    expect(auth).toBeGreaterThan(-1);
    expect(session).toBeGreaterThan(auth);
    expect(initiate).toBeGreaterThan(session);
  });

  it('keeps the poll under the server payment window and bounded', () => {
    expect(ACTION).toContain('const POLL_INTERVAL_MS = 3000;');
    expect(ACTION).toContain('const POLL_TIMEOUT_MS = 90000;');
  });
});

describe('2: while the prompt is out the state is processing', () => {
  it('moves to the awaiting phase only after the initiate call returns ok', () => {
    const initiateIdx = ACTION.indexOf('/initiate');
    const awaitingIdx = ACTION.indexOf("setPhase('awaiting');");
    expect(initiateIdx).toBeGreaterThan(-1);
    expect(awaitingIdx).toBeGreaterThan(initiateIdx);
  });

  it('swaps the pay action for a status check while awaiting', () => {
    expect(ACTION).toContain("{phase === 'awaiting' ? (");
    expect(ACTION).toContain("'Check payment status'");
    // The pay button is no longer the offered action in that branch.
    expect(ACTION).toMatch(/\{phase === 'error' \? 'Try again' : 'Pay with M-Pesa'\}/);
  });

  it('cannot double-submit: a re-press is guarded and idempotent server-side', () => {
    // The handler refuses to run while busy; the duplicate push is prevented by
    // the server's per-session CAS, whose contract is documented above the
    // initiate call. The UI therefore never fans out parallel pushes.
    expect(ACTION).toMatch(/if \(!payable \|\| busy\) return;/);
    expect(ACTION).toMatch(/if \(!sessionId \|\| busy\) return;/);
  });

  it('polls the claim status on a fixed cadence with a hard ceiling', () => {
    expect(ACTION).toContain('setInterval(');
    expect(ACTION).toContain('clearInterval(interval);');
    expect(ACTION).toMatch(/elapsed \+= POLL_INTERVAL_MS/);
    expect(ACTION).toMatch(/elapsed > POLL_TIMEOUT_MS/);
  });
});

describe('3: a confirmation is only ever read back from the server', () => {
  it('never sets the confirmed phase from a client-side value', () => {
    // Every `setPhase('confirmed')` sits behind a server-reported status. There
    // is exactly one per path (poll + explicit check), both keyed on the claim
    // status the backend actually recorded.
    expect(count(ACTION, /setPhase\('confirmed'\)/g)).toBe(2);
  });

  it("confirms only on escrow_held / released, the backend's own tokens", () => {
    expect(ACTION).toMatch(/data\?\.status === 'escrow_held' \|\| data\?\.status === 'released'/);
    expect(ACTION).toMatch(
      /sessionStatus === 'confirmed' \|\| claimStatus === 'escrow_held' \|\| claimStatus === 'released'/,
    );
  });

  it('treats a closed window as a terminal, recoverable state', () => {
    // THE BEHAVIOUR: the CLAIM's 24-hour window closing is the only terminal case
    // that requires re-linking, so it is evaluated BEFORE the per-attempt session
    // expiry, which is merely "get a fresh prompt" while the claim stays open.
    //
    // This used to be asserted as one verbatim `||` expression
    // ('sessionStatus === \'expired\' || claimStatus === \'payment_window_expired\'),
    // which is not a contract — the two conditions were later split into ordered
    // branches (correctly, since they are NOT interchangeable) and the literal
    // stopped existing while the BEHAVIOUR was preserved. Assert the ordering and
    // the outcomes instead, so the test measures the rule rather than one spelling
    // of it.
    expect(ACTION).toContain("data?.status === 'payment_window_expired'");

    const claimWindow = ACTION.indexOf("claimStatus === 'payment_window_expired'");
    const sessionExpired = ACTION.indexOf("sessionStatus === 'expired'");
    expect(claimWindow, 'closed-claim-window branch missing').toBeGreaterThan(-1);
    expect(sessionExpired, 'expired-prompt branch missing').toBeGreaterThan(-1);
    expect(claimWindow).toBeLessThan(sessionExpired);

    // The terminal branch stops the poll loop AND tells the parent to reload, so
    // the dashboard can move on to a fresh claim.
    const claimWindowBranch = ACTION.slice(claimWindow, sessionExpired);
    expect(claimWindowBranch).toContain('setPolling(false);');
    expect(claimWindowBranch).toContain('onConfirmedRef.current();');

    // The prompt-expiry branch stops the loop but must NOT end the claim: the
    // 24-hour window is still open, so the parent is deliberately not signalled.
    const sessionExpiredBranch = ACTION.slice(sessionExpired, sessionExpired + 600);
    expect(sessionExpiredBranch).toContain('setPolling(false);');
    expect(sessionExpiredBranch).not.toContain('onConfirmedRef.current();');
  });

  it('tells the parent so it can reload the claim and move on', () => {
    // The reload callback is held in a ref so its identity cannot restart the
    // poll loop. It fires on a confirmation AND on a closed window, on both the
    // poll path and the on-demand check path — four call sites, one per outcome.
    expect(ACTION).toContain('const onConfirmedRef = useRef(onConfirmed);');
    expect(count(ACTION, /onConfirmedRef\.current\(\);/g)).toBe(4);
  });
});

describe('4: an unauthorized or declined attempt fails safe', () => {
  it('sends the account phone so the server can authorize it', () => {
    expect(bodies(ACTION)).toEqual([
      '{ phone }',
      '{ phone, payerPhone: phone }',
      '{ paymentAuthToken: authData?.paymentAuthToken }',
    ]);
    // The payer is the account holder itself — the flow never lets the caller
    // name an arbitrary payer.
    expect(ACTION).toContain('payerPhone: phone');
  });

  it('NEVER puts an amount in a request body', () => {
    for (const body of bodies(ACTION)) {
      expect(body).not.toMatch(/amount/i);
    }
  });

  it('shows the server-computed amount, and nothing invented', () => {
    expect(ACTION).toContain('readAmount(sessionData?.paymentSession?.amount)');
    expect(ACTION).toContain('readAmount(data?.paymentSession?.amount)');
    expect(ACTION).toContain('formatAmount(amount)');
  });

  it('surfaces a rejected request instead of pretending success', () => {
    // A non-ok response throws, and the catch renders the server message via a
    // Banner — the surface never advances on an error.
    expect(count(ACTION, /if \(!res\.ok\)/g)).toBeGreaterThanOrEqual(1);
    expect(
      count(ACTION, /if \(!authRes\.ok\)|if \(!sessionRes\.ok\)|if \(!initiateRes\.ok\)/g),
    ).toBe(3);
    expect(ACTION).toContain("{phase === 'error' && note && (");
    expect(ACTION).toContain('<Banner kind="error">{note}</Banner>');
    expect(ACTION).toMatch(/setPhase\('error'\)/);
  });
});

describe('5: the existing customer flow is untouched', () => {
  it('adds no endpoint to the dashboard itself — the action is a child', () => {
    const dashTargets = Array.from(DASHBOARD.matchAll(/fetch\('([^']*)'/g)).map((m) => m[1]);
    expect(dashTargets).toEqual([
      '/api/customer/claims',
      '/api/customer/claims/link/request-otp',
      '/api/customer/claims/link/verify',
      '/api/customer/claims/',
    ]);
  });

  it('mounts the action exactly once and keeps the button/icon language', () => {
    expect(count(DASHBOARD, /<ClaimPaymentAction/g)).toBe(1);
    // The dashboard still has exactly one hand-rolled <button> (its section nav)
    // and every icon stays on the ICON_SIZE ladder, each hidden once.
    expect(count(DASHBOARD, /<button\s/g)).toBe(1);
    const iconSizes = count(DASHBOARD, /size=\{ICON_SIZE\.[a-z]+\}/g);
    expect(count(DASHBOARD, /aria-hidden="true"/g)).toBe(iconSizes);
  });

  it('keeps the raw phone out of the dashboard markup', () => {
    // The child receives the account phone through a plain local, so the raw
    // number is still never interpolated into the view (only maskPhone is).
    expect(DASHBOARD).toContain('{maskPhone(customer.phone)}');
    expect(DASHBOARD).not.toMatch(/\{customer\.phone\}/);
    expect(DASHBOARD).toContain('phone={accountPhone}');
  });

  it('leaves the owner journey the only other payment surface', () => {
    const owner = stripComments(read('src/components/OwnerView.tsx'));
    expect(owner).toContain('triggerEscrowPayment');
    // The action mirrors that flow rather than reimplementing the backend.
    expect(ACTION).toContain('payment-auth');
    expect(ACTION).toContain('payment-session');
  });
});

