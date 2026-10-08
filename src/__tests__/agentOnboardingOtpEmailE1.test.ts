// =============================================================================
// E1 — NEW-AGENT ONBOARDING EMAIL OTP: the REAL request -> dispatch boundary.
//
// The N4 harness mocks AuthService.requestOTP(), so it never proves that an
// onboarding HTTP request reaches the REAL email dispatch seam — that is why the
// "OTP-entry screen for an email that was never sent" defect could pass CI green.
//
// This suite closes that gap. It mocks ONLY the email TRANSPORT (the provider);
// AuthService, the /api/auth/request-otp route, recipient resolution, the OTP
// store, the notification boundary and verify-otp are ALL the real
// implementations, over real HTTP on an ephemeral socket (the N4 /
// lifecycleHttpE2E pattern). Its purpose is to fail the moment the onboarding
// recipient stops reaching sendEmailOtp(), or the route starts claiming success
// for a message it never dispatched.
//
// It is deliberately the regression for the confirmed CRITICAL defect:
//   * AgentView posted `{ phone }` alone -> the onboarding branch resolved no
//     recipient -> the dispatch failed closed -> the route STILL answered 200.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { db } from '../db/database';
import { testRunId } from '../db/__tests__/ensureTestCategory';
import { resolveCountyName } from '../config/kenyaCounties';
import { administrativeUnitsForCounty } from '../config/kenyaAdministrativeUnits';
import { EMAIL_OTP_UNAVAILABLE_MESSAGE } from '../services/emailOtp';

// --- ONLY THE PROVIDER IS DOUBLED. EVERYTHING ELSE IS REAL. ------------------
const emails = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; subject: string; body: string }>,
  accept: true,
}));

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const EmailService = actual.EmailService ?? {};
  return {
    ...actual,
    EmailService: new Proxy(EmailService, {
      get(target: any, prop: string) {
        if (prop === 'send' || prop === 'sendWithId') {
          return vi.fn(async (to: string, subject: string, body: string) => {
            emails.sent.push({ to, subject, body });
            return emails.accept
              ? { accepted: true, providerMessageId: 'e1-mock-1', providerError: null }
              : { accepted: false, providerMessageId: null, providerError: null };
          });
        }
        return target[prop];
      },
    }),
  };
});

vi.mock('../services/storage', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, uploadBase64Image: vi.fn(async () => 'https://storage.test/e1.jpg') };
});

// Imported AFTER the mocks are registered. NOTE: ../services/auth is NOT mocked,
// so requestOTP() and verifyOTP() are the real implementations.
const { createApp } = await import('../server.ts');

const RUN = testRunId;
const COUNTY = resolveCountyName('Nairobi')!;
const UNIT_ID = administrativeUnitsForCounty(COUNTY)[0]?.id;

// The exact subjects the two SEQUENTIAL agent messages carry.
const LOGIN_SUBJECT = 'Your Return4me verification code - Return4me';
const ACTIVATION_SUBJECT = 'Verify your Return4me agent email';

let app: any;
let server: any;
let base = '';
let xffSeq = 0;
let phoneSeq = 0;

/** A fresh X-Forwarded-For per request (see agentEmailActivationN4 for the why). */
function nextForwardedFor(): string {
  xffSeq += 1;
  return `10.77.${Math.floor(xffSeq / 250)}.${(xffSeq % 250) + 1}`;
}

/** A unique, valid E.164 Kenyan number per call. */
function nextPhone(): string {
  phoneSeq += 1;
  return '+2547' + String(20000000 + ((phoneSeq * 7919 + phoneSeq * phoneSeq) % 19999999)).slice(-8);
}

async function http(pathname: string, opts: { method?: string; body?: any; token?: string } = {}) {
  const headers: Record<string, string> = { 'X-Forwarded-For': nextForwardedFor() };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(base + pathname, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json, text };
}

/** The most recent AGENT_LOGIN_OTP_EMAIL captured, optionally to a given address. */
function loginOtpEmail(to?: string) {
  return [...emails.sent].reverse().find(
    (e) => e.subject === LOGIN_SUBJECT && (to === undefined || e.to === to),
  );
}
/** The most recent AGENT_EMAIL_ACTIVATION captured. */
function activationEmail() {
  return [...emails.sent].reverse().find((e) => e.subject === ACTIVATION_SUBJECT);
}
/** Pulls the 4-digit code out of the rendered code block of a login OTP email. */
function codeFromEmail(body: string): string {
  const m = body.match(/>(\d{4})<\/p>/);
  if (!m) throw new Error('no 4-digit code found in the captured OTP email');
  return m[1];
}
/** Pulls the activation token out of the captured activation email. */
function tokenFromEmail(body: string): string {
  const m = body.match(/token=([A-Za-z0-9]+)/);
  if (!m) throw new Error('no activation token in the captured email');
  return decodeURIComponent(m[1]);
}

/** Runs the REAL onboarding + registration: request-otp -> verify-otp. */
async function onboardAndRegister(email: string) {
  const phone = nextPhone();
  const request = await http('/api/auth/request-otp', { body: { phone, email } });
  const sent = loginOtpEmail(email);
  if (!sent) throw new Error('no OTP email captured for ' + email);
  const code = codeFromEmail(sent.body);
  const result = await http('/api/auth/verify-otp', {
    body: {
      phone, code, role: 'agent',
      businessName: 'E1 Test Shop',
      locationAddress: 'Kenyatta Avenue, Nairobi',
      county: 'Nairobi', administrativeUnitId: UNIT_ID,
      tillNumber: '123456', nationalId: '12345678',
      termsAccepted: true,
      contactEmail: email,
    },
  });
  return { phone, request, code, result };
}

beforeAll(async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    app = await createApp();
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
  server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

beforeEach(() => {
  emails.sent.length = 0;
  emails.accept = true;
});

// -----------------------------------------------------------------------------
// A. NEW AGENT WITH EMAIL — the code reaches the supplied (normalized) address.
// -----------------------------------------------------------------------------
describe('E1-A — a brand-new agent\'s OTP is emailed to the onboarding address', () => {
  it('resolves the onboarding recipient and dispatches a 4-digit code to it', async () => {
    const phone = nextPhone();
    const res = await http('/api/auth/request-otp', {
      body: { phone, email: 'New.Agent@Example.com' },
    });

    // The request is accepted and the OTP-entry flow may proceed.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Exactly one dispatch, to the SUPPLIED address (trimmed + lower-cased), and
    // it is the real AGENT_LOGIN_OTP_EMAIL transport — not a mock of the route.
    const sent = loginOtpEmail('new.agent@example.com');
    expect(sent, 'AGENT_LOGIN_OTP_EMAIL must reach the onboarding email').toBeTruthy();
    expect(sent!.to).toBe('new.agent@example.com');

    // A 4-digit code, carrying the existing 5-minute expiry wording and the
    // existing shared security warning (the template is unchanged).
    expect(codeFromEmail(sent!.body)).toMatch(/^\d{4}$/);
    expect(sent!.body).toContain('Valid for 5 minutes');
    expect(sent!.body).toContain('Never share a Return4me code');
  });
});

// -----------------------------------------------------------------------------
// B. ANTI-ENUMERATION — a bare phone request never dispatches, never leaks, and
//    never claims a code was emailed to the caller.
// -----------------------------------------------------------------------------
describe('E1-B — a bare phone request (no onboarding email) dispatches nothing', () => {
  it('makes no provider call and keeps the conditional anti-enumeration response', async () => {
    const phone = nextPhone();
    const res = await http('/api/auth/request-otp', { body: { phone } });

    // No email provider call happened at all — the transport failed closed.
    expect(emails.sent).toHaveLength(0);

    // The shared response is CONDITIONAL ("If this account has a verified email
    // address…"), so it never tells the caller a code was sent to them. A request
    // without an onboarding address is answered exactly like a login attempt, so
    // the endpoint cannot be used to tell a registered phone from an unregistered
    // one.
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If this account has a verified email address');
    expect(res.body.message).not.toContain(EMAIL_OTP_UNAVAILABLE_MESSAGE);
  });

  it('answers an unregistered phone EXACTLY like a registered one (no oracle)', async () => {
    // Register (only the first OTP email is captured) and activate an agent.
    const { phone: registeredPhone } = await onboardAndRegister(`oracle-${RUN}@example.com`);
    emails.sent.length = 0;

    const registered = await http('/api/auth/request-otp', { body: { phone: registeredPhone } });
    const unregistered = await http('/api/auth/request-otp', { body: { phone: nextPhone() } });

    expect(registered.status).toBe(unregistered.status);
    expect(registered.body).toEqual(unregistered.body);
  });
});

// -----------------------------------------------------------------------------
// C. PROVIDER REJECTION — surfaced honestly, with no provider internals.
// -----------------------------------------------------------------------------
describe('E1-C — a provider refusal is never a false onboarding success', () => {
  it('returns the shared channel-neutral failure and no provider detail', async () => {
    emails.accept = false; // the provider refuses the send
    const phone = nextPhone();
    const res = await http('/api/auth/request-otp', {
      body: { phone, email: `reject-${RUN}@example.com` },
    });

    // The onboarding dispatch was attempted and refused -> the applicant must not
    // be shown the OTP-entry step as though the email were on its way.
    expect(res.status).toBe(503);
    expect(res.body.success).toBeUndefined();
    expect(res.body.error).toBe(EMAIL_OTP_UNAVAILABLE_MESSAGE);
    // No provider internals leak (no "resend", no status code, no raw error).
    expect(JSON.stringify(res.body)).not.toMatch(/resend|provider|Resend/i);
  });
});

// -----------------------------------------------------------------------------
// D. EXISTING-AGENT SECURITY BOUNDARY — the verified DB email is authoritative.
// -----------------------------------------------------------------------------
describe('E1-D — a request-supplied email can never redirect an existing agent', () => {
  it('emails the verified contact_email, ignoring the address in the request', async () => {
    const email = `owner-${RUN}@example.com`;
    const { phone, result } = await onboardAndRegister(email);
    expect(result.status).toBe(200);

    // Activate the agent so `email_verified_at` is set — the existing-account
    // recipient is the SERVER-RESOLVED verified contact_email.
    const activationToken = tokenFromEmail(activationEmail()!.body);
    expect((await http('/api/agents/activate', { body: { token: activationToken } })).status).toBe(200);

    emails.sent.length = 0;
    const res = await http('/api/auth/request-otp', {
      body: { phone, email: 'attacker@evil.example' },
    });
    expect(res.status).toBe(200);

    // The code went to the account's own verified address, NOT the attacker's.
    const sent = loginOtpEmail(email);
    expect(sent, 'the verified DB email must be the recipient').toBeTruthy();
    expect(loginOtpEmail('attacker@evil.example')).toBeFalsy();
  });
});

// -----------------------------------------------------------------------------
// E. TWO SEPARATE MESSAGES — OTP first, activation second, distinct event types.
// -----------------------------------------------------------------------------
describe('E1-E — the OTP email and the activation email stay separate', () => {
  it('sends AGENT_LOGIN_OTP_EMAIL, then AGENT_EMAIL_ACTIVATION, as distinct messages', async () => {
    const email = `sequence-${RUN}@example.com`;
    const { result } = await onboardAndRegister(email);
    expect(result.status).toBe(200);
    expect(result.body.profile.activationRequired).toBe(true);

    // Both messages exist, distinctly, in order.
    expect(loginOtpEmail(email), 'the AGENT_LOGIN_OTP_EMAIL').toBeTruthy();
    const activation = activationEmail();
    expect(activation, 'the AGENT_EMAIL_ACTIVATION').toBeTruthy();
    expect(activation!.to).toBe(email);

    // They are not the same message: the OTP carried a 4-digit code; the
    // activation message carries a token/link and no code block.
    expect(activation!.body).not.toMatch(/>(\d{4})<\/p>/);
    expect(activation!.body).toContain('token=');
  });
});
