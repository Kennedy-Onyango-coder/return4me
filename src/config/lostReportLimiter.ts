import rateLimit from 'express-rate-limit';

// DEDICATED RATE-LIMIT POLICY FOR LOST-REPORT CREATION (Phase 9A)
// ===============================================================
// A lost report is a real, persisted record that a future matcher will consume,
// so it is an obvious spam/flooding/enumeration target. Two independent
// buckets are used, mirroring the existing limiter architecture rather than
// inventing a second one:
//
//   1. lostReportIpLimiter — keyed by client IP (express-rate-limit default,
//      identical to every other limiter in this codebase, so `trust proxy`
//      semantics stay uniform). Mounted BEFORE authentication so an
//      unauthenticated flood is still capped.
//   2. lostReportCustomerLimiter — keyed by the AUTHENTICATED customer id.
//      Mounted AFTER requireCustomerAuth. An IP-independent ceiling: a single
//      account cannot flood the table by rotating IPs, and the keyspace is
//      bounded by real accounts (an attacker cannot grow limiter memory by
//      inventing keys).
//
// This module is deliberately pure configuration + factories so the limiter
// mechanics can be exercised by real HTTP tests with a small threshold (see
// src/__tests__/lostReportRoutes.test.ts), while server.ts mounts the shipped
// default instances below — the same pattern as config/claimStatusPollLimiter.ts.

export const LOST_REPORT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Production caps are deliberately modest: a genuine person files a handful of
// lost reports in a lifetime, never 20 in a quarter of an hour.
export const LOST_REPORT_IP_MAX = process.env.NODE_ENV === 'production' ? 12 : 1000;
export const LOST_REPORT_CUSTOMER_MAX = process.env.NODE_ENV === 'production' ? 8 : 1000;

function buildLimiter(max: number, windowMs: number, keyGenerator: any, message: string, perCustomer: boolean): any {
  const config: any = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    message: { error: message },
  };
  if (perCustomer) config.keyGenerator = keyGenerator;
  return rateLimit(config);
}

export function createLostReportIpLimiter(
  overrides?: { windowMs?: number; max?: number }
): any {
  return buildLimiter(
    overrides?.max ?? LOST_REPORT_IP_MAX,
    overrides?.windowMs ?? LOST_REPORT_WINDOW_MS,
    undefined,
    'Maombi mengi ya kuripoti bidhaa iliyopotea. Tafadhali subiri dakika chache. / Too many lost-item report attempts. Please wait a few minutes.',
    false
  );
}

export function createLostReportCustomerLimiter(
  overrides?: { windowMs?: number; max?: number }
): any {
  return buildLimiter(
    overrides?.max ?? LOST_REPORT_CUSTOMER_MAX,
    overrides?.windowMs ?? LOST_REPORT_WINDOW_MS,
    // req.customer is set by requireCustomerAuth, which is mounted immediately
    // before this limiter, so the bucket follows the authenticated account —
    // never a value the caller could choose.
    (req: any) => `lost-report-customer:${req?.customer?.id || req.ip || 'unknown'}`,
    'Umeripoti bidhaa zilizopotea mara nyingi mno hivi karibuni. Tafadhali subiri dakika chache. / You have filed too many lost-item reports recently. Please wait a few minutes.',
    true
  );
}

/** The IP-keyed limiter mounted on POST /api/lost-reports in routes/lostReports.ts. */
export const lostReportIpLimiter = createLostReportIpLimiter();

/** The customer-keyed limiter mounted on POST /api/lost-reports. */
export const lostReportCustomerLimiter = createLostReportCustomerLimiter();

// ---------------------------------------------------------------------------
// PHASE 9B — MATCHING POLICY
// ---------------------------------------------------------------------------
// GET /api/lost-reports/:id/matches is an authenticated READ, but it is not
// free: every request loads the currently-claimable item set and scores it with
// the matching engine. Two independent buckets are used, mirroring the creation
// policy above and the rest of the codebase:
//   * IP-keyed       — bounds an unauthenticated flood (mounted before auth).
//   * Customer-keyed — an IP-independent ceiling per account, so one account
//     cannot repeatedly run the scorer by rotating addresses.
// A genuine customer opens their own report's matches a handful of times, so
// the production caps stay modest while being generous for normal use.

export const LOST_REPORT_MATCH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const LOST_REPORT_MATCH_IP_MAX = process.env.NODE_ENV === 'production' ? 30 : 1000;
export const LOST_REPORT_MATCH_CUSTOMER_MAX = process.env.NODE_ENV === 'production' ? 20 : 1000;

export function createLostReportMatchIpLimiter(
  overrides?: { windowMs?: number; max?: number }
): any {
  return buildLimiter(
    overrides?.max ?? LOST_REPORT_MATCH_IP_MAX,
    overrides?.windowMs ?? LOST_REPORT_MATCH_WINDOW_MS,
    undefined,
    'Maombi mengi ya kutafuta mechi. Tafadhali subiri dakika chache. / Too many match lookups. Please wait a few minutes.',
    false
  );
}

export function createLostReportMatchCustomerLimiter(
  overrides?: { windowMs?: number; max?: number }
): any {
  return buildLimiter(
    overrides?.max ?? LOST_REPORT_MATCH_CUSTOMER_MAX,
    overrides?.windowMs ?? LOST_REPORT_MATCH_WINDOW_MS,
    // req.customer is set by requireCustomerAuth, mounted immediately before
    // this limiter, so the bucket follows the authenticated account.
    (req: any) => `lost-report-match:${req?.customer?.id || req.ip || 'unknown'}`,
    'Umetafuta mechi mara nyingi mno hivi karibuni. Tafadhali subiri dakika chache. / You have looked up matches too many times recently. Please wait a few minutes.',
    true
  );
}

/** The IP-keyed limiter mounted on GET /api/lost-reports/:id/matches. */
export const lostReportMatchIpLimiter = createLostReportMatchIpLimiter();

/** The customer-keyed limiter mounted on GET /api/lost-reports/:id/matches. */
export const lostReportMatchCustomerLimiter = createLostReportMatchCustomerLimiter();
