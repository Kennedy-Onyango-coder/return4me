import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// Load main .env
dotenv.config();

// Fall back to .env.example ONLY in non-production environments if required variables are missing
if (process.env.NODE_ENV !== 'production') {
  if (!process.env.JWT_SECRET) {
    const fallbackPath = path.resolve(process.cwd(), '.env.example');
    if (fs.existsSync(fallbackPath)) {
      dotenv.config({ path: fallbackPath });
    }
  }
}

// @ts-ignore
import AfricaTalking from 'africastalking';

function sanitizeEnvValue(val?: string): string {
  if (!val) return '';
  let trimmed = val.trim();
  trimmed = trimmed.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  return trimmed.trim();
}

export function toE164Kenyan(phone: string): string {
  let clean = phone.replace(/\s+/g, '');
  if (clean.startsWith('07') && clean.length === 10) {
    return '+254' + clean.slice(1);
  }
  if (clean.startsWith('01') && clean.length === 10) {
    return '+254' + clean.slice(1);
  }
  if (clean.startsWith('254') && clean.length === 12) {
    return '+' + clean;
  }
  if (clean.startsWith('+254')) {
    return clean;
  }
  return clean;
}

/**
 * Masks a phone number for logging — keeps enough to trace/correlate a
 * specific request in operational logs without printing the full number.
 * "+254712345678" -> "+254712***678". Never use the raw phone number in a
 * console.log/console.error call; use this instead.
 */
export function maskPhoneForLog(phone: string | null | undefined): string {
  if (!phone) return '(no phone)';
  const clean = phone.toString().replace(/\s+/g, '');
  if (clean.length < 7) return '***'; // too short to safely partially reveal
  return clean.slice(0, -6) + '***' + clean.slice(-3);
}

import { isPlaceholderKey } from './payments';

const atApiKey = sanitizeEnvValue(process.env.AFRICASTALKING_API_KEY);
const atUsername = sanitizeEnvValue(process.env.AFRICASTALKING_USERNAME);
const atSenderId = sanitizeEnvValue(process.env.AFRICASTALKING_SENDER_ID);

const isAtDummy = isPlaceholderKey(atApiKey) || isPlaceholderKey(atUsername);

// Explicit live-SMS enable switch. Live SMS may only be sent when this is
// explicitly "true". Missing/invalid/false => SMS is treated as DISABLED
// (console simulation in non-production; an explicit non-delivery failure in
// production so the caller is never led to believe an SMS was sent when it was
// not). This makes accidental real SMS (and accidental billing) impossible:
// presence of keys alone no longer enables live delivery, matching the rest of
// the codebase's "production behavior must be explicit" pattern.
const smsEnabled = process.env.SMS_ENABLED === 'true';

let atSMSClient: any = null;

if (!isAtDummy) {
  try {
    const at = AfricaTalking({
      apiKey: atApiKey,
      username: atUsername,
    });
    atSMSClient = at.SMS;
    console.log(`[AFRICASTALKING] Real SMS Service initialized successfully. Username: "${atUsername}", SenderID: "${atSenderId || '(none)'}", KeyLength: ${atApiKey.length}`);
  } catch (err) {
    console.error('[AFRICASTALKING ERROR] Failed to initialize SDK:', err);
  }
} else {
  console.log('[AFRICASTALKING] Placeholder or missing keys detected. Running in console-only fallback mode.');
}

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/database.ts';

// Enforce strict presence and length of JWT_SECRET at startup ONLY in production
const JWT_SECRET = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production') {
  if (!JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET environment variable is missing. The app refuses to boot.');
  }
  if (JWT_SECRET.length < 32) {
    throw new Error('FATAL: JWT_SECRET must be at least 32 characters long. The app refuses to boot.');
  }
  if (
    JWT_SECRET.includes('REPLACE_WITH') ||
    JWT_SECRET.includes('PLACEHOLDER') ||
    JWT_SECRET === 'REPLACE_WITH_STRONG_RANDOM_VALUE_MIN_32_CHARS'
  ) {
    throw new Error('FATAL: JWT_SECRET is set to a default placeholder value. For production security, please configure a real high-entropy secret.');
  }
} else {
  if (!JWT_SECRET) {
    console.warn('WARNING: JWT_SECRET environment variable is missing in development.');
  } else if (
    JWT_SECRET.length < 32 ||
    JWT_SECRET.includes('REPLACE_WITH') ||
    JWT_SECRET.includes('PLACEHOLDER') ||
    JWT_SECRET === 'REPLACE_WITH_STRONG_RANDOM_VALUE_MIN_32_CHARS'
  ) {
    console.warn('WARNING: JWT_SECRET is using a default placeholder or short value in development. Please configure a real high-entropy secret in production.');
  }
}

// Codes (OTPs and claim pickup codes) are never stored in plaintext — this
// hashes them with HMAC-SHA256 keyed on JWT_SECRET before they touch the
// database or persist anywhere. Exported so server.ts can hash/verify claim
// pickup codes with the exact same function.
export function hashCode(code: string): string {
  return crypto.createHmac('sha256', JWT_SECRET || 'dev-fallback-secret').update(code).digest('hex');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface SessionPayload {
  userId: string;
  phone: string;
  // 'admin_pending_2fa' is deliberately a distinct, separate role — not a
  // flag on the 'admin' role — so it fails every existing admin route's
  // `req.user?.role !== 'admin'` check automatically, with no changes
  // needed to any of those routes. A token issued after password-only
  // verification (before the TOTP step) can therefore never be used to
  // reach real admin functionality, even if intercepted; the only thing
  // it can do is attempt the second-factor verification endpoint.
  role: 'owner' | 'finder' | 'agent' | 'admin' | 'admin_pending_2fa';
  agentId?: string;
  username?: string;
  // Session-revocation (P0): the admin_users.token_version value that was
  // current at the moment this token was issued. Every admin route
  // re-compares this against the account's CURRENT token_version on each
  // request (see requireCurrentAdminSession in server.ts) — a mismatch
  // means something security-sensitive happened to the account since this
  // token was issued (2FA disabled, account suspended, etc.), and the
  // token is rejected even though it's still validly signed and unexpired.
  // Only meaningful for role 'admin' / 'admin_pending_2fa'; absent for
  // other roles.
  tokenVersion?: number;
}

// Helper to sign session payloads as a real JWT. expiresIn defaults to the
// normal 24h session length; the admin 2FA pending-step token overrides
// this to a short window since it should never be a long-lived credential.
export function generateToken(payload: SessionPayload, expiresIn: string = '24h'): string {
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: expiresIn as any });
}

// Helper to verify JWT tokens
export function verifyToken(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as any;
    if (!decoded || typeof decoded !== 'object') return null;
    return {
      userId: decoded.userId,
      phone: decoded.phone,
      role: decoded.role,
      agentId: decoded.agentId,
      username: decoded.username,
      // P0 propagation fix: the SessionPayload embeds the admin_users
      // token_version current at issuance (see SessionPayload.tokenVersion and
      // server.ts's admin-login routes). requireCurrentAdminSession re-checks
      // that version against the live account on EVERY request — but if it is
      // dropped here, req.user.tokenVersion becomes undefined and
      // isAdminSessionCurrent() fails closed ("typeof undefined !== 'number'").
      // Every validly-signed admin token was therefore rejected the instant it
      // reached the first protected admin route, which is exactly the
      // "admin login accepted, then immediately logged out" symptom. Preserve
      // the already-verified value exactly; absent/undefined stays absent so
      // stale pre-version tokens still fail closed.
      tokenVersion: decoded.tokenVersion,
    };
  } catch (e) {
    return null;
  }
}


// --- AUTH SERVICES ---

const SMS_UNAVAILABLE_MESSAGE =
  'Imeshindwa kutuma SMS. Tafadhali jaribu tena au tumia njia nyingine. / SMS delivery is temporarily unavailable. Please try again or use another method.';

/**
 * Normalizes an Africa's Talking SMS `send()` response into a safe,
 * caller-facing result. Africa's Talking resolves (does NOT throw) for many
 * per-recipient rejections — most importantly a `UserInBlacklist` recipient,
 * which the SDK reports inside `SMSMessageData.Recipients` (statusCode 406).
 * The classic success statusCode is 101. Treating a resolved promise as
 * "delivered" would therefore report a blacklisted recipient as success:true.
 *
 * Rules:
 *  - If any recipient reports an accepted/success code, the send is success.
 *  - Otherwise, if any recipient reports blacklist (406 / "blacklist"), the
 *    send FAILED and is NOT retryable by the application.
 *  - Other explicit non-success recipient statuses => failure, retryable.
 *  - A response with no recipient-level detail is treated as accepted (we
 *    cannot prove rejection) but the sender logs the raw payload for
 *    reconciliation.
 * Returns only normalized fields — never the raw provider payload.
 */
export function normalizeAtSmsResult(
  response: any
): { success: boolean; failureReason: string | null; retryable: boolean } {
  const recipients =
    response?.SMSMessageData?.Recipients ??
    (Array.isArray(response?.Recipients) ? response.Recipients : null) ??
    (Array.isArray(response) ? response : null);

  if (!Array.isArray(recipients) || recipients.length === 0) {
    // No recipient-level detail returned — we cannot confirm rejection, and we
    // must not invent one. Treat as accepted; the caller logs the raw response.
    return { success: true, failureReason: null, retryable: false };
  }

  let anyAccepted = false;
  let blacklisted = false;
  let rejected = false;

  for (const r of recipients) {
    const status = String(r?.status ?? '').trim().toLowerCase();
    const code = r?.statusCode;
    const isAccepted =
      status === 'success' ||
      status === 'sent' ||
      status === 'accepted' ||
      status === 'queued' ||
      Number(code) === 101 ||
      Number(code) === 104;
    if (isAccepted) {
      anyAccepted = true;
    } else if (status.includes('blacklist') || Number(code) === 406) {
      blacklisted = true;
    } else if (status !== '' && status !== 'pending') {
      rejected = true;
    }
  }

  if (anyAccepted) return { success: true, failureReason: null, retryable: false };
  if (blacklisted) {
    return { success: false, failureReason: 'blacklisted_recipient', retryable: false };
  }
  if (rejected) {
    return { success: false, failureReason: 'provider_rejected', retryable: true };
  }
  // Recipients present but no resolvable disposition — safest to treat as
  // accepted (no evidence of rejection) and log for reconciliation.
  return { success: true, failureReason: null, retryable: false };
}

/**
 * Sends a numeric code to a Kenyan phone number via SMS — shared by both
 * phone-verification OTP (requestOTP below) and claim-specific OTP
 * (POST /api/claims/:id/request-otp in server.ts). Deliberately takes an
 * already-generated code rather than generating one itself, since the two
 * callers store it against different tables (phone number vs claim ID)
 * with different expiry/attempt semantics — this function only owns
 * actual delivery, not code generation or persistence.
 *
 * Live SMS is sent only when BOTH real credentials AND SMS_ENABLED=true are
 * configured. In simulation/dev fallback mode (no credentials, or SMS_ENABLED
 * not true and non-production), the code is printed to the console with an
 * unmistakable "SIMULATION" label — the ONLY path that ever logs a real OTP
 * code. In production, when SMS cannot actually be delivered
 * (SMS_ENABLED missing/false or no provider configured), this returns failure
 * so the caller is never told an SMS was sent when it was not.
 */
export async function sendCodeViaSms(cleanPhone: string, code: string, label: string, message: string): Promise<{ success: boolean; message: string }> {
  const canSendLive = smsEnabled && !isAtDummy && !!atSMSClient;

  if (!canSendLive) {
    if (!isAtDummy && atSMSClient) {
      console.warn(`[SMS ${label} GATEWAY] Real Africa's Talking credentials are configured but SMS_ENABLED is not set to "true". ${process.env.NODE_ENV === 'production' ? 'Refusing to send live SMS in production; failing closed.' : 'Skipping live SMS (dev/sandbox).'}`);
    }
    if (process.env.NODE_ENV === 'production') {
      // Production must never report a simulated/non-delivered SMS as success.
      console.warn(`[SMS ${label} GATEWAY] SMS is not deliverable in this configuration (SMS_ENABLED missing/false, or provider not configured). Not claiming delivery.`);
      return { success: false, message: SMS_UNAVAILABLE_MESSAGE };
    }
    console.log(`\n========================================\n[SMS ${label} GATEWAY - SIMULATION, DEV/SANDBOX ONLY] Sending code ${code} to ${maskPhoneForLog(cleanPhone)}\n========================================\n`);
    return { success: true, message };
  }

  console.log(`[SMS ${label} GATEWAY] Sending live SMS via Africa's Talking to ${maskPhoneForLog(cleanPhone)}`);
  const options: any = {
    to: [toE164Kenyan(cleanPhone)],
    message: `Msimbo wako wa Return4me ni ${code}. Tafadhali usimshirikishe mtu yeyote. Muda wake unaisha baada ya dakika 5.`,
  };
  if (atSenderId && !atSenderId.includes('REPLACE_WITH') && atSenderId.trim() !== '') {
    options.from = atSenderId;
  }
  try {
    const response = await atSMSClient.send(options);
    console.log(`[SMS ${label} GATEWAY] Africa's Talking response:`, JSON.stringify(response));
    // A provider that accepted the message is NOT implied by a resolved
    // promise — per-recipient rejections (e.g. blacklist, statusCode 406) also
    // resolve. Inspect the recipient dispositions before reporting success.
    const normalized = normalizeAtSmsResult(response);
    if (!normalized.success) {
      console.error(`[SMS ${label} GATEWAY] Africa's Talking did not accept the message (${normalized.failureReason}).`);
      return { success: false, message: SMS_UNAVAILABLE_MESSAGE };
    }
    return { success: true, message };
  } catch (error: any) {
    console.error(`[SMS ${label} GATEWAY ERROR] Africa's Talking send failed:`, error);
    // P1: this used to embed the raw provider error (error.message) directly
    // into the message returned to the caller — which multiple routes then
    // forward straight to res.json({ error: ... }), reaching the end user
    // verbatim. The full error is already logged above for debugging; the
    // caller-facing message stays generic.
    return { success: false, message: SMS_UNAVAILABLE_MESSAGE };
  }
}

export const AuthService = {
  // Generate and "send" an OTP code to a Kenyan phone number
  async requestOTP(phone: string): Promise<{ success: boolean; message: string }> {
    // Validate Kenyan format (+254 or 07... / 01...)
    const cleanPhone = phone.replace(/\s+/g, '');
    const isKenyan = /^(\+254|0)(7|1)[0-9]{8}$/.test(cleanPhone);
    if (!isKenyan) {
      return { success: false, message: 'Tafadhali weka nambari sahihi ya simu ya Safaricom/Airtel (e.g., 0712345678).' };
    }

    // Canonicalize to a single E.164 form once, at the store boundary, so the
    // same number entered as 0712..., 0112..., +254712... or 254712... always
    // maps to exactly one OTP key (see toE164Kenyan).
    const canonicalPhone = toE164Kenyan(cleanPhone);

    // Generate 4-digit code using secure cryptographic random values
    const code = crypto.randomInt(1000, 10000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 mins validity

    // Persisted to Postgres (not an in-memory Map) so the OTP survives a
    // server restart/redeploy and multiple server instances can share state.
    await db.setOtp(canonicalPhone, hashCode(code), expiresAt);

    return sendCodeViaSms(canonicalPhone, code, 'OTP', `Msimbo wa OTP umetumwa kwa nambari yako ya simu ya ${canonicalPhone}.`);
  },

  // Verify OTP code with automatic brute-force invalidation after 5 attempts.
  // Backed by Postgres now, so this is async — callers must await it.
  async verifyOTP(phone: string, code: string): Promise<{ success: boolean; message: string }> {
    const cleanPhone = phone.replace(/\s+/g, '');
    // Look up by the same canonical E.164 key used at store time, so a user who
    // requests with 0712... and verifies with +2547... still matches.
    const canonicalPhone = toE164Kenyan(cleanPhone);
    const record = await db.getOtp(canonicalPhone);

    if (!record) {
      return { success: false, message: 'Hakuna OTP iliyoombwa kwa nambari hii au muda wake umeisha. / No OTP requested for this phone or it has expired.' };
    }

    if (record.expires_at.getTime() < Date.now()) {
      await db.deleteOtp(canonicalPhone);
      return { success: false, message: 'Muda wa OTP umeisha. Tafadhali omba msimbo mpya. / OTP has expired. Please request a new code.' };
    }

    const isMockBypass = (
      process.env.NODE_ENV !== 'production' &&
      process.env.ALLOW_MOCK_OTP_BYPASS === 'true' &&
      (code === '1234' || code === '4114')
    );
    const codeMatches = timingSafeEqualHex(hashCode(code), record.code_hash);
    if (!codeMatches && !isMockBypass) {
      const attempts = await db.incrementOtpAttempts(canonicalPhone);
      if (attempts >= 5) {
        await db.deleteOtp(canonicalPhone);
        return {
          success: false,
          message: 'Umekosea msimbo wa OTP mara 5. OTP hii imefutwa kwa usalama wako. Tafadhali omba msimbo mpya. / You have entered the wrong OTP 5 times. This OTP has been invalidated for security. Please request a new code.'
        };
      }
      return {
        success: false,
        message: `Msimbo wa OTP si sahihi. Una fursa ${5 - attempts} zilizobaki. / Incorrect OTP code. You have ${5 - attempts} attempts remaining.`
      };
    }

    // Success! Clear OTP
    await db.deleteOtp(canonicalPhone);
    return { success: true, message: 'Msimbo umethibitishwa kikamilifu! / Code successfully verified!' };
  },

  // Reusable low-level SMS sender (falls back to console logging in sandbox
  // mode) so other flows — like the claim pickup code — can send an SMS
  // without duplicating the Africa's Talking wiring. Same live-SMS gate and
  // recipient-level acceptance check as sendCodeViaSms: live sending requires
  // SMS_ENABLED=true (otherwise dev/sandbox simulation, except in production
  // where non-deliverable SMS returns false), and a provider response that
  // did not accept the recipient (e.g. blacklist) is NOT reported as success.
  async sendSms(phone: string, message: string): Promise<boolean> {
    const cleanPhone = phone.replace(/\s+/g, '');
    const canSendLive = smsEnabled && !isAtDummy && !!atSMSClient;
    if (!canSendLive) {
      if (process.env.NODE_ENV === 'production') {
        console.warn('[SMS GATEWAY] SMS is not deliverable in this configuration. Not claiming delivery.');
        return false;
      }
      console.log(`\n========================================\n[SMS GATEWAY - SIMULATION] Sending to ${maskPhoneForLog(cleanPhone)}: ${message}\n========================================\n`);
      return true;
    }
    try {
      const options: any = { to: [toE164Kenyan(cleanPhone)], message };
      if (atSenderId && !atSenderId.includes('REPLACE_WITH') && atSenderId.trim() !== '') {
        options.from = atSenderId;
      }
      const response = await atSMSClient.send(options);
      console.log('[SMS GATEWAY] Africa\'s Talking response:', JSON.stringify(response));
      return normalizeAtSmsResult(response).success;
    } catch (error: any) {
      console.error('[SMS GATEWAY ERROR] Africa\'s Talking send failed:', error);
      return false;
    }
  },
};

// --- AUTHENTICATION MIDDLEWARES ---

// Pure decision predicate behind server.ts's requireActiveAgent middleware
// — extracted here (rather than left inline in server.ts) specifically so
// it can be unit-tested directly. server.ts has no exports at all and
// pulls in a large amount of top-level side-effecting setup (dotenv
// loading, production fatal-throw guards, rate limiters, etc.), so
// importing anything from it in a test file is unsafe; auth.ts has none of
// that and is already safely imported by existing tests. Takes only the
// two fields the decision actually depends on, not a full Agent record —
// an undefined/null agent (the "no such Agent" / "unknown agentId" case)
// is never actionable, and only 'active' status is.
export function isAgentActionable(agent: { status: string } | undefined | null): boolean {
  return !!agent && agent.status === 'active';
}

// Pure decision predicate behind server.ts's requireCurrentAdminSession
// middleware — same rationale as isAgentActionable above: extracted here
// so it's unit-testable without importing server.ts. A session is valid
// only if the account is still active AND the token's embedded version
// matches the account's current version exactly; a missing tokenVersion on
// the token (e.g. a stale token minted before this mechanism existed) is
// deliberately NOT treated as a wildcard match — it fails closed.
export function isAdminSessionCurrent(
  admin: { is_active: boolean; token_version: number } | undefined | null,
  tokenVersion: number | undefined
): boolean {
  if (!admin || !admin.is_active) return false;
  if (typeof tokenVersion !== 'number') return false;
  return tokenVersion === admin.token_version;
}

export function authenticateJWT(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Ufikiaji umekataliwa. Tafadhali ingia katika akaunti yako.' });
  }

  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);

  if (!payload) {
    return res.status(403).json({ error: 'Muda wako wa kuingia umeisha. Tafadhali ingia tena.' });
  }

  req.user = payload; // Inject verified user session data
  next();
}

// TypeScript custom types typing support for Express Request
declare global {
  namespace Express {
    interface Request {
      user?: SessionPayload;
    }
  }
}
