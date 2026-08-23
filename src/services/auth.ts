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
    };
  } catch (e) {
    return null;
  }
}


// --- AUTH SERVICES ---

/**
 * Sends a numeric code to a Kenyan phone number via SMS — shared by both
 * phone-verification OTP (requestOTP below) and claim-specific OTP
 * (POST /api/claims/:id/request-otp in server.ts). Deliberately takes an
 * already-generated code rather than generating one itself, since the two
 * callers store it against different tables (phone number vs claim ID)
 * with different expiry/attempt semantics — this function only owns
 * actual delivery, not code generation or persistence.
 *
 * In sandbox/dev fallback mode (no real Africa's Talking credentials
 * configured), the code is printed to the console with an unmistakable
 * "SIMULATION" label — this is the ONLY path that ever logs a real OTP
 * code, and it never runs when real credentials are configured. The real-
 * delivery path deliberately never logs the code itself.
 */
export async function sendCodeViaSms(cleanPhone: string, code: string, label: string, message: string): Promise<{ success: boolean; message: string }> {
  if (isAtDummy || !atSMSClient) {
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
    return { success: true, message };
  } catch (error: any) {
    console.error(`[SMS ${label} GATEWAY ERROR] Africa's Talking send failed:`, error);
    return { success: false, message: `Imeshindwa kutuma ujumbe wa SMS: ${error.message || error}. Tafadhali jaribu tena.` };
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

    // Generate 4-digit code using secure cryptographic random values
    const code = crypto.randomInt(1000, 10000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 mins validity

    // Persisted to Postgres (not an in-memory Map) so the OTP survives a
    // server restart/redeploy and multiple server instances can share state.
    await db.setOtp(cleanPhone, hashCode(code), expiresAt);

    return sendCodeViaSms(cleanPhone, code, 'OTP', `Msimbo wa OTP umetumwa kwa nambari yako ya simu ya ${cleanPhone}.`);
  },

  // Verify OTP code with automatic brute-force invalidation after 5 attempts.
  // Backed by Postgres now, so this is async — callers must await it.
  async verifyOTP(phone: string, code: string): Promise<{ success: boolean; message: string }> {
    const cleanPhone = phone.replace(/\s+/g, '');
    const record = await db.getOtp(cleanPhone);

    if (!record) {
      return { success: false, message: 'Hakuna OTP iliyoombwa kwa nambari hii au muda wake umeisha. / No OTP requested for this phone or it has expired.' };
    }

    if (record.expires_at.getTime() < Date.now()) {
      await db.deleteOtp(cleanPhone);
      return { success: false, message: 'Muda wa OTP umeisha. Tafadhali omba msimbo mpya. / OTP has expired. Please request a new code.' };
    }

    const isMockBypass = (
      process.env.NODE_ENV !== 'production' &&
      process.env.ALLOW_MOCK_OTP_BYPASS === 'true' &&
      (code === '1234' || code === '4114')
    );
    const codeMatches = timingSafeEqualHex(hashCode(code), record.code_hash);
    if (!codeMatches && !isMockBypass) {
      const attempts = await db.incrementOtpAttempts(cleanPhone);
      if (attempts >= 5) {
        await db.deleteOtp(cleanPhone);
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
    await db.deleteOtp(cleanPhone);
    return { success: true, message: 'Msimbo umethibitishwa kikamilifu! / Code successfully verified!' };
  },

  // Reusable low-level SMS sender (falls back to console logging in sandbox
  // mode) so other flows — like the claim pickup code — can send an SMS
  // without duplicating the Africa's Talking wiring.
  async sendSms(phone: string, message: string): Promise<boolean> {
    const cleanPhone = phone.replace(/\s+/g, '');
    if (isAtDummy || !atSMSClient) {
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
      return true;
    } catch (error: any) {
      console.error('[SMS GATEWAY ERROR] Africa\'s Talking send failed:', error);
      return false;
    }
  },
};

// --- AUTHENTICATION MIDDLEWARES ---

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
