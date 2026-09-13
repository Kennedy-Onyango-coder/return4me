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
import { hashCode } from './auth.ts';

export const CUSTOMER_SESSION_COOKIE = 'r4m_customer_session';
export const CUSTOMER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const CUSTOMER_OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const CUSTOMER_OTP_MAX_ATTEMPTS = 5;
export const CUSTOMER_OTP_RESEND_MS = 30 * 1000; // 30s resend floor (SMS cost control)

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
// finds the session server-side, then checks revocation, expiry and the
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
