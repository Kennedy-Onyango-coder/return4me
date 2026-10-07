// =============================================================================
// BATCH 2 - CUSTOMER ACCOUNT DATA & SESSION SECURITY (routes).
//
// WHY A SEPARATE MODULE
//   server.ts constructs the application and calls startServer() at import time,
//   so it cannot be imported by a test. Registering into the caller Express app is
//   the same extracted-module pattern routes/customerClaims.ts and
//   routes/customerNotifications.ts already use, and it lets the HTTP tests mount
//   a REAL app around the REAL middleware and the REAL handlers.
//
// AUTHORIZATION MODEL (H9, G1, G2, G3)
//   Identity comes ONLY from req.customer, resolved by requireCustomerAuth from
//   the session cookie hash. No customer id is ever read from a body, a query
//   string, a path segment or a header, so there is nothing for a caller to
//   tamper with. Every handler passes req.customer.id into a service method whose
//   SQL is scoped by customer_id.
//
//   A resource belonging to another customer produces the SAME response as one
//   that does not exist (404 / not-found), deliberately: distinguishing them
//   would be an existence oracle for another customer's identifiers.
//
// RE-AUTHENTICATION (G2, G3)
//   Erasure and identifier changes are the two most sensitive things a customer
//   can do to an account, so both require a fresh one-time code proved against
//   the CURRENT identifier before anything changes. A stolen session cookie
//   alone cannot silently destroy an account or repoint its identity.
// =============================================================================

import crypto from 'crypto';

import { requireCustomerAuth } from '../services/customerAuth.ts';
import { smsRateLimit } from '../services/smsRateLimit.ts';
import { identityEmailChangeRateLimit } from '../services/identityChangeRateLimit.ts';
import { db } from '../db/database.ts';
import { hashCode, toE164Kenyan } from '../services/auth.ts';
import { generateSecureId } from '../services/customerAuth.ts';
import {
  emailOtpRecipientIsSafe,
  EMAIL_VERIFICATION_REQUIRED_MESSAGE,
} from '../services/emailOtp.ts';
import {
  CUSTOMER_ACCOUNT_STRINGS,
  IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS,
  IDENTITY_CHANGE_VERIFICATION_TTL_MS,
  deriveDeviceLabel,
} from '../config/customerAccountPolicy.ts';

const SERVER_ERROR = {
  error: 'Hitilafu imetokea upande wa seva. Tafadhali jaribu tena baadaye.',
};
const NOT_FOUND = { error: 'Haijapatikana. / Not found.' };
const BAD_REQUEST = { error: 'Ombi la awali si sahihi. / Invalid request.' };

/** Six digits, generated server-side. The plaintext is never stored. */
function newVerificationCode(): string {
  // CSPRNG, NOT Math.random(). This code is the ONLY proof of control over the
  // identifier being claimed, so its unpredictability is a security property:
  // Math.random() is not cryptographically secure and its stream is predictable
  // from a few observed outputs. `randomInt(low, high)` is uniform with no modulo
  // bias and matches the generator every other one-time code in the codebase uses
  // (see services/customerAuth.ts).
  return crypto.randomInt(100000, 1000000).toString();
}

/** Opaque id for a verification attempt; safe to return since it grants nothing alone. */
function newVerificationId(): string {
  return generateSecureId('CICH');
}

export function registerCustomerAccountRoutes(app: any, deps: {
  /**
   * Sends the one-time verification message for an identity change.
   *
   * Injected rather than called directly so this module never imports a
   * delivery mechanism: the account layer decides WHAT must be verified, and the
   * injected seam decides how to deliver it (E1: the shared email OTP seam in
   * services/emailOtp.ts, reached from server.ts). Delivery failure is
   * therefore invisible here and cannot roll back a business decision.
   */
  sendVerificationCode: (input: {
    destination: string;
    code: string;
    kind: 'email' | 'phone';
  }) => Promise<boolean>;
}) {
  const { sendVerificationCode } = deps;

  // ==========================================================================
  // H9-a - SESSION / DEVICE VISIBILITY
  // ==========================================================================
  app.get('/api/customer/sessions', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const rows = await db.listCustomerSessions(req.customer.id);
      const currentId = req.customerSession.id;
      // Projected field by field. `token_hash` and the raw User-Agent are read by
      // the query but NEVER copied into the response: the device is shown as a
      // short label the customer recognises, which is all they need to decide
      // whether a session is theirs.
      const sessions = rows.map((s: any) => {
        const device = deriveDeviceLabel(s.user_agent);
        return {
          id: s.id,
          device: device.label,
          platform: device.platform,
          current: s.id === currentId,
          createdAt: s.created_at ? new Date(s.created_at).toISOString() : null,
          lastSeenAt: s.last_seen_at ? new Date(s.last_seen_at).toISOString() : null,
          expiresAt: s.expires_at ? new Date(s.expires_at).toISOString() : null,
          // A revoked session is shown, not hidden: the customer can see what they
          // already signed out of, which is what makes "sign out other devices"
          // legible after the fact.
          revoked: s.revoked_at != null,
        };
      });
      return res.json({ sessions });
    } catch (e) {
      console.error('[CUSTOMER_SESSIONS_LIST_ERROR]', e);
      return res.status(500).json(SERVER_ERROR);
    }
  });

  // ==========================================================================
  // H9-b - SIGN OUT OTHER SESSIONS
  //
  // Deliberately NOT a per-session revoke endpoint. "Sign out other devices" is
  // the product requirement; allowing a caller to name an arbitrary session id
  // would add an identifier-guessing surface for no product benefit, since the
  // customer never needs to revoke one specific other session.
  // ==========================================================================
  app.post('/api/customer/sessions/revoke-others', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const revoked = await db.revokeAllOtherCustomerSessions(
        req.customer.id,
        req.customerSession.id,
      );
      return res.json({
        success: true,
        revoked,
        message: CUSTOMER_ACCOUNT_STRINGS.revokeOthersDone.en,
      });
    } catch (e) {
      console.error('[CUSTOMER_SESSIONS_REVOKE_OTHERS_ERROR]', e);
      return res.status(500).json(SERVER_ERROR);
    }
  });

  // ==========================================================================
  // G1 - DATA EXPORT
  //
  // Machine-readable (JSON) and scoped to the session customer. The shape is
  // built as an allow-list in db.exportCustomerData, so a field that was never
  // selected cannot appear here - which is how a token hash, a one-time code or
  // a delivery error is excluded by construction rather than by remembering to
  // strip it.
  // ==========================================================================
  app.get('/api/customer/data-export', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const payload = await db.exportCustomerData(req.customer.id);
      if (!payload) return res.status(404).json(NOT_FOUND);
      return res.json(payload);
    } catch (e) {
      console.error('[CUSTOMER_DATA_EXPORT_ERROR]', e);
      return res.status(500).json(SERVER_ERROR);
    }
  });

  // ==========================================================================
  // G3 - PROFILE
  //
  // Name updates immediately: it is not an identifier anything authenticates with.
  // Email and phone do NOT, and cannot, bypass verification - see the two
  // endpoints below.
  // ==========================================================================
  app.patch('/api/customer/profile', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : null;
      if (fullName === null) return res.status(400).json(BAD_REQUEST);
      if (fullName.length < 2 || fullName.length > 120) {
        return res.status(400).json({
          error: 'Tafadhali weka jina lako kamili. / Please enter your full name.',
        });
      }
      const ok = await db.updateCustomerName(req.customer.id, fullName);
      if (!ok) return res.status(404).json(NOT_FOUND);
      const customer = await db.getCustomerById(req.customer.id);
      return res.json({ success: true, customer: toSafeProfile(customer) });
    } catch (e) {
      console.error('[CUSTOMER_PROFILE_UPDATE_ERROR]', e);
      return res.status(500).json(SERVER_ERROR);
    }
  });

  /**
   * Begin an email or phone change (G3).
   *
   * The authoritative customer row is NOT touched. A one-time code is sent to the
   * mailbox that proves the change (the NEW address for an email change, this
   * account's existing VERIFIED email for a phone change), and until that code is
   * redeemed the old identifier continues to authenticate exactly as before. If
   * the customer abandons the change, nothing has moved - which is the property
   * that makes this safe to attempt.
   */
  // ---------------------------------------------------------------------------
  // N10-A — SHARED CODE BUDGET (PHONE) + E1-H2 EMAIL BUDGET.
  //
  // `kind === 'phone'` is the branch that carried the pre-E1 SMS. After the E1
  // migration BOTH kinds are delivered by email. The PHONE branch's metering
  // scope stayed exactly as N10-A left it. The EMAIL branch — which this route
  // mounted with `requireCustomerAuth` alone for years, so an authenticated
  // customer could trigger an unbounded number of codes to arbitrary addresses —
  // was the remaining gap, and E1-H2 meters it (see below). Its only guard was
  // the identifier-collision
  // 409, which deliberately EXCLUDES the caller's own id, so repeating the call
  // with the same number was always allowed.
  //
  // This reuses the EXISTING limiter — the same module, the same
  // `smsRateLimit()` instance semantics, 3 per rolling 10 minutes, the same
  // shared buckets as OWNER_CLAIM_VERIFICATION_CODE / PICKUP_CODE /
  // CLAIM_LINK_OTP / CUSTOMER_LOGIN_OTP, the same generic bilingual 429 and the
  // same fail-closed behaviour. It is NOT a second limiter and NOT a
  // route-specific quota: the one middleware instance below is created once and
  // consulted only when this request comes from the branch that has always been
  // metered.
  //
  // WHY THE CONDITION IS ON THE REQUEST BODY BUT NOT ON THE IDENTITY
  //   `kind` decides only WHETHER THIS BRANCH IS METERED. The rate-limit IDENTITY
  //   is still resolved entirely server-side by `resolveSmsRateLimitIdentities`,
  //   which reads only `req.ip` and the session-verified `req.customer.id`;
  //   `req.body` is never consulted for the bucket, the recipient, or the
  //   principal. That is why the branch selection below reads `kind` and nothing
  //   else from the body: `kind` chooses WHICH budget applies, never the bucket
  //   key, and never the recipient.
  //
  // ORDERING
  //   `requireCustomerAuth, <budget>, <handler>` — the canonical N6/N7 order.
  //   Auth runs first so the user dimension comes from the verified session,
  //   and the budget is spent before any provider call. `express.json()` has
  //   already parsed the body, which is what makes `kind` readable here.
  // ---------------------------------------------------------------------------
  const identitySmsBudget = smsRateLimit();
  // ---------------------------------------------------------------------------
  // E1-H2 — THE EMAIL BRANCH'S OWN BUDGET (the residual N10-A left open).
  //
  // N10-A metered `kind: 'phone'` and stopped there, so `kind: 'email'` remained
  // the one unmetered code producer in the product: one authenticated session
  // could ask for an unbounded number of codes, each addressed to an arbitrary
  // live mailbox. THIS is that gap closed.
  //
  // WHY NOT `smsRateLimit()` HERE
  //   The SMS budget's buckets ARE the "3 SMS per 10 minutes" promise shared by
  //   login, claim-link, pickup-code and the phone change. Charging an email
  //   send to them would let an email change eat an SMS allowance it never
  //   spends, and would let unrelated SMS activity refuse an email change — a
  //   semantic change to flows this batch must not touch. So the email branch
  //   gets a NARROW second budget built on the SAME canonical primitive
  //   (`buildSmsRateLimitBucketKey` + `db.consumeSmsRateLimitSlot`) in its own
  //   namespace: one limiter implementation, two independent budgets.
  //
  // ITS IDENTITY IS STILL SERVER-RESOLVED
  //   `resolveIdentityEmailRateLimitIdentities` reads `req.customer.id` (from
  //   the hashed session lookup requireCustomerAuth performed) and `req.ip`
  //   first; the requested address contributes ONE extra, ADDITIVE dimension so
  //   a spray aimed at a single mailbox is refused at that mailbox too. Because
  //   the account dimension is always charged, changing the requested address on
  //   every request cannot widen anything.
  //
  // ORDERING: `requireCustomerAuth, <budget>, <handler>` — the same canonical
  // order as the phone branch. Auth first (so the principal is the verified
  // session), budget second (so a refusal happens before any code is generated,
  // before any change row is written and before any mailbox is written to).
  // ---------------------------------------------------------------------------
  const identityEmailBudget = identityEmailChangeRateLimit();
  app.post(
    '/api/customer/profile/identity',
    requireCustomerAuth,
    (req: any, res: any, next: any) => {
      // `kind` selects WHICH budget applies and nothing else — it is never a
      // bucket key, a destination or an authorization input. An unknown kind is
      // passed through unmetred on purpose: the handler rejects it with a 400
      // before any code could be issued.
      if (req.body?.kind === 'phone') return identitySmsBudget(req, res, next);
      if (req.body?.kind === 'email') return identityEmailBudget(req, res, next);
      return next();
    },
    async (req: any, res: any) => {
    try {
      const kind = req.body?.kind;
      if (kind !== 'email' && kind !== 'phone') return res.status(400).json(BAD_REQUEST);

      const normalized = normalizeTarget(kind, req.body?.value);
      if (!normalized) return res.status(400).json({ error: invalidTargetMessage(kind) });

      // Another account already holding this identifier must not be claimable.
      if (await db.isCustomerIdentifierTaken(kind, normalized, req.customer.id)) {
        return res.status(409).json({ error: takenMessage(kind) });
      }

      // E1 - WHO RECEIVES THE CODE (destination resolved SERVER-SIDE).
      //   kind 'email'  -> the NEW address itself: proving control of it is the
      //                    whole point of the change.
      //   kind 'phone'  -> THIS account's existing VERIFIED email, read from the
      //                    session's own authoritative record. The new number is
      //                    never a delivery destination: an unproven number must
      //                    not be handed a code that would mark it verified, and
      //                    nothing in this flow may trust a destination from the
      //                    body. An account without a verified email FAILS CLOSED
      //                    BEFORE any challenge row is written, so no orphan
      //                    change exists to be redeemed later.
      let destination = normalized;
      if (kind === 'phone') {
        const account = await db.getCustomerById(req.customer.id);
        destination =
          account && account.email && account.email_verified_at && emailOtpRecipientIsSafe(account.email)
            ? account.email
            : '';
        if (!destination) {
          return res.status(403).json({ error: EMAIL_VERIFICATION_REQUIRED_MESSAGE });
        }
      }

      const code = newVerificationCode();
      const changeId = newVerificationId();
      await db.createCustomerIdentityChange({
        id: changeId,
        customerId: req.customer.id,
        kind,
        targetValue: normalized,
        // Only the HASH is persisted, so a leaked database cannot be used to
        // complete someone else's identity change.
        codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + IDENTITY_CHANGE_VERIFICATION_TTL_MS),
      });

      // A delivery failure must NOT roll back the recorded change and must not
      // be described to the customer in transport terms; the honest message is
      // that the verification is on its way, and the customer can retry.
      const delivered = await sendVerificationCode({ destination, code, kind }).catch(
        () => false,
      );
      if (!delivered) {
        return res.status(202).json({
          success: false,
          changeId,
          message: CUSTOMER_ACCOUNT_STRINGS.identityVerificationSent.en,
        });
      }
      return res.json({
        success: true,
        changeId,
        message: CUSTOMER_ACCOUNT_STRINGS.identityVerificationSent.en,
      });
    } catch (e) {
      console.error('[CUSTOMER_IDENTITY_REQUEST_ERROR]', e);
      return res.status(500).json(SERVER_ERROR);
    }
    },
  );

  /**
   * Complete an email or phone change by redeeming the code (G3).
   *
   * This is the ONLY path by which a new identifier becomes authoritative. The
   * code is burned with a compare-and-swap scoped to the session customer, so a
   * change belonging to somebody else — and a second redemption of the same
   * change — both fail.
   */
  app.post('/api/customer/profile/identity/verify', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const changeId = typeof req.body?.changeId === 'string' ? req.body.changeId : '';
      const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
      if (!changeId || !code) return res.status(400).json(BAD_REQUEST);

      // Read the change SCOPED TO THIS CUSTOMER. A change id belonging to
      // somebody else resolves to nothing, which is indistinguishable from an id
      // that never existed - no existence oracle across accounts.
      const record = await db.getIdentityChangeById(changeId, req.customer.id);
      if (!record) return res.status(404).json(NOT_FOUND);
      if (record.consumed_at != null) {
        return res.status(400).json({ error: 'Msimbo huu umetumika. / That code has already been used.' });
      }
      if (new Date(record.expires_at).getTime() <= Date.now()) {
        return res.status(400).json({ error: 'Msimbo huu umeisha muda. / That code has expired.' });
      }
      if (hashCode(code) !== record.code_hash) {
        // BOUNDED GUESSING. A six-digit space is small enough that an attacker
        // holding the (session-bound) changeId could otherwise walk the whole
        // range inside the 30-minute TTL. Count the failure ATOMICALLY, and once
        // the ceiling is reached BURN the change so it can never be redeemed even
        // with the correct code. The response is byte-identical to an ordinary
        // wrong code, so the eventual lockout is not itself an oracle.
        const attempts = await db.incrementCustomerIdentityChangeAttempts({
          id: changeId,
          customerId: req.customer.id,
        });
        if (attempts >= IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS) {
          await db.consumeCustomerIdentityChange({ id: changeId, customerId: req.customer.id });
        }
        return res.status(400).json({ error: 'Msimbo si sahihi. / That code is not correct.' });
      }

      // Burn first. If applying the identifier then failed, the code is spent and
      // the customer simply starts again - which is safe, because the old
      // identifier is still authoritative until applyVerifiedCustomerIdentifier
      // succeeds.
      const burned = await db.consumeCustomerIdentityChange({ id: changeId, customerId: req.customer.id });
      if (!burned) return res.status(400).json({ error: 'Msimbo huu umetumika. / That code has already been used.' });

      const applied = await db.applyVerifiedCustomerIdentifier(
        req.customer.id,
        record.kind,
        record.target_value,
      );
      if (!applied) return res.status(404).json(NOT_FOUND);

      // E1-H2 — THE NEW ADDRESS COMPLETES ITS LIFECYCLE HERE.
      //
      // Redeeming this code IS the proof of control of the mailbox being claimed:
      // the code was generated server-side, delivered ONLY to that address
      // (never to a destination named by a request), stored hash-only, expiring
      // in 30 minutes, single-use, and redeemable only by the authenticated
      // session that owns the pending change. That is strictly stronger evidence
      // than the emailed activation LINK the registration flow relies on, which
      // proves mailbox control with no session binding at all.
      //
      // So `applyVerifiedCustomerIdentifier` commits the new address AND its
      // verified stamp in ONE statement. Before this batch an email change left
      // `email_verified_at` NULL, and the login activation gate reads exactly
      // that state as "account not activated" - a state the customer could not
      // leave, because a code is only ever sent to the address on the account.
      // The write is still fail-safe in the direction that matters: the account
      // row is untouched until this point, so an abandoned or unproven change
      // moves nothing.
      const customer = await db.getCustomerById(req.customer.id);
      return res.json({ success: true, customer: toSafeProfile(customer) });
    } catch (e) {
      console.error('[CUSTOMER_IDENTITY_VERIFY_ERROR]', e);
      return res.status(500).json(SERVER_ERROR);
    }
  });

  // ==========================================================================
  // G2 - AUTHENTICATED ACCOUNT ERASURE
  //
  // The EXISTING phone + code + confirmation route at
  // /api/auth/request-data-deletion is untouched and still works; this is the
  // account-scoped equivalent for a customer who is already signed in.
  //
  // Re-authentication is required before anything is erased, because erasure is
  // irreversible from the customer's side. The code is proved against the account's
  // CURRENT phone, so a stolen session cookie cannot destroy an account.
  //
  // The erasure itself is delegated to db.purgeUserData, which already encodes
  // the PII-versus-financial-record principle this product locked: owner PII is
  // redacted, claim links are removed, and the claims, ledger entries and audit
  // trail are deliberately PRESERVED.
  // ==========================================================================
  app.post('/api/customer/account/erasure', requireCustomerAuth, async (req: any, res: any) => {
    try {
      const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
      const confirmed = req.body?.confirm === true;
      if (!code || !confirmed) return res.status(400).json(BAD_REQUEST);

      const customer = req.customer;
      const challenge = await db.getCustomerOtpForPurpose(customer.phone, 'login');
      const valid =
        challenge &&
        !challenge.used_at &&
        new Date(challenge.expires_at).getTime() > Date.now() &&
        challenge.code_hash === hashCode(code);
      if (!valid) {
        return res.status(400).json({ error: 'Uthibitisho si sahihi. / That confirmation code is not correct.' });
      }

      // Burn the proof so one code can never erase twice.
      await db.consumeCustomerOtp(challenge.id);

      // BATCH 2: Batch 1's customer_notifications rows are personal data keyed to
      // this account, and purgeUserData predates them. They are removed HERE,
      // from the erasure path only, so Batch 1's own semantics are untouched.
      await db.purgeCustomerNotifications(customer.id);

      // The single existing implementation of the locked erasure principle.
      await db.purgeUserData(customer.phone);

      // Every session is revoked so the erased account cannot keep acting.
      await db.revokeAllOtherCustomerSessions(customer.id, '');
      await db.revokeCustomerSession(req.customerSession.id);

      await db.logAudit(
        'CUSTOMER',
        'CUSTOMER_ERASURE_REQUESTED',
        `Customer ${customer.id} requested erasure of their personal data from the account.`,
      );

      return res.json({ success: true, message: CUSTOMER_ACCOUNT_STRINGS.erasureStarted.en });
    } catch (e) {
      console.error('[CUSTOMER_ERASURE_ERROR]', e);
      return res.status(500).json(SERVER_ERROR);
    }
  });
}

/** Normalises the claimed value using the SAME rules registration uses. */
function normalizeTarget(kind: 'email' | 'phone', value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (kind === 'email') {
    const email = trimmed.toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email;
  }
  const phone = toE164Kenyan(trimmed);
  return /^\+254\d{9}$/.test(phone) ? phone : null;
}

function invalidTargetMessage(kind: 'email' | 'phone'): string {
  return kind === 'email'
    ? 'Weka barua pepe sahihi. / Enter a valid email address.'
    : 'Weka nambari sahihi ya simu ya Kenya. / Enter a valid Kenyan phone number.';
}

function takenMessage(kind: 'email' | 'phone'): string {
  return kind === 'email'
    ? 'Barua pepe hii tayari imetumika. / This email address is already in use.'
    : 'Nambari hii tayari imetumika. / This phone number is already in use.';
}

/**
 * The customer-visible shape of an account.
 *
 * Mirrors the existing toSafeCustomer() contract in server.ts: the same fields,
 * so the account screens and this batch cannot drift apart. No token, no
 * verification stamp beyond "is it verified", and never a one-time code.
 */
function toSafeProfile(customer: any): any {
  if (!customer) return null;
  return {
    id: customer.id,
    full_name: customer.full_name,
    phone: customer.phone,
    email: customer.email,
    emailVerified: customer.email_verified_at != null,
    status: customer.status,
  };
}
