import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import https from 'https';
import express from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { createServer as createViteServer } from 'vite';
import { db, FoundItem, Claim, Agent } from './db/database';
import { pool, ensureSchemaUpToDate, isDatabaseConnectionError } from './db/index';
import { AuthService, authenticateJWT, generateToken, verifyToken, toE164Kenyan, hashCode, timingSafeEqualHex, sendCodeViaSms, maskPhoneForLog } from './services/auth';
import { AgentMatchingService, geocodeAddress } from './services/agent';
import { EmailService } from './services/email';
import { PaymentService, isPlaceholderKey } from './services/payments';
import { OcrService } from './services/ocr';
import { uploadBase64Image } from './services/storage';
import { SocialService } from './services/social';
import { computeRecoveryFee } from './services/feeEngine';
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

// Whitelists an Agent row down to what's actually safe to show an owner
// looking up where to collect their item. The full Agent record also
// carries mpesa_till_or_paybill, national_id_hash, refundable_deposit,
// warning_count/last_warning_reason, and id_document_photo_url — none of
// which an owner has any legitimate reason to see, and several of which
// (till number, deposit amount, warning history) are the agent's own
// operational/financial details. Used everywhere an `agent` object is
// returned from an owner-facing, unauthenticated route.
function toOwnerSafeAgentView(agent: any): any {
  if (!agent) return null;
  return {
    id: agent.id,
    business_name: agent.business_name,
    contact_phone: agent.contact_phone,
    location_address: agent.location_address,
    latitude: agent.latitude,
    longitude: agent.longitude,
    rating: agent.rating,
    rating_count: agent.rating_count,
  };
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
const sentryDsnBackend = process.env.SENTRY_DSN_BACKEND;
const isSentryBackendEnabled = sentryDsnBackend && !sentryDsnBackend.includes('REPLACE_WITH') && sentryDsnBackend.trim() !== '';

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
    console.log('[SENTRY] Sentry Backend error tracking with PII scrubbing initialized successfully.');
  } catch (err) {
    console.error('[SENTRY ERROR] Failed to initialize Sentry:', err);
  }
} else {
  console.log('[SENTRY] Missing or placeholder Sentry DSN detected. Sentry Backend error tracking is disabled.');
}


// Startup environment configuration log
console.log('================================================================');
console.log('                   RETURN4ME ENVIRONMENT CHECK                  ');
console.log('================================================================');
console.log(`.env File Detected:      ${realEnvExists ? '✅ Yes' : '❌ No (Using default fallback process envs/example)'}`);
console.log(`DATABASE_URL:            ${process.env.DATABASE_URL ? '✅ Configured' : '❌ Missing'}`);
console.log(`JWT_SECRET:              ${process.env.JWT_SECRET ? '✅ Configured' : '❌ Missing'}`);
console.log(`DOC_HASH_SALT:           ${process.env.DOC_HASH_SALT ? '✅ Configured' : '❌ Missing'}`);
console.log(`ADMIN_PASSCODE:          ${process.env.ADMIN_PASSCODE ? '✅ Configured' : '❌ Missing'}`);
console.log(`INTASEND_PUBLISHABLE:    ${process.env.INTASEND_PUBLISHABLE_KEY ? '✅ Configured' : '❌ Missing'}`);
console.log(`INTASEND_SECRET:         ${process.env.INTASEND_SECRET_KEY ? '✅ Configured' : '❌ Missing'}`);
console.log(`ALLOW_MOCK_OTP_BYPASS:   ${process.env.ALLOW_MOCK_OTP_BYPASS === 'true' ? '⚠️ ENABLED (Insecure)' : '✅ Disabled'}`);
console.log(`GEMINI_API_KEY:          ${process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY' ? '✅ Configured (Real OCR Active)' : '⚠️ Missing or placeholder'}`);
console.log(`GROQ_API_KEY:            ${process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'MY_GROQ_API_KEY' ? '✅ Configured (Secondary OCR Active)' : '⚠️ Missing or placeholder'}`);
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
  console.warn("⚠️  SECURITY WARNING: REAL GOOGLE API KEY DETECTED IN UNCONFIGURED STATE!");
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

const PORT = 3000;

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
      console.log('[DATABASE ENGINE] Categories integrity check: ALL OK ✅');
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
      console.error('[HEALTHCHECK ERROR] Database connection check failed:', err);
      res.status(503).json({
        status: 'error',
        db: 'disconnected',
        error: err.message || String(err),
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
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.get('/api/regions', async (req, res) => {
    try {
      const regions = await db.getDistinctRegions();
      res.json(regions);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/stats', async (req, res) => {
    try {
      const agents = await db.getAgents();
      const activeAgentsCount = agents.filter(a => a.status === 'active').length;
      res.json({ activeAgentsCount });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
  app.post('/api/auth/admin-2fa/setup', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
    }
  });

  // Confirms enrollment: the admin must prove the secret from /setup above
  // actually works before 2FA is turned on and required at login.
  app.post('/api/auth/admin-2fa/confirm', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
    }
  });

  // Disabling 2FA requires re-proving the account password (not just an
  // active session token) — the same standard this codebase already
  // applies to other sensitive account changes, since a stolen/left-open
  // session shouldn't be enough on its own to turn off an account's second
  // factor.
  app.post('/api/auth/admin-2fa/disable', authenticateJWT, async (req, res) => {
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
      res.json({ success: true, message: '2FA imezimwa kwa akaunti hii. / 2FA has been disabled on this account.' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message || String(e) });
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
      res.status(500).json({ error: e.message });
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
      finderPhone,
      createAccount,
      termsAccepted,
      description,
      finderEmail,
      declaredValue,
    } = req.body;

    if (!categoryId || !photoBase64 || !locationDescription || !finderPhone) {
      return res.status(400).json({ error: 'Tafadhali jaza sehemu zote zinazohitajika.' });
    }

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
      const cat = categories.find(c => c.id === categoryId);
      const isSensitive = cat ? (cat.is_sensitive_document !== false) : true;

      // 1. Assign nearest physical Return4me agent
      const numericLat = latitude ? parseFloat(latitude) : null;
      const numericLon = longitude ? parseFloat(longitude) : null;
      
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
      res.status(500).json({ error: e.message });
    }
  });

  // 5. OWNER SEARCH: PRIVACY-MASKED RESULTS
  app.get('/api/items/search', async (req, res) => {
    const { q, categoryId, area } = req.query;

    try {
      const allItems = await db.getItems();
      // Public search must only ever show items that are CURRENTLY
      // claimable — routed through the same canCreateClaim() rule used at
      // claim-submission time, so this list can never drift from what the
      // claim endpoint will actually accept. Previously this allowed
      // 'awaiting_dropoff' items through: a Finder's report on its own,
      // before any Agent has physically verified the item exists. That is
      // not a verified found item and must never be publicly claimable.
      const claimabilityChecks = await Promise.all(allItems.map(async item => ({ item, result: await canCreateClaim(item) })));
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
        const isSensitive = item.is_sensitive_document !== false;
        return {
          id: item.id,
          category_id: item.category_id,
          photo_url: isSensitive ? null : item.photo_url,
          is_sensitive_document: isSensitive,
          document_name_fuzzy: item.isDescriptionOnly ? 'Bidhaa ya Maelezo' : (item.document_name_fuzzy || (isSensitive ? 'Mwenye ID' : 'Bidhaa Bila Hati')),
          location_description: item.location_description,
          description: (item.isDescriptionOnly || !isSensitive) ? item.description : null,
          isDescriptionOnly: item.isDescriptionOnly,
          created_at: item.created_at,
          status: item.status,
          agent: rawAgent ? {
            business_name: rawAgent.business_name,
            rough_area: getRoughArea(rawAgent.location_address),
          } : null,
        };
      });

      res.json(maskedResults);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 6. OWNER CLAIMS: TIERED IDENTITY VERIFICATION
  app.post('/api/claims/submit', async (req, res) => {
    const { itemId, ownerPhone, securityAnswers, verificationTier, idProofBase64, termsAccepted, ownerIdentifyingDetails, ownerEmail } = req.body;

    if (!itemId || !ownerPhone || !securityAnswers) {
      return res.status(400).json({ error: 'Tafadhali jaza maelezo yote ya usajili wa claim.' });
    }

    if (!termsAccepted) {
      return res.status(400).json({ error: 'Ni lazima ukubali Vigezo na Masharti yetu kabla ya kuendelea (You must agree to our Terms and Privacy Policy).' });
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
      {
        const cleanOwnerPhone = ownerPhone.replace(/\s+/g, '');
        const sameOwnerClaim = (await db.getClaims()).find(c => 
          c.item_id === itemId && 
          c.status !== 'disputed' && 
          c.owner_phone && 
          c.owner_phone.replace(/\s+/g, '') === cleanOwnerPhone
        );

        if (sameOwnerClaim) {
          return res.json({
            claim: sameOwnerClaim,
            message: 'Unarejelea claim yako ya awali.',
          });
        }

        const existingClaims = (await db.getClaims()).filter(c => 
          c.item_id === itemId && 
          c.status !== 'disputed' &&
          c.owner_phone &&
          c.owner_phone.replace(/\s+/g, '') !== cleanOwnerPhone
        );

        if (existingClaims.length > 0) {
          const existingClaim = existingClaims[0];
          const newClaimCode = await generateUniqueClaimId();

          // Save duplicate claim as disputed
          const newClaim = await db.createClaim({
            id: newClaimCode,
            item_id: itemId,
            owner_phone: ownerPhone,
            owner_email: ownerEmail || null,
            security_answers: securityAnswers,
            verification_tier: verificationTier || 1,
            status: 'disputed',
            owner_id_proof_url: idProofUrl,
            payment_reference: null,
            owner_identifying_details: ownerIdentifyingDetails || null,
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
            claim: newClaim,
            isDisputed: true
          });
        }
      }

      // Tier 1 Validation: Check security answers (e.g. last 4 digits of the document matches OCR)
      // Skip for non-sensitive items
      let tierPassed = true;
      if (item.is_sensitive_document !== false && item.ocr_extracted_number) {
        const lastDigitsInput = securityAnswers.lastDigits ? securityAnswers.lastDigits.trim().toUpperCase() : '';
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
          owner_phone: ownerPhone,
          owner_email: ownerEmail || null,
          security_answers: securityAnswers,
          verification_tier: isTier3 ? 3 : 2,
          status: 'pending_verification',
          owner_id_proof_url: idProofUrl,
          payment_reference: null,
          owner_identifying_details: ownerIdentifyingDetails || null,
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
        claim,
        warning,
        message: isTier3
          ? 'Thibitisho la Tier 1 na Tier 3 limepita! Tafadhali thibitisha OTP yako ili uendelee kwenye malipo.'
          : (item.is_sensitive_document !== false 
            ? 'Thibitisho la utambulisho (Tier 1) limepita! Tafadhali thibitisha OTP ili uendelee kwenye malipo.'
            : 'Ombi lako limepokelewa! Tafadhali thibitisha OTP yako ili uendelee kwenye malipo.'),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 6b. Tier 2: CLAIM SPECIFIC OTP DISPATCH & VERIFICATION
  app.post('/api/claims/:id/request-otp', otpGlobalLimiter, otpIpLimiter, async (req, res) => {
    const claimId = req.params.id;
    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
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
      res.status(500).json({ error: e.message });
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

      await db.deleteClaimOtp(claimId);
      await db.updateClaimStatus(claimId, 'awaiting_agent_confirmation');

      res.json({
        success: true,
        message: 'Msimbo umethibitishwa kikamilifu! Tafadhali nenda kwa wakala physically ili athibitishe kuwa bidhaa hii ni yako kabla ya kulipa. / Verification code approved! Please visit the agent physically to verify the item belongs to you before initiating payment.',
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 7. INTASEND M-PESA STK PUSH & WEBHOOKS
  app.post('/api/claims/:id/pay', async (req, res) => {
    const claimId = req.params.id;
    const { phone } = req.body;

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
      // logged in), but that means the only thing standing between an
      // attacker and triggering an M-Pesa STK push to an arbitrary Kenyan
      // number is knowing/guessing a claim ID. `phone` in the body used to
      // silently override the claim's real owner_phone with no check at
      // all — so anyone who found or brute-forced a claim ID sitting in
      // 'pending_payment' could spam an unrelated third party's phone with
      // STK push prompts. It's still accepted (an owner may be paying from
      // a different handset than the one they registered), but it must
      // resolve to the same person: normalized to E.164 and compared
      // against the claim's own owner_phone before being used.
      if (phone) {
        const normalizedInput = toE164Kenyan(String(phone).replace(/\s+/g, ''));
        const normalizedOwner = toE164Kenyan(String(claim.owner_phone || '').replace(/\s+/g, ''));
        if (normalizedInput !== normalizedOwner) {
          return res.status(403).json({
            error: 'Nambari ya simu uliyoweka hailingani na iliyotumiwa kutengeneza claim hii. / The phone number provided does not match the one used to create this claim.'
          });
        }
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
      await db.updateClaimStatus(claimId, 'pending_payment', paymentResult.checkoutRequestId);

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
      res.status(500).json({ error: e.message });
    }
  });

  // 7a. Look up existing claim by Claim ID and Owner Phone
  app.post('/api/claims/lookup', async (req, res) => {
    const { claimId, phone } = req.body;
    if (!claimId || !phone) {
      return res.status(400).json({ error: 'Msimbo wa claim (Claim ID) na nambari ya simu zinahitajika.' });
    }

    try {
      const cleanClaimId = String(claimId).trim().toUpperCase();
      const cleanPhone = String(phone).replace(/\s+/g, '');
      const e164Phone = toE164Kenyan(cleanPhone);

      const claim = await db.getClaim(cleanClaimId);
      if (!claim) {
        return res.status(404).json({ error: 'Hakuna claim iliyopatikana yenye msimbo huo. Tafadhali hakikisha msimbo ni sahihi.' });
      }

      const claimPhoneClean = claim.owner_phone ? claim.owner_phone.replace(/\s+/g, '') : '';
      if (claimPhoneClean !== cleanPhone && claimPhoneClean !== e164Phone && toE164Kenyan(claimPhoneClean) !== e164Phone) {
        return res.status(403).json({ error: 'Nambari ya simu uliyoweka hailingani na iliyotumiwa kutengeneza claim hii.' });
      }

      const item = await db.getItem(claim.item_id);
      let agent = null;
      if (item && item.assigned_agent_id) {
        agent = await db.getAgent(item.assigned_agent_id);
      }

      res.json({
        success: true,
        claim,
        item,
        agent: toOwnerSafeAgentView(agent),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 7b. Submit user rating for an agent from the owner portal
  app.post('/api/claims/:id/rate', async (req, res) => {
    const claimId = req.params.id;
    const { userRating } = req.body;

    try {
      const claim = await db.getClaim(claimId);
      if (!claim) {
        return res.status(404).json({ error: 'Claim haikupatikana.' });
      }

      const item = await db.getItem(claim.item_id);
      if (!item) {
        return res.status(404).json({ error: 'Bidhaa inayodaiwa haikupatikana.' });
      }

      if (!item.assigned_agent_id) {
        return res.status(400).json({ error: 'Hakuna hub/wakala aliyepangiwa bidhaa hii.' });
      }

      if (userRating) {
        const ratingVal = parseFloat(String(userRating));
        if (!isNaN(ratingVal) && ratingVal >= 1 && ratingVal <= 5) {
          await db.rateAgent(item.assigned_agent_id, ratingVal);
        }
      }

      res.json({ success: true, message: 'Ukadiriaji umewasilishwa kikamilifu! Ahsante.' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET lightweight claim status for frontend polling
  // SECURITY: this endpoint is deliberately unauthenticated — it's polled
  // every 3 seconds by the owner's browser during claim submission and
  // payment, before any login exists for owners. It used to return the
  // ENTIRE raw claim row, including `security_answers` (the exact
  // last-4-digits/color/lost-details answers used to verify someone is the
  // real owner), `owner_phone`, `owner_email`, `owner_identifying_details`,
  // and `owner_id_proof_url`. Anyone who obtained a claim ID — from a URL,
  // an SMS, a shared screenshot, or simple enumeration — could read the
  // correct security answers for that claim and use them to impersonate
  // the real owner on a future claim, plus pull their phone/email/ID-proof
  // link. The frontend polling loops (OwnerView.tsx) only ever read
  // `id`, `status`, and `agent_confirmed_at` from the response, so that's
  // now the entire whitelist returned here.
  app.get('/api/claims/:id/status', async (req, res) => {
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
      const item = await db.getItem(claim.item_id);
      let agent = null;
      if (item) {
        agent = await db.getAgent(item.assigned_agent_id);
      }
      res.json({
        status: claim.status,
        claim: {
          id: claim.id,
          status: claim.status,
          agent_confirmed_at: claim.agent_confirmed_at,
        },
        agent: toOwnerSafeAgentView(agent),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Core logic for confirming a claim's payment and moving it to escrow.
  // Shared by the real IntaSend webhook AND the dev-only test-payment
  // simulator below, so both paths run through the exact same business
  // logic — no duplicated/diverging implementation between "real" and
  // "simulated" payment confirmation.
  async function processClaimPaymentConfirmed(claimId: string, invoiceId: string): Promise<string | null> {
    // Atomic compare-and-swap: only the delivery that actually wins the
    // 'pending_payment' -> 'escrow_held' transition proceeds past this
    // point. A duplicate/retried webhook for an already-confirmed claim
    // returns false here and is dropped as a no-op, instead of re-running
    // the confirmation flow (new pickup code, duplicate emails/SMS) a
    // second time.
    const won = await db.attemptClaimEscrowHold(claimId, invoiceId);
    if (!won) return null;

    const claim = await db.getClaim(claimId);
    if (!claim) return null;
    const item = await db.getItem(claim.item_id);
    if (!item) return null;

    await db.updateItemStatus(item.id, 'at_agent');

    // Resolve as first-successfully-paid for non-sensitive items: Auto-reject other claims
    if (item.is_sensitive_document === false) {
      const otherClaims = (await db.getClaims()).filter(c => c.item_id === item.id && c.id !== claimId);
      for (const oc of otherClaims) {
        await db.updateClaimStatus(oc.id, 'rejected', 'System Auto-Rejected: Another claimant successfully paid first.');
      }
    }

    // Pre-fetch metadata for emails
    const categories = await db.getCategories();
    const cat = categories.find(c => c.id === item.category_id);
    const itemName = cat ? cat.name_en : 'Found Document / Item';
    const agent = await db.getAgent(item.assigned_agent_id);

    let resolvedFee = cat ? cat.total_fee : '0.00';
    if (item && item.locked_total_fee !== undefined && item.locked_total_fee !== null) {
      resolvedFee = String(item.locked_total_fee);
    }

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

    console.log('[INTASEND WEBHOOK] Received callback event:', JSON.stringify(payload, null, 2));

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
        if (computed === signatureHeader) {
          isValid = true;
        }
      }

      // Method 2: Check embedded signature
      if (!isValid && payload.signature) {
        const { signature, ...rest } = payload;
        const computed = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(rest)).digest('hex');
        if (computed === signature) {
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

    const { invoice_id, state, api_ref } = payload;
    const claimId = api_ref;

    if (claimId && (state === 'COMPLETE' || state === 'COMPLETED' || state === 'SUCCESS')) {
      try {
        await processClaimPaymentConfirmed(claimId, invoice_id);
      } catch (err: any) {
        console.error('[INTASEND WEBHOOK] Error handling claim payment webhook update:', err);
        return res.status(500).json({ error: err.message });
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
  // requiring an actual M-Pesa transaction. Hard-gated off in production and
  // behind the same flag that enables OTP bypass, so it can never be live.
  app.post('/api/dev/simulate-payment/:claimId', async (req, res) => {
    if (process.env.NODE_ENV === 'production' || process.env.ALLOW_MOCK_OTP_BYPASS !== 'true') {
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
      res.status(500).json({ error: e.message });
    }
  });

  // Lets the frontend know whether dev/test conveniences (OTP bypass, the
  // simulate-payment button) are active, without hardcoding that assumption
  // client-side or exposing it in production.
  app.get('/api/dev/test-mode', (req, res) => {
    res.json({
      testModeEnabled: process.env.NODE_ENV !== 'production' && process.env.ALLOW_MOCK_OTP_BYPASS === 'true',
    });
  });

  // 8. AGENT HUB QUEUES
  app.get('/api/agents/queue', authenticateJWT, async (req, res) => {
    try {
      if (req.user?.role !== 'agent' || !req.user.agentId) {
        return res.status(403).json({ error: 'Ufikiaji umekataliwa. Sio Return4me Agent aliyeidhinishwa.' });
      }

      const agentId = req.user.agentId;
      const agent = await db.getAgent(agentId);
      if (!agent || agent.status !== 'active') {
        return res.status(403).json({ error: 'Akaunti yako ya Agent bado haijaidhinishwa au imesitishwa.' });
      }

      // Get items assigned to this agent
      const allItems = await db.getItems();
      const items = allItems.filter(i => i.assigned_agent_id === agentId);
      
      const rawClaims = await db.getClaims();
      const allClaims = [];
      for (const claim of rawClaims) {
        allClaims.push(await checkClaimExpiry(claim));
      }
      const claims = allClaims.filter(c => items.some(i => i.id === c.item_id));

      const earnings = await db.getAgentEarnings(agentId);

      res.json({
        agent,
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
            associatedClaim,
          };
        }),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
  app.post('/api/agents/verify-item', authenticateJWT, async (req, res) => {
    const { dropoffCode, categoryId, name, documentNumber, description, foundArea, reason, reasonDetail, physicallyVerified } = req.body;

    try {
      if (req.user?.role !== 'agent' || !req.user.agentId) {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

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
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/confirm-dropoff', authenticateJWT, async (req, res) => {
    const { dropoffCode } = req.body;

    try {
      if (req.user?.role !== 'agent' || !req.user.agentId) {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

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
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/reject-dropoff', authenticateJWT, async (req, res) => {
    const { dropoffCode, reason } = req.body;

    if (!dropoffCode || !reason || !reason.trim() || /^Other:\s*$/i.test(reason.trim())) {
      return res.status(400).json({ error: 'Msimbo wa drop-off na sababu vinahitajika.' });
    }

    try {
      if (req.user?.role !== 'agent' || !req.user.agentId) {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

      const item = await db.getItem(dropoffCode);
      if (!item) {
        return res.status(404).json({ error: 'Msimbo wa kuwasilisha (Drop-off code) si sahihi.' });
      }

      if (item.assigned_agent_id !== req.user.agentId) {
        return res.status(403).json({ error: 'Bidhaa hii haijapangiwa physical hub yako.' });
      }

      await db.rejectItem(dropoffCode, reason);
      res.json({ success: true, message: 'Bidhaa imekataliwa na kuondolewa kwenye mfumo.' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/claims/:claimId/confirm-viewing', authenticateJWT, async (req, res) => {
    const claimId = req.params.claimId;

    try {
      if (req.user?.role !== 'agent' || !req.user.agentId) {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

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

      // Update status and agent_confirmed_at
      await db.updateClaimStatus(claimId, 'pending_payment', undefined, new Date());

      // Log an audit entry
      await db.logAudit(
        `AGENT_${req.user.agentId}`,
        'AGENT_CONFIRMED_VIEWING',
        `Agent ${req.user.agentId} confirmed in-person viewing for claim ${claimId} and item ${item.id}`
      );

      // Get updated claim to return
      const updatedClaim = await db.getClaim(claimId);
      res.json({ success: true, claim: updatedClaim });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/confirm-handover', authenticateJWT, async (req, res) => {
    const { claimId, userRating, pickupCode } = req.body;

    try {
      if (req.user?.role !== 'agent' || !req.user.agentId) {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

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
      // SMS/email when payment was confirmed) before releasing any money.
      // Without this, an agent could confirm handover — and trigger the payout
      // — without the item ever actually being given to the verified owner.
      if (!pickupCode || typeof pickupCode !== 'string' || pickupCode.trim() === '') {
        return res.status(400).json({ error: 'Muulize mmiliki msimbo wake wa siri wa kuchukua bidhaa kabla ya kuendelea. / Ask the owner for their secret pickup code before proceeding.' });
      }

      // Require a handover evidence photo (the claimant holding the item,
      // ideally alongside their own ID) before any payout can be triggered.
      // This is the platform's main defense against an agent colluding with
      // someone who is not the real owner: a colluding agent now has to
      // actively produce and submit fabricated evidence rather than simply
      // clicking a button with no record at all, and a genuine dispute later
      // has something concrete to review.
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

      const pickupRecord = await db.getPickupCode(claimId);
      if (!pickupRecord) {
        return res.status(400).json({ error: 'Msimbo wa kuchukua haujaanzishwa kwa dai hili. / No pickup code has been issued for this claim yet.' });
      }
      if (!timingSafeEqualHex(hashCode(pickupCode.trim()), pickupRecord.code_hash)) {
        return res.status(400).json({ error: 'Msimbo wa siri wa kuchukua si sahihi. Muulize mmiliki tena. / The secret pickup code is incorrect. Ask the owner again.' });
      }
      await db.markPickupCodeVerified(claimId);

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
      res.status(500).json({ error: e.message });
    }
  });

  // 10. ADMIN DASHBOARD & CONTROLS
  app.get('/api/admin/dashboard', authenticateJWT, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }

      const agents = await db.getAgents();
      const items = await db.getItems();
      const claims = await db.getClaims();
      const disputes = await db.getDisputes();
      const ledger = await db.getLedger();

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
        return {
          ...item,
          reputation: { total_reports: counts.total, rejected_reports: counts.rejected, autoFlag },
        };
      });

      // Computations
      const stats = {
        pendingAgentsCount: agents.filter(a => a.status === 'pending').length,
        itemsInReviewCount: items.filter(i => i.status === 'awaiting_dropoff').length,
        itemsAtAgentCount: items.filter(i => i.status === 'at_agent').length,
        escrowHeldCount: claims.filter(c => c.status === 'escrow_held').length,
        disputesOpenCount: disputes.filter(d => !d.resolved_at).length,
        totalRevenue: ledger.filter(l => l.type === 'platform_fee' && l.status === 'completed').reduce((sum, l) => sum + l.amount, 0),
      };

      // Attach each agent's total earnings (their share of completed
      // escrow releases) so admin can see who's earning what without a
      // separate request per agent — built from data already loaded above.
      const completedAgentPayouts = ledger.filter(l => l.type === 'agent_payout' && l.status === 'completed');
      const agentsWithEarnings = agents.map(agent => {
        const agentItemIds = new Set(items.filter(i => i.assigned_agent_id === agent.id).map(i => i.id));
        const payouts = completedAgentPayouts.filter(l => l.item_id && agentItemIds.has(l.item_id));
        return {
          ...agent,
          total_earned: payouts.reduce((sum, l) => sum + l.amount, 0),
          completed_payouts_count: payouts.length,
        };
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

      res.json({
        stats,
        agents: agentsWithEarnings,
        disputes,
        items: itemsWithReputation,
        ledger,
        pendingSettlements,
        auditLogs: await db.getAuditLogs(),
        currentAdminTotpEnabled: !!currentAdmin?.totp_enabled,
        socialPublishingPaused: await isSocialPublishingPaused(),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/agents/:id/approve', authenticateJWT, async (req, res) => {
    const agentId = req.params.id;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.approveAgent(agentId, adminIdentifier);
      res.json({ success: true, message: 'Return4me Agent amethibitishwa na kuruhusiwa kuanza kazi.' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manually set or correct an agent's GPS coordinates. Needed because agent
  // signup only geocodes a free-text address automatically — when that fails
  // (common with informal Kenyan addresses) or is wrong, this is the only way
  // to fix it so the agent becomes matchable by the nearest-agent algorithm.
  app.post('/api/admin/agents/:id/location', authenticateJWT, async (req, res) => {
    const agentId = req.params.id;
    const { latitude, longitude } = req.body;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const lat = parseFloat(latitude);
      const lon = parseFloat(longitude);
      if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return res.status(400).json({ error: 'Latitude/longitude si sahihi. / Invalid latitude/longitude.' });
      }
      const agent = await db.getAgent(agentId);
      if (!agent) {
        return res.status(404).json({ error: 'Agent haikupatikana.' });
      }
      const updated = await db.updateAgentLocation(agentId, lat, lon);
      await db.logAudit(
        req.user?.username || req.user?.userId || 'admin',
        'AGENT_LOCATION_MANUALLY_SET',
        `Admin manually set coordinates for agent ${agent.business_name} (${agentId}) to ${lat}, ${lon}`
      );
      res.json({ success: true, agent: updated, message: 'Mahali pa Agent pamesasishwa. / Agent location updated.' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/agents/:id/suspend', authenticateJWT, async (req, res) => {
    const agentId = req.params.id;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      await db.suspendAgent(agentId, adminIdentifier);
      res.json({ success: true, message: 'Return4me Agent amesimamishwa kazi kwa muda.' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/agents/:id/warn', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  });

  // Admin-only, on-demand (not bundled into the main dashboard payload,
  // which every admin page-load fetches — evidence can include photos and
  // is only actually needed when an admin opens a specific dispute).
  app.get('/api/admin/disputes/:disputeId/evidence', authenticateJWT, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const evidence = await db.getDisputeEvidenceForDispute(req.params.disputeId);
      res.json({ success: true, evidence });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/disputes/resolve', authenticateJWT, async (req, res) => {
    const { disputeId, winningClaimId, adminNotes } = req.body;
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }
      const adminIdentifier = req.user?.username || req.user?.userId || 'admin';
      const result = await db.resolveDispute(disputeId, winningClaimId, adminIdentifier, adminNotes);

      // If the losing claimant had already paid into escrow, they were
      // locked into 'refunding' by resolveDispute above. Trigger the real
      // M-Pesa refund now — outside the DB transaction, since it's a
      // network call to IntaSend — and only mark the refund complete once
      // the transfer actually succeeds. A failure here does NOT roll back
      // the dispute decision (the winner has already been decided); it
      // reverts just the loser's claim to 'escrow_held' and flags it in
      // the audit log for manual admin reconciliation, exactly like a
      // failed payout during normal escrow release.
      if (result.refundNeededForClaimId && result.refundAmount && result.refundPhone) {
        const refundResult = await PaymentService.triggerIntasendRefund(
          result.refundPhone,
          parseFloat(result.refundAmount),
          result.refundNeededForClaimId
        );
        if (refundResult.success) {
          await db.finalizeClaimRefund(result.refundNeededForClaimId, result.refundAmount, result.refundPhone);
        } else {
          await db.revertClaimRefundLock(result.refundNeededForClaimId, 'IntaSend refund disbursement failed or timed out');
          return res.status(207).json({
            success: true,
            message: 'Mzozo umetatuliwa, lakini urejeshaji wa fedha wa mdai aliyeshindwa umeshindwa kufaulu. Msimamizi anahitaji kufuatilia kwa mkono. / Dispute resolved, but the losing claimant\'s refund failed to go through. Manual admin follow-up is required.',
            refundFailed: true,
          });
        }
      }

      res.json({ success: true, message: 'Mzozo umetatuliwa kikamilifu kulingana na ushahidi uliowasilishwa.' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/items/:id/review', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
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
  app.post('/api/admin/settings/social-publishing-pause', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/claims/:id/release-settlement', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
    }
  });

  // --- STOLEN-PROPERTY STATE MACHINE (admin-only) ---
  // The platform does not adjudicate criminal guilt. These endpoints only
  // ever change an item's claimability/visibility; no public accusation is
  // ever attached to a person, and the underlying report is always routed
  // to the appropriate authorities outside the platform.
  app.post('/api/admin/items/:id/flag-stolen', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/items/:id/legal-hold', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/items/:id/clear-hold', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/items/:id/reject', authenticateJWT, async (req, res) => {
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

      await db.rejectItem(itemId, reason || 'Admin manual review rejection');
      res.json({ success: true, message: 'Item rejected successfully.' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/reputations/:phone/clear', authenticateJWT, async (req, res) => {
    const phone = req.params.phone;

    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

      await db.clearPhoneReputation(phone);
      res.json({ success: true, message: `Reputation flag manually cleared for ${phone}.` });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/admin/payment-strikes', authenticateJWT, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa imekataliwa.' });
      }

      const strikes = await db.getAllPaymentStrikes();
      res.json({ success: true, strikes });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/payment-strikes/:phone/clear', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
    }
  });

  // 10B. ADMIN CATEGORIES MANAGEMENT
  app.get('/api/admin/categories', authenticateJWT, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Ruhusa hii ni ya Wasimamizi (Admins) tu.' });
      }
      const categories = await db.getCategoriesWithUsage();
      res.json(categories);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/categories', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/categories/:id', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/admin/categories/:id', authenticateJWT, async (req, res) => {
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
      res.status(500).json({ error: e.message });
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
      if (req.path.startsWith('/src/')) {
        const fullPath = path.join(process.cwd(), req.path);
        if (fs.existsSync(fullPath)) {
          if (fullPath.endsWith('.tsx') || fullPath.endsWith('.ts') || fullPath.endsWith('.jsx')) {
            res.setHeader('Content-Type', 'text/javascript');
          }
          return res.sendFile(fullPath);
        } else {
          res.setHeader('Content-Type', 'text/javascript');
          return res.send(`/* Source file ${path.basename(req.path)} is not included in the production build */`);
        }
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[RETURN4ME SERVER] Running on http://0.0.0.0:${PORT}`);
    // Start background sweep for payment window expiry every 60 seconds
    setInterval(expireStaleClaims, 60000);
    // Start background sweep for due settlements (dispute window closed) every 5 minutes
    setInterval(releaseDueSettlements, 5 * 60 * 1000);
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
        await db.updateClaimStatus(claim.id, 'payment_window_expired');
        await db.recordPaymentStrike(claim.owner_phone);
        // Get updated claim
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
            await db.updateClaimStatus(claim.id, 'payment_window_expired');
            await db.recordPaymentStrike(claim.owner_phone);
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
async function canCreateClaim(item: FoundItem): Promise<{ allowed: boolean; reason: string }> {
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
  const disputes = await db.getDisputesByItem(item.id);
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
  try {
    const value = await db.getSetting('social_publishing_paused');
    return value === 'true';
  } catch (err) {
    console.error('[SOCIAL PUBLISHING PAUSE CHECK] Failed to read setting — failing safe (treating as paused):', err);
    return true;
  }
}

function hashDocument(value: string): string {
  const normalizedValue = value.trim().toUpperCase();
  const salt = process.env.DOC_HASH_SALT || process.env.JWT_SECRET || 'RETURN4ME_DEFAULT_SALT_VALUE_FOR_DOCUMENT_HASHING';
  return crypto
    .createHmac('sha256', salt)
    .update(normalizedValue)
    .digest('hex');
}

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

function getRoughArea(address: string): string {
  if (!address) return 'Nairobi';
  const parts = address.split(',');
  if (parts.length > 0 && parts[0].trim().length > 3) {
    return parts[0].trim();
  }
  const words = address.split(/\s+/).slice(0, 3).join(' ');
  return words || 'Nairobi';
}

// Fire up full-stack server
startServer().catch(err => {
  console.error('[CRITICAL] Return4me server boot failed:', err);
});
