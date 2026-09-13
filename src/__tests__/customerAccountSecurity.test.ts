import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Route-level security audit for the customer-account foundation, in the same
// static-source style as paymentSessionSecurity.test.ts. The runtime DB
// mechanics are covered by src/db/__tests__/customerAccount.test.ts; this file
// pins the HTTP-layer guarantees that need the real express route bodies.
const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

function routeBody(marker: string, len = 4000): string {
  const idx = serverTs.indexOf(marker);
  expect(idx, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const after = serverTs.slice(idx);
  const nextRoute = after.indexOf('\n  app.', 10);
  const end = nextRoute > -1 ? idx + nextRoute : idx + len;
  return serverTs.slice(idx, end);
}

const register = routeBody("app.post('/api/customer/register'");
const registerVerify = routeBody("app.post('/api/customer/register/verify'");
const login = routeBody("app.post('/api/customer/login'");
const loginVerify = routeBody("app.post('/api/customer/login/verify'");
const logout = routeBody("app.post('/api/customer/logout'");
const me = routeBody("app.get('/api/customer/me'");
const middleware = serverTs.slice(
  serverTs.indexOf('async function requireCustomerAuth'),
  serverTs.indexOf('async function startServer()')
);

describe('customer account: API surface', () => {
  it('exposes register, register/verify, login, login/verify, logout and me', () => {
    expect(serverTs).toContain("app.post('/api/customer/register',");
    expect(serverTs).toContain("app.post('/api/customer/register/verify',");
    expect(serverTs).toContain("app.post('/api/customer/login',");
    expect(serverTs).toContain("app.post('/api/customer/login/verify',");
    expect(serverTs).toContain("app.post('/api/customer/logout',");
    expect(serverTs).toContain("app.get('/api/customer/me',");
  });

  it('rate-limits every customer auth route (unauthenticated SMS senders)', () => {
    expect(register).toMatch(/customerAuthLimiter/);
    expect(registerVerify).toMatch(/otpVerifyLimiter/);
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

  it('never stores the plaintext OTP — only hashCode(code)', () => {
    expect(register).toMatch(/hashCode\(code\)/);
    expect(register).toContain("'registration'");
    expect(register).not.toMatch(/code_hash:\s*code\b/);
  });

  it('returns a generic message that does not reveal whether the phone exists', () => {
    expect(register).toMatch(/Kama nambari hii inaweza kutumika/);
    expect(register).not.toMatch(/already registered/i);
  });

  it('applies a resend throttle before sending a new SMS', () => {
    expect(register).toMatch(/customerOtpLastSent/);
    expect(register).toMatch(/CUSTOMER_OTP_RESEND_MS/);
  });
});

describe('customer registration verify: one-time, purpose-bound, replay-safe', () => {
  it('reads the challenge for the registration purpose only', () => {
    expect(registerVerify).toMatch(/getActiveCustomerOtp\(phone, 'registration'\)/);
  });

  it('fails an expired code and burns it', () => {
    expect(registerVerify).toMatch(/expires_at/);
    expect(registerVerify).toMatch(/consumeCustomerOtp\(otp\.id\)/);
  });

  it('bounded by the attempt ceiling', () => {
    expect(registerVerify).toMatch(/CUSTOMER_OTP_MAX_ATTEMPTS/);
    expect(registerVerify).toMatch(/incrementCustomerOtpAttempts/);
  });

  it('verifies the code with a timing-safe hash comparison', () => {
    expect(registerVerify).toMatch(/timingSafeEqualHex\(otp\.code_hash, hashCode\(code\)\)/);
  });

  it('consumes the challenge before creating the account (one-time use)', () => {
    const consumeIdx = registerVerify.indexOf('consumeCustomerOtp');
    const createIdx = registerVerify.indexOf('createCustomer(');
    expect(consumeIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(consumeIdx).toBeLessThan(createIdx);
  });

  it('does not accept a client-supplied customer id or status', () => {
    expect(registerVerify).not.toMatch(/req\.body\.(customerId|id|status)/);
    expect(registerVerify).toMatch(/generateSecureId\('CUS'\)/);
  });
});

describe('customer login: no enumeration, no account creation', () => {
  it('responds identically whether or not the phone is registered', () => {
    expect(login).toMatch(/Kama nambari hii imesajiliwa/);
    expect(login).not.toMatch(/not registered/i);
    expect(login).not.toMatch(/no such account/i);
  });

  it('sends a code only for an existing active account', () => {
    expect(login).toMatch(/if \(customer && customer\.status === 'active'\)/);
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
    expect(serverTs).toMatch(/httpOnly:\s*true/);
    expect(serverTs).toMatch(/sameSite:\s*'lax'/);
    expect(serverTs).toMatch(/secure:\s*process\.env\.NODE_ENV === 'production'/);
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
    expect(serverTs).toContain("app.post('/api/claims/lookup', claimGuessLimiter,");
    expect(serverTs).toContain("app.post('/api/claims/:id/request-otp',");
    expect(serverTs).toContain("app.post('/api/claims/:id/verify-otp', otpVerifyLimiter,");
    expect(serverTs).toContain("app.get('/api/claims/:id/status',");
  });

  it('does not gate the accountless Finder report route behind customer auth', () => {
    const report = routeBody("app.post('/api/items/report'");
    expect(report).not.toMatch(/requireCustomerAuth/);
  });

  it('leaves the committed payment-session routes intact', () => {
    expect(serverTs).toMatch(/app\.post\('\/api\/claims\/:id\/payment-session',\s*claimGuessLimiter,/);
    expect(serverTs).toMatch(/resolveAuthoritativePaymentFee\(item, category\)/);
  });

  it('never logs a raw OTP or session token', () => {
    const section = serverTs.slice(
      serverTs.indexOf('CUSTOMER ACCOUNT AUTHENTICATION'),
      serverTs.indexOf("// --- API ROUTES ---")
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
    expect(schemaTs).toMatch(/uq_payment_sessions_provider_invoice/);
  });
});
