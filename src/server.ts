import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { fileURLToPath } from 'url';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { createServer as createViteServer } from 'vite';
import { db, FoundItem, Claim, Agent, Dispute } from './db/database';
import { pool, ensureSchemaUpToDate, isDatabaseConnectionError } from './db/index';
import { AuthService, authenticateJWT, generateToken, verifyToken, toE164Kenyan, hashCode, timingSafeEqualHex, maskPhoneForLog, isAgentActionable, isAdminSessionCurrent, SMS_UNAVAILABLE_MESSAGE } from './services/auth';
import { AgentMatchingService, geocodeAddress } from './services/agent';
import { geocodeReverse } from './services/geocoding/index.ts';
import {
  renderSendPaymentReceivedEmail,
  renderSendAgentPaymentConfirmedEmail,
  renderSendAdminTransactionLogEmail,
} from './services/email';
// N5 â€” the canonical notification boundary. Both account-activation emails now
// go through it, so each send is recorded in notification_events before it
// happens. Nothing else is migrated in N5; N6/N7/N8/N9 own the remaining
// call sites.
import { NotificationService, buildNotificationIdempotencyKey } from './services/notificationService';
import { newSmsIssuanceId, sendSmsNotification } from './services/smsNotification';
import { smsRateLimit } from './services/smsRateLimit';
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
  // N3 â€” email activation gate.
  CUSTOMER_ACTIVATION_TTL_MS,
  // N4 â€” agent email activation. Shares the activation URL conventions and the
  // 24h lifetime, but is a SEPARATE builder and a separate endpoint: an agent
  // link and a customer link mean different things and must never be
  // interchangeable.
  AGENT_ACTIVATION_TTL_MS,
  buildAgentActivationUrl,
  buildAgentActivationEmailHtml,
  buildCustomerActivationUrl,
  buildCustomerActivationEmailHtml,
  customerOtpLastSent,
  toSafeCustomer,
  generateCustomerOtp,
  generateSecureId,
  setCustomerSessionCookie,
  clearCustomerSessionCookie,
  requireCustomerAuth,
  // Phase 7C.3 / F11 â€” optional (non-terminating) session resolution and the
  // additive post-verification journey link. See services/customerAuth.ts.
  resolveOptionalCustomer,
  linkVerifiedClaimToCustomer,
} from './services/customerAuth';
// BATCH 3 - in-app customer notification producers for the authoritative claim
// and payment transitions in this file. In-app only: no delivery, no provider.
import {
  producePaymentReceived,
  produceClaimAutoRejectedFirstPayment,
  produceClaimComplete,
  produceRefundComplete,
} from './services/claimNotificationProducers';

// Phase 7C.7 (R1): isPickupEligibleClaimStatus is the canonical pickup-eligibility
// predicate introduced by Phase 7C.5. /api/claims/lookup now gates its agent
// disclosure with it so that route cannot drift from routes/publicItems.ts.
import { INACTIVE_CLAIM_STATUSES, isPickupEligibleClaimStatus, CLAIM_UNAVAILABLE_MESSAGE } from './config/claimStatuses';
import { toOwnerSafeAgentView, toOwnerSafeClaimView, toOwnerSafeItemView } from './services/ownerSafeViews';
// Phase 7B: the shared public (unauthenticated) item read model. getRoughArea
// moved here from this file so the public search route and the new public
// item-detail route cannot drift apart in how they coarsen an agent address.
import { toPublicItemView, getRoughArea } from './services/publicItemView';
import { toAdminSafeAgentView, toAdminSafeItemView, toAdminSafeDisputeView, toAdminSafeAgentDocumentsView, toAdminSafeLedgerEntry, toAdminSafeAuditLog } from './services/adminSafeViews';
import { registerCustomerClaimRoutes } from './routes/customerClaims';
// Batch 1: the customer notification USER layer. Registered separately from
// server.ts for the same reason as the other route modules â€” this file boots the
// application at import time and cannot be imported by a test.
import { registerCustomerNotificationRoutes } from './routes/customerNotifications';
// Batch 2: customer account data and session security (H9, H10, G1, G2, G3).
// Registered separately for the same reason as the other route modules â€” this
// file boots the application at import time and cannot be imported by a test.
import { registerCustomerAccountRoutes } from './routes/customerAccount';
import { registerAdminDisputeRoutes } from './routes/adminDisputes';
// PHASE 16.1 BATCH 1A â€” the public category list and the admin category-creation
// action, extracted so the admin-create â†’ GET /api/categories propagation chain
// can be exercised over real HTTP (same pattern as routes/adminDisputes.ts).
import { registerPublicCategoryRoutes, registerAdminCategoryRoutes } from './routes/categories';
import { registerAdminClaimRoutes } from './routes/adminClaims';
import { registerAdminLostReportRoutes } from './routes/adminLostReports';
import { registerPublicItemRoutes } from './routes/publicItems';
// Phase 9A: the customer lost-item reporting routes. Registered the same way as
// the customer-claim routes below so an HTTP test can mount the real handlers.
import { registerLostReportRoutes } from './routes/lostReports';
// The canonical document-number hasher. Moved out of this file verbatim in
// Phase 9A so the found-item report route (which also hashes identifiers) and
// the new lost-item report route share ONE implementation instead of drifting
// copies. Behaviour is unchanged â€” see services/documentHash.ts.
import { hashDocument } from './services/documentHash';
// PHASE 9D: the found-item county input rule (required + canonical, never
// inferred). Extracted so the rule is unit-testable rather than trapped in the
// handler â€” the same pattern routes/lostReports.ts uses. It delegates to the
// ONE canonical resolver (`resolveCountyName` in config/kenyaCounties.ts), so
// this file needs no county list and no second implementation.
import { resolveFoundCountyInput, FOUND_COUNTY_MESSAGES, itemMatchesCanonicalCounty } from './services/foundItemCounty';
// PHASE 16.1 (GEO-16-01): the ONE canonical county resolver, reused by the
// public county search filter and the admin lost-report county filter. This
// file keeps no county list and no alias table of its own.
import { resolveCountyName } from './config/kenyaCounties';
import { resolveAdministrativeUnitId } from './config/kenyaAdministrativeUnits';
// P14A (P14-05): the ONE authoritative vocabulary for
// `categories.public_clue_style`. The admin category routes validate against
// this list instead of re-typing it, so the console can configure the masking
// policy the public-recognition service actually implements.
import { isPublicClueStyle, PUBLIC_CLUE_STYLES } from './services/publicRecognition';
// PHASE 16.1 BATCH 1 (CAT-01 / CAT-07 / CAT-19): the ONE category input rule.
// Validates a category id against the LIVE `db.getCategories()` list before any
// write or search filter (so an unknown id is a controlled 400, never a
// foreign-key 500) and parses the numeric Recovery Fee Engine fields an admin
// may configure. This file keeps no category list of its own.
import {
  CATEGORY_MESSAGES,
  resolveCategoryId,
  parseCategoryNumber,
} from './services/categoryValidation';
// PHASE 16.1 BATCH 2 (CAT-09): the PUBLIC category DTO. `GET /api/categories` is
// unauthenticated, so it serves an explicit whitelist of the fields the public
// UX actually reads â€” never the raw configuration row. The admin console keeps
// the complete record over `GET /api/admin/categories`.
//
// PHASE 16.1 BATCH 1A: that DTO (like `validateCategoryIdFormat` above) is now
// applied by the category routes in routes/categories.ts, which were extracted so
// the admin-create â†’ public-read propagation chain can be exercised over real
// HTTP â€” so server.ts no longer imports them directly.
// PHASE 9D: the ONE coordinate validator (finite + in-range, explicit
// null-handling so a valid 0 is not discarded).
import { normalizeCoordinateInput } from './services/coordinates';
// P2-A1: isValidImageSignature and maskName moved here from module-local
// definitions in this file, so the extracted Finder report routes and the
// routes that still use them inline share ONE implementation.
import { isValidImageSignature, maskName } from './services/imageSignature';
// P2-A1: the Finder report / photo-analyze routes were extracted verbatim so
// they can be mounted for real HTTP integration testing (server.ts calls
// startServer() at import time and cannot be imported by a test).
import { registerFinderReportRoutes } from './routes/finderReport';
// P2-A2: the public discovery search route was extracted verbatim so it can be
// mounted for real HTTP integration testing.
import { registerPublicSearchRoutes } from './routes/publicSearch';
// P2-A3.1: claim submission and the claim OTP pair were extracted verbatim so
// they can be mounted for real HTTP integration testing.
import { registerClaimRoutes } from './routes/claims';
import { registerClaimPaymentRoutes } from './routes/claimPayments';
// P2-A3.3: the IntaSend collection webhook was extracted verbatim so it can be
// mounted for real HTTP integration testing. processClaimPaymentConfirmed and
// sendServerError are INJECTED, not moved or duplicated: the payment-confirmation
// logic is shared with the dev-only simulator below and must stay a single
// implementation.
import { registerWebhookRoutes } from './routes/webhooks';
// P2-A3.4A: the four Agent physical item-handling routes were extracted verbatim
// into routes/agentOps.ts so they can be mounted for real HTTP integration
// testing. confirm-viewing and confirm-handover deliberately remain inline.
import { registerAgentOperationalRoutes } from './routes/agentOps';
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
// N3 note: the activation email reuses the EXISTING EmailService (imported
// above), whose `send()` already fails closed in production â€” it returns false
// when Resend has no usable credentials and true only on real provider
// acceptance (or the explicit dev/sandbox outbox). That boolean is the signal
// the activation gate depends on, so no new mailer is introduced.
// PHASE 10 (F-4): the dev payment-simulation gate, extracted so it is testable.
// This predicate was private to this file, which cannot be imported by a test
// (it boots the application on import), so the gate that protects a
// money-faking endpoint had no regression coverage at all. The logic is
// unchanged â€” see config/devPaymentSimulation.ts.
import { resolveDevPaymentSimulationEnabled } from './config/devPaymentSimulation';
import { getAdminNotificationEmail } from './config/adminNotificationEmail';
import { assertEmailTransportConfiguration } from './config/emailConfig';
// BATCH 2 (G3) â€” the EXISTING email sender is reused for the email-change
// verification message. Imported here rather than inside routes/customerAccount.ts
// so that module stays free of any delivery dependency.
import { EmailService } from './services/email';
import {
  runNotificationRetrySweep,
  retryNotificationEvent,
  isRetryableEventType,
  RETRYABLE_EVENT_TYPES,
} from './services/notificationRetry';
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
// operational status â€” never the provider secret, never raw provider internals.
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
  // process.env reads â€” and therefore the gate's behaviour â€” are unchanged; this
  // wrapper exists only so every existing call site in this file keeps working
  // untouched.
  return resolveDevPaymentSimulationEnabled(
    process.env.NODE_ENV,
    process.env.ALLOW_MOCK_OTP_BYPASS,
    process.env.ENABLE_DEV_PAYMENT_SIMULATION,
  );
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
//
// P2-A4: this whole block was module-level. It is a STARTUP guard, and it now
// lives in assertBootSecrets() below, which startServer() calls before anything
// else. The `else` branch (development warnings) is NOT part of the boot
// contract â€” it is advisory logging, so it runs on import exactly as before.
if (process.env.NODE_ENV === 'production') {
  // Intentionally empty here; see assertBootSecrets().
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
// unusable DSN â€” it logs its own "Invalid Sentry Dsn" warning and returns â€” so
// the application announced error tracking as live while no event could ever be
// delivered, which is worse than not having it at all.
//
// The acceptability policy now lives in config/sentryDsn.ts (the same module the
// browser bundle uses). The messages state exactly what was established: that
// the DSN passed the application's own configuration policy and that
// Sentry.init() ran. They deliberately do NOT claim the provider accepted the
// DSN â€” verifying that needs network I/O, which this boot path does not perform.
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
    // Initialisation itself failed. Report that â€” never success.
    console.error('[SENTRY ERROR] Failed to initialize Sentry:', err);
  }
} else {
  // A non-null problem is guaranteed here (isSentryDsnUsable was false), and
  // `?? 'missing'` keeps the type narrow without a non-null assertion.
  console.log(`[SENTRY] Backend error tracking is DISABLED â€” Sentry DSN is ${sentryDsnProblemLabel(sentryBackendDsnProblem ?? 'missing')}. No error events will be sent.`);
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

// Enforce strict presence and safety of secrets at startup.
//
// P2-A4: this block used to run at MODULE IMPORT. That is a boot guard being
// executed as an import side effect, which is why importing this file under the
// test runner threw "FATAL: ... refuses to boot" before a single assertion ran â€”
// the test environment deliberately blanks provider credentials (see
// setup.testEnv.ts, which exists to stop the suite dispatching real SMS).
//
// These checks belong to STARTUP, as their own comment says. They now run as
// the FIRST statement of startServer(), i.e. before the schema migration,
// before the admin seed and before app.listen() â€” so a production deployment
// with missing secrets still refuses to serve traffic, exactly as before.
// The only behavioural difference is that merely importing the module no longer
// aborts the process.
function assertBootSecrets() {
  // AFRICA'S TALKING SMS IS AN OPTIONAL CHANNEL, NOT A BOOT DEPENDENCY.
  //
  // The predicate below is deliberately the EXACT expression the runtime send
  // path uses (services/auth.ts:74), so the boot guard and the sender can never
  // disagree about whether SMS is live:
  //
  //   SMS_ENABLED === 'true'  ->  SMS is ON, and the strict Africa's Talking
  //                              credentials check further down is UNCHANGED.
  //   anything else           ->  SMS is OFF, so Africa's Talking credentials
  //                              and a Sender ID are NOT required to boot. This
  //                              is the recommended initial production-launch
  //                              posture: the platform runs on email/Resend and
  //                              the send path already fails closed rather than
  //                              ever claiming a delivery it cannot prove.
  //
  // This gates ONLY the two Africa's Talking checks below. Every other
  // production requirement in this function (JWT_SECRET, DOC_HASH_SALT,
  // ADMIN_PASSCODE, the dev-flag refusals, the IntaSend keys and the
  // Resend/email rule) is unconditional and untouched.
  const smsEnabled = process.env.SMS_ENABLED === 'true';
  if (!smsEnabled) {
    console.log('[BOOT] SMS_ENABLED is not "true": Africa\'s Talking SMS is an OPTIONAL notification channel. Africa\'s Talking credentials and Sender ID are NOT required for startup, and no SMS is attempted. Email (Resend) remains the transactional notification channel. Set SMS_ENABLED="true" once valid Africa\'s Talking credentials and an approved Sender ID are available, to enable SMS later.');
  }

  // P2-A4: the production-only strict block used to run at MODULE IMPORT. It is
  // a STARTUP guard, so it now runs from the boot path like the rest of this
  // function. Under test NODE_ENV is 'test', so it never fired there anyway â€”
  // but leaving boot policy in the import path meant a production-mode import
  // could abort a process that only wanted the app object.
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
    // M-Pesa payment as "successful" â€” real users would see a success message,
    // items would be released to them, and agents would be told they'd been
    // paid, while zero real money ever moved. The same principle applies to
    // Africa's Talking WHEN SMS IS ENABLED: a placeholder key there means
    // pickup codes are only ever logged to the server console, never actually
    // sent to the owner's phone. Both failure modes are invisible unless
    // caught here at boot.
    //
    // The SMS check is conditional on `smsEnabled` (declared at the top of this
    // function) because SMS is an optional channel a launch may deliberately
    // leave off; the IntaSend checks above are unconditional because payments
    // are never optional.
    if (isPlaceholderKey(process.env.INTASEND_PUBLISHABLE_KEY) || isPlaceholderKey(process.env.INTASEND_SECRET_KEY)) {
      throw new Error('FATAL: INTASEND_PUBLISHABLE_KEY / INTASEND_SECRET_KEY are missing or still placeholder values in production mode. Without real keys, all M-Pesa payments would be silently simulated as successful with no real money moving. The app refuses to boot.');
    }
    if (isPlaceholderKey(process.env.INTASEND_WEBHOOK_SECRET)) {
      throw new Error('FATAL: INTASEND_WEBHOOK_SECRET is missing or still a placeholder value in production mode. Without it, payment webhook signatures cannot be verified, and the app refuses to boot rather than accept unverified payment confirmations.');
    }
    if (smsEnabled && (isPlaceholderKey(process.env.AFRICASTALKING_API_KEY) || isPlaceholderKey(process.env.AFRICASTALKING_USERNAME) || isPlaceholderKey(process.env.AFRICASTALKING_SENDER_ID))) {
      throw new Error('FATAL: Africa\'s Talking configuration is missing or still placeholder values in production mode while SMS_ENABLED is "true". Without it, secret pickup codes would only ever be logged to the server console, never actually delivered to owners by SMS. Enable valid Africa\'s Talking credentials and an approved Sender ID, or set SMS_ENABLED="false" to launch on email/Resend alone. The app refuses to boot.');
    }
  }

  // Presence checks that apply in EVERY environment (not just production), so a
  // misconfigured deployment cannot start at all.
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

  // Africa's Talking presence check. Meaningful ONLY when SMS is actually
  // enabled: when SMS_ENABLED is not 'true' the credentials are not a launch
  // requirement, so their absence must never refuse boot. When SMS IS enabled
  // this preserves the original guarantee — a real .env without the three SMS
  // variables still refuses to boot.
  if (realEnvExists && smsEnabled) {
    if (process.env.AFRICASTALKING_API_KEY === undefined || process.env.AFRICASTALKING_USERNAME === undefined || process.env.AFRICASTALKING_SENDER_ID === undefined) {
      throw new Error('FATAL: Africa\'s Talking configuration variables (AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME, AFRICASTALKING_SENDER_ID) are missing from .env while SMS_ENABLED is "true". The app refuses to boot.');
    }
  }

  // TRANSACTIONAL EMAIL (Resend). This is the SAME rule the sender applies,
  // called from the same boot path as the secret assertions above.
  //
  // PRODUCTION: throws without a usable RESEND_API_KEY. There is no console
  // outbox in production (the transport fails closed), so a deployment without
  // a provider would serve traffic while unable to send ANY transactional
  // email — not the activation link that verifies an account, not the payment
  // confirmation that releases an item from an agent. Refusing to start is
  // strictly safer than appearing healthy while silently unable to complete
  // those flows, and this is exactly what the missing-secret checks above do.
  //
  // NON-PRODUCTION: never throws — it warns, because the dev/test transport has
  // a deliberate console outbox, which makes an unconfigured machine fully
  // workable. A resolvable-but-risky configuration (Resend's shared sandbox
  // sender, or no Reply-To) warns in BOTH modes instead of throwing: it can
  // still deliver, and a staging operator is allowed to choose it.
  //
  // Deliberately NOT re-implemented here: the definition of "usable key" lives
  // in config/emailConfig.ts and is shared with the transport, because a guard
  // that accepts what the sender rejects (or vice versa) is how a deployment
  // ends up "validated" against a rule nothing follows.
  assertEmailTransportConfiguration();
}

// PHASE 10 (F-1): the listen port is now configuration-driven.
//
// This was `const PORT = 3000;` â€” a hardcoded constant that ignored the
// environment entirely. Managed container platforms (Cloud Run, which
// .env.example's own comments describe this app as targeting) inject PORT and
// route traffic and health checks to the port they assigned, so a server that
// ignores it can report a successful boot while receiving no traffic at all.
//
// An ABSENT PORT keeps the long-standing 3000 default, so local development is
// unchanged. An INVALID PORT also falls back to 3000 â€” a typo in an environment
// variable must never be the reason the service is down â€” but the rejection is
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
// suspicious handover before money moves â€” see database.ts enterPendingSettlement.
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
// proxy hops in front of this server (see the trust-proxy config below) â€” if
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

// P0: POST /api/claims/:id/request-otp used to require only a claim ID â€”
// no phone parameter at all â€” and was gated solely by otpIpLimiter (5/5min
// per IP) and otpGlobalLimiter (a system-wide bucket). Neither is keyed to
// the specific claim being targeted, so an attacker who found or guessed a
// claim ID (the same 900k-combination numeric space documented elsewhere
// in this file) could repeatedly trigger real OTP SMS messages to that
// claim's real registered owner_phone â€” a harassment/cost-abuse vector
// against a third party who never initiated anything â€” bounded only by a
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
// request and is reachable unauthenticated â€” before any item report even
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

// Claim IDs are 6-digit numeric codes (CLM-100000..CLM-999999 â€” see
// generateUniqueClaimId below), a space of under 900,000 values. `/pay`,
// `/lookup`, and `/status` all accept a bare claim ID from an unauthenticated
// caller (owners have no login), and generalLimiter's 1000 req/15min per IP
// is nowhere near tight enough to stop that space being brute-forced â€”
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
// platform-wide ceiling â€” the same defense-in-depth pair the claim OTP route
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
// validly signed and hasn't expired â€” it says nothing about whether the
// Agent it names is still allowed to act *right now*. Before this
// middleware existed, every Agent operational route (verify-item,
// confirm-dropoff, reject-dropoff, confirm-viewing, confirm-handover) only
// ever checked `req.user?.role === 'agent'` â€” trusting the JWT claim alone
// â€” while a single unrelated route (GET /api/agents/queue) separately
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
// currently active â€” lets route handlers use the already-verified record
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
// validly signed and hasn't expired â€” an admin JWT stayed fully usable for
// its entire remaining lifetime (currently 4h) even after is_active was
// set to false, because is_active was only ever checked at login and at
// 2FA verification, never on the ~24 subsequent privileged requests a
// session actually makes. Re-checks both is_active and token_version
// against the live admin_users record on every request via
// isAdminSessionCurrent() (services/auth.ts) â€” a mismatch on either means
// something security-sensitive happened to this account since the token
// was issued, and the token is rejected regardless of remaining expiry.
// Mount directly after authenticateJWT on every admin route, in addition
// to (not instead of) each route's own `role !== 'admin'` check.
function requireCurrentAdminSession(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin' || !req.user.username) {
    // Not an admin-role token at all (e.g. admin_pending_2fa, or another
    // role entirely) â€” the route's own role check will reject it; nothing
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
// client â€” meaning a Postgres constraint violation ("duplicate key value
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
// customer from that hash â€” a browser can never supply its own
// customerId/phone/name and be trusted.
//
// The cookie handling, helpers and the requireCustomerAuth middleware were
// moved VERBATIM to services/customerAuth.ts in Phase 2. Two reasons:
//   1. The customer claim routes now live in routes/customerClaims.ts, and
//      they need the exact same middleware â€” importing server.ts from another
//      module is impossible because this file calls startServer() at import
//      time.
//   2. The HTTP integration tests must exercise the REAL middleware; they can
//      import services/customerAuth.ts and mount a real Express app without
//      booting the whole application (Vite middleware, sweeps, listeners).
// Behaviour is unchanged: same cookie flags, same hash-only lookup, same
// revocation/expiry/live-status checks.


async function startServer() {
  // P2-A4: the startup secret assertions moved here from module scope. This is
  // the first statement, so a deployment missing a secret still fails before the
  // schema migration, before the admin seed and before the socket opens.
  assertBootSecrets();

  // Run schema synchronization checks to prevent DB drift crashes.
  // ensureSchemaUpToDate() itself throws in production if any migration
  // statement genuinely failed (see its implementation) â€” that must be
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

  const app = await createApp();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[RETURN4ME SERVER] Running on http://0.0.0.0:${PORT}`);
    // Start background sweep for payment window expiry every 60 seconds
    setInterval(expireStaleClaims, 60000);
    // Start background sweep for due settlements (dispute window closed) every 5 minutes
    setInterval(releaseDueSettlements, 5 * 60 * 1000);
    // Start background sweep for retryable social-publication failures every 5 minutes
    setInterval(socialRetrySweep, 5 * 60 * 1000);
    // Start background sweep for expired handover-evidence photos once a day
    // (multi-year retention window â€” no need to check more often)
    setInterval(handoverEvidenceRetentionSweep, 24 * 60 * 60 * 1000);
    // N9: retry of failed, RECONSTRUCTABLE notifications every 5 minutes.
    // Safe across multiple instances because the claim is a database
    // compare-and-swap, not an in-process lock â€” see claimDueNotificationRetries.
    setInterval(notificationRetrySweep, 5 * 60 * 1000);
  });
}

// P2-A4 - APPLICATION CONSTRUCTION SEPARATED FROM LISTENING.
//
// Everything above `return app;` below is byte-for-byte the body that used to
// live inside startServer(), from `express()` through the final JSON API error
// handler. It is NOT rewritten, reordered or "improved" - it is the same
// middleware and the same route registrations, in the same order, on the same
// single Express app. startServer() now simply awaits this, then listens.
//
// WHY: startServer() was invoked unconditionally at import, so the file opened
// a listening socket (and started four background sweeps) the moment anything
// imported it. That is why no runtime HTTP test could ever mount the real app.
// With this seam, a test can `await createApp()` and exercise the REAL routes
// and REAL middleware without a socket, a Vite server or a sweep ever running.
//
// NOTE the function is async because the non-production branch installs Vite
// as middleware (`await createViteServer(...)`). That is preserved exactly.
async function createApp() {
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
      // PHASE 12 â€” REPRODUCED DEFECT: this used to include
      // `error: err.message || String(err)` in the response body. /api/health is
      // unauthenticated, deliberately exempt from the global limiter, and this is
      // its "the database is unreachable" branch â€” i.e. the one moment a raw pg
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
      // reworded â€” a health probe only needs status/db, and the full error is
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

  /**
   * The request's User-Agent, normalised for storage (BATCH 2 / H9-a).
   *
   * Reads the header and nothing else: it never trusts a body or query value,
   * because a caller-supplied device string would let a customer label their own
   * session arbitrarily. Returns null when absent so the column stays NULL rather
   * than recording an empty string as if it were a real device.
   *
   * The stored value is truncated to the column width in createCustomerSession,
   * and is never returned to the customer â€” see routes/customerAccount.ts, which
   * projects it into a short device label.
   */
  function readCustomerUserAgent(req: any): string | null {
    const raw = req?.headers?.['user-agent'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  // --- CUSTOMER ACCOUNT ROUTES ---
  // Persistent customer identity/session, separate from claim ownership.
  //   Registration: name + phone -> OTP -> verify -> customer + session
  //   Login:        phone -> OTP -> verify -> session
  // Responses are deliberately generic so an arbitrary phone cannot be probed
  // to learn whether it is already registered.

  app.post('/api/customer/register', customerAuthLimiter, otpGlobalLimiter, async (req, res) => {
    // N3 â€” EMAIL ACTIVATION GATE.
    //
    // CHANGED FROM THE SMS FLOW: registration no longer generates, persists or
    // sends a registration OTP and never calls sendCodeViaSms / Africa's
    // Talking. The account is created INACTIVE and the customer receives one
    // activation email instead. No session is issued here â€” activation is the
    // only path that can create one.
    //
    // Unchanged: name/phone validation, E.164 normalization, the throttle, and
    // the deliberately generic success shape that cannot be used to probe
    // whether a phone or email already exists.
    try {
      const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : '';
      const rawPhone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
      const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim() : '';

      if (fullName.length < 2 || fullName.length > 120) {
        return res.status(400).json({ error: 'Tafadhali weka jina lako kamili. / Please enter your full name.' });
      }
      const phone = toE164Kenyan(rawPhone);
      if (!/^\+254\d{9}$/.test(phone)) {
        return res.status(400).json({ error: 'Weka nambari sahihi ya simu ya Kenya. / Enter a valid Kenyan phone number.' });
      }
      // Normalization is deliberately minimal â€” trim + lowercase â€” so the
      // partial unique index compares case-insensitively without inventing
      // canonicalization rules the rest of the product does not share.
      const email = rawEmail.toLowerCase();
      if (rawEmail.length === 0 || rawEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Weka barua pepe sahihi. / Enter a valid email address.' });
      }

      const throttleKey = phone + ':registration';
      if (Date.now() - (customerOtpLastSent.get(throttleKey) || 0) < CUSTOMER_OTP_RESEND_MS) {
        return res.status(429).json({ error: 'Tafadhali subiri kidogo kabla ya kuomba msimbo mwingine. / Please wait before requesting another code.' });
      }

      // A phone that already has an account must not silently attach the new
      // email to it, and must not be distinguishable from any other refusal.
      const existingPhone = await db.getCustomerByPhone(phone);
      if (existingPhone) {
        return res.status(409).json({ error: 'Akaunti hii tayari ipo. / This account already exists.' });
      }
      const existingEmail = await db.getCustomerByEmail(email);
      if (existingEmail) {
        return res.status(409).json({ error: 'Barua pepe hii tayari imetumika. / This email address is already in use.' });
      }

      // The account exists but is INACTIVE and unverifiable: it cannot obtain a
      // session, and `activateCustomerAccount` is the only writer of 'active'.
      let customer;
      try {
        customer = await db.createCustomerPendingActivation(
          generateSecureId('CUS'),
          fullName,
          phone,
          email
        );
      } catch (e: any) {
        // 23505 = the partial unique index rejected a duplicate email. Reported
        // as the same conflict as the pre-check, never as an internal error.
        if (e && (e as any).code === '23505') {
          return res.status(409).json({ error: 'Barua pepe hii tayari imetumika. / This email address is already in use.' });
        }
        throw e;
      }
      customerOtpLastSent.set(throttleKey, Date.now());

      // 32 random bytes from the CSPRNG. The plaintext exists ONLY here and
      // inside the emailed link: never persisted, logged or returned.
      const rawToken = crypto.randomBytes(32).toString('hex');
      await db.createAccountActivationToken(
        generateSecureId('ACT'),
        'customer',
        customer.id,
        'email_activation',
        hashCode(rawToken),
        new Date(Date.now() + CUSTOMER_ACTIVATION_TTL_MS)
      );

      // N5 â€” this send is now behind the canonical notification boundary, so the
      // attempt is recorded durably (and deduplicated) before it happens. The
      // rendered body is produced by a CALLBACK, not passed as a string, so the
      // live activation link cannot reach the notification_events row: the only
      // recipient-derived value written is the masked `recipient_reference`.
      //
      // The acceptance semantics are deliberately UNCHANGED from N3: the boolean
      // this used to receive is now `accepted`, and everything downstream of it
      // â€” the 503, the audit entry, the account remaining inactive â€” behaves
      // exactly as before.
      const customerActivationNotification = await NotificationService.notify({
        eventType: 'CUSTOMER_EMAIL_ACTIVATION',
        recipient: email,
        // Derived from the ACCOUNT, not the address or the clock, so re-running
        // this branch for the same customer cannot create a second event.
        idempotencyKey: buildNotificationIdempotencyKey('CUSTOMER_EMAIL_ACTIVATION', customer.id),
        render: () => ({
          subject: 'Activate your Return4me account',
          body: buildCustomerActivationEmailHtml(fullName, buildCustomerActivationUrl(rawToken)),
        }),
      });
      const emailAccepted = customerActivationNotification.accepted;

      // EMAIL FAILURE MODE (N3): the account row and the token both already
      // exist, so the account is NOT active and NO session exists. The token
      // stays valid until its 24h expiry, so a later activation can still
      // succeed; until then the customer simply cannot sign in. We do not
      // delete the token or invent a queue here â€” resend is a later batch.
      if (!emailAccepted) {
        await db.logAudit(
          'SYSTEM',
          'CUSTOMER_ACTIVATION_EMAIL_FAILED',
          `Customer ${customer.id} created pending activation; the activation email was not accepted by the provider. Account remains INACTIVE, no session issued.`
        );
        return res.status(503).json({
          error: 'Tumaini la barua pepe halikufanikiwa. Tafadhali jaribu tena baadaye. / We could not send the activation email. Please try again later.'
        });
      }

      await db.logAudit(
        'SYSTEM',
        'CUSTOMER_ACTIVATION_EMAIL_SENT',
        `Customer ${customer.id} registered and is pending email activation. No session issued.`
      );

      // Generic on purpose â€” never reveals whether this phone or email exists.
      return res.json({
        success: true,
        message: 'Akaunti imeundwa. Angalia barua pepe yako kwa kiungo cha kuamilisha. / Account created. Check your email for a link to activate it.'
      });
    } catch (e: any) {
      return sendServerError(res, e, 'CUSTOMER_REGISTER_ERROR');
    }
  });

  app.post('/api/customer/activate', customerAuthLimiter, otpVerifyLimiter, async (req, res) => {
    // N3 â€” redeem an emailed activation token.
    //
    // REPLACES the old SMS-based /api/customer/register/verify. Order is
    // deliberate:
    //   hash -> look up -> validate purpose/type -> CONSUME (atomic) -> activate
    //   -> ONLY THEN create the session.
    // The session is created last on purpose: a failure anywhere earlier must
    // leave the caller unauthenticated.
    try {
      const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      if (!rawToken || rawToken.length < 32 || rawToken.length > 128) {
        return res.status(400).json({ error: 'Kiungo cha kuamilisha si sahihi au kimeisha muda. / The activation link is invalid or has expired.' });
      }

      const token = await db.getAccountActivationTokenByHash(hashCode(rawToken));
      // ONE generic failure for every reason below â€” unknown hash, wrong
      // account type, wrong purpose, already consumed, expired. The response
      // must not distinguish them, or it becomes a token oracle.
      const GENERIC = { error: 'Kiungo cha kuamilisha si sahihi au kimeisha muda. / The activation link is invalid or has expired.' };
      if (!token) return res.status(400).json(GENERIC);
      if (token.account_type !== 'customer' || token.purpose !== 'email_activation') {
        return res.status(400).json(GENERIC);
      }
      if (token.consumed_at) return res.status(400).json(GENERIC);
      if (new Date(token.expires_at).getTime() < Date.now()) return res.status(400).json(GENERIC);

      // Atomic: the guard is in the UPDATE's WHERE clause, so two concurrent
      // redemptions of this token produce exactly one success.
      const consumed = await db.consumeAccountActivationToken(token.id);
      if (!consumed) return res.status(400).json(GENERIC);

      // One statement: verify the email AND flip to active, only from the
      // pre-activation state. A grandfathered account can never pass this.
      const activated = await db.activateCustomerAccount(token.account_id);
      if (!activated) return res.status(400).json(GENERIC);

      const customer = await db.getCustomerById(token.account_id);
      if (!customer) return res.status(400).json(GENERIC);

      await db.logAudit(
        'SYSTEM',
        'CUSTOMER_ACTIVATED',
        `Customer ${customer.id} activated their email and may now authenticate.`
      );

      // Only now â€” after activation has actually committed â€” is a session
      // issued. The plaintext session token is hashed before storage and never
      // appears in a response body or log.
      const rawSession = crypto.randomBytes(32).toString('hex');
      // BATCH 2 (H9-a): record the device so the customer can later see and
      // revoke this session. Optional and additive â€” authentication is unchanged.
      await db.createCustomerSession(
        generateSecureId('CSES'),
        customer.id,
        hashCode(rawSession),
        new Date(Date.now() + CUSTOMER_SESSION_TTL_MS),
        readCustomerUserAgent(req),
      );
      setCustomerSessionCookie(res, rawSession);
      return res.json({ success: true, customer: toSafeCustomer(customer) });
    } catch (e: any) {
      return sendServerError(res, e, 'CUSTOMER_ACTIVATE_ERROR');
    }
  });

  // --- N4: AGENT EMAIL ACTIVATION ---
  //
  // Path is '/api/agents/...' to match the established agent route convention
  // (all agent routes are plural: /api/agents/queue, /api/agents/verify-item),
  // and it is deliberately NOT a parallel to '/api/customer/activate' by
  // accident of shape: the two endpoints differ in what they are allowed to
  // change. The customer one activates an ACCOUNT; this one verifies an ADDRESS
  // and must leave the approval axis untouched.
  //
  // Step order is identical to the customer endpoint and is the whole point:
  //   hash -> look up -> validate type/purpose/expiry/consumption
  //         -> CONSUME (atomic) -> set email_verified_at -> read back
  // NO session is issued here, unlike the customer endpoint. An agent proves
  // they own a mailbox; that is not the same as being approved to operate, and
  // the only thing that grants operational authority remains
  // requireActiveAgent re-evaluating isAgentActionable() on every protected
  // request.
  app.post('/api/agents/activate', customerAuthLimiter, otpVerifyLimiter, async (req, res) => {
    try {
      const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      // Length bounds reject obvious garbage before touching the database. The
      // real work is done by the lookup: a 64-hex token cannot be guessed.
      if (!rawToken || rawToken.length < 32 || rawToken.length > 128) {
        return res.status(400).json({ error: 'Kiungo cha kuamilisha si sahihi au kimeisha muda. / The activation link is invalid or has expired.' });
      }

      const token = await db.getAccountActivationTokenByHash(hashCode(rawToken));
      // ONE generic failure for every reason below â€” unknown hash, wrong account
      // type, wrong purpose, already consumed, expired. The response must not
      // distinguish them, or this endpoint becomes a token oracle that can be
      // used to probe which tokens exist.
      const GENERIC = { error: 'Kiungo cha kuamilisha si sahihi au kimeisha muda. / The activation link is invalid or has expired.' };
      if (!token) return res.status(400).json(GENERIC);
      // ACCOUNT-TYPE AND PURPOSE ISOLATION. A customer token presented here, or
      // a token minted for some other purpose, is refused outright. The check is
      // on the row's own columns, never inferred from the id, so a token can
      // only ever act on the account type it was issued for.
      if (token.account_type !== 'agent' || token.purpose !== 'email_activation') {
        return res.status(400).json(GENERIC);
      }
      if (token.consumed_at) return res.status(400).json(GENERIC);
      if (new Date(token.expires_at).getTime() < Date.now()) return res.status(400).json(GENERIC);

      // The agent must exist. Checked BEFORE consuming so a token pointing at a
      // deleted agent is not burned â€” the lookup is by the token's own
      // account_id, so the agent this acts on can only ever be the agent the
      // token was issued to. That is the wrong-agent protection: there is no
      // request-supplied agent id anywhere in this handler to be confused with.
      const agent = await db.getAgent(token.account_id);
      if (!agent) return res.status(400).json(GENERIC);

      // Atomic: the guard is in the UPDATE's WHERE clause, so two concurrent
      // redemptions of this token produce exactly one success and exactly one
      // failed response.
      const consumed = await db.consumeAccountActivationToken(token.id);
      if (!consumed) return res.status(400).json(GENERIC);

      // Sets email_verified_at ONLY. `status` is untouched, by construction:
      // a 'pending' agent stays 'pending' and a 'suspended' agent stays
      // 'suspended'. Email verification cannot buy business approval.
      const verified = await db.verifyAgentEmail(agent.id);
      if (!verified) return res.status(400).json(GENERIC);

      const updated = await db.getAgent(agent.id);
      if (!updated) return res.status(400).json(GENERIC);

      await db.logAudit(
        'SYSTEM',
        'AGENT_EMAIL_VERIFIED',
        `Agent ${updated.id} verified their email. Approval status is unchanged (${updated.status}); no session issued.`
      );

      // N4 â€” the response reports BOTH axes so the frontend can say something
      // true, and issues NO session. `operational` is exactly the server's own
      // isAgentActionable() verdict, not a client-side guess, so the UI can
      // never claim more access than the authorization layer would grant.
      return res.json({
        success: true,
        agent: {
          id: updated.id,
          businessName: updated.business_name,
          status: updated.status,
          emailVerified: true,
        },
        // Still 'pending'? Then the applicant is verified but NOT approved, and
        // the UI must keep saying so rather than sending them to the Agent Hub.
        operational: isAgentActionable(updated),
        message: updated.status === 'active'
          ? 'Barua pepe imethibitishwa. Unaweza kuendelea. / Your email is verified. You can continue.'
          : 'Barua pepe imethibitishwa. Maombi yako bado yasubiri kupitishwa na msimamizi. / Your email is verified. Your application is still awaiting administrator approval.',
      });
    } catch (e: any) {
      return sendServerError(res, e, 'AGENT_ACTIVATE_ERROR');
    }
  });

  app.post('/api/customer/login', customerAuthLimiter, otpGlobalLimiter, smsRateLimit(), async (req, res) => {
    try {
      const rawPhone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
      const phone = toE164Kenyan(rawPhone);
      if (!/^\+254\d{9}$/.test(phone)) {
        return res.status(400).json({ error: 'Weka nambari sahihi ya simu ya Kenya. / Enter a valid Kenyan phone number.' });
      }

      const customer = await db.getCustomerByPhone(phone);
      // Only a genuinely registered, active account gets a code â€” but the
      // response is identical either way, so this cannot be used to discover
      // whether an arbitrary number is registered. Login NEVER creates an
      // account (an unknown phone cannot be turned into a takeover).
      if (customer && customer.status === 'active') {
        const throttleKey = phone + ':login';
        if (Date.now() - (customerOtpLastSent.get(throttleKey) || 0) >= CUSTOMER_OTP_RESEND_MS) {
          const code = generateCustomerOtp();
          // The OTP row's own id is the logical identity of this notification, so
          // it becomes the idempotency-key component. A genuine resend mints a
          // NEW row and therefore a NEW key; a retry of THIS issuance dedupes.
          // The id is opaque and secret-free, so it is safe in a stored key.
          const customerOtpId = generateSecureId('COTP');
          await db.createCustomerOtp(
            customerOtpId,
            phone,
            'login',
            hashCode(code),
            new Date(Date.now() + CUSTOMER_OTP_TTL_MS),
            customer.id
          );
          customerOtpLastSent.set(throttleKey, Date.now());
          // N7: routed through the notification boundary. The result is
          // deliberately ignored, exactly as before â€” the anti-enumeration
          // response below is returned whether or not a code was sent, so the
          // endpoint cannot be used to probe which numbers are registered.
          await sendSmsNotification({
            eventType: 'CUSTOMER_LOGIN_OTP',
            recipient: phone,
            issuanceId: customerOtpId,
            seam: 'code',
            code,
            label: 'Return4me',
            message: `Your Return4me login code is ${code}. It expires in 5 minutes. Do not share it with anyone.`,
            actorUserId: customer.id,
          });
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

      // The server â€” never the browser â€” determines which customer owns this
      // phone. A login code can never create an account.
      const customer = await db.getCustomerByPhone(phone);
      if (!customer) {
        return res.status(400).json({ error: 'Msimbo si sahihi au umeisha muda. / The code is invalid or has expired.' });
      }
      if (customer.status !== 'active') {
        return res.status(403).json({ error: 'Akaunti hii haitumiki kwa sasa. / This account is not active.', status: customer.status });
      }
      // N3 â€” ACTIVATION GATE AT LOGIN.
      //
      // A customer created by the N3 registration flow sits at
      // status = 'pending_activation' and is already rejected by the check
      // above, so this is a second, independent barrier rather than the only
      // one: it also refuses any account that somehow reached 'active' while
      // its email is still unverified.
      //
      // GRANDFATHERING: every pre-N3 account has email_verified_at = NULL, so
      // the guard is deliberately conditioned on the account HAVING an email.
      // An account with no email is a legacy account and must keep working â€”
      // requiring legacy users to activate would lock out every existing
      // customer, which is exactly what the grandfathering decision forbids.
      if (customer.email && !customer.email_verified_at) {
        return res.status(403).json({ error: 'Akaunti yako bado haijasajiliwa. Angalia barua pepe yako. / Your account is not activated yet. Please check your email.' });
      }

      const rawToken = crypto.randomBytes(32).toString('hex');
      // BATCH 2 (H9-a): record the device so the customer can later see and
      // revoke this session. Optional and additive â€” authentication is unchanged.
      await db.createCustomerSession(
        generateSecureId('CSES'),
        customer.id,
        hashCode(rawToken),
        new Date(Date.now() + CUSTOMER_SESSION_TTL_MS),
        readCustomerUserAgent(req),
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
  // exclusively from the session â€” never from anything the browser supplies.
  app.get('/api/customer/me', requireCustomerAuth, async (req: any, res) => {
    return res.json({ customer: toSafeCustomer(req.customer) });
  });

  // ---------------------------------------------------------------------------
  // PHASE 2 â€” customer dashboard: explicit claim linking + the scoped claims
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
  // BATCH 1 â€” customer notification USER layer (active list, history, read state,
  // preferences). Registered from routes/customerNotifications.ts so the HTTP
  // tests can mount the real handlers and the real requireCustomerAuth middleware
  // without importing this file (which boots the application at import time).
  //
  // This layer is strictly a CUSTOMER-FACING projection. It neither delivers nor
  // retries: notification_events and NotificationService remain the only things
  // that touch a provider, and this module never reads that table â€” so no
  // provider name, error string or retry counter can reach a response body.
  // ---------------------------------------------------------------------------
  registerCustomerNotificationRoutes(app);

  // ---------------------------------------------------------------------------
  // BATCH 2 â€” customer account data & session security: device visibility, sign
  // out other devices, data export, account erasure, profile updates.
  //
  // The verification MESSAGE sender is injected rather than imported, so this
  // layer decides WHAT must be verified and never HOW it is delivered. That keeps
  // the delivery/retry machinery (N5â€“N9) entirely out of the account layer, and
  // means a delivery failure cannot roll back a business decision.
  // ---------------------------------------------------------------------------
  registerCustomerAccountRoutes(app, {
    sendVerificationCode: async ({ destination, code, kind }) => {
      if (kind === 'phone') {
        // Routed through the EXISTING N7 SMS seam rather than the low-level
        // sender: smsMigrationN7 asserts that server.ts never calls
        // sendCodeViaSms directly, and this keeps rate limiting, idempotency and
        // the durable notification event record on the one existing path.
        //
        // PHONE_VERIFICATION_OTP is the honest fit from N5's CLOSED vocabulary â€”
        // it is precisely "a one-time code proving control of this phone number",
        // sent to a customer by SMS. No new event type is invented, so the N5
        // vocabulary and its retry classification are unchanged.
        const outcome = await sendSmsNotification({
          eventType: 'PHONE_VERIFICATION_OTP',
          recipient: destination,
          // A FRESH issuance reference per request is what keeps a RETRIED
          // verification deliverable. N7 derives the idempotency key centrally
          // as buildNotificationIdempotencyKey(eventType, issuanceId), so two
          // requests for the same number are two genuinely different
          // notifications (the second code overwrites the first) instead of one
          // being suppressed as a duplicate. There is deliberately NO
          // caller-supplied idempotencyKey here: this seam is the ONE place a key
          // is derived, and a second derivation would compete with it.
          issuanceId: newSmsIssuanceId('PCHG'),
          seam: 'code',
          code,
          // Required by SmsNotificationInput for `seam: 'code'`: the dev/sandbox
          // console line only. sendCodeViaSms builds the LIVE body from `code`
          // itself, so this text never reaches a real handset.
          message: `Msimbo wa uthibitisho wa Return4me ni ${code}. / Your Return4me verification code is ${code}.`,
        }).catch(() => null);
        return Boolean(outcome && (outcome as any).accepted);
      }
      // The EXISTING generic email sender is reused rather than a new template
      // being added, so no N8 notification vocabulary or retry behaviour changes.
      const result = await EmailService.sendWithId(
        destination,
        'Confirm your email address',
        `<p>Your verification code is <strong>${code}</strong>.</p>` +
          `<p>If you did not ask to change your email address, you can ignore this message.</p>`,
      );
      return Boolean(result && result.accepted);
    },
  });

  // ---------------------------------------------------------------------------
  // PHASE 9A â€” customer lost-item reports.
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
  // PHASE 7B â€” public item journey.
  //
  // GET  /api/items/:id/public          (the /item/:id detail read model)
  // POST /api/claims/:id/pickup-details (ownership-gated agent pickup info)
  //
  // Registered from routes/publicItems.ts for the same reason as the customer
  // claim routes above: an HTTP integration test can mount the real handlers.
  //
  // canCreateClaim is injected rather than duplicated â€” it is the single
  // central claimability rule, and the public detail route must agree with it
  // exactly or it would advertise an item the claim endpoint would refuse.
  // sendServerError is passed through so error disclosure behaviour (generic in
  // production, detailed in dev) is identical to every inline route.
  // ---------------------------------------------------------------------------
  registerPublicItemRoutes(app, { canCreateClaim, sendServerError });

  // --- API ROUTES ---

  // 1. CONFIGURATION & PUBLIC METADATA
  // PHASE 16.1 BATCH 1A â€” GET /api/categories now lives in
  // routes/categories.ts, moved verbatim, so the propagation chain
  // (admin create â†’ GET /api/categories) can be exercised over real HTTP.
  // Same extract-for-testability pattern as routes/adminDisputes.ts.
  registerPublicCategoryRoutes(app, { sendServerError });

  // 2. CONFIGURATION & PUBLIC METADATA
  app.post('/api/location/reverse', async (req, res) => {
    const coordinates = normalizeCoordinateInput(req.body?.latitude, req.body?.longitude);
    if (!coordinates) return res.status(400).json({ error: 'Invalid coordinates.' });
    const outcome = await geocodeReverse(coordinates.latitude, coordinates.longitude);
    if (outcome.status !== 'ok') return res.status(503).json({ status: 'unavailable', reason: outcome.reason });
    return res.json({ ...outcome.result, source: outcome.source });
  });

  // PHASE 16.1 (GEO-16-07) â€” GET /api/regions HAS BEEN RETIRED.
  //
  // It used to return the retired distinct-regions list (`getDistinctRegions`):
  // a flat list built from `items.location_description` plus a hard-coded
  // 30-entry fallback of Nairobi estates, towns and roads. That list
  // mixed COUNTIES, towns, estates and arbitrary reporter-typed text into one
  // "region" vocabulary, was derived from items regardless of whether they were
  // publicly visible at all, and was therefore the source of the Owner search's
  // misleading "All Regions" selector â€” the GEO-16-01 finding.
  //
  // The public replacement is the canonical, structured county filter on
  // GET /api/items/search?county= (see above), whose options come from
  // config/kenyaCounties.ts (countiesByUxGroup()). Its last production consumer
  // (OwnerView) now uses that selector, and the endpoint and its DB method were
  // removed together â€” no code path can serve mixed area/county text as though
  // it were a geographic county list any more. Free-text location search
  // remains available via `q`/`area`.

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
  app.post('/api/auth/request-otp', otpGlobalLimiter, otpIpLimiter, otpPhoneLimiter, smsRateLimit(), async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) {
        return res.status(400).json({ error: 'Nambari ya simu inahitajika.' });
      }
      // N7: AuthService owns code generation, expiry and persistence and is
      // unchanged; only the transport is redirected into the notification
      // boundary, so this route gains a durable notification record and N5/N6
      // idempotency. The returned shape is mapped back to the exact pre-N7
      // contract â€” including the generic message on failure â€” so no response
      // semantics change.
      const result = await AuthService.requestOTP(
        phone,
        async (cleanPhone, code, label, message) => {
          const outcome = await sendSmsNotification({
            eventType: 'AGENT_LOGIN_OTP',
            recipient: cleanPhone,
            // Each request issues a fresh code that OVERWRITES the previous one,
            // so each is a distinct notification. Suppressing by recipient would
            // leave the user holding a code that was never delivered.
            issuanceId: newSmsIssuanceId('AOTP'),
            seam: 'code',
            code,
            label,
            message,
          });
          return {
            success: outcome.accepted,
            message: outcome.accepted ? message : SMS_UNAVAILABLE_MESSAGE,
          };
        },
      );
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
      const { phone, code, role, businessName, locationAddress, county, administrativeUnitId, latitude, longitude, locationAccuracy, tillNumber, payoutMethodType, nationalId, termsAccepted, contactEmail, shopPhotoBase64, idDocumentPhotoBase64 } = req.body;
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
          const canonicalAgentCounty = resolveCountyName(county);
          const canonicalAgentUnit = canonicalAgentCounty ? resolveAdministrativeUnitId(canonicalAgentCounty, administrativeUnitId) : null;
          if (!canonicalAgentCounty || !canonicalAgentUnit) {
            return res.status(400).json({ error: 'Please choose a sub-county belonging to your service county.' });
          }
          const suppliedCoordinates = normalizeCoordinateInput(latitude, longitude);
          if ((latitude !== undefined && latitude !== null) && !suppliedCoordinates) {
            return res.status(400).json({ error: 'Invalid agent coordinates.' });
          }
          const parsedAccuracy = Number(locationAccuracy);
          const safeAccuracy = Number.isFinite(parsedAccuracy) && parsedAccuracy >= 0 ? parsedAccuracy : null;

          if (!termsAccepted) {
            return res.status(400).json({ error: 'Ni lazima ukubali Vigezo na Masharti yetu kabla ya kujisajili.' });
          }

          // --- N4: AGENT EMAIL IS REQUIRED FOR NEW REGISTRATIONS ---
          //
          // Validated BEFORE any agent row, image upload or geocode is created,
          // so a rejected registration leaves no orphan agent and no orphaned
          // upload. Normalization is deliberately the same trim + lowercase used
          // for customers: it is the minimum that makes the partial unique index
          // behave case-insensitively, without inventing canonicalization rules
          // the rest of the product does not share. db.createAgent() normalizes
          // again, so the stored value is identical whichever path writes it.
          const rawAgentEmail = typeof contactEmail === 'string' ? contactEmail.trim() : '';
          const normalizedAgentEmail = rawAgentEmail.toLowerCase();
          if (
            rawAgentEmail.length === 0 ||
            rawAgentEmail.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedAgentEmail)
          ) {
            return res.status(400).json({ error: 'Weka barua pepe sahihi ya biashara. / Enter a valid business email address.' });
          }

          // Duplicate check BEFORE the insert, so the common case gets a clean
          // 409. It is not a security boundary on its own â€” two concurrent
          // registrations can both pass it â€” which is why the 23505 handler
          // below is mandatory, not defensive.
          const emailOwner = await db.getAgentByEmail(normalizedAgentEmail);
          if (emailOwner) {
            return res.status(409).json({ error: 'Barua pepe hii tayari imetumika. / This email address is already in use.' });
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
          
          const geoResult = suppliedCoordinates ? { latitude: suppliedCoordinates.latitude, longitude: suppliedCoordinates.longitude, needsManual: false } : await geocodeAddress(locationAddress);
          
          const newId = 'agent-' + Math.random().toString(36).substr(2, 7);
          let newAgent;
          try {
            newAgent = await db.createAgent({
              id: newId,
              business_name: businessName,
              contact_phone: phone,
              location_address: locationAddress,
              county: canonicalAgentCounty,
              administrative_unit_id: canonicalAgentUnit,
              location_accuracy: safeAccuracy,
              latitude: geoResult.latitude,
              longitude: geoResult.longitude,
              needs_manual_geocoding: geoResult.needsManual,
              mpesa_till_or_paybill: tillNumber,
              payout_method_type: payoutMethodType || 'Till Number',
              // BUSINESS APPROVAL axis. Unchanged by N4, and deliberately NOT
              // advanced by activation either â€” see verifyAgentEmail().
              status: 'pending',
              refundable_deposit: 0,
              national_id_hash: hashDocument(nationalId),
              terms_accepted_at: new Date().toISOString(),
              contact_email: normalizedAgentEmail,
              shop_photo_url: shopPhotoUrl,
              id_document_photo_url: idPhotoUrl,
            });
          } catch (e: any) {
            // 23505 = the partial unique index rejected a duplicate email: a
            // concurrent registration won the race after the check above. It is
            // the same conflict the applicant already saw once, so it returns
            // the same 409 â€” never an internal error, and never a leaked
            // database message.
            if (e && (e as any).code === '23505') {
              return res.status(409).json({ error: 'Barua pepe hii tayari imetumika. / This email address is already in use.' });
            }
            throw e;
          }

          await db.logAudit(
            phone,
            'TERMS_ACCEPTED',
            `Agent application terms and privacy accepted for ${businessName} (Phone: ${phone})`
          );
          
          agentId = newAgent.id;
          userRole = 'agent';

          // --- N4: ISSUE THE EMAIL ACTIVATION TOKEN ---
          //
          // Sent at REGISTRATION, not at admin approval. Registration is the one
          // point where a concrete agent row with a known email comes into
          // existence, and the approved architecture puts the email here so N4
          // does not have to invent an approval-triggered notification policy.
          // It also means the applicant can prove they own the mailbox while
          // they wait for the admin decision, instead of only after it.
          //
          // 32 random bytes from the CSPRNG, persisted as a SHA-256 hash ONLY.
          // The plaintext exists in this scope and inside the emailed link â€”
          // never in a log, never in a response body, never in the DB.
          //
          // Reuses the N2 table with account_type='agent'. The account_type is
          // the isolation boundary that keeps an agent token from ever being
          // redeemable against a customer account and vice versa.
          const rawAgentActivationToken = crypto.randomBytes(32).toString('hex');
          await db.createAccountActivationToken(
            generateSecureId('ACT'),
            'agent',
            newAgent.id,
            'email_activation',
            hashCode(rawAgentActivationToken),
            new Date(Date.now() + AGENT_ACTIVATION_TTL_MS)
          );

          // N5 â€” routed through the canonical notification boundary, exactly as
          // the N3 customer activation now is. The body is rendered by a
          // CALLBACK so the live agent activation link is never given to the
          // service as a value and therefore can never be persisted in
          // notification_events; only the masked recipient reference is stored.
          //
          // Acceptance semantics are UNCHANGED from N4: `accepted` plays the role
          // of the old boolean, and the 503 / audit / retryable-token behaviour
          // below is untouched.
          const agentActivationNotification = await NotificationService.notify({
            eventType: 'AGENT_EMAIL_ACTIVATION',
            recipient: normalizedAgentEmail,
            // Keyed on the AGENT id, so a re-registration attempt for the same
            // agent dedupes against the same logical activation event.
            idempotencyKey: buildNotificationIdempotencyKey('AGENT_EMAIL_ACTIVATION', newAgent.id),
            render: () => ({
              subject: 'Verify your Return4me agent email',
              body: buildAgentActivationEmailHtml(businessName, buildAgentActivationUrl(rawAgentActivationToken)),
            }),
          });
          const agentEmailAccepted = agentActivationNotification.accepted;

          // EMAIL FAILURE MODE (N4), identical in outcome to the N3 customer
          // case. The agent row and the token both already exist, so:
          //   * the agent stays email_verified_at = NULL  -> not actionable
          //   * status stays 'pending'                    -> not approved
          //   * no operational session is granted below
          // The token is NOT consumed or deleted, so it stays valid until its
          // 24h expiry and a delivery retry can still succeed. We surface 503
          // rather than reporting success for an email that never went out;
          // there is no resend endpoint in N4, which is a known gap, not a
          // reason to invent one here.
          if (!agentEmailAccepted) {
            await db.logAudit(
              'SYSTEM',
              'AGENT_ACTIVATION_EMAIL_FAILED',
              `Agent ${newAgent.id} registered pending approval; the activation email was not accepted by the provider. Email remains UNVERIFIED and no agent session is issued.`
            );
            return res.status(503).json({
              error: 'Tumaini la barua pepe halikufanikiwa. Tafadhali jaribu tena baadaye. / We could not send the activation email. Please try again later.'
            });
          }

          await db.logAudit(
            'SYSTEM',
            'AGENT_ACTIVATION_EMAIL_SENT',
            `Agent ${newAgent.id} registered, pending admin approval, and pending email activation. No agent session issued.`
          );
        }
      }

      // N4 â€” SESSION BEHAVIOUR.
      //
      // This token is still issued, and it is deliberately NOT removed. Two
      // reasons, and the distinction matters:
      //
      //  1. It is a PROOF OF PHONE OWNERSHIP, nothing more. It carries no
      //     authority of its own: every protected agent route runs
      //     authenticateJWT -> requireActiveAgent, and requireActiveAgent
      //     re-reads the agent row and calls isAgentActionable() on every single
      //     request. A freshly registered agent is 'pending' AND
      //     email_verified_at = NULL, so that predicate is false and every one of
      //     those routes answers 403 â€” the token cannot be used to reach any
      //     agent data or action before BOTH approval and email activation.
      //
      //  2. The onboarding UI uses it to show the applicant's own status, which
      //     is the same job it did before N4.
      //
      // So the guard is the authorization predicate, not the absence of a token.
      // The two fields below make the applicant's exact state explicit to the
      // frontend instead of forcing it to infer it from `status` alone.
      const token = generateToken({
        userId: phone,
        phone: phone,
        role: userRole,
        agentId,
      });

      let agentStatus = 'active';
      let agentEmailVerified: boolean | null = null;
      if (agentId) {
        const agent = await db.getAgent(agentId);
        if (agent) {
          agentStatus = agent.status;
          // N4: null for the owner/claimant branch, which has no agent row.
          agentEmailVerified = !!agent.email_verified_at;
        }
      }

      res.json({
        success: true,
        token,
        profile: {
          phone,
          role: userRole,
          agentId,
          status: agentStatus,
          // N4 â€” the EMAIL axis, reported separately from `status` because the
          // two are independent: an agent can be approved but unverified, or
          // verified but unapproved. The frontend must not collapse them.
          emailVerified: agentEmailVerified,
          // N4 â€” true only for an agent that must still verify. Drives the
          // "check your inbox" state after registration.
          activationRequired: userRole === 'agent' && agentEmailVerified === false,
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
      // issue a short-lived, narrowly-scoped 'admin_pending_2fa' token â€”
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
      // 24h used for ordinary user tokens â€” an admin session can flag items
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
  // fresh secret and stores it UNCONFIRMED (totp_enabled stays false) â€”
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
  // active session token) â€” the same standard this codebase already
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
      // â€” bump it so every other currently-active session for this admin
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

  // ---------------------------------------------------------------------------
  // 3 + 4. FINDER FLOW: photo pre-analysis (OCR) and found-item report.
  //
  // P2-A1: these two handlers were extracted VERBATIM into routes/finderReport.ts
  // so they can be mounted for real HTTP integration testing. server.ts calls
  // startServer() at import time, so it cannot be imported by a test â€” the
  // extracted-module pattern is the same one routes/customerClaims.ts,
  // routes/publicItems.ts, routes/adminClaims.ts, routes/adminDisputes.ts,
  // routes/adminLostReports.ts, routes/categories.ts and routes/lostReports.ts
  // already use. No behaviour, validation order, status code or message changed.
  //
  // Injected rather than duplicated:
  //   - sendServerError: identical error disclosure to every inline route.
  //   - the pause helpers: this route keeps reading the same admin setting
  //     through the same fail-safe helper.
  //   - the limiters: the SAME middleware objects, so a request is still limited
  //     exactly once, in the same bucket, as it was inline.
  // ---------------------------------------------------------------------------
  registerFinderReportRoutes(app, {
    sendServerError,
    pauseSettingKey,
    isPlatformOperationPaused,
    PAUSED_MESSAGES,
    reportLimiter,
    ocrAnalyzeLimiter,
  });


  // 5. OWNER SEARCH: PRIVACY-MASKED RESULTS
  //
  // P2-A2: this handler was extracted VERBATIM into routes/publicSearch.ts so it
  // can be mounted for real HTTP integration testing. server.ts boots the whole
  // application at import time and cannot be imported by a test, so the
  // extracted-module pattern already used by routes/finderReport.ts,
  // routes/customerClaims.ts, routes/publicItems.ts and the rest applies here.
  //
  // Injected rather than duplicated:
  //   - sendServerError: identical error disclosure to every inline route.
  //   - canCreateClaim:   the single claimability rule. routes/publicItems.ts and
  //     routes/lostReports.ts already inject this same function instance, so the
  //     public search list, the public item page and the claim endpoint all agree
  //     on exactly which items are claimable.
  registerPublicSearchRoutes(app, { sendServerError, canCreateClaim });

  // ---------------------------------------------------------------------------
  // 6 + 6b. OWNER CLAIMS: tiered identity verification, and the claim-specific
  // OTP dispatch + verification pair.
  //
  // P2-A3.1: these three handlers were extracted VERBATIM into routes/claims.ts
  // so they can be mounted for real HTTP integration testing. server.ts boots the
  // whole application at import time and cannot be imported by a test, so the
  // extracted-module pattern already used by routes/finderReport.ts,
  // routes/publicSearch.ts and the rest applies here.
  //
  // The PAYMENT routes deliberately stay inline for a later batch: /payment-auth,
  // /payment-session, /initiate, /session status, /pay, /lookup, /rate and
  // /status are untouched and were not moved.
  //
  // Injected rather than duplicated:
  //   - sendServerError:            identical error disclosure to every inline route.
  //   - canCreateClaim:             the single claimability rule, already injected
  //     into routes/publicSearch.ts, routes/publicItems.ts and
  //     routes/lostReports.ts, so all four surfaces agree on what is claimable.
  //   - claimabilityErrorMessage:   still called by the payment routes below, so
  //     it is injected rather than moved â€” one implementation, no split.
  //   - the pause helpers:          this route keeps reading the same admin
  //     setting through the same fail-safe helper.
  //   - the four OTP limiters:      the SAME middleware objects, so the buckets
  //     and the effective limits are unchanged by the move.
  // ---------------------------------------------------------------------------
  registerClaimRoutes(app, {
    sendServerError,
    canCreateClaim,
    claimabilityErrorMessage,
    generateUniqueClaimId,
    pauseSettingKey,
    isPlatformOperationPaused,
    PAUSED_MESSAGES,
    otpGlobalLimiter,
    otpIpLimiter,
    otpClaimLimiter,
    otpVerifyLimiter,
  });

  // ---------------------------------------------------------------------
  // P2-A3.2 ? the eight claim payment/status routes (payment-auth,
  // payment-session, initiate, session status, /pay, lookup, rate and the
  // polled status endpoint) now live in routes/claimPayments.ts so an HTTP
  // integration test can mount them without importing this file.
  //
  // The shared helpers below still have live callers HERE (the IntaSend
  // webhook and the six agent routes), so they are INJECTED rather than moved:
  // both sides keep exactly one definition, which is what stops the payment
  // fee rule, the claimability vocabulary, the expiry sweep and the rate-limit
  // buckets from ever drifting apart.
  // ---------------------------------------------------------------------
  registerClaimPaymentRoutes(app, {
    sendServerError,
    canCreateClaim,
    claimabilityErrorMessage,
    checkClaimExpiry,
    isPlatformOperationPaused,
    pauseSettingKey,
    PAUSED_MESSAGES,
    claimGuessLimiter,
    paymentSessionStatusLimiter,
    claimStatusPollLimiter,
  });

  // 6c. Short-lived, single-purpose payment authorization. Owners have no
  // persistent login in this app, so this is the closest equivalent to a
  // "claim session": prove you know the claim's registered phone number
  // (the same bar /lookup already uses) and receive a random, opaque,
  // 20-minute token that /pay will require. Unlike a bare phone-number
  // check, this token expires, is minted fresh per request (nothing
  // long-lived to leak), and is never persisted in plaintext â€” only its
  // hash is stored, exactly like OTP codes and pickup codes elsewhere in
  // this file. Rate-limited the same as the other claim-ID-guessable
  // routes since it still only takes a claim ID + a guessable-in-principle
  // phone number to attempt.

  // --- PAYMENT SESSIONS (server-controlled, single-claim payment attempts) ---
  // This is the PRIMARY payment path, replacing the old rule that the payer's
  // M-Pesa phone must equal the claim's owner_phone. Opening a session for a
  // claim still requires proving ownership of the claim (phone == owner_phone,
  // the same bar /payment-auth always used) â€” that proof has NOT been deleted,
  // just moved: the session becomes the bearer of authorization, and the
  // session's payer_phone (below) may legitimately differ from owner_phone. The
  // server computes the amount; the browser supplies none of it.

  // Create a new payment session for a claim.

  // Initiate the M-Pesa STK push for a payment session. Requires the short-lived
  // ownership token minted by /payment-auth (which itself requires knowing the
  // claim's owner phone), so triggering a real payment still proves ownership.

  // Authoritative payment-session status for the frontend polling loop. The
  // frontend can never mark a payment confirmed here; it can only observe what
  // the backend/provider have recorded. Also enforces server-side expiry on both
  // the claim and the session.
  // PHASE 12: this route is POLLED by OwnerView (`payment_polling: 3`, i.e. the
  // same 3-second cadence as GET /api/claims/:id/status) and was registered with
  // no limiter at all, unlike every other route in the claim family. It now
  // carries its OWN 600/15-minutes-per-IP budget (a distinct limiter instance, so
  // the two polled routes cannot drain each other's allowance).

  // 7. INTASEND M-PESA STK PUSH & WEBHOOKS

  // 7a. Look up existing claim by Claim ID and Owner Phone
  //
  // Phase 7C.7 (R2): the two ownership failures â€” "no such claim" and "the phone
  // does not match this claim" â€” now return ONE status and ONE body. Previously
  // a caller who knew nothing but a candidate claim ID could learn whether that
  // claim existed at all, and, for a claim they knew existed, confirm whether a
  // guessed phone number was the registered owner phone. The missing-field guard
  // stays a 400 and still runs BEFORE any database read, so it cannot be used as
  // a probe either. The wording mirrors the ownership-gated pickup-details route
  // (routes/publicItems.ts MESSAGES.claimUnavailable) so both surfaces speak with
  // the same vocabulary. NOTE: ownership proof is unchanged â€” a matching
  // registered phone is still required, and the claim's real owner phone remains
  // the only credential this route accepts.
  //
  // PHASE 16 (P0) â€” THE AUTHENTICATED BOUNDARY.
  //
  // This route used to be reachable ANONYMOUSLY: a claim ID (CLM-######, under
  // 900,000 values â€” see generateUniqueClaimId below) plus the owner phone was
  // the only credential, and the phone comparison itself was the only thing
  // standing between a stranger and the claim's status, its masked item view and
  // â€” while the claim is pickup-eligible â€” the hub's operational contact DTO.
  // The product requirement is now AUTHENTICATED claim tracking: the Track My
  // Claim surface lives on the public /lost page but hands a signed-out visitor
  // through the existing /account customer boundary (GET /api/customer/me, the
  // httpOnly r4m_customer_session cookie) before the form is ever rendered.
  //
  // The server therefore enforces the same boundary rather than relying on the
  // UI hiding a form: `requireCustomerAuth` runs FIRST and answers 401 for a
  // caller with no live customer session. It is deliberately ADDITIVE, not a
  // replacement â€” the phone-match check below is untouched, so a signed-in
  // customer still cannot read a claim that is not theirs. This cannot become a
  // second authentication system: it is the SAME middleware, resolving the SAME
  // cookie session, that guards /api/customer/me and every /api/customer/claims
  // route. Nothing about the claim state machine, the payment flow, the DTO
  // privacy rules or the rate limiter changes.
  //
  // Consequence, stated plainly: an owner who has never created a Return4me
  // account can no longer track a claim anonymously. They are not locked out â€”
  // the public /lost page routes them through the existing one-time-code account
  // creation (the same phone number the claim already holds) and returns them
  // here with the tracking form open.

  // 7b. Submit user rating for an agent from the owner portal
  // SECURITY: this route used to be unauthenticated AND unguarded, which meant
  // a bare, guessable claim ID (see the claim-ID-guessing comments elsewhere in
  // this file â€” 6-digit numeric space, under 900,000 values) was sufficient to
  // call db.rateAgent() an unlimited number of times for any claim, with no
  // check that the claim had even reached handover. rateAgent() is a running
  // average with no built-in dedup, so this let anyone who found/guessed a
  // claim ID arbitrarily inflate or tank an agent's reputation score by
  // spamming this endpoint. That was closed with three gates: rate-limited like
  // the other claim-ID-guessable routes, requires the claim to have actually
  // reached a post-handover status, and atomically allows at most one rating per
  // claim ever (db.markClaimRatedIfNotAlready).
  //
  // PHASE 16.1 Batch 2A â€” THE ANONYMOUS PREMISE IS GONE. The "owners aren't
  // logged in" justification this route (and the matching note in
  // db/database.ts) was written against has been falsified by Phase 16: the one
  // journey that reaches this endpoint, Track My Claim, is now a customer-
  // authenticated flow (requireCustomerAuth on POST /api/claims/lookup, and the
  // same boundary in OwnerView). Rating is a state-changing WRITE to a real
  // business's public reputation â€” the last owner-journey mutation still
  // reachable by nothing but a guessed claim ID. It therefore resolves the
  // customer session FIRST now.
  //
  // This is the SAME middleware, resolving the SAME httpOnly r4m_customer_session
  // cookie, that already guards /api/claims/lookup and every /api/customer route
  // â€” no second authentication mechanism, no new token store, and no change to
  // the request contract (OwnerView already calls this same-origin, so the
  // cookie is sent). The three gates above are untouched and remain in force
  // behind the new boundary.

  // GET lightweight claim status for frontend polling
  // SECURITY (P0, Phase 7B): this endpoint is deliberately unauthenticated â€”
  // it's polled every 3 seconds by the owner's browser during claim submission,
  // agent confirmation and payment, before any login exists for owners. Two
  // separate exposures were fixed here:
  //
  //  1. It used to return the ENTIRE raw claim row, including
  //     `security_answers` (the exact last-4-digits/color/lost-details answers
  //     used to verify someone is the real owner), `owner_phone`, `owner_email`,
  //     `owner_identifying_details`, and `owner_id_proof_url`. Anyone who
  //     obtained a claim ID â€” from a URL, an SMS, a shared screenshot, or
  //     simple enumeration of the ~900k-combination claim-ID space â€” could read
  //     the correct security answers for that claim and use them to impersonate
  //     the real owner. That was already narrowed to the hand-built whitelist
  //     below ({ id, status, agent_confirmed_at }), which is the ONLY thing the
  //     OwnerView polling loops read off `data.claim`.
  //
  //  2. PRIVACY FIX: it then STILL returned `agent: toOwnerSafeAgentView(agent)`
  //     â€” the assigned agent's full contact phone number, exact pickup address
  //     and GPS latitude/longitude â€” to any anonymous caller who simply knew or
  //     guessed a claim ID. That is operational contact/location data for a
  //     real business and a real person, and a guessable ID must never be
  //     sufficient to obtain it. `agent` is now GONE from this response
  //     entirely; the owner gets it from the separately ownership-gated
  //     POST /api/claims/:id/pickup-details (routes/publicItems.ts), which
  //     requires the claim's registered owner phone. The response object below
  //     is the complete public contract â€” it is a deliberately minimal public
  //     DTO, not a filtered row.
  //
  // Also rate-limited, but DELIBERATELY NOT with claimGuessLimiter.
  //
  // F1 REGRESSION (fixed in Phase 7B.2): attaching claimGuessLimiter here â€”
  // a 20-requests/15-minutes bucket SHARED with /lookup, /pay,
  // /payment-auth, /payment-session and /:id/rate â€” starved the legitimate
  // owner's own flow. OwnerView polls this route every 3 seconds (20 requests
  // per minute, up to 300 per window), so the shared budget was gone ~60
  // seconds into waiting for the agent; the poller then received 429s it
  // ignored, and the owner's subsequent /payment-auth and /pay calls were
  // rejected too. This route is the only POLLED claim route, so it now has a
  // dedicated policy (600/15 min per IP â€” see config/claimStatusPollLimiter.ts
  // for the arithmetic and the keying rationale) that cannot consume, or be
  // consumed by, the discrete-route enumeration bucket.

  // Core logic for confirming a claim's payment and moving it to escrow.
  // Shared by the real IntaSend webhook AND the dev-only test-payment
  // simulator below, so both paths run through the exact same business
  // logic â€” no duplicated/diverging implementation between "real" and
  // "simulated" payment confirmation.
  async function processClaimPaymentConfirmed(claimId: string, invoiceId: string, confirmedAmount?: number | string | null): Promise<string | null> {
    // P1: webhook amount reconciliation. Before this, the webhook handler
    // never looked at the paid amount at all â€” only invoice_id, state, and
    // api_ref were read from the payload. Signature verification means an
    // attacker can't forge/alter a payload without the shared secret, but
    // that's a different guarantee than this one: a legitimately-signed
    // webhook could still report a different amount than what this claim
    // actually owes (a fee-calculation bug, a race between STK-push
    // initiation and confirmation, a provider-side anomaly) and nothing
    // would catch it â€” the claim would move to escrow_held and eventually
    // pay out Finder/Agent shares computed from ITS OWN expected fee,
    // silently diverging from what the owner was actually charged.
    //
    // NOTE ON FIELD NAME: this codebase has no prior reference to what
    // IntaSend actually calls the paid amount in a collection webhook
    // payload â€” the call site below best-effort reads payload.value (with
    // payload.amount as a fallback), based on IntaSend's typical naming,
    // but this has not been verified against live IntaSend documentation
    // from this environment (no network access). If the field name is
    // wrong, confirmedAmount arrives as undefined here, and â€” deliberately
    // â€” that does NOT block the payment (see below): a wrong guess about
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
    if (session && session.claim_id !== claimId) {
      console.error(`[WEBHOOK SESSION] Refusing confirmation: invoice ${invoiceId} belongs to payment session ${session.id} for claim ${session.claim_id}, not claim ${claimId}. Cross-claim payment blocked.`);
      await db.logAudit('SYSTEM', 'WEBHOOK_CROSS_CLAIM_REFUSED', `Invoice ${invoiceId} tried to confirm claim ${claimId} but belongs to session ${session.id} of claim ${session.claim_id}. Refused.`);
      return null;
    }
    // P1 HARDENING (B-1). A claim must NOT reach 'escrow_held' unless the amount
    // has been POSITIVELY reconciled â€” either from the callback's own value, or
    // from an authoritative provider lookup keyed on the invoice_id we already
    // hold. 'unknown' (absent OR malformed) is never a licence to proceed.
    let authoritativeAmount: unknown = confirmedAmount;

    const sessionRecon = session
      ? reconcileWebhookAmount(confirmedAmount, session.amount)
      : 'unknown';

    if (sessionRecon === 'mismatch') {
      console.error(`[WEBHOOK SESSION AMOUNT] Refusing to confirm session ${session.id} for claim ${claimId}: webhook amount ${confirmedAmount} != session amount ${session.amount}. Invoice ${invoiceId}.`);
      await db.logAudit('SYSTEM', 'WEBHOOK_AMOUNT_MISMATCH_REFUSED', `Claim ${claimId} session ${session.id}: webhook amount ${confirmedAmount} did not match session amount ${session.amount} (invoice ${invoiceId}). Refused.`);
      return null;
    }
    if (session && sessionRecon === 'unknown') {
      // Escalate to the provider BEFORE the session is marked confirmed, so a
      // payment we cannot verify never consumes the session's one confirmation.
      const resolved = await PaymentService.fetchAuthoritativeCollectionStatus(invoiceId, session.amount);
      if (!resolved.verified) {
        await db.logAudit('SYSTEM', 'WEBHOOK_AMOUNT_UNVERIFIED', `Claim ${claimId} session ${session.id} invoice ${invoiceId}: callback amount unusable and provider verification failed (${resolved.reason}). Payment NOT confirmed; escrow withheld.`);
        console.error(`[WEBHOOK SESSION AMOUNT] Provider verification failed for session ${session.id} (${resolved.reason}). Escrow withheld.`);
        return null;
      }
      const providerRecon = reconcileWebhookAmount(resolved.providerAmount, session.amount);
      if (providerRecon !== 'match') {
        await db.logAudit('SYSTEM', 'WEBHOOK_AMOUNT_MISMATCH_REFUSED', `Claim ${claimId} session ${session.id} invoice ${invoiceId}: provider amount ${resolved.providerAmount} did not match session amount ${session.amount} (${providerRecon}). Refused.`);
        return null;
      }
      authoritativeAmount = resolved.providerAmount;
    }

    if (session) {
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

    const claimRecon = reconcileWebhookAmount(authoritativeAmount, expectedFee);
    if (claimRecon === 'mismatch') {
      console.error(
        `[WEBHOOK AMOUNT RECONCILIATION] REFUSING to confirm payment for claim ${claimId}: amount ${authoritativeAmount}, claim expects ${expectedFee}. Invoice ${invoiceId}. This claim will remain in its current status pending manual admin investigation â€” it will NOT be silently held in escrow with a mismatched amount.`
      );
      await db.logAudit('SYSTEM', 'WEBHOOK_AMOUNT_MISMATCH_REFUSED', `Claim ${claimId}: amount ${authoritativeAmount} did not reconcile with expected fee ${expectedFee} (invoice ${invoiceId}). Payment confirmation refused pending manual review.`);
      return null;
    }
    if (claimRecon === 'unknown') {
      // No session existed, or the session already reconciled the amount above.
      // This is the legacy/direct-payment path (no payment_sessions row): the
      // callback carried no usable amount, so the provider is the only remaining
      // authority. Without a verified amount we do NOT enter escrow.
      const resolved = await PaymentService.fetchAuthoritativeCollectionStatus(invoiceId, expectedFee);
      if (!resolved.verified) {
        await db.logAudit('SYSTEM', 'WEBHOOK_AMOUNT_UNVERIFIED', `Claim ${claimId} invoice ${invoiceId}: no usable amount in callback and provider verification failed (${resolved.reason}). Payment NOT confirmed; escrow withheld.`);
        console.error(`[WEBHOOK AMOUNT RECONCILIATION] Provider verification failed for claim ${claimId} (${resolved.reason}). Escrow withheld.`);
        return null;
      }
      const providerRecon = reconcileWebhookAmount(resolved.providerAmount, expectedFee);
      if (providerRecon !== 'match') {
        await db.logAudit('SYSTEM', 'WEBHOOK_AMOUNT_MISMATCH_REFUSED', `Claim ${claimId} invoice ${invoiceId}: provider amount ${resolved.providerAmount} did not match expected fee ${expectedFee} (${providerRecon}). Refused.`);
        console.error(`[WEBHOOK AMOUNT RECONCILIATION] Provider amount did not reconcile for claim ${claimId} (${providerRecon}). Escrow withheld.`);
        return null;
      }
    }

    // Atomic compare-and-swap: only the delivery that actually wins the
    // 'pending_payment' -> 'escrow_held' transition proceeds past this
    // point. A duplicate/retried webhook for an already-confirmed claim
    // returns false here and is dropped as a no-op, instead of re-running
    // the confirmation flow (new pickup code, duplicate emails/SMS) a
    // second time.
    const won = await db.attemptClaimEscrowHold(claimId, invoiceId);
    if (!won) return null;

    // BATCH 3 / P5 - customer notification for the confirmed payment.
    //
    // `won` IS the idempotency guard. attemptClaimEscrowHold is a
    // pending_payment -> escrow_held compare-and-swap that returns true only for
    // the single caller that actually moved the claim, so a replayed payment
    // webhook reaches `return null` above and cannot notify twice. The business
    // state and the payment truth are already committed at this point; the
    // producer below can only add an in-app row and can never roll them back.
    //
    // The pickup code, transaction code and provider references deliberately do
    // NOT appear here: the secret code stays solely in the transient outbound
    // render() further down, exactly as before.
    await producePaymentReceived(claimId);


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
    // It also unconditionally overwrote EVERY other claim's status â€” including
    // terminal ones (released / refunded / rejected / expired) and claims
    // already pulled into an open dispute â€” silently regressing them. The
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
          // dispute â€” in every case NOT ours to reject from this path.
          console.log(
            `[AUTO-REJECT] Skipped claim ${oc.id} (status=${autoReject.from ?? 'unknown'}, reason=${autoReject.code}).`,
          );
        } else if (!autoReject.alreadyInState) {
          // BATCH 3 / P3 - customer notification for the losing claim.
          //
          // The `else` branch is the whole point: this is the branch where
          // transitionClaimStatus ACTUALLY moved the claim to rejected. The
          // `if` branch above is a claim that was legitimately skipped (terminal,
          // escrowed, or already disputed) and must stay silent, and
          // `alreadyInState` is excluded so an explicit idempotent no-op cannot
          // notify either. `oc.id` is the specific losing claim, so no claim that
          // merely happens to be rejected is ever notified through this path.
          await produceClaimAutoRejectedFirstPayment(oc.id);
        }
      }
    }

    // Pre-fetch metadata for emails
    const cat = catForReconciliation;
    const itemName = cat ? cat.name_en : 'Found Document / Item';
    const agent = await db.getAgent(item.assigned_agent_id);

    const resolvedFee = expectedFee;

    // Generate a genuinely secret, single-use pickup code for this claim.
    // NOTE: this is deliberately NOT the item's drop-off code (item.id) â€”
    // that code is public (it's broadcast on Telegram/Facebook/X in the
    // claim link), so it proves nothing about who is physically present
    // at the agent hub. Only the HMAC hash is ever stored; the plaintext
    // code is sent once, privately, to the owner via SMS and email, and
    // the agent must have the owner read it out at handover.
    const pickupCode = crypto.randomInt(100000, 1000000).toString();
    await db.createPickupCode(claim.id, hashCode(pickupCode));

    // 1. Send email to owner if provided
    //
    // N8: routed through the notification boundary, which now records a durable
    // notification_events row before any provider call and de-duplicates on a
    // deterministic key. The recipient guard, the subject, the HTML and the
    // fire-and-forget shape are all unchanged â€” a payment must never be reported
    // as failed because an email provider was slow or absent.
    if (claim.owner_email && claim.owner_email.trim() !== '') {
      const ownerEmail = claim.owner_email;
      // Idempotency identity: the CLAIM. A claim reaches escrow exactly once, so
      // the claim id IS the payment event identity. Deliberately NOT the pickup
      // code â€” that is a secret and must never reach a durable column.
      NotificationService.notify({
        eventType: 'PAYMENT_RECEIVED',
        recipient: ownerEmail,
        idempotencyKey: buildNotificationIdempotencyKey('PAYMENT_RECEIVED', claim.id),
        // Rendered transiently at dispatch: the pickup code lives only in this
        // in-memory body and is never written to the notification_events row.
        render: () =>
          renderSendPaymentReceivedEmail(
            ownerEmail,
            claim.owner_phone,
            itemName,
            agent ? agent.business_name : 'Return4me Agent Hub',
            agent ? agent.contact_phone : 'Contact Support',
            item.id,
            pickupCode
          ),
      }).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Payment received email failed:', err));
    }

    // 1b. Send the pickup code via SMS too â€” many owners won't have
    // provided an email, and SMS is the more reliable channel in Kenya.
    //
    // N7: routed through the notification boundary. Note this flow is triggered
    // by the IntaSend WEBHOOK (a provider callback), not by a client request, so
    // it deliberately has NO N6 rate limiter attached: N6 keys on IP/user
    // identity, every webhook shares the provider's IP, and rate-limiting them
    // would suppress legitimate paid-order notifications while doing nothing
    // about the actual abuse surface (the payment endpoints). It still gets the
    // durable notification record and idempotency, which is what protects
    // against a replayed webhook sending the same code twice.
    //
    // Still fire-and-forget, exactly as before: a payment must never be
    // reported as failed because an SMS provider was slow.
    sendSmsNotification({
      eventType: 'PICKUP_CODE',
      recipient: claim.owner_phone,
      // Bound to this claim's pickup code, not to the order event: the code is
      // regenerated per claim and the old one stops working.
      issuanceId: newSmsIssuanceId('PKC'),
      // This notification's live body is a full sentence, not a bare code, so
      // it uses the message seam â€” preserving the exact text users get today.
      seam: 'message',
      message: `Return4me: Malipo yamethibitishwa. Msimbo wako wa siri wa kuchukua bidhaa ni ${pickupCode}. Toa msimbo huu kwa Agent PEKEE wakati wa kuchukua bidhaa yako. Usimshirikishe mtu mwingine. / Payment confirmed. Your secret pickup code is ${pickupCode}. Give this ONLY to the Agent when collecting your item. Do not share it with anyone else.`,
      label: 'PICKUP',
    }).catch(err => console.error('[SMS NOTIFICATION ERROR] Pickup code SMS failed:', err));

    // 2. Send email to agent if provided
    if (agent && agent.contact_email && agent.contact_email.trim() !== '') {
      const agentEmail = agent.contact_email;
      const agentBusinessName = agent.business_name;
      // Same stable identity as the owner email above: this is the SAME payment
      // event on the SAME claim, told to two different recipients. They are
      // distinct notification events precisely because the event type differs.
      NotificationService.notify({
        eventType: 'AGENT_PAYMENT_CONFIRMED',
        recipient: agentEmail,
        // N9: the claim this payment belongs to. Lets a failed send be rebuilt
        // from the authoritative claim/item/agent records. Opaque domain id â€”
        // not a recipient, not a credential.
        businessReference: claim.id,
        idempotencyKey: buildNotificationIdempotencyKey('AGENT_PAYMENT_CONFIRMED', claim.id),
        render: () =>
          renderSendAgentPaymentConfirmedEmail(
            agentEmail,
            agentBusinessName,
            itemName,
            item.id,
            claim.id
          ),
      }).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Agent payment confirmed email failed:', err));
    }

    // 3. Send transaction log email to admin
    //
    // N8: the admin recipient is resolved by this caller (it used to be read
    // inside the email provider). When it is unset the recipient is '' and
    // NotificationService rejects the event with `missing_recipient` â€” before any
    // provider call and before anything is stored. Nothing is sent, exactly as
    // before; the difference is that the refusal is now recorded rather than a
    // silent provider-level `false`.
    //
    // Idempotency identity: the admin SUBTYPE plus the claim. Both subtypes share
    // one event type, so without the subtype in the key the handover log would
    // be silently suppressed as a duplicate of the payment log for the same
    // claim.
    NotificationService.notify({
      eventType: 'ADMIN_TRANSACTION_LOG',
      recipient: getAdminNotificationEmail(),
      // N9: subtype + claim, matching the idempotency key exactly, so a retry
      // rebuilds the SAME log rather than collapsing the two subtypes.
      businessReference: `PAYMENT_CONFIRMED:${claim.id}`,
      idempotencyKey: buildNotificationIdempotencyKey(
        'ADMIN_TRANSACTION_LOG',
        `PAYMENT_CONFIRMED:${claim.id}`
      ),
      render: () =>
        renderSendAdminTransactionLogEmail(
          'PAYMENT_CONFIRMED',
          claim.id,
          item.id,
          resolvedFee,
          agent ? agent.business_name : 'Unknown Agent'
        ),
    }).catch(err => console.error('[EMAIL NOTIFICATION ERROR] Admin payment log email failed:', err));

    console.log(`[PAYMENT CONFIRMED] Claim ${claimId} successfully transitioned to escrow_held.`);
    return pickupCode;
  }

  registerWebhookRoutes(app, {
    processClaimPaymentConfirmed,
    sendServerError,
  });

  // DEV/TEST-ONLY: lets a local tester complete a payment without a real
  // M-Pesa phone or real IntaSend keys. With sandbox/placeholder IntaSend
  // credentials, no real STK push ever reaches a phone, so the payment
  // polling screen would otherwise wait the full 90 seconds and time out
  // every single time â€” there was no way to actually finish testing the
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
      // pickupCode is only ever returned here â€” a dev/test-only endpoint,
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


  // P2-A3.4A: the Agent's four physical item-handling routes (queue,
  // verify-item, confirm-dropoff, reject-dropoff) were extracted verbatim into
  // routes/agentOps.ts. requireActiveAgent, sendServerError, checkClaimExpiry and
  // isSocialPublishingPaused are INJECTED rather than moved - each is still
  // defined and used here, so there remains exactly one definition of each.
  //
  // confirm-viewing and confirm-handover deliberately STAY here for P2-A3.4B:
  // they carry claim/handover lifecycle behaviour and are out of this batch.
  registerAgentOperationalRoutes(app, {
    requireActiveAgent,
    sendServerError,
    checkClaimExpiry,
    isSocialPublishingPaused,
    // P2-A3.4B: confirm-handover. All five remain DEFINED here and are passed
    // in rather than duplicated, so the pause gate, the stolen/hold/dispute
    // fail-safe and the dispute window each keep exactly one implementation.
    pauseSettingKey,
    PAUSED_MESSAGES,
    canCreateClaim,
    claimabilityErrorMessage,
    DISPUTE_WINDOW_MS,
    isPlatformOperationPaused,
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
      // full tables â€” we use bounded recent windows mapped through explicit
      // admin whitelists so raw DB columns (provider refs, failure reasons,
      // unsanitized audit detail text, recipient phone/till) never reach the
      // browser even if the frontend is bypassed.
      const dbLedger = await db.getRecentLedgerEntries(100);
      const dbAuditLogs = await db.getRecentAuditLogs(100);

      // Claim lookup for the dispute DTO's per-claimant summaries. Built from
      // the claims already loaded above â€” no extra query per dispute.
      const claimsById = new Map<string, any>(claims.map((c: any) => [c.id, c]));

      // Fetch reputation for each item's finder_phone
      //
      // getPhoneReputation() internally calls db.getItems() AGAIN to compute
      // its per-phone counts â€” calling it once per item here re-fetches the
      // ENTIRE items table once per item. With N items that's O(NÂ²) row
      // reads: 500 items means 500 calls each re-scanning all 500 items,
      // 250,000 row reads for one admin dashboard load, growing quadratically
      // worse as the table grows. `items` is already loaded once above, so
      // the counts can be computed from it directly with zero extra
      // full-table re-fetches â€” isPhoneCleared() is still a real per-phone
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
      // item column to the browser on every console load â€” including
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
      // the admin console rendered it under the label "Escrow Funds Held" â€” a
      // count of claims presented as a monetary figure, directly beside a
      // genuine `KES {totalRevenue}` card. The amount is now the authoritative
      // server-side sum of `items.locked_total_fee` over claims in `escrow_held`
      // (the same field the payment path charges via
      // resolveAuthoritativePaymentFee), computed from the rows already loaded
      // above â€” no new query, no client input, no change to any escrow
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
      // separate request per agent â€” built from data already loaded above.
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

      // Claims sitting in the dispute window, most-soon-to-settle first â€”
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
  // signup only geocodes a free-text address automatically â€” when that fails
  // (common with informal Kenyan addresses) or is wrong, this is the only way
  // to fix it so the agent becomes matchable by the nearest-agent algorithm.
  app.post('/api/admin/agents/:id/location', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const agentId = req.params.id;
    const { latitude, longitude } = req.body;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      // PHASE 9D (F3) â€” the SAME shared validator every other coordinate input
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
  // claims tied to this dispute, proving they're an actual party to it â€”
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

      // Same phone-ownership proof pattern used in /api/claims/:id/pay â€”
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
  // endpoint is registered here â€” lifecycle changes remain the exclusive
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
  // refund â€” finalize merely records an already-executed transfer as refunded;
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
      // Re-derive amount/recipient from the DB â€” never trust the client.
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
      // BATCH 3 / P9 - customer notification for the completed refund.
      //
      // After the `if (!finalized)` early return, so it runs only where
      // finalizeClaimRefund actually performed its refunding -> refunded CAS.
      // `finalized` is the idempotency guard, so a repeated admin reconciliation
      // of the same claim cannot notify twice. The refund has already committed;
      // the producer can only add an in-app row and cannot undo it.
      await produceRefundComplete(claimId);

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

      // -----------------------------------------------------------------------
      // PHASE 16.1 BATCH 1 (CAT-01) â€” VALIDATE THE CATEGORY BEFORE THE UPDATE.
      // -----------------------------------------------------------------------
      // The submitted `categoryId` went straight into `adminUpdateItem()` and
      // only afterwards hit `items_category_id_fkey`, turning bad admin input
      // into an unhandled 500. It is resolved against the LIVE category list
      // here â€” the first thing that happens after authorization, so no update,
      // hash or audit write can precede the rejection â€” and the canonical id is
      // what gets written. An omitted field is left undefined exactly as before,
      // so the existing admin-update contract is otherwise unchanged.
      let validatedCategoryId: string | undefined = categoryId;
      if (categoryId !== undefined) {
        // PHASE 16.1 BATCH 2 (CAT-04) â€” this stays on the COMPLETE list, on
        // purpose. This is an ADMIN correction of an already-reported item, not a
        // user choosing a category for new work, so an administrator must still
        // be able to file a legacy item under a category that has since been
        // deactivated. Only the public/new-work boundaries are narrowed to the
        // active list.
        const resolvedCategory = resolveCategoryId(categoryId, await db.getCategories());
        if (!resolvedCategory.ok) {
          return res.status(400).json({ error: resolvedCategory.error });
        }
        validatedCategoryId = resolvedCategory.id as string;
      }


      // A manual agent (re)assignment must be accountable: who did it,
      // which agent it was moved from/to, and why. Require a reason
      // whenever an agent is actually being assigned here â€” matches the
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
        category_id: validatedCategoryId,
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
  // in 'pending_settlement' â€” it can never release a claim that's disputed,
  // already released, or never reached handover. Every use is audit-logged
  // with the acting admin's identity (see attemptSettlementRelease/
  // executeClaimSettlement), matching the doc's requirement that every
  // admin override be individually accountable.
  // Social media emergency stop (doc Â§86/87 "fail-safe: if uncertain, do not
  // publish"). Pausing takes effect immediately for every future post â€” it
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
  // sweep (socialRetrySweep) deliberately never touches â€” 'unknown'
  // outcomes (might already have succeeded; auto-retry risks a duplicate)
  // and 'permanent_failure' outcomes (won't fix themselves; an admin has
  // presumably just fixed whatever caused it, e.g. rotated credentials).
  // Resets the row to 'retryable_failure' with an immediate next_attempt_at,
  // then retries it directly (found_notice only â€” see the SCOPE NOTE on
  // SocialService.retryFoundNoticePost for reunited_notice's limitation).

  // ---------------------------------------------------------------------------
  // N9 â€” NOTIFICATION FAILURE OPERATOR SURFACE.
  //
  // Before N9 a failed notification was recorded and then invisible: six of the
  // seven transactional emails are fire-and-forget, so a failure produced no
  // console line, no alert and no way to find it again. These endpoints are the
  // minimum that makes the durable failure record actually usable.
  //
  // WHAT IS DELIBERATELY NOT HERE
  //   No recipient, no body, no subject, no OTP, no pickup code, no token. The
  //   list returns only columns that already exist and are already safe: the
  //   MASKED recipient reference, an opaque business id, and the sanitized error.
  //   There is no endpoint that can re-send a secret-bearing notification.
  //
  // AUTH uses the existing admin boundary (authenticateJWT +
  // requireCurrentAdminSession) â€” no new mechanism, and never exposed to
  // customers, agents, finders or unauthenticated callers.
  // ---------------------------------------------------------------------------

  // Notification failures an operator may want to look at. 'failed' is included
  // because those are pre-N9 rows, and an operator needs to SEE them even
  // though N9 will never retry them.
  const NOTIFICATION_OPERATOR_STATUSES = [
    'retryable_failure', 'permanent_failure', 'unknown', 'failed',
  ];

  app.get('/api/admin/notifications', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      // REQUIRED inline. requireCurrentAdminSession verifies that an admin
      // session has not been revoked, but it deliberately does NOT check the
      // role â€” it explicitly leaves that to each route. Without this line an
      // `admin_pending_2fa` token, or any other authenticated role, could read
      // the notification failure log. This is the same check every other
      // /api/admin route in this file performs.
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const statusFilter = String(req.query?.status || '').trim();
      const eventTypeFilter = String(req.query?.eventType || '').trim();
      const channelFilter = String(req.query?.channel || '').trim();

      const statuses = statusFilter ? [statusFilter] : NOTIFICATION_OPERATOR_STATUSES;
      for (const status of statuses) {
        if (!NOTIFICATION_OPERATOR_STATUSES.includes(status)) {
          return res.status(400).json({ error: 'Unknown notification status filter.' });
        }
      }
      if (channelFilter && channelFilter !== 'sms' && channelFilter !== 'email') {
        return res.status(400).json({ error: 'Unknown notification channel filter.' });
      }

      const rows = await db.listNotificationEventsByStatus({
        statuses,
        eventType: eventTypeFilter || null,
        channel: channelFilter || null,
        limit: 200,
      });

      // Each row is annotated with whether N9 may retry it, so an operator can
      // tell "press retry" from "this needs a human decision" without guessing.
      return res.json({
        notifications: rows.map((row: any) => ({
          id: row.id,
          eventType: row.event_type,
          channel: row.channel,
          provider: row.provider,
          status: row.status,
          recipientReference: row.recipient_reference,
          lastError: row.last_error,
          attemptCount: row.attempt_count,
          retryAttemptCount: row.retry_attempt_count,
          businessReference: row.business_reference,
          retryClass: row.retry_class,
          retryable: isRetryableEventType(row.event_type),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          sentAt: row.sent_at,
          nextAttemptAt: row.next_attempt_at,
        })),
        retryableEventTypes: RETRYABLE_EVENT_TYPES,
      });
    } catch (e) {
      console.error('[ADMIN NOTIFICATION LIST ERROR]', e);
      return sendServerError(res, e, 'ADMIN_NOTIFICATION_LIST_ERROR');
    }
  });

  app.post('/api/admin/notifications/:id/retry', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    try {
      // REQUIRED inline â€” see the note on the list route above.
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const id = String(req.params?.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Notification id is required.' });

      // The refusal is SERVER-SIDE and happens before anything else, so a
      // hand-crafted request cannot make the server retry a secret-bearing
      // notification or mint a new OTP/pickup code.
      const existing = await db.getNotificationEventById(id);
      if (!existing) return res.status(404).json({ error: 'Notification not found.' });

      if (!isRetryableEventType(existing.event_type)) {
        return res.status(409).json({
          error: 'This notification cannot be retried.',
          // 'unknown'/'permanent_failure' need a human decision, not a resend.
          reviewRequired: true,
        });
      }
      if (existing.status !== 'retryable_failure') {
        return res.status(409).json({
          error: `Only a retryable_failure can be retried; this one is '${existing.status}'.`,
          reviewRequired: existing.status === 'unknown' || existing.status === 'permanent_failure',
        });
      }

      const result = await retryNotificationEvent(id);
      return res.json({
        retried: result.ok,
        outcome: result.outcome,
        detail: result.detail ?? null,
      });
    } catch (e) {
      console.error('[ADMIN NOTIFICATION RETRY ERROR]', e);
      return sendServerError(res, e, 'ADMIN_NOTIFICATION_RETRY_ERROR');
    }
  });

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
  // scopes an admin needs to be able to freeze independently â€” see the
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

      await db.clearPaymentStrikes(phone, req.user?.username || req.user?.userId || 'admin');
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

  // PHASE 16.1 BATCH 1A â€” POST /api/admin/categories now lives in
  // routes/categories.ts (moved verbatim, same extract-for-testability pattern as
  // routes/adminDisputes.ts) so the admin-create â†’ GET /api/categories chain can
  // be proven over real HTTP. The is_admin_modified create-asymmetry fix is
  // applied inside that module.
  registerAdminCategoryRoutes(app, { requireCurrentAdminSession, sendServerError });

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
        elevated_review, is_admin_modified, public_clue_style, is_active,
      } = req.body;

      // P14A (P14-05) â€” allow-listed masking style. OMITTED preserves whatever
      // the category already has; an unsupported value is rejected, never
      // silently coerced or written through.
      if (public_clue_style !== undefined && public_clue_style !== null && public_clue_style !== '') {
        if (!isPublicClueStyle(public_clue_style)) {
          return res.status(400).json({
            error: `public_clue_style lazima iwe mojawapo ya: ${PUBLIC_CLUE_STYLES.join(', ')}. / public_clue_style must be one of: ${PUBLIC_CLUE_STYLES.join(', ')}.`
          });
        }
      }

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

      // -----------------------------------------------------------------------
      // PHASE 16.1 BATCH 1 (CAT-19) â€” Recovery Fee Engine fields are validated too.
      // -----------------------------------------------------------------------
      // Same gap as POST: these eight were cast with a bare `Number()`, so a bad
      // value became NaN/Infinity/negative and surfaced to the admin as a
      // database 500. PUT is also how an admin CLEARS an optional cap, so its
      // existing shapes are preserved exactly:
      //   undefined  -> leave the stored value untouched
      //   null / ''  -> clear. Only `finder_reward_cap` is nullable ("no cap");
      //                 the other seven are NOT NULL columns with defaults, so an
      //                 empty field there means "not supplied" and the stored
      //                 value is preserved rather than silently zeroed.
      //   a number   -> validated (amounts >= 0, percentages 0 - 100) and stored.
      let finderRewardCapUpdate: number | null | undefined = undefined;
      if (finder_reward_cap !== undefined) {
        if (finder_reward_cap === null || finder_reward_cap === '') {
          finderRewardCapUpdate = null;
        } else {
          const parsedCap = parseCategoryNumber(finder_reward_cap, 'finder_reward_cap', { min: 0 });
          if (!parsedCap.ok) {
            return res.status(400).json({ error: parsedCap.error });
          }
          finderRewardCapUpdate = parsedCap.value as number;
        }
      }

      const engineFeeFields: Array<[string, unknown, { min: number; max?: number }]> = [
        ['base_fee', base_fee, { min: 0 }],
        ['complexity_fee', complexity_fee, { min: 0 }],
        ['delay_fee', delay_fee, { min: 0 }],
        ['ceiling_percent', ceiling_percent, { min: 0, max: 100 }],
        ['finder_pct', finder_pct, { min: 0, max: 100 }],
        ['agent_pct', agent_pct, { min: 0, max: 100 }],
        ['platform_pct', platform_pct, { min: 0, max: 100 }],
      ];
      const engineFees: Record<string, number | undefined> = {};
      for (const [field, rawValue, rule] of engineFeeFields) {
        const parsed = parseCategoryNumber(rawValue, field, rule);
        if (!parsed.ok) {
          return res.status(400).json({ error: parsed.error });
        }
        engineFees[field] = parsed.supplied ? (parsed.value as number) : undefined;
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
        // meant editing ANY field via the admin form â€” including the
        // Recovery Fee Engine's own base/complexity/delay/ceiling inputs â€”
        // silently pinned the category to its old flat total_fee forever,
        // making the engine fields dead the instant an admin touched them.
        // is_admin_modified must now be an explicit choice: "yes, ignore
        // the engine and use total_fee/finder_share/etc. verbatim" (true)
        // vs "no, keep computing the fee from base/complexity/delay/
        // ceiling" (false). If the request doesn't say, preserve whatever
        // was already set rather than silently flipping it.
        is_admin_modified: typeof is_admin_modified === 'boolean' ? is_admin_modified : existing.is_admin_modified,
        base_fee: engineFees.base_fee,
        complexity_fee: engineFees.complexity_fee,
        delay_fee: engineFees.delay_fee,
        ceiling_percent: engineFees.ceiling_percent,
        finder_pct: engineFees.finder_pct,
        agent_pct: engineFees.agent_pct,
        platform_pct: engineFees.platform_pct,
        finder_reward_cap: finderRewardCapUpdate,
        elevated_review: elevated_review !== undefined ? !!elevated_review : undefined,
        // CAT-04 (Phase 16.1 Batch 2) â€” an ordinary edit that does not mention
        // the lifecycle state leaves it untouched (`undefined`). Only a real
        // boolean flips it, so saving a name or a fee can never accidentally
        // deactivate or reactivate a category.
        is_active: typeof is_active === 'boolean' ? is_active : undefined,
        // Omitted â†’ undefined, which updateCategory treats as "leave unchanged".
        public_clue_style: public_clue_style === undefined || public_clue_style === null || public_clue_style === ''
          ? undefined
          : public_clue_style,
      });

      const adminUser = req.user?.username || req.user?.userId || 'admin';
      await db.logAudit(
        adminUser,
        'CATEGORY_UPDATED',
        `Admin updated category id=${id}, old total_fee=${existing.total_fee}, new total_fee=${total_fee}, public_clue_style=${updatedCat?.public_clue_style ?? existing.public_clue_style}`
      );

      res.json({ success: true, category: updatedCat });
    } catch (e: any) {
      sendServerError(res, e, 'UNHANDLED_ROUTE_ERROR');
    }
  });

  /**
   * PHASE 16.1 BATCH 2 (CAT-04) â€” CATEGORY LIFECYCLE (activate / deactivate).
   *
   * A dedicated action rather than a general edit: the console needs to retire or
   * restore a category with ONE click, and routing that through
   * PUT /api/admin/categories/:id would mean re-submitting every other field
   * (names, fees, percentages) â€” so a stale console tab could silently revert a
   * concurrent pricing edit. This endpoint writes exactly one column.
   *
   * It is the ONLY supported way to retire a CANONICAL seeded category (CAT-06):
   * deactivating keeps the row, so every historical `items.category_id` /
   * `lost_reports.category_id` reference stays intact and searchable, while the
   * category disappears from every "choose a category" surface.
   *
   * Admin-only, audited, and validated: `is_active` must be a real boolean.
   *
   * Registered as PUT (a full replacement of this sub-resource's state, which is
   * idempotent) rather than PATCH: the repository's admin-route security audit
   * (src/__tests__/adminRouteAudit.test.ts) enumerates `get|post|put|delete`
   * /api/admin routes and asserts each one keeps an inline role check. Using a
   * verb outside that scan would place a brand-new admin mutation outside the
   * audit that exists to catch exactly that â€” so this route deliberately lands
   * INSIDE it.
   */
  app.put('/api/admin/categories/:id/active', authenticateJWT, requireCurrentAdminSession, async (req, res) => {
    const { id } = req.params;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }

      const is_active = req.body?.is_active;
      if (typeof is_active !== 'boolean') {
        return res.status(400).json({
          error: 'is_active lazima iwe true au false. / is_active must be a boolean (true or false).'
        });
      }

      const updated = await db.setCategoryActive(id, is_active);
      if (!updated) {
        return res.status(404).json({ error: 'Kategoria haikupatikana.' });
      }

      const adminUser = req.user?.username || req.user?.userId || 'admin';
      await db.logAudit(
        adminUser,
        is_active ? 'CATEGORY_ACTIVATED' : 'CATEGORY_DEACTIVATED',
        `Admin set category id=${id} is_active=${is_active}`
      );

      res.json({ success: true, category: updated });
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

      // -----------------------------------------------------------------------
      // PHASE 16.1 BATCH 2 (CAT-06) â€” A CANONICAL CATEGORY IS NEVER DELETED.
      // -----------------------------------------------------------------------
      // The 46 baseline categories are part of the platform's vocabulary: every
      // historical item, lost report and verification that named one of them
      // depends on that id continuing to exist, and the boot sync would recreate
      // a deleted baseline row anyway (insert-only, so it WOULD come back while
      // the references were still broken in the meantime). Retiring one is a
      // LIFECYCLE action â€” deactivate it â€” not a destructive one.
      //
      // The id set is derived from the same canonical seed the sync uses; there
      // is no second list (see isCanonicalCategoryId in db/database.ts).
      if (db.isCanonicalCategoryId(id)) {
        return res.status(409).json({
          error: 'Kategoria hii ni ya msingi (canonical) na haiwezi kufutwa. Imezimwa (deactivate) badala yake. / This is a canonical category and cannot be deleted. Deactivate it instead.'
        });
      }

      // -----------------------------------------------------------------------
      // PHASE 16.1 BATCH 1 (CAT-05) â€” EVERY REFERENCE, NOT JUST items.category_id.
      // -----------------------------------------------------------------------
      // The old guard counted `items.category_id` only. But `categories` is
      // referenced by THREE foreign keys, so a category used solely by a lost
      // report (or only as an agent's `verified_category_id`) sailed past the
      // guard and then failed inside DELETE on `lost_reports_category_id_fkey` â€”
      // a raw 500 for an action the API had just described as safe. The database
      // must never be the first line of defence for this. `total === 0` is the
      // only condition under which deletion proceeds, and the message names the
      // references that actually exist so an admin can act on it.
      const references = await db.getCategoryReferenceCounts(id);
      if (references.total > 0) {
        const parts: string[] = [];
        if (references.items > 0) parts.push(`bidhaa ${references.items}`);
        if (references.verifiedItems > 0) parts.push(`bidhaa zilizothibitishwa ${references.verifiedItems}`);
        if (references.lostReports > 0) parts.push(`ripoti za upotevu ${references.lostReports}`);
        return res.status(409).json({
          error: `Haiwezi kufutwa: rekodi ${references.total} zinatumia kategoria hii (${parts.join(', ')}). / Cannot delete: ${references.total} records are using this category (${parts.join(', ')}).`
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
    // .cwd(), 'src'))` covering the ENTIRE src/ tree â€” meaning
    // src/server.ts (the full backend, including exact validation logic,
    // rate-limit thresholds, magic-byte checks, and every comment
    // explaining how the security model works), all of src/db/ (the ORM
    // schema and every query), and all of src/services/ (auth, payments,
    // storage, social) were served as plain-text over HTTP to anyone who
    // requested e.g. GET /src/server.ts in production. The stated intent
    // ("so that sourcemaps can load TSX/TS source files") only actually
    // needs the FRONTEND files a Vite/browser sourcemap can reference â€”
    // src/components, src/App.tsx, src/main.tsx, src/index.css,
    // src/types.ts. None of the backend-only directories are ever part of
    // the frontend bundle (confirmed: zero imports from src/components,
    // src/App.tsx, or src/main.tsx into src/db/ or src/services/), so they
    // have no legitimate reason to be reachable over HTTP at all. Denylist
    // checked before the static handler runs, returning a plain 404 (not
    // 403) so the response doesn't even confirm a backend layer exists.
    // SEC-2B-04 â€” '/src/routes/' was missing from this list. The six
    // backend-only route modules (adminClaims, adminDisputes,
    // adminLostReports, customerClaims, lostReports, publicItems) live there,
    // are imported ONLY by server.ts, and are referenced by no frontend file â€”
    // so no browser sourcemap can ever need them, which is the same test
    // applied to the four prefixes above. Without this entry
    // GET /src/routes/adminClaims.ts returned the admin API's shape and its
    // permission-guard wiring as plain text in production.
    const srcBackendPathPrefixes = ['/src/server.ts', '/src/db/', '/src/services/', '/src/__tests__/', '/src/routes/'];
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
      // TRAVERSAL GUARD (Phase 12 â€” REPRODUCED DEFECT). This branch used to test
      // the RAW request path with `req.path.startsWith('/src/')` and then resolve
      // it with `path.join(process.cwd(), req.path)`. path.join NORMALISES `..`,
      // so the path the code CHECKED was not the path it SERVED:
      //   req.path = '/src/../sql/schema.sql'
      //   '/src/../sql/schema.sql'.startsWith('/src/')  -> true       (guard passes)
      //   path.join(cwd, '/src/../sql/schema.sql')      -> <cwd>/sql/schema.sql
      //   existsSync(...) then res.sendFile(...)        -> file served
      // Measured: the same arithmetic resolves '/src/../.env' to '<cwd>/.env'.
      // Any non-dot file under the deployment directory was therefore readable
      // unauthenticated â€” sql/schema.sql, package.json, docs â€” and, because the
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
  // PHASE 12 â€” FINAL JSON API ERROR HANDLER
  // ============================================================
  // REPRODUCED DEFECT (found by probing every registered route against the real
  // server with a malformed JSON body): with no error-handling middleware
  // registered, a body-parser failure fell through to Express's DEFAULT error
  // handler, which answered 400 with an HTML page whose <pre> contained the raw
  // parser message AND â€” outside production â€” the complete server-side stack
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
  // deliberately never echoes err.message to the client â€” the same rule
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
  return app;
}

// --- SECURE HELPERS ---

// Claim IDs were previously 4 digits ('CLM-1000'..'CLM-9999', ~9,000
// possible values) with no collision handling â€” a birthday-paradox
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
          await db.recordPaymentStrike(claim.owner_phone, claim.id);
        }
        // Get updated claim (authoritative state â€” the claim may have been
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
// 'retryable_failure' rows past their scheduled next_attempt_at â€” never
// 'unknown' (an unknown outcome might already have succeeded on the
// provider's side; auto-retrying risks a duplicate post â€” see the
// PublicationOutcome comment in services/social.ts) and never
// 'permanent_failure' (won't succeed on retry without a human fixing
// configuration first). Both of those are left for admin manual retry
// instead (POST /api/admin/social/:id/retry). Only 'found_notice' rows are
// retried here â€” see the SCOPE NOTE on SocialService.retryFoundNoticePost.
// P1: data retention (docs/DATA_RETENTION_POLICY.md). Purges handover
// evidence photos past their documented retention window (default 2
// years past a claim's release) â€” a real, concrete implementation of the
// "automated deletion/anonymization" the policy calls for, rather than
// leaving the whole thing as a document nobody enforces. Deliberately
// narrow in scope: only handover photos, only for status='released'
// claims (a disputed/held claim is never eligible regardless of age â€”
// see the comment on getClaimsWithExpiredHandoverPhotos). The other
// categories in the policy document remain documented-but-not-yet-
// automated by design; each needs its own scoped sweep and its own
// tests, the same way this one was built, rather than one large
// unreviewed sweep across every category at once.
const HANDOVER_PHOTO_RETENTION_DAYS = 730; // 2 years â€” see docs/DATA_RETENTION_POLICY.md
/**
 * N9 â€” the notification retry sweep.
 *
 * Deliberately a thin wrapper: all the real work (claim, reconstruct, dispatch,
 * record) lives in services/notificationRetry.ts, and the sweep's only job is to
 * trigger it on a timer. Wrapped in try/catch exactly like every other sweep in
 * this file so a failure can never take the server process down.
 */
async function notificationRetrySweep() {
  try {
    const outcome = await runNotificationRetrySweep();
    if (outcome.claimed > 0) {
      console.log(`[NOTIFICATION RETRY SWEEP] Claimed ${outcome.claimed}, sent ${outcome.sent}.`);
    }
  } catch (err) {
    console.error('[NOTIFICATION RETRY SWEEP] Sweep failed:', err);
  }
}

async function handoverEvidenceRetentionSweep() {
  try {
    const expiredClaimIds = await db.getClaimsWithExpiredHandoverPhotos(HANDOVER_PHOTO_RETENTION_DAYS);
    for (const claimId of expiredClaimIds) {
      try {
        await db.purgeHandoverPhoto(claimId);
        await db.logAudit('SYSTEM', 'HANDOVER_PHOTO_RETENTION_PURGE', `Claim ${claimId}: handover evidence photo purged â€” past its ${HANDOVER_PHOTO_RETENTION_DAYS}-day retention window per data retention policy.`);
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
        console.log(`[SOCIAL RETRY SWEEP] Skipping ${row.platform} ${row.publication_type} for item ${row.item_id} â€” automatic retry is only implemented for found_notice (see retryFoundNoticePost).`);
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
              await db.recordPaymentStrike(claim.owner_phone, claim.id);
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
    // (status='releasing') by the time this function is called â€” reverting
    // it back to 'pending_settlement' here (the same mechanism already used
    // below for "still outstanding, retry later") is what keeps this safe
    // to call from both the automatic sweep and the admin manual-release
    // endpoint: neither path moves any real money while paused, and the
    // claim isn't left stuck in 'releasing' with nothing to unstick it.
    await db.revertSettlementRelease(claimId);
    await db.logAudit('SYSTEM', 'SETTLEMENT_SKIPPED_PAYOUTS_PAUSED', `Claim ${claimId}: settlement release skipped â€” payouts are paused platform-wide. Reverted to pending_settlement for retry once resumed.`);
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
  // agent ONLY â€” never re-sending to the finder, which would be a
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
      if (!row) continue; // shouldn't happen â€” outstanding was built from these same rows
      await db.recordPayoutAttempt(row.id, {
        status: result.status,
        providerBatchId: payoutResult.batchId,
        providerTransactionId: result.providerTransactionId,
        failureReason: result.status === 'failed' ? 'IntaSend reported this transaction as failed.' : result.status === 'unknown' ? 'Network/timeout error contacting IntaSend â€” outcome unconfirmed.' : null,
      });
      if (result.status === 'failed' || result.status === 'unknown') {
        await db.logAudit('SYSTEM', 'PAYOUT_NOT_CONFIRMED', `Claim ${claimId}: ${result.recipientType} payout status '${result.status}'. Ledger row ${row.id} left pending for retry/reconciliation.`);
      }
    }
  }

  // Re-check actual state after recording results â€” never assume the
  // outcome, re-fetch it.
  const refreshedLedgerRows = await db.getLedgerEntriesForClaim(claimId);
  const stillOutstanding = refreshedLedgerRows.find(
    r => (r.type === 'finder_payout' || r.type === 'agent_payout') && r.status !== 'completed'
  );

  if (stillOutstanding) {
    await db.revertSettlementRelease(claimId);
    return {
      success: false,
      message: `Settlement partially processed â€” ${stillOutstanding.type} is '${stillOutstanding.status}'. Claim reverted to pending_settlement; the next sweep will retry only the outstanding payout(s).`,
    };
  }

  const finalized = await db.finalizeSettlement(claimId);
  if (!finalized.success) {
    // Deliberately NOT reverting here â€” the real M-Pesa payouts already went
    // out (every finder_payout/agent_payout row is confirmed 'completed' at
    // this point). Leaving the claim in 'releasing' keeps it locked and
    // flags it for manual admin reconciliation rather than risking a
    // duplicate payout via an automatic retry.
    await db.logAudit('SYSTEM', 'SETTLEMENT_FINALIZE_DB_FAILURE_AFTER_PAYOUT', `Claim ${claimId}: all payouts confirmed but finalizeSettlement failed: ${finalized.message}. Left in 'releasing' â€” requires manual admin review.`);
    return { success: false, message: 'Payouts confirmed but recording the final settlement failed. Flagged for manual admin review.' };
  }
  // BATCH 3 / P7 - customer notification for the completed claim.
  //
  // Placed here, AFTER the `if (!finalized.success)` early return, so it runs
  // only on the branch where finalizeSettlement actually performed the
  // releasing -> released CAS. `success` is the idempotency guard, so a repeated
  // sweep or an admin re-release that finds the claim already released returns
  // early and never notifies twice. This is also the single choke point that
  // covers BOTH execution paths: the periodic releaseDueSettlements sweep and
  // the admin release-settlement route both reach the claim through here.
  await produceClaimComplete(claimId);
  return finalized;

}

// Runs periodically: finds every claim whose dispute window has closed
// (status='pending_settlement' and settle_at <= now) and, one at a time,
// atomically claims the release lock and executes the real payout. A claim
// that was disputed or admin-frozen during its window is no longer in
// 'pending_settlement' by the time this runs, so it's simply never selected
// â€” no special-case skip logic needed.
async function releaseDueSettlements() {
  try {
    const due = await db.getClaimsDueForSettlement();
    for (const claim of due) {
      try {
        const won = await db.attemptSettlementRelease(claim.id, false);
        if (!won) continue; // lost the CAS race (e.g. an admin already force-released it) â€” fine, skip
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
// all (DB hiccup, etc.), we treat that the same as "paused" â€” never publish
// when uncertain, per the doc's fail-safe principle. Only an explicit,
// successfully-read 'false' allows publishing to proceed.
/**
 * CENTRAL CLAIMABILITY RULE â€” the single source of truth for "can this item
 * currently be claimed." Used by both the public search endpoint (to decide
 * what's even shown) and claim submission (to independently re-verify â€”
 * never trust that something visible in a search result is still
 * claimable by the time the request arrives). Do not duplicate this logic
 * inline anywhere else; if a new claimability condition is needed, add it
 * here once.
 */
  // Section: historical vs. active claims. A claim in one of these statuses
  // is a CLOSED attempt â€” an audit/history record, NOT an active reservation
  // on the item. It must never count as a "competing claimant" below:
  // payment expiry (payment_window_expired) in particular is simple
  // abandonment, and the item's own status ('at_agent') already reflects
  // that it is physically back in the agent's custody and claimable again.
  // Treating an expired payment attempt as a live rival claimant used to
  // file a bogus dispute the moment the legitimate owner (or anyone else)
  // tried again â€” payment expiry is not a dispute and not another claimant.
  //
  // The set itself now lives in config/claimStatuses.ts (moved verbatim in
  // Phase 2) so the customer dashboard's Active/History split groups claims by
  // exactly this rule instead of keeping a second, drifting copy.

async function canCreateClaim(item: FoundItem, preFetchedDisputes?: Dispute[]): Promise<{ allowed: boolean; reason: string }> {
  if (!item) return { allowed: false, reason: 'not_found' };

  // A Finder's report is NOT a verified found item â€” only an Agent's
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
  // dispute per item, and while one is open, no new claims of any kind â€”
  // not just a duplicate from a claimant who's already involved. Without
  // this, a third claimant could slip in after the first two already
  // entered 'disputed' status, since neither of those two claims counts as
  // "active" anymore under the earlier duplicate-detection check alone.
  //
  // PERFORMANCE: a caller iterating many items (the search route) passes
  // preFetchedDisputes from one batched db.getDisputesByItemIds() call
  // instead of every item triggering its own db.getDisputesByItem() query
  // â€” see the comment on that method. Single-item callers (e.g. /pay,
  // /claims/submit) omit it and this falls back to the original per-item
  // query, unchanged.
  const disputes = preFetchedDisputes ?? await db.getDisputesByItem(item.id);
  const hasUnresolvedDispute = disputes.some(d => !d.resolved_at);
  if (hasUnresolvedDispute) {
    return { allowed: false, reason: 'unresolved_dispute' };
  }

  return { allowed: true, reason: 'ok' };
}

// Shared bilingual error messages for canCreateClaim() reasons â€” used
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
// handovers without touching code/infrastructure â€” a real gap for the one
// class of situation (suspected fraud ring, a payment-provider incident, a
// bug actively causing harm) where an admin needs to freeze a specific slice
// of the platform in seconds, not by disabling the whole app. Six
// independent scopes, each its own platform_settings row (via the same
// setSetting()/getSetting() pair â€” audited, admin-only, fail-safe already
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
    console.error(`[EMERGENCY PAUSE CHECK] Failed to read setting '${settingKey}' â€” failing safe (treating as paused):`, err);
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




// ---------------------------------------------------------------------------
// P2-A4 â€” IMPORT GUARD.
//
// This call used to be UNCONDITIONAL, which meant the instant anything
// imported this module the process opened a listening socket, ran the schema
// migration, seeded the admin, started a Vite dev server and launched four
// background sweeps. That is why no runtime HTTP test could ever mount the real
// application: importing it WAS starting it.
//
// Production behaviour is unchanged. `npm run dev` (tsx src/server.ts) and
// `npm start` (node dist/server.cjs) both execute THIS file directly, so
// `process.argv[1]` resolves to this module and the server still boots exactly
// as before. Only an IMPORT by something else â€” a test â€” skips the boot.
//
// The check is deliberately not `require.main === module`: the esbuild bundle
// in dist/ and tsx both satisfy it, but the argv comparison also holds for any
// runner that wraps the entry, and it cannot be fooled by a re-export.
// ---------------------------------------------------------------------------
function isServerEntrypoint(): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    // `__filename` is a CommonJS binding: it exists in the esbuild production
    // bundle (dist/server.cjs, `--format=cjs`) but NOT under tsx, which loads
    // this file as ESM because package.json declares `"type": "module"`.
    // Referencing it there raised ReferenceError, the catch below swallowed it,
    // and the guard therefore reported "not the entrypoint" for `npm run dev` —
    // so the app built no Express app and opened no socket at all. Falling back
    // to `import.meta.url` gives the same module identity for the ESM runners;
    // esbuild rewrites `import.meta.url` to the bundle's own file URL for the
    // node/cjs production build, so both runners agree.
    const selfPath =
      typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);
    return path.resolve(entry) === path.resolve(selfPath);
  } catch {
    return false;
  }
}

if (isServerEntrypoint()) {
  // Fire up full-stack server
  startServer().catch(err => {
    console.error('[CRITICAL] Return4me server boot failed:', err);
  });
} else {
  // Imported, not executed. Constructing the app is now the CALLER's job via
  // createApp() â€” importing this module has no side effect on the process.
  console.log('[RETURN4ME] server.ts imported without booting (entrypoint guard).');
}

// P2-A4 â€” test seam. createApp() builds the REAL app: the same middleware, the
// same route modules, the same error handlers, in the same order, with no
// socket and no background timers. startServer() remains exported and callable
// for the production entrypoint above.
export { startServer, createApp, isServerEntrypoint };
