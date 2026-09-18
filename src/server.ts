import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import https from 'https';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { createServer as createViteServer } from 'vite';
import { db, FoundItem, Claim, Agent, Dispute } from './db/database';
import { pool, ensureSchemaUpToDate, isDatabaseConnectionError } from './db/index';
import { AuthService, authenticateJWT, generateToken, verifyToken, toE164Kenyan, hashCode, timingSafeEqualHex, sendCodeViaSms, maskPhoneForLog, isAgentActionable, isAdminSessionCurrent } from './services/auth';
import { AgentMatchingService, geocodeAddress } from './services/agent';
import { EmailService } from './services/email';
import { PaymentService, isPlaceholderKey, reconcileWebhookAmount } from './services/payments';
import { OcrService } from './services/ocr';
import { uploadBase64Image } from './services/storage';
import { SocialService } from './services/social';
import { computeRecoveryFee } from './services/feeEngine';
import { validateVerificationAnswers, toAgentVerificationEvidence, isAnswerValidationFailure, compareVerificationAnswers } from './services/verificationValidation';
import {
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_TTL_MS,
  CUSTOMER_OTP_TTL_MS,
  CUSTOMER_OTP_MAX_ATTEMPTS,
  CUSTOMER_OTP_RESEND_MS,
  customerOtpLastSent,
  toSafeCustomer,
  generateCustomerOtp,
  generateSecureId,
  setCustomerSessionCookie,
  clearCustomerSessionCookie,
  requireCustomerAuth,
  // Phase 7C.3 / F11 — optional (non-terminating) session resolution and the
  // additive post-verification journey link. See services/customerAuth.ts.
  resolveOptionalCustomer,
  linkVerifiedClaimToCustomer,
} from './services/customerAuth';
// Phase 7C.7 (R1): isPickupEligibleClaimStatus is the canonical pickup-eligibility
// predicate introduced by Phase 7C.5. /api/claims/lookup now gates its agent
// disclosure with it so that route cannot drift from routes/publicItems.ts.
import { INACTIVE_CLAIM_STATUSES, isPickupEligibleClaimStatus } from './config/claimStatuses';
import { toOwnerSafeAgentView, toOwnerSafeClaimView, toOwnerSafeItemView } from './services/ownerSafeViews';
// Phase 7B: the shared public (unauthenticated) item read model. getRoughArea
// moved here from this file so the public search route and the new public
// item-detail route cannot drift apart in how they coarsen an agent address.
import { toPublicItemView, getRoughArea } from './services/publicItemView';
import { toAdminSafeAgentView, toAdminSafeItemView, toAdminSafeDisputeView, toAdminSafeAgentDocumentsView, toAdminSafeLedgerEntry, toAdminSafeAuditLog } from './services/adminSafeViews';
import { registerCustomerClaimRoutes } from './routes/customerClaims';
import { registerAdminDisputeRoutes } from './routes/adminDisputes';
import { registerAdminClaimRoutes } from './routes/adminClaims';
import { registerAdminLostReportRoutes } from './routes/adminLostReports';
import { registerPublicItemRoutes } from './routes/publicItems';
// Phase 9A: the customer lost-item reporting routes. Registered the same way as
// the customer-claim routes below so an HTTP test can mount the real handlers.
import { registerLostReportRoutes } from './routes/lostReports';
// The canonical document-number hasher. Moved out of this file verbatim in
// Phase 9A so the found-item report route (which also hashes identifiers) and
// the new lost-item report route share ONE implementation instead of drifting
// copies. Behaviour is unchanged — see services/documentHash.ts.
import { hashDocument } from './services/documentHash';
// PHASE 9D: the found-item county input rule (required + canonical, never
// inferred). Extracted so the rule is unit-testable rather than trapped in the
// handler — the same pattern routes/lostReports.ts uses. It delegates to the
// ONE canonical resolver (`resolveCountyName` in config/kenyaCounties.ts), so
// this file needs no county list and no second implementation.
import { resolveFoundCountyInput } from './services/foundItemCounty';
// PHASE 9D: the ONE coordinate validator (finite + in-range, explicit
// null-handling so a valid 0 is not discarded).
import { normalizeCoordinateInput } from './services/coordinates';
import { claimStatusPollLimiter, paymentSessionStatusLimiter } from './config/claimStatusPollLimiter';
// PHASE 10 (F-1): the ONE server-port resolver. This file previously hardcoded
// the listen port and ignored the environment, which breaks port-injecting
// container platforms (see config/serverPort.ts for the full reasoning).
import { resolveServerPort } from './config/serverPort';
// PHASE 10 (F-5): the ONE Sentry-DSN acceptability policy. Shared with the
// browser bundle (main.tsx) so "is Sentry actually configured?" has a single
// implementation instead of two drifting copies.
import { isSentryDsnUsable, sentryDsnProblem, sentryDsnProblemLabel } from './config/sentryDsn';
// Phase 12: containment-checked resolution of /src/* sourcemap requests (see the
// module's own documentation for the traversal defect it replaces).
import { resolveContainedSourcePath } from './utils/safeStaticPath';
// PHASE 10 (F-2): the escrow-holdings aggregate. The admin "Escrow Funds Held"
// card previously displayed a claim COUNT where a monetary total belongs.
import { computeEscrowFundsHeld } from './services/escrowFunds';
// PHASE 10 (F-4): the dev payment-simulation gate, extracted so it is testable.
// This predicate was private to this file, which cannot be imported by a test
// (it boots the application on import), so the gate that protects a
// money-faking endpoint had no regression coverage at all. The logic is
// unchanged — see config/devPaymentSimulation.ts.
import { resolveDevPaymentSimulationEnabled } from './config/devPaymentSimulation';
import bcrypt from 'bcryptjs';
import * as Sentry from '@sentry/node';
import * as OTPAuth from 'otpauth';

// TLS COMPATIBILITY FIX: some external APIs we call (notably Africa's Talking's
// AWS-hosted SMS endpoint) issue a mid-handshake TLS renegotiation that Node.js's
// bundled OpenSSL can fail on with "EPROTO ... wrong version number", even though
// the exact same connection succeeds via curl or other TLS stacks (e.g. Windows
// SChannel). Forcing TLS 1.2 avoids this specific renegotiation behavior. This is
// applied process-wide and automatically on every boot, so it does not depend on
// remembering to set NODE_OPTIONS manually in each terminal session.
https.globalAgent.options.minVersion = 'TLSv1.2';
https.globalAgent.options.maxVersion = 'TLSv1.2';

// Load main .env
dotenv.config();

// Fall back to .env.example ONLY in non-production environments if required variables are missing
if (process.env.NODE_ENV !== 'production') {
  if (!process.env.JWT_SECRET || !process.env.DOC_HASH_SALT) {
    const fallbackPath = path.resolve(process.cwd(), '.env.example');
    if (fs.existsSync(fallbackPath)) {
      dotenv.config({ path: fallbackPath });
    }
  }
}

function scrubPii(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(scrubPii);
  }
  const result = { ...obj };
  const piiKeys = ['nationalid', 'national_id', 'phone', 'email', 'password', 'passcode', 'signature', 'token', 'secret', 'key'];
  for (const key of Object.keys(result)) {
    if (piiKeys.some(pii => key.toLowerCase().includes(pii))) {
      result[key] = '[REDACTED]';
    } else if (typeof result[key] === 'object') {
      result[key] = scrubPii(result[key]);
    }
  }
  return result;
}

// toOwnerSafeAgentView / toOwnerSafeClaimView / toOwnerSafeItemView were moved
// VERBATIM to services/ownerSafeViews.ts in Phase 2 so the customer dashboard
// reuses the exact same masking rules rather than keeping a second copy of
// security-relevant logic. They are imported above.

// Hand-built (never `.spread`) DTO for a payment session returned to the owner
// flow. Contains ONLY the fields the owner payment UI needs and safe-to-show
// operational status — never the provider secret, never raw provider internals.
// payer_phone is returned (it is the user's own number, entered this session,
// and the UI must show which number received the prompt); it is NOT the claim's
// owner_phone unless the user chose the same number.
// SC-9: single source of truth for "may the fake-payment endpoint run here?".
//
// Deliberately stricter than the general dev-convenience gate. This endpoint
// writes an AUTHORITATIVE payment confirmation (claims.status -> escrow_held and
// claims.paid_at), so it must not be reachable merely because NODE_ENV is not
// 'production' (an unset NODE_ENV is the classic configuration mistake), and it
// must not share a flag with a non-money feature like OTP bypass. All three
// conditions are required, and boot() refuses to start in production if the
// money-specific flag is set at all.
function isDevPaymentSimulationEnabled(): boolean {
  // PHASE 10 (F-4): the logic now lives in config/devPaymentSimulation.ts so it
  // can be unit-tested (this module cannot be imported by a test). The three
  // process.env reads — and therefore the gate's behaviour — are unchanged; this
  // wrapper exists only so every existing call site in this file keeps working
  // untouched.
  return resolveDevPaymentSimulationEnabled(
    process.env.NODE_ENV,
    process.env.ALLOW_MOCK_OTP_BYPASS,
    process.env.ENABLE_DEV_PAYMENT_SIMULATION,
  );
}

function toSafePaymentSession(session: any): any {
  if (!session) return null;
  return {
    id: session.id,
    claim_id: session.claim_id,
    amount: session.amount,
    currency: session.currency,
    method: session.method,
    status: session.status,
    payer_phone: session.payer_phone,
    created_at: session.created_at ? new Date(session.created_at).toISOString() : null,
    expires_at: session.expires_at ? new Date(session.expires_at).toISOString() : null,
    confirmed_at: session.confirmed_at ? new Date(session.confirmed_at).toISOString() : null,
  };
}

// Resolves the authoritative amount owed for a claim's payment, using exactly
// the same rule /pay uses: the item's locked_total_fee when present and valid,
// otherwise the category's total_fee. The payer/browser never supplies this.
function resolveAuthoritativePaymentFee(item: any, category: any): number {
  let fee = Number(category ? category.total_fee : 0);
  if (Number.isNaN(fee)) fee = 0;
  if (item && item.locked_total_fee !== undefined && item.locked_total_fee !== null) {
    const lockedVal = typeof item.locked_total_fee === 'string' ? parseFloat(item.locked_total_fee) : Number(item.locked_total_fee);
    if (!Number.isNaN(lockedVal) && lockedVal > 0) fee = lockedVal;
  }
  return fee;
}


function checkSecret(name: string, val: string | undefined, minLen: number = 32) {
  if (!val) {
    throw new Error(`FATAL: ${name} environment variable is missing. The app refuses to boot.`);
  }
  if (val.length < minLen) {
    throw new Error(`FATAL: ${name} must be at least ${minLen} characters long. The app refuses to boot.`);
  }
  if (
    val.includes('REPLACE_WITH') ||
    val.includes('PLACEHOLDER') ||
    val === 'REPLACE_WITH_STRONG_RANDOM_VALUE_MIN_32_CHARS'
  ) {
    throw new Error(`FATAL: ${name} is configured with a default placeholder value. For production security, please configure a real high-entropy secret.`);
  }
}

// Enforce strict secrets checking at startup ONLY in production
if (process.env.NODE_ENV === 'production') {
  checkSecret('JWT_SECRET', process.env.JWT_SECRET, 32);
  checkSecret('DOC_HASH_SALT', process.env.DOC_HASH_SALT, 32);
  if (!process.env.ADMIN_PASSCODE || process.env.ADMIN_PASSCODE === '4114' || process.env.ADMIN_PASSCODE === '1234') {
    throw new Error('FATAL: In production mode, ADMIN_PASSCODE must be configured and cannot use weak default codes like 4114 or 1234.');
  }
  if (process.env.ALLOW_MOCK_OTP_BYPASS === 'true') {
    throw new Error('FATAL: ALLOW_MOCK_OTP_BYPASS is set to true in production mode. This is extremely insecure and is strictly forbidden.');
  }
  // SC-9: the dev payment simulator moves a claim to escrow_held with NO real
  // money. It must never be reachable in a production configuration, and a
  // deployment that sets its flag by mistake must fail loudly at boot rather
  // than serve a fake payment endpoint.
  if (process.env.ENABLE_DEV_PAYMENT_SIMULATION === 'true') {
    throw new Error('FATAL: ENABLE_DEV_PAYMENT_SIMULATION is set to true in production mode. This endpoint fabricates payment confirmation without any real transfer and is strictly forbidden in production.');
  }
  // Without these checks, a production deployment with forgotten/placeholder
  // IntaSend keys would boot successfully and then silently simulate every
  // M-Pesa payment as "successful" — real users would see a success message,
  // items would be released to them, and agents would be told they'd been
  // paid, while zero real money ever moved. Same principle for Africa's
  // Talking: a placeholder key there means pickup codes are only ever
  // logged to the server console, never actually sent to the owner's phone.
  // Both failure modes are invisible unless caught here at boot.
  if (isPlaceholderKey(process.env.INTASEND_PUBLISHABLE_KEY) || isPlaceholderKey(process.env.INTASEND_SECRET_KEY)) {
    throw new Error('FATAL: INTASEND_PUBLISHABLE_KEY / INTASEND_SECRET_KEY are missing or still placeholder values in production mode. Without real keys, all M-Pesa payments would be silently simulated as successful with no real money moving. The app refuses to boot.');
  }
  if (isPlaceholderKey(process.env.INTASEND_WEBHOOK_SECRET)) {
    throw new Error('FATAL: INTASEND_WEBHOOK_SECRET is missing or still a placeholder value in production mode. Without it, payment webhook signatures cannot be verified, and the app refuses to boot rather than accept unverified payment confirmations.');
  }
  if (isPlaceholderKey(process.env.AFRICASTALKING_API_KEY) || isPlaceholderKey(process.env.AFRICASTALKING_USERNAME) || isPlaceholderKey(process.env.AFRICASTALKING_SENDER_ID)) {
    throw new Error('FATAL: Africa\'s Talking configuration is missing or still placeholder values in production mode. Without it, secret pickup codes would only ever be logged to the server console, never actually delivered to owners by SMS. The app refuses to boot.');
  }
} else {
  const warnSecret = (name: string, val: string | undefined) => {
    if (!val) {
      console.warn(`WARNING: ${name} environment variable is missing in development.`);
    } else if (
      val.length < 32 ||
      val.includes('REPLACE_WITH') ||
      val.includes('PLACEHOLDER') ||
      val === 'REPLACE_WITH_STRONG_RANDOM_VALUE_MIN_32_CHARS'
    ) {
      console.warn(`WARNING: ${name} is using a default placeholder or short value in development. Please configure a real high-entropy secret in production.`);
    }
  };
  warnSecret('JWT_SECRET', process.env.JWT_SECRET);
  warnSecret('DOC_HASH_SALT', process.env.DOC_HASH_SALT);
}

const realEnvExists = fs.existsSync(path.resolve(process.cwd(), '.env'));

// Initialize Sentry early
//
// PHASE 10 (F-5): the previous guard below only rejected an empty value and the
// literal substring 'REPLACE_WITH', and the success line was printed purely
// because Sentry.init() had not thrown. Sentry.init() does NOT throw on an
// unusable DSN — it logs its own "Invalid Sentry Dsn" warning and returns — so
// the application announced error tracking as live while no event could ever be
// delivered, which is worse than not having it at all.
//
// The acceptability policy now lives in config/sentryDsn.ts (the same module the
// browser bundle uses). The messages state exactly what was established: that
// the DSN passed the application's own configuration policy and that
// Sentry.init() ran. They deliberately do NOT claim the provider accepted the
// DSN — verifying that needs network I/O, which this boot path does not perform.
const sentryDsnBackend = process.env.SENTRY_DSN_BACKEND;
const sentryBackendDsnProblem = sentryDsnProblem(sentryDsnBackend);
// Kept as a boolean with this exact name: the Express error handler registration
// near app.listen() is gated on it.
const isSentryBackendEnabled = isSentryDsnUsable(sentryDsnBackend);

if (isSentryBackendEnabled) {
  try {
    Sentry.init({
      dsn: sentryDsnBackend,
      tracesSampleRate: 1.0,
      beforeSend(event) {
        // Redact any PII from request body, context, or breadcrumbs
        if (event.request && event.request.data) {
          try {
            if (typeof event.request.data === 'string') {
              let parsed = JSON.parse(event.request.data);
              parsed = scrubPii(parsed);
              event.request.data = JSON.stringify(parsed);
            } else if (typeof event.request.data === 'object') {
              event.request.data = scrubPii(event.request.data);
            }
          } catch (e) {}
        }
        return event;
      }
    });
    console.log('[SENTRY] Backend error tracking initialised with a configured, well-formed DSN (PII scrubbing active). Provider-side delivery is not verified at boot.');
  } catch (err) {
    // Initialisation itself failed. Report that — never success.
    console.error('[SENTRY ERROR] Failed to initialize Sentry:', err);
  }
} else {
  // A non-null problem is guaranteed here (isSentryDsnUsable was false), and
  // `?? 'missing'` keeps the type narrow without a non-null assertion.
  console.log(`[SENTRY] Backend error tracking is DISABLED — Sentry DSN is ${sentryDsnProblemLabel(sentryBackendDsnProblem ?? 'missing')}. No error events will be sent.`);
}


// Startup environment configuration log
console.log('================================================================');
console.log('                   RETURN4ME ENVIRONMENT CHECK                  ');
console.log('================================================================');
console.log(`.env File Detected:      ${realEnvExists ? '[OK] Yes' : '[MISSING] No (Using default fallback process envs/example)'}`);
console.log(`DATABASE_URL:            ${process.env.DATABASE_URL ? '[OK] Configured' : '[MISSING] Missing'}`);
console.log(`JWT_SECRET:              ${process.env.JWT_SECRET ? '[OK] Configured' : '[MISSING] Missing'}`);
console.log(`DOC_HASH_SALT:           ${process.env.DOC_HASH_SALT ? '[OK] Configured' : '[MISSING] Missing'}`);
console.log(`ADMIN_PASSCODE:          ${process.env.ADMIN_PASSCODE ? '[OK] Configured' : '[MISSING] Missing'}`);
console.log(`INTASEND_PUBLISHABLE:    ${process.env.INTASEND_PUBLISHABLE_KEY ? '[OK] Configured' : '[MISSING] Missing'}`);
console.log(`INTASEND_SECRET:         ${process.env.INTASEND_SECRET_KEY ? '[OK] Configured' : '[MISSING] Missing'}`);
console.log(`ALLOW_MOCK_OTP_BYPASS:   ${process.env.ALLOW_MOCK_OTP_BYPASS === 'true' ? '[WARNING] ENABLED (Insecure)' : '[OK] Disabled'}`);
console.log(`GEMINI_API_KEY:          ${process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY' ? '[OK] Configured (Real OCR Active)' : '[WARNING] Missing or placeholder'}`);
console.log(`GROQ_API_KEY:            ${process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'MY_GROQ_API_KEY' ? '[OK] Configured (Secondary OCR Active)' : '[WARNING] Missing or placeholder'}`);
console.log('================================================================');
console.log('Database pool created, SSL enabled');
console.log('================================================================');

// Startup check for real Gemini API key in a freshly-cloned/example state
const geminiKey = process.env.GEMINI_API_KEY || '';
const isRealGoogleKey = /^(AQ\.[A-Za-z0-9_-]+|AIzaSy[A-Za-z0-9_-]+)$/.test(geminiKey);
const isFreshlyCloned = !realEnvExists ||
  process.env.JWT_SECRET === "REPLACE_WITH_STRONG_RANDOM_VALUE_MIN_32_CHARS" ||
  process.env.ADMIN_PASSCODE === "REPLACE_WITH_STRONG_PASSCODE_MIN_12_CHARS" ||
  process.env.DOC_HASH_SALT === "REPLACE_WITH_STRONG_RANDOM_VALUE_MIN_32_CHARS" ||
  process.env.INTASEND_PUBLISHABLE_KEY === "REPLACE_WITH_INTASEND_PUBLISHABLE_KEY" ||
  process.env.INTASEND_SECRET_KEY === "REPLACE_WITH_INTASEND_SECRET_KEY";

if (isRealGoogleKey && isFreshlyCloned) {
  console.warn("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.warn("[WARNING]  SECURITY WARNING: REAL GOOGLE API KEY DETECTED IN UNCONFIGURED STATE!");
  console.warn("Your GEMINI_API_KEY format matches a real Google API key (starts with 'AQ.' or 'AIzaSy').");
  console.warn("However, the application appears to be running in an unconfigured, freshly-cloned,");
  console.warn("or example fallback state where standard security placeholders are still active.");
  console.warn("Please ensure you do NOT commit your real API keys or secrets to public repositories");
  console.warn("or .env.example. Use a secure, untracked .env file for secrets instead.");
  console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n");
}

// Enforce strict presence and safety of secrets at startup
if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is missing. The app refuses to boot.');
}
if (process.env.JWT_SECRET.length < 32) {
  throw new Error('FATAL: JWT_SECRET must be at least 32 characters long. The app refuses to boot.');
}
if (!process.env.DOC_HASH_SALT) {
  throw new Error('FATAL: DOC_HASH_SALT environment variable is missing. The app refuses to boot.');
}
if (!process.env.ADMIN_PASSCODE) {
  throw new Error('FATAL: ADMIN_PASSCODE environment variable is missing. The app refuses to boot.');
}
if (process.env.ADMIN_PASSCODE.length < 12) {
  throw new Error('FATAL: ADMIN_PASSCODE must be at least 12 characters long. The app refuses to boot.');
}
if (!process.env.INTASEND_PUBLISHABLE_KEY) {
  throw new Error('FATAL: INTASEND_PUBLISHABLE_KEY environment variable is missing. The app refuses to boot.');
}
if (!process.env.INTASEND_SECRET_KEY) {
  throw new Error('FATAL: INTASEND_SECRET_KEY environment variable is missing. The app refuses to boot.');
}

if (realEnvExists) {
  if (process.env.AFRICASTALKING_API_KEY === undefined || process.env.AFRICASTALKING_USERNAME === undefined || process.env.AFRICASTALKING_SENDER_ID === undefined) {
    throw new Error('FATAL: Africa\'s Talking configuration variables (AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME, AFRICASTALKING_SENDER_ID) are missing from .env. The app refuses to boot.');
  }
}

// PHASE 10 (F-1): the listen port is now configuration-driven.
//
// This was `const PORT = 3000;` — a hardcoded constant that ignored the
// environment entirely. Managed container platforms (Cloud Run, which
// .env.example's own comments describe this app as targeting) inject PORT and
// route traffic and health checks to the port they assigned, so a server that
// ignores it can report a successful boot while receiving no traffic at all.
//
// An ABSENT PORT keeps the long-standing 3000 default, so local development is
// unchanged. An INVALID PORT also falls back to 3000 — a typo in an environment
// variable must never be the reason the service is down — but the rejection is
// reported below rather than swallowed, because a silently ignored
// misconfiguration is exactly what this phase removes. Port 0 is rejected
// deliberately; see config/serverPort.ts.
const serverPortResolution = resolveServerPort(process.env.PORT);
const PORT = serverPortResolution.port;

if (serverPortResolution.source === 'env') {
  console.log(`[CONFIG] Server port ${PORT} resolved from the PORT environment variable.`);
} else if (serverPortResolution.rejectedRawValue !== null) {
  console.warn(
    `[CONFIG] WARNING: PORT was set to "${serverPortResolution.rejectedRawValue}", which is not a valid TCP port (a whole number from 1 to 65535). ` +
    `Falling back to the default port ${PORT}. Fix PORT in the deployment environment; the value provided was ignored.`
  );
} else {
  console.log(`[CONFIG] PORT is not set; using the default server port ${PORT}.`);
}

// Settlement dispute window: how long a claim sits in 'pending_settlement'
// (item already physically handed over, payout booked in the ledger as
// pending) before the settlement sweep actually disburses the M-Pesa split.
// Gives a second claimant, the owner, or an admin a real window to freeze a
// suspicious handover before money moves — see database.ts enterPendingSettlement.
const DISPUTE_WINDOW_HOURS = process.env.DISPUTE_WINDOW_HOURS ? parseFloat(process.env.DISPUTE_WINDOW_HOURS) : 48;
const DISPUTE_WINDOW_MS = Math.max(0, DISPUTE_WINDOW_HOURS) * 60 * 60 * 1000;

// Rate Limiters Configuration
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 1000 : 10000, // 1000 in prod, 10000 in dev/testing
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Too many requests, please try again later.' }
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per 15 minutes per IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Jaribio nyingi za kuingia zimefanyika kama msimamizi. Tafadhali subiri dakika 15 kabla ya kujaribu tena.' }
});

const otpIpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Muda mwingi wa maombi ya OTP kutoka kwa anwani hii. Tafadhali subiri kidogo.' }
});

// Defense-in-depth backstop, independent of client IP entirely. The IP-based
// limiter above relies on `trust proxy` matching the real number of reverse
// proxy hops in front of this server (see the trust-proxy config below) — if
// that assumption is ever wrong for a given deployment (no reverse proxy, a
// misconfigured one, or an extra hop such as a CDN in front of it), a client
// can trivially defeat IP-based limiting by sending a different fake
// X-Forwarded-For value on every request. Since each OTP send costs real
// money (SMS) and can be aimed at anyone's phone number, not just the
// attacker's own, this global cap ensures there is still a hard ceiling on
// total OTP sends platform-wide even if the per-IP limiter is bypassed.
const otpGlobalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'production' ? 60 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: () => 'global-otp-bucket',
  message: { error: 'Mfumo umepokea maombi mengi ya OTP kwa sasa. Tafadhali jaribu tena baada ya dakika chache. / The system is currently receiving too many OTP requests. Please try again in a few minutes.' }
});

const otpPhoneLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => {
    return req.body.phone ? String(req.body.phone).trim() : req.ip || 'unknown-ip';
  },
  message: { error: 'Nambari hii imefikia kikomo cha maombi ya OTP. Tafadhali subiri dakika 5.' }
});

// P0: POST /api/claims/:id/request-otp used to require only a claim ID —
// no phone parameter at all — and was gated solely by otpIpLimiter (5/5min
// per IP) and otpGlobalLimiter (a system-wide bucket). Neither is keyed to
// the specific claim being targeted, so an attacker who found or guessed a
// claim ID (the same 900k-combination numeric space documented elsewhere
// in this file) could repeatedly trigger real OTP SMS messages to that
// claim's real registered owner_phone — a harassment/cost-abuse vector
// against a third party who never initiated anything — bounded only by a
// generous IP-wide budget that resets every 5 minutes and doesn't stop an
// attacker who simply rotates IPs. Keyed on the claim ID itself (from the
// URL param, always present) rather than IP, so the limit follows the
// target claim regardless of how many different IPs an attacker uses.
const otpClaimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => `claim-otp:${req.params.id || 'unknown-claim'}`,
  message: { error: 'Dai hili limefikia kikomo cha maombi ya OTP hivi karibuni. Tafadhali subiri dakika chache. / This claim has reached its OTP request limit recently. Please wait a few minutes.' }
});

const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Umekwishatuma ripoti nyingi hivi karibuni. Tafadhali subiri kabla ya kuripoti tena.' }
});

// /api/items/analyze triggers a real, paid Gemini/Groq vision-API call per
// request and is reachable unauthenticated — before any item report even
// exists, unlike /api/items/report which shares this same 10/15min cap.
// Without its own limiter it only inherited generalLimiter's 1000/15min
// per IP, which is nowhere near tight enough for a per-call-billed
// external API: an attacker (or one spread across a handful of IPs) could
// burn through the OCR budget for free with zero friction. Capped to match
// reportLimiter's rate.
const ocrAnalyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Umekwishajaribu kuchanganua picha mara nyingi mno. Tafadhali subiri kabla ya kujaribu tena. / Too many image analysis attempts. Please wait before trying again.' }
});

const otpVerifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5, // 5 attempts per 5 minutes per phone/claim/IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => {
    return req.body.phone ? String(req.body.phone).trim() : (req.params.id ? String(req.params.id) : req.ip || 'unknown-ip');
  },
  message: { error: 'Umekwishajaribu msimbo wa OTP mara nyingi mno. Tafadhali subiri kidogo. / Too many OTP verification attempts. Please wait.' }
});

// Claim IDs are 6-digit numeric codes (CLM-100000..CLM-999999 — see
// generateUniqueClaimId below), a space of under 900,000 values. `/pay`,
// `/lookup`, and `/status` all accept a bare claim ID from an unauthenticated
// caller (owners have no login), and generalLimiter's 1000 req/15min per IP
// is nowhere near tight enough to stop that space being brute-forced —
// worst case for `/pay` specifically, a guessed ID sitting in
// 'pending_payment' with no `phone` supplied lets an attacker trigger a real
// M-Pesa STK push to an uninvolved third party's phone with no proof of
// ownership at all (see the SECURITY comment on that route). Keyed by IP so
// it doesn't block the legitimate owner retrying their own claim, and kept
// tight since a real owner only ever needs a handful of calls per claim.
const claimGuessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Umejaribu maombi mengi mno ya claim hii hivi karibuni. Tafadhali subiri dakika chache. / Too many claim requests from this connection recently. Please wait a few minutes.' }
});

// Customer account auth (register/login) is fully unauthenticated and each
// request can trigger a real, billable OTP SMS aimed at an arbitrary phone
// number. customerAuthLimiter is the per-connection cap; otpGlobalLimiter
// (applied on the two OTP-sending routes below) is the IP-independent
// platform-wide ceiling — the same defense-in-depth pair the claim OTP route
// (/api/claims/:id/request-otp) already uses, so a per-IP bypass cannot turn
// this into an unbounded SMS-cost/abuse vector. The verify endpoints reuse
// the existing tighter otpVerifyLimiter below.
const customerAuthLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: process.env.NODE_ENV === 'production' ? 10 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Majaribio mengi ya akaunti kwa sasa. Tafadhali subiri kidogo. / Too many account attempts. Please wait a few minutes.' }
});

// ACTIVE AGENT AUTHORIZATION: authenticateJWT only proves a token was
// validly signed and hasn't expired — it says nothing about whether the
// Agent it names is still allowed to act *right now*. Before this
// middleware existed, every Agent operational route (verify-item,
// confirm-dropoff, reject-dropoff, confirm-viewing, confirm-handover) only
// ever checked `req.user?.role === 'agent'` — trusting the JWT claim alone
// — while a single unrelated route (GET /api/agents/queue) separately
// re-verified `agent.status === 'active'` against the live Agent record.
// That meant a suspended or still-pending Agent whose JWT happened to still
// have hours of validity left (this codebase has no per-request session
// expiry shorter than the token's own lifetime) could keep performing every
// one of those operations right up until the token's natural expiry,
// regardless of being suspended in the interim. This middleware is the
// single choke point: re-loads the Agent from the DB on every request,
// confirms it still exists, and confirms status === 'active', denying
// (403) otherwise. Mount it directly after authenticateJWT on every Agent
// operational route. Attaches the freshly-loaded, known-active Agent record
// to req.activeAgent so route handlers that need it don't have to
// re-query.
function requireActiveAgent(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'agent' || !req.user.agentId) {
    return res.status(403).json({ error: 'Ufikiaji umekataliwa. Sio Return4me Agent aliyeidhinishwa.' });
  }
  db.getAgent(req.user.agentId)
    .then(agent => {
      if (!isAgentActionable(agent)) {
        return res.status(403).json({ error: 'Akaunti yako ya Agent bado haijaidhinishwa au imesitishwa.' });
      }
      req.activeAgent = agent;
      next();
    })
    .catch(err => {
      console.error('[requireActiveAgent] Failed to verify Agent status:', err);
      res.status(500).json({ error: 'Imeshindikana kuthibitisha akaunti yako ya Agent.' });
    });
}

// Express type augmentation for req.activeAgent, set by requireActiveAgent
// above once it has confirmed the Agent named in the JWT is real and
// currently active — lets route handlers use the already-verified record
// instead of re-querying it.
declare global {
  namespace Express {
    interface Request {
      activeAgent?: Agent;
    }
  }
}

// ADMIN SESSION REVOCATION: same class of gap as requireActiveAgent above,
// for admin sessions. authenticateJWT alone only proves a token was
// validly signed and hasn't expired — an admin JWT stayed fully usable for
// its entire remaining lifetime (currently 4h) even after is_active was
// set to false, because is_active was only ever checked at login and at
// 2FA verification, never on the ~24 subsequent privileged requests a
// session actually makes. Re-checks both is_active and token_version
// against the live admin_users record on every request via
// isAdminSessionCurrent() (services/auth.ts) — a mismatch on either means
// something security-sensitive happened to this account since the token
// was issued, and the token is rejected regardless of remaining expiry.
// Mount directly after authenticateJWT on every admin route, in addition
// to (not instead of) each route's own `role !== 'admin'` check.
function requireCurrentAdminSession(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin' || !req.user.username) {
    // Not an admin-role token at all (e.g. admin_pending_2fa, or another
    // role entirely) — the route's own role check will reject it; nothing
    // further to verify here.
    return next();
  }
  db.getAdminByUsername(req.user.username)
    .then(admin => {
      if (!isAdminSessionCurrent(admin, req.user!.tokenVersion)) {
        return res.status(401).json({ error: 'Kikao chako cha msimamizi kimebatilishwa. Tafadhali ingia tena. / Your admin session has been revoked. Please log in again.' });
      }
      next();
    })
    .catch(err => {
      console.error('[requireCurrentAdminSession] Failed to verify admin session:', err);
      res.status(500).json({ error: 'Imeshindikana kuthibitisha kikao chako.' });
    });
}

// P1: error disclosure. Every one of this file's ~50 generic
// `catch (e: any) { res.status(500).json({ error: e.message }) }` blocks
// used to hand the caught exception's raw .message straight to the
// client — meaning a Postgres constraint violation ("duplicate key value
// violates unique constraint \"items_pkey\""), a filesystem path, a
// third-party provider's raw API error body, or any other unexpected
// internal detail could reach an end user verbatim, since these catch
// blocks are specifically the "something unexpected happened" path (not
// the ~400-level explicit validation checks throughout this file, which
// already return safe, intentional bilingual messages BEFORE ever
// reaching a catch block, and are untouched by this fix). In production,
// this always logs the full error server-side and returns a generic,
// safe message instead of the raw one; in development the raw message is
// still shown, matching this codebase's established pattern of being
// stricter in production than in dev (see storage.ts, payments.ts,
// social.ts's own fail-closed-in-production guards for the same shape of
// tradeoff elsewhere in this file).
function sendServerError(res: Response, error: any, context: string) {
  console.error(`[${context}]`, error);
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({ error: 'Hitilafu imetokea upande wa seva. Tafadhali jaribu tena baadaye. / A server error occurred. Please try again later.' });
  } else {
    res.status(500).json({ error: error?.message || String(error) });
  }
}

async function seedAdminUser() {
  try {
    const isEmpty = await db.isAdminTableEmpty();
    if (isEmpty) {
      const username = process.env.ADMIN_INITIAL_USERNAME;
      const password = process.env.ADMIN_INITIAL_PASSWORD;

      if (!username || !password) {
        console.warn('[ADMIN SEED WARNING] admin_users table is empty, but ADMIN_INITIAL_USERNAME or ADMIN_INITIAL_PASSWORD env vars are missing. Cannot seed first admin.');
        return;
      }

      const salt = await bcrypt.genSalt(12);
      const hash = await bcrypt.hash(password, salt);
      const id = 'ADM-' + Math.random().toString(36).substring(2, 11).toUpperCase();

      await db.createAdminUser(id, username, hash, 'First Administrator');
      console.log('================================================================');
      console.log(`[ADMIN SEED SUCCESS] Initial admin account created successfully!`);
      console.log(`Username: ${username}`);
      console.log('================================================================');
    }
  } catch (error) {
    console.error('[ADMIN SEED ERROR] Failed to seed initial admin user:', error);
  }
}

// ---------------------------------------------------------------------------
// CUSTOMER ACCOUNT AUTHENTICATION
// ---------------------------------------------------------------------------
// A customer account is a persistent identity/session, deliberately SEPARATE
// from claim ownership evidence (owner_phone, owner_id_proof_url, ...).
// Nothing here reads or mutates claims, payments, escrow, refunds or strikes.
// The raw session token exists only in the client's HttpOnly cookie; the
// server stores only its hash, and every protected request resolves the
// customer from that hash — a browser can never supply its own
// customerId/phone/name and be trusted.
//
// The cookie handling, helpers and the requireCustomerAuth middleware were
// moved VERBATIM to services/customerAuth.ts in Phase 2. Two reasons:
//   1. The customer claim routes now live in routes/customerClaims.ts, and
//      they need the exact same middleware — importing server.ts from another
//      module is impossible because this file calls startServer() at import
//      time.
//   2. The HTTP integration tests must exercise the REAL middleware; they can
//      import services/customerAuth.ts and mount a real Express app without
//      booting the whole application (Vite middleware, sweeps, listeners).
// Behaviour is unchanged: same cookie flags, same hash-only lookup, same
// revocation/expiry/live-status checks.


async function startServer() {
  // Run schema synchronization checks to prevent DB drift crashes.
  // ensureSchemaUpToDate() itself throws in production if any migration
  // statement genuinely failed (see its implementation) — that must be
  // fatal here too, not swallowed into a log line. Continuing to serve
  // traffic against a database that doesn't match what the application
  // code assumes is worse than refusing to start.
  try {
    await ensureSchemaUpToDate(pool);
  } catch (err) {
    console.error('================================================================');
    console.error('         RETURN4ME SCHEMA MIGRATION FATAL ERROR                 ');
    console.error('================================================================');
    console.error('Failed to sync database schema on startup:', err);
    if (process.env.NODE_ENV === 'production') {
      console.error('Refusing to start in production with an unverified database schema.');
      console.error('================================================================');
      process.exit(1);
    }
    console.error('Continuing in non-production environment despite the migration error.');
    console.error('================================================================');
  }

  // Sync categories and updated fee schedule on start
  await db.syncDefaultCategories().catch(err => console.error('Failed to sync categories on startup:', err));

  // Seed the initial admin account if needed
  await seedAdminUser();


  // FIX 2 & FIX 4: Verification and raw diagnostic logging
  try {
    const categories = await db.getCategories();
    
    // Fix 2: Integrity check
    const incompleteCategories: Array<{ id: string; missing: string[]; is_admin_modified: boolean }> = [];
    for (const cat of categories) {
      const missingFields: string[] = [];
      if (!cat.name_en || cat.name_en.trim() === '') {
        missingFields.push('name_en');
      }
      if (!cat.name_sw || cat.name_sw.trim() === '') {
        missingFields.push('name_sw');
      }
      const feeNum = Number(cat.total_fee);
      if (isNaN(feeNum) || feeNum <= 0) {
        missingFields.push('total_fee');
      }
      
      if (missingFields.length > 0) {
        incompleteCategories.push({ id: cat.id, missing: missingFields, is_admin_modified: !!cat.is_admin_modified });
      }
    }
    
    if (incompleteCategories.length > 0) {
      console.error('================================================================');
      console.error('          RETURN4ME CATEGORIES INTEGRITY CHECK FAILED           ');
      console.error('================================================================');
      console.error(`Incomplete categories detected: ${incompleteCategories.length} items`);
      for (const item of incompleteCategories) {
        const typeStr = item.is_admin_modified ? 'Admin Modified' : 'Default';
        console.error(` - Category ID: "${item.id}" (${typeStr}) is missing or invalid: ${item.missing.join(', ')}`);
      }
      console.error('================================================================');
    } else {
      console.log('[DATABASE ENGINE] Categories integrity check: ALL OK [OK]');
    }

  } catch (err) {
    console.error('Failed to perform category verification checks on startup:', err);
  }

  const app = express();

  // Intercept all 500 database connection errors and return 503 with the requested bilingual message
  app.use((req, res, next) => {
    const originalStatus = res.status;
    res.status = function(statusCode: number) {
      if (statusCode === 500) {
        const originalJson = res.json;
        res.json = function(body: any) {
          const errorMsg = body?.error || body?.message || String(body);
          if (isDatabaseConnectionError(errorMsg)) {
            originalStatus.call(res, 503);
            return originalJson.call(res, {
              error: "Huduma haipatikani kwa sasa. Tafadhali jaribu tena baadaye. / Service temporarily unavailable. Please try again shortly."
            });
          }
          return originalJson.call(res, body);
        };
        const originalSend = res.send;
        res.send = function(body: any) {
          const errorMsg = typeof body === 'string' ? body : (body?.error || body?.message || String(body));
          if (isDatabaseConnectionError(errorMsg)) {
            originalStatus.call(res, 503);
            res.setHeader('Content-Type', 'application/json');
            return originalSend.call(res, JSON.stringify({
              error: "Huduma haipatikani kwa sasa. Tafadhali jaribu tena baadaye. / Service temporarily unavailable. Please try again shortly."
            }));
          }
          return originalSend.call(res, body);
        };
      }
      originalStatus.call(res, statusCode);
      return res;
    };
    next();
  });

  // Enable trust proxy for Cloud Run/Container hosting environment
  app.set('trust proxy', 1);

  // Increase payload size for base64 camera photo uploads
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ limit: '20mb', extended: true }));

  // CORS & Security Headers Middleware (Self-contained)
  app.use((req, res, next) => {
    const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
    res.header('Access-Control-Allow-Origin', corsOrigin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // Baseline security headers
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'SAMEORIGIN');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    if (process.env.NODE_ENV === 'production') {
      res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
      res.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https:; frame-ancestors 'none';");
    } else {
      res.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https:;");
    }

    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // 0. HEALTH CHECK (Uptime and DB connection monitor, not rate limited)
  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({
        status: 'ok',
        db: 'connected',
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      // PHASE 12 — REPRODUCED DEFECT: this used to include
      // `error: err.message || String(err)` in the response body. /api/health is
      // unauthenticated, deliberately exempt from the global limiter, and this is
      // its "the database is unreachable" branch — i.e. the one moment a raw pg
      // error is most likely to contain infrastructure detail. MEASURED with the
      // real pg client against an unreachable local port:
      //   connect ECONNREFUSED 127.0.0.1:5599
      // (i.e. host and port), and other pg failure modes name the USER
      // ("password authentication failed for user \"...\""), the DATABASE, or the
      // internal hostname ("getaddrinfo ENOTFOUND ..."). That is exactly the class
      // of leak sendServerError() was introduced to eliminate everywhere else in
      // this file, and the tripwire test that guards it only matched the
      // single-line `res.status(500).json({ error: e.message` shape, so this
      // multi-line 503 slipped through. No client reads this field (verified: no
      // source file fetches /api/health), so the field is removed rather than
      // reworded — a health probe only needs status/db, and the full error is
      // already logged above.
      console.error('[HEALTHCHECK ERROR] Database connection check failed:', err);
      res.status(503).json({
        status: 'error',
        db: 'disconnected',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Apply general limiter on all /api routes
  app.use('/api', generalLimiter);

  // Simple Request Logger
  app.use((req, res, next) => {
    // Sanitize log to prevent regex-based log parsers from falsely flagging ErrorBoundary component requests as errors
    const safeUrl = req.url.replace(/ErrorBoundary/gi, 'ErrBoundary');
    console.log(`[HTTP] ${req.method} ${safeUrl}`);
    next();
  });

  // --- CUSTOMER ACCOUNT ROUTES ---
  // Persistent customer identity/session, separate from claim ownership.
  //   Registration: name + phone -> OTP -> verify -> customer + session
  //   Login:        phone -> OTP -> verify -> session
  // Responses are deliberately generic so an arbitrary phone cannot be probed
  // to learn whether it is already registered.

  app.post('/api/customer/register', customerAuthLimiter, otpGlobalLimiter, async (req, res) => {
    try {
      const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : '';
      const rawPhone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
      if (fullName.length < 2 || fullName.length > 120) {
        return res.status(400).json({ error: 'Tafadhali weka jina lako kamili. / Please enter your full name.' });
      }
      const phone = toE164Kenyan(rawPhone);
      if (!/^\+254\d{9}$/.test(phone)) {
        return res.status(400).json({ error: 'Weka nambari sahihi ya simu ya Kenya. / Enter a valid Kenyan phone number.' });
      }

      const throttleKey = phone + ':registration';
      if (Date.now() - (customerOtpLastSent.get(throttleKey) || 0) < CUSTOMER_OTP_RESEND_MS) {
        return res.status(429).json({ error: 'Tafadhali subiri kidogo kabla ya kuomba msimbo mwingine. / Please wait before requesting another code.' });
      }

      const code = generateCustomerOtp();
      await db.createCustomerOtp(
        generateSecureId('COTP'),
        phone,
        'registration',
        hashCode(code),
        new Date(Date.now() + CUSTOMER_OTP_TTL_MS),
        null
      );
      customerOtpLastSent.set(throttleKey, Date.now());
      await sendCodeViaSms(phone, code, 'Return4me', `Your Return4me verification code is ${code}. It expires in 5 minutes. Do not share it with anyone.`);

      // Generic on purpose — never reveals whether this phone already exists.
      return res.json({
        success: true,
        message: 'Kama nambari hii inaweza kutumika, msimbo wa uthibitisho umetumwa. / If this number can be used, a verification code has been sent.'
      });
    } catch (e: any) {
      return sendServerError(res, e, 'CUSTOMER_REGISTER_ERROR');
    }
  });

  app.post('/api/customer/register/verify', customerAuthLimiter, otpVerifyLimiter, async (req, res) => {
    try {
      const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : '';
      const rawPhone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
      const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
      const phone = toE164Kenyan(rawPhone);
      if (!/^\+254\d{9}$/.test(phone) || !/^\d{6}$/.test(code) || fullName.length < 2 || fullName.length > 120) {
        return res.status(400).json({ error: 'Taarifa si sahihi. / Invalid details.' });
      }

      const otp = await db.getActiveCustomerOtp(phone, 'registration');
      if (!otp) {
        return res.status(400).json({ error: 'Msimbo si sahihi au umeisha muda. / The code is invalid or has expired.' });
      }
      if (new Date(otp.expires_at).getTime() < Date.now()) {
        await db.consumeCustomerOtp(otp.id);
        return res.status(400).json({ error: 'Msimbo si sahihi au umeisha muda. / The code is invalid or has expired.' });
      }
      if ((otp.attempt_count || 0) >= CUSTOMER_OTP_MAX_ATTEMPTS) {
        return res.status(429).json({ error: 'Majaribio mengi ya msimbo. Omba msimbo mpya. / Too many attempts. Request a new code.' });
      }
      if (!timingSafeEqualHex(otp.code_hash, hashCode(code))) {
        await db.incrementCustomerOtpAttempts(otp.id, CUSTOMER_OTP_MAX_ATTEMPTS);
        return res.status(400).json({ error: 'Msimbo si sahihi au umeisha muda. / The code is invalid or has expired.' });
      }
      // One-time consume (CAS) — a replayed code can never succeed twice.
      const consumed = await db.consumeCustomerOtp(otp.id);
      if (!consumed) {
        return res.status(400).json({ error: 'Msimbo si sahihi au umeisha muda. / The code is invalid or has expired.' });
      }

      // Idempotent on normalized phone — a duplicate number never creates a
      // second account, and no client-supplied id/status/timestamp is trusted.
      let customer = await db.getCustomerByPhone(phone);
      if (customer) {
        if (customer.status !== 'active') {
          return res.status(403).json({ error: 'Akaunti hii haitumiki kwa sasa. / This account is not active.' });
        }
      } else {
        customer = await db.createCustomer(generateSecureId('CUS'), fullName, phone);
      }

      const rawToken = crypto.randomBytes(32).toString('hex');
      await db.createCustomerSession(
        generateSecureId('CSES'),
        customer.id,
        hashCode(rawToken),
        new Date(Date.now() + CUSTOMER_SESSION_TTL_MS)
      );
      setCustomerSessionCookie(res, rawToken);
      return res.json({ success: true, customer: toSafeCustomer(customer) });
    } catch (e: any) {
      return sendServerError(res, e, 'CUSTOMER_REGISTER_VERIFY_ERROR');
    }
  });

  app.post('/api/customer/login', customerAuthLimiter, otpGlobalLimiter, async (req, res) => {
    try {
      const rawPhone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
      const phone = toE164Kenyan(rawPhone);
      if (!/^\+254\d{9}$/.test(phone)) {
        return res.status(400).json({ error: 'Weka nambari sahihi ya simu ya Kenya. / Enter a valid Kenyan phone number.' });
      }

      const customer = await db.getCustomerByPhone(phone);
      // Only a genuinely registered, active account gets a code — but the
      // response is identical either way, so this cannot be used to discover
      // whether an arbitrary number is registered. Login NEVER creates an
      // account (an unknown phone cannot be turned into a takeover).
      if (customer && customer.status === 'active') {
        const throttleKey = phone + ':login';
        if (Date.now() - (customerOtpLastSent.get(throttleKey) || 0) >= CUSTOMER_OTP_RESEND_MS) {
          const code = generateCustomerOtp();
          await db.createCustomerOtp(
            generateSecureId('COTP'),
            phone,
            'login',
            hashCode(code),
            new Date(Date.now() + CUSTOMER_OTP_TTL_MS),
            customer.id
          );
          customerOtpLastSent.set(throttleKey, Date.now());
          await sendCodeViaSms(phone, code, 'Return4me', `Your Return4me login code is ${code}. It expires in 5 minutes. Do not share it with anyone.`);
        }
      }

      return res.json({
        success: true,
        message: 'Kama nambari hii imesajiliwa, msimbo wa kuingia umetumwa. / If this number is registered, a login code has been sent.'
      });
    } catch (e: any) {
      return sendServerError(res, e, 'CUSTOMER_LOGIN_ERROR');
    }
  });

  app.post('/api/customer/login/verify', customerAuthLimiter, otpVerifyLimiter, async (req, res) => {
    try {
      const rawPhone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
      const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
      const phone = toE164Kenyan(rawPhone);
      if (!/^\+254\d{9}$/.test(phone) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Msimbo si sahihi au umeisha muda. / The code is invalid or has expired.' });
      }

      const otp = await db.getActiveCustomerOtp(phone, 'login');
      if (!otp) {
        return res.status(400).json({ error: 'Msimbo si sahihi au umeisha muda. / The code is invalid or has expired.' });
      }
      if (new Date(otp.expires_at).getTime() < Date.now()) {
        await db.consumeCustomerOtp(otp.id);
        return res.status(400).json({ error: 'Msimbo si sahihi au umeisha muda. / The code is invalid or has expired.' });
      }
      if ((otp.attempt_count || 0) >= CUSTOMER_OTP_MAX_ATTEMPTS) {
        return res.status(429).json({ error: 'Majaribio mengi ya msimbo. Omba msimbo mpya. / Too many attempts. Request a new code.' });
      }
      if (!timingSafeEqualHex(otp.code_hash, hashCode(code))) {
        await db.incrementCustomerOtpAttempts(otp.id, CUSTOMER_OTP_MAX_ATTEMPTS);
        return res.status(400).json({ error: 'Msimbo si sahihi au umeisha muda. / The code is invalid or has expired.' });
      }
      const consumed = await db.consumeCustomerOtp(otp.id);
      if (!consumed) {
        return res.status(400).json({ error: 'Msimbo si sahihi au umeisha muda. / The code is invalid or has expired.' });
      }

      // The server — never the browser — determines which customer owns this
      // phone. A login code can never create an account.
      const customer = await db.getCustomerByPhone(phone);
      if (!customer) {
        return res.status(400).json({ error: 'Msimbo si sahihi au umeisha muda. / The code is invalid or has expired.' });
      }
      if (customer.status !== 'active') {
        return res.status(403).json({ error: 'Akaunti hii haitumiki kwa sasa. / This account is not active.', status: customer.status });
      }

      const rawToken = crypto.randomBytes(32).toString('hex');
      await db.createCustomerSession(
        generateSecureId('CSES'),
        customer.id,
        hashCode(rawToken),
        new Date(Date.now() + CUSTOMER_SESSION_TTL_MS)
      );
      setCustomerSessionCookie(res, rawToken);
      return res.json({ success: true, customer: toSafeCustomer(customer) });
    } catch (e: any) {
      return sendServerError(res, e, 'CUSTOMER_LOGIN_VERIFY_ERROR');
    }
  });

  // Logout is server-side: the stored session is revoked so the cookie is
  // unusable even if it was captured/retained.
  app.post('/api/customer/logout', requireCustomerAuth, async (req: any, res) => {
    try {
      await db.revokeCustomerSession(req.customerSession.id);
      clearCustomerSessionCookie(res);
      return res.json({ success: true });
    } catch (e: any) {
      return sendServerError(res, e, 'CUSTOMER_LOGOUT_ERROR');
    }
  });

  // Returns ONLY the authenticated customer's own safe fields. Identity comes
  // exclusively from the session — never from anything the browser supplies.
  app.get('/api/customer/me', requireCustomerAuth, async (req: any, res) => {
    return res.json({ customer: toSafeCustomer(req.customer) });
  });

  // ---------------------------------------------------------------------------
  // PHASE 2 — customer dashboard: explicit claim linking + the scoped claims
  // list/detail/unlink routes. Registered from routes/customerClaims.ts so the
  // HTTP integration tests can mount the real handlers and the real
  // requireCustomerAuth middleware without importing this file (which boots the
  // application at import time).
  //
  // checkClaimExpiry is injected rather than moved: it drives the shared claim
  // expiry + payment-strike lifecycle, which is deliberately left in this file
  // untouched. Function declarations are hoisted, so passing it here is safe.
  // ---------------------------------------------------------------------------
  registerCustomerClaimRoutes(app, { checkClaimExpiry });

  // ---------------------------------------------------------------------------
  // PHASE 9A — customer lost-item reports.
  //
  //   POST /api/lost-reports             (authenticated; creates a lost report)
  //   GET  /api/lost-reports             (authenticated; the caller's OWN reports)
  //   GET  /api/lost-reports/:id         (authenticated; one OWN report)
  //   GET  /api/lost-reports/:id/matches (Phase 9B; possible found-item matches)
  //
  // Registered from routes/lostReports.ts for the same reason as the customer
  // claim routes above: an HTTP integration test can mount the real handlers
  // around the real requireCustomerAuth middleware. sendServerError is passed
  // through so error disclosure behaviour is identical to every inline route,
  // and canCreateClaim is injected (never re-implemented) so the matching
  // engine can only ever surface an item that the public search, the public
  // item page and the claim endpoint would each already accept.
  // ---------------------------------------------------------------------------
  registerLostReportRoutes(app, { sendServerError, canCreateClaim });

  // ---------------------------------------------------------------------------
  // PHASE 7B — public item journey.
  //
  // GET  /api/items/:id/public          (the /item/:id detail read model)
  // POST /api/claims/:id/pickup-details (ownership-gated agent pickup info)
  //
  // Registered from routes/publicItems.ts for the same reason as the customer
  // claim routes above: an HTTP integration test can mount the real handlers.
  //
  // canCreateClaim is injected rather than duplicated — it is the single
  // central claimability rule, and the public detail route must agree with it
  // exactly or it would advertise an item the claim endpoint would refuse.
  // sendServerError is passed through so error disclosure behaviour (generic in
  // production, detailed in dev) is identical to every inline route.
  // ---------------------------------------------------------------------------
  registerPublicItemRoutes(app, { canCreateClaim, sendServerError });

  // --- API ROUTES ---

  // 1. CONFIGURATION & PUBLIC METADATA
  app.get('/api/categories', async (req, res) => {
    try {
      const categories = await db.getCategories();
      res.json(categories);
    } catch (e: any) {
      console.error('[API CATEGORIES ENGINE] Failed to fetch categories from database:', e);
      if (isDatabaseConnectionError(e)) {
        return res.status(503).json({
          error: "Huduma haipatikani kwa sasa. Tafadhali jaribu tena baadaye. / Service temporarily unavailable. Please try again shortly."
        });
      }
      sendServerError(res, e, 'CATEGORIES_FETCH_ERROR');
    }
  });

  app.get('/api/regions', async (req, res) => {
    try {
      const regions = await db.getDistinctRegions();
      res.json(regions);
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.get('/api/stats', async (req, res) => {
    try {
      const agents = await db.getAgents();
      const activeAgentsCount = agents.filter(a => a.status === 'active').length;
      res.json({ activeAgentsCount });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 2. OTP AUTHENTICATION GATEWAY (IP + Phone Rate-limited)
  app.post('/api/auth/request-otp', otpGlobalLimiter, otpIpLimiter, otpPhoneLimiter, async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) {
        return res.status(400).json({ error: 'Nambari ya simu inahitajika.' });
      }
      const result = await AuthService.requestOTP(phone);
      if (!result.success) {
        return res.status(400).json({ error: result.message });
      }
      const { otp, ...safeResult } = result as any;
      res.json(safeResult);
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/auth/verify-otp', otpVerifyLimiter, async (req, res) => {
    try {
      const { phone, code, role, businessName, locationAddress, tillNumber, payoutMethodType, nationalId, termsAccepted, contactEmail, shopPhotoBase64, idDocumentPhotoBase64 } = req.body;
      if (!phone || !code) {
        return res.status(400).json({ error: 'Nambari ya simu na msimbo wa OTP zinahitajika.' });
      }

      const verification = await AuthService.verifyOTP(phone, code);
      if (!verification.success) {
        return res.status(400).json({ error: verification.message });
      }

      // Role differentiation
      let userRole = role || 'owner';
      let agentId: string | undefined;

      if (userRole === 'agent') {
        // If it's a registration/onboarding request, save agent application first
        const agents = await db.getAgents();
        const existingAgent = agents.find(a => a.contact_phone === phone);
        if (existingAgent) {
          agentId = existingAgent.id;
          userRole = 'agent';
        } else {
          // Create new agent application
          if (!businessName || !locationAddress || !tillNumber || !nationalId) {
            return res.status(400).json({ error: 'Tafadhali weka maelezo yote ya biashara ili kujisajili kama Agent.' });
          }

          if (!termsAccepted) {
            return res.status(400).json({ error: 'Ni lazima ukubali Vigezo na Masharti yetu kabla ya kujisajili.' });
          }

          let shopPhotoUrl: string | null = null;
          let idPhotoUrl: string | null = null;

          if (shopPhotoBase64) {
            if (!isValidImageSignature(shopPhotoBase64)) {
              return res.status(400).json({ error: 'Aina ya picha ya duka haikubaliki. Pakia picha ya JPEG, PNG, WEBP, au HEIC.' });
            }
            shopPhotoUrl = await uploadBase64Image(shopPhotoBase64, 'agent-shops');
          }

          if (idDocumentPhotoBase64) {
            if (!isValidImageSignature(idDocumentPhotoBase64)) {
              return res.status(400).json({ error: 'Aina ya picha ya kitambulisho cha wakala haikubaliki. Pakia picha ya JPEG, PNG, WEBP, au HEIC.' });
            }
            idPhotoUrl = await uploadBase64Image(idDocumentPhotoBase64, 'agent-ids');
          }
          
          const geoResult = await geocodeAddress(locationAddress);
          
          const newId = 'agent-' + Math.random().toString(36).substr(2, 7);
          const newAgent = await db.createAgent({
            id: newId,
            business_name: businessName,
            contact_phone: phone,
            location_address: locationAddress,
            latitude: geoResult.latitude,
            longitude: geoResult.longitude,
            needs_manual_geocoding: geoResult.needsManual,
            mpesa_till_or_paybill: tillNumber,
            payout_method_type: payoutMethodType || 'Till Number',
            status: 'pending',
            refundable_deposit: 0,
            national_id_hash: hashDocument(nationalId),
            terms_accepted_at: new Date().toISOString(),
            contact_email: contactEmail || null,
            shop_photo_url: shopPhotoUrl,
            id_document_photo_url: idPhotoUrl,
          });

          await db.logAudit(
            phone,
            'TERMS_ACCEPTED',
            `Agent application terms and privacy accepted for ${businessName} (Phone: ${phone})`
          );
          
          agentId = newAgent.id;
          userRole = 'agent';
        }
      }

      const token = generateToken({
        userId: phone,
        phone: phone,
        role: userRole,
        agentId,
      });

      let agentStatus = 'active';
      if (agentId) {
        const agent = await db.getAgent(agentId);
        if (agent) agentStatus = agent.status;
      }

      res.json({
        success: true,
        token,
        profile: {
          phone,
          role: userRole,
          agentId,
          status: agentStatus,
        },
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // Admin login via per-admin accounts with password hashing (Rate Limited)
  app.post('/api/auth/admin-login', adminLoginLimiter, async (req, res) => {
    try {
      const { username } = req.body;
      const password = req.body.password || req.body.passcode;

      if (!username || !password) {
        return res.status(400).json({ error: 'Tafadhali weka jina la mtumiaji na nenosiri.' });
      }

      const admin = await db.getAdminByUsername(username);
      if (!admin) {
        return res.status(401).json({ error: 'Maelezo yasiyo sahihi ya msimamizi.' });
      }

      if (!admin.is_active) {
        return res.status(403).json({ error: 'Akaunti hii ya msimamizi imesitishwa.' });
      }

      const isMatch = await bcrypt.compare(password, admin.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Maelezo yasiyo sahihi ya msimamizi.' });
      }

      // If this admin has 2FA enrolled, password verification alone is not
      // enough to issue a real session. Instead of the full admin token,
      // issue a short-lived, narrowly-scoped 'admin_pending_2fa' token —
      // it fails every existing admin route's `role !== 'admin'` check
      // automatically, so even if this token leaked in the few minutes
      // before it expires, it can't be used for anything except attempting
      // the second-factor verification endpoint below.
      if (admin.totp_enabled) {
        const pendingToken = generateToken({
          userId: admin.id,
          phone: '+254700000000',
          role: 'admin_pending_2fa',
          username: admin.username,
        }, '5m');
        return res.json({
          success: true,
          requiresTwoFactor: true,
          pendingToken,
          message: 'Weka msimbo wako wa uthibitishaji wa hatua mbili (2FA). / Enter your two-factor authentication code.',
        });
      }

      await db.updateAdminLastLogin(admin.id);

      // Admin sessions are deliberately shorter-lived (4h) than the default
      // 24h used for ordinary user tokens — an admin session can flag items
      // stolen, override settlement timing, and change category fee
      // configuration, and this codebase has no server-side token
      // revocation (logout is client-side only, consistent with every
      // other role here). A shorter expiry is the proportionate way to
      // bound a leaked token's usable window without introducing a new
      // session/blacklist table.
      const token = generateToken({
        userId: admin.id,
        phone: '+254700000000',
        role: 'admin',
        username: admin.username,
        tokenVersion: admin.token_version,
      }, '4h');

      return res.json({
        success: true,
        token,
        profile: {
          role: 'admin',
          username: admin.username,
          fullName: admin.full_name,
          totpEnabled: admin.totp_enabled,
        }
      });
    } catch (error: any) {
      console.error('[ADMIN LOGIN ERROR]', error);
      res.status(500).json({ error: 'Hitilafu ya mfumo imetokea wakati wa kuingia.' });
    }
  });

  // Second step of admin login when 2FA is enrolled: exchanges a
  // password-verified 'admin_pending_2fa' token plus a valid TOTP code for
  // the real admin session token.
  app.post('/api/auth/admin-login/verify-2fa', adminLoginLimiter, async (req, res) => {
    try {
      const { pendingToken, code } = req.body;
      if (!pendingToken || !code) {
        return res.status(400).json({ error: 'Tokeni na msimbo wa 2FA zinahitajika.' });
      }

      const pendingPayload = verifyToken(pendingToken);
      if (!pendingPayload || pendingPayload.role !== 'admin_pending_2fa') {
        return res.status(401).json({ error: 'Muda wa kuingia umeisha. Tafadhali anza tena. / Login session expired. Please start over.' });
      }

      const admin = await db.getAdminByUsername(pendingPayload.username || '');
      if (!admin || admin.id !== pendingPayload.userId || !admin.is_active) {
        return res.status(401).json({ error: 'Maelezo yasiyo sahihi ya msimamizi.' });
      }
      if (!admin.totp_enabled || !admin.totp_secret) {
        return res.status(400).json({ error: '2FA haijawezeshwa kwa akaunti hii.' });
      }

      const totp = new OTPAuth.TOTP({
        issuer: 'Return4me',
        label: admin.username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(admin.totp_secret),
      });
      // window: 1 tolerates the code from one 30s step before/after the
      // current one, to absorb ordinary clock drift between the admin's
      // authenticator app and this server without meaningfully widening
      // the brute-force window (still only 3 possible valid codes at once,
      // same order of magnitude as the OTP tolerance used elsewhere in
      // this codebase).
      const delta = totp.validate({ token: String(code).trim(), window: 1 });
      if (delta === null) {
        return res.status(400).json({ error: 'Msimbo wa 2FA si sahihi. / Incorrect 2FA code.' });
      }

      await db.updateAdminLastLogin(admin.id);

      const token = generateToken({
        userId: admin.id,
        phone: '+254700000000',
        role: 'admin',
        username: admin.username,
        tokenVersion: admin.token_version,
      }, '4h');

      return res.json({
        success: true,
        token,
        profile: {
          role: 'admin',
          username: admin.username,
          fullName: admin.full_name,
          totpEnabled: admin.totp_enabled,
        }
      });
    } catch (error: any) {
      console.error('[ADMIN 2FA VERIFY ERROR]', error);
      res.status(500).json({ error: 'Hitilafu ya mfumo imetokea wakati wa kuthibitisha 2FA.' });
    }
  });

  // Begins 2FA enrollment for an already-logged-in admin. Generates a
  // fresh secret and stores it UNCONFIRMED (totp_enabled stays false) —
  // login continues to work password-only until the admin proves they can
  // actually generate a valid code from it via the confirm endpoint below,
  // so a half-finished enrollment (e.g. they closed the tab before
  // scanning the QR code) can never lock them out.
  app.post('/api/auth/admin-2fa/setup', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const admin = await db.getAdminByUsername(req.user.username || '');
      if (!admin) {
        return res.status(404).json({ error: 'Msimamizi hakupatikana.' });
      }

      const secret = new OTPAuth.Secret({ size: 20 });
      await db.setAdminTotpSecret(admin.id, secret.base32);

      const totp = new OTPAuth.TOTP({
        issuer: 'Return4me',
        label: admin.username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret,
      });

      res.json({
        success: true,
        secret: secret.base32,
        otpauthUrl: totp.toString(),
        message: 'Skani msimbo wa QR kwa programu yako ya uthibitishaji, kisha thibitisha msimbo ili kuwezesha 2FA. / Scan the QR code with your authenticator app, then confirm a code to enable 2FA.',
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // Confirms enrollment: the admin must prove the secret from /setup above
  // actually works before 2FA is turned on and required at login.
  app.post('/api/auth/admin-2fa/confirm', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const { code } = req.body;
      if (!code) {
        return res.status(400).json({ error: 'Msimbo wa 2FA unahitajika.' });
      }
      const admin = await db.getAdminByUsername(req.user.username || '');
      if (!admin || !admin.totp_secret) {
        return res.status(400).json({ error: 'Anza uwekaji wa 2FA kwanza. / Start 2FA setup first.' });
      }

      const totp = new OTPAuth.TOTP({
        issuer: 'Return4me',
        label: admin.username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(admin.totp_secret),
      });
      const delta = totp.validate({ token: String(code).trim(), window: 1 });
      if (delta === null) {
        return res.status(400).json({ error: 'Msimbo si sahihi. Jaribu tena. / Incorrect code. Please try again.' });
      }

      await db.confirmAdminTotpEnrollment(admin.id);
      res.json({ success: true, message: '2FA imewezeshwa kikamilifu kwa akaunti yako. / 2FA has been successfully enabled on your account.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // Disabling 2FA requires re-proving the account password (not just an
  // active session token) — the same standard this codebase already
  // applies to other sensitive account changes, since a stolen/left-open
  // session shouldn't be enough on its own to turn off an account's second
  // factor.
  app.post('/api/auth/admin-2fa/disable', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const { password } = req.body;
      if (!password) {
        return res.status(400).json({ error: 'Nenosiri linahitajika kuzima 2FA.' });
      }
      const admin = await db.getAdminByUsername(req.user.username || '');
      if (!admin) {
        return res.status(404).json({ error: 'Msimamizi hakupatikana.' });
      }
      const isMatch = await bcrypt.compare(password, admin.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Nenosiri si sahihi.' });
      }

      await db.disableAdminTotp(admin.id);
      // Disabling 2FA is exactly the kind of security-sensitive account
      // change requireCurrentAdminSession's tokenVersion check exists for
      // — bump it so every other currently-active session for this admin
      // (on other devices/browsers, or a stolen-but-still-valid token) is
      // immediately invalidated and forced to re-authenticate, rather than
      // silently continuing to work under the now-weaker 2FA-less posture
      // until each token's own 4h expiry.
      await db.bumpAdminTokenVersion(admin.username);
      res.json({ success: true, message: '2FA imezimwa kwa akaunti hii. / 2FA has been disabled on this account.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // GDPR / Kenya Data Protection Act 2019 Section 40: Right to Erasure / Personal Data Deletion Request
  app.post('/api/auth/request-data-deletion', otpVerifyLimiter, async (req, res) => {
    const { phone, code, confirmConsent } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ error: 'Nambari ya simu na msimbo wa OTP zinahitajika. / Phone number and OTP code are required.' });
    }
    if (!confirmConsent) {
      return res.status(400).json({ error: 'Ni lazima uthibitishe idhini ya kufuta data yako ya kibinafsi. / You must confirm consent to delete your personal data.' });
    }

    try {
      const verification = await AuthService.verifyOTP(phone, code);
      if (!verification.success) {
        return res.status(400).json({ error: verification.message });
      }

      // Perform technical erasure of personal data associated with this phone
      await db.purgeUserData(phone);

      await db.logAudit(
        phone,
        'DATA_DELETION_REQUESTED',
        `User ${phone} completed OTP-verified personal data deletion under Section 40 of Kenya DPA 2019.`
      );

      res.json({
        success: true,
        message: 'Ombi lako la kufuta data limetekelezwa kikamilifu. Data yako yote ya kibinafsi imeondolewa au kufutwa jina (anonymized) kwenye mifumo yetu kwa mujibu wa Sheria ya Ulinzi wa Data ya Kenya, 2019. / Your data erasure request has been executed successfully. All your personal data has been completely removed or anonymized in our systems in accordance with the Kenya Data Protection Act, 2019.'
      });
    } catch (e: any) {
      console.error('[DATA DELETION ERROR]', e);
      sendServerError(res, e, 'DATA_DELETION_ERROR');
    }
  });

  // 3. FINDER FLOW: PRE-ANALYZE PHOTO USING GEMINI OCR
  app.post('/api/items/analyze', ocrAnalyzeLimiter, async (req, res) => {
    const { photoBase64 } = req.body;
    if (!photoBase64) {
      return res.status(400).json({ error: 'Picha inahitajika kufanya OCR.' });
    }
    if (!isValidImageSignature(photoBase64)) {
      return res.status(400).json({ error: 'Aina ya picha haikubaliki. Tafadhali pakia picha halisi ya JPEG, PNG, WEBP, au HEIC.' });
    }

    try {
      const ocrResult = await OcrService.extractDocumentDetails(photoBase64);
      res.json(ocrResult);
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 4. FINDER FLOW: REPORT / SAVE FOUND ITEM (Rate Limited)
  app.post('/api/items/report', reportLimiter, async (req, res) => {
    const {
      categoryId,
      photoBase64,
      extractedNumber,
      extractedName,
      locationDescription,
      latitude,
      longitude,
      foundCounty,
      finderPhone,
      createAccount,
      termsAccepted,
      description,
      finderEmail,
      declaredValue,
    } = req.body;

    if (await isPlatformOperationPaused(pauseSettingKey('reports'))) {
      return res.status(503).json({ error: PAUSED_MESSAGES.reports });
    }

    if (!categoryId || !photoBase64 || !locationDescription || !finderPhone) {
      return res.status(400).json({ error: 'Tafadhali jaza sehemu zote zinazohitajika.' });
    }

    // -----------------------------------------------------------------------
    // PHASE 9D — FOUND-ITEM COUNTY (required, canonical, user-declared)
    // -----------------------------------------------------------------------
    // The Finder must now state WHICH COUNTY the item was found in. This is the
    // authoritative found-side geographic field.
    //
    // WHY IT IS REQUIRED RATHER THAN INFERRED: before Phase 9D the found side
    // had no county at all, so the matcher guessed one by scanning the free-text
    // location for county names. That produced a real, reproducible false
    // positive — "Mombasa Road" (a Nairobi street) read as Mombasa County and
    // "Kiambu Road" read as Kiambu County — which could then wrongly ELIMINATE
    // a correct candidate. Asking the Finder removes the guess at its source.
    //
    // VALIDATION IS SERVER-SIDE AND AUTHORITATIVE. The browser may pre-validate
    // for UX, but nothing from the client is trusted: `resolveCountyName()` is
    // the SAME canonical resolver (and the same 47-county list) the lost-report
    // route uses, and it never guesses a nearby county. A value that does not
    // resolve is REJECTED — it is never silently stored, dropped, or coerced.
    //
    // ORDER MATTERS: this runs before image validation and before any agent
    // matching/geocoding, so an invalid county cannot trigger the paid OCR path
    // or an outbound geocoding request.
    const foundCountyResolution = resolveFoundCountyInput(foundCounty);
    if (!foundCountyResolution.ok) {
      return res.status(400).json({ error: foundCountyResolution.error });
    }
    const canonicalFoundCounty = foundCountyResolution.county;

    // Declared value is an OPTIONAL, unverified estimate the finder can give
    // of what the item would cost to replace. It is never treated as fact —
    // it only ever feeds the Recovery Fee Engine's ceiling calculation
    // (src/services/feeEngine.ts), and the ceiling only ever pulls the fee
    // DOWN, never up. Silently ignore anything that isn't a sane positive
    // number rather than rejecting the whole report over it.
    let parsedDeclaredValue: number | null = null;
    if (declaredValue !== undefined && declaredValue !== null && declaredValue !== '') {
      const n = parseFloat(declaredValue);
      if (!isNaN(n) && n > 0 && n < 100_000_000) {
        parsedDeclaredValue = n;
      }
    }

    if (createAccount && !termsAccepted) {
      return res.status(400).json({ error: 'Ni lazima ukubali Vigezo na Masharti ili kufungua akaunti.' });
    }

    if (!isValidImageSignature(photoBase64)) {
      return res.status(400).json({ error: 'Aina ya picha haikubaliki. Tafadhali pakia picha halisi ya JPEG, PNG, WEBP, au HEIC.' });
    }

    try {
      const isOther = categoryId === 'other';
      const categories = await db.getCategories();

      // -----------------------------------------------------------------------
      // PHASE 12 (P12-F1): the category is validated BEFORE any side effect.
      //
      // This route previously looked the category up and then carried on even
      // when it did not exist: `cat` was undefined, `isSensitive` fell back to
      // its fail-closed `true`, and execution continued through agent matching
      // and `uploadBase64Image()` — a REAL storage write — before `db.createItem`
      // finally failed the `items_category_id_fkey` constraint. The catch below
      // then reported it as a 500 "Failed to save found item.", so a trivially
      // malformed public request produced (a) a 5xx instead of a 4xx, (b) a full
      // stack trace in the error log for a client input error, and (c) an
      // orphaned uploaded photo object with no item row referencing it.
      //
      // The lost-report route has always rejected an unknown category up front
      // (routes/lostReports.ts -> validateLostReportPayload -> MESSAGES.categoryInvalid);
      // this makes the found-item route behave the same way, with the same
      // wording, and keeps the rejection free of side effects.
      // -----------------------------------------------------------------------
      const cat = categories.find(c => c.id === categoryId);
      if (!cat) {
        return res.status(400).json({ error: 'Aina ya kitu haikubaliki. / That item category is not valid.' });
      }
      const isSensitive = cat.is_sensitive_document !== false;

      // 1. Assign nearest physical Return4me agent
      //
      // PHASE 9D: the optional device-supplied pair is validated ONCE, here, by
      // the shared validator. A malformed, non-finite or out-of-range value now
      // yields `null` for BOTH halves instead of a NaN or an absurd number
      // reaching the distance comparison and the database. A legitimate
      // coordinate of exactly 0 is preserved rather than treated as absent.
      //
      // This is validation ONLY. It deliberately does not give the pair a
      // meaning: `items.latitude/longitude` keep exactly the semantic they had
      // (an optional, best-effort device position used to route the drop-off to
      // a nearby Agent hub). Nothing downstream may treat it as the item's
      // found location, as a county, or as evidence about ownership.
      const coordinates = normalizeCoordinateInput(
        latitude ?? null,
        longitude ?? null,
      );
      const numericLat = coordinates ? coordinates.latitude : null;
      const numericLon = coordinates ? coordinates.longitude : null;

      const matchingResult = await AgentMatchingService.assignNearestAgent(numericLat, numericLon, locationDescription);
      const assignedAgent = matchingResult.agent;

      // Upload found-item photo to S3 storage
      const photoUrl = await uploadBase64Image(photoBase64, 'items');

      // 2. Generate secure unique drop-off code
      const dropoffCode = 'R4M-' + Math.floor(100 + Math.random() * 900) + Math.random().toString(36).substr(2, 3).toUpperCase();

      // 3. Create document hashes for privacy-safe exact matching via secure HMAC-SHA256
      // Skip OCR and salted hashing entirely for non-sensitive items
      const saltedHash = (isSensitive && !isOther && extractedNumber) ? hashDocument(extractedNumber) : null;
      const fuzzyMaskedName = (isSensitive && !isOther && extractedName) ? maskName(extractedName) : (isSensitive ? null : (extractedName || (cat ? cat.name_en : 'Found Item')));

      // Get finder phone reputation
      const reputation = await db.getPhoneReputation(finderPhone);

      // Determine flagged status - default to true if other, key details are missing (only for sensitive docs), category requires elevated review (cash/children's-property), agent assignment could not be made with any real confidence, or client specifies, or reputation auto-flags
      const isFlagged = isOther || 
                        reputation.autoFlag || 
                        (cat ? cat.elevated_review : false) ||
                        matchingResult.needsManualAgentReassignment ||
                        (req.body.flaggedForReview !== undefined ? !!req.body.flaggedForReview : (isSensitive ? (!extractedNumber || !extractedName) : false));

      // RECOVERY FEE ENGINE: an admin who has explicitly hand-set a flat fee
      // for this category (is_admin_modified) keeps that override verbatim —
      // unchanged legacy behaviour. Otherwise compute the fee from the
      // category's engine config: base + complexity + delay, capped at
      // ceiling_percent of the finder's declared value when one was given.
      // See src/services/feeEngine.ts for the full reasoning.
      let lockedTotalFee: number | null = cat ? cat.total_fee : null;
      let lockedFinderShare: number | null = cat ? cat.finder_share : null;
      let lockedAgentShare: number | null = cat ? cat.agent_share : null;
      let lockedPlatformShare: number | null = cat ? cat.platform_share : null;
      let feeCeilingApplied = false;

      if (cat && !cat.is_admin_modified) {
        const breakdown = computeRecoveryFee({
          base_fee: cat.base_fee,
          complexity_fee: cat.complexity_fee,
          delay_fee: cat.delay_fee,
          ceiling_percent: cat.ceiling_percent,
          finder_pct: cat.finder_pct,
          agent_pct: cat.agent_pct,
          platform_pct: cat.platform_pct,
          finder_reward_cap: cat.finder_reward_cap,
        }, parsedDeclaredValue);
        lockedTotalFee = breakdown.totalFee;
        lockedFinderShare = breakdown.finderAmount;
        lockedAgentShare = breakdown.agentAmount;
        lockedPlatformShare = breakdown.platformAmount;
        feeCeilingApplied = breakdown.ceilingApplied;
      }

      const newItem = await db.createItem({
        id: dropoffCode,
        category_id: categoryId,
        photo_url: photoUrl,
        ocr_extracted_number: (isSensitive && !isOther) ? (extractedNumber || null) : null,
        ocr_extracted_name: (isSensitive && !isOther) ? (extractedName ? extractedName.toUpperCase() : null) : null,
        document_number_hash: saltedHash,
        document_name_fuzzy: fuzzyMaskedName,
        location_description: locationDescription,
        // PHASE 9D: the Finder's explicit, canonical, server-validated county.
        // `locationDescription` above is stored UNCHANGED — the user's own
        // wording is never replaced, normalized in place, or overwritten by any
        // provider result (see §8 of the Phase 9D brief).
        found_county: canonicalFoundCounty,
        latitude: numericLat,
        longitude: numericLon,
        finder_phone: finderPhone,
        // No arbitrary/fallback agent is ever assigned — assignNearestAgent
        // returns agent: null whenever it can't confidently match one, and
        // that null is preserved here rather than being papered over. The
        // item enters the admin manual-assignment queue instead (see
        // needs_manual_agent_reassignment below and the
        // POST /api/admin/items/:id/review endpoint, which an admin uses to
        // actually assign an agent once one is confidently selected).
        assigned_agent_id: assignedAgent ? assignedAgent.id : null,
        status: 'awaiting_dropoff',
        flaggedForReview: isFlagged,
        isDescriptionOnly: isOther || !isSensitive,
        description: (isOther || !isSensitive) ? (description || extractedName || (cat ? cat.name_en : 'Found item')) : null,
        is_sensitive_document: isSensitive,
        rejection_reason: null,
        locked_total_fee: lockedTotalFee,
        locked_finder_share: lockedFinderShare,
        locked_agent_share: lockedAgentShare,
        locked_platform_share: lockedPlatformShare,
        agent_assignment_method: matchingResult.method,
        agent_assignment_distance_km: matchingResult.distanceKm,
        needs_manual_agent_reassignment: matchingResult.needsManualAgentReassignment,
        finder_email: finderEmail || null,
        declared_value: parsedDeclaredValue,
        fee_ceiling_applied: feeCeilingApplied,
      });

      if (matchingResult.method === 'manual_required') {
        EmailService.sendAdminNewReassignmentRequestEmail(
          newItem.id,
          locationDescription,
          finderPhone
        ).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Admin reassignment email failed:', err));
      }

      if (createAccount && termsAccepted) {
        await db.logAudit(
          finderPhone,
          'TERMS_ACCEPTED',
          `Finder account terms and privacy accepted for phone ${finderPhone} during item report`
        );
      }

      res.json({
        success: true,
        item: {
          id: newItem.id,
          // assignedAgent is null when the item is awaiting manual admin
          // assignment — the frontend must handle this case with honest
          // messaging ("we're finding the right agent for you") rather
          // than assuming an agent object is always present.
          assignedAgent,
        },
        message: assignedAgent
          ? 'Ripoti yako imepokelewa kikamilifu! Msimbo wako wa kuwasilisha bidhaa kwa Agent umezalishwa.'
          : 'Ripoti yako imepokelewa! Tunatafuta Agent anayefaa karibu nawe na tutakujulisha hivi karibuni. / Your report has been received! We\'re finding the right Agent near you and will notify you shortly.',
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 5. OWNER SEARCH: PRIVACY-MASKED RESULTS
  app.get('/api/items/search', async (req, res) => {
    const { q, categoryId, area } = req.query;

    try {
      // PERFORMANCE: canCreateClaim() only ever returns allowed:true for
      // status==='at_agent' — every other status (awaiting_dropoff,
      // claimed, expired, rejected, suspected_stolen, legal_hold) always
      // returns allowed:false. So fetching only 'at_agent' rows at the SQL
      // level (via getItemsByStatus, replacing an unfiltered
      // db.getItems() table scan) produces an identical final result set
      // while skipping every row that could never have passed anyway —
      // see the comment on getItemsByStatus in database.ts.
      const allItems = await db.getItemsByStatus('at_agent');
      // Public search must only ever show items that are CURRENTLY
      // claimable — routed through the same canCreateClaim() rule used at
      // claim-submission time, so this list can never drift from what the
      // claim endpoint will actually accept. Previously this allowed
      // 'awaiting_dropoff' items through: a Finder's report on its own,
      // before any Agent has physically verified the item exists. That is
      // not a verified found item and must never be publicly claimable.
      //
      // PERFORMANCE: canCreateClaim's dispute check used to run as its own
      // db.getDisputesByItem() query per item inside this Promise.all — an
      // N+1 pattern where every search request fired one dispute query per
      // result. Batched into a single db.getDisputesByItemIds() call up
      // front instead; see that method's comment.
      const disputesByItem = await db.getDisputesByItemIds(allItems.map(item => item.id));
      const claimabilityChecks = await Promise.all(allItems.map(async item => ({ item, result: await canCreateClaim(item, disputesByItem.get(item.id) ?? []) })));
      let items = claimabilityChecks.filter(c => c.result.allowed).map(c => c.item);

      // Filter by category
      if (categoryId) {
        items = items.filter(item => item.category_id === categoryId);
      }

      // Filter by area text
      if (area) {
        const areaLower = (area as string).toLowerCase();
        items = items.filter(item => item.location_description.toLowerCase().includes(areaLower));
      }

      // If search query is provided
      if (q) {
        const queryStr = (q as string).trim().toUpperCase();

        // Exact match via secure HMAC-SHA256 hash
        const queryHash = hashDocument(queryStr);
        // Exclude description-only items from exact hash matches
        const exactMatches = items.filter(item => !item.isDescriptionOnly && item.document_number_hash === queryHash);

        if (exactMatches.length > 0) {
          items = exactMatches;
        } else {
          // Fuzzy name matching fallback OR description-only search
          items = items.filter(item => {
            if (item.isDescriptionOnly || item.is_sensitive_document === false) {
              const desc = (item.description || '').toUpperCase();
              const loc = (item.location_description || '').toUpperCase();
              const title = (item.document_name_fuzzy || '').toUpperCase();
              return desc.includes(queryStr) || loc.includes(queryStr) || title.includes(queryStr);
            }
            if (!item.ocr_extracted_name) return false;
            // Check if parts of query exist in extracted name
            const nameParts = item.ocr_extracted_name.split(/\s+/);
            const queryParts = queryStr.split(/\s+/);
            return queryParts.some(qp => nameParts.some(np => np.includes(qp) || qp.includes(np)));
          });
        }
      }

      // Privacy Mask: Never send plaintext names/numbers or finder details to public searchers
      // Limit agent details to business_name and rough_area for privacy (Item 1)
      //
      // This used to call db.getAgent(item.assigned_agent_id) once per item
      // inside the map below — on the public search endpoint, almost
      // certainly the highest-traffic route in the app. A 50-item result
      // page meant 50 separate DB round-trips, even though there are far
      // fewer physical agent hubs nationally than there are found items, so
      // most of those round-trips were re-fetching the same handful of
      // agents over and over. One bulk fetch + an in-memory lookup turns N
      // round-trips into 1, regardless of how many items are in the page.
      const allAgentsForSearch = await db.getAgents();
      const agentByIdForSearch = new Map(allAgentsForSearch.map(a => [a.id, a]));

      const maskedResults = items.map(item => {
        const rawAgent = item.assigned_agent_id ? agentByIdForSearch.get(item.assigned_agent_id) : null;
        // Phase 7B: the masking itself now lives in services/publicItemView.ts
        // (toPublicItemView) so this route and GET /api/items/:id/public return
        // byte-for-byte the same shape. Behaviour is unchanged here.
        return toPublicItemView(item, rawAgent);
      });

      res.json(maskedResults);
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 6. OWNER CLAIMS: TIERED IDENTITY VERIFICATION
  app.post('/api/claims/submit', async (req, res) => {
    const { itemId, ownerPhone, securityAnswers, verificationTier, idProofBase64, termsAccepted, ownerIdentifyingDetails, ownerEmail } = req.body;

    if (await isPlatformOperationPaused(pauseSettingKey('claims'))) {
      return res.status(503).json({ error: PAUSED_MESSAGES.claims });
    }

    if (!itemId || !ownerPhone || !securityAnswers) {
      return res.status(400).json({ error: 'Tafadhali jaza maelezo yote ya usajili wa claim.' });
    }

    if (!termsAccepted) {
      return res.status(400).json({ error: 'Ni lazima ukubali Vigezo na Masharti yetu kabla ya kuendelea (You must agree to our Terms and Privacy Policy).' });
    }

    // The frontend previously fell back to a hardcoded sandbox number when a
    // phone was missing. That fallback must never reach production identity
    // handling: a claim's owner_phone is the handle used for OTP, pickup-code
    // delivery and claimant lookup, so the server now requires a real value.
    const normalizedOwnerPhone = toE164Kenyan(String(ownerPhone).replace(/\s+/g, ''));
    if (!/^\+254\d{9}$/.test(normalizedOwnerPhone)) {
      return res.status(400).json({ error: 'Nambari ya simu halali ya Kenya inahitajika. / A valid Kenyan phone number is required.' });
    }

    const ownerIdentifyingDetailValue =
      typeof ownerIdentifyingDetails === 'string' ? ownerIdentifyingDetails.trim() : '';
    if (!ownerIdentifyingDetailValue) {
      return res.status(400).json({ error: 'Maelezo ya kitambulisho yanahitajika. / An identifying detail is required.' });
    }
    if (ownerIdentifyingDetailValue.length > 300) {
      return res.status(400).json({ error: 'Maelezo ya kitambulisho ni marefu kupita kiasi. / Identifying detail is too long.' });
    }

    try {
      const strikeCount = await db.getPaymentStrikeCount(ownerPhone);
      if (strikeCount >= 3) {
        return res.status(403).json({
          error: "Akaunti yako imezuiliwa kwa muda kwa sababu ya kutolipa baada ya kuthibitisha mara kwa mara. Tafadhali wasiliana na usaidizi. / Your account is temporarily restricted due to repeated unpaid confirmations. Please contact support or administrator."
        });
      }

      const item = await db.getItem(itemId);
      if (!item) {
        return res.status(404).json({ error: 'Bidhaa inayotafutwa haikupatikana.' });
      }

      // Central claimability rule — see canCreateClaim(). Independently
      // re-verified here rather than trusting that the item was claimable
      // when it appeared in a search result; the two checks must never be
      // allowed to drift apart, which is exactly why they share one
      // function instead of being reimplemented per-endpoint.
      const claimability = await canCreateClaim(item);
      if (!claimability.allowed) {
        return res.status(423).json({ error: claimabilityErrorMessage(claimability.reason) });
      }

      // Server-authoritative verification profile enforcement. The category is
      // the item's SERVER-KNOWN category, never a category supplied by the
      // claimant. Unknown keys, wrong types, oversized/forbidden values and
      // missing required fields are rejected before anything is stored.
      const categoryId = item.category_id || 'other-item';
      const validation = validateVerificationAnswers(categoryId, securityAnswers);
      if (isAnswerValidationFailure(validation)) {
        return res.status(400).json({
          error: `Majibu ya usalama si sahihi. ${validation.error} / Verification answers are invalid. ${validation.error}`,
        });
      }
      const sanitizedAnswers = validation.sanitized;

      // If ID proof is provided, validate its signature and upload to S3 storage
      let idProofUrl: string | null = null;
      if (idProofBase64 && item.is_sensitive_document !== false) {
        if (!isValidImageSignature(idProofBase64)) {
          return res.status(400).json({ error: 'Aina ya picha ya kitambulisho haikubaliki. Pakia picha ya JPEG, PNG, WEBP, au HEIC.' });
        }
        idProofUrl = await uploadBase64Image(idProofBase64, 'id-proofs');
      }

      // Check if there is already an active (non-disputed, non-rejected) claim on this item_id to trigger an auto-dispute.
      // Runs for every item type — not just sensitive documents. A second
      // claimant on a laptop or phone is exactly as much a collision risk as
      // a second claimant on a national ID; the item shouldn't be handed to
      // "whoever clicked claim first" in either case.
      // Only ACTIVE claims count here. A claim whose status is in
      // INACTIVE_CLAIM_STATUSES is a CLOSED attempt (most importantly:
      // 'payment_window_expired' = simple abandonment, NOT a competing
      // claimant and NOT a dispute). Historical records stay in the DB
      // for audit; they must simply stop acting as live reservations.
      {
        // P12-F2: compare NORMALIZED phones on both sides — claims are stored in
        // E.164 (`normalizedOwnerPhone`), so comparing the raw client string let a
        // returning claimant miss their own claim, creating a duplicate plus a
        // self-collision dispute that froze the item with 423. Full rationale and
        // the live reproduction: src/__tests__/claimDuplicatePhoneNormalization.test.ts
        const normalizeOwnerPhone = (p: unknown) => toE164Kenyan(String(p || '').replace(/\s+/g, ''));
        const targetOwnerPhone = normalizedOwnerPhone;
        const isActiveClaim = (c: { status: string }) => !INACTIVE_CLAIM_STATUSES.has(c.status);
        const sameOwnerClaim = (await db.getClaims()).find(c =>
          c.item_id === itemId &&
          isActiveClaim(c) &&
          c.owner_phone &&
          normalizeOwnerPhone(c.owner_phone) === targetOwnerPhone
        );

        if (sameOwnerClaim) {
          return res.json({
            claim: toOwnerSafeClaimView(sameOwnerClaim),
            message: 'Unarejelea claim yako ya awali.',
          });
        }

        const existingClaims = (await db.getClaims()).filter(c =>
          c.item_id === itemId &&
          isActiveClaim(c) &&
          c.owner_phone &&
          normalizeOwnerPhone(c.owner_phone) !== targetOwnerPhone
        );

        if (existingClaims.length > 0) {
          const existingClaim = existingClaims[0];
          const newClaimCode = await generateUniqueClaimId();

          // Save duplicate claim as disputed
          const newClaim = await db.createClaim({
            id: newClaimCode,
            item_id: itemId,
            owner_phone: normalizedOwnerPhone,
            owner_email: ownerEmail || null,
            security_answers: sanitizedAnswers,
            verification_tier: verificationTier || 1,
            status: 'disputed',
            owner_id_proof_url: idProofUrl,
            payment_reference: null,
            owner_identifying_details: ownerIdentifyingDetailValue || null,
          });

          // Generate a dispute. createDispute() only marks both claims
          // 'disputed' — it deliberately does not touch item.status, since
          // a dispute is about ownership, not physical custody (see the
          // comment in database.ts).
          const disputeCode = 'DSP-' + Math.floor(1000 + Math.random() * 9000).toString();
          try {
            await db.createDispute({
              id: disputeCode,
              item_id: itemId,
              claimant_1_claim_id: existingClaim.id,
              claimant_2_claim_id: newClaim.id,
              claimant_1_id_proof_url: existingClaim.owner_id_proof_url || 'no-proof-yet',
              claimant_2_id_proof_url: newClaim.owner_id_proof_url || 'no-proof-yet',
              resolved_by: null,
              resolved_claim_id: null,
              resolved_at: null,
              admin_notes: null,
            });
          } catch (disputeErr: any) {
            // uq_disputes_one_unresolved_per_item — an unresolved dispute
            // was already created for this item in the gap between our
            // read above and this insert (e.g. a third near-simultaneous
            // claimant). That's fine: the item is already correctly
            // frozen by the dispute that won the race, so this claim
            // still needs to be surfaced to admin the same way.
            const isUniqueViolation = disputeErr?.code === '23505' || String(disputeErr?.cause?.code) === '23505' || /uq_disputes_one_unresolved_per_item/.test(String(disputeErr?.message || disputeErr?.cause?.message || ''));
            if (!isUniqueViolation) throw disputeErr;
          }

          return res.status(409).json({
            error: 'Bidhaa hii tayari inadaiwa na mtu mwingine. Mzozo (Dispute) umefunguliwa na utachunguzwa na wasimamizi wetu.',
            claim: toOwnerSafeClaimView(newClaim),
            isDisputed: true
          });
        }
      }

      // Tier 1 Validation: Check security answers (e.g. last 4 digits of the document matches OCR)
      // Skip for non-sensitive items
      let tierPassed = true;
      if (item.is_sensitive_document !== false && item.ocr_extracted_number) {
        const lastDigitsInput = sanitizedAnswers.lastDigits ? sanitizedAnswers.lastDigits.toUpperCase() : '';
        if (lastDigitsInput) {
          // 1. Raw comparison (removing non-alphanumeric, case-insensitive)
          const rawOcr = item.ocr_extracted_number.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
          const cleanInput = lastDigitsInput.replace(/[^A-Z0-9]/g, '');
          const lastRawOcr = rawOcr.substring(Math.max(0, rawOcr.length - cleanInput.length));

          // 2. Numeric-only comparison (for pure-numeric document numbers)
          const cleanOcrDigits = item.ocr_extracted_number.replace(/\D/g, '');
          const cleanInputDigits = lastDigitsInput.replace(/\D/g, '');
          const lastDigitsOcr = cleanOcrDigits.substring(Math.max(0, cleanOcrDigits.length - cleanInputDigits.length));

          const rawMatch = cleanInput && lastRawOcr === cleanInput;
          const digitsMatch = cleanInputDigits && lastDigitsOcr === cleanInputDigits;

          if (!rawMatch && !digitsMatch) {
            tierPassed = false;
          }
        }
      }

      if (!tierPassed) {
        return res.status(400).json({
          error: 'Majibu ya usalama hayajalingana na maelezo ya hati hii. Tafadhali thibitisha na ujaribu tena.',
        });
      }

      // Tier 3 Validation: Require and store ID proof upload
      // Skip for non-sensitive items
      const isTier3 = item.is_sensitive_document !== false && (verificationTier === 3 || !!idProofBase64);
      if (isTier3) {
        if (!idProofUrl) {
          return res.status(400).json({ error: 'Uthibitisho wa Kitambulisho (ID Proof upload) unahitajika kwa Tier 3.' });
        }
      }

      const claimCode = await generateUniqueClaimId();

      // Create Claim in pending_verification until Tier 2 OTP is satisfied.
      // The application-level duplicate check above narrows the race window
      // but can't close it entirely (two requests can both pass that check
      // before either commits) — uq_claims_one_active_per_item is the real
      // backstop. If we lose that race here, someone else's claim on this
      // item committed in the gap between our check and our insert; that's
      // not a server error, it's a legitimate "someone else got there
      // first" outcome, so we surface it as one.
      let claim;
      try {
        claim = await db.createClaim({
          id: claimCode,
          item_id: itemId,
          owner_phone: normalizedOwnerPhone,
          owner_email: ownerEmail || null,
          security_answers: sanitizedAnswers,
          verification_tier: isTier3 ? 3 : 2,
          status: 'pending_verification',
          owner_id_proof_url: idProofUrl,
          payment_reference: null,
          owner_identifying_details: ownerIdentifyingDetailValue || null,
        });
      } catch (raceErr: any) {
        const isUniqueViolation = raceErr?.code === '23505' || String(raceErr?.cause?.code) === '23505' || /uq_claims_one_active_per_item/.test(String(raceErr?.message || raceErr?.cause?.message || ''));
        if (isUniqueViolation) {
          return res.status(409).json({
            error: 'Mtu mwingine ameshadai bidhaa hii sekunde chache zilizopita. Tafadhali onyesha usaidizi ikiwa unaamini hii ni makosa. / Someone else just claimed this item moments ago. Please contact support if you believe this is a mistake.',
          });
        }
        throw raceErr;
      }

      // Log terms acceptance in audit log server-side
      await db.logAudit(
        ownerPhone,
        'TERMS_ACCEPTED',
        `Owner claim terms and privacy accepted for claim ${claimCode} on item ${itemId} (Phone: ${ownerPhone})`
      );

      let warning: string | null = null;
      if (strikeCount === 1 || strikeCount === 2) {
        warning = "Kumbuka: Uliwahi kuthibitisha kuwa bidhaa ni yako physically lakini hukulipia. Uthibitishaji unaorudiwa bila malipo unaweza kuzuia akaunti yako. / Note: you previously confirmed an item was yours in person but did not complete payment. Repeated occurrences may restrict your access to Return4me.";
      }

      res.json({
        success: true,
        claim: toOwnerSafeClaimView(claim),
        warning,
        message: isTier3
          ? 'Thibitisho la Tier 1 na Tier 3 limepita! Tafadhali thibitisha OTP yako ili uendelee kwenye malipo.'
          : (item.is_sensitive_document !== false 
            ? 'Thibitisho la utambulisho (Tier 1) limepita! Tafadhali thibitisha OTP ili uendelee kwenye malipo.'
            : 'Ombi lako limepokelewa! Tafadhali thibitisha OTP yako ili uendelee kwenye malipo.'),
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 6b. Tier 2: CLAIM SPECIFIC OTP DISPATCH & VERIFICATION
  app.post('/api/claims/:id/request-otp', otpGlobalLimiter, otpIpLimiter, otpClaimLimiter, async (req, res) => {
    const claimId = req.params.id;
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Nambari ya simu inahitajika. / Phone number is required.' });
    }

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }

      // P0: claim ID alone (a guessable, ~900k-combination numeric space)
      // used to be sufficient to trigger an OTP SMS to this claim's real
      // owner_phone — no proof the caller was that owner at all. Now
      // requires the same phone-match standard already used by /lookup,
      // /pay, and /payment-auth elsewhere in this file.
      const normalizedInput = toE164Kenyan(String(phone).replace(/\s+/g, ''));
      const normalizedOwner = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
      if (normalizedInput !== normalizedOwner) {
        return res.status(403).json({
          error: 'Nambari ya simu uliyoweka hailingani na iliyotumiwa kutengeneza claim hii. / The phone number provided does not match the one used to create this claim.'
        });
      }

      // SC-1 (companion guard): an OTP is only meaningful for a claim still
      // awaiting its first verification. Without this, the route would happily
      // send a real SMS to the owner of an already-paid/handed-over/refunded
      // claim and set up exactly the backward transition the verify-otp guard
      // above now refuses. Returns 409 (a state conflict, not a bad request).
      if (claim.status !== 'pending_verification') {
        return res.status(409).json({
          error: 'Claim hii imeshapitia uthibitisho. Hakuna OTP mpya inayohitajika. / This claim has already passed verification. No new OTP is required.',
        });
      }

      // Generate secure 4-digit code using Node crypto
      const code = crypto.randomInt(1000, 10000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // valid for 5 mins
      await db.setClaimOtp(claimId, hashCode(code), expiresAt);

      // BUGFIX: this used to only console.log the raw OTP code and the
      // owner's full phone number — unconditionally, even in production —
      // and never actually sent an SMS at all. A real owner in production
      // would never have received this code on their phone. Now routed
      // through the same gateway phone-verification OTP uses; the raw
      // code is only ever printed to the console in dev/sandbox
      // simulation mode (no real Africa's Talking credentials configured),
      // clearly labeled as such — see sendCodeViaSms in services/auth.ts.
      const smsResult = await sendCodeViaSms(
        claim.owner_phone,
        code,
        'CLAIM OTP',
        `Msimbo mpya wa thibitisho la claim umetumwa kwa nambari ya simu ya ${claim.owner_phone}.`
      );
      if (!smsResult.success) {
        return res.status(500).json({ error: smsResult.message });
      }

      res.json({
        success: true,
        message: smsResult.message,
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/claims/:id/verify-otp', otpVerifyLimiter, async (req, res) => {
    const claimId = req.params.id;
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Msimbo wa OTP unahitajika.' });
    }

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }

      const record = await db.getClaimOtp(claimId);
      if (!record) {
        return res.status(400).json({ error: 'Hakuna OTP iliyoombwa kwa claim hii au muda wake umeisha.' });
      }

      if (record.expires_at.getTime() < Date.now()) {
        await db.deleteClaimOtp(claimId);
        return res.status(400).json({ error: 'Muda wa OTP umeisha. Tafadhali omba msimbo mpya.' });
      }

      const isMockBypass = (
        process.env.NODE_ENV !== 'production' &&
        process.env.ALLOW_MOCK_OTP_BYPASS === 'true' &&
        (code === '1234' || code === '4114')
      );
      const codeMatches = timingSafeEqualHex(hashCode(code), record.code_hash);
      if (!codeMatches && !isMockBypass) {
        const attempts = await db.incrementClaimOtpAttempts(claimId);
        if (attempts >= 5) {
          await db.deleteClaimOtp(claimId);
          return res.status(400).json({ error: 'Umekosea msimbo wa OTP mara 5. OTP hii imefutwa kwa usalama wako. Tafadhali omba msimbo mpya. / You have entered the wrong OTP 5 times. For your security, this OTP has been invalidated. Please request a new code.' });
        }
        return res.status(400).json({ error: `Msimbo wa OTP si sahihi. Una fursa ${5 - attempts} zilizobaki. / Incorrect OTP code. You have ${5 - attempts} attempts remaining.` });
      }

      // SC-1 — LIFECYCLE GUARD. This route used to write
      // 'awaiting_agent_confirmation' from ANY source state, which meant a
      // claim that had already progressed (escrow_held, pending_settlement,
      // releasing, released, refunding, refunded, rejected) could be pushed
      // BACKWARD by a fresh OTP verification. Only 'pending_verification' is a
      // legal source, and the check runs BEFORE the OTP is consumed so a
      // refused attempt does not destroy the caller's still-valid code.
      if (claim.status !== 'pending_verification') {
        return res.status(409).json({
          error: 'Claim hii haiwezi kuthibitishwa kwa OTP katika hali yake ya sasa. / This claim cannot be OTP-verified from its current state.',
        });
      }

      // The transition is expressed through the central contract so the
      // allowed-edge table, the expected-state CAS and the audit write are all
      // enforced in one place.
      const otpTransition = await db.transitionClaimStatus({
        claimId,
        expected: ['pending_verification'],
        to: 'awaiting_agent_confirmation',
        actor: claim.owner_phone || 'CLAIMANT',
        action: 'CLAIM_OTP_VERIFIED',
        details: `Claim ${claimId} OTP verified; awaiting in-person agent confirmation.`,
      });
      if (!otpTransition.ok) {
        // NOT_FOUND cannot happen (the claim was read above) but is mapped for
        // completeness; STATE_CONFLICT means another request moved the claim
        // first — a 409, never a 500. The OTP is still NOT consumed here.
        return res.status(otpTransition.code === 'NOT_FOUND' ? 404 : 409).json({
          error: 'Claim hii imeshabadilika hivi punde. Tafadhali pakia upya. / This claim changed moments ago. Please reload.',
        });
      }

      // Single-use: consume the challenge only AFTER the transition committed.
      await db.deleteClaimOtp(claimId);

      // F11 (Phase 7C.3) — IDENTITY CONTINUITY. Everything above is the
      // authoritative, already-committed verification and must NOT depend on
      // anything below. The claim journey has always been valid for anonymous
      // visitors (the claim OTP is sent to the claim's own registered phone),
      // so the customer-account link is strictly ADDITIVE and is attempted
      // only once the OTP is spent:
      //
      //   * no / invalid / expired / revoked session  -> anonymous, linked:false
      //   * customer's normalised phone != claim phone -> no link, linked:false
      //   * matching phone -> the EXISTING link primitive is used, linked:true
      //
      // It runs AFTER the transition + OTP consumption by design, so it can
      // never weaken the claim's own proof standard, and it is wrapped so that
      // a linkage failure cannot turn a successful verification into a 500.
      let journeyLinked = false;
      try {
        const journeyCustomer = await resolveOptionalCustomer(req);
        if (journeyCustomer) {
          const journeyLink = await linkVerifiedClaimToCustomer(journeyCustomer, claim);
          journeyLinked = journeyLink.linked;
        }
      } catch (e: any) {
        console.error('[CUSTOMER_CLAIM_JOURNEY_LINK_ERROR]', e);
        journeyLinked = false;
      }

      res.json({
        success: true,
        message: 'Msimbo umethibitishwa kikamilifu! Tafadhali nenda kwa wakala physically ili athibitishe kuwa bidhaa hii ni yako kabla ya kulipa. / Verification code approved! Please visit the agent physically to verify the item belongs to you before initiating payment.',
        linked: journeyLinked,
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 6c. Short-lived, single-purpose payment authorization. Owners have no
  // persistent login in this app, so this is the closest equivalent to a
  // "claim session": prove you know the claim's registered phone number
  // (the same bar /lookup already uses) and receive a random, opaque,
  // 20-minute token that /pay will require. Unlike a bare phone-number
  // check, this token expires, is minted fresh per request (nothing
  // long-lived to leak), and is never persisted in plaintext — only its
  // hash is stored, exactly like OTP codes and pickup codes elsewhere in
  // this file. Rate-limited the same as the other claim-ID-guessable
  // routes since it still only takes a claim ID + a guessable-in-principle
  // phone number to attempt.
  app.post('/api/claims/:id/payment-auth', claimGuessLimiter, async (req, res) => {
    const claimId = req.params.id;
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Nambari ya simu inahitajika. / Phone number is required.' });
    }

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }

      if (claim.status !== 'pending_payment') {
        return res.status(400).json({
          error: 'Lazima kwanza uthibitishwe na wakala kabla ya kuomba idhini ya malipo. / You must be confirmed by the agent in person before requesting payment authorization.'
        });
      }

      const normalizedInput = toE164Kenyan(String(phone).replace(/\s+/g, ''));
      const normalizedOwner = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
      if (normalizedInput !== normalizedOwner) {
        return res.status(403).json({
          error: 'Nambari ya simu uliyoweka hailingani na iliyotumiwa kutengeneza claim hii. / The phone number provided does not match the one used to create this claim.'
        });
      }

      const paymentAuthToken = crypto.randomBytes(32).toString('hex');
      const paymentAuthExpiresAt = new Date(Date.now() + 20 * 60 * 1000);
      await db.setClaimPaymentAuthToken(claimId, hashCode(paymentAuthToken), paymentAuthExpiresAt);

      res.json({ success: true, paymentAuthToken, expiresAt: paymentAuthExpiresAt.toISOString() });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // --- PAYMENT SESSIONS (server-controlled, single-claim payment attempts) ---
  // This is the PRIMARY payment path, replacing the old rule that the payer's
  // M-Pesa phone must equal the claim's owner_phone. Opening a session for a
  // claim still requires proving ownership of the claim (phone == owner_phone,
  // the same bar /payment-auth always used) — that proof has NOT been deleted,
  // just moved: the session becomes the bearer of authorization, and the
  // session's payer_phone (below) may legitimately differ from owner_phone. The
  // server computes the amount; the browser supplies none of it.

  // Create a new payment session for a claim.
  app.post('/api/claims/:id/payment-session', claimGuessLimiter, async (req, res) => {
    const claimId = req.params.id;
    const { phone, payerPhone } = req.body;

    if (await isPlatformOperationPaused(pauseSettingKey('payments'))) {
      return res.status(503).json({ error: PAUSED_MESSAGES.payments });
    }

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }
      if (claim.status !== 'pending_payment') {
        return res.status(400).json({ error: 'Lazima kwanza uthibitishwe na wakala kabla ya kulipa. / You must be confirmed by the agent in person before you can pay.' });
      }
      const freshClaim = await checkClaimExpiry(claim);
      if (!freshClaim || freshClaim.status !== 'pending_payment') {
        return res.status(410).json({ error: 'Muda wa malipo umeisha. / The payment window has expired.' });
      }

      if (!phone) {
        return res.status(400).json({ error: 'Nambari ya simu inahitajika. / Phone number is required.' });
      }
      // Ownership proof (unchanged security bar): you must know the claim's
      // registered owner phone to open a session for it. This is NOT the rule
      // for the payer M-Pesa number — see payerPhone below.
      const normalizedInput = toE164Kenyan(String(phone).replace(/\s+/g, ''));
      const normalizedOwner = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
      if (normalizedInput !== normalizedOwner) {
        return res.status(403).json({
          error: 'Nambari ya simu uliyoweka hailingani na iliyotumiwa kutengeneza claim hii. / The phone number provided does not match the one used to create this claim.'
        });
      }

      // Payer M-Pesa number — may differ from owner_phone. Must be a valid
      // Kenyan number when supplied; defaults to owner_phone when omitted.
      let normalizedPayer = normalizedOwner;
      if (payerPhone !== undefined && payerPhone !== null && String(payerPhone).trim() !== '') {
        const candidate = toE164Kenyan(String(payerPhone).replace(/\s+/g, ''));
        if (!/^\+254\d{9}$/.test(candidate)) {
          return res.status(400).json({ error: 'Nambari ya simu ya M-Pesa sio sahihi. / Enter a valid Kenyan M-Pesa number.' });
        }
        normalizedPayer = candidate;
      }

      const item = await db.getItem(claim.item_id);
      if (!item) {
        return res.status(404).json({ error: 'Bidhaa inayodaiwa haikupatikana.' });
      }
      const claimability = await canCreateClaim(item);
      if (!claimability.allowed) {
        return res.status(423).json({ error: claimabilityErrorMessage(claimability.reason) });
      }
      const category = await db.getCategory(item.category_id);
      if (!category) {
        return res.status(404).json({ error: 'Ada ya kategoria haikupatikana.' });
      }

      // Authoritative server-side amount — never taken from the client.
      const resolvedFee = resolveAuthoritativePaymentFee(item, category);

      // Reuse an existing active (non-terminal) session for this claim so a
      // refresh or tab-reopen never spawns duplicate concurrent sessions.
      const existing = (await db.listPaymentSessionsForClaim(claimId))
        .find((s: any) => !['confirmed', 'failed', 'cancelled', 'expired'].includes(s.status));
      if (existing) {
        return res.json({ success: true, paymentSession: toSafePaymentSession(existing), reused: true });
      }

      // Session window == the claim's payment window (agent_confirmed_at + 15 min).
      const baseMs = claim.agent_confirmed_at ? new Date(claim.agent_confirmed_at).getTime() : Date.now();
      const expiresAt = new Date(baseMs + 15 * 60 * 1000);
      const sessionId = 'PS-' + crypto.randomBytes(8).toString('hex').toUpperCase();
      const created = await db.createPaymentSession({
        id: sessionId,
        claimId,
        amount: resolvedFee,
        currency: 'KES',
        payerPhone: normalizedPayer,
        method: 'mpesa_stk',
        expiresAt,
      });
      if (!created) {
        return res.status(500).json({ error: 'Kushindwa kuunda session ya malipo. / Failed to create the payment session.' });
      }

      const session = await db.getPaymentSessionById(sessionId);
      await db.logAudit('CLAIMANT', 'PAYMENT_SESSION_CREATED', `Payment session ${sessionId} created for claim ${claimId} (KES ${resolvedFee}).`);
      res.json({ success: true, paymentSession: toSafePaymentSession(session), reused: false });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // Initiate the M-Pesa STK push for a payment session. Requires the short-lived
  // ownership token minted by /payment-auth (which itself requires knowing the
  // claim's owner phone), so triggering a real payment still proves ownership.
  app.post('/api/claims/:id/payment-session/:sessionId/initiate', claimGuessLimiter, async (req, res) => {
    const claimId = req.params.id;
    const sessionId = req.params.sessionId;
    const { paymentAuthToken } = req.body;

    if (await isPlatformOperationPaused(pauseSettingKey('payments'))) {
      return res.status(503).json({ error: PAUSED_MESSAGES.payments });
    }

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }
      if (claim.status !== 'pending_payment') {
        return res.status(400).json({ error: 'Lazima kwanza uthibitishwe na wakala kabla ya kulipa. / You must be confirmed by the agent in person before you can pay.' });
      }
      const freshClaim = await checkClaimExpiry(claim);
      if (!freshClaim || freshClaim.status !== 'pending_payment') {
        return res.status(410).json({ error: 'Muda wa malipo umeisha. / The payment window has expired.' });
      }

      // Authorization to spend: present a valid, unexpired ownership token.
      if (!paymentAuthToken) {
        return res.status(403).json({ error: 'Idhini ya malipo imekosekana. Tafadhali omba idhini mpya kabla ya kulipa. / Payment authorization is missing. Please request authorization before paying.' });
      }
      const authRecord = await db.getClaimPaymentAuthToken(claimId);
      if (!authRecord || authRecord.expires_at.getTime() < Date.now() || !timingSafeEqualHex(hashCode(String(paymentAuthToken)), authRecord.token_hash)) {
        return res.status(403).json({ error: 'Idhini ya malipo si sahihi au imeisha muda. Tafadhali omba idhini mpya. / Payment authorization is invalid or has expired. Please request a new authorization.' });
      }

      const session = await db.getPaymentSessionById(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session ya malipo haikupatikana. / Payment session not found.' });
      }
      // A payment session is bound to exactly ONE claim. Refuse any attempt to
      // use a session opened for a different claim.
      if (session.claim_id !== claimId) {
        return res.status(403).json({ error: 'Session ya malipo haihusiani na claim hii. / This payment session does not belong to this claim.' });
      }
      if (['confirmed', 'failed', 'cancelled', 'expired'].includes(session.status)) {
        return res.status(409).json({ error: 'Session ya malipo haitumiki tena. / This payment session is no longer usable.' });
      }
      if (new Date(session.expires_at).getTime() < Date.now()) {
        await db.expirePaymentSession(sessionId);
        return res.status(410).json({ error: 'Muda wa session ya malipo umeisha. / The payment session has expired.' });
      }

      const item = await db.getItem(claim.item_id);
      if (!item) {
        return res.status(404).json({ error: 'Bidhaa inayodaiwa haikupatikana.' });
      }
      const claimability = await canCreateClaim(item);
      if (!claimability.allowed) {
        return res.status(423).json({ error: claimabilityErrorMessage(claimability.reason) });
      }

      // Concurrency-safe: only the caller that wins the created -> payment_initiated
      // CAS may issue the provider STK push. A repeated/double request loses and
      // is told so (it does NOT trigger a second push).
      const reserved = await db.reservePaymentSession(sessionId);
      if (!reserved) {
        const current = await db.getPaymentSessionById(sessionId);
        const stillActive = current && ['created', 'payment_initiated', 'pending'].includes(current.status)
          && new Date(current.expires_at).getTime() >= Date.now();
        if (stillActive) {
          return res.json({ success: true, paymentSession: toSafePaymentSession(current), alreadyInitiated: true });
        }
        return res.status(409).json({ error: 'Session ya malipo haikuweza kuanzishwa. / The payment session could not be initiated.' });
      }

      // Authoritative amount and payer phone come from the session, never the body.
      const paymentResult = await PaymentService.triggerMpesaStkPush(
        session.payer_phone || claim.owner_phone,
        session.amount,
        session.claim_id
      );
      if (!paymentResult.success) {
        await db.markPaymentSessionFailed(sessionId, paymentResult.message || 'STK initiation failed');
        return res.status(400).json({ error: paymentResult.message || 'Malipo hayakufaulu, jaribu tena.' });
      }

      await db.finalizePaymentSessionInitiated(sessionId, paymentResult.checkoutRequestId, paymentResult.mpesaReceiptCode);
      await db.logAudit('CLAIMANT', 'PAYMENT_SESSION_INITIATED', `M-Pesa STK push requested for session ${sessionId} (claim ${claimId}, KES ${session.amount}).`);

      const updated = await db.getPaymentSessionById(sessionId);
      res.json({ success: true, paymentSession: toSafePaymentSession(updated), alreadyInitiated: false });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // Authoritative payment-session status for the frontend polling loop. The
  // frontend can never mark a payment confirmed here; it can only observe what
  // the backend/provider have recorded. Also enforces server-side expiry on both
  // the claim and the session.
  // PHASE 12: this route is POLLED by OwnerView (`payment_polling: 3`, i.e. the
  // same 3-second cadence as GET /api/claims/:id/status) and was registered with
  // no limiter at all, unlike every other route in the claim family. It now
  // carries its OWN 600/15-minutes-per-IP budget (a distinct limiter instance, so
  // the two polled routes cannot drain each other's allowance).
  app.get('/api/claims/:id/payment-session/:sessionId/status', paymentSessionStatusLimiter, async (req, res) => {
    const claimId = req.params.id;
    const sessionId = req.params.sessionId;
    try {
      let claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }
      claim = await checkClaimExpiry(claim);

      const session = await db.getPaymentSessionById(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session ya malipo haikupatikana. / Payment session not found.' });
      }
      // Cross-claim isolation: this session is simply not visible under another
      // claim's URL.
      if (session.claim_id !== claimId) {
        return res.status(403).json({ error: 'Session ya malipo haihusiani na claim hii. / This payment session does not belong to this claim.' });
      }

      // Authoritative server-side session expiry: a session past its window that
      // is not yet terminal is expired here (not by a browser countdown).
      if (!['confirmed', 'failed', 'cancelled', 'expired'].includes(session.status)
        && new Date(session.expires_at).getTime() < Date.now()) {
        await db.expirePaymentSession(sessionId);
        session.status = 'expired';
      }

      res.json({
        success: true,
        claim: { id: claim.id, status: claim.status },
        paymentSession: toSafePaymentSession(session),
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 7. INTASEND M-PESA STK PUSH & WEBHOOKS
  app.post('/api/claims/:id/pay', claimGuessLimiter, async (req, res) => {
    const claimId = req.params.id;
    const { phone, paymentAuthToken } = req.body;

    if (await isPlatformOperationPaused(pauseSettingKey('payments'))) {
      return res.status(503).json({ error: PAUSED_MESSAGES.payments });
    }

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }

      if (claim.status !== 'pending_payment') {
        return res.status(400).json({
          error: "Lazima kwanza uthibitishwe na wakala kabla ya kulipa. / You must be confirmed by the agent in person before you can pay."
        });
      }

      // SECURITY: this route is deliberately unauthenticated (owners aren't
      // logged in). It used to accept a bare claim ID as sufficient —
      // `phone` was only checked if the caller bothered to send it, so
      // omitting it entirely let anyone who found/guessed a claim ID
      // trigger an M-Pesa STK push against the claim's real owner_phone
      // with zero proof of ownership. Now BOTH are required and checked:
      // `phone` must resolve (E.164-normalized) to the claim's own
      // owner_phone, exactly as /lookup already requires, AND the caller
      // must present a valid, unexpired paymentAuthToken minted by
      // POST /api/claims/:id/payment-auth (which itself required that same
      // phone match to issue). Knowing the claim ID, or the phone number,
      // is no longer individually or jointly sufficient without also
      // holding a token that expires in 20 minutes and was minted for this
      // specific payment attempt.
      if (!phone) {
        return res.status(400).json({
          error: 'Nambari ya simu inahitajika. / Phone number is required.'
        });
      }
      const normalizedInput = toE164Kenyan(String(phone).replace(/\s+/g, ''));
      const normalizedOwner = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
      if (normalizedInput !== normalizedOwner) {
        return res.status(403).json({
          error: 'Nambari ya simu uliyoweka hailingani na iliyotumiwa kutengeneza claim hii. / The phone number provided does not match the one used to create this claim.'
        });
      }

      if (!paymentAuthToken) {
        return res.status(403).json({
          error: 'Idhini ya malipo imekosekana. Tafadhali omba idhini mpya kabla ya kulipa. / Payment authorization is missing. Please request authorization before paying.'
        });
      }
      const authRecord = await db.getClaimPaymentAuthToken(claimId);
      if (!authRecord || authRecord.expires_at.getTime() < Date.now() || !timingSafeEqualHex(hashCode(String(paymentAuthToken)), authRecord.token_hash)) {
        return res.status(403).json({
          error: 'Idhini ya malipo si sahihi au imeisha muda. Tafadhali omba idhini mpya. / Payment authorization is invalid or has expired. Please request a new authorization.'
        });
      }

      const item = await db.getItem(claim.item_id);
      if (!item) {
        return res.status(404).json({ error: 'Bidhaa inayodaiwa haikupatikana.' });
      }

      // Central claimability rule, re-checked here as defense in depth: an
      // item's state can change between claim creation and payment (e.g.
      // flagged stolen/legal-hold, or a dispute opened by a competing
      // claimant) — never let money move on an item that's no longer
      // currently claimable, even if this specific claim slipped past the
      // earlier check at submission time.
      const claimability = await canCreateClaim(item);
      if (!claimability.allowed) {
        return res.status(423).json({ error: claimabilityErrorMessage(claimability.reason) });
      }

      const category = await db.getCategory(item.category_id);
      if (!category) {
        return res.status(404).json({ error: 'Ada ya kategoria haikupatikana.' });
      }

      // Prefer item.locked_total_fee if present and valid (> 0), else fallback to category.total_fee
      let resolvedFee = category.total_fee;
      if (item.locked_total_fee !== undefined && item.locked_total_fee !== null) {
        const lockedVal = typeof item.locked_total_fee === 'string' ? parseFloat(item.locked_total_fee) : item.locked_total_fee;
        if (!isNaN(lockedVal) && lockedVal > 0) {
          resolvedFee = lockedVal;
        }
      }

      // Trigger IntaSend M-Pesa STK Push
      const paymentResult = await PaymentService.triggerMpesaStkPush(phone || claim.owner_phone, resolvedFee, claimId);

      if (!paymentResult.success) {
        return res.status(400).json({ error: paymentResult.message || 'Malipo hayakufaulu, jaribu tena.' });
      }

      // STK push initiated — claim remains in 'pending_payment' while we wait for
      // the IntaSend/M-Pesa webhook to confirm success and move it to 'escrow_held'.
      //
      // SC-4/SC-6 FIX: this call used to pass paymentResult.checkoutRequestId as
      // the `paymentRef` argument, which wrote the provider's CHECKOUT REQUEST
      // ID into claims.payment_reference at INITIATION — i.e. before any money
      // existed. Because resolveDispute() used `!!payment_reference` as "this
      // claimant actually paid", merely STARTING an STK push was enough to
      // create a refund obligation for money that was never received.
      //
      // The checkout request id is transient STK metadata with no claim-level
      // use (the authoritative receipt arrives on the webhook, and the
      // payment-session path already persists provider_reference on the
      // session), so it is deliberately not persisted here at all. The status
      // write is retained only to refresh updated_at; `paid_at` is untouched —
      // only attemptClaimEscrowHold()'s guarded CAS may ever set it.
      await db.updateClaimStatus(claimId, 'pending_payment');

      const updatedClaim = await db.getClaim(claimId);
      let agent = null;
      if (updatedClaim && (updatedClaim.status === 'escrow_held' || updatedClaim.status === 'released')) {
        agent = await db.getAgent(item.assigned_agent_id);
      }

      // SECURITY: same leak as /api/claims/:id/status above, and arguably
      // worse here — the phone-match check a few lines up only runs when
      // `phone` is actually provided in the body, so calling this route
      // with just a claim ID (no phone at all) is enough to reach this
      // point without proving ownership. Only the fields the frontend
      // (triggerEscrowPayment in OwnerView.tsx) actually consumes are
      // returned instead of the raw row.
      res.json({
        success: true,
        paymentResult,
        claim: updatedClaim ? {
          id: updatedClaim.id,
          status: updatedClaim.status,
          agent_confirmed_at: updatedClaim.agent_confirmed_at,
        } : null,
        agent: toOwnerSafeAgentView(agent),
        message: 'Malipo yameanzishwa kikamilifu! Tafadhali weka PIN ya M-Pesa kwenye simu yako ili kukamilisha.',
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 7a. Look up existing claim by Claim ID and Owner Phone
  //
  // Phase 7C.7 (R2): the two ownership failures — "no such claim" and "the phone
  // does not match this claim" — now return ONE status and ONE body. Previously
  // a caller who knew nothing but a candidate claim ID could learn whether that
  // claim existed at all, and, for a claim they knew existed, confirm whether a
  // guessed phone number was the registered owner phone. The missing-field guard
  // stays a 400 and still runs BEFORE any database read, so it cannot be used as
  // a probe either. The wording mirrors the ownership-gated pickup-details route
  // (routes/publicItems.ts MESSAGES.claimUnavailable) so both surfaces speak with
  // the same vocabulary. NOTE: ownership proof is unchanged — a matching
  // registered phone is still required, and the claim's real owner phone remains
  // the only credential this route accepts.
  app.post('/api/claims/lookup', claimGuessLimiter, async (req, res) => {
    const { claimId, phone } = req.body;
    if (!claimId || !phone) {
      return res.status(400).json({ error: 'Msimbo wa claim (Claim ID) na nambari ya simu zinahitajika.' });
    }

    try {
      const cleanClaimId = String(claimId).trim().toUpperCase();
      const cleanPhone = String(phone).replace(/\s+/g, '');
      const e164Phone = toE164Kenyan(cleanPhone);

      // ONE response object for both ownership failures below — a single shared
      // constant so the two branches can never drift apart again.
      const claimUnavailable = {
        error: 'Claim haikupatikana au nambari ya simu hailingani. / Claim not found, or the phone number does not match.'
      };

      const claim = await db.getClaim(cleanClaimId);
      if (!claim) {
        return res.status(404).json(claimUnavailable);
      }

      const claimPhoneClean = claim.owner_phone ? claim.owner_phone.replace(/\s+/g, '') : '';
      if (claimPhoneClean !== cleanPhone && claimPhoneClean !== e164Phone && toE164Kenyan(claimPhoneClean) !== e164Phone) {
        // Same status AND same body as the unknown-claim branch above.
        return res.status(404).json(claimUnavailable);
      }

      const item = await db.getItem(claim.item_id);
      let agent = null;
      if (item && item.assigned_agent_id) {
        agent = await db.getAgent(item.assigned_agent_id);
      }

      res.json({
        success: true,
        claim: toOwnerSafeClaimView(claim),
        item: toOwnerSafeItemView(item),
        // Phase 7C.7 (R1): the hub's operational contact phone, exact address and
        // GPS coordinates are only disclosed while the claim is still entitled to
        // active pickup instructions — the SAME canonical policy the
        // ownership-gated pickup-details route applies (config/claimStatuses.ts,
        // Phase 7C.5). Without this gate, a claim that /pickup-details refuses
        // (terminal, rejected, expired, refunded, disputed, or still
        // OTP-unverified) could obtain the identical agent DTO from here instead.
        //
        // The `agent` KEY is deliberately preserved (null, never removed) and the
        // claim status + masked item are untouched, so the Track/resume surface
        // keeps working and still shows claim/item/status information.
        agent: isPickupEligibleClaimStatus(claim.status) ? toOwnerSafeAgentView(agent) : null,
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 7b. Submit user rating for an agent from the owner portal
  // SECURITY: this route is deliberately unauthenticated (owners aren't
  // logged in), but that used to mean a bare, guessable claim ID (see the
  // claim-ID-guessing comments elsewhere in this file — 6-digit numeric
  // space, under 900,000 values) was sufficient to call db.rateAgent() an
  // unlimited number of times for any claim, with no check that the claim
  // had even reached handover. rateAgent() is a running average with no
  // built-in dedup, so this let anyone who found/guessed a claim ID
  // arbitrarily inflate or tank an agent's reputation score by spamming
  // this endpoint. Now gated three ways: rate-limited like the other
  // claim-ID-guessable routes, requires the claim to have actually reached
  // a post-handover status, and atomically allows at most one rating per
  // claim ever (db.markClaimRatedIfNotAlready).
  app.post('/api/claims/:id/rate', claimGuessLimiter, async (req, res) => {
    const claimId = req.params.id;
    const { userRating } = req.body;

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }

      const handoverHasOccurred = ['pending_settlement', 'releasing', 'released'].includes(claim.status);
      if (!handoverHasOccurred) {
        return res.status(400).json({ error: 'Huwezi kutoa ukadiriaji kabla ya bidhaa kukabidhiwa. / You can only rate after the item has actually been handed over.' });
      }

      const item = await db.getItem(claim.item_id);
      if (!item) {
        return res.status(404).json({ error: 'Bidhaa inayodaiwa haikupatikana.' });
      }

      if (!item.assigned_agent_id) {
        return res.status(400).json({ error: 'Hakuna hub/wakala aliyepangiwa bidhaa hii.' });
      }

      const wonRatingSlot = await db.markClaimRatedIfNotAlready(claimId);
      if (!wonRatingSlot) {
        return res.status(409).json({ error: 'Dai hili tayari limekadiriwa. / This claim has already been rated.' });
      }

      if (userRating) {
        const ratingVal = parseFloat(String(userRating));
        if (!isNaN(ratingVal) && ratingVal >= 1 && ratingVal <= 5) {
          await db.rateAgent(item.assigned_agent_id, ratingVal);
        }
      }

      res.json({ success: true, message: 'Ukadiriaji umewasilishwa kikamilifu! Ahsante.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // GET lightweight claim status for frontend polling
  // SECURITY (P0, Phase 7B): this endpoint is deliberately unauthenticated —
  // it's polled every 3 seconds by the owner's browser during claim submission,
  // agent confirmation and payment, before any login exists for owners. Two
  // separate exposures were fixed here:
  //
  //  1. It used to return the ENTIRE raw claim row, including
  //     `security_answers` (the exact last-4-digits/color/lost-details answers
  //     used to verify someone is the real owner), `owner_phone`, `owner_email`,
  //     `owner_identifying_details`, and `owner_id_proof_url`. Anyone who
  //     obtained a claim ID — from a URL, an SMS, a shared screenshot, or
  //     simple enumeration of the ~900k-combination claim-ID space — could read
  //     the correct security answers for that claim and use them to impersonate
  //     the real owner. That was already narrowed to the hand-built whitelist
  //     below ({ id, status, agent_confirmed_at }), which is the ONLY thing the
  //     OwnerView polling loops read off `data.claim`.
  //
  //  2. PRIVACY FIX: it then STILL returned `agent: toOwnerSafeAgentView(agent)`
  //     — the assigned agent's full contact phone number, exact pickup address
  //     and GPS latitude/longitude — to any anonymous caller who simply knew or
  //     guessed a claim ID. That is operational contact/location data for a
  //     real business and a real person, and a guessable ID must never be
  //     sufficient to obtain it. `agent` is now GONE from this response
  //     entirely; the owner gets it from the separately ownership-gated
  //     POST /api/claims/:id/pickup-details (routes/publicItems.ts), which
  //     requires the claim's registered owner phone. The response object below
  //     is the complete public contract — it is a deliberately minimal public
  //     DTO, not a filtered row.
  //
  // Also rate-limited, but DELIBERATELY NOT with claimGuessLimiter.
  //
  // F1 REGRESSION (fixed in Phase 7B.2): attaching claimGuessLimiter here —
  // a 20-requests/15-minutes bucket SHARED with /lookup, /pay,
  // /payment-auth, /payment-session and /:id/rate — starved the legitimate
  // owner's own flow. OwnerView polls this route every 3 seconds (20 requests
  // per minute, up to 300 per window), so the shared budget was gone ~60
  // seconds into waiting for the agent; the poller then received 429s it
  // ignored, and the owner's subsequent /payment-auth and /pay calls were
  // rejected too. This route is the only POLLED claim route, so it now has a
  // dedicated policy (600/15 min per IP — see config/claimStatusPollLimiter.ts
  // for the arithmetic and the keying rationale) that cannot consume, or be
  // consumed by, the discrete-route enumeration bucket.
  app.get('/api/claims/:id/status', claimStatusPollLimiter, async (req, res) => {
    const claimId = req.params.id;
    try {
      let claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }
      claim = await checkClaimExpiry(claim);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }
      res.json({
        status: claim.status,
        claim: {
          id: claim.id,
          status: claim.status,
          agent_confirmed_at: claim.agent_confirmed_at,
        },
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // Core logic for confirming a claim's payment and moving it to escrow.
  // Shared by the real IntaSend webhook AND the dev-only test-payment
  // simulator below, so both paths run through the exact same business
  // logic — no duplicated/diverging implementation between "real" and
  // "simulated" payment confirmation.
  async function processClaimPaymentConfirmed(claimId: string, invoiceId: string, confirmedAmount?: number | string | null): Promise<string | null> {
    // P1: webhook amount reconciliation. Before this, the webhook handler
    // never looked at the paid amount at all — only invoice_id, state, and
    // api_ref were read from the payload. Signature verification means an
    // attacker can't forge/alter a payload without the shared secret, but
    // that's a different guarantee than this one: a legitimately-signed
    // webhook could still report a different amount than what this claim
    // actually owes (a fee-calculation bug, a race between STK-push
    // initiation and confirmation, a provider-side anomaly) and nothing
    // would catch it — the claim would move to escrow_held and eventually
    // pay out Finder/Agent shares computed from ITS OWN expected fee,
    // silently diverging from what the owner was actually charged.
    //
    // NOTE ON FIELD NAME: this codebase has no prior reference to what
    // IntaSend actually calls the paid amount in a collection webhook
    // payload — the call site below best-effort reads payload.value (with
    // payload.amount as a fallback), based on IntaSend's typical naming,
    // but this has not been verified against live IntaSend documentation
    // from this environment (no network access). If the field name is
    // wrong, confirmedAmount arrives as undefined here, and — deliberately
    // — that does NOT block the payment (see below): a wrong guess about
    // an external API's field name should never be able to silently halt
    // every real payment, only add a soft warning until it's verified.
    const claim = await db.getClaim(claimId);
    if (!claim) return null;
    const item = await db.getItem(claim.item_id);
    if (!item) return null;

    // --- PAYMENT-SESSION RESOLUTION (primary production payment path) ---
    // If this provider invoice belongs to a payment session, verify it is bound
    // to THIS claim (cross-claim isolation) and reconcile the confirmed amount
    // against the session's authoritative amount. This is stronger than the
    // claim-fee fallback below because the session also pins the amount the
    // payer was actually prompted for, so a webhook can never confirm a
    // different claim or a different amount than the payer was charged.
    const session = await db.getPaymentSessionByProviderInvoice(invoiceId);
    if (session) {
      if (session.claim_id !== claimId) {
        console.error(`[WEBHOOK SESSION] Refusing confirmation: invoice ${invoiceId} belongs to payment session ${session.id} for claim ${session.claim_id}, not claim ${claimId}. Cross-claim payment blocked.`);
        await db.logAudit('SYSTEM', 'WEBHOOK_CROSS_CLAIM_REFUSED', `Invoice ${invoiceId} tried to confirm claim ${claimId} but belongs to session ${session.id} of claim ${session.claim_id}. Refused.`);
        return null;
      }
      if (confirmedAmount !== undefined && confirmedAmount !== null && confirmedAmount !== '') {
        const sessionAmountRecon = reconcileWebhookAmount(confirmedAmount, session.amount);
        if (sessionAmountRecon === 'mismatch') {
          console.error(`[WEBHOOK SESSION AMOUNT] Refusing to confirm session ${session.id} for claim ${claimId}: webhook amount ${confirmedAmount} != session amount ${session.amount}. Invoice ${invoiceId}.`);
          await db.logAudit('SYSTEM', 'WEBHOOK_AMOUNT_MISMATCH_REFUSED', `Claim ${claimId} session ${session.id}: webhook amount ${confirmedAmount} did not match session amount ${session.amount} (invoice ${invoiceId}). Refused.`);
          return null;
        }
      }
      // Per-session idempotency: only an unreserved, non-terminal session is
      // marked confirmed here; a duplicate webhook for an already-confirmed
      // session is a no-op. The claim-level CAS below is the outer idempotency
      // guard.
      const sessionConfirmed = await db.attemptPaymentSessionConfirm(session.id);
      if (!sessionConfirmed && session.status !== 'confirmed') {
        // The session wasn't in 'pending' (e.g. it was already confirmed). This
        // is safe to proceed from only when it's already confirmed; otherwise do
        // not let a session that was never initiated confirm the claim.
        console.warn(`[WEBHOOK SESSION] Invoice ${invoiceId} for session ${session.id} was not in a confirmable state (status=${session.status}).`);
        return null;
      }
    }

    const categoriesForReconciliation = await db.getCategories();
    const catForReconciliation = categoriesForReconciliation.find(c => c.id === item.category_id);
    let expectedFee = catForReconciliation ? catForReconciliation.total_fee : '0.00';
    if (item.locked_total_fee !== undefined && item.locked_total_fee !== null) {
      expectedFee = String(item.locked_total_fee);
    }

    if (confirmedAmount !== undefined && confirmedAmount !== null && confirmedAmount !== '') {
      const reconciliation = reconcileWebhookAmount(confirmedAmount, expectedFee);
      if (reconciliation === 'mismatch') {
        console.error(
          `[WEBHOOK AMOUNT RECONCILIATION] REFUSING to confirm payment for claim ${claimId}: webhook reports amount ${confirmedAmount}, claim expects ${expectedFee}. Invoice ${invoiceId}. This claim will remain in its current status pending manual admin investigation — it will NOT be silently held in escrow with a mismatched amount.`
        );
        await db.logAudit('SYSTEM', 'WEBHOOK_AMOUNT_MISMATCH_REFUSED', `Claim ${claimId}: webhook amount ${confirmedAmount} did not reconcile with expected fee ${expectedFee} (invoice ${invoiceId}). Payment confirmation refused pending manual review.`);
        return null;
      }
    } else {
      console.warn(`[WEBHOOK AMOUNT RECONCILIATION] No amount field found in webhook payload for claim ${claimId} (invoice ${invoiceId}) — proceeding without reconciliation. This should be verified against IntaSend's actual webhook payload format; see the comment on processClaimPaymentConfirmed.`);
    }

    // Atomic compare-and-swap: only the delivery that actually wins the
    // 'pending_payment' -> 'escrow_held' transition proceeds past this
    // point. A duplicate/retried webhook for an already-confirmed claim
    // returns false here and is dropped as a no-op, instead of re-running
    // the confirmation flow (new pickup code, duplicate emails/SMS) a
    // second time.
    const won = await db.attemptClaimEscrowHold(claimId, invoiceId);
    if (!won) return null;

    await db.updateItemStatus(item.id, 'at_agent');

    // Resolve as first-successfully-paid for non-sensitive items: auto-reject
    // other claims that are still competing for the same item.
    //
    // SC-6 FIX: this loop used to call
    //   updateClaimStatus(oc.id, 'rejected', 'System Auto-Rejected: ...')
    // which wrote a HUMAN-READABLE MESSAGE into claims.payment_reference. That
    // column is a provider reference and is read by payment-truth logic, so a
    // rejection message could masquerade as a payment.
    //
    // It also unconditionally overwrote EVERY other claim's status — including
    // terminal ones (released / refunded / rejected / expired) and claims
    // already pulled into an open dispute — silently regressing them. The
    // transition contract now refuses those, so this only ever rejects a claim
    // that was genuinely still competing, the reason is preserved in the audit
    // trail (where it belongs), and anything skipped is logged rather than
    // silently corrupted.
    if (item.is_sensitive_document === false) {
      const otherClaims = (await db.getClaims()).filter(c => c.item_id === item.id && c.id !== claimId);
      for (const oc of otherClaims) {
        const autoReject = await db.transitionClaimStatus({
          claimId: oc.id,
          expected: ['pending_verification', 'awaiting_agent_confirmation', 'pending_payment'],
          to: 'rejected',
          actor: 'SYSTEM',
          action: 'CLAIM_AUTO_REJECTED_FIRST_PAYMENT',
          details: `Claim ${oc.id} auto-rejected: another claimant on item ${item.id} successfully paid first.`,
        });
        if (!autoReject.ok) {
          // Legitimately skipped: the claim is terminal, escrowed, or part of a
          // dispute — in every case NOT ours to reject from this path.
          console.log(
            `[AUTO-REJECT] Skipped claim ${oc.id} (status=${autoReject.from ?? 'unknown'}, reason=${autoReject.code}).`,
          );
        }
      }
    }

    // Pre-fetch metadata for emails
    const cat = catForReconciliation;
    const itemName = cat ? cat.name_en : 'Found Document / Item';
    const agent = await db.getAgent(item.assigned_agent_id);

    const resolvedFee = expectedFee;

    // Generate a genuinely secret, single-use pickup code for this claim.
    // NOTE: this is deliberately NOT the item's drop-off code (item.id) —
    // that code is public (it's broadcast on Telegram/Facebook/X in the
    // claim link), so it proves nothing about who is physically present
    // at the agent hub. Only the HMAC hash is ever stored; the plaintext
    // code is sent once, privately, to the owner via SMS and email, and
    // the agent must have the owner read it out at handover.
    const pickupCode = crypto.randomInt(100000, 1000000).toString();
    await db.createPickupCode(claim.id, hashCode(pickupCode));

    // 1. Send email to owner if provided
    if (claim.owner_email && claim.owner_email.trim() !== '') {
      EmailService.sendPaymentReceivedEmail(
        claim.owner_email,
        claim.owner_phone,
        itemName,
        agent ? agent.business_name : 'Return4me Agent Hub',
        agent ? agent.contact_phone : 'Contact Support',
        item.id,
        pickupCode
      ).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Payment received email failed:', err));
    }

    // 1b. Send the pickup code via SMS too — many owners won't have
    // provided an email, and SMS is the more reliable channel in Kenya.
    AuthService.sendSms(
      claim.owner_phone,
      `Return4me: Malipo yamethibitishwa. Msimbo wako wa siri wa kuchukua bidhaa ni ${pickupCode}. Toa msimbo huu kwa Agent PEKEE wakati wa kuchukua bidhaa yako. Usimshirikishe mtu mwingine. / Payment confirmed. Your secret pickup code is ${pickupCode}. Give this ONLY to the Agent when collecting your item. Do not share it with anyone else.`
    ).catch(err => console.error('[SMS NOTIFICATION ERROR] Pickup code SMS failed:', err));

    // 2. Send email to agent if provided
    if (agent && agent.contact_email && agent.contact_email.trim() !== '') {
      EmailService.sendAgentPaymentConfirmedEmail(
        agent.contact_email,
        agent.business_name,
        itemName,
        item.id,
        claim.id
      ).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Agent payment confirmed email failed:', err));
    }

    // 3. Send transaction log email to admin
    EmailService.sendAdminTransactionLogEmail(
      'PAYMENT_CONFIRMED',
      claim.id,
      item.id,
      resolvedFee,
      agent ? agent.business_name : 'Unknown Agent'
    ).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Admin payment log email failed:', err));

    console.log(`[PAYMENT CONFIRMED] Claim ${claimId} successfully transitioned to escrow_held.`);
    return pickupCode;
  }

  // Webhook for IntaSend payment confirmation events
  app.post('/api/webhooks/intasend', async (req, res) => {
    const payload = req.body;
    const signatureHeader = req.headers['x-intasend-signature'] as string || req.headers['signature'] as string;
    const webhookSecret = process.env.INTASEND_WEBHOOK_SECRET;

    // SECURITY/LOGGING: this used to log the complete raw payload via
    // JSON.stringify(payload, null, 2) — IntaSend collection callbacks
    // typically carry the payer's phone number (and sometimes account/
    // narrative fields), so that line was writing an unmasked phone number
    // to production logs every single payment, in direct violation of the
    // no-full-phone-numbers-in-logs rule this codebase already follows
    // elsewhere (see maskPhoneForLog, used for the exact same purpose in
    // auth.ts and the sweep job below). Log only the fields actually
    // useful for debugging a webhook delivery, with the phone masked.
    const logSafePayload = {
      invoice_id: payload?.invoice_id,
      state: payload?.state,
      api_ref: payload?.api_ref,
      value: payload?.value,
      phone_number: maskPhoneForLog(payload?.phone_number),
    };
    console.log('[INTASEND WEBHOOK] Received callback event:', JSON.stringify(logSafePayload, null, 2));

    // Missing signature rejection in production
    if (!signatureHeader && !payload.signature) {
      console.warn('[INTASEND WEBHOOK] Missing signature header and signature field.');
      if (process.env.NODE_ENV === 'production') {
        return res.status(401).json({ error: 'Missing signature' });
      }
    }

    if (webhookSecret) {
      let isValid = false;

      // Method 1: Check signature header
      if (signatureHeader) {
        const computed = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(payload)).digest('hex');
        // BUGFIX: this used to compare with plain `===`, a variable-time
        // string comparison — inconsistent with the timing-safe comparison
        // this codebase already uses everywhere else a secret/HMAC value is
        // checked (OTP codes, pickup codes, the claim payment-auth token).
        // A `===` comparison on a hex digest leaks (in principle, via
        // response-timing statistics across many attempts) how many
        // leading characters an attacker's guess got right, incrementally
        // narrowing the search space for a value that's supposed to be
        // computationally infeasible to guess at all.
        if (timingSafeEqualHex(computed, signatureHeader)) {
          isValid = true;
        }
      }

      // Method 2: Check embedded signature
      if (!isValid && payload.signature) {
        const { signature, ...rest } = payload;
        const computed = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(rest)).digest('hex');
        if (typeof signature === 'string' && timingSafeEqualHex(computed, signature)) {
          isValid = true;
        }
      }

      if (!isValid) {
        console.warn('[INTASEND WEBHOOK] Webhook signature verification failed.');
        if (process.env.NODE_ENV === 'production') {
          return res.status(401).json({ error: 'Signature verification failed' });
        }
        console.warn('[INTASEND WEBHOOK] Continuing in sandbox/development mode.');
      } else {
        console.log('[INTASEND WEBHOOK] Signature verified successfully.');
      }
    } else if (process.env.NODE_ENV === 'production') {
      console.warn('[INTASEND WEBHOOK] Webhook secret is missing in production.');
      return res.status(401).json({ error: 'Webhook secret is missing' });
    }

    const { invoice_id, state, api_ref, value, amount } = payload;
    const claimId = api_ref;
    // Best-effort field-name guess — see the NOTE ON FIELD NAME comment on
    // processClaimPaymentConfirmed.
    const webhookAmount = value ?? amount;

    if (claimId && (state === 'COMPLETE' || state === 'COMPLETED' || state === 'SUCCESS')) {
      try {
        await processClaimPaymentConfirmed(claimId, invoice_id, webhookAmount);
      } catch (err: any) {
        console.error('[INTASEND WEBHOOK] Error handling claim payment webhook update:', err);
        return sendServerError(res, err, 'INTASEND_WEBHOOK_CLAIM_UPDATE_ERROR');
      }
    }

    res.json({ status: 'ok' });
  });

  // DEV/TEST-ONLY: lets a local tester complete a payment without a real
  // M-Pesa phone or real IntaSend keys. With sandbox/placeholder IntaSend
  // credentials, no real STK push ever reaches a phone, so the payment
  // polling screen would otherwise wait the full 90 seconds and time out
  // every single time — there was no way to actually finish testing the
  // flow through the browser. This runs the identical confirmation logic
  // the real webhook uses, so it exercises the real code path, just without
  // requiring an actual M-Pesa transaction.
  //
  // SC-9 HARD BOUNDARY. This endpoint fabricates an authoritative payment
  // confirmation, so its gate must not depend on a flag that is also used for
  // something else, nor on NODE_ENV being unset. It requires ALL THREE of:
  //   1. NODE_ENV explicitly 'development' or 'test' (NOT unset, NOT production)
  //   2. ALLOW_MOCK_OTP_BYPASS === 'true'   (the existing dev-convenience flag)
  //   3. ENABLE_DEV_PAYMENT_SIMULATION === 'true'  (dedicated, money-specific)
  // and boot() additionally refuses to start in production if (3) is set.
  app.post('/api/dev/simulate-payment/:claimId', async (req, res) => {
    if (!isDevPaymentSimulationEnabled()) {
      return res.status(404).json({ error: 'Not found' });
    }
    try {
      const claim = await db.getClaim(req.params.claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim not found' });
      }
      if (claim.status !== 'pending_payment') {
        return res.status(400).json({ error: `Claim is not awaiting payment (status: ${claim.status})` });
      }
      const pickupCode = await processClaimPaymentConfirmed(req.params.claimId, `TEST-SIMULATED-${Date.now()}`);
      const updatedClaim = await db.getClaim(req.params.claimId);
      // pickupCode is only ever returned here — a dev/test-only endpoint,
      // already hard-gated off in production above. In the real flow it's
      // never exposed via any API response, only sent privately by SMS/email.
      res.json({ success: true, claim: updatedClaim, pickupCode });
    } catch (e: any) {
      console.error('[DEV SIMULATE PAYMENT] Failed:', e);
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // Lets the frontend know whether dev/test conveniences are active, without
  // hardcoding that assumption client-side or exposing it in production.
  app.get('/api/dev/test-mode', (req, res) => {
    res.json({
      testModeEnabled: process.env.NODE_ENV !== 'production' && process.env.ALLOW_MOCK_OTP_BYPASS === 'true',
      // Reported separately from the OTP bypass: this one fabricates payment
      // confirmation, so it has its own, stricter flag (SC-9).
      paymentSimulationEnabled: isDevPaymentSimulationEnabled(),
    });
  });

  // 8. AGENT HUB QUEUES
  app.get('/api/agents/queue', authenticateJWT, requireActiveAgent, async (req, res) => {
    try {
      const agentId = req.user!.agentId!;

      // Get items assigned to this agent
      //
      // PERFORMANCE: this used to fetch the entire items table
      // (db.getItems(), every status, every historical row) and filter by
      // assigned_agent_id in application code — despite idx_items_agent
      // already existing on exactly this column and sitting unused here.
      // getItemsByAgent() pushes the filter into the WHERE clause so this
      // actually uses that index instead of scanning every item in the
      // system on every agent dashboard load.
      const items = await db.getItemsByAgent(agentId);
      
      const rawClaims = await db.getClaims();
      const allClaims = [];
      for (const claim of rawClaims) {
        allClaims.push(await checkClaimExpiry(claim));
      }
      const claims = allClaims.filter(c => items.some(i => i.id === c.item_id));

      const earnings = await db.getAgentEarnings(agentId);

      res.json({
        agent: req.activeAgent,
        earnings,
        pendingDropoffs: items.filter(i => i.status === 'awaiting_dropoff'),
        holdingItems: items.filter(i => i.status === 'at_agent').map(item => {
          const associatedClaim = claims.find(c => c.item_id === item.id && (
            c.status === 'escrow_held' || 
            c.status === 'released' || 
            c.status === 'disputed' ||
            c.status === 'awaiting_agent_confirmation' ||
            c.status === 'pending_payment'
          ));
          return {
            ...item,
            associatedClaim: associatedClaim ? {
              id: associatedClaim.id,
              status: associatedClaim.status,
              agent_confirmed_at: associatedClaim.agent_confirmed_at || null,
              // Operational evidence only: the subset the assigned agent needs to
              // physically compare against the item, never the raw claim row.
              owner_identifying_details: associatedClaim.owner_identifying_details || null,
              security_answers: toAgentVerificationEvidence(item.category_id || 'other-item', associatedClaim.security_answers),
            } : undefined,
          };
        }),
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 9. AGENT CONFIRMATIONS
  /**
   * Agent correction/verification step — must happen BEFORE
   * confirm-dropoff (physical approve & accept). Lets the Agent, who is
   * physically looking at the item, correct or complete what the Finder
   * submitted. Original Finder data is never touched; see
   * recordItemVerification in database.ts for the full data-integrity
   * and sensitive-document rules this enforces.
   */
  app.post('/api/agents/verify-item', authenticateJWT, requireActiveAgent, async (req, res) => {
    const { dropoffCode, categoryId, name, documentNumber, description, foundArea, reason, reasonDetail, physicallyVerified } = req.body;

    try {
      const item = await db.getItem(dropoffCode);
      if (!item) {
        return res.status(404).json({ error: 'Msimbo wa kuwasilisha (Drop-off code) si sahihi.' });
      }

      if (item.assigned_agent_id !== req.user.agentId) {
        return res.status(403).json({ error: 'Bidhaa hii haijapangiwa physical hub yako.' });
      }

      if (item.status !== 'awaiting_dropoff') {
        return res.status(400).json({ error: `Bidhaa hii tayari imeshughulikiwa. Hali ya sasa: ${item.status}` });
      }

      if (!categoryId || !foundArea) {
        return res.status(400).json({ error: 'Kategoria na eneo lililopatikana ni lazima.' });
      }

      const result = await db.recordItemVerification(
        dropoffCode,
        req.user.agentId,
        {
          category_id: categoryId,
          name: name ?? null,
          document_number: documentNumber ?? null,
          description: description ?? null,
          found_area: foundArea,
        },
        reason || '',
        reasonDetail || null,
        !!physicallyVerified
      );

      if (!result.success) {
        return res.status(400).json({ error: result.message });
      }

      res.json({ success: true, message: result.message });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/agents/confirm-dropoff', authenticateJWT, requireActiveAgent, async (req, res) => {
    const { dropoffCode } = req.body;

    try {
      const item = await db.getItem(dropoffCode);
      if (!item) {
        return res.status(404).json({ error: 'Msimbo wa kuwasilisha (Drop-off code) si sahihi.' });
      }

      if (item.assigned_agent_id !== req.user.agentId) {
        return res.status(403).json({ error: 'Bidhaa hii haijapangiwa physical hub yako.' });
      }

      // The Agent must complete verification (confirm-as-reported or
      // correct-and-save) before physically approving the item — this is
      // enforced here, server-side, not just by the frontend button
      // sequence, so it can't be bypassed by calling the API directly.
      if (item.verification_status === 'pending') {
        return res.status(400).json({ error: 'Tafadhali kamilisha uthibitisho wa bidhaa kabla ya kuikubali. / Please complete item verification before approving it.' });
      }
      if (!item.physically_verified_at) {
        return res.status(400).json({ error: 'Tafadhali thibitisha kimwili bidhaa hii kabla ya kuikubali. / Please physically verify this item before approving it.' });
      }

      // SOCIAL MEDIA AUTO-POSTING INTEGRATION POINT:
      // When the Facebook/Telegram auto-posting module is built, the trigger event MUST
      // be right here when the status changes from 'awaiting_dropoff' to 'at_agent'.
      // DO NOT trigger posting on initial report creation (when status is 'awaiting_dropoff')
      // as that would result in unverified, possibly fake, or spam reports being published publicly
      // before a physical human (the agent) has physically verified the item actually exists and is deposited.
      await db.updateItemStatus(dropoffCode, 'at_agent');

      // Fetch the updated item, category, and agent to trigger our auto-posting module
      try {
        const fullItem = await db.getItem(dropoffCode);
        if (fullItem) {
          const category = fullItem.category_id ? await db.getCategory(fullItem.category_id) : undefined;
          const agent = fullItem.assigned_agent_id ? await db.getAgent(fullItem.assigned_agent_id) : undefined;

          const socialPaused = await isSocialPublishingPaused();
          if (socialPaused) {
            console.log(`[SOCIAL MEDIA AUTO-POST] Skipped for item ${dropoffCode} — social publishing is paused by admin.`);
          } else {
            // Trigger the social media broadcast asynchronously to prevent blocking the agent's API response
            SocialService.broadcastVerifiedItem(
              fullItem,
              agent ? {
                id: agent.id,
                business_name: agent.business_name,
                location_address: agent.location_address,
                contact_phone: agent.contact_phone
              } : undefined,
              category ? {
                id: category.id,
                name_en: category.name_en,
                name_sw: category.name_sw,
                total_fee: category.total_fee,
                is_sensitive_document: category.is_sensitive_document
              } : undefined
            ).catch(socialErr => {
              console.error('[SOCIAL MEDIA AUTO-POST] Async broadcast error:', socialErr);
            });
          }
        }
      } catch (e) {
        console.error('[SOCIAL MEDIA AUTO-POST] Failed to prepare social broadcast details:', e);
      }

      res.json({ success: true, message: 'Uthibitisho umekamilika! Bidhaa sasa ipo salama kwenye hub yako.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/agents/reject-dropoff', authenticateJWT, requireActiveAgent, async (req, res) => {
    const { dropoffCode, reason } = req.body;

    if (!dropoffCode || !reason || !reason.trim() || /^Other:\s*$/i.test(reason.trim())) {
      return res.status(400).json({ error: 'Msimbo wa drop-off na sababu vinahitajika.' });
    }

    try {
      const item = await db.getItem(dropoffCode);
      if (!item) {
        return res.status(404).json({ error: 'Msimbo wa kuwasilisha (Drop-off code) si sahihi.' });
      }

      if (item.assigned_agent_id !== req.user.agentId) {
        return res.status(403).json({ error: 'Bidhaa hii haijapangiwa physical hub yako.' });
      }

      // The rejecting actor is recorded explicitly: this route is an
      // authenticated AGENT action, so it must not be attributed to an
      // administrator nor silently collapsed into "SYSTEM" (see rejectItem).
      await db.rejectItem(dropoffCode, reason, 'AGENT');
      res.json({ success: true, message: 'Bidhaa imekataliwa na kuondolewa kwenye mfumo.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/agents/claims/:claimId/confirm-viewing', authenticateJWT, requireActiveAgent, async (req, res) => {
    const claimId = req.params.claimId;

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }

      const item = await db.getItem(claim.item_id);
      if (!item || item.assigned_agent_id !== req.user.agentId) {
        return res.status(403).json({ error: 'Msimbo huu hauhusiani na hub yako.' });
      }

      if (claim.status !== 'awaiting_agent_confirmation') {
        return res.status(400).json({ error: 'Claim lazima iwe kwenye hali ya kusubiri uthibitisho wa wakala kabla ya kuthibitisha.' });
      }

      // SC-2/SC-8: status change and its audit row now commit together through
      // the central transition contract, with the expected state enforced by an
      // atomic CAS. A concurrent second confirmation loses the race and gets a
      // 409 instead of silently double-writing.
      const viewingTransition = await db.transitionClaimStatus({
        claimId,
        expected: ['awaiting_agent_confirmation'],
        to: 'pending_payment',
        actor: `AGENT_${req.user.agentId}`,
        action: 'AGENT_CONFIRMED_VIEWING',
        details: `Agent ${req.user.agentId} confirmed in-person viewing for claim ${claimId} and item ${item.id}`,
        extraSet: { agent_confirmed_at: new Date() },
      });
      if (!viewingTransition.ok) {
        return res.status(viewingTransition.code === 'NOT_FOUND' ? 404 : 409).json({
          error: 'Claim hii imeshashughulikiwa hivi punde. Tafadhali pakia upya. / This claim was handled moments ago. Please reload.',
        });
      }

      // Get updated claim to return
      const updatedClaim = await db.getClaim(claimId);
      res.json({ success: true, claim: updatedClaim });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/agents/confirm-handover', authenticateJWT, requireActiveAgent, async (req, res) => {
    const { claimId, userRating, pickupCode } = req.body;

    if (await isPlatformOperationPaused(pauseSettingKey('handovers'))) {
      return res.status(503).json({ error: PAUSED_MESSAGES.handovers });
    }

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }

      const item = await db.getItem(claim.item_id);
      if (!item || item.assigned_agent_id !== req.user.agentId) {
        return res.status(403).json({ error: 'Msimbo huu hauhusiani na hub yako.' });
      }

      const category = await db.getCategory(item.category_id);
      if (!category) {
        return res.status(404).json({ error: 'Ada ya kategoria haikupatikana.' });
      }

      const agent = await db.getAgent(item.assigned_agent_id);
      if (!agent) {
        return res.status(404).json({ error: 'Hub haikupatikana.' });
      }

      if (claim.status !== 'escrow_held') {
        return res.status(400).json({ error: `Huwezi kutoa bidhaa hii. Hali ya sasa ni: ${claim.status}` });
      }

      // Fail-safe: even with money already in escrow, never let the physical
      // item leave custody once it's been flagged stolen/legal-hold, or if
      // a competing claimant has opened an unresolved ownership dispute in
      // the meantime. If uncertain, do not release the item — escalate to
      // admin instead. (item.status is expected to still be 'at_agent' here
      // since physical custody hasn't transferred yet — canCreateClaim's
      // 'at_agent' requirement is not the binding condition in this case,
      // the dispute/hold checks are.)
      const claimability = await canCreateClaim(item);
      if (!claimability.allowed && (claimability.reason === 'suspected_stolen' || claimability.reason === 'legal_hold' || claimability.reason === 'unresolved_dispute')) {
        return res.status(423).json({ error: claimabilityErrorMessage(claimability.reason) });
      }

      // SECURITY: require the owner's secret pickup code (sent privately via
      // SMS/email when payment was confirmed) before releasing any money —
      // and, per the fix below, before uploading/storing any photo at all.
      if (!pickupCode || typeof pickupCode !== 'string' || pickupCode.trim() === '') {
        return res.status(400).json({ error: 'Muulize mmiliki msimbo wake wa siri wa kuchukua bidhaa kabla ya kuendelea. / Ask the owner for their secret pickup code before proceeding.' });
      }

      // P0: pickup-code hash verification now happens BEFORE the photo
      // upload/storage step below, not after. Previously the handover
      // photo was uploaded and persisted to the claim (db.setHandoverPhoto)
      // first, and only THEN was the pickup code actually checked against
      // its hash — meaning a wrong pickup code (a typo, a scam attempt, an
      // agent testing the flow) still left a real uploaded evidence photo
      // stored against the claim even though the handover never actually
      // happened. Correct order: authorize the agent and the claim/item,
      // validate claim state, validate the pickup code, THEN — and only
      // then — validate and upload the photo.
      const pickupRecord = await db.getPickupCode(claimId);
      if (!pickupRecord) {
        return res.status(400).json({ error: 'Msimbo wa kuchukua haujaanzishwa kwa dai hili. / No pickup code has been issued for this claim yet.' });
      }
      if (!timingSafeEqualHex(hashCode(pickupCode.trim()), pickupRecord.code_hash)) {
        return res.status(400).json({ error: 'Msimbo wa siri wa kuchukua si sahihi. Muulize mmiliki tena. / The secret pickup code is incorrect. Ask the owner again.' });
      }
      await db.markPickupCodeVerified(claimId);

      // Require a handover evidence photo (the claimant holding the item,
      // ideally alongside their own ID) before any payout can be triggered.
      // This is the platform's main defense against an agent colluding with
      // someone who is not the real owner: a colluding agent now has to
      // actively produce and submit fabricated evidence rather than simply
      // clicking a button with no record at all, and a genuine dispute later
      // has something concrete to review. Only reached now that the pickup
      // code has already been confirmed correct — see the comment above.
      const { handoverPhotoBase64 } = req.body;
      if (!handoverPhotoBase64 || typeof handoverPhotoBase64 !== 'string' || handoverPhotoBase64.trim() === '') {
        return res.status(400).json({ error: 'Piga picha ya mdai akiwa na bidhaa kabla ya kutoa. Hii inalinda dhidi ya udanganyifu. / Take a photo of the claimant with the item before handing it over. This protects against fraud.' });
      }
      let handoverPhotoUrl: string;
      try {
        handoverPhotoUrl = await uploadBase64Image(handoverPhotoBase64, 'handover-evidence');
      } catch (uploadErr: any) {
        console.error('[HANDOVER PHOTO UPLOAD ERROR]:', uploadErr);
        return res.status(500).json({ error: 'Imeshindikana kupakia picha. Tafadhali jaribu tena. / Failed to upload photo. Please try again.' });
      }
      await db.setHandoverPhoto(claimId, handoverPhotoUrl);

      // Atomically claim the exclusive right to move this claim into
      // settlement. If two (or more) confirm-handover requests arrive
      // concurrently for the same claim — a double-click, a retry, or a
      // scripted attack — only one of them will win this compare-and-swap;
      // the rest are rejected here, before anything financial is booked.
      const settlement = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
      if (!settlement.success) {
        return res.status(409).json({ error: settlement.message || 'Dai hili tayari linashughulikiwa au limekwisha kamilika. / This claim is already being processed or has already been completed.' });
      }

      // NOTE: the actual M-Pesa split disbursement does NOT happen here. The
      // payout is booked in the ledger as 'pending' and will be sent by the
      // settlement sweep (releaseDueSettlements) once DISPUTE_WINDOW_HOURS
      // has elapsed with no dispute raised — or immediately by an admin via
      // POST /api/admin/claims/:id/release-settlement. This gives a real
      // window for a second claimant, the owner, or an admin to freeze a
      // suspicious handover before any money actually moves.

      // Close out the public listing with a short, privacy-safe follow-up notice.
      // Fired asynchronously so a social platform outage never blocks the actual
      // handover response to the agent — mirrors the pattern used for the
      // original found-item broadcast in /api/agents/confirm-dropoff.
      isSocialPublishingPaused().then(paused => {
        if (paused) {
          console.log(`[SOCIAL MEDIA AUTO-POST] Reunited-notice skipped for claim ${claimId} — social publishing is paused by admin.`);
          return;
        }
        SocialService.broadcastItemReunited(
          item,
          category ? {
            id: category.id,
            name_en: category.name_en,
            name_sw: category.name_sw,
            total_fee: category.total_fee,
            is_sensitive_document: category.is_sensitive_document
          } : undefined
        ).catch(socialErr => {
          console.error('[SOCIAL MEDIA AUTO-POST] Async reunited-notice broadcast error:', socialErr);
        });
      }).catch(pauseCheckErr => {
        console.error('[SOCIAL MEDIA AUTO-POST] Failed to check publishing-pause setting, skipping reunited-notice as a precaution:', pauseCheckErr);
      });

      const itemName = category ? category.name_en : 'Found Document / Item';
      let resolvedFee = category ? category.total_fee : '0.00';
      if (item.locked_total_fee !== undefined && item.locked_total_fee !== null) {
        resolvedFee = String(item.locked_total_fee);
      }

      // 1. Send item collection email asynchronously if owner email is provided
      if (claim.owner_email && claim.owner_email.trim() !== '') {
        const dateStr = new Date().toLocaleDateString('en-KE', {
          timeZone: 'Africa/Nairobi',
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        EmailService.sendItemHandedOverEmail(
          claim.owner_email,
          claim.owner_phone,
          itemName,
          item.id,
          dateStr
        ).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Handover confirmation email failed:', err));
      }

      // 2. Send finder collection email asynchronously if finder email is provided
      if (item.finder_email && item.finder_email.trim() !== '') {
        EmailService.sendFinderItemCollectedEmail(
          item.finder_email,
          itemName,
          item.id
        ).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Finder item collected email failed:', err));
      }

      // 3. Send transaction log email to admin
      EmailService.sendAdminTransactionLogEmail(
        'HANDOVER_CONFIRMED_PENDING_SETTLEMENT',
        claim.id,
        item.id,
        resolvedFee,
        agent ? agent.business_name : 'Unknown Agent'
      ).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Admin handover log email failed:', err));

      if (userRating) {
        await db.rateAgent(req.user.agentId, parseFloat(userRating));
      }

      res.json({ success: true, message: settlement.message, settleAt: settlement.settleAt });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 10. ADMIN DASHBOARD & CONTROLS
  app.get('/api/admin/dashboard', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }

      const agents = await db.getAgents();
      const items = await db.getItems();
      const claims = await db.getClaims();
      const disputes = await db.getDisputes();
      const ledger = await db.getLedger();
      // Bounded ledger/audit for the dashboard payload. The raw
      // getLedger()/getAuditLogs() calls above return the full historical
      // tables, which we use for in-memory stats computation (totalRevenue,
      // completedAgentPayouts). The dashboard payload itself must never ship the
      // full tables — we use bounded recent windows mapped through explicit
      // admin whitelists so raw DB columns (provider refs, failure reasons,
      // unsanitized audit detail text, recipient phone/till) never reach the
      // browser even if the frontend is bypassed.
      const dbLedger = await db.getRecentLedgerEntries(100);
      const dbAuditLogs = await db.getRecentAuditLogs(100);

      // Claim lookup for the dispute DTO's per-claimant summaries. Built from
      // the claims already loaded above — no extra query per dispute.
      const claimsById = new Map<string, any>(claims.map((c: any) => [c.id, c]));

      // Fetch reputation for each item's finder_phone
      //
      // getPhoneReputation() internally calls db.getItems() AGAIN to compute
      // its per-phone counts — calling it once per item here re-fetches the
      // ENTIRE items table once per item. With N items that's O(N²) row
      // reads: 500 items means 500 calls each re-scanning all 500 items,
      // 250,000 row reads for one admin dashboard load, growing quadratically
      // worse as the table grows. `items` is already loaded once above, so
      // the counts can be computed from it directly with zero extra
      // full-table re-fetches — isPhoneCleared() is still a real per-phone
      // lookup, but it's a cheap indexed single-row query, and calling it
      // once per DISTINCT phone (not once per item) keeps it bounded by the
      // number of unique finders rather than the number of items.
      const itemCountsByPhone = new Map<string, { total: number; rejected: number }>();
      for (const it of items) {
        const entry = itemCountsByPhone.get(it.finder_phone) || { total: 0, rejected: 0 };
        entry.total += 1;
        if (it.status === 'rejected') entry.rejected += 1;
        itemCountsByPhone.set(it.finder_phone, entry);
      }
      const uniquePhones = Array.from(itemCountsByPhone.keys());
      const clearedByPhone = new Map<string, boolean>(
        await Promise.all(uniquePhones.map(async (p): Promise<[string, boolean]> => [p, await db.isPhoneCleared(p)]))
      );
      // Build the bulk item payload through an explicit admin whitelist rather
      // than spreading the raw row. The previous `{ ...item }` shipped every
      // item column to the browser on every console load — including
      // document_number_hash, finder_email and the per-item locked-fee
      // internals, none of which any admin screen reads.
      const itemsWithReputation = items.map(item => {
        const counts = itemCountsByPhone.get(item.finder_phone) || { total: 0, rejected: 0 };
        const isCleared = clearedByPhone.get(item.finder_phone) || false;
        let autoFlag = false;
        if (counts.total >= 3) {
          const ratio = counts.rejected / counts.total;
          if (ratio > 0.3) {
            autoFlag = !isCleared;
          }
        }
        return toAdminSafeItemView(item, {
          total_reports: counts.total,
          rejected_reports: counts.rejected,
          autoFlag,
        });
      });

      // Computations
      //
      // PHASE 10 (F-2): `escrowHeldCount` used to be the ONLY escrow statistic and
      // the admin console rendered it under the label "Escrow Funds Held" — a
      // count of claims presented as a monetary figure, directly beside a
      // genuine `KES {totalRevenue}` card. The amount is now the authoritative
      // server-side sum of `items.locked_total_fee` over claims in `escrow_held`
      // (the same field the payment path charges via
      // resolveAuthoritativePaymentFee), computed from the rows already loaded
      // above — no new query, no client input, no change to any escrow
      // transition, authorisation, capture, refund or reconciliation behaviour.
      // The count is still published, under its own truthful label in the UI.
      const escrowFundsHeld = computeEscrowFundsHeld(claims, items);

      const stats = {
        pendingAgentsCount: agents.filter(a => a.status === 'pending').length,
        itemsInReviewCount: items.filter(i => i.status === 'awaiting_dropoff').length,
        itemsAtAgentCount: items.filter(i => i.status === 'at_agent').length,
        // KES actually held for escrow-held claims (SUM of locked_total_fee).
        escrowHeldAmount: escrowFundsHeld.amount,
        // How many claims are in escrow_held. Displayed as "Claims in Escrow".
        escrowHeldCount: escrowFundsHeld.count,
        disputesOpenCount: disputes.filter(d => !d.resolved_at).length,
        totalRevenue: ledger.filter(l => l.type === 'platform_fee' && l.status === 'completed').reduce((sum, l) => sum + l.amount, 0),
      };

      // Attach each agent's total earnings (their share of completed
      // escrow releases) so admin can see who's earning what without a
      // separate request per agent — built from data already loaded above.
      //
      // The payload is built through the explicit admin whitelist rather than
      // `{ ...agent }`: the raw row carries national_id_hash, the agent's
      // national-ID photo URL and shop photo URL, none of which belong in a
      // bulk refresh (vetting documents are served on demand by
      // GET /api/admin/agents/:id/documents).
      const completedAgentPayouts = ledger.filter(l => l.type === 'agent_payout' && l.status === 'completed');
      const agentsWithEarnings = agents.map(agent => {
        const agentItemIds = new Set(items.filter(i => i.assigned_agent_id === agent.id).map(i => i.id));
        const payouts = completedAgentPayouts.filter(l => l.item_id && agentItemIds.has(l.item_id));
        return toAdminSafeAgentView(agent, {
          total_earned: payouts.reduce((sum, l) => sum + l.amount, 0),
          completed_payouts_count: payouts.length,
        });
      });

      const currentAdmin = req.user?.username ? await db.getAdminByUsername(req.user.username) : null;

      // Claims sitting in the dispute window, most-soon-to-settle first —
      // lets an admin see (and, if needed, override) exactly what's about to
      // be disbursed and when.
      const pendingSettlements = claims
        .filter(c => c.status === 'pending_settlement')
        .sort((a, b) => new Date(a.settle_at || 0).getTime() - new Date(b.settle_at || 0).getTime())
        .map(c => {
          const item = items.find(i => i.id === c.item_id);
          return {
            claimId: c.id,
            itemId: c.item_id,
            settleAt: c.settle_at,
            itemCategoryId: item?.category_id || null,
            lockedTotalFee: item?.locked_total_fee ?? null,
          };
        });

      // `disputes` is mapped through the explicit admin whitelist: the raw
      // rows carry each claimant's government-ID proof URL plus free-text
      // admin_notes, which are not needed to list disputes. Evidence stays
      // available on demand via GET /api/admin/disputes/:disputeId/evidence.
      // The claims map supplies each claimant's live status/phone so the
      // console can name the two claimants without guessing.
      res.json({
        stats,
        agents: agentsWithEarnings,
        disputes: disputes.map(d => toAdminSafeDisputeView(d, claimsById)),
        items: itemsWithReputation,
        ledger: dbLedger.map(toAdminSafeLedgerEntry),
        pendingSettlements,
        auditLogs: dbAuditLogs.map(toAdminSafeAuditLog),
        currentAdminTotpEnabled: !!currentAdmin?.totp_enabled,
        socialPublishingPaused: await isSocialPublishingPaused(),
      });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/agents/:id/approve', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const agentId = req.params.id;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.approveAgent(agentId, adminIdentifier);
      res.json({ success: true, message: 'Return4me Agent amethibitishwa na kuruhusiwa kuanza kazi.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // Manually set or correct an agent's GPS coordinates. Needed because agent
  // signup only geocodes a free-text address automatically — when that fails
  // (common with informal Kenyan addresses) or is wrong, this is the only way
  // to fix it so the agent becomes matchable by the nearest-agent algorithm.
  app.post('/api/admin/agents/:id/location', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const agentId = req.params.id;
    const { latitude, longitude } = req.body;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      // PHASE 9D (F3) — the SAME shared validator every other coordinate input
      // goes through. Previously this route used a local, lenient numeric
      // coercion ('1.29junk' silently became 1.29) and duplicated the
      // latitude/longitude range rule in a second place that could drift from
      // the shared one. Authorization, the response shape and valid-value
      // behaviour are unchanged: an invalid pair still yields the same 400 and
      // the same bilingual message.
      const coordinates = normalizeCoordinateInput(latitude, longitude);
      if (!coordinates) {
        return res.status(400).json({ error: 'Latitude/longitude si sahihi. / Invalid latitude/longitude.' });
      }
      const agent = await db.getAgent(agentId);
      if (!agent) {
        return res.status(404).json({ error: 'Agent haikupatikana.' });
      }
      const updated = await db.updateAgentLocation(agentId, coordinates.latitude, coordinates.longitude);
      await db.logAudit(
        req.user?.username || req.user?.userId || 'admin',
        'AGENT_LOCATION_MANUALLY_SET',
        `Admin manually set coordinates for agent ${agent.business_name} (${agentId}) to ${coordinates.latitude}, ${coordinates.longitude}`
      );
      res.json({ success: true, agent: updated, message: 'Mahali pa Agent pamesasishwa. / Agent location updated.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // On-demand agent vetting evidence.
  //
  // Deliberately NOT part of the bulk /api/admin/dashboard payload: an agent's
  // national-ID document and shop photo are sensitive identity evidence, and
  // are only needed while an administrator is reviewing one specific agent
  // application. The console calls this when an agent row is expanded, instead
  // of every console page-load carrying those URLs for every agent.
  // Same authorization stack as every other admin route.
  app.get('/api/admin/agents/:id/documents', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const agent = await db.getAgent(req.params.id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent haikupatikana.' });
      }
      return res.json({ success: true, documents: toAdminSafeAgentDocumentsView(agent) });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/agents/:id/suspend', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const agentId = req.params.id;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.suspendAgent(agentId, adminIdentifier);
      res.json({ success: true, message: 'Return4me Agent amesimamishwa kazi kwa muda.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/agents/:id/warn', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const agentId = req.params.id;
    const { reason } = req.body;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      if (!reason || typeof reason !== 'string' || reason.trim() === '') {
        return res.status(400).json({ error: 'Tafadhali weka sababu ya kumpa wakala onyo.' });
      }
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      const updatedAgent = await db.warnAgent(agentId, reason, adminIdentifier);
      res.json({ success: true, message: 'Onyo limetumwa kwa wakala kikamilifu.', agent: updatedAgent });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // Lets either claimant in an active dispute submit their own supporting
  // evidence (text and/or a photo) for the admin to review during
  // resolution. Unauthenticated by necessity (claimants don't have
  // accounts/sessions), but gated the same way /api/claims/:id/pay is:
  // the caller must supply the phone number that matches one of the two
  // claims tied to this dispute, proving they're an actual party to it —
  // not just anyone who found the dispute ID.
  app.post('/api/disputes/:disputeId/evidence', reportLimiter, async (req, res) => {
    const disputeId = req.params.disputeId;
    const { claimId, phone, evidenceText, evidencePhotoBase64 } = req.body;

    if (!claimId || !phone) {
      return res.status(400).json({ error: 'Claim ID na nambari ya simu zinahitajika.' });
    }
    if ((!evidenceText || !evidenceText.trim()) && !evidencePhotoBase64) {
      return res.status(400).json({ error: 'Tafadhali toa maelezo au picha kama ushahidi.' });
    }

    try {
      const dispute = await db.getDispute(disputeId);
      if (!dispute) {
        return res.status(404).json({ error: 'Mzozo haukupatikana.' });
      }
      if (dispute.resolved_by || dispute.resolved_at) {
        return res.status(400).json({ error: 'Mzozo huu tayari umetatuliwa.' });
      }
      if (claimId !== dispute.claimant_1_claim_id && claimId !== dispute.claimant_2_claim_id) {
        return res.status(403).json({ error: 'Claim hii haihusiani na mzozo huu.' });
      }

      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }

      // Same phone-ownership proof pattern used in /api/claims/:id/pay —
      // normalize both sides to E.164 before comparing so '0712...',
      // '254712...', and '+254712...' for the same real number all match.
      const normalizedInput = toE164Kenyan(String(phone).replace(/\s+/g, ''));
      const normalizedOwner = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
      if (normalizedInput !== normalizedOwner) {
        return res.status(403).json({ error: 'Nambari ya simu haiendani na hii claim.' });
      }

      let evidencePhotoUrl: string | null = null;
      if (evidencePhotoBase64) {
        if (!isValidImageSignature(evidencePhotoBase64)) {
          return res.status(400).json({ error: 'Aina ya picha haikubaliki. Pakia JPEG, PNG, WEBP, au HEIC.' });
        }
        evidencePhotoUrl = await uploadBase64Image(evidencePhotoBase64, 'dispute-evidence');
      }

      const evidenceId = 'DEV-' + Math.random().toString(36).substr(2, 9).toUpperCase();
      const evidence = await db.createDisputeEvidence({
        id: evidenceId,
        dispute_id: disputeId,
        claim_id: claimId,
        submitted_by_phone: claim.owner_phone,
        evidence_text: evidenceText ? String(evidenceText).slice(0, 2000) : null,
        evidence_photo_url: evidencePhotoUrl,
      });

      res.json({ success: true, evidence, message: 'Ushahidi wako umewasilishwa kwa mafanikio. Msimamizi atauzingatia wakati wa kutatua mzozo.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // ============================================================
  // ADMIN DISPUTE ADJUDICATION
  // ============================================================
  // The on-demand evidence reader and the dispute-resolution action live in
  // routes/adminDisputes.ts so an HTTP integration test can mount the REAL
  // handlers behind the REAL middleware. Registered here, at the same point in
  // the middleware chain the inline routes previously occupied.
  registerAdminDisputeRoutes(app, { requireCurrentAdminSession, sendServerError });

  // (admin dispute resolution is served by registerAdminDisputeRoutes above)

  // ============================================================
  // CLAIMS ADMINISTRATION (READ-ONLY, PHASE 6E)
  // ============================================================
  // The bounded claims list and the single-claim detail record live in
  // routes/adminClaims.ts so an HTTP integration test can mount the REAL
  // handlers behind the REAL middleware. Registered here, immediately after the
  // admin dispute routes, so the middleware chain is identical to every other
  // /api/admin route: authenticateJWT -> requireCurrentAdminSession ->
  // permission guard -> inline role check.
  //
  // READ-ONLY: this module exposes GET handlers only. No claim mutation
  // endpoint is registered here — lifecycle changes remain the exclusive
  // province of transitionClaimStatus() and the existing admin actions.
  registerAdminClaimRoutes(app, { requireCurrentAdminSession, sendServerError });

  // ============================================================
  // LOST-REPORT ADMIN VISIBILITY (READ-ONLY, PHASE 11A)
  // ============================================================
  // The bounded lost-report list lives in routes/adminLostReports.ts so an HTTP
  // integration test can mount the REAL handler behind the REAL middleware. It
  // is registered immediately after the claims routes, so its middleware chain
  // is identical to every other /api/admin read:
  //   authenticateJWT -> requireCurrentAdminSession -> inline role check.
  //
  // canCreateClaim is injected (never re-implemented) so the possible-match
  // count a console shows is computed from exactly the items the public search
  // and the claim endpoint would each accept.
  //
  // READ-ONLY: GET only. No lost-report mutation endpoint is registered here.
  registerAdminLostReportRoutes(app, { requireCurrentAdminSession, sendServerError, canCreateClaim });


  // ============================================================
  // REFUND RECONCILIATION (A1 unknown-outcome operational workflow)
  // ============================================================
  // A refund whose real provider outcome is UNKNOWN (network/timeout during the
  // IntaSend call) is deliberately left with claim.status='refunding' and is
  // NEVER automatically retried. Those claims are safe from duplication but
  // were otherwise operationally orphaned: nothing surfaced them for the manual
  // provider check the A1 discipline requires. These three routes make them
  // discoverable and reconcile-able. Neither finalize nor revert ever triggers a
  // refund — finalize merely records an already-executed transfer as refunded;
  // revert records that the transfer did not execute.
  app.get('/api/admin/refund-reconciliation', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      const claims = await db.getRefundReconciliationClaims();
      const items = claims.map((c) => ({
        claimId: c.claimId,
        itemId: c.itemId,
        ownerPhone: maskPhoneForLog(c.ownerPhone),
        refundAmount: c.refundAmount,
        waitingSince: c.waitingSince,
        status: 'refunding',
        reason: 'unknown_provider_outcome',
      }));
      res.json({ success: true, items });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/refund-reconciliation/:claimId/finalize', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      const claimId = req.params.claimId;
      // Re-derive amount/recipient from the DB — never trust the client.
      const found = (await db.getRefundReconciliationClaims()).find((c) => c.claimId === claimId);
      if (!found || !found.ownerPhone) {
        return res.status(409).json({ error: 'Dai hili halipo katika hali ya refunding. / This claim is not awaiting refund reconciliation.' });
      }
      if (parseFloat(found.refundAmount) <= 0) {
        return res.status(409).json({ error: 'Kiasi cha kurejesha hakijaweza kubainishwa. / The refund amount could not be resolved.' });
      }
      const finalized = await db.finalizeClaimRefund(claimId, found.refundAmount, found.ownerPhone, adminIdentifier);
      if (!finalized) {
        return res.status(409).json({ error: 'Dai hili halikuwa tena katika hali ya refunding. / This claim is no longer in the refunding state.' });
      }
      res.json({ success: true, message: 'Refund imethibitishwa kuwa imefanyika na dai limekamilishwa. / Refund confirmed executed and claim finalized.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/refund-reconciliation/:claimId/revert', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      const claimId = req.params.claimId;
      const reason = (req.body && typeof req.body.reason === 'string' && req.body.reason.trim())
        ? req.body.reason.trim()
        : 'Admin confirmed with the provider that the refund was NOT executed';
      const reverted = await db.revertClaimRefundLock(claimId, reason, adminIdentifier);
      if (!reverted) {
        return res.status(409).json({ error: 'Dai hili halikuwa katika hali ya refunding. / This claim was not in the refunding state.' });
      }
      res.json({ success: true, message: 'Urejeshaji umehakikiwa kuwa haukufanyika na dai limefungwa. / Refund confirmed NOT executed and claim closed.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/items/:id/review', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const itemId = req.params.id;
    const {
      categoryId,
      ocrExtractedNumber,
      ocrExtractedName,
      isDescriptionOnly,
      description,
      assignedAgentId,
      reason,
    } = req.body;

    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

      // A manual agent (re)assignment must be accountable: who did it,
      // which agent it was moved from/to, and why. Require a reason
      // whenever an agent is actually being assigned here — matches the
      // same accountability standard already applied to stolen-property
      // flags and legal holds elsewhere in the admin API.
      if (assignedAgentId && (!reason || typeof reason !== 'string' || !reason.trim())) {
        return res.status(400).json({ error: 'Toa sababu ya kupanga Agent huyu. / A reason is required to assign an Agent.' });
      }

      const existingItem = assignedAgentId ? await db.getItem(itemId) : null;
      const oldAgentId = existingItem?.assigned_agent_id ?? null;

      // Calculate hashes and fuzzy names
      let documentNumberHash = null;
      let documentNameFuzzy = null;

      if (!isDescriptionOnly) {
        if (ocrExtractedNumber) {
          documentNumberHash = hashDocument(ocrExtractedNumber);
        }
        if (ocrExtractedName) {
          documentNameFuzzy = maskName(ocrExtractedName);
        }
      }

      const updates: any = {
        category_id: categoryId,
        ocr_extracted_number: isDescriptionOnly ? null : (ocrExtractedNumber || null),
        ocr_extracted_name: isDescriptionOnly ? null : (ocrExtractedName ? ocrExtractedName.toUpperCase() : null),
        document_number_hash: documentNumberHash,
        document_name_fuzzy: documentNameFuzzy,
        description: description || null,
        isDescriptionOnly: !!isDescriptionOnly,
        flaggedForReview: false, // cleared flaggedForReview so it becomes normally searchable!
      };

      if (assignedAgentId) {
        updates.assigned_agent_id = assignedAgentId;
        updates.agent_assignment_method = 'manual_override';
        updates.needs_manual_agent_reassignment = false;
        updates.agent_assignment_distance_km = null;
      }

      await db.adminUpdateItem(itemId, updates);

      if (assignedAgentId) {
        const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
        await db.logAudit(
          adminIdentifier,
          'MANUAL_AGENT_ASSIGNMENT',
          `Item ${itemId}: agent changed from ${oldAgentId || '(none)'} to ${assignedAgentId} by ${adminIdentifier}. Reason: ${reason.trim()}`
        );
      }

      res.json({ success: true, message: 'Item manual review completed and saved.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // Admin manual settlement release ("Release Now"): bypasses the dispute
  // window's settle_at check but still requires the claim to genuinely be
  // in 'pending_settlement' — it can never release a claim that's disputed,
  // already released, or never reached handover. Every use is audit-logged
  // with the acting admin's identity (see attemptSettlementRelease/
  // executeClaimSettlement), matching the doc's requirement that every
  // admin override be individually accountable.
  // Social media emergency stop (doc §86/87 "fail-safe: if uncertain, do not
  // publish"). Pausing takes effect immediately for every future post — it
  // does not retract anything already published.
  app.post('/api/admin/settings/social-publishing-pause', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      const { paused } = req.body;
      if (typeof paused !== 'boolean') {
        return res.status(400).json({ error: '"paused" lazima iwe true au false.' });
      }
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.setSetting('social_publishing_paused', paused ? 'true' : 'false', adminIdentifier);
      res.json({ success: true, message: paused ? 'Social media publishing paused platform-wide.' : 'Social media publishing resumed.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // P0: admin manual retry for social publications that the automatic
  // sweep (socialRetrySweep) deliberately never touches — 'unknown'
  // outcomes (might already have succeeded; auto-retry risks a duplicate)
  // and 'permanent_failure' outcomes (won't fix themselves; an admin has
  // presumably just fixed whatever caused it, e.g. rotated credentials).
  // Resets the row to 'retryable_failure' with an immediate next_attempt_at,
  // then retries it directly (found_notice only — see the SCOPE NOTE on
  // SocialService.retryFoundNoticePost for reunited_notice's limitation).
  app.post('/api/admin/social/:id/retry', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      const publicationId = req.params.id;
      const reset = await db.resetSocialPublicationForManualRetry(publicationId);
      if (!reset) {
        return res.status(404).json({ error: 'Social publication record haikupatikana.' });
      }
      if (reset.publication_type !== 'found_notice') {
        return res.status(400).json({
          error: `Manual retry is not yet implemented for publication_type '${reset.publication_type}' (only 'found_notice' is supported). See SocialService.retryFoundNoticePost's SCOPE NOTE.`
        });
      }
      const outcome = await SocialService.retryFoundNoticePost(reset.item_id, reset.platform);
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.logAudit(adminIdentifier, 'SOCIAL_PUBLICATION_MANUAL_RETRY', `Manually retried ${reset.platform} ${reset.publication_type} for item ${reset.item_id}. Outcome: ${outcome}.`);
      res.json({ success: true, outcome });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // EMERGENCY CONTROLS: generalizes the pattern above to the other five
  // scopes an admin needs to be able to freeze independently — see the
  // PAUSABLE_SCOPES comment. Kept as a separate route (rather than folding
  // 'social_publishing' in here and deleting the dedicated route above) so
  // nothing about the existing, already-wired-up social-pause admin UI
  // needs to change; both ultimately write the same underlying setting via
  // the same audited setSetting() call.
  app.post('/api/admin/settings/pause', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      const { scope, paused } = req.body;
      if (typeof paused !== 'boolean') {
        return res.status(400).json({ error: '"paused" lazima iwe true au false.' });
      }
      if (typeof scope !== 'string' || !(PAUSABLE_SCOPES as readonly string[]).includes(scope)) {
        return res.status(400).json({ error: `"scope" must be one of: ${PAUSABLE_SCOPES.join(', ')}.` });
      }
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.setSetting(pauseSettingKey(scope as PausableScope), paused ? 'true' : 'false', adminIdentifier);
      res.json({ success: true, scope, paused, message: `${scope} is now ${paused ? 'PAUSED' : 'resumed'} platform-wide.` });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // Lets any client (admin dashboard, or defensively the public frontend)
  // read current pause state for all six scopes in one call, rather than
  // guessing from a 403 on some unrelated action.
  app.get('/api/admin/settings/pause-status', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      const statuses = await Promise.all(
        PAUSABLE_SCOPES.map(async scope => [scope, await isPlatformOperationPaused(pauseSettingKey(scope))] as const)
      );
      res.json({ success: true, statuses: Object.fromEntries(statuses) });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/claims/:id/release-settlement', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const claimId = req.params.id;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      const won = await db.attemptSettlementRelease(claimId, true);
      if (!won) {
        return res.status(409).json({ error: 'Dai hili si tayari kwa kuachiliwa (labda tayari limekwisha au lina mzozo). / This claim is not eligible for release (it may already be settled or under dispute).' });
      }
      await db.logAudit(adminIdentifier, 'ADMIN_FORCE_RELEASE_SETTLEMENT', `Admin ${adminIdentifier} force-released settlement for claim ${claimId} ahead of the dispute window.`);
      const result = await executeClaimSettlement(claimId);
      if (!result.success) {
        return res.status(500).json({ error: result.message });
      }
      res.json({ success: true, message: result.message });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // --- STOLEN-PROPERTY STATE MACHINE (admin-only) ---
  // The platform does not adjudicate criminal guilt. These endpoints only
  // ever change an item's claimability/visibility; no public accusation is
  // ever attached to a person, and the underlying report is always routed
  // to the appropriate authorities outside the platform.
  app.post('/api/admin/items/:id/flag-stolen', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const itemId = req.params.id;
    const { reason } = req.body;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      if (!reason || typeof reason !== 'string' || !reason.trim()) {
        return res.status(400).json({ error: 'Toa sababu ya kuweka alama ya wizi. / A reason is required to flag an item as suspected stolen.' });
      }
      const item = await db.getItem(itemId);
      if (!item) return res.status(404).json({ error: 'Bidhaa haikupatikana.' });
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.setItemReviewStatus(itemId, 'suspected_stolen', reason.trim(), adminIdentifier);
      res.json({ success: true, message: 'Item flagged as suspected stolen. The claim flow is now blocked pending review.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/items/:id/legal-hold', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const itemId = req.params.id;
    const { reason } = req.body;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      if (!reason || typeof reason !== 'string' || !reason.trim()) {
        return res.status(400).json({ error: 'Toa sababu ya kuweka item hii chini ya uangalizi wa kisheria. / A reason is required to place an item under legal hold.' });
      }
      const item = await db.getItem(itemId);
      if (!item) return res.status(404).json({ error: 'Bidhaa haikupatikana.' });
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.setItemReviewStatus(itemId, 'legal_hold', reason.trim(), adminIdentifier);
      res.json({ success: true, message: 'Item placed under legal hold. No claim, payment, or handover can proceed while this is active.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/items/:id/clear-hold', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const itemId = req.params.id;
    const { reason } = req.body;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      const item = await db.getItem(itemId);
      if (!item) return res.status(404).json({ error: 'Bidhaa haikupatikana.' });
      if (item.status !== 'suspected_stolen' && item.status !== 'legal_hold') {
        return res.status(400).json({ error: `Item si chini ya uangalizi. Hali ya sasa: ${item.status}` });
      }
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.setItemReviewStatus(itemId, 'at_agent', reason && reason.trim() ? reason.trim() : 'Hold cleared after review.', adminIdentifier);
      res.json({ success: true, message: 'Hold cleared. Item is claimable again.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/items/:id/reject', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const itemId = req.params.id;
    const { reason } = req.body;

    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

      const item = await db.getItem(itemId);
      if (!item) {
        return res.status(404).json({ error: 'Bidhaa haikupatikana.' });
      }

      // The rejecting administrator is recorded explicitly, so the audit trail
      // answers "which admin rejected this item?" instead of "SYSTEM".
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.rejectItem(itemId, reason || 'Admin manual review rejection', adminIdentifier);
      res.json({ success: true, message: 'Item rejected successfully.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/reputations/:phone/clear', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const phone = req.params.phone;

    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

      // Record the acting administrator rather than the old hard-coded "ADMIN".
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.clearPhoneReputation(phone, adminIdentifier);
      res.json({ success: true, message: `Reputation flag manually cleared for ${phone}.` });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.get('/api/admin/payment-strikes', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

      const strikes = await db.getAllPaymentStrikes();
      res.json({ success: true, strikes });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/payment-strikes/:phone/clear', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const phone = req.params.phone;

    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

      await db.clearPaymentStrikes(phone);
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.logAudit(
        adminIdentifier,
        'ADMIN_CLEAR_PAYMENT_STRIKES',
        `Admin cleared payment strikes for phone number ${phone}`
      );
      res.json({ success: true, message: `Payment strikes manually cleared for ${phone}.` });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // 10B. ADMIN CATEGORIES MANAGEMENT
  app.get('/api/admin/categories', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      const categories = await db.getCategoriesWithUsage();
      res.json(categories);
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.post('/api/admin/categories', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }

      const {
        id, name_en, name_sw, total_fee, finder_share, agent_share, platform_share, is_sensitive_document,
        base_fee, complexity_fee, delay_fee, ceiling_percent, finder_pct, agent_pct, platform_pct, finder_reward_cap,
        elevated_review,
      } = req.body;

      if (!id || typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) {
        return res.status(400).json({ error: 'ID lazima iwe herufi ndogo na kistari (lowercase-kebab-case) pekee, na isikuwe tupu.' });
      }

      if (!name_en || typeof name_en !== 'string' || name_en.trim() === '' || !name_sw || typeof name_sw !== 'string' || name_sw.trim() === '') {
        return res.status(400).json({ error: 'Majina ya kategoria (English & Swahili) lazima yajazwe.' });
      }

      const existing = await db.getCategory(id);
      if (existing) {
        return res.status(400).json({ error: 'ID hii ya kategoria tayari ipo. Tafadhali tumia nyingine.' });
      }

      const numTotal = Number(total_fee);
      const numFinder = Number(finder_share);
      const numAgent = Number(agent_share);
      const numPlatform = Number(platform_share);

      if (isNaN(numTotal) || numTotal < 0 || isNaN(numFinder) || numFinder < 0 || isNaN(numAgent) || numAgent < 0 || isNaN(numPlatform) || numPlatform < 0) {
        return res.status(400).json({ error: 'Ada na migao yote lazima iwe nambari inayozidi au sawa na sifuri.' });
      }

      // Check sum exactly to 2 decimal places to avoid standard JS float issues
      const total = parseFloat(numTotal.toFixed(2));
      const sumShares = parseFloat((numFinder + numAgent + numPlatform).toFixed(2));
      if (total !== sumShares) {
        return res.status(400).json({
          error: 'Mgao (finder + agent + platform) lazima uwe sawa na jumla ya ada. / Split shares (finder + agent + platform) must sum to total fee exactly.'
        });
      }

      const newCat = await db.createCategory({
        id,
        name_en: name_en.trim(),
        name_sw: name_sw.trim(),
        total_fee: numTotal,
        finder_share: numFinder,
        agent_share: numAgent,
        platform_share: numPlatform,
        is_sensitive_document: is_sensitive_document !== false,
        base_fee: base_fee !== undefined ? Number(base_fee) : undefined,
        complexity_fee: complexity_fee !== undefined ? Number(complexity_fee) : undefined,
        delay_fee: delay_fee !== undefined ? Number(delay_fee) : undefined,
        ceiling_percent: ceiling_percent !== undefined ? Number(ceiling_percent) : undefined,
        finder_pct: finder_pct !== undefined ? Number(finder_pct) : undefined,
        agent_pct: agent_pct !== undefined ? Number(agent_pct) : undefined,
        platform_pct: platform_pct !== undefined ? Number(platform_pct) : undefined,
        finder_reward_cap: finder_reward_cap === null || finder_reward_cap === undefined || finder_reward_cap === '' ? null : Number(finder_reward_cap),
        elevated_review: !!elevated_review,
      });

      const adminUser = req.user?.username || req.user?.userId || 'admin';
      await db.logAudit(
        adminUser,
        'CATEGORY_CREATED',
        `Admin created category: id=${id}, name=${name_en}, total_fee=${total_fee}`
      );

      res.json({ success: true, category: newCat });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.put('/api/admin/categories/:id', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const { id } = req.params;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }

      const existing = await db.getCategory(id);
      if (!existing) {
        return res.status(404).json({ error: 'Kategoria haikupatikana.' });
      }

      const {
        name_en, name_sw, total_fee, finder_share, agent_share, platform_share, is_sensitive_document,
        base_fee, complexity_fee, delay_fee, ceiling_percent, finder_pct, agent_pct, platform_pct, finder_reward_cap,
        elevated_review, is_admin_modified,
      } = req.body;

      if (!name_en || typeof name_en !== 'string' || name_en.trim() === '' || !name_sw || typeof name_sw !== 'string' || name_sw.trim() === '') {
        return res.status(400).json({ error: 'Majina ya kategoria (English & Swahili) lazima yajazwe.' });
      }

      const numTotal = Number(total_fee);
      const numFinder = Number(finder_share);
      const numAgent = Number(agent_share);
      const numPlatform = Number(platform_share);

      if (isNaN(numTotal) || numTotal < 0 || isNaN(numFinder) || numFinder < 0 || isNaN(numAgent) || numAgent < 0 || isNaN(numPlatform) || numPlatform < 0) {
        return res.status(400).json({ error: 'Ada na migao yote lazima iwe nambari inayozidi au sawa na sifuri.' });
      }

      const total = parseFloat(numTotal.toFixed(2));
      const sumShares = parseFloat((numFinder + numAgent + numPlatform).toFixed(2));
      if (total !== sumShares) {
        return res.status(400).json({
          error: 'Mgao (finder + agent + platform) lazima uwe sawa na jumla ya ada. / Split shares (finder + agent + platform) must sum to total fee exactly.'
        });
      }

      const updatedCat = await db.updateCategory(id, {
        name_en: name_en.trim(),
        name_sw: name_sw.trim(),
        total_fee: numTotal,
        finder_share: numFinder,
        agent_share: numAgent,
        platform_share: numPlatform,
        is_sensitive_document: is_sensitive_document !== false,
        // BUG FIX: this used to be hardcoded `true` on every save, which
        // meant editing ANY field via the admin form — including the
        // Recovery Fee Engine's own base/complexity/delay/ceiling inputs —
        // silently pinned the category to its old flat total_fee forever,
        // making the engine fields dead the instant an admin touched them.
        // is_admin_modified must now be an explicit choice: "yes, ignore
        // the engine and use total_fee/finder_share/etc. verbatim" (true)
        // vs "no, keep computing the fee from base/complexity/delay/
        // ceiling" (false). If the request doesn't say, preserve whatever
        // was already set rather than silently flipping it.
        is_admin_modified: typeof is_admin_modified === 'boolean' ? is_admin_modified : existing.is_admin_modified,
        base_fee: base_fee !== undefined ? Number(base_fee) : undefined,
        complexity_fee: complexity_fee !== undefined ? Number(complexity_fee) : undefined,
        delay_fee: delay_fee !== undefined ? Number(delay_fee) : undefined,
        ceiling_percent: ceiling_percent !== undefined ? Number(ceiling_percent) : undefined,
        finder_pct: finder_pct !== undefined ? Number(finder_pct) : undefined,
        agent_pct: agent_pct !== undefined ? Number(agent_pct) : undefined,
        platform_pct: platform_pct !== undefined ? Number(platform_pct) : undefined,
        finder_reward_cap: finder_reward_cap === undefined ? undefined : (finder_reward_cap === null || finder_reward_cap === '' ? null : Number(finder_reward_cap)),
        elevated_review: elevated_review !== undefined ? !!elevated_review : undefined,
      });

      const adminUser = req.user?.username || req.user?.userId || 'admin';
      await db.logAudit(
        adminUser,
        'CATEGORY_UPDATED',
        `Admin updated category id=${id}, old total_fee=${existing.total_fee}, new total_fee=${total_fee}`
      );

      res.json({ success: true, category: updatedCat });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  app.delete('/api/admin/categories/:id', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const { id } = req.params;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }

      const existing = await db.getCategory(id);
      if (!existing) {
        return res.status(404).json({ error: 'Kategoria haikupatikana.' });
      }

      // Check count of items referencing this category_id
      const count = await db.getItemsCountForCategory(id);
      if (count > 0) {
        return res.status(409).json({
          error: `Haiwezi kufutwa: bidhaa ${count} zinatumia kategoria hii. / Cannot delete: ${count} items are using this category.`
        });
      }

      await db.deleteCategory(id);

      const adminUser = req.user?.username || req.user?.userId || 'admin';
      await db.logAudit(
        adminUser,
        'CATEGORY_DELETED',
        `Admin deleted category id=${id}`
      );

      res.json({ success: true, message: 'Kategoria imefutwa kikamilifu.' });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  // Vite integration as standard middleware for frontend serving
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    
    // SECURITY: this used to be a single `express.static(path.join(process
    // .cwd(), 'src'))` covering the ENTIRE src/ tree — meaning
    // src/server.ts (the full backend, including exact validation logic,
    // rate-limit thresholds, magic-byte checks, and every comment
    // explaining how the security model works), all of src/db/ (the ORM
    // schema and every query), and all of src/services/ (auth, payments,
    // storage, social) were served as plain-text over HTTP to anyone who
    // requested e.g. GET /src/server.ts in production. The stated intent
    // ("so that sourcemaps can load TSX/TS source files") only actually
    // needs the FRONTEND files a Vite/browser sourcemap can reference —
    // src/components, src/App.tsx, src/main.tsx, src/index.css,
    // src/types.ts. None of the backend-only directories are ever part of
    // the frontend bundle (confirmed: zero imports from src/components,
    // src/App.tsx, or src/main.tsx into src/db/ or src/services/), so they
    // have no legitimate reason to be reachable over HTTP at all. Denylist
    // checked before the static handler runs, returning a plain 404 (not
    // 403) so the response doesn't even confirm a backend layer exists.
    const srcBackendPathPrefixes = ['/src/server.ts', '/src/db/', '/src/services/', '/src/__tests__/'];
    app.use('/src', (req, res, next) => {
      if (srcBackendPathPrefixes.some(prefix => req.path === prefix || req.path.startsWith(prefix))) {
        return res.status(404).send('Not Found');
      }
      next();
    });

    // Serve the src directory statically in production so that sourcemaps can load TSX/TS source files
    app.use('/src', express.static(path.join(process.cwd(), 'src'), {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.tsx') || filePath.endsWith('.ts') || filePath.endsWith('.jsx')) {
          res.setHeader('Content-Type', 'text/javascript');
        }
      }
    }));
    
    app.get('*', (req, res) => {
      // If a sourcemap or browser requests a source file under /src, check if it exists on disk.
      // If it doesn't exist, send a graceful 200 OK with an explanatory comment to prevent HTTP 404 telemetry errors.
      //
      // TRAVERSAL GUARD (Phase 12 — REPRODUCED DEFECT). This branch used to test
      // the RAW request path with `req.path.startsWith('/src/')` and then resolve
      // it with `path.join(process.cwd(), req.path)`. path.join NORMALISES `..`,
      // so the path the code CHECKED was not the path it SERVED:
      //   req.path = '/src/../sql/schema.sql'
      //   '/src/../sql/schema.sql'.startsWith('/src/')  -> true       (guard passes)
      //   path.join(cwd, '/src/../sql/schema.sql')      -> <cwd>/sql/schema.sql
      //   existsSync(...) then res.sendFile(...)        -> file served
      // Measured: the same arithmetic resolves '/src/../.env' to '<cwd>/.env'.
      // Any non-dot file under the deployment directory was therefore readable
      // unauthenticated — sql/schema.sql, package.json, docs — and, because the
      // request path still began with '/src/', also src/db/**, src/services/** and
      // src/server.ts, which is precisely what the denylist above this block was
      // added to prevent. `express.static`/'send' reject '..' themselves, which is
      // why the hand-rolled branch is the one that had to be fixed rather than
      // relied upon. Only a path that RESOLVES to a real file INSIDE <cwd>/src is
      // served now; anything else falls through to the normal SPA/404 handling and
      // never touches the filesystem.
      if (req.path.startsWith('/src/')) {
        // Containment is delegated to utils/safeStaticPath.ts, which is unit-tested
        // against every hostile input this branch must reject: '..', '%2e%2e',
        // '\..\', a NUL byte, and the denylist re-entry '/src/../src/db/schema.ts'
        // (which resolves back INSIDE src/ and would otherwise re-enable the
        // backend-source disclosure the denylist exists to prevent).
        const srcRoot = path.join(process.cwd(), 'src');
        const resolvedSource = resolveContainedSourcePath(srcRoot, req.path);
        if (resolvedSource && fs.existsSync(resolvedSource) && fs.statSync(resolvedSource).isFile()) {
          if (resolvedSource.endsWith('.tsx') || resolvedSource.endsWith('.ts') || resolvedSource.endsWith('.jsx')) {
            res.setHeader('Content-Type', 'text/javascript');
          }
          return res.sendFile(resolvedSource);
        }
        if (resolvedSource) {
          res.setHeader('Content-Type', 'text/javascript');
          return res.send(`/* Source file ${path.basename(resolvedSource)} is not included in the production build */`);
        }
        // A path that does not resolve inside src/ deliberately falls through to
        // the normal SPA/404 handling below and never touches the filesystem.
      }

      // If the request path has an extension, do not fall back to index.html; return 404 Not Found
      if (path.extname(req.path)) {
        return res.status(404).send('Not Found');
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Register Sentry Error Handler AFTER all route handlers but BEFORE app.listen
  if (isSentryBackendEnabled) {
    Sentry.setupExpressErrorHandler(app);
    console.log('[SENTRY] Sentry Express error handler registered.');
  }

  // ============================================================
  // PHASE 12 — FINAL JSON API ERROR HANDLER
  // ============================================================
  // REPRODUCED DEFECT (found by probing every registered route against the real
  // server with a malformed JSON body): with no error-handling middleware
  // registered, a body-parser failure fell through to Express's DEFAULT error
  // handler, which answered 400 with an HTML page whose <pre> contained the raw
  // parser message AND — outside production — the complete server-side stack
  // trace with absolute filesystem paths, e.g.
  //   SyntaxError: Expected property name or '}' in JSON at position 1
  //     at JSON.parse (<anonymous>)
  //     at parse (C:\...\node_modules\body-parser\lib\types\json.js:96:19)
  //     at read.js:128:18 ... raw-body/index.js:287:7 ...
  // Measured unauthenticated on /api/customer/register, /api/items/report,
  // /api/claims/lookup and /api/webhooks/intasend. Because body parsing runs
  // BEFORE routing, EVERY JSON endpoint was reachable this way, and an API must
  // never answer with HTML or with internal parser/path detail.
  //
  // This is the ONE place that converts an error which escaped a route (or never
  // reached one, like the parse failure above) into the JSON contract. It
  // deliberately never echoes err.message to the client — the same rule
  // sendServerError already applies to route-level failures. Full detail is
  // logged server-side; client-error noise stays a single concise line so a
  // malformed-body request cannot flood the log with stacks.
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);

    // Only /api/* gets this contract. Non-API page requests keep the SPA's
    // existing fallback behaviour.
    if (!String(req.path || '').startsWith('/api/')) return next(err);

    const type = err?.type;
    const status =
      type === 'entity.parse.failed' ? 400
      : type === 'entity.too.large' ? 413
      : type === 'encoding.unsupported' ? 415
      : (typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500);

    // 5xx = a genuine server fault: log the stack. 4xx = the caller's malformed
    // request: one line, no stack, so it cannot be used to flood the logs.
    if (status >= 500) {
      console.error(`[API_ERROR_HANDLER] ${req.method} ${String(req.path)} -> ${status}`, err?.stack || err);
    } else {
      console.warn(`[API_ERROR_HANDLER] ${req.method} ${String(req.path)} -> ${status} (${type || err?.name || 'Error'})`);
    }

    const message =
      status === 400 ? 'Ombi lako halikuweza kusomwa. Tafadhali angalia muundo wa data. / Your request could not be read. Please check the data format.'
      : status === 413 ? 'Ombi lako ni kubwa kupita kiasi. / Your request is too large.'
      : status === 415 ? 'Muundo wa data hautumiki. / Unsupported data format.'
      : 'Hitilafu imetokea upande wa seva. Tafadhali jaribu tena baadaye. / A server error occurred. Please try again later.';

    return res.status(status).json({ error: message });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[RETURN4ME SERVER] Running on http://0.0.0.0:${PORT}`);
    // Start background sweep for payment window expiry every 60 seconds
    setInterval(expireStaleClaims, 60000);
    // Start background sweep for due settlements (dispute window closed) every 5 minutes
    setInterval(releaseDueSettlements, 5 * 60 * 1000);
    // Start background sweep for retryable social-publication failures every 5 minutes
    setInterval(socialRetrySweep, 5 * 60 * 1000);
    // Start background sweep for expired handover-evidence photos once a day
    // (multi-year retention window — no need to check more often)
    setInterval(handoverEvidenceRetentionSweep, 24 * 60 * 60 * 1000);
  });
}

// --- SECURE HELPERS ---

// Claim IDs were previously 4 digits ('CLM-1000'..'CLM-9999', ~9,000
// possible values) with no collision handling — a birthday-paradox
// collision (two random draws landing on the same 4-digit code, causing a
// legitimate owner's claim submission to fail with a DB primary-key error)
// becomes likely after only ~100-150 claims have ever been created, which
// is nowhere near the platform's national-scale ambitions. Widened to 6
// digits (900,000 possible values, collision-likely only after tens of
// thousands of claims) and wrapped in a check-and-retry loop so that even
// a rare collision is silently avoided instead of surfacing as a 500 to
// the owner mid-submission.
async function generateUniqueClaimId(maxAttempts: number = 5): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = 'CLM-' + Math.floor(100000 + Math.random() * 900000).toString();
    const existing = await db.getClaim(candidate);
    if (!existing) return candidate;
    console.warn(`[CLAIM ID GENERATION] Collision on ${candidate}, retrying (attempt ${attempt + 1}/${maxAttempts}).`);
  }
  // Extremely unlikely fallback: timestamp-suffixed to guarantee uniqueness.
  return 'CLM-' + Date.now().toString(36).toUpperCase();
}

async function checkClaimExpiry(claim: any): Promise<any> {
  if (claim.status === 'pending_payment' && claim.agent_confirmed_at) {
    const confirmedTime = new Date(claim.agent_confirmed_at).getTime();
    if (Date.now() - confirmedTime > 15 * 60 * 1000) {
      console.log(`[INLINE-CHECK] Claim ${claim.id} payment window expired. Expiring now.`);
      try {
        const expired = await db.expirePendingPaymentClaim(claim.id);
        if (expired) {
          await db.recordPaymentStrike(claim.owner_phone);
        }
        // Get updated claim (authoritative state — the claim may have been
        // confirmed paid by a webhook that won the expiry race while we read).
        const updated = await db.getClaim(claim.id);
        if (updated) {
          return updated;
        }
      } catch (err) {
        console.error("Failed to expire claim inline:", err);
      }
    }
  }
  return claim;
}

// P0: automatic retry sweep for social publications. Only ever picks up
// 'retryable_failure' rows past their scheduled next_attempt_at — never
// 'unknown' (an unknown outcome might already have succeeded on the
// provider's side; auto-retrying risks a duplicate post — see the
// PublicationOutcome comment in services/social.ts) and never
// 'permanent_failure' (won't succeed on retry without a human fixing
// configuration first). Both of those are left for admin manual retry
// instead (POST /api/admin/social/:id/retry). Only 'found_notice' rows are
// retried here — see the SCOPE NOTE on SocialService.retryFoundNoticePost.
// P1: data retention (docs/DATA_RETENTION_POLICY.md). Purges handover
// evidence photos past their documented retention window (default 2
// years past a claim's release) — a real, concrete implementation of the
// "automated deletion/anonymization" the policy calls for, rather than
// leaving the whole thing as a document nobody enforces. Deliberately
// narrow in scope: only handover photos, only for status='released'
// claims (a disputed/held claim is never eligible regardless of age —
// see the comment on getClaimsWithExpiredHandoverPhotos). The other
// categories in the policy document remain documented-but-not-yet-
// automated by design; each needs its own scoped sweep and its own
// tests, the same way this one was built, rather than one large
// unreviewed sweep across every category at once.
const HANDOVER_PHOTO_RETENTION_DAYS = 730; // 2 years — see docs/DATA_RETENTION_POLICY.md
async function handoverEvidenceRetentionSweep() {
  try {
    const expiredClaimIds = await db.getClaimsWithExpiredHandoverPhotos(HANDOVER_PHOTO_RETENTION_DAYS);
    for (const claimId of expiredClaimIds) {
      try {
        await db.purgeHandoverPhoto(claimId);
        await db.logAudit('SYSTEM', 'HANDOVER_PHOTO_RETENTION_PURGE', `Claim ${claimId}: handover evidence photo purged — past its ${HANDOVER_PHOTO_RETENTION_DAYS}-day retention window per data retention policy.`);
      } catch (err) {
        console.error(`[HANDOVER PHOTO RETENTION SWEEP] Failed to purge photo for claim ${claimId}:`, err);
      }
    }
    if (expiredClaimIds.length > 0) {
      console.log(`[HANDOVER PHOTO RETENTION SWEEP] Purged ${expiredClaimIds.length} expired handover photo(s).`);
    }
  } catch (err) {
    console.error('[HANDOVER PHOTO RETENTION SWEEP] Sweep failed:', err);
  }
}

async function socialRetrySweep() {
  try {
    const due = await db.getSocialPublicationsDueForRetry();
    for (const row of due) {
      if (row.publication_type !== 'found_notice') {
        console.log(`[SOCIAL RETRY SWEEP] Skipping ${row.platform} ${row.publication_type} for item ${row.item_id} — automatic retry is only implemented for found_notice (see retryFoundNoticePost).`);
        continue;
      }
      console.log(`[SOCIAL RETRY SWEEP] Retrying ${row.platform} found_notice for item ${row.item_id} (attempt ${row.attempt_count + 1}).`);
      try {
        await SocialService.retryFoundNoticePost(row.item_id, row.platform);
      } catch (err) {
        console.error(`[SOCIAL RETRY SWEEP] Unexpected error retrying ${row.platform} for item ${row.item_id}:`, err);
      }
    }
  } catch (err) {
    console.error('[SOCIAL RETRY SWEEP] Sweep failed:', err);
  }
}

async function expireStaleClaims() {
  try {
    const allClaims = await db.getClaims();
    const now = Date.now();
    for (const claim of allClaims) {
      if (claim.status === 'pending_payment' && claim.agent_confirmed_at) {
        const confirmedTime = new Date(claim.agent_confirmed_at).getTime();
        if (now - confirmedTime > 15 * 60 * 1000) {
          console.log(`[SWEEP] Claim ${claim.id} payment window expired. Transitioning status and recording strike for ${maskPhoneForLog(claim.owner_phone)}`);
          try {
            const expired = await db.expirePendingPaymentClaim(claim.id);
            if (expired) {
              await db.recordPaymentStrike(claim.owner_phone);
            }
          } catch (err) {
            console.error(`Failed to expire claim ${claim.id} in sweep:`, err);
          }
        }
      }
    }
  } catch (err) {
    console.error("Error in expireStaleClaims sweep:", err);
  }
}

/**
 * Actually moves money for a claim that has already won the
 * attemptSettlementRelease() lock (status='releasing'): sends the real
 * IntaSend split disbursement, then finalizes the ledger/claim on success,
 * or reverts the lock on failure so a later sweep/retry can try again. Used
 * by both the automatic settlement sweep and the admin manual-release
 * endpoint, so both paths share one, single source of truth for how a
 * settlement is actually executed.
 */
async function executeClaimSettlement(claimId: string): Promise<{ success: boolean; message: string }> {
  if (await isPlatformOperationPaused(pauseSettingKey('payouts'))) {
    // The claim has already won the attemptSettlementRelease() lock
    // (status='releasing') by the time this function is called — reverting
    // it back to 'pending_settlement' here (the same mechanism already used
    // below for "still outstanding, retry later") is what keeps this safe
    // to call from both the automatic sweep and the admin manual-release
    // endpoint: neither path moves any real money while paused, and the
    // claim isn't left stuck in 'releasing' with nothing to unstick it.
    await db.revertSettlementRelease(claimId);
    await db.logAudit('SYSTEM', 'SETTLEMENT_SKIPPED_PAYOUTS_PAUSED', `Claim ${claimId}: settlement release skipped — payouts are paused platform-wide. Reverted to pending_settlement for retry once resumed.`);
    return { success: false, message: 'Payouts are currently paused platform-wide by an administrator. This claim remains in pending_settlement and will be retried automatically once resumed.' };
  }

  const claim = await db.getClaim(claimId);
  if (!claim) return { success: false, message: 'Claim not found.' };
  const item = await db.getItem(claim.item_id);
  if (!item) return { success: false, message: 'Item not found.' };
  const agent = item.assigned_agent_id ? await db.getAgent(item.assigned_agent_id) : null;
  if (!agent) return { success: false, message: 'Agent not found.' };
  const category = item.category_id ? await db.getCategory(item.category_id) : null;
  if (!category) return { success: false, message: 'Category not found.' };

  let finderShare = parseFloat(String(category.finder_share));
  let agentShare = parseFloat(String(category.agent_share));
  if (item.locked_finder_share !== undefined && item.locked_finder_share !== null && item.locked_agent_share !== undefined && item.locked_agent_share !== null) {
    const lockedFinder = Number(item.locked_finder_share);
    const lockedAgent = Number(item.locked_agent_share);
    if (!isNaN(lockedFinder) && !isNaN(lockedAgent) && lockedFinder >= 0 && lockedAgent >= 0) {
      finderShare = lockedFinder;
      agentShare = lockedAgent;
    }
  }

  // Only pay recipients whose ledger row is still 'pending'. This is what
  // makes a retry safe: if the finder's payout already succeeded on a
  // previous attempt but the agent's failed, this run sends money to the
  // agent ONLY — never re-sending to the finder, which would be a
  // duplicate payment.
  const claimLedgerRows = await db.getLedgerEntriesForClaim(claimId);
  const finderRow = claimLedgerRows.find(r => r.type === 'finder_payout');
  const agentRow = claimLedgerRows.find(r => r.type === 'agent_payout');

  const outstanding: Array<{ destination: string; amount: number; payoutMethodType?: string; recipientType: 'finder' | 'agent' }> = [];
  if (finderRow && finderRow.status === 'pending') {
    outstanding.push({ destination: item.finder_phone, payoutMethodType: 'Personal M-Pesa', amount: finderShare, recipientType: 'finder' });
  }
  if (agentRow && agentRow.status === 'pending') {
    outstanding.push({ destination: agent.mpesa_till_or_paybill, payoutMethodType: agent.payout_method_type || 'Till Number', amount: agentShare, recipientType: 'agent' });
  }

  if (outstanding.length > 0) {
    const payoutResult = await PaymentService.triggerIntasendPayout(claimId, outstanding);

    for (const result of payoutResult.results) {
      const row = result.recipientType === 'finder' ? finderRow : agentRow;
      if (!row) continue; // shouldn't happen — outstanding was built from these same rows
      await db.recordPayoutAttempt(row.id, {
        status: result.status,
        providerBatchId: payoutResult.batchId,
        providerTransactionId: result.providerTransactionId,
        failureReason: result.status === 'failed' ? 'IntaSend reported this transaction as failed.' : result.status === 'unknown' ? 'Network/timeout error contacting IntaSend — outcome unconfirmed.' : null,
      });
      if (result.status === 'failed' || result.status === 'unknown') {
        await db.logAudit('SYSTEM', 'PAYOUT_NOT_CONFIRMED', `Claim ${claimId}: ${result.recipientType} payout status '${result.status}'. Ledger row ${row.id} left pending for retry/reconciliation.`);
      }
    }
  }

  // Re-check actual state after recording results — never assume the
  // outcome, re-fetch it.
  const refreshedLedgerRows = await db.getLedgerEntriesForClaim(claimId);
  const stillOutstanding = refreshedLedgerRows.find(
    r => (r.type === 'finder_payout' || r.type === 'agent_payout') && r.status !== 'completed'
  );

  if (stillOutstanding) {
    await db.revertSettlementRelease(claimId);
    return {
      success: false,
      message: `Settlement partially processed — ${stillOutstanding.type} is '${stillOutstanding.status}'. Claim reverted to pending_settlement; the next sweep will retry only the outstanding payout(s).`,
    };
  }

  const finalized = await db.finalizeSettlement(claimId);
  if (!finalized.success) {
    // Deliberately NOT reverting here — the real M-Pesa payouts already went
    // out (every finder_payout/agent_payout row is confirmed 'completed' at
    // this point). Leaving the claim in 'releasing' keeps it locked and
    // flags it for manual admin reconciliation rather than risking a
    // duplicate payout via an automatic retry.
    await db.logAudit('SYSTEM', 'SETTLEMENT_FINALIZE_DB_FAILURE_AFTER_PAYOUT', `Claim ${claimId}: all payouts confirmed but finalizeSettlement failed: ${finalized.message}. Left in 'releasing' — requires manual admin review.`);
    return { success: false, message: 'Payouts confirmed but recording the final settlement failed. Flagged for manual admin review.' };
  }
  return finalized;
}

// Runs periodically: finds every claim whose dispute window has closed
// (status='pending_settlement' and settle_at <= now) and, one at a time,
// atomically claims the release lock and executes the real payout. A claim
// that was disputed or admin-frozen during its window is no longer in
// 'pending_settlement' by the time this runs, so it's simply never selected
// — no special-case skip logic needed.
async function releaseDueSettlements() {
  try {
    const due = await db.getClaimsDueForSettlement();
    for (const claim of due) {
      try {
        const won = await db.attemptSettlementRelease(claim.id, false);
        if (!won) continue; // lost the CAS race (e.g. an admin already force-released it) — fine, skip
        const result = await executeClaimSettlement(claim.id);
        if (!result.success) {
          console.error(`[SETTLEMENT SWEEP] Claim ${claim.id} settlement failed: ${result.message}`);
        } else {
          console.log(`[SETTLEMENT SWEEP] Claim ${claim.id} settled successfully.`);
        }
      } catch (err) {
        console.error(`[SETTLEMENT SWEEP] Error settling claim ${claim.id}:`, err);
      }
    }
  } catch (err) {
    console.error('Error in releaseDueSettlements sweep:', err);
  }
}

// Social-media emergency stop: fails SAFE. If the setting can't be read at
// all (DB hiccup, etc.), we treat that the same as "paused" — never publish
// when uncertain, per the doc's fail-safe principle. Only an explicit,
// successfully-read 'false' allows publishing to proceed.
/**
 * CENTRAL CLAIMABILITY RULE — the single source of truth for "can this item
 * currently be claimed." Used by both the public search endpoint (to decide
 * what's even shown) and claim submission (to independently re-verify —
 * never trust that something visible in a search result is still
 * claimable by the time the request arrives). Do not duplicate this logic
 * inline anywhere else; if a new claimability condition is needed, add it
 * here once.
 */
  // Section: historical vs. active claims. A claim in one of these statuses
  // is a CLOSED attempt — an audit/history record, NOT an active reservation
  // on the item. It must never count as a "competing claimant" below:
  // payment expiry (payment_window_expired) in particular is simple
  // abandonment, and the item's own status ('at_agent') already reflects
  // that it is physically back in the agent's custody and claimable again.
  // Treating an expired payment attempt as a live rival claimant used to
  // file a bogus dispute the moment the legitimate owner (or anyone else)
  // tried again — payment expiry is not a dispute and not another claimant.
  //
  // The set itself now lives in config/claimStatuses.ts (moved verbatim in
  // Phase 2) so the customer dashboard's Active/History split groups claims by
  // exactly this rule instead of keeping a second, drifting copy.

async function canCreateClaim(item: FoundItem, preFetchedDisputes?: Dispute[]): Promise<{ allowed: boolean; reason: string }> {
  if (!item) return { allowed: false, reason: 'not_found' };

  // A Finder's report is NOT a verified found item — only an Agent's
  // physical inspection makes it one. 'at_agent' is the only status that
  // represents a physically verified, currently-in-custody item; every
  // other status (awaiting_dropoff, claimed, expired, rejected,
  // suspected_stolen, legal_hold) means "not currently claimable" for a
  // different reason, but the practical rule is the same: only 'at_agent'
  // is eligible.
  if (item.status !== 'at_agent') {
    if (item.status === 'suspected_stolen' || item.status === 'legal_hold') {
      return { allowed: false, reason: item.status };
    }
    if (item.status === 'claimed') {
      return { allowed: false, reason: 'already_recovered' };
    }
    if (item.status === 'expired' || item.status === 'rejected') {
      return { allowed: false, reason: 'no_longer_available' };
    }
    // awaiting_dropoff, or any other pre-verification status.
    return { allowed: false, reason: 'not_physically_verified' };
  }

  if (item.flaggedForReview) {
    return { allowed: false, reason: 'flagged_for_review' };
  }

  // Section 5 / third-claimant rule: at most one UNRESOLVED ownership
  // dispute per item, and while one is open, no new claims of any kind —
  // not just a duplicate from a claimant who's already involved. Without
  // this, a third claimant could slip in after the first two already
  // entered 'disputed' status, since neither of those two claims counts as
  // "active" anymore under the earlier duplicate-detection check alone.
  //
  // PERFORMANCE: a caller iterating many items (the search route) passes
  // preFetchedDisputes from one batched db.getDisputesByItemIds() call
  // instead of every item triggering its own db.getDisputesByItem() query
  // — see the comment on that method. Single-item callers (e.g. /pay,
  // /claims/submit) omit it and this falls back to the original per-item
  // query, unchanged.
  const disputes = preFetchedDisputes ?? await db.getDisputesByItem(item.id);
  const hasUnresolvedDispute = disputes.some(d => !d.resolved_at);
  if (hasUnresolvedDispute) {
    return { allowed: false, reason: 'unresolved_dispute' };
  }

  return { allowed: true, reason: 'ok' };
}

// Shared bilingual error messages for canCreateClaim() reasons — used
// wherever a claimability check is enforced, so wording doesn't drift
// between call sites.
function claimabilityErrorMessage(reason: string): string {
  const messages: Record<string, string> = {
    not_physically_verified: 'Bidhaa hii bado haijathibitishwa kimwili na Agent. Tafadhali subiri uthibitisho kabla ya kudai. / This item has not yet been physically verified by an Agent. Please wait for verification before claiming.',
    suspected_stolen: 'Bidhaa hii inahitaji uthibitisho wa ziada kabla ya kudai. Tafadhali wasiliana na usaidizi. / This item requires additional verification before it can be claimed. Please contact support.',
    legal_hold: 'Bidhaa hii inahitaji uthibitisho wa ziada kabla ya kudai. Tafadhali wasiliana na usaidizi. / This item requires additional verification before it can be claimed. Please contact support.',
    flagged_for_review: 'Bidhaa hii bado iko chini ya ukaguzi. Tafadhali jaribu tena baadaye. / This item is still under review. Please try again later.',
    already_recovered: 'Bidhaa hii tayari imedaiwa na kurejeshwa. / This item has already been claimed and recovered.',
    no_longer_available: 'Bidhaa hii haipatikani tena. / This item is no longer available.',
    unresolved_dispute: 'Bidhaa hii ina mzozo wa umiliki ambao bado haujatatuliwa. Hakuna hatua zaidi zinazokubaliwa hadi utatuzi ukamilike. / This item has an unresolved ownership dispute. No further action is accepted until it is resolved.',
    not_found: 'Bidhaa inayotafutwa haikupatikana.',
  };
  return messages[reason] || 'Bidhaa hii haiwezi kudaiwa kwa sasa.';
}

async function isSocialPublishingPaused(): Promise<boolean> {
  return isPlatformOperationPaused('social_publishing_paused');
}

// EMERGENCY CONTROLS: before this, 'social_publishing_paused' was the only
// platform-wide pause switch that existed. There was no way for an admin to
// stop new reports, new claims, payment initiation, payout disbursement, or
// handovers without touching code/infrastructure — a real gap for the one
// class of situation (suspected fraud ring, a payment-provider incident, a
// bug actively causing harm) where an admin needs to freeze a specific slice
// of the platform in seconds, not by disabling the whole app. Six
// independent scopes, each its own platform_settings row (via the same
// setSetting()/getSetting() pair — audited, admin-only, fail-safe already
// used for social publishing), so pausing one never accidentally pauses an
// unrelated flow, and each is a single boolean an admin can flip back.
const PAUSABLE_SCOPES = ['reports', 'claims', 'payments', 'payouts', 'handovers', 'social_publishing'] as const;
type PausableScope = typeof PAUSABLE_SCOPES[number];

function pauseSettingKey(scope: PausableScope): string {
  return `${scope}_paused`;
}

async function isPlatformOperationPaused(settingKey: string): Promise<boolean> {
  try {
    const value = await db.getSetting(settingKey);
    return value === 'true';
  } catch (err) {
    // Same fail-safe rule as the original social-publishing check this
    // generalizes from: if we can't even determine whether an operation is
    // paused, treat it as paused rather than silently letting a
    // report/claim/payment/payout/handover through unchecked.
    console.error(`[EMERGENCY PAUSE CHECK] Failed to read setting '${settingKey}' — failing safe (treating as paused):`, err);
    return true;
  }
}

const PAUSED_MESSAGES: Record<PausableScope, string> = {
  reports: 'Uwasilishaji wa ripoti mpya umesimamishwa kwa muda na msimamizi. / New item reports are temporarily paused by an administrator. Please try again shortly.',
  claims: 'Uwasilishaji wa madai mapya umesimamishwa kwa muda na msimamizi. / New claims are temporarily paused by an administrator. Please try again shortly.',
  payments: 'Malipo yamesimamishwa kwa muda na msimamizi. / Payments are temporarily paused by an administrator. Please try again shortly.',
  payouts: 'Malipo ya wakala/mtafutaji yamesimamishwa kwa muda na msimamizi. / Agent/Finder payouts are temporarily paused by an administrator.',
  handovers: 'Ukabidhi wa bidhaa umesimamishwa kwa muda na msimamizi. / Item handovers are temporarily paused by an administrator. Please try again shortly.',
  social_publishing: 'Uchapishaji wa mitandao ya kijamii umesimamishwa kwa muda na msimamizi. / Social publishing is temporarily paused by an administrator.',
};


// (Phase 9A: hashDocument moved to services/documentHash.ts so the found-item
// and lost-item report routes share ONE hashing implementation. It is imported
// at the top of this file.)

function isValidImageSignature(base64Str: string): boolean {
  try {
    if (!base64Str) return false;
    const base64Data = base64Str.includes(';base64,') ? base64Str.split(';base64,')[1] : base64Str;
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length < 4) return false;

    // JPEG
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return true;
    }
    // PNG
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return true;
    }
    // WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WEBP') {
      return true;
    }
    // HEIC
    if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
      const brand = buffer.toString('ascii', 8, 12).toLowerCase();
      if (brand.startsWith('hei') || brand.startsWith('hev') || brand.startsWith('mif') || brand.startsWith('msf')) {
        return true;
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

function maskName(name: string): string {
  const parts = name.split(/\s+/);
  const maskedParts = parts.map(part => {
    if (part.length <= 2) return part;
    return part[0] + '*'.repeat(part.length - 2) + part[part.length - 1];
  });
  return maskedParts.join(' ');
}

// (Phase 7B: getRoughArea moved to services/publicItemView.ts so the public
// search route and the public item-detail route share one implementation.)

// Fire up full-stack server
startServer().catch(err => {
  console.error('[CRITICAL] Return4me server boot failed:', err);
});
