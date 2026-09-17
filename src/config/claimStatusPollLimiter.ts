import rateLimit from 'express-rate-limit';

// DEDICATED RATE-LIMIT POLICY FOR THE POLLED CLAIM-STATUS ENDPOINT (Phase 7B.2)
// =============================================================================
// WHY THIS EXISTS — the F1 regression
// GET /api/claims/:id/status is not a "user action" endpoint: OwnerView polls
// it every 3 seconds while a claim is in flight. A 3-second cadence is 20
// requests per MINUTE, i.e. up to 300 requests inside one 15-minute window (the
// maximum a single continuous poller can generate in a window).
//
// Phase 7B attached the pre-existing `claimGuessLimiter` (20 requests / 15
// minutes) to this route. That limiter was designed for DISCRETE, guessable-ID
// operations (/lookup, /pay, /payment-auth, /payment-session, /:id/rate), and
// express-rate-limit instances are shared buckets, so all six routes drew from
// ONE 20-request budget per IP. The result: a legitimate owner exhausted the
// budget ~60 seconds into waiting for the agent, after which the poller
// silently received 429s (and their own /payment-auth and /pay calls also got
// 429s) — the claim could not be completed. Verified live in the Phase 7B.1
// audit: 21st status request → 429 with `RateLimit-Limit: 20;w=900`, and the
// same exhausted bucket returned 429 for /payment-auth and /lookup.
//
// This module gives the polled route its OWN policy, separate from the
// enumeration bucket, so polling can never starve discrete claim/payment
// operations (and vice versa). `claimGuessLimiter` is deliberately left
// untouched at 20/15 min for the routes it was designed for.
//
// CHOSEN POLICY
//   limit  : 600 requests
//   window : 15 minutes
//   keyed  : client IP (express-rate-limit default, identical to every other
//            limiter in this codebase, so `trust proxy` semantics stay uniform)
//
// WHY 600 IS APPROPRIATE (and not effectively unlimited)
//   * Legitimate ceiling: one continuous 3-second poller generates at most 300
//     requests per 15-minute window. 600 is exactly 2x that, which covers a
//     second claim/tab, page reloads that restart polling, the extra calls at
//     state transitions, and ordinary retry noise — while a single claim can
//     never come close to it.
//   * Still a real cap: it is 30x tighter than the previous exposure for an
//     enumerator (600 status probes per window instead of the unbounded
//     general limiter's 1000), and it sits below the global /api limiter
//     (generalLimiter: 1000/15 min in production), so this policy is not the
//     binding constraint on any legitimate flow but is a hard ceiling on
//     status-probing volume.
//   * IP keying (NOT claim-ID keying) is deliberate: a claim-scoped key would
//     give an enumerator a fresh 600-request bucket for every claim ID they
//     named, which would defeat the limiter entirely. It also keeps the
//     keyspace bounded — an attacker cannot grow limiter memory by inventing
//     claim IDs.
//
// This module is deliberately pure configuration + a factory so the limit
// mechanics can be exercised by real HTTP tests (see
// src/__tests__/claimStatusPollingRateLimit.test.ts) without needing 600
// requests, while server.ts mounts the shipped default instance below.

export const CLAIM_STATUS_POLL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const CLAIM_STATUS_POLL_MAX = 600;

/**
 * Builds the status-polling limiter. `overrides` exists so tests can exercise
 * the real limiter mechanics (threshold, headers, bucket isolation) with a
 * small threshold; production always uses the default instance below.
 */
export function createClaimStatusPollLimiter(
  overrides?: { windowMs?: number; max?: number }
): any {
  const windowMs = overrides?.windowMs ?? CLAIM_STATUS_POLL_WINDOW_MS;
  const max = overrides?.max ?? CLAIM_STATUS_POLL_MAX;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    // Worded distinctly from the discrete-claim limiter message on purpose:
    // when this appears in an operator's logs/alerts it should be obvious that
    // the STATUS-POLLING budget (not the enumeration budget) was reached.
    message: { error: 'Umeangalia hali ya dai hii mara nyingi mno hivi karibuni. Tafadhali subiri kidogo kisha pakia upya ukurasa. / We have checked this claim\'s status too many times recently. Please wait a moment, then refresh the page.' }
  });
}

/** The limiter actually mounted on GET /api/claims/:id/status in server.ts. */
export const claimStatusPollLimiter = createClaimStatusPollLimiter();

/**
 * The limiter for the OTHER polled claim route (Phase 12):
 * GET /api/claims/:id/payment-session/:sessionId/status.
 *
 * A SEPARATE INSTANCE, not a second mount of `claimStatusPollLimiter`, for the
 * reason this module's header already gives: express-rate-limit instances are
 * shared buckets, so mounting one instance on both polled routes would let the
 * payment poller drain the claim-status poller's budget (and vice versa) — the
 * exact cross-starvation defect that separated this policy from
 * claimGuessLimiter in the first place.
 *
 * WHY THE ROUTE NEEDS ONE AT ALL (reproduced Phase 12 finding): OwnerView polls
 * this endpoint on the same 3-second cadence as the claim-status route
 * (`payment_polling: 3`), but the route was registered with NO limiter at all —
 * unlike every other route in the claim family, and unlike its own sibling
 * polled route. That left an unauthenticated caller an unbounded budget for
 * claim-ID enumeration, and bounded nothing. The client already renders any
 * non-OK response's `error` text, so a 429 here degrades to a visible message
 * rather than a silent failure.
 */
export const paymentSessionStatusLimiter = createClaimStatusPollLimiter();
