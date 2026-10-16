// =============================================================================
// AGENT EMAIL-OTP SIGN-IN — THE TWO DEFECTS THAT BLOCKED IT.
//
// THE REPORTED FAILURE. An EXISTING agent (Furusato Japanese Restaurant) could
// request a one-time code, received it by email, and still could not sign in.
// The investigation found the sign-in path broken in two INDEPENDENT places,
// and both are pinned here:
//
//   D1 (client)  src/components/AgentView.tsx — handleOtpVerify applied the B1
//                payout-destination guard UNCONDITIONALLY, but that guard reads
//                `tillNumber`, a REGISTRATION-ONLY field that is always empty
//                when an existing agent signs in. The handler returned before it
//                ever posted to /api/auth/verify-otp: the code arrived and the
//                form silently refused it. The sibling guard in
//                handleAuthRequest is scoped to registration; that asymmetry was
//                the defect, not the guard itself.
//
//   D2 (server)  src/server.ts — /api/auth/request-otp resolved the agent by the
//                CANONICAL phone form (07..., +2547..., 2547... all matched) while
//                /api/auth/verify-otp compared the RAW string. A number
//                recognised when the code was requested was therefore not
//                recognised when the code was submitted: the existing-agent arm
//                was skipped, the request fell into the REGISTRATION arm and was
//                answered with "Please provide all of the business details
//                required to register as an Agent." (400) — with the one-time
//                code already consumed. Both endpoints now share one matcher,
//                resolveAgentByPhone().
//
// WHAT THIS FILE IS
//   * D2 is exercised END TO END over real HTTP against the real application on
//     an ephemeral socket (the N4 / E1 / lifecycleHttpE2E pattern). Only the
//     email and object-storage TRANSPORTS are doubled: AuthService.requestOTP,
//     verifyOTP, resolveAgentByPhone, the OTP store, the hashing, the expiry,
//     the limiter chain and the agent records are ALL the real implementations.
//   * D1 cannot be rendered: this repository ships no jsdom / React Testing
//     Library harness (the UX-11/UX-12 and B1 suites document the same
//     constraint) and AgentView is a stateful component whose handler is not
//     reachable through renderToStaticMarkup(). So this suite does not assert
//     that a string appears in the file: it EXTRACTS each shipped payout refusal
//     together with the guards that enclose it and EVALUATES that expression, so
//     the assertions are about what the shipped code DOES for the sign-in state
//     versus the registration state. The limitation is stated, not hidden.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { testRunId } from '../db/__tests__/ensureTestCategory';
import { resolveCountyName } from '../config/kenyaCounties';
import { administrativeUnitsForCounty } from '../config/kenyaAdministrativeUnits';
import {
  PERSONAL_MPESA_PAYOUT_METHOD,
  resolvePayoutLegEligibility,
  resolvePayoutBatchEligibility,
} from '../config/payoutDestinations';
// The REAL module: requestOTP / verifyOTP / the shared phone matcher. NOT mocked

// --- ONLY THE TRANSPORTS ARE DOUBLED. EVERY BUSINESS RULE IS REAL. -----------
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
              ? { accepted: true, providerMessageId: 'sgn-mock-1', providerError: null }
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
  return { ...actual, uploadBase64Image: vi.fn(async () => 'https://storage.test/sgn.jpg') };
});

// Imported AFTER the mocks are registered, so the app is built on them.
const { createApp } = await import('../server.ts');

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
// The shipped component the D1 tests below analyse. server.ts is NOT read here:
// every server-side claim in this file is made over real HTTP instead.
const AGENT_VIEW = read('src/components/AgentView.tsx');

const RUN = testRunId;
const COUNTY = resolveCountyName('Nairobi')!;
const UNIT_ID = administrativeUnitsForCounty(COUNTY)[0]?.id;

/** The subject the shipped AGENT_LOGIN_OTP_EMAIL template carries (E1 pins it). */
const LOGIN_SUBJECT = 'Your Return4me verification code - Return4me';

let app: any;
let server: any;
let base = '';
let xffSeq = 0;
let phoneSeq = 0;
let agentSeq = 0;

/**
 * A fresh X-Forwarded-For per request — fixture hygiene, not a workaround: the
 * app sets `trust proxy` to 1, so otpIpLimiter (5 per 5 minutes per address)
 * correctly keys on the forwarded address, and a suite that fires a couple of
 * dozen OTP requests from one synthetic address would otherwise start reading
 * 429s for reasons unrelated to what is under test.
 */
function nextForwardedFor(): string {
  xffSeq += 1;
  return `10.55.${Math.floor(xffSeq / 250)}.${(xffSeq % 250) + 1}`;
}

/** A unique, valid E.164 Kenyan number per call (07xx range). */
function nextPhone(): string {
  phoneSeq += 1;
  return '+2547' + String(20000000 + ((phoneSeq * 7919 + phoneSeq * phoneSeq) % 19999999)).slice(-8);
}

/**
 * The FOUR supported spellings of one number that a client may post. Every one
 * of them passes the route's own Kenyan validator and canonicalises, via
 * toE164Kenyan, to the same E.164 key.
 */
function spellingsOf(e164: string) {
  const digits = e164.replace(/^\+254/, ''); // 7XXXXXXXX
  return {
    canonical: e164,
    local: '0' + digits,
    bare: '254' + digits,
    spaced: `+254 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`,
  };
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

/** The most recent agent login OTP email captured, optionally to one address. */
function loginOtpEmail(to?: string) {
  return [...emails.sent].reverse().find(
    (e) => e.subject === LOGIN_SUBJECT && (to === undefined || e.to === to),
  );
}

/** Pulls the 4-digit code out of the rendered code block of a login OTP email. */
function codeFromEmail(body: string): string {
  const m = body.match(/>(\d{4})<\/p>/);
  if (!m) throw new Error('no 4-digit code found in the captured OTP email');
  return m[1];
}

/**
 * Issues a REAL one-time code for a phone number.
 *
 * This calls the real AuthService.requestOTP and replaces only the injected
 * TRANSPORT — the same seam the route itself injects — so the Kenyan format
 * validation, the CSPRNG code, hashCode(), the canonical Postgres store key and
 * the persist-then-send ordering are all the real code paths. It exists for the
 * account states whose login OTP the route deliberately cannot deliver (an agent
 * with no verified email fails closed and dispatches nothing) and for fixtures
 * that need a genuine code without another HTTP round trip.
 */
async function issueRealOtp(phone: string): Promise<string> {
  let captured = '';
  const result = await AuthService.requestOTP(phone, async (_phone: string, code: string) => {
    captured = code;
    return { success: true, message: 'captured in test' };
  });
  if (!captured) throw new Error('real requestOTP issued no code for a valid number: ' + result.message);
  return captured;
}

/**
 * Seeds an agent row DIRECTLY, bypassing registration — what the D2 tests need
 * is a row that already exists. `storedPhone` is written VERBATIM, which is the
 * point of the format matrix below: a row created before canonicalisation may
 * hold `07...` or a bare `254...`. `emailVerified: false` exercises the
 * "approved but not activated" axis; the row always has an address, because
 * createAgent() normalises a blank one to NULL and that is the OTHER axis.
 */
async function seedAgent(opts: {
  status?: string;
  storedPhone: string;
  emailVerified?: boolean;
}): Promise<{ id: string; email: string }> {
  agentSeq += 1;
  const id = `SGN-${RUN}-${agentSeq}`;
  const email = `sgn-${RUN}-${agentSeq}@example.com`;
  await db.createAgent({
    id,
    business_name: `SGN Fixture ${id}`,
    contact_phone: opts.storedPhone,
    location_address: 'Kenyatta Avenue, Nairobi',
    county: COUNTY,
    administrative_unit_id: UNIT_ID,
    mpesa_till_or_paybill: '254712345678',
    payout_method_type: PERSONAL_MPESA_PAYOUT_METHOD,
    status: opts.status ?? 'active',
    refundable_deposit: 0,
    national_id_hash: 'sgn-hash-' + id,
    terms_accepted_at: new Date().toISOString(),
    contact_email: email,
  } as any);
  if (opts.emailVerified !== false) {
    const verified = await db.verifyAgentEmail(id);
    if (!verified) throw new Error('could not mark the fixture agent email verified');
  }
  const row = await db.getAgent(id);
  return { id, email: row?.contact_email ?? email };
}

/**
 * Signs an EXISTING agent in exactly as the browser does: request the code, read
 * it from the captured email (so the server-side DESTINATION resolution is real
 * evidence too), then submit verification with NOTHING but the phone, the code
 * and the role — no payout destination and no registration fields, because an
 * existing agent is never asked for any of them.
 */
async function signInWithEmailCode(submittedPhone: string) {
  const request = await http('/api/auth/request-otp', { body: { phone: submittedPhone, role: 'agent' } });
  const sent = loginOtpEmail();
  if (!sent) throw new Error('the route dispatched no login OTP email for ' + submittedPhone);
  const code = codeFromEmail(sent.body);
  const verify = await http('/api/auth/verify-otp', {
    body: { phone: submittedPhone, code, role: 'agent' },
  });
  return { request, verify, code, sent };
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
// 1. D2 — AN EXISTING AGENT COMPLETES SIGN-IN WITH NOTHING BUT A PHONE AND A CODE
// -----------------------------------------------------------------------------
describe('1. an existing agent signs in without any registration data', () => {
  it('accepts { phone, code, role } and returns THAT agent, not a new one', async () => {
    const phone = nextPhone();
    const agent = await seedAgent({ storedPhone: phone });
    const before = (await db.getAgents()).length;

    const { verify, sent } = await signInWithEmailCode(phone);

    expect(verify.status).toBe(200);
    expect(verify.body.token).toBeTruthy();
    expect(verify.body.profile.agentId).toBe(agent.id);
    expect(verify.body.profile.role).toBe('agent');
    // The mailbox that received the code is the agent's VERIFIED address, so the
    // request endpoint resolved this very row server-side.
    expect(sent.to).toBe(agent.email);
    // No registration was performed and no second row appeared.
    expect((await db.getAgents()).length).toBe(before);
    expect(verify.text).not.toMatch(/business details/i);
  });

  it('lets that sign-in reach the agent hub with the token it was given', async () => {
    const phone = nextPhone();
    const agent = await seedAgent({ storedPhone: phone });
    const { verify } = await signInWithEmailCode(phone);

    const queue = await http('/api/agents/queue', { token: verify.body.token });
    expect(queue.status).toBe(200);
    // The queue DTO is an explicit allowlist and deliberately carries no id, so
    // the fixture's own business name is what identifies the row here.
    expect(queue.body.agent.business_name).toBe('SGN Fixture ' + agent.id);
    expect(queue.body.agent.payout_method_type).toBe(PERSONAL_MPESA_PAYOUT_METHOD);
  });

  it('keeps the request endpoint a generic dead end for a registered number', async () => {
    const phone = nextPhone();
    await seedAgent({ storedPhone: phone });
    const { request } = await signInWithEmailCode(phone);
    expect(request.status).toBe(200);
    expect(request.body.success).toBe(true);
    // Byte-identical wording to the unregistered case: the response cannot be
    // used to learn whether a number exists.
    expect(String(request.body.message)).toMatch(/If this account has a verified email address/);
  });
});

// -----------------------------------------------------------------------------
// 2. D2 — EVERY SUPPORTED SPELLING OF THE NUMBER FINDS THE SAME EXISTING AGENT
//    A row may hold whatever was typed at registration (the route stores the
//    raw string), and the code may be submitted in any supported spelling. Both
//    endpoints must resolve identically, or sign-in fails for a real agent.
// -----------------------------------------------------------------------------
describe('2. equivalent Kenyan spellings resolve to the same existing agent', () => {
  const cases: Array<{ label: string; stored: 'canonical' | 'local' | 'bare'; submitted: 'canonical' | 'local' | 'spaced' }> = [
    { label: 'stored +254..., submitted 07...', stored: 'canonical', submitted: 'local' },
    { label: 'stored 07..., submitted +254...', stored: 'local', submitted: 'canonical' },
    { label: 'stored 254... (no plus), submitted +254 ... (spaced)', stored: 'bare', submitted: 'spaced' },
    { label: 'stored +254..., submitted +254... (control)', stored: 'canonical', submitted: 'canonical' },
  ];

  for (const { label, stored, submitted } of cases) {
    it(`${label}`, async () => {
      const number = nextPhone();
      const spellings = spellingsOf(number);
      const agent = await seedAgent({ storedPhone: spellings[stored] });
      const before = (await db.getAgents()).length;

      const { verify, sent } = await signInWithEmailCode(spellings[submitted]);

      expect(verify.status, label).toBe(200);
      expect(verify.body.profile.agentId, label).toBe(agent.id);
      expect(sent.to, label).toBe(agent.email);
      expect((await db.getAgents()).length, label).toBe(before);
      // The exact failure an agent saw before the fix: a sign-in answered as a
      // refused registration.
      expect(verify.text, label).not.toMatch(/business details/i);
    });
  }

  it('is the SHARED rule, evaluated directly on rows in every stored shape', () => {
    const number = nextPhone();
    const s = spellingsOf(number);
    const rows = [
      { id: 'canonical-row', contact_phone: s.canonical, email: 'a@example.com' },
      { id: 'local-row', contact_phone: s.local, email: 'b@example.com' },
      { id: 'bare-row', contact_phone: s.bare, email: 'c@example.com' },
    ];
    // Every stored shape is reachable from every submitted spelling of the SAME
    // number — and the canonical E.164 key is what makes them one identity.
    expect(toE164Kenyan(s.local)).toBe(s.canonical);
    expect(toE164Kenyan(s.spaced)).toBe(s.canonical);
    expect(toE164Kenyan(s.bare)).toBe(s.canonical);
    for (const row of rows) {
      expect(resolveAgentByPhone([row], s.canonical)?.id, row.id).toBe(row.id);
      expect(resolveAgentByPhone([row], s.local)?.id, row.id).toBe(row.id);
      expect(resolveAgentByPhone([row], s.spaced)?.id, row.id).toBe(row.id);
      expect(resolveAgentByPhone([row], s.bare)?.id, row.id).toBe(row.id);
    }
  });
});

// -----------------------------------------------------------------------------
// 3. D2 — NO INVALID OR UNSUPPORTED INPUT IS EVER MATCHED BY GUESSING
// -----------------------------------------------------------------------------
describe('3. a matcher that never guesses', () => {
  const known = nextPhone();
  const s = spellingsOf(known);
  const rows = [{ id: 'only-row', contact_phone: s.canonical, email: 'x@example.com' }];

  it('does not resolve a DIFFERENT, entirely valid number to that agent', () => {
    const other = nextPhone();
    expect(resolveAgentByPhone(rows, other)).toBeUndefined();
    expect(resolveAgentByPhone(rows, spellingsOf(other).local)).toBeUndefined();
  });

  it('does not resolve malformed, non-Kenyan or unsupported spellings', () => {
    for (const bad of ['071234567', '07123456789', '0812345678', '+255712345678', 'E2E-TILL', '0712-345-678', '   ', '']) {
      expect(resolveAgentByPhone(rows, bad), bad).toBeUndefined();
    }
  });

  it('never treats an empty or absent stored number as an identity', () => {
    const empty = [{ id: 'empty-row', contact_phone: '' }, { id: 'null-row', contact_phone: null }];
    expect(resolveAgentByPhone(empty, '')).toBeUndefined();
    expect(resolveAgentByPhone(empty, s.canonical)).toBeUndefined();
  });

  it('still reaches the REGISTRATION arm for a number no agent holds', async () => {
    const registeredPhone = nextPhone();
    const seeded = await seedAgent({ storedPhone: registeredPhone });
    const stranger = nextPhone();
    const code = await issueRealOtp(stranger);
    const before = (await db.getAgents()).length;

    const verify = await http('/api/auth/verify-otp', { body: { phone: stranger, code, role: 'agent' } });

    // The registration arm is still the arm for an unknown number, and its
    // refusal names the missing registration fields.
    expect(verify.status).toBe(400);
    expect(String(verify.body.error)).toMatch(/business details/i);
    expect(verify.body.profile?.agentId).not.toBe(seeded.id);
    expect((await db.getAgents()).length).toBe(before);
  });

  it('still refuses an unsupported spelling at the door, dispatching nothing', async () => {
    const request = await http('/api/auth/request-otp', { body: { phone: '0712-345-678', role: 'agent' } });
    expect(request.status).toBe(400);
    expect(String(request.body.error)).toMatch(/valid Safaricom or Airtel phone number/i);
    expect(loginOtpEmail()).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// 4. D1 — THE CLIENT PAYOUT REFUSAL, EVALUATED FOR THE SIGN-IN STATE
//
// AgentView's handler cannot be rendered here (this repository ships no DOM
// harness — see the note at the top of this file), so the shipped refusal and the
// guards that ENCLOSE it are extracted from the shipped source and the resulting
// expression is EVALUATED. The claim under test is therefore "does this shipped
// rule block a sign-in?", not "does this string appear in the file?".
// -----------------------------------------------------------------------------

/**
 * Every `if (<condition>) { ... }` block in `source` whose block CONTAINS the
 * offset `siteAt`, outermost first. The inner
 * `if (canonicalPayoutDestination === null)` is NOT the whole rule on its own: in
 * handleAuthRequest it is nested inside
 * `if (isRegistering && registrationStep === 3)`, and inheriting that nesting —
 * or failing to inherit it — is precisely what the sign-in path got wrong.
 */
function enclosingIfGuards(source: string, siteAt: number): string[] {
  const found: string[] = [];
  const re = /\bif\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const openParen = m.index + m[0].length - 1;
    let depth = 0;
    let closeParen = -1;
    for (let i = openParen; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') { depth--; if (depth === 0) { closeParen = i; break; } }
    }
    if (closeParen === -1) continue;
    let blockStart = closeParen + 1;
    while (blockStart < source.length && /\s/.test(source[blockStart])) blockStart++;
    if (source[blockStart] !== '{') continue;
    let braceDepth = 0;
    let blockEnd = -1;
    for (let i = blockStart; i < source.length; i++) {
      if (source[i] === '{') braceDepth++;
      else if (source[i] === '}') { braceDepth--; if (braceDepth === 0) { blockEnd = i; break; } }
    }
    if (blockEnd === -1 || siteAt <= blockStart || siteAt > blockEnd) continue;
    found.push(source.slice(openParen + 1, closeParen).replace(/\s+/g, ' ').trim());
  }
  return found;
}

/** The shipped payout refusals, each with the FULL condition that runs it. */
function payoutRefusalScopes(source: string): Array<{ at: number; scope: string }> {
  const NEEDLE = 'setAuthError(payoutDestinationMessage);';
  const out: Array<{ at: number; scope: string }> = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(NEEDLE, from);
    if (at === -1) return out;
    from = at + NEEDLE.length;
    const guards = enclosingIfGuards(source, at);
    if (guards.length === 0) continue;
    out.push({ at, scope: guards.map((g) => `(${g})`).join(' && ') });
  }
}

type SignInState = {
  isRegistering: boolean;
  registrationStep: number;
  canonicalPayoutDestination: string | null;
};

/** Evaluates a SHIPPED guard expression. True means "this refusal would run". */
function guardFires(scope: string, state: SignInState): boolean {
  const fn = new Function(
    'isRegistering',
    'registrationStep',
    'canonicalPayoutDestination',
    `return (${scope});`,
  );
  return Boolean(fn(state.isRegistering, state.registrationStep, state.canonicalPayoutDestination));
}

describe('4. the shipped payout refusal does not block an existing agent sign-in', () => {
  const refusals = payoutRefusalScopes(AGENT_VIEW);
  const otpVerifyStart = AGENT_VIEW.indexOf('const handleOtpVerify = async');
  /** The refusal in handleAuthRequest: the gate that stops the REQUEST. */
  const formRefusal = refusals.filter((r) => r.at < otpVerifyStart);
  /** The refusal in handleOtpVerify: the payload-level defence in depth. */
  const payloadRefusal = refusals.filter((r) => r.at > otpVerifyStart);

  /** An EXISTING agent signing in: nothing is being registered, so no destination. */
  const SIGN_IN: SignInState = { isRegistering: false, registrationStep: 0, canonicalPayoutDestination: null };
  /** The registration review step, before a destination has been typed. */
  const REGISTRATION_EMPTY: SignInState = { isRegistering: true, registrationStep: 3, canonicalPayoutDestination: null };
  /** An earlier registration step: this refusal is not the one that runs there. */
  const REGISTRATION_STEP_1: SignInState = { isRegistering: true, registrationStep: 1, canonicalPayoutDestination: null };
  /** The registration review step with a valid, canonical destination. */
  const REGISTRATION_VALID: SignInState = { isRegistering: true, registrationStep: 3, canonicalPayoutDestination: '254712345678' };

  it('keeps both payout refusals in the shipped component', () => {
    expect(refusals).toHaveLength(2);
    expect(formRefusal).toHaveLength(1);
    expect(payloadRefusal).toHaveLength(1);
    expect(otpVerifyStart).toBeGreaterThan(-1);
  });

  it('lets the sign-in state through EVERY shipped refusal', () => {
    // THE REGRESSION. Before the fix the verification handler's refusal was
    // unconditional, so this list held a firing guard and the handler returned
    // before it could post the code it had just been emailed.
    expect(refusals.filter((r) => guardFires(r.scope, SIGN_IN)).map((r) => r.scope)).toEqual([]);
  });

  it('still refuses an EMPTY destination when a registration is submitted', () => {
    // At the review step BOTH shipped refusals apply: the form's own gate stops
    // the request, and the payload-level defence-in-depth check would stop the
    // submission. Either one alone is enough — that redundancy is deliberate.
    expect(formRefusal).toHaveLength(1);
    expect(payloadRefusal).toHaveLength(1);
    expect(guardFires(formRefusal[0].scope, REGISTRATION_EMPTY)).toBe(true);
    expect(guardFires(payloadRefusal[0].scope, REGISTRATION_EMPTY)).toBe(true);
  });

  it('keeps the form gate scoped to the review step, and silent for a valid destination', () => {
    // The form handler ADVANCES the earlier steps rather than refusing them...
    expect(guardFires(formRefusal[0].scope, REGISTRATION_STEP_1)).toBe(false);
    // ...an existing agent never trips it at all...
    expect(guardFires(formRefusal[0].scope, SIGN_IN)).toBe(false);
    // ...and a valid destination is refused by neither.
    for (const r of refusals) {
      expect(guardFires(r.scope, REGISTRATION_VALID), r.scope).toBe(false);
    }
  });

  it('scopes the verification handler refusal to registration, and only to registration', () => {
    const inVerifyHandler = refusals.filter((r) => r.at > otpVerifyStart);
    expect(inVerifyHandler).toHaveLength(1);
    expect(inVerifyHandler[0].scope).toContain('isRegistering');
    expect(guardFires(inVerifyHandler[0].scope, SIGN_IN)).toBe(false);
    expect(guardFires(inVerifyHandler[0].scope, REGISTRATION_EMPTY)).toBe(true);
  });

  it('leaves the verification request reachable in the same handler', () => {
    const handler = AGENT_VIEW.slice(otpVerifyStart);
    expect(handler).toContain("fetch('/api/auth/verify-otp'");
    // ...and the one refusal guarding it is the refusal evaluated above.
    expect(refusals.filter((r) => r.at > otpVerifyStart)).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// 5. REGISTRATION IS UNCHANGED — the payout contract is still enforced there,
//    the refusal is still side-effect-free, and a valid application still lands.
// -----------------------------------------------------------------------------
describe('5. registration still enforces the personal M-Pesa contract', () => {
  /** One registration submission against a brand-new number, with a REAL code. */
  async function registerAttempt(overrides: Record<string, any> = {}, includeRegistrationFields = true) {
    const phone = nextPhone();
    const code = await issueRealOtp(phone);
    const email = `sgn-reg-${phone.replace(/\D/g, '')}@example.com`;
    const result = await http('/api/auth/verify-otp', {
      body: {
        phone,
        code,
        role: 'agent',
        ...(includeRegistrationFields
          ? {
              businessName: 'SGN Registration Fixture',
              locationAddress: 'Kenyatta Avenue, Nairobi',
              county: 'Nairobi',
              administrativeUnitId: UNIT_ID,
              tillNumber: '0712345678',
              payoutMethodType: PERSONAL_MPESA_PAYOUT_METHOD,
              nationalId: '12345678',
              termsAccepted: true,
              contactEmail: email,
            }
          : {}),
        ...overrides,
      },
    });
    return { phone, email, result };
  }

  it('refuses every missing or invalid personal M-Pesa destination', async () => {
    // The empty and absent cases are caught by the route's required-fields check
    // (which runs first, unchanged); every non-empty unusable value is refused by
    // the payout guard itself. Either way: 400, and nothing created.
    const refused: Array<[string, unknown, RegExp]> = [
      ['an empty string', '', /business details/i],
      ['missing entirely', undefined, /business details/i],
      ['whitespace only', '   ', /personal M-Pesa/i],
      ['a Till number', '123456', /personal M-Pesa/i],
      ['too short', '07123456', /personal M-Pesa/i],
      ['non-Kenyan', '+255712345678', /personal M-Pesa/i],
    ];
    for (const [label, value, expected] of refused) {
      const before = (await db.getAgents()).length;
      const { result } = await registerAttempt({ tillNumber: value });
      expect(result.status, label).toBe(400);
      expect(String(result.body.error), label).toMatch(expected);
      // A refused registration still creates nothing.
      expect((await db.getAgents()).length, label).toBe(before);
    }
  });

  it('refuses an unsupported or missing payout METHOD even with a perfect destination', async () => {
    for (const method of ['Till Number', 'Paybill Number', 'Pochi la Biashara', undefined]) {
      const before = (await db.getAgents()).length;
      const { result } = await registerAttempt({ payoutMethodType: method });
      expect(result.status, String(method)).toBe(400);
      expect(String(result.body.error), String(method)).toMatch(/personal M-Pesa is supported/i);
      expect((await db.getAgents()).length, String(method)).toBe(before);
    }
  });

  it('still refuses a registration whose OTP verified but that is not registerable', async () => {
    // The sign-in fix must not have made the registration arm reachable with an
    // incomplete application: no registration fields at all is still a 400.
    const before = (await db.getAgents()).length;
    const { result } = await registerAttempt({}, false);
    expect(result.status).toBe(400);
    expect((await db.getAgents()).length).toBe(before);
  });

  it('still registers a brand-new agent end to end, storing a payable leg', async () => {
    const phone = nextPhone();
    const email = `sgn-onboard-${phone.replace(/\D/g, '')}@example.com`;

    const request = await http('/api/auth/request-otp', { body: { phone, email, role: 'agent' } });
    expect(request.status).toBe(200);
    // The onboarding arm sends the code to the address the applicant supplied.
    const sent = loginOtpEmail(email);
    expect(sent, 'the onboarding OTP email must be dispatched').toBeTruthy();
    const code = codeFromEmail(sent!.body);

    const verify = await http('/api/auth/verify-otp', {
      body: {
        phone,
        code,
        role: 'agent',
        businessName: 'SGN Onboarding Fixture',
        locationAddress: 'Kenyatta Avenue, Nairobi',
        county: 'Nairobi',
        administrativeUnitId: UNIT_ID,
        tillNumber: '0712345678',
        payoutMethodType: PERSONAL_MPESA_PAYOUT_METHOD,
        nationalId: '12345678',
        termsAccepted: true,
        contactEmail: email,
      },
    });

    expect(verify.status).toBe(200);
    expect(verify.body.profile.status).toBe('pending');
    expect(verify.body.profile.emailVerified).toBe(false);
    expect(verify.body.profile.activationRequired).toBe(true);

    const created = (await db.getAgents()).find((a) => a.contact_phone === phone);
    expect(created, 'the new agent row must exist').toBeTruthy();
    // B1's contract is intact: the CANONICAL destination and the ONE supported
    // method are what the row holds.
    expect(created!.mpesa_till_or_paybill).toBe('254712345678');
    expect(created!.payout_method_type).toBe(PERSONAL_MPESA_PAYOUT_METHOD);
    expect(created!.contact_email).toBe(email);
    expect(
      emails.sent.some((e) => e.subject === 'Verify your Return4me agent email'),
      'the N4 activation email must still be sent',
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 6. AUTHORIZATION AND PAYOUT ELIGIBILITY ARE UNTOUCHED.
//    Signing in proves PHONE OWNERSHIP; it grants nothing. The three refusal
//    axes and the executor's own eligibility predicate must be exactly as they
//    were, or the fix would have traded one lockout for a security hole.
// -----------------------------------------------------------------------------
describe('6. authorization, suspension and payout eligibility are unchanged', () => {
  it('signs in a PENDING agent, then refuses its hub as pending approval', async () => {
    const phone = nextPhone();
    const agent = await seedAgent({ storedPhone: phone, status: 'pending' });
    expect(isAgentActionable(await db.getAgent(agent.id))).toBe(false);

    const { verify } = await signInWithEmailCode(phone);
    expect(verify.status).toBe(200);

    const queue = await http('/api/agents/queue', { token: verify.body.token });
    expect(queue.status).toBe(403);
    expect(queue.body.code).toBe('AGENT_PENDING_APPROVAL');
  });

  it('signs in a SUSPENDED agent, then refuses its hub as suspended', async () => {
    const phone = nextPhone();
    const agent = await seedAgent({ storedPhone: phone, status: 'suspended' });
    expect(isAgentActionable(await db.getAgent(agent.id))).toBe(false);

    const { verify } = await signInWithEmailCode(phone);
    expect(verify.status).toBe(200);

    const queue = await http('/api/agents/queue', { token: verify.body.token });
    expect(queue.status).toBe(403);
    expect(queue.body.code).toBe('AGENT_SUSPENDED');
  });

  it('signs in an APPROVED but UNVERIFIED agent, then refuses its hub as inactive', async () => {
    const phone = nextPhone();
    const agent = await seedAgent({ storedPhone: phone, emailVerified: false });
    expect(isAgentActionable(await db.getAgent(agent.id))).toBe(false);

    // No login OTP can be delivered to this account (the route fails closed with
    // no verified destination), so the code is issued through the real service
    // with only the transport replaced — a genuine code, genuinely verified.
    const code = await issueRealOtp(phone);
    const verify = await http('/api/auth/verify-otp', { body: { phone, code, role: 'agent' } });
    expect(verify.status).toBe(200);
    expect(verify.body.profile.agentId).toBe(agent.id);
    expect(verify.body.profile.emailVerified).toBe(false);
    expect(verify.body.profile.activationRequired).toBe(true);

    const queue = await http('/api/agents/queue', { token: verify.body.token });
    expect(queue.status).toBe(403);
    expect(queue.body.code).toBe('AGENT_INACTIVE');
  });

  it('leaves the executor OWN eligibility predicate paying the signed-in leg', async () => {
    const phone = nextPhone();
    const agent = await seedAgent({ storedPhone: phone });
    const { verify } = await signInWithEmailCode(phone);
    expect(verify.status).toBe(200);

    const row = await db.getAgent(agent.id);
    const leg = resolvePayoutLegEligibility({
      recipientType: 'agent',
      destination: row!.mpesa_till_or_paybill,
      payoutMethodType: row!.payout_method_type,
    });
    expect(leg.eligible).toBe(true);
    expect(leg.canonicalDestination).toBe('254712345678');
  });

  it('leaves the all-or-nothing batch rule intact', async () => {
    const batch = resolvePayoutBatchEligibility([
      { recipientType: 'finder', destination: '0712345678', payoutMethodType: PERSONAL_MPESA_PAYOUT_METHOD },
      { recipientType: 'agent', destination: '123456', payoutMethodType: 'Till Number' },
    ]);
    expect(batch.legs[0].eligible).toBe(true);
    expect(batch.eligible).toBe(false);
    expect(batch.ineligible.map((l) => l.recipientType)).toEqual(['agent']);
  });
});









// — the only transport replaced anywhere in this file is the email provider.
import { AuthService, resolveAgentByPhone, toE164Kenyan, isAgentActionable } from '../services/auth';
