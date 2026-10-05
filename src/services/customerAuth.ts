// Customer-account authentication primitives.
//
// Extracted verbatim from server.ts so the customer claim routes can live in
// their own mountable module. This is required for the HTTP integration tests:
// server.ts calls startServer() at import time (it constructs the Express app,
// the Vite middleware and the background sweeps), so a test cannot import it
// without booting the whole application. Importing these primitives instead
// lets a test build a real Express app around the REAL middleware.
//
// Nothing here changed behaviourally in the move — same cookie flags, same
// hash-only lookup, same revocation/expiry/status checks.
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { db } from '../db/database.ts';
// BATCH 2 (H10) — the single definition of the idle-session window and its
// boundary comparison, plus the customer-facing wording used when it fires.
// Imported here so the rule lives in exactly one place and cannot be restated, or
// contradicted, by a route handler.
import { CUSTOMER_ACCOUNT_STRINGS, isSessionIdle } from '../config/customerAccountPolicy.ts';
import { hashCode, toE164Kenyan } from './auth.ts';
// The SHARED transactional-email shell. These two activation builders were the
// last messages on the platform assembling their own `<div style="...">` markup
// instead of using it; see `emailTemplates.ts` for what the shell guarantees.
import {
  EMAIL_THEME,
  buildEmailMessage,
  emailButton,
  emailDivider,
  emailHeading,
  emailKicker,
  emailNote,
  emailParagraph,
  escapeHtml,
} from './emailTemplates.ts';

export const CUSTOMER_SESSION_COOKIE = 'r4m_customer_session';
export const CUSTOMER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const CUSTOMER_OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const CUSTOMER_OTP_MAX_ATTEMPTS = 5;
export const CUSTOMER_OTP_RESEND_MS = 30 * 1000; // 30s resend floor (SMS cost control)

// N3 — EMAIL ACTIVATION GATE.
// The activation link lives for a full day, unlike the 5-minute SMS code: the
// user has to find the email, open it and click. The token is a 32-byte
// CSPRNG value, so a 24h lifetime does not meaningfully widen the brute-force
// surface.
export const CUSTOMER_ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Builds the emailed activation URL.
 *
 * The raw token appears HERE and in the email body and nowhere else — never in
 * a database row, an audit record, a log line or an API response. The frontend
 * owns the route, so the public origin is configurable; the token is the only
 * secret and it is single-use + 24h-expiring.
 */
export function buildCustomerActivationUrl(rawToken: string): string {
  const base = (process.env.PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/activate-email?token=${encodeURIComponent(rawToken)}`;
}

/**
 * The activation email body. Bilingual like every other user-facing string in
 * the product, and it states the validity window so a user who misses the
 * 24h window knows to ask for a new link rather than to keep retrying.
 */
export function buildCustomerActivationEmailHtml(fullName: string, activationUrl: string): string {
  // Escaped by the shared `escapeHtml`, which is the platform's one escaping
  // boundary, rather than by a local character-stripper. Same outcome for every
  // name the previous code handled, plus the `'` and control characters it did
  // not.
  const safeName = escapeHtml(fullName);
  const content = [
    emailKicker('Account activation'),
    emailHeading('Activate your Return4me account'),
    emailParagraph(`Hi ${safeName},`),
    emailParagraph('Thanks for registering. Confirm your email address to activate your account and start using Return4me.'),
    // `fallback: true` prints the raw link as well as the button: this is the
    // only way into the account and there is no second channel to resend it on.
    emailButton({ href: activationUrl, label: 'Activate my account', fallback: true }),
    emailNote('This link works once and expires in 24 hours. If it expires, request a new activation link from the sign-in page.'),
    emailNote('If you did not create a Return4me account, you can safely ignore this email.'),
    emailDivider('Kiswahili'),
    emailParagraph(`<strong>Hai salamu ${safeName},</strong>`),
    emailParagraph('Asante kwa kujiandikisha. Thibitisha barua pepe yako kuiambisha akaunti yako na kuanza kutumia Return4me.'),
    emailParagraph('Kiungo hiki kinafanya kazi mara moja tu na kin expires baada ya saa 24. Ukishapokea, omba kiungo kipya kutoka ukurasa wa kuingia.'),
  ].join('\n');

  // The subject is duplicated into the document as its <title>; the preheader is
  // the preview line a client shows next to the subject, so it carries the two
  // facts that make the message worth opening: what to do and how long for.
  return buildEmailMessage({
    subject: 'Activate your Return4me account',
    preheader: 'Confirm your email address to activate your Return4me account. The link works once and expires in 24 hours.',
    headerLabel: 'Email verification',
    accent: EMAIL_THEME.green,
    content,
  }).html;
}

// Minimal cookie reader (no extra dependency) — used only for our own cookie.
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers?.cookie;
  if (!header) return undefined;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// N4 — AGENT ACTIVATION LINK.
//
// Deliberately its own builder rather than a parameterised
// buildCustomerActivationUrl(): an agent link and a customer link point at
// different pages and mean different things (one proves a mailbox, the other
// activates an account), so a shared "kind" argument would invite the wrong one
// being used. What IS shared is the origin resolution and the percent-encoding,
// so both read PUBLIC_APP_URL and both encode identically — one configuration
// gap, not two.
//
// The token appears here and in the link and nowhere else: never persisted in
// plaintext, never logged, never in a response body.
// ---------------------------------------------------------------------------
// N4 — agent email activation reuses the customer activation lifetime. One
// number, not two: the token is an equally random 32-byte CSPRNG value, so there
// is no security reason to differentiate, and a second constant would only
// invite the two to drift apart.
export const AGENT_ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function buildAgentActivationUrl(rawToken: string): string {
  const base = (process.env.PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/activate-agent-email?token=${encodeURIComponent(rawToken)}`;
}

/**
 * The agent activation email body. Bilingual like every other user-facing
 * string in the product, and it states the two facts an applicant most needs to
 * be true: verifying the address is NOT the same as being approved (an admin
 * still reviews the application), and the link works once and expires in 24h.
 */
export function buildAgentActivationEmailHtml(businessName: string, activationUrl: string): string {
  const safeName = escapeHtml(businessName);
  const content = [
    emailKicker('Agent email verification'),
    emailHeading('Verify your Return4me agent email'),
    emailParagraph(`Hi ${safeName},`),
    emailParagraph('Thank you for registering as a Return4me agent. Please confirm this email address so we know your business can receive mail from us.'),
    emailButton({ href: activationUrl, label: 'Verify my agent email', fallback: true }),
    // The second sentence is not padding: an applicant who reads verification as
    // approval stops checking their queue and starts waiting to be paid.
    emailNote('This link works once and expires after 24 hours. Verifying your email is not the same as approval &mdash; an administrator still reviews your application before you can start work.'),
    emailDivider('Kiswahili'),
    emailParagraph(`<strong>Hai salamu ${safeName},</strong>`),
    emailParagraph('Asante kwa kujisajili kama Wakala wa Return4me. Tafadhali thibitisha barua pepe hii ili tujue biashara yako inaweza kupokea barua kutoka kwetu.'),
    emailParagraph('Kiungo hiki kinafanya kazi mara moja tu na kin expires baada ya saa 24. Kuthibitisha barua pepe si sawa na kukubaliwa &mdash; msimamizi bado anapaswa kupitia maombi yako kabla ya kuanza kazi.'),
  ].join('\n');

  return buildEmailMessage({
    subject: 'Verify your Return4me agent email',
    preheader: 'Confirm this address so your Return4me agent account can receive mail. Verifying your email is not the same as approval.',
    headerLabel: 'Agent verification',
    accent: EMAIL_THEME.green,
    content,
  }).html;
}

export function customerCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

export function setCustomerSessionCookie(res: Response, token: string) {
  res.cookie(CUSTOMER_SESSION_COOKIE, token, { ...customerCookieOptions(), maxAge: CUSTOMER_SESSION_TTL_MS });
}

export function clearCustomerSessionCookie(res: Response) {
  res.clearCookie(CUSTOMER_SESSION_COOKIE, customerCookieOptions());
}

// In-process resend throttle, keyed by normalized phone + purpose.
export const customerOtpLastSent = new Map<string, number>();

// Whitelisted customer shape for API responses. Never includes OTP hashes,
// session tokens/hashes, or other internal security fields.
export function toSafeCustomer(customer: any): any {
  if (!customer) return null;
  return {
    id: customer.id,
    full_name: customer.full_name,
    phone: customer.phone,
    status: customer.status,
    created_at: customer.created_at ? new Date(customer.created_at).toISOString() : null,
    updated_at: customer.updated_at ? new Date(customer.updated_at).toISOString() : null,
  };
}

// 6-digit, crypto-random OTP as a zero-padded decimal string.
export function generateCustomerOtp(): string {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

export function generateSecureId(prefix: string): string {
  return prefix + '-' + crypto.randomBytes(10).toString('hex').toUpperCase();
}

// Customer auth middleware. Reads ONLY the cookie, hashes the presented token,
// finds the session server-side, then checks revocation, expiry, IDLE TIME and the
// account's LIVE status — a suspended/locked customer must not remain
// authenticated merely because an old cookie is still valid.
export async function requireCustomerAuth(req: any, res: Response, next: NextFunction) {
  try {
    const raw = readCookie(req, CUSTOMER_SESSION_COOKIE);
    if (!raw) return res.status(401).json({ error: 'Uthibitisho unahitajika. / Authentication required.' });
    const session = await db.getCustomerSessionByTokenHash(hashCode(raw));
    if (!session) return res.status(401).json({ error: 'Kipindi hiki si sahihi. / Invalid session.' });
    if (session.revoked_at) return res.status(401).json({ error: 'Kipindi hiki kimefungwa. / Session has been revoked.' });
    if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
      return res.status(401).json({ error: 'Kipindi hiki kimeisha muda. / Session has expired.' });
    }
    // H10 (BATCH 2) — IDLE-TIME CHECK, enforced here and nowhere else.
    //
    // Placed AFTER revocation and absolute expiry so the more specific reasons
    // keep their existing messages and behaviour: a revoked session still reports
    // "revoked", an expired one still reports "expired". Only a session that is
    // otherwise valid can be rejected for being idle.
    //
    // The session is REVOKED server-side rather than merely refused, so a stale
    // cookie cannot be replayed on a later request and cannot race the check.
    // The customer-facing wording says they were signed out and to sign in again;
    // it deliberately names no middleware, timeout value or internal term.
    if (isSessionIdle(session.last_seen_at, new Date())) {
      await db.revokeCustomerSession(session.id);
      return res.status(401).json({ error: CUSTOMER_ACCOUNT_STRINGS.sessionIdle.en });
    }
    const customer = await db.getCustomerById(session.customer_id);
    if (!customer) return res.status(401).json({ error: 'Akaunti haipatikani. / Account not available.' });
    if (customer.status !== 'active') {
      return res.status(403).json({ error: 'Akaunti hii haitumiki kwa sasa. / This account is not active.', status: customer.status });
    }
    await db.touchCustomerSession(session.id);
    req.customer = customer;
    req.customerSession = session;
    next();
  } catch (e: any) {
    console.error('[CUSTOMER_AUTH_ERROR]', e);
    return res.status(500).json({ error: 'Hitilafu imetokea upande wa seva. Tafadhali jaribu tena baadaye.' });
  }
}

// ---------------------------------------------------------------------------
// OPTIONAL (non-terminating) customer session resolution — Phase 7C.3 / F11.
//
// Performs exactly the same validation as requireCustomerAuth above
// (cookie -> token hash -> server-side session -> revoked -> expired ->
// account exists -> account active) but instead of rejecting the request it
// returns `null` for EVERY case that is not a live, active customer account:
// no cookie, malformed/invalid cookie, revoked session, expired session,
// deleted account, or a suspended/locked account.
//
// It NEVER writes a response, never throws and never ends the request, so a
// failed lookup can only degrade the caller to "anonymous". It also does not
// touch `req.customer` — an optional lookup must not leave an authenticated
// identity on the request for downstream handlers to trust by accident.
//
// SCOPE — this helper must NOT be used to gate arbitrary state changes or to
// replace requireCustomerAuth. It exists for one additive purpose only: the
// post-verification customer-claim link in POST /api/claims/:id/verify-otp,
// where the request must keep succeeding for anonymous visitors (the claim
// OTP journey has never required a customer account) while a signed-in
// customer's claim is additionally linked to their account. Anything that
// REQUIRES authentication must keep using requireCustomerAuth.
//
// Identity is read EXCLUSIVELY from the session cookie. The request payload,
// the query string and the route parameters are never consulted, so a caller
// cannot select which account an operation is attributed to.
// ---------------------------------------------------------------------------
export async function resolveOptionalCustomer(req: any): Promise<any | null> {
  try {
    const raw = readCookie(req, CUSTOMER_SESSION_COOKIE);
    if (!raw) return null;
    const session = await db.getCustomerSessionByTokenHash(hashCode(raw));
    if (!session) return null;
    if (session.revoked_at) return null;
    if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) return null;
    const customer = await db.getCustomerById(session.customer_id);
    if (!customer) return null;
    if (customer.status !== 'active') return null;
    await db.touchCustomerSession(session.id);
    return customer;
  } catch (e: any) {
    // Deliberately swallowed: an optional lookup must never be able to fail a
    // request that would otherwise have succeeded.
    console.error('[CUSTOMER_OPTIONAL_AUTH_ERROR]', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// AUTOMATIC JOURNEY LINK (F11) — the linked_via value written for the
// automatic link created after a successful claim-OTP verification.
// ---------------------------------------------------------------------------
export const JOURNEY_CLAIM_LINK_VIA = 'journey_verify_otp';

export interface ClaimJourneyLinkResult {
  /** Only this is exposed to the client (as `linked`). */
  linked: boolean;
  /**
   * Internal reason, for auditing and tests. 'linked' is the only outcome that
   * wrote a row; 'already_linked_self' means the legitimate link already
   * existed (idempotent: no duplicate row and no duplicate audit entry).
   */
  outcome: 'linked' | 'already_linked_self' | 'already_linked_other' | 'phone_mismatch' | 'error';
}

// Links a freshly OTP-verified claim to the authenticated customer who
// performed the verification.
//
// PRE-CONDITION (enforced by the caller and re-checked here): the claim's OTP
// has JUST been verified in this request, and the caller's identity came from
// a validated customer session — never from request input.
//
// The phone-equality rule mirrors the explicit linking route exactly
// (routes/customerClaims.ts), including the shared toE164Kenyan normalisation
// so '+2547XXXXXXXX' and '07XXXXXXXX' are recognised as the same number. A
// claim whose owner phone differs from the account's phone is left UNLINKED —
// the existing explicit link flow refuses that case too, and the anonymous /
// other-phone claim journey must keep working.
//
// Deliberately additive and NON-FATAL: it never throws and never rolls
// anything back. The claim transition that precedes it is the authoritative
// operation; a linkage failure can only mean "verified but not yet visible in
// the dashboard", which the existing explicit link flow can repair. Only the
// existing db.linkClaimToCustomer primitive is used — no new link mechanism,
// no bulk/phone-based matching (see the customer_claim_links comment in
// db/database.ts).
export async function linkVerifiedClaimToCustomer(
  customer: any,
  claim: any
): Promise<ClaimJourneyLinkResult> {
  try {
    if (!customer || !claim || !customer.id || !claim.id) {
      return { linked: false, outcome: 'phone_mismatch' };
    }

    const customerPhone = toE164Kenyan(String(customer.phone || '').replace(/\s+/g, ''));
    const claimPhone = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
    if (!customerPhone || !claimPhone || customerPhone !== claimPhone) {
      return { linked: false, outcome: 'phone_mismatch' };
    }

    const outcome = await db.linkClaimToCustomer(
      generateSecureId('CCL'),
      customer.id,
      claim.id,
      JOURNEY_CLAIM_LINK_VIA
    );

    if (outcome === 'already_linked_other') {
      // The claim is already owned by a different account. Nothing is
      // re-pointed and nothing is overwritten; the verified claim is untouched
      // and the manual flow remains the only reconciliation path.
      await db.logAudit(
        'SYSTEM',
        'CUSTOMER_CLAIM_LINK_FAILED',
        `Automatic journey link skipped for claim ${claim.id}: the claim is already linked to a different customer account.`
      );
      return { linked: false, outcome: 'already_linked_other' };
    }

    if (outcome === 'already_linked_self') {
      return { linked: true, outcome: 'already_linked_self' };
    }

    await db.logAudit(
      'CUSTOMER',
      'CUSTOMER_CLAIM_LINK',
      `Customer ${customer.id} linked claim ${claim.id} via ${JOURNEY_CLAIM_LINK_VIA}.`
    );
    return { linked: true, outcome: 'linked' };
  } catch (e: any) {
    console.error('[CUSTOMER_CLAIM_JOURNEY_LINK_ERROR]', e);
    try {
      await db.logAudit(
        'SYSTEM',
        'CUSTOMER_CLAIM_LINK_FAILED',
        `Automatic journey link failed for claim ${claim && claim.id ? claim.id : 'unknown'}; the claim verification itself is unaffected.`
      );
    } catch (auditError: any) {
      console.error('[CUSTOMER_CLAIM_JOURNEY_LINK_AUDIT_ERROR]', auditError);
    }
    return { linked: false, outcome: 'error' };
  }
}
