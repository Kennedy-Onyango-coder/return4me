// =============================================================================
// N6 — DURABLE SMS RATE LIMITING (request layer).
//
// WHERE THIS LIVES, AND WHY IT IS NOT INSIDE NotificationService
//
//   The canonical SMS path is:
//
//     request → identity → SMS RATE LIMIT → NotificationService → idempotency
//     → provider adapter
//
//   Rate limiting sits at the REQUEST layer because it is a property of a
//   REQUEST, not of a notification: it is keyed on the originating client IP and
//   on an authenticated principal, neither of which NotificationService can
//   know. A notification may legitimately be produced by a background sweep, an
//   admin action or a webhook — none of which has a client IP at all — so
//   putting IP limiting inside the service would either break those callers or
//   force the service to accept a caller-supplied IP, which is exactly the kind
//   of untrusted input that makes an IP limit meaningless.
//
//   Idempotency, by contrast, STAYS in NotificationService, because it is a
//   property of the notification itself. Nothing in this file may deduplicate a
//   send.
//
// THE LIMIT ITSELF
//   3 requests per rolling 10 minutes, enforced for BOTH identity dimensions
//   the requirement names:
//
//     * IP    — always, including for anonymous callers.
//     * User  — additionally, whenever the request carries a TRUSTWORTHY
//               authenticated identity.
//
//   Consuming both is deliberate. IP alone is defeatable by an attacker who
//   rotates source addresses; the user dimension alone is defeatable by anyone
//   sending unauthenticated requests. Together a caller must satisfy both, so
//   neither is a single point of bypass.
//
// NOT TRUSTWORTHY, AND THEREFORE NEVER A LIMIT KEY
//   req.body.userId, req.query.userId, req.body.phone and any other
//   client-supplied identifier. Keying a limit on them would let a caller pick a
//   fresh identity per request and defeat the limit completely. Only a
//   server-verified principal is used, and the raw identity is HASHED before it
//   is stored, so the table never becomes a log of who connects from where.
// =============================================================================

import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { db } from '../db/database.ts';

/** The N1/N6 requirement: 3 SMS requests per rolling 10 minutes. */
export const SMS_RATE_LIMIT = 3;
export const SMS_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * The rate-limit response. Generic and identical for every reason, so it can
 * never be used to probe whether an account, phone number or IP is known to the
 * system — the same anti-enumeration property the OTP routes rely on. It also
 * never echoes the identity that was limited.
 */
const RATE_LIMIT_BODY = {
  error:
    'Mafti ya maombi ya ujumbe mfupi umefikia kikomo. Tafadhali subiri kidogo kabla ya kujaribu tena. / Too many SMS requests. Please wait before trying again.',
};

/**
 * A keyed HASH of the request identity — never the raw IP, user id or phone.
 *
 * Keyed with the deployment salt (the same fallback chain services/documentHash
 * uses) so the bucket key is stable across restarts and instances, and so the
 * table is not a reverseable index of who connects from where. The `scope`
 * prefix keeps the IP and user dimensions in separate namespaces, so a user id
 * that happens to look like an address can never share a bucket with an IP.
 */
export function buildSmsRateLimitBucketKey(scope: 'ip' | 'user', identifier: string): string {
  const salt = process.env.DOC_HASH_SALT || process.env.JWT_SECRET || 'RETURN4ME_DEFAULT_SALT_VALUE_FOR_DOCUMENT_HASHING';
  return crypto
    .createHmac('sha256', salt)
    .update(`${scope}:${String(identifier ?? '').trim().toLowerCase()}`)
    .digest('hex');
}

/**
 * Resolves the identities to rate-limit for a request.
 *
 * ORDER MATTERS: the user identity is only accepted from a server-verified
 * principal. `req.user` is populated by authenticateJWT from a signature it
 * verified, and `req.customer` by requireCustomerAuth from a hashed session
 * lookup — both trustworthy. Anything on `req.body` or `req.query` is not, and
 * is never consulted.
 */
export function resolveSmsRateLimitIdentities(req: Request): string[] {
  const keys: string[] = [];

  // 1. IP — always, for every caller, authenticated or not. With `trust proxy`
  //    set, Express derives this from X-Forwarded-For as the deployment
  //    configures it; an unresolvable address is not silently allowed through.
  const ip = (req as any).ip;
  if (typeof ip === 'string' && ip.trim() !== '') {
    keys.push(buildSmsRateLimitBucketKey('ip', ip));
  }

  // 2. User — only from a verified principal.
  const verifiedUserId =
    (req as any).user?.userId || (req as any).user?.id || (req as any).customer?.id || null;
  if (typeof verifiedUserId === 'string' && verifiedUserId.trim() !== '') {
    keys.push(buildSmsRateLimitBucketKey('user', verifiedUserId));
  }

  return keys;
}

/**
 * Consumes one unit of quota for every identity dimension the request carries.
 *
 * All dimensions are consumed even if an EARLIER one is already exhausted. That
 * is intentional: otherwise a caller could probe "is my IP limited?" and then
 * keep retrying until the user dimension happened to let them through, which
 * collapses two independent protections into one. Consuming both is the only way
 * "both must pass" is actually true.
 */
export async function consumeSmsRateLimit(
  identities: string[]
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  let retryAfterSeconds = 0;
  for (const key of identities) {
    const outcome = await db.consumeSmsRateLimitSlot(key, SMS_RATE_LIMIT, SMS_RATE_LIMIT_WINDOW_MS);
    if (!outcome.allowed) {
      // Keep the LONGEST wait, so the client is never told to retry sooner than
      // every dimension actually permits.
      retryAfterSeconds = Math.max(retryAfterSeconds, outcome.retryAfterSeconds);
    }
  }
  return { allowed: retryAfterSeconds === 0, retryAfterSeconds };
}

/**
 * The Express middleware N7 attaches to SMS-triggering routes.
 *
 * It must be mounted AFTER any authentication middleware and BEFORE anything
 * that can reach a provider, which is exactly the ordering in the canonical
 * path: `authenticateJWT, smsRateLimit, <handler>`. Mounting it before auth would
 * leave it with no trustworthy user dimension, and mounting it after the handler
 * would be too late — the SMS would already be spent.
 *
 * WHAT IT GUARANTEES ON REFUSAL
 *   * `next()` is NOT called, so the route handler never runs.
 *   * The provider is never invoked.
 *   * No notification_events row is created, so a refused request can never be
 *     recorded as a `sent` notification — which is the specific false record
 *     that would make an audit trail lie.
 *   * The body is the SAME generic message for every cause, so the response
 *     cannot be used to discover whether an IP or account is known.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not deduplicate notifications (that is NotificationService's job)
 *   and it does not retry anything (N9 owns fallback).
 */
export function smsRateLimit() {
  return async function smsRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
      const identities = resolveSmsRateLimitIdentities(req);
      // No identity at all (no IP and no principal) is treated as unlimited only
      // if it is genuinely impossible to identify anyone; in practice req.ip is
      // always set, so this branch is defensive and FAILS CLOSED.
      if (identities.length === 0) {
        res.setHeader('Retry-After', String(SMS_RATE_LIMIT_WINDOW_MS / 1000));
        return res.status(429).json(RATE_LIMIT_BODY);
      }

      const outcome = await consumeSmsRateLimit(identities);
      if (!outcome.allowed) {
        // Standard rate-limit headers, matching the convention the existing
        // express-rate-limit instances already emit.
        res.setHeader('RateLimit-Limit', String(SMS_RATE_LIMIT));
        res.setHeader('RateLimit-Remaining', '0');
        res.setHeader('RateLimit-Reset', String(outcome.retryAfterSeconds));
        res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
        return res.status(429).json(RATE_LIMIT_BODY);
      }

      return next();
    } catch (error) {
      // FAIL CLOSED. If the limiter itself is broken, an unmetered SMS send is
      // the worse outcome: it costs money and can be aimed at a third party.
      // Refusing the request is safe, retryable by the user, and preserves the
      // existing generic anti-enumeration shape.
      console.error('[SMS RATE LIMIT] Unavailable; refusing request:', error);
      res.setHeader('Retry-After', String(SMS_RATE_LIMIT_WINDOW_MS / 1000));
      return res.status(429).json(RATE_LIMIT_BODY);
    }
  };
}
