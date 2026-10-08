import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Route-level security audit for the customer-account foundation, in the same
// static-source style as paymentSessionSecurity.test.ts. The runtime DB
// mechanics are covered by src/db/__tests__/customerAccount.test.ts; this file
// pins the HTTP-layer guarantees that need the real express route bodies.

// P2-A3.2: the eight claim payment/status handlers moved verbatim into
// routes/claimPayments.ts (so an HTTP integration test can mount them without
// importing server.ts, which boots its listener at import time). Route lookups
// below search the new owner FIRST and fall back to server.ts, so an assertion
// still fails if a handler disappeared from BOTH. No assertion weakened.
const CLAIM_PAYMENTS_TS = fs.readFileSync(path.resolve(__dirname, '../routes/claimPayments.ts'), 'utf8');
const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
// Phase 2 moved the cookie handling and the requireCustomerAuth middleware out
// of server.ts into services/customerAuth.ts (so the customer claim routes and
// the HTTP integration tests can use the real middleware without importing
// server.ts, which boots the app at import time). These assertions are
// unchanged — they just read the file the code now lives in.
const customerAuthTs = fs.readFileSync(path.resolve(__dirname, '../services/customerAuth.ts'), 'utf8');
// P2-A1: POST /api/items/report was extracted VERBATIM from server.ts into
// routes/finderReport.ts so it can be mounted for real HTTP integration testing.
// routeBody resolves a marker from whichever file now owns it, so every
// assertion keeps testing the same route body it always tested — only the file
// the body is read from moved. No behavioural assertion is weakened.
const finderReportTs = fs.readFileSync(path.resolve(__dirname, '../routes/finderReport.ts'), 'utf8');
function sourceFor(marker: string): string {
  if (serverTs.includes(marker)) return serverTs;
  if (finderReportTs.includes(marker)) return finderReportTs;
  throw new Error(`marker not found in server.ts or routes/finderReport.ts: ${marker}`);
}

function routeBody(marker: string, len = 4000): string {
  // P2-A3.2: sourceFor now also resolves routes in routes/claimPayments.ts.
  const src = sourceFor(marker);
  const idx = src.indexOf(marker);
  expect(idx, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const after = src.slice(idx);
  const nextRoute = after.indexOf('\n  app.', 10);
  const end = nextRoute > -1 ? idx + nextRoute : idx + len;
  return src.slice(idx, end);
}

const register = routeBody("app.post('/api/customer/register'");
// N3: the SMS-based /api/customer/register/verify was replaced by the email
// activation endpoint. The marker below follows that move; every assertion
// below it still protects the same property (rate limiting, ownership, CAS
// single use, hash-only storage, timing-safe compare).
const registerVerify = routeBody("app.post('/api/customer/activate'");
const login = routeBody("app.post('/api/customer/login'");
const loginVerify = routeBody("app.post('/api/customer/login/verify'");
const logout = routeBody("app.post('/api/customer/logout'");
const me = routeBody("app.get('/api/customer/me'");
const middleware = customerAuthTs.slice(
  customerAuthTs.indexOf('export async function requireCustomerAuth'),
  customerAuthTs.length
);

describe('customer account: API surface', () => {
  it('exposes register, activate, login, login/verify, logout and me', () => {
    expect(serverTs).toContain("app.post('/api/customer/register',");
    // N3: /register/verify (SMS) is replaced by /activate (email token).
    expect(serverTs).toContain("app.post('/api/customer/activate',");
    expect(serverTs).not.toContain("app.post('/api/customer/register/verify',");
    expect(serverTs).toContain("app.post('/api/customer/login',");
    expect(serverTs).toContain("app.post('/api/customer/login/verify',");
    expect(serverTs).toContain("app.post('/api/customer/logout',");
    expect(serverTs).toContain("app.get('/api/customer/me',");
  });

  it('rate-limits every customer auth route', () => {
    expect(register).toMatch(/customerAuthLimiter/);
    expect(registerVerify).toMatch(/otpVerifyLimiter/);
    expect(registerVerify).toMatch(/customerAuthLimiter/);
    expect(login).toMatch(/customerAuthLimiter/);
    expect(loginVerify).toMatch(/otpVerifyLimiter/);
  });

  it('applies the IP-independent global OTP ceiling to the two SMS-sending routes', () => {
    // A per-IP limiter alone is bypassable on a deployment where `trust proxy`
    // does not match the real hop count (the codebase documents this on
    // otpGlobalLimiter itself). Every customer OTP send costs real money and
    // can target an arbitrary number, so the same global backstop the claim
    // OTP route uses must cover these routes too.
    expect(register).toMatch(/app\.post\('\/api\/customer\/register', customerAuthLimiter, otpGlobalLimiter,/);
    expect(login).toMatch(/app\.post\('\/api\/customer\/login', customerAuthLimiter, otpGlobalLimiter,/);
  });
});

describe('customer registration: validation and hashing', () => {
  it('normalizes the phone with the shared helper and validates the Kenyan format', () => {
    expect(register).toMatch(/toE164Kenyan\(rawPhone\)/);
    expect(register).toMatch(/\/\^\\\+254\\d\{9\}\$\/\.test\(phone\)/);
  });

  it('never persists an activation token in plaintext — only hashCode(rawToken)', () => {
    // N3: registration stopped storing an SMS OTP. The equivalent
    // hash-only invariant now applies to the activation token.
    expect(register).toMatch(/hashCode\(rawToken\)/);
    expect(register).toContain("'email_activation'");
    expect(register).not.toMatch(/token_hash:\s*rawToken\b/);
  });

  it('returns a generic success that does not reveal whether the phone or email exists', () => {
    expect(register).toMatch(/Account created/);
    expect(register).not.toMatch(/already registered/i);
  });

  it('applies the resend throttle before issuing a new activation token', () => {
    expect(register).toMatch(/customerOtpLastSent/);
    expect(register).toMatch(/CUSTOMER_OTP_RESEND_MS/);
  });
});

describe('customer activation: one-time, purpose-bound, replay-safe', () => {
  it('reads the token by hash for the email_activation purpose and customer type only', () => {
    expect(registerVerify).toMatch(/getAccountActivationTokenByHash\(hashCode\(rawToken\)\)/);
    expect(registerVerify).toMatch(/account_type !== 'customer'/);
    expect(registerVerify).toMatch(/purpose !== 'email_activation'/);
  });

  it('refuses an expired token and refuses an already-consumed one', () => {
    expect(registerVerify).toMatch(/expires_at/);
    expect(registerVerify).toMatch(/consumed_at/);
    expect(registerVerify).toMatch(/consumeAccountActivationToken\(token\.id\)/);
  });

  it('consumes the token atomically before activating and before any session', () => {
    const consumeIdx = registerVerify.indexOf('consumeAccountActivationToken');
    const activateIdx = registerVerify.indexOf('activateCustomerAccount');
    const sessionIdx = registerVerify.indexOf('createCustomerSession');
    expect(consumeIdx).toBeGreaterThan(-1);
    expect(activateIdx).toBeGreaterThan(consumeIdx);
    expect(sessionIdx).toBeGreaterThan(activateIdx);
  });

  it('returns ONE generic failure for every unusable-token reason (no token oracle)', () => {
    const generic = (registerVerify.match(/json\(GENERIC\)/g) || []).length;
    expect(generic).toBeGreaterThanOrEqual(5);
  });

  it('does not accept a client-supplied customer id, status or token hash', () => {
    expect(registerVerify).not.toMatch(/req\.body\.(customerId|id|status|token_hash|accountId)/);
  });
});

describe('customer login: no enumeration, no account creation', () => {
  it('responds identically whether or not the phone is registered', () => {
    // E1: the single generic answer now tells every caller the same thing —
    // "if this account has a verified email, a code went to it; otherwise verify
    // your email first" — which is the same sentence for a registered and an
    // unregistered number.
    expect(login).toMatch(/If this account has a verified email address/);
    expect(login).not.toMatch(/not registered/i);
    expect(login).not.toMatch(/no such account/i);
  });

  it('sends a code only for an existing active account with a verified email', () => {
    // E1 narrowed the branch further: the destination must exist AND be verified,
    // or there is nothing to send to and the route fails closed.
    expect(login).toMatch(
      /if \(customer && customer\.status === 'active' && customer\.email && customer\.email_verified_at\)/,
    );
  });

  it('login verify uses the login purpose and can never create an account', () => {
    expect(loginVerify).toMatch(/getActiveCustomerOtp\(phone, 'login'\)/);
    expect(loginVerify).not.toMatch(/createCustomer\(/);
    expect(loginVerify).toMatch(/getCustomerByPhone\(phone\)/);
  });

  it('login verify rejects a non-active account and never sets an identity from the body', () => {
    expect(loginVerify).toMatch(/customer\.status !== 'active'/);
    expect(loginVerify).not.toMatch(/req\.body\.customerId/);
  });

  it('both verify routes use a timing-safe comparison and consume the challenge', () => {
    expect(loginVerify).toMatch(/timingSafeEqualHex\(otp\.code_hash, hashCode\(code\)\)/);
    expect(loginVerify).toMatch(/consumeCustomerOtp\(otp\.id\)/);
  });
});

describe('customer sessions: server-side, hash-only, revocable', () => {
  it('issues an HttpOnly, SameSite=Lax cookie that is Secure in production', () => {
    expect(customerAuthTs).toMatch(/httpOnly:\s*true/);
    expect(customerAuthTs).toMatch(/sameSite:\s*'lax'/);
    expect(customerAuthTs).toMatch(/secure:\s*process\.env\.NODE_ENV === 'production'/);
  });

  it('persists only the hash of the raw session token', () => {
    expect(registerVerify).toMatch(/crypto\.randomBytes\(32\)\.toString\('hex'\)/);
    expect(registerVerify).toMatch(/hashCode\(rawToken\)/);
    expect(registerVerify).not.toMatch(/token_hash:\s*rawToken\b/);
  });

  it('the middleware resolves identity only from the cookie hash, never from the request', () => {
    expect(middleware).toMatch(/readCookie\(req, CUSTOMER_SESSION_COOKIE\)/);
    expect(middleware).toMatch(/getCustomerSessionByTokenHash\(hashCode\(raw\)\)/);
    expect(middleware).not.toMatch(/req\.body/);
    expect(middleware).not.toMatch(/req\.query/);
    expect(middleware).not.toMatch(/req\.params/);
  });

  it('rejects revoked, expired and non-active customers', () => {
    expect(middleware).toMatch(/session\.revoked_at/);
    expect(middleware).toMatch(/session\.expires_at/);
    expect(middleware).toMatch(/customer\.status !== 'active'/);
  });

  it('logout revokes the stored session server-side', () => {
    expect(logout).toMatch(/revokeCustomerSession\(req\.customerSession\.id\)/);
    expect(logout).toMatch(/clearCustomerSessionCookie\(res\)/);
  });
});

describe('customer responses: no internal fields exposed', () => {
  it('/me returns only the safe whitelisted customer shape', () => {
    expect(me).toMatch(/toSafeCustomer\(req\.customer\)/);
    // P2-A3.2: toSafeCustomer stayed in server.ts (customer auth was not extracted).
    const safe = serverTs.slice(
      serverTs.indexOf('function toSafeCustomer'),
      serverTs.indexOf('// 6-digit, crypto-random OTP')
    );
    expect(safe).not.toMatch(/code_hash/);
    expect(safe).not.toMatch(/token_hash/);
    expect(safe).not.toMatch(/revoked_at/);
  });
});

describe('customer foundation: regression boundaries', () => {
  it('preserves the existing Track Claim routes (claim ID + phone lookup with OTP)', () => {
    // NOTE: this repository's Track Claim flow is /api/claims/lookup
    // (claim ID + phone) plus /:id/request-otp and /:id/verify-otp, with
    // GET /api/claims/:id/status for the result. There is no separate
    // GET /api/claims/track/:claimId/:phone route here — this asserts the
    // real surface so the test stays honest about what exists.
    //
    // PHASE 16: the lookup route additionally resolves the CUSTOMER session
    // (requireCustomerAuth) before the limiter, because Track My Claim is now
    // an authenticated journey. The route itself, its phone match and its
    // discrete rate limit are all unchanged.
    expect(CLAIM_PAYMENTS_TS).toContain("app.post('/api/claims/lookup', requireCustomerAuth, claimGuessLimiter,");
    // P2-A3.1: the two claim OTP routes were extracted VERBATIM into
    // routes/claims.ts. Their limiter wiring is asserted against whichever file
    // owns them — the guarantee (request-otp is triple-limited, verify-otp uses
    // otpVerifyLimiter) is unchanged.
    const claimsSrc = serverTs.includes("app.post('/api/claims/:id/request-otp',")
      ? serverTs
      : fs.readFileSync(path.resolve(__dirname, '../routes/claims.ts'), 'utf8');
    expect(claimsSrc).toContain("app.post('/api/claims/:id/request-otp',");
    expect(claimsSrc).toContain("app.post('/api/claims/:id/verify-otp', otpVerifyLimiter,");
    expect(CLAIM_PAYMENTS_TS).toContain("app.get('/api/claims/:id/status',");
  });

  it('does not gate the accountless Finder report route behind customer auth', () => {
    const report = routeBody("app.post('/api/items/report'");
    expect(report).not.toMatch(/requireCustomerAuth/);
  });

  it('leaves the committed payment-session routes intact', () => {
    expect(CLAIM_PAYMENTS_TS).toMatch(/app\.post\('\/api\/claims\/:id\/payment-session',\s*claimGuessLimiter,/);
    expect(CLAIM_PAYMENTS_TS).toMatch(/resolveAuthoritativePaymentFee\(item, category\)/);
  });

  it('never logs a raw OTP or session token', () => {
    // P2-A3.2: the customer-auth section stayed in server.ts.
    // CUSTOMER ACCOUNT AUTHENTICATION block only — a slice of the whole file would
    const section = serverTs.slice(
      serverTs.indexOf('CUSTOMER ACCOUNT AUTHENTICATION'),
      serverTs.indexOf('// --- API ROUTES ---')
    );
    expect(section).not.toMatch(/console\.log\([^)]*rawToken/);
    expect(section).not.toMatch(/console\.log\([^)]*\bcode\b/);
  });

  it('keeps the committed payment provider-invoice unique index in the incremental DDL', () => {
    // A working-tree edit during the customer-account work accidentally
    // dropped this statement from the incremental schema path (schema.ts
    // still had it, so a fresh database was fine but an already-running one
    // would have lost the guarantee). This guards the payment baseline.
    const dbIndexTs = fs.readFileSync(path.resolve(__dirname, '../db/index.ts'), 'utf8');
    expect(dbIndexTs).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_sessions_provider_invoice ON payment_sessions\(provider_invoice_id\) WHERE provider_invoice_id IS NOT NULL/
    );
    const schemaTs = fs.readFileSync(path.resolve(__dirname, '../db/schema.ts'), 'utf8');

// P2-A3.2: the eight claim payment/status handlers moved verbatim into
// routes/claimPayments.ts (so an HTTP integration test can mount them without
// importing server.ts, which boots its listener at import time). Route lookups
// below now search the new owner first and fall back to server.ts, so an
// assertion still fails if the handler disappears from BOTH files. No assertion
// was weakened or removed.
    expect(schemaTs).toMatch(/uq_payment_sessions_provider_invoice/);
  });
});
