// VITEST GLOBAL SETUP — OUTBOUND PROVIDER KILL-SWITCH.
//
// WHY THIS FILE EXISTS (a real incident found during the production audit):
// `errorDisclosure.test.ts` calls the real `sendCodeViaSms()` from
// services/auth.ts. That function only takes its safe "SIMULATION" branch
// when `isAtDummy` is true — i.e. when AFRICASTALKING_API_KEY/USERNAME look
// like placeholders. On any machine with a populated `.env` (a developer
// laptop, or any CI runner where real secrets are injected), those keys are
// NOT placeholders, so the test suite initialised the live Africa's Talking
// SDK and actually dispatched a real SMS. Captured verbatim from a real
// `npm test` run during the audit:
//
//   [AFRICASTALKING] Real SMS Service initialized successfully. KeyLength: 77
//   [SMS TEST GATEWAY] Sending live SMS via Africa's Talking to +254700***000
//   [SMS TEST GATEWAY] Africa's Talking response: {"SMSMessageData":
//     {"Message":"Sent to 0/1 ...","Recipients":[{"status":"UserInBlacklist",
//     "statusCode":406}]}}
//
// That send was only stopped by the recipient number happening to be
// blacklisted (statusCode 406). A different test number would have sent a
// real message, to a real handset, billed to the real Return4me account —
// simply by someone running the test suite.
//
// HOW THIS FIXES IT: every outbound third-party credential is forced to an
// obvious placeholder value BEFORE any application module is imported.
// Vitest runs setupFiles ahead of the test file's module graph, and
// `dotenv.config()` (called at import time in auth.ts / social.ts /
// payments.ts / server.ts) does NOT override variables that already exist
// in process.env — so these placeholders win, and every provider client
// initialises in its own built-in simulation/fallback mode.
//
// This is a TEST-ONLY guarantee. It changes no production code path: each
// of these services already has a placeholder-detection branch (isAtDummy,
// isPlaceholderKey, etc.) that this file simply makes deterministic under
// test, instead of depending on whether the machine happens to have a
// populated `.env`.
//
// DELIBERATELY NOT NEUTRALISED HERE: DATABASE_URL. Whether the suite runs
// against real Postgres or the in-memory mock is a separate, consequential
// question (the mock does not enforce NOT NULL constraints, which currently
// masks real schema drift), and silently forcing one or the other from a
// setup file would hide that. It is tracked as its own finding.

// WHY EMPTY STRING RATHER THAN A "REPLACE_WITH_..." PLACEHOLDER STRING:
// the two guard styles in this codebase disagree about what counts as
// unconfigured. `isPlaceholderKey()` (auth/payments/social) treats both an
// empty value AND a REPLACE_WITH_* string as unconfigured — but
// `storage.ts` checks raw truthiness only (`if (!endpoint || !bucket ...)`),
// so a non-empty placeholder would make storage look CONFIGURED and send
// real S3 requests to a bogus endpoint. Empty string is the one value that
// every guard in the codebase reads as "not configured".
//
// It also exactly reproduces the known-good CI state: CI has no `.env` at
// all, and the suite passes there. Setting these to '' makes a developer
// machine behave identically to CI.
//
// Empty string (rather than `delete`) is deliberate: `dotenv.config()` only
// populates keys NOT already present in process.env. An empty string still
// counts as present, so dotenv will not re-populate it from `.env`; a
// deleted key WOULD be re-populated with the real secret.
const UNCONFIGURED = '';

// Every env var that, if it holds a real value, causes an application
// module to make a genuine outbound call (SMS, email, payment, social post)
// during the test run.
const OUTBOUND_PROVIDER_ENV_VARS = [
  // Africa's Talking — SMS. The one that actually fired during the audit.
  'AFRICASTALKING_API_KEY',
  'AFRICASTALKING_USERNAME',
  'AFRICASTALKING_SENDER_ID',
  // IntaSend — M-Pesa payments, payouts and refunds (real money).
  'INTASEND_PUBLISHABLE_KEY',
  'INTASEND_SECRET_KEY',
  'INTASEND_WEBHOOK_SECRET',
  // Resend — transactional email.
  'RESEND_API_KEY',
  // Social publishing — posts to real public channels.
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHANNEL_ID',
  'FACEBOOK_PAGE_ID',
  'FACEBOOK_PAGE_ACCESS_TOKEN',
  'TWITTER_API_KEY',
  'TWITTER_API_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_TOKEN_SECRET',
  // OCR providers — billed external inference calls.
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  // Object storage — writes real objects to a real bucket.
  'STORAGE_ENDPOINT',
  'STORAGE_BUCKET',
  'STORAGE_KEY',
  'STORAGE_SECRET',
  // Sentry — avoids polluting the real error-tracking project with test noise.
  'SENTRY_DSN_BACKEND',
  'VITE_SENTRY_DSN_FRONTEND',
] as const;

for (const key of OUTBOUND_PROVIDER_ENV_VARS) {
  process.env[key] = UNCONFIGURED;
}

// NODE_ENV must never be 'production' during tests: several modules
// deliberately throw fatal startup errors when production is combined with
// placeholder credentials (that fail-closed behaviour is itself tested, by
// individual tests that set NODE_ENV='production' locally and restore it).
process.env.NODE_ENV = 'test';

// The mock-OTP bypass must stay off by default so no test can accidentally
// pass because it accepted the hardcoded '1234'/'4114' development codes.
process.env.ALLOW_MOCK_OTP_BYPASS = 'false';
