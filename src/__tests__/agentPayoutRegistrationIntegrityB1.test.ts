// =============================================================================
// B1 — AGENT PAYOUT-REGISTRATION INTEGRITY.
//
// THE DEFECT THIS SUITE PINS. The launch payout policy
// (src/config/payoutDestinations.ts) pays Kenyan PERSONAL M-PESA PHONE
// destinations only — exactly one method string ('Personal M-Pesa') and exactly
// one destination shape (254 followed by nine digits). Registration, however,
// DEFAULTED to 'Till Number', offered Till / Paybill / Pochi choices, and the
// route stored whatever the client sent. A newly registered agent could
// therefore hold a method and destination the executor refuses — and because the
// executor refuses the WHOLE batch when one leg is ineligible, the paired FINDER
// leg was blocked as well. Registration is the only writer of both columns and
// there is no correction path, so the agent simply stayed unpayable.
//
// WHAT THIS FILE PROVES
//   1. the form's default is the SHARED constant, and no unsupported choice
//      survives anywhere in it;
//   2. the route accepts EXACTLY what the policy accepts and refuses exactly what
//      it refuses — over REAL HTTP against the real application, so the two
//      cannot silently disagree;
//   3. a refused registration leaves NO agent row, NO stored image and NO agent
//      email behind: the guard runs before every side effect that could create
//      partial registration state;
//   4. a valid registration stores the CANONICAL destination and the supported
//      method, and the executor's OWN eligibility predicate then finds that
//      stored leg payable;
//   5. the default for FUTURE records changed in all three schema sources, by an
//      additive, idempotent statement, with NO backfill and NO row rewrite.
//
// LIMITATION, STATED PLAINLY, NOT HIDDEN. The settlement executor itself cannot
// be driven here: executeClaimSettlement() lives in server.ts, which boots the
// application on import. Point 4 therefore composes the REAL stored row with the
// REAL predicate the executor calls (resolvePayoutLegEligibility) instead of
// moving money, and the end-to-end batch refusal stays covered by
// lifecycleHttpE2E.test.ts stage 8.9.
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
  normalizePersonalMpesaPhoneDestination,
  resolvePayoutLegEligibility,
  resolvePayoutBatchEligibility,
} from '../config/payoutDestinations';

// --- ONLY THE PROVIDERS ARE DOUBLED. EVERY BUSINESS RULE IS REAL. ------------
// The same seams the N4 and E1 suites use: SMS capture, email capture, storage
// capture. Hashing, OTP storage/consumption, validation, the county/sub-county
// checks, the audit trail and the database write are all the real code paths.
const emails = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; subject: string; body: string }>,
  accept: true,
}));
const uploads = vi.hoisted(() => ({ folders: [] as string[] }));
const sms = vi.hoisted(() => ({ sent: [] as Array<{ phone: string; code: string }> }));

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
              ? { accepted: true, providerMessageId: 'b1-mock-1', providerError: null }
              : { accepted: false, providerMessageId: null, providerError: null };
          });
        }
        return target[prop];
      },
    }),
  };
});

// Capture-only storage seam. The FOLDER is recorded so a test can prove which
// upload actually happened — and, more importantly, that NONE happened for a
// registration the payout guard refused.
vi.mock('../services/storage', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    uploadBase64Image: vi.fn(async (_base64: string, folder: string) => {
      uploads.folders.push(String(folder));
      return 'https://storage.test/b1.jpg';
    }),
  };
});

// Same honest wrapper as the N4 suite: a real CSPRNG code is generated and
// persisted through the REAL db.setOtp with the REAL hashCode, and only the
// network send is captured. verifyOTP and its expiry/single-use rules are NOT
// touched, so every verify-otp call below is a genuine OTP verification.
vi.mock('../services/auth', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const realDbModule: any = await import('../db/database.ts');
  const nodeCrypto = await import('crypto');

  const captureSms = vi.fn(async () => ({ success: true, failureReason: null, retryable: false }));

  const AuthService = new Proxy(actual.AuthService ?? {}, {
    get(target: any, prop: string) {
      if (prop === 'sendSms') return captureSms;
      if (prop === 'requestOTP') {
        return async (phone: string) => {
          const cleanPhone = String(phone).replace(/\s+/g, '');
          if (!/^(\+254|0)(7|1)[0-9]{8}$/.test(cleanPhone)) return target[prop](phone);
          const e164 = actual.toE164Kenyan(cleanPhone);
          const code = nodeCrypto.randomInt(1000, 10000).toString();
          await realDbModule.db.setOtp(e164, actual.hashCode(code), new Date(Date.now() + 5 * 60 * 1000));
          sms.sent.push({ phone: e164, code });
          return { success: true, message: 'captured in test' };
        };
      }
      return target[prop];
    },
  });

  return {
    ...actual,
    AuthService,
    sendCodeViaSms: vi.fn(async (phone: string, code: string) => {
      sms.sent.push({ phone, code });
      return { success: true, message: 'captured in test' };
    }),
    sendSms: captureSms,
  };
});

// Imported AFTER the mocks are registered.
const { createApp } = await import('../server.ts');

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const AGENT_VIEW = read('src/components/AgentView.tsx');
const BECOME_AGENT = read('src/components/BecomeAgentView.tsx');
const SERVER_TS = read('src/server.ts');
const SCHEMA_TS = read('src/db/schema.ts');
const DB_INDEX_TS = read('src/db/index.ts');
const DATABASE_TS = read('src/db/database.ts');
const SCHEMA_SQL = read('sql/schema.sql');

/** A real PNG header, so isValidImageSignature() genuinely passes. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const RUN = testRunId;
const COUNTY = resolveCountyName('Nairobi')!;
const UNIT_ID = administrativeUnitsForCounty(COUNTY)[0]?.id;

let app: any;
let server: any;
let base = '';
let xffSeq = 0;
let phoneSeq = 0;

function nextForwardedFor(): string {
  xffSeq += 1;
  return `10.66.${Math.floor(xffSeq / 250)}.${(xffSeq % 250) + 1}`;
}

/** A unique, valid E.164 Kenyan MOBILE number per call (07xx range). */
function nextPhone(): string {
  phoneSeq += 1;
  return '+2547' + String(20000000 + ((phoneSeq * 7919 + phoneSeq * phoneSeq) % 19999999)).slice(-8);
}

async function http(pathname: string, opts: { body?: any } = {}) {
  const headers: Record<string, string> = { 'X-Forwarded-For': nextForwardedFor() };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method: opts.body !== undefined ? 'POST' : 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json, text };
}

/**
 * Drives the REAL two-step registration over HTTP and returns the verify-otp
 * response. `payout` is whatever the caller wants to send for the two payout
 * fields, so every case below travels the identical path the browser uses.
 */
async function registerAgent(
  payout: { tillNumber?: unknown; payoutMethodType?: unknown },
  overrides: Record<string, any> = {},
  includePhoto = false,
) {
  const phone = nextPhone();
  const email = `b1-${phone.replace(/\D/g, '')}@example.com`;
  await http('/api/auth/request-otp', { body: { phone, email, role: 'agent' } });
  const code = [...sms.sent].reverse().find((m) => m.phone === phone)?.code;
  if (!code) throw new Error('no OTP captured for ' + phone);

  const result = await http('/api/auth/verify-otp', {
    body: {
      phone,
      code,
      role: 'agent',
      businessName: 'B1 Test Shop ' + RUN,
      locationAddress: 'Kenyatta Avenue, Nairobi',
      county: 'Nairobi',
      administrativeUnitId: UNIT_ID,
      nationalId: '12345678',
      termsAccepted: true,
      contactEmail: email,
      ...payout,
      ...(includePhoto ? { shopPhotoBase64: PNG_B64 } : {}),
      ...overrides,
    },
  });
  return { phone, email, result };
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
  sms.sent.length = 0;
  uploads.folders.length = 0;
});

// -----------------------------------------------------------------------------
// A. THE FORM'S CONTRACT (source contract — this repository has no DOM harness,
//    the same limitation UX-12 documents).
// -----------------------------------------------------------------------------
describe('A. the registration form offers ONE supported method and one phone field', () => {
  it('defaults the payout method to the SHARED policy constant, not a literal', () => {
    expect(AGENT_VIEW).toContain('useState(PERSONAL_MPESA_PAYOUT_METHOD)');
    expect(AGENT_VIEW).not.toContain("useState('Till Number')");
  });

  it('imports the constant and the canonical normaliser instead of restating them', () => {
    expect(AGENT_VIEW).toContain("from '../config/payoutDestinations'");
    expect(AGENT_VIEW).toContain('PERSONAL_MPESA_PAYOUT_METHOD');
    expect(AGENT_VIEW).toContain('normalizePersonalMpesaPhoneDestination');
    // No competing literal is invented beside them.
    expect(AGENT_VIEW).not.toContain("=== 'Personal M-Pesa'");
  });

  it('no longer OFFERS Till Number, Paybill Number or Pochi la Biashara', () => {
    for (const unsupported of ['Till Number', 'Paybill Number', 'Pochi la Biashara']) {
      expect(AGENT_VIEW, `option ${unsupported}`).not.toContain(`<option value="${unsupported}">`);
    }
    expect(AGENT_VIEW).toContain('<option value={PERSONAL_MPESA_PAYOUT_METHOD}>');
    // The step still owns exactly the method control and the destination field.
    expect(AGENT_VIEW).toContain('id="agent-payout-method"');
    expect(AGENT_VIEW).toContain('id="agent-till-number"');
  });

  it('asks for a personal M-Pesa PHONE NUMBER, with a Kenyan example', () => {
    expect(AGENT_VIEW).toContain('Personal M-Pesa phone number');
    expect(AGENT_VIEW).toContain('07XX XXX XXX');
    const at = AGENT_VIEW.indexOf('id="agent-till-number"');
    expect(at).toBeGreaterThan(-1);
    expect(/\brequired\b/.test(AGENT_VIEW.slice(at, at + 500))).toBe(true);
  });

  it('says in plain English which methods are NOT supported', () => {
    expect(AGENT_VIEW).toMatch(/not supported/i);
    expect(AGENT_VIEW).toMatch(/Send Money/);
  });

  it('identifies the destination truthfully on Review, without printing the number', () => {
    const at = AGENT_VIEW.indexOf("reviewGroup('Payout'");
    expect(at).toBeGreaterThan(-1);
    const review = AGENT_VIEW.slice(at, at + 400);
    expect(review).toContain('Personal M-Pesa phone number');
    expect(review).not.toContain('{tillNumber}');
    expect(review).toContain("tillNumber ? 'Provided' : 'Not provided'");
  });

  it('keeps the PUBLIC become-an-agent page honest about the same contract', () => {
    // The page states what the application asks for. B1 changed that, so it must
    // not still advertise the refused methods as accepted. The pinned prefix is
    // preserved, so the existing public-page suite is unaffected.
    expect(BECOME_AGENT).toContain('An M-Pesa payout number');
    expect(BECOME_AGENT).toContain('a personal M-Pesa phone number');
    expect(BECOME_AGENT).toMatch(/not supported at launch/i);
  });
});

// -----------------------------------------------------------------------------
// B. THE ROUTE ACCEPTS EXACTLY WHAT THE POLICY ACCEPTS — over real HTTP.
// -----------------------------------------------------------------------------
describe('B. the registration route enforces the payout policy itself', () => {
  it('stores the canonical 254XXXXXXXXX form for every documented input shape', async () => {
    const cases: Array<[string, string]> = [
      ['0712345678', '254712345678'],
      ['+254712345678', '254712345678'],
      ['254712345678', '254712345678'],
      ['+254 712 345 678', '254712345678'],
      ['0712-345-678', '254712345678'],
      ['(0712) 345678', '254712345678'],
      ['0110000000', '254110000000'],
    ];
    for (const [input, canonical] of cases) {
      const { result } = await registerAgent({
        tillNumber: input,
        payoutMethodType: PERSONAL_MPESA_PAYOUT_METHOD,
      });
      expect(result.status, input).toBe(200);
      const agent = await db.getAgent(result.body.profile.agentId);
      expect(agent!.mpesa_till_or_paybill, input).toBe(canonical);
      expect(agent!.payout_method_type, input).toBe(PERSONAL_MPESA_PAYOUT_METHOD);
    }
  });

  it('refuses every destination the policy refuses, with 400', async () => {
    const refused: Array<[string, unknown]> = [
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['no digits at all', 'E2E-TILL'],
      ['a Till number', '123456'],
      ['too short', '07123456'],
      ['too long', '07123456789'],
      ['non-Kenyan (+255)', '+255712345678'],
      ['a non-mobile Kenyan range', '0812345678'],
      ['an unexpected type (object)', { number: '0712345678' }],
      ['an unexpected type (boolean)', true],
      ['missing entirely', undefined],
    ];
    for (const [label, value] of refused) {
      const { result } = await registerAgent({
        tillNumber: value,
        payoutMethodType: PERSONAL_MPESA_PAYOUT_METHOD,
      });
      expect(result.status, label).toBe(400);
    }
  });

  it('refuses an unsupported or missing METHOD even when the destination is perfect', async () => {
    for (const method of [
      'Till Number',
      'Paybill Number',
      'Pochi la Biashara',
      'personal m-pesa',
      ' Personal M-Pesa',
      '',
      undefined,
      null,
      42,
    ]) {
      const { result } = await registerAgent({ tillNumber: '0712345678', payoutMethodType: method });
      expect(result.status, JSON.stringify(method)).toBe(400);
      expect(String(result.body.error), JSON.stringify(method)).toMatch(/personal M-Pesa is supported/i);
    }
  });

  it('refuses a fresh value without echoing it, and names what IS supported', async () => {
    const { result } = await registerAgent({
      tillNumber: 'E2E-NOT-A-PHONE-9137',
      payoutMethodType: PERSONAL_MPESA_PAYOUT_METHOD,
    });
    expect(result.status).toBe(400);
    const error = String(result.body.error);
    expect(error).toMatch(/personal M-Pesa phone number/i);
    expect(error).not.toContain('E2E-NOT-A-PHONE-9137');
    expect(error.toLowerCase()).not.toMatch(/verified|validated|confirmed/);
  });

  it('agrees with the pure policy on the same inputs (one rule, two callers)', () => {
    for (const value of ['0712345678', '+254712345678', '0110000000']) {
      expect(normalizePersonalMpesaPhoneDestination(value), value).not.toBeNull();
    }
    for (const value of ['123456', 'E2E-TILL', '07123456', '07123456789', '+255712345678', '0812345678', '', '   ']) {
      expect(normalizePersonalMpesaPhoneDestination(value), value).toBeNull();
    }
  });
});

// -----------------------------------------------------------------------------
// C. A REFUSED REGISTRATION LEAVES NO PARTIAL REGISTRATION STATE.
// -----------------------------------------------------------------------------
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** The route body of POST /api/auth/verify-otp, comment-stripped. */
const verifyOtpBody = () => {
  const code = stripComments(SERVER_TS);
  const start = code.indexOf("app.post('/api/auth/verify-otp'");
  expect(start).toBeGreaterThan(-1);
  return code.slice(start);
};

/** Agent ACTIVATION emails only — the OTP email from request-otp is expected. */
const activationEmails = () => emails.sent.filter((e) => e.subject.toLowerCase().includes('agent'));

describe('C. a refused registration leaves no partial state behind', () => {
  it('creates no agent row, stores no image and sends no agent activation email', async () => {
    const before = (await db.getAgents()).length;
    // includePhoto = true, and the photograph is a VALID one: an upload WOULD
    // happen if the guard ran after the upload step, so the empty list below is
    // evidence about the ordering, not about the image being rejected.
    const { result, email } = await registerAgent(
      { tillNumber: '123456', payoutMethodType: PERSONAL_MPESA_PAYOUT_METHOD },
      {},
      true,
    );
    expect(result.status).toBe(400);
    expect((await db.getAgents()).length).toBe(before);
    expect((await db.getAgents()).find((a) => a.contact_email === email)).toBeUndefined();
    expect(uploads.folders).toEqual([]);
    expect(activationEmails()).toHaveLength(0);
  });

  it('the same is true for an unsupported METHOD', async () => {
    const before = (await db.getAgents()).length;
    for (const method of ['Till Number', 'Paybill Number', 'Pochi la Biashara', undefined]) {
      const { result, email } = await registerAgent(
        { tillNumber: '0712345678', payoutMethodType: method },
        {},
        true,
      );
      expect(result.status, String(method)).toBe(400);
      expect((await db.getAgents()).find((a) => a.contact_email === email)).toBeUndefined();
    }
    expect((await db.getAgents()).length).toBe(before);
    expect(uploads.folders).toEqual([]);
    expect(activationEmails()).toHaveLength(0);
  });

  it('places the guard BEFORE every side effect in the route itself', () => {
    const body = verifyOtpBody();
    const guard = body.indexOf('canonicalAgentPayoutDestination');
    expect(guard).toBeGreaterThan(-1);
    for (const marker of ['uploadBase64Image', 'geocodeAddress', 'db.createAgent(']) {
      const at = body.indexOf(marker);
      expect(at, `${marker} must still be in the route`).toBeGreaterThan(-1);
      expect(at, `${marker} must come AFTER the payout guard`).toBeGreaterThan(guard);
    }
  });

  it('states the boundary honestly: the one-time code IS consumed first', () => {
    // The guard sits after AuthService.verifyOTP() deliberately — that call is
    // the authentication of the request. This pin keeps the claim precise: the
    // refusal is side-effect-free with respect to REGISTRATION STATE only.
    const body = verifyOtpBody();
    expect(body.indexOf('AuthService.verifyOTP(')).toBeLessThan(
      body.indexOf('canonicalAgentPayoutDestination'),
    );
  });
});

// -----------------------------------------------------------------------------
// D. A VALID REGISTRATION STORES A LEG THE EXECUTOR WILL PAY.
// -----------------------------------------------------------------------------
describe('D. a valid registration stores a payable leg', () => {
  it('persists the canonical destination and the supported method', async () => {
    const { result } = await registerAgent({
      tillNumber: '0712345678',
      payoutMethodType: PERSONAL_MPESA_PAYOUT_METHOD,
    });
    expect(result.status).toBe(200);
    const agent = await db.getAgent(result.body.profile.agentId);
    expect(agent!.mpesa_till_or_paybill).toBe('254712345678');
    expect(agent!.payout_method_type).toBe(PERSONAL_MPESA_PAYOUT_METHOD);
    // B1 changed the payout contract ONLY: approval and activation are untouched.
    expect(agent!.status).toBe('pending');
    expect(agent!.email_verified_at).toBeNull();
  });

  it('the executor OWN eligibility predicate finds that stored leg payable', async () => {
    const { result } = await registerAgent({
      tillNumber: '+254 722 000 111',
      payoutMethodType: PERSONAL_MPESA_PAYOUT_METHOD,
    });
    const agent = await db.getAgent(result.body.profile.agentId);
    const leg = resolvePayoutLegEligibility({
      recipientType: 'agent',
      destination: agent!.mpesa_till_or_paybill,
      payoutMethodType: agent!.payout_method_type,
    });
    expect(leg.eligible).toBe(true);
    expect(leg.reason).toBeNull();
    expect(leg.canonicalDestination).toBe('254722000111');
  });

  it('shows the defect this closes: the OLD stored shape poisons the WHOLE batch', () => {
    // Composed through the same predicate the executor uses, on the shape the
    // pre-B1 default produced. The agent leg is refused...
    const oldAgentLeg = resolvePayoutLegEligibility({
      recipientType: 'agent',
      destination: '123456',
      payoutMethodType: 'Till Number',
    });
    expect(oldAgentLeg.eligible).toBe(false);
    // ...and because ONE ineligible leg refuses the batch, the paired FINDER leg
    // — which is perfectly payable — was never sent either.
    const batch = resolvePayoutBatchEligibility([
      { recipientType: 'finder', destination: '0712345678', payoutMethodType: PERSONAL_MPESA_PAYOUT_METHOD },
      { recipientType: 'agent', destination: '123456', payoutMethodType: 'Till Number' },
    ]);
    expect(batch.legs[0].eligible).toBe(true);
    expect(batch.eligible).toBe(false);
    expect(batch.ineligible.map((l) => l.recipientType)).toEqual(['agent']);
  });
});

// -----------------------------------------------------------------------------
// E. DEFAULTS AND MIGRATION — FUTURE RECORDS ONLY, NO ROW REWRITTEN.
// -----------------------------------------------------------------------------
describe('E. the default moved in all three schema sources, additively', () => {
  it('names the SHARED constant as the Drizzle default (never a literal)', () => {
    expect(SCHEMA_TS).toContain(
      'import { PERSONAL_MPESA_PAYOUT_METHOD } from "../config/payoutDestinations"',
    );
    expect(SCHEMA_TS).toContain('.default(PERSONAL_MPESA_PAYOUT_METHOD)');
    expect(SCHEMA_TS).not.toContain('.default("Till Number")');
  });

  it('matches in the bootstrap DDL and in the runtime migration path', () => {
    expect(SCHEMA_SQL).toContain(
      "payout_method_type VARCHAR(50) NOT NULL DEFAULT 'Personal M-Pesa'",
    );
    expect(SCHEMA_SQL).not.toContain("DEFAULT 'Till Number'");
    expect(DB_INDEX_TS).toContain(
      "`ALTER TABLE agents ALTER COLUMN payout_method_type SET DEFAULT 'Personal M-Pesa'`",
    );
    expect(DB_INDEX_TS).toContain(
      "`ALTER TABLE agents ADD COLUMN IF NOT EXISTS payout_method_type VARCHAR(50) NOT NULL DEFAULT 'Personal M-Pesa'`",
    );
  });

  it('is ADDITIVE: no UPDATE, no backfill, no type change, no table rebuild', () => {
    expect(DB_INDEX_TS).not.toMatch(/UPDATE\s+agents\s+SET\s+payout_method_type/i);
    expect(DB_INDEX_TS).not.toMatch(
      /ALTER\s+TABLE\s+agents\s+ALTER\s+COLUMN\s+payout_method_type\s+TYPE/i,
    );
    expect(DB_INDEX_TS).not.toMatch(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?agents/i);
    // Exactly two statements mention the column: the ADD COLUMN and the
    // idempotent SET DEFAULT. Nothing else in the migration list touches it.
    expect((DB_INDEX_TS.match(/payout_method_type/g) ?? []).length).toBe(2);
  });

  it('leaves the READ-time fallback for EXISTING rows exactly as it was', () => {
    // Deliberately NOT changed in this batch: how a row with no recorded method
    // reads back decides how an EXISTING record is treated, and silently
    // converting it is out of scope. Reported, not remediated.
    expect(DATABASE_TS).toContain('payout_method_type: row.payout_method_type || "Till Number"');
    // The WRITE-path default for a NEW row DID move to the supported method.
    expect(DATABASE_TS).toContain(
      'payout_method_type: agent.payout_method_type || PERSONAL_MPESA_PAYOUT_METHOD',
    );
  });

  it('leaves the settlement eligibility guard and the executor untouched', () => {
    // The guard still asks the policy...
    expect(SERVER_TS).toContain('resolvePayoutBatchEligibility(');
    // ...the registration route no longer writes the old literal...
    expect(SERVER_TS).not.toContain("payout_method_type: payoutMethodType || 'Till Number'");
    // ...and the executor's OWN read-time fallback is deliberately unchanged, so
    // the treatment of existing rows cannot drift in this batch.
    expect(SERVER_TS).toContain("payoutMethodType: agent.payout_method_type || 'Till Number'");
  });
});
