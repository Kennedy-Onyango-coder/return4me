// =============================================================================
// E1-H2 — ADMISSION CONTROL FOR THE EMAIL IDENTITY-CHANGE BRANCH.
//
// THE GAP THIS CLOSES
//   `POST /api/customer/profile/identity` carried only `requireCustomerAuth`.
//   The `kind: 'phone'` branch was later mounted on the shared N6 SMS budget
//   (N10-A), but the `kind: 'email'` branch stayed unmetered, so ONE
//   authenticated session could generate an unbounded number of email one-time
//   codes, addressed to an arbitrary number of arbitrary live mailboxes. An
//   authenticated account could therefore use this endpoint as a general
//   purpose mail-sending primitive. Account-level authorization was never the
//   problem — unbounded issuance from one account was.
//
// WHY A SEPARATE BUDGET, AND NOT `smsRateLimit()`
//   `smsRateLimit()` is the SMS budget: its buckets ARE the product's "3 SMS per
//   10 minutes" promise, shared by login, claim-link, pickup-code and the phone
//   identity change. Charging an email send to that budget would let an email
//   change consume an SMS allowance it never spends, and would let SMS activity
//   from one flow refuse an unrelated email change. That is a semantic change to
//   an unrelated flow, which is exactly what must not happen here.
//
//   So this file adds a NARROW, second budget that reuses the SAME canonical
//   primitive (`buildSmsRateLimitBucketKey` + `db.consumeSmsRateLimitSlot`, the
//   durable true-rolling-window admission control) in its OWN namespace. One
//   implementation of the limiter, two independent budgets — no second
//   mechanism, no shared counter.
//
// THE POLICY
//   The established, documented budget shape: 3 issuances per rolling 10
//   minutes, charged on EVERY identity dimension the request carries, and a
//   request is admitted only when every dimension admits it.
//
// THE DIMENSIONS, AND WHY EACH ONE IS HERE
//   1. The AUTHENTICATED CUSTOMER (`req.customer.id`, put there by
//      requireCustomerAuth from a hashed session lookup). BINDING: this is what
//      makes the limit impossible to escape by changing the requested address —
//      twenty requests from one account are twenty charges on one bucket,
//      whether or not every request named a different mailbox.
//   2. The CLIENT IP (`req.ip`). The existing budget's second dimension, for the
//      same reason it exists there: the user dimension alone is defeatable by an
//      unauthenticated caller, and the IP dimension alone by address rotation.
//   3. The TARGET ADDRESS being proved, taken from the request body. ADDITIVE
//      ONLY — the account dimension already bounds total issuance, so this
//      dimension can never be a bypass; it exists so that a spray aimed at ONE
//      mailbox (many accounts, many addresses, one victim) is refused at the
//      destination as well. It is never the sole key, never an authorization
//      input, and never stored raw: only its keyed hash reaches the bucket table.
//
//   NOT A KEY: nothing else from `req.body` or `req.query`. A client-supplied
//   identifier as the only key would let a caller mint a fresh identity per
//   request, which is what makes a rate limit meaningless.
//
// WHAT IT GUARANTEES ON REFUSAL
//   `next()` is not called, so the handler never runs; no identity-change row is
//   written and no email one-time code is issued; and the body is the SAME
//   generic message for every cause, so the refusal cannot be used to probe
//   whether an address exists or belongs to somebody else.
// =============================================================================

import type { NextFunction, Request, Response } from 'express';
import { db } from '../db/database.ts';
import { buildSmsRateLimitBucketKey } from './smsRateLimit.ts';

/**
 * The email identity-change budget: 3 issuances per rolling 10 minutes.
 *
 * The same shape as every other code budget in the product, and comfortably
 * above what a legitimate customer needs (a change, a retry after a typo, and
 * one re-send), while bounding issuance from a single account or to a single
 * mailbox.
 */
export const IDENTITY_EMAIL_RATE_LIMIT = 3;
export const IDENTITY_EMAIL_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Namespaces. Distinct from 'ip'/'user' so an email-change bucket can never
 * collide with the SMS budget's — the two limits are independent by
 * construction, not by convention.
 */
export const IDENTITY_EMAIL_PRINCIPAL_SCOPE = 'identity-email-principal';
export const IDENTITY_EMAIL_IP_SCOPE = 'identity-email-ip';
export const IDENTITY_EMAIL_TARGET_SCOPE = 'identity-email-target';

/**
 * The refusal message, exported so tests and callers can reference ONE definition
 * rather than re-typing the copy.
 */
export const IDENTITY_EMAIL_RATE_LIMIT_MESSAGE =
  'Too many verification requests. Please wait before trying again.';

/**
 * The refusal body. Deliberately free of SMS wording (an email change is not an
 * SMS flow), of any internal term (counter, bucket, provider, retry class) and
 * of the identity that was limited, so it discloses nothing about the account or
 * the address beyond "too many verification requests for now".
 */
const RATE_LIMIT_BODY = { error: IDENTITY_EMAIL_RATE_LIMIT_MESSAGE };


/** The client IP — always a dimension, exactly as the SMS budget treats it. */
function resolveClientIp(req: Request): string {
  const ip = (req as any).ip;
  return typeof ip === 'string' ? ip.trim() : '';
}

/** The session-verified customer id, or '' when there is none. */
function resolveVerifiedCustomerId(req: Request): string {
  const id = (req as any).customer?.id;
  return typeof id === 'string' ? id.trim() : '';
}

/**
 * The claimed target address, used ONLY as an anti-spray key component.
 *
 * Read for nothing else: it never becomes a destination (the route resolves the
 * destination from the authoritative record) and it never participates in
 * authorization. Normalized the same trivial way the bucket key normalizes every
 * identifier — lowercased and trimmed — so two spellings of one mailbox share
 * one bucket.
 */
function resolveTargetAddress(req: Request): string {
  const value = (req as any).body?.value;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Every identity dimension this request must pass, already hashed.
 *
 * Order is irrelevant (all are consumed), but the caller id is first so a
 * truncated log or a partial failure still leaves the binding dimension applied.
 */
export function resolveIdentityEmailRateLimitIdentities(req: Request): string[] {
  const keys: string[] = [];

  const customerId = resolveVerifiedCustomerId(req);
  if (customerId) {
    keys.push(buildSmsRateLimitBucketKey(IDENTITY_EMAIL_PRINCIPAL_SCOPE, customerId));
  }

  const ip = resolveClientIp(req);
  if (ip) {
    keys.push(buildSmsRateLimitBucketKey(IDENTITY_EMAIL_IP_SCOPE, ip));
  }

  const target = resolveTargetAddress(req);
  if (target) {
    keys.push(buildSmsRateLimitBucketKey(IDENTITY_EMAIL_TARGET_SCOPE, target));
  }

  return keys;
}

/**
 * Consumes one unit on EVERY dimension, even after an earlier one is already
 * exhausted — the same deliberate choice `consumeSmsRateLimit` documents, so
 * "every dimension must admit this request" is actually true rather than
 * "the first dimension that refuses".
 */
export async function consumeIdentityEmailRateLimit(
  identities: string[],
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  let retryAfterSeconds = 0;
  for (const key of identities) {
    const outcome = await db.consumeSmsRateLimitSlot(
      key,
      IDENTITY_EMAIL_RATE_LIMIT,
      IDENTITY_EMAIL_RATE_LIMIT_WINDOW_MS,
    );
    if (!outcome.allowed) {
      // Keep the LONGEST wait: a client must never be told to retry sooner than
      // every dimension actually permits.
      retryAfterSeconds = Math.max(retryAfterSeconds, outcome.retryAfterSeconds);
    }
  }
  return { allowed: retryAfterSeconds === 0, retryAfterSeconds };
}

/**
 * The middleware the identity route mounts on its EMAIL branch.
 *
 * It runs AFTER `requireCustomerAuth` (so its binding identity is the verified
 * session, not a claim in the body) and BEFORE the handler (so no code is
 * generated, nothing is persisted and no mailbox is written to when it refuses).
 * It emits the project's standard refusal: HTTP 429, the RateLimit-* headers and
 * Retry-After the other limiters already use, and the generic body above.
 */
export function identityEmailChangeRateLimit() {
  return async function identityEmailChangeRateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const identities = resolveIdentityEmailRateLimitIdentities(req);
      // Defensive and FAIL-CLOSED: with `requireCustomerAuth` in front of it a
      // principal always exists, so this branch should be unreachable. An
      // unattributable request must not be allowed to issue a code.
      if (identities.length === 0) {
        res.setHeader('Retry-After', String(IDENTITY_EMAIL_RATE_LIMIT_WINDOW_MS / 1000));
        return res.status(429).json(RATE_LIMIT_BODY);
      }

      const outcome = await consumeIdentityEmailRateLimit(identities);
      if (!outcome.allowed) {
        res.setHeader('RateLimit-Limit', String(IDENTITY_EMAIL_RATE_LIMIT));
        res.setHeader('RateLimit-Remaining', '0');
        res.setHeader('RateLimit-Reset', String(outcome.retryAfterSeconds));
        res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
        return res.status(429).json(RATE_LIMIT_BODY);
      }

      return next();
    } catch (error) {
      // FAIL CLOSED, like the SMS budget: an unbounded email primitive that can
      // be aimed at a third party's mailbox is the worse outcome. The refusal is
      // retryable by the customer and keeps the generic anti-enumeration shape.
      console.error('[IDENTITY EMAIL RATE LIMIT] Unavailable; refusing request:', error);
      res.setHeader('Retry-After', String(IDENTITY_EMAIL_RATE_LIMIT_WINDOW_MS / 1000));
      return res.status(429).json(RATE_LIMIT_BODY);
    }
  };
}
