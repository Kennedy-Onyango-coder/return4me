// ===========================================================================
// N4 — AGENT EMAIL ACTIVATION.
//
// The N4 counterpart of customerEmailActivationN3.test.ts, and it proves the
// things N3's suite could not: that an AGENT's email verification is a real
// authorization axis, that it is INDEPENDENT of business approval in both
// directions, and that existing agents are grandfathered rather than locked out.
//
// Three classes of assertion, because they are genuinely different claims:
//
//  1. EXECUTED, over real HTTP against the REAL `createApp()` app on an
//     ephemeral socket (the lifecycleHttpE2E.test.ts pattern). These witness
//     real token consumption, real CAS writes and real 403s from
//     requireActiveAgent — not a description of them.
//  2. EXECUTED against the real db helpers, for states that are awkward to
//     reach over HTTP (expired tokens, competing activation).
//  3. SOURCE assertions, only where execution is genuinely impossible.
//
// authenticateJWT and requireActiveAgent are NEVER bypassed. Every protected
// route is reached with a real HS256 token from the real generateToken().
// ===========================================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { testRunId } from '../db/__tests__/ensureTestCategory';
import { hashCode, generateToken, isAgentActionable } from '../services/auth';
import {
  AGENT_ACTIVATION_TTL_MS,
  buildAgentActivationUrl,
  buildAgentActivationEmailHtml,
} from '../services/customerAuth';
import { resolveCountyName } from '../config/kenyaCounties';
import { administrativeUnitsForCounty } from '../config/kenyaAdministrativeUnits';

// --- EXTERNAL PROVIDERS DOUBLED, BUSINESS LOGIC REAL -------------------------
// Only the transport is captured. Hashing, token consumption, CAS and the
// authorization predicate are all the real implementations.
const emails = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; body: string }>, accept: true }));

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const EmailService = actual.EmailService ?? {};
  return {
    ...actual,
    EmailService: new Proxy(EmailService, {
      get(target: any, prop: string) {
        // N9: the notification adapter now calls `sendWithId` so the provider
        // message id can be persisted (that id is what later makes an ambiguous
        // send resolvable). This mock is a SEAM, not an assertion about which
        // method the adapter uses, so it covers both and returns the same
        // accept/reject decision each would.
        if (prop === 'send' || prop === 'sendWithId') {
          return vi.fn(async (to: string, subject: string, body: string) => {
            emails.sent.push({ to, subject, body });
            return emails.accept
              ? { accepted: true, providerMessageId: 'n4-mock-1', providerError: null }
              : { accepted: false, providerMessageId: null, providerError: null };
          });
        }
        return target[prop];
      },
    }),
  };
});

const sms = vi.hoisted(() => ({ sent: [] as Array<{ phone: string; code: string }> }));

// AuthService.requestOTP calls the MODULE-LOCAL sendCodeViaSms directly, not
// the exported binding, so overriding the export would not intercept it.
//
// requestOTP itself is the only seam that yields the generated code, so it is
// wrapped — and wrapped HONESTLY: a real CSPRNG code is generated, persisted
// through the REAL db.setOtp with the REAL hashCode, and the same response
// shape is returned. Only the network send is replaced by a capture.
//
// verifyOTP, its hashing, its expiry and its 5-attempt invalidation are NOT
// touched and remain entirely real — which is exactly what the N4 tests that
// register agents end-to-end depend on.
vi.mock('../services/auth', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const { db: realDb } = await import('../db/database.ts');
  const nodeCrypto = await import('crypto');

  const captureSms = vi.fn(async (phone: string, message: string) => {
    sms.sent.push({ phone, code: message });
    return { success: true, failureReason: null, retryable: false };
  });

  const AuthService = new Proxy(actual.AuthService ?? {}, {
    get(target: any, prop: string) {
      if (prop === 'sendSms') return captureSms;
      if (prop === 'requestOTP') {
        return async (phone: string) => {
          const cleanPhone = String(phone).replace(/\s+/g, '');
          // An invalid number still takes the REAL path, so its 400 is genuine.
          if (!/^(\+254|0)(7|1)[0-9]{8}$/.test(cleanPhone)) return target[prop](phone);
          const e164 = actual.toE164Kenyan(cleanPhone);
          const code = nodeCrypto.randomInt(1000, 10000).toString();
          await realDb.setOtp(e164, actual.hashCode(code), new Date(Date.now() + 5 * 60 * 1000));
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

vi.mock('../services/storage', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, uploadBase64Image: vi.fn(async () => 'https://storage.test/n4.jpg') };
});

// Imported AFTER the mocks are registered.
const { createApp } = await import('../server.ts');

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
const dbTs = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');
const schemaTs = fs.readFileSync(path.resolve(__dirname, '../db/schema.ts'), 'utf8');
const dbIndexTs = fs.readFileSync(path.resolve(__dirname, '../db/index.ts'), 'utf8');
const authTs = fs.readFileSync(path.resolve(__dirname, '../services/auth.ts'), 'utf8');
const schemaSql = fs.readFileSync(path.resolve(__dirname, '../../sql/schema.sql'), 'utf8');

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Slices a route body out of server.ts by its registration anchor. */
function routeBody(anchor: string): string {
  const start = serverTs.indexOf(anchor);
  if (start === -1) throw new Error('route not found: ' + anchor);
  let depth = 0;
  let opened = false;
  for (let i = start; i < serverTs.length; i++) {
    const c = serverTs[i];
    if (c === '{') { depth++; opened = true; }
    else if (c === '}') depth--;
    if (opened && depth === 0) return serverTs.slice(start, i + 1);
  }
  throw new Error('unbalanced route body: ' + anchor);
}

const verifyOtpBody = routeBody("app.post('/api/auth/verify-otp'");
const verifyOtpCode = stripComments(verifyOtpBody);
const activateBody = routeBody("app.post('/api/agents/activate'");
const activateCode = stripComments(activateBody);

const RUN = testRunId;
const COUNTY = resolveCountyName('Nairobi')!;
const UNIT_ID = administrativeUnitsForCounty(COUNTY)[0]?.id;

let app: any;
let server: any;
let base = '';
let phoneSeq = 0;
let xffSeq = 0;

/**
 * A fresh X-Forwarded-For per request.
 *
 * This is FIXTURE hygiene, not a workaround for a real limit: the app sets
 * `trust proxy` to 1 (see server.ts), so the OTP/IP limiters correctly key on
 * the forwarded address — and a test that fires ~60 requests from a single
 * synthetic address would otherwise trip otpIpLimiter (5 per 5 minutes) and
 * start reading 429s for reasons that have nothing to do with what is under
 * test. The limiters are asserted on their own terms elsewhere; here they would
 * only be measuring the test.
 */
function nextForwardedFor(): string {
  xffSeq += 1;
  return `10.99.${Math.floor(xffSeq / 250)}.${(xffSeq % 250) + 1}`;
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
  return { status: res.status, body: json, text: text.slice(0, 400) };
}

const agentToken = (id: string) => generateToken({ id: `n4-${id}`, role: 'agent', agentId: id } as any);

let smsCounter = 0;
/** A unique, valid E.164 Kenyan number per call. */
function nextPhone(): string {
  smsCounter += 1;
  return '+2547' + String(20000000 + ((smsCounter * 7919 + smsCounter * smsCounter) % 19999999)).slice(-8);
}

/** Creates an agent directly, bypassing registration, to set up edge-case states. */
async function makeAgent(id: string, opts: { status?: string; email?: string | null } = {}) {
  phoneSeq += 1;
  await db.createAgent({
    id,
    business_name: `N4 ${id}`,
    contact_phone: nextPhone(),
    location_address: 'Nairobi',
    county: COUNTY,
    administrative_unit_id: UNIT_ID,
    mpesa_till_or_paybill: String(1000000 + phoneSeq),
    payout_method_type: 'Till Number',
    status: opts.status ?? 'active',
    refundable_deposit: 0,
    national_id_hash: hashCode(`nid-${id}`),
    terms_accepted_at: new Date().toISOString(),
    contact_email: opts.email === undefined ? null : opts.email,
  } as any);
  return id;
}

/** Runs the REAL registration flow: request-otp -> verify-otp. */
async function registerAgent(overrides: Record<string, any> = {}, phone = nextPhone()) {
  await http('/api/auth/request-otp', { body: { phone, role: 'agent' } });
  const code = [...sms.sent].reverse().find((m) => m.phone === phone)?.code;
  if (!code) throw new Error('no OTP captured for ' + phone);
  return {
    phone,
    result: await http('/api/auth/verify-otp', {
      body: {
        phone, code, role: 'agent',
        businessName: 'N4 Test Shop',
        locationAddress: 'Kenyatta Avenue, Nairobi',
        county: 'Nairobi', administrativeUnitId: UNIT_ID,
        tillNumber: '123456', nationalId: '12345678',
        termsAccepted: true,
        ...overrides,
      },
    }),
  };
}

/** Pulls the activation token out of the captured activation EMAIL. */
function tokenFromEmail(body: string): string {
  const m = body.match(/token=([A-Za-z0-9]+)/);
  if (!m) throw new Error('no activation token in the captured email');
  return decodeURIComponent(m[1]);
}

function lastAgentEmail(): { to: string; subject: string; body: string } {
  const found = [...emails.sent].reverse().find((e) => e.subject.includes('agent'));
  if (!found) throw new Error('no agent activation email was captured');
  return found;
}

/** Mints a token row directly, for states awkward to reach over HTTP. */
async function mintToken(agentId: string, overrides: Partial<{
  accountType: string; purpose: string; expiresAt: Date;
}> = {}) {
  const raw = crypto.randomBytes(32).toString('hex');
  await db.createAccountActivationToken(
    `ACT-N4-${raw.slice(0, 16)}`,
    overrides.accountType ?? 'agent',
    agentId,
    overrides.purpose ?? 'email_activation',
    hashCode(raw),
    overrides.expiresAt ?? new Date(Date.now() + AGENT_ACTIVATION_TTL_MS)
  );
  return raw;
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
  sms.sent.length = 0;
  emails.accept = true;
});

// -----------------------------------------------------------------------------
// 1-4. REGISTRATION REQUIRES, NORMALIZES AND UNIQUELY BINDS AN EMAIL
// -----------------------------------------------------------------------------
describe('N4-1..4 — registration requires a normalized, unique email', () => {
  it('rejects a MISSING email and sends no activation email', async () => {
    const { result } = await registerAgent({ contactEmail: undefined });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/barua pepe/i);
    expect(emails.sent.filter((e) => e.subject.includes('agent'))).toHaveLength(0);
  });

  it('rejects a BLANK and a whitespace-only email', async () => {
    expect((await registerAgent({ contactEmail: '' })).result.status).toBe(400);
    expect((await registerAgent({ contactEmail: '   ' })).result.status).toBe(400);
  });

  it('rejects a malformed email', async () => {
    for (const bad of ['not-an-email', 'a@b', 'a b@c.com', '@nope.com', 'a@nope.']) {
      const { result } = await registerAgent({ contactEmail: bad });
      expect(result.status, bad).toBe(400);
    }
  });

  it('validates the email BEFORE creating the agent row', () => {
    // Ordering is load-bearing: a rejected registration must not leave an
    // orphan agent or an orphaned image upload behind. Asserted against
    // comment-stripped source so the prose explaining the rule cannot satisfy
    // (or defeat) the check.
    const guard = verifyOtpCode.indexOf('rawAgentEmail');
    const create = verifyOtpCode.indexOf('db.createAgent(');
    expect(guard).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(guard);
    // ...and the image uploads happen after the guard too, for the same reason.
    expect(verifyOtpCode.indexOf('uploadBase64Image')).toBeGreaterThan(guard);
  });

  it('normalizes by trim + lowercase and STORES the normalized value', async () => {
    const { result } = await registerAgent({ contactEmail: '  N4.MixedCase@Example.COM  ' });
    expect(result.status).toBe(200);
    const agent = await db.getAgent(result.body.profile.agentId);
    expect(agent!.contact_email).toBe('n4.mixedcase@example.com');
  });

  it('rejects a DUPLICATE normalized email with 409 (case- and space-insensitive)', async () => {
    const first = await registerAgent({ contactEmail: `dup-${RUN}@example.com` });
    expect(first.result.status).toBe(200);
    // Same address, different case AND surrounding whitespace: normalization must
    // happen BEFORE the uniqueness check, or this would create a second account.
    const second = await registerAgent({ contactEmail: `  DUP-${RUN}@Example.com  ` });
    expect(second.result.status).toBe(409);
    expect(second.result.body.error).toMatch(/already in use/i);
  });

  it('rejects a duplicate BEFORE any second agent row or email is created', async () => {
    const email = `dupcheck-${RUN}@example.com`;
    await registerAgent({ contactEmail: email });
    const before = (await db.getAgents()).filter((a) => a.contact_email === email).length;
    const emailsBefore = emails.sent.length;
    const second = await registerAgent({ contactEmail: email });
    expect(second.result.status).toBe(409);
    expect((await db.getAgents()).filter((a) => a.contact_email === email).length).toBe(before);
    expect(emails.sent.length).toBe(emailsBefore);
  });

  it('creates the agent PENDING with an UNVERIFIED email', async () => {
    const { result } = await registerAgent({ contactEmail: `pending-${RUN}@example.com` });
    const agent = await db.getAgent(result.body.profile.agentId);
    expect(agent!.status).toBe('pending');
    expect(agent!.email_verified_at).toBeNull();
  });

  it('the partial unique index is the real database-level guarantee', () => {
    // The route check is a convenience; THIS is what actually prevents two
    // agents sharing an address when registrations race.
    const ddl = 'CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_email ON agents(contact_email) WHERE contact_email IS NOT NULL';
    expect(dbIndexTs).toContain(ddl);
    expect(schemaSql).toContain(ddl.replace('IF NOT EXISTS ', '') + ';');
  });

  it('the index is PARTIAL: any number of NULL-email agents coexist', async () => {
    const a = await makeAgent(`N4-NULL-A-${RUN}`, { email: null });
    const b = await makeAgent(`N4-NULL-B-${RUN}`, { email: null });
    expect((await db.getAgent(a))!.contact_email).toBeNull();
    expect((await db.getAgent(b))!.contact_email).toBeNull();
  });

  it('handles the uniqueness RACE as the same conflict, never an internal error', () => {
    // 23505 is what a concurrent insert raises; it must map to the same 409 the
    // pre-check produces, so a racing applicant sees one consistent outcome.
    expect(verifyOtpBody).toContain("if (e && (e as any).code === '23505')");
    expect(verifyOtpBody).toContain('already in use');
  });
});

// -----------------------------------------------------------------------------
// 5-8. TOKEN GENERATION, HASH-ONLY PERSISTENCE, ACCOUNT AND PURPOSE ISOLATION
// -----------------------------------------------------------------------------
describe('N4-5..8 — activation token generation, hashing and isolation', () => {
  it('generates 32 CSPRNG bytes and lives 24 hours', () => {
    expect(verifyOtpBody).toContain("crypto.randomBytes(32).toString('hex')");
    expect(verifyOtpBody).toContain('AGENT_ACTIVATION_TTL_MS');
    expect(AGENT_ACTIVATION_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('persists ONLY the hash — the plaintext is never stored', async () => {
    const { result } = await registerAgent({ contactEmail: `hashonly-${RUN}@example.com` });
    const agentId = result.body.profile.agentId;
    const raw = tokenFromEmail(lastAgentEmail().body);

    const row = await db.getAccountActivationTokenByHash(hashCode(raw));
    expect(row).toBeTruthy();
    expect(row.account_type).toBe('agent');
    expect(row.account_id).toBe(agentId);
    expect(row.token_hash).toBe(hashCode(raw));
    expect(row.token_hash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(raw);
  });

  it('the raw token appears nowhere in the HTTP response', async () => {
    const { result } = await registerAgent({ contactEmail: `noresp-${RUN}@example.com` });
    const raw = tokenFromEmail(lastAgentEmail().body);
    expect(JSON.stringify(result.body)).not.toContain(raw);
  });

  it('ACCOUNT-TYPE isolation: a customer-scoped token cannot redeem an agent email', async () => {
    const agentId = await makeAgent(`N4-ISO-${RUN}`, { email: `iso-${RUN}@example.com` });
    const customerScoped = await mintToken(agentId, { accountType: 'customer' });
    const res = await http('/api/agents/activate', { body: { token: customerScoped } });
    expect(res.status).toBe(400);
    expect((await db.getAgent(agentId))!.email_verified_at).toBeNull();
  });

  it('an AGENT token cannot be redeemed against the customer endpoint', async () => {
    // The mirror image, and the reason account_type exists at all.
    const agentId = await makeAgent(`N4-ISO2-${RUN}`, { email: `iso2-${RUN}@example.com` });
    const raw = await mintToken(agentId);
    const res = await http('/api/customer/activate', { body: { token: raw } });
    expect(res.status).toBe(400);
    expect((await db.getAgent(agentId))!.email_verified_at).toBeNull();
  });

  it('PURPOSE isolation is enforced in the route, and by a table CHECK', () => {
    expect(activateBody).toContain("token.purpose !== 'email_activation'");
    // The CHECK means a token can never even be filed under another purpose, so
    // the route check defends against a constraint-less database too.
    expect(dbIndexTs).toContain("CHECK (purpose = 'email_activation')");
  });

  it('the activation link is built by the shared URL builder', () => {
    const url = buildAgentActivationUrl('a'.repeat(64));
    expect(url).toContain('/activate-agent-email?token=');
    expect(url).toContain(encodeURIComponent('a'.repeat(64)));
    expect(verifyOtpBody).toContain('buildAgentActivationUrl(rawAgentActivationToken)');
  });
});

// -----------------------------------------------------------------------------
// 9-14. TOKEN VALIDITY: EXPIRY, SINGLE USE, ATOMICITY, WRONG-AGENT, SUCCESS
// -----------------------------------------------------------------------------
describe('N4-9..14 — token validity, single use and atomic consumption', () => {
  it('rejects an EXPIRED token and leaves the agent unverified', async () => {
    const agentId = await makeAgent(`N4-EXP-${RUN}`, { email: `exp-${RUN}@example.com` });
    const raw = await mintToken(agentId, { expiresAt: new Date(Date.now() - 1000) });
    const res = await http('/api/agents/activate', { body: { token: raw } });
    expect(res.status).toBe(400);
    expect((await db.getAgent(agentId))!.email_verified_at).toBeNull();
  });

  it('rejects an ALREADY-CONSUMED token on a second redemption', async () => {
    const agentId = await makeAgent(`N4-CONS-${RUN}`, { email: `cons-${RUN}@example.com` });
    const raw = await mintToken(agentId);
    expect((await http('/api/agents/activate', { body: { token: raw } })).status).toBe(200);
    expect((await http('/api/agents/activate', { body: { token: raw } })).status).toBe(400);
  });

  it('is SINGLE-USE: the atomic CAS refuses a second consumption', async () => {
    const agentId = await makeAgent(`N4-SINGLE-${RUN}`, { email: `single-${RUN}@example.com` });
    const raw = await mintToken(agentId);
    const row = await db.getAccountActivationTokenByHash(hashCode(raw));
    expect(await db.consumeAccountActivationToken(row.id)).toBe(true);
    // The guard lives in the UPDATE's WHERE clause, so a second call matches
    // nothing. This is the property the route depends on.
    expect(await db.consumeAccountActivationToken(row.id)).toBe(false);
  });

  it('COMPETING ACTIVATION: concurrent redemptions produce exactly one success', async () => {
    const agentId = await makeAgent(`N4-RACE-${RUN}`, { email: `race-${RUN}@example.com` });
    const raw = await mintToken(agentId);
    const results = await Promise.all([
      http('/api/agents/activate', { body: { token: raw } }),
      http('/api/agents/activate', { body: { token: raw } }),
      http('/api/agents/activate', { body: { token: raw } }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
    expect((await db.getAgent(agentId))!.email_verified_at).toBeTruthy();
  });

  it('rejects an unknown token identically to a malformed one (no oracle)', async () => {
    const unknown = await http('/api/agents/activate', { body: { token: 'f'.repeat(64) } });
    const short = await http('/api/agents/activate', { body: { token: 'abc' } });
    const empty = await http('/api/agents/activate', { body: { token: '' } });
    expect(unknown.status).toBe(400);
    // Every unusable-token reason collapses to ONE message. Anything more
    // specific would let a caller probe which tokens exist.
    expect(short.body.error).toBe(unknown.body.error);
    expect(empty.body.error).toBe(unknown.body.error);
  });

  it('WRONG-AGENT protection: the token acts only on its own account_id', async () => {
    const victim = await makeAgent(`N4-VICTIM-${RUN}`, { email: `victim-${RUN}@example.com` });
    const attacker = await makeAgent(`N4-ATTACKER-${RUN}`, { email: `attacker-${RUN}@example.com` });
    const raw = await mintToken(victim);
    // The request carries NO agent id at all — there is nothing to confuse. The
    // extra field below is an attacker attempt and must be ignored entirely.
    const res = await http('/api/agents/activate', { body: { token: raw, agentId: attacker } });
    expect(res.status).toBe(200);
    expect(res.body.agent.id).toBe(victim);
    expect((await db.getAgent(victim))!.email_verified_at).toBeTruthy();
    expect((await db.getAgent(attacker))!.email_verified_at).toBeNull();
  });

  it('refuses a token whose agent no longer exists, WITHOUT consuming it', async () => {
    const raw = await mintToken(`N4-GHOST-${RUN}`);
    const res = await http('/api/agents/activate', { body: { token: raw } });
    expect(res.status).toBe(400);
    // The agent lookup precedes consumption, so the token is not burned.
    const row = await db.getAccountActivationTokenByHash(hashCode(raw));
    expect(row.consumed_at).toBeNull();
  });

  it('a SUCCESSFUL activation sets email_verified_at', async () => {
    const agentId = await makeAgent(`N4-SUCC-${RUN}`, { email: `succ-${RUN}@example.com` });
    const raw = await mintToken(agentId);
    expect((await http('/api/agents/activate', { body: { token: raw } })).status).toBe(200);
    const agent = await db.getAgent(agentId);
    expect(agent!.email_verified_at).toBeTruthy();
    expect(new Date(agent!.email_verified_at!).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('a SUCCESSFUL activation PRESERVES status for every status value', async () => {
    for (const status of ['pending', 'active', 'suspended'] as const) {
      const agentId = await makeAgent(`N4-PRESERVE-${status}-${RUN}`, { status, email: `p-${status}-${RUN}@example.com` });
      const raw = await mintToken(agentId);
      expect((await http('/api/agents/activate', { body: { token: raw } })).status, status).toBe(200);
      const agent = await db.getAgent(agentId);
      // THE load-bearing assertion: the approval axis is untouched.
      expect(agent!.status, status).toBe(status);
      expect(agent!.email_verified_at, status).toBeTruthy();
    }
  });

  it('verifyAgentEmail() writes ONLY the email column — never `status`', () => {
    const body = stripComments(dbTs.slice(dbTs.indexOf('public async verifyAgentEmail'))).slice(0, 800);
    expect(body).toContain('email_verified_at');
    expect(body).not.toContain('status');
    // And it is a compare-and-swap guarded on the column still being NULL.
    expect(body).toContain('isNull(agentsTable.email_verified_at)');
  });

  it('verifyAgentEmail() is idempotent-safe: a second call writes nothing', async () => {
    const agentId = await makeAgent(`N4-IDEM-${RUN}`, { email: `idem-${RUN}@example.com` });
    expect(await db.verifyAgentEmail(agentId)).toBe(true);
    const first = (await db.getAgent(agentId))!.email_verified_at;
    expect(await db.verifyAgentEmail(agentId)).toBe(false);
    expect((await db.getAgent(agentId))!.email_verified_at).toBe(first);
  });
});

// -----------------------------------------------------------------------------
// 15-17. RESPONSE / SESSION BEHAVIOUR AND EMAIL FAILURE SAFETY
// -----------------------------------------------------------------------------
describe('N4-15..17 — response shape, session behaviour, email failure safety', () => {
  it('issues NO session on activation (unlike the customer endpoint)', () => {
    // An agent proves they own a mailbox. That is not approval, so no cookie
    // and no session row is created — requireActiveAgent remains the only
    // thing that grants operational authority.
    expect(activateCode).not.toContain('createCustomerSession');
    expect(activateCode).not.toContain('setCustomerSessionCookie');
    expect(activateCode).not.toContain('generateToken');
    expect(activateCode).not.toContain('res.cookie');
  });

  it('reports the server-side operational verdict, not a client-side guess', async () => {
    const active = await makeAgent(`N4-OP-ACTIVE-${RUN}`, { status: 'active', email: `op-a-${RUN}@example.com` });
    const pending = await makeAgent(`N4-OP-PENDING-${RUN}`, { status: 'pending', email: `op-p-${RUN}@example.com` });
    const suspended = await makeAgent(`N4-OP-SUSP-${RUN}`, { status: 'suspended', email: `op-s-${RUN}@example.com` });

    for (const [id, expected] of [[active, true], [pending, false], [suspended, false]] as const) {
      const raw = await mintToken(id);
      const res = await http('/api/agents/activate', { body: { token: raw } });
      expect(res.status).toBe(200);
      // `operational` is isAgentActionable() evaluated by the SERVER, so the UI
      // can never claim more access than the next protected request would grant.
      expect(res.body.operational).toBe(expected);
      expect(res.body.agent.emailVerified).toBe(true);
    }
  });

  it('never returns the token, the activation URL, or any credential', () => {
    const response = activateBody.slice(activateBody.lastIndexOf('return res.json'));
    expect(response).not.toContain('rawToken');
    expect(response).not.toContain('activationUrl');
    expect(activateCode).not.toMatch(/console\.(log|warn|error)[^;]*rawToken/);
    expect(activateBody).not.toMatch(/logAudit[^;]*rawToken/);
  });

  it('EMAIL FAILURE leaves the agent unverified and returns 503', async () => {
    emails.accept = false;
    const { result } = await registerAgent({ contactEmail: `fail-${RUN}@example.com` });
    expect(result.status).toBe(503);
    // The row exists but is NOT verified, and NOT approved.
    const agent = (await db.getAgents()).find((a) => a.contact_email === `fail-${RUN}@example.com`);
    expect(agent).toBeTruthy();
    expect(agent!.email_verified_at).toBeNull();
    expect(agent!.status).toBe('pending');
  });

  it('EMAIL FAILURE issues no session and no token-bearing response', async () => {
    emails.accept = false;
    const { result } = await registerAgent({ contactEmail: `failtok-${RUN}@example.com` });
    expect(result.status).toBe(503);
    expect(result.body.token).toBeUndefined();
    expect(result.body.profile).toBeUndefined();
  });

  it('EMAIL FAILURE leaves the issued token RETRYABLE — unconsumed and still redeemable', async () => {
    emails.accept = false;
    const { result } = await registerAgent({ contactEmail: `retry-${RUN}@example.com` });
    expect(result.status).toBe(503);

    const agent = (await db.getAgents()).find((a) => a.contact_email === `retry-${RUN}@example.com`)!;
    // The email body was still composed, so the real token can be recovered here
    // exactly as a later successful delivery would carry it. It must survive the
    // failure unconsumed — N4 burns nothing on a delivery error, and there is no
    // resend endpoint, so destroying it would be the only way to lock the agent
    // out permanently.
    const raw = tokenFromEmail(lastAgentEmail().body);
    const row = await db.getAccountActivationTokenByHash(hashCode(raw));
    expect(row).toBeTruthy();
    expect(row.consumed_at).toBeNull();

    // A later delivery retry therefore still succeeds.
    emails.accept = true;
    const res = await http('/api/agents/activate', { body: { token: raw } });
    expect(res.status).toBe(200);
    expect((await db.getAgent(agent.id))!.email_verified_at).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// 18-25. THE AUTHORIZATION MATRIX — verified over REAL HTTP, real JWT, real
// requireActiveAgent. This is the block that proves N4 is a real security
// condition and not a cosmetic one.
// -----------------------------------------------------------------------------
describe('N4-18..25 — isAgentActionable truth table', () => {
  const NOW = () => new Date().toISOString();

  it('pending => NOT actionable, with or without verification', () => {
    expect(isAgentActionable({ status: 'pending' })).toBe(false);
    expect(isAgentActionable({ status: 'pending', email_verified_at: NOW() })).toBe(false);
    expect(isAgentActionable({ status: 'pending', email_verified_at: NOW(), contact_email: 'a@b.com' })).toBe(false);
  });

  it('suspended => NOT actionable, with or without verification', () => {
    expect(isAgentActionable({ status: 'suspended' })).toBe(false);
    expect(isAgentActionable({ status: 'suspended', email_verified_at: NOW() })).toBe(false);
    expect(isAgentActionable({ status: 'suspended', email_verified_at: NOW(), contact_email: 'a@b.com' })).toBe(false);
  });

  it('unknown / garbage / missing status => NOT actionable (fails closed)', () => {
    for (const status of ['', 'ACTIVE', 'Active', 'approved', 'deleted', 'null', 'undefined']) {
      expect(isAgentActionable({ status, email_verified_at: NOW() }), status).toBe(false);
    }
    expect(isAgentActionable(undefined)).toBe(false);
    expect(isAgentActionable(null)).toBe(false);
  });

  it('active + UNVERIFIED email (a new N4 agent) => NOT actionable', () => {
    // The new gate. Without this, a fresh registration would be fully
    // operational on the strength of an unproven email.
    expect(isAgentActionable({ status: 'active', email_verified_at: null, contact_email: 'new@example.com' })).toBe(false);
  });

  it('active + VERIFIED email => actionable', () => {
    expect(isAgentActionable({ status: 'active', email_verified_at: NOW(), contact_email: 'a@b.com' })).toBe(true);
  });

  it('GRANDFATHER: a legacy active agent with a NULL email stays actionable', () => {
    // The rule that stops N4 from locking the existing agent network out on
    // deploy. Pre-N4 agents have no email at all, so there is nothing they
    // could have verified.
    expect(isAgentActionable({ status: 'active', email_verified_at: null, contact_email: null })).toBe(true);
  });

  it('the grandfather clause cannot be reached by an agent that HAS an email', () => {
    // The safety argument in one assertion: the bypass and the blocked case are
    // opposites, so possessing an email is never a way around the requirement.
    expect(isAgentActionable({ status: 'active', email_verified_at: null, contact_email: 'attacker@x.com' })).toBe(false);
    expect(isAgentActionable({ status: 'active', email_verified_at: null, contact_email: null })).toBe(true);
  });

  it('the grandfather clause never overrides a non-active status', () => {
    // It is bounded by status, so it cannot make a pending or suspended agent
    // actionable even with a NULL email.
    for (const status of ['pending', 'suspended', 'weird']) {
      expect(isAgentActionable({ status, email_verified_at: null, contact_email: null }), status).toBe(false);
    }
  });

  it('createAgent() normalizes a blank email to NULL, closing the grandfather loophole', () => {
    // This is what makes the rule unsteerable: a post-N4 agent can never
    // manufacture a NULL email by registering with whitespace.
    expect(dbTs).toContain("String(agent.contact_email).trim().toLowerCase() || null");
    // And the registration route rejects a blank email outright, so NULL is
    // unreachable through the new-agent path at all.
    expect(verifyOtpBody).toContain('rawAgentEmail.length === 0');
  });

  it('requireActiveAgent is still the single authorization boundary', () => {
    // All six protected agent operation routes keep the same two middlewares in
    // the same order. N4 strengthened the predicate; it did not add, remove or
    // reorder a guard.
    const agentOpsTs = fs.readFileSync(path.resolve(__dirname, '../routes/agentOps.ts'), 'utf8');
    const routes = [...agentOpsTs.matchAll(/app\.(?:get|post)\('(\/api\/agents\/[^']+)'([^)]*)\)/g)];
    expect(routes.length).toBeGreaterThanOrEqual(6);
    for (const [, path, args] of routes) {
      if (path === '/api/agents/activate') continue; // public by design
      expect(args, path).toContain('authenticateJWT');
      expect(args, path).toContain('requireActiveAgent');
      // Order matters: identity is proven before authority is evaluated.
      expect(args.indexOf('authenticateJWT'), path).toBeLessThan(args.indexOf('requireActiveAgent'));
    }
  });

  it('the activation route is PUBLIC and carries no auth middleware', () => {
    // An applicant following an emailed link has no session by definition, so
    // the token IS the credential here. It is deliberately not authenticateJWT
    // — and it grants no authority either, which is why it can be public.
    expect(activateBody.slice(0, activateBody.indexOf('async'))).not.toContain('authenticateJWT');
    expect(activateBody.slice(0, activateBody.indexOf('async'))).not.toContain('requireActiveAgent');
  });
});

// -----------------------------------------------------------------------------
// THE SAME MATRIX, EXECUTED OVER REAL HTTP.
//
// The pure predicate above states the rule; this proves the rule is actually
// ENFORCED by the real middleware chain on a real protected route. A predicate
// that nothing consults would pass every test above and protect nothing.
// -----------------------------------------------------------------------------
describe('N4 — protected agent operations over real HTTP', () => {
  it('an ACTIVE + VERIFIED agent reaches a protected agent route', async () => {
    const id = await makeAgent(`N4-HTTP-OK-${RUN}`, { status: 'active', email: `http-ok-${RUN}@example.com` });
    await db.verifyAgentEmail(id);
    const agent = await db.getAgent(id);
    expect(agent!.email_verified_at).toBeTruthy();
    expect(isAgentActionable(agent)).toBe(true);
    expect((await http('/api/agents/queue', { token: agentToken(id) })).status).toBe(200);
  });

  it('an ACTIVE but UNVERIFIED agent is refused with 403', async () => {
    // The new gate. Fully business-approved, but the registration email has not
    // been confirmed — the guard must still deny.
    const id = await makeAgent(`N4-HTTP-UNVERIFIED-${RUN}`, { status: 'active', email: `http-unv-${RUN}@example.com` });
    expect((await db.getAgent(id))!.email_verified_at).toBeNull();
    expect((await http('/api/agents/queue', { token: agentToken(id) })).status).toBe(403);
  });

  it('a PENDING + VERIFIED agent is refused with 403', async () => {
    // Verifying the email does NOT buy approval. This is the direction of the
    // independence that matters most.
    const id = await makeAgent(`N4-HTTP-PENDING-${RUN}`, { status: 'pending', email: `http-pend-${RUN}@example.com` });
    const raw = await mintToken(id);
    expect((await http('/api/agents/activate', { body: { token: raw } })).status).toBe(200);
    const agent = await db.getAgent(id);
    expect(agent!.email_verified_at).toBeTruthy();
    expect(agent!.status).toBe('pending');
    expect((await http('/api/agents/queue', { token: agentToken(id) })).status).toBe(403);
  });

  it('a SUSPENDED + VERIFIED agent is refused with 403', async () => {
    const id = await makeAgent(`N4-HTTP-SUSP-${RUN}`, { status: 'suspended', email: `http-susp-${RUN}@example.com` });
    const raw = await mintToken(id);
    expect((await http('/api/agents/activate', { body: { token: raw } })).status).toBe(200);
    expect((await http('/api/agents/queue', { token: agentToken(id) })).status).toBe(403);
  });

  it('a LEGACY active NULL-email agent remains fully operational', async () => {
    // THE REGRESSION THIS RULE EXISTS TO PREVENT. Without it, deploying N4 would
    // lock out every existing approved agent in the country.
    const id = await makeAgent(`N4-HTTP-LEGACY-${RUN}`, { status: 'active', email: null });
    const agent = await db.getAgent(id);
    expect(agent!.email_verified_at).toBeNull();
    expect(isAgentActionable(agent)).toBe(true);
    expect((await http('/api/agents/queue', { token: agentToken(id) })).status).toBe(200);
  });

  it('an unauthenticated request is refused before the agent guard is reached', async () => {
    expect((await http('/api/agents/queue')).status).toBe(401);
  });

  it('a fresh REGISTRATION cannot reach any protected route before activation', async () => {
    // End-to-end: register, keep the returned token, and prove it buys nothing.
    const { result } = await registerAgent({ contactEmail: `fresh-${RUN}@example.com` });
    expect(result.status).toBe(200);
    expect(result.body.profile.activationRequired).toBe(true);
    expect(result.body.profile.emailVerified).toBe(false);
    // The token is a proof of phone ownership, not of authority.
    expect((await http('/api/agents/queue', { token: result.body.token })).status).toBe(403);
  });

  it('that same registration gains access ONLY after activation AND approval', async () => {
    const { result } = await registerAgent({ contactEmail: `full-${RUN}@example.com` });
    const agentId = result.body.profile.agentId;
    const token = result.body.token;
    // 1. pending + unverified -> blocked
    expect((await http('/api/agents/queue', { token })).status).toBe(403);

    // 2. verified, still pending -> STILL blocked. Email is not approval.
    const raw = tokenFromEmail(lastAgentEmail().body);
    expect((await http('/api/agents/activate', { body: { token: raw } })).status).toBe(200);
    expect((await http('/api/agents/queue', { token })).status).toBe(403);

    // 3. approved, and the guard re-reads the row on every request -> now open.
    // The REAL approval transition, not a raw column write, so the test exercises
    // the same path an administrator does.
    await db.approveAgent(agentId, `n4-admin-${RUN}`);
    expect((await db.getAgent(agentId))!.status).toBe('active');
    expect((await http('/api/agents/queue', { token })).status).toBe(200);
  });
});

// -----------------------------------------------------------------------------
// 24. NO NEW SMS, 25. NO RESEND, AND THE SCHEMA / ROUTE SHAPE
// -----------------------------------------------------------------------------
describe('N4-24..25 — no new SMS, no resend, schema and route shape', () => {
  it('introduces NO new SMS: the only SMS is the pre-existing phone OTP', () => {
    // The pre-existing request-otp -> verify-otp phone challenge is untouched and
    // is explicitly NOT part of N4. N4 adds no SMS send of any kind.
    expect(verifyOtpCode).not.toContain('sendCodeViaSms');
    expect(verifyOtpCode).not.toContain('AuthService.sendSms');
    expect(activateCode).not.toContain('Sms');
    // Registration still happens on the ONE shared OTP route — no parallel route.
    expect(serverTs.match(/app\.post\('\/api\/auth\/verify-otp'/g)).toHaveLength(1);
  });

  it('adds NO resend endpoint or route', () => {
    const resendRoutes = [...serverTs.matchAll(/app\.(?:get|post)\('([^']*resend[^']*)'/gi)].map((m) => m[1]);
    expect(resendRoutes).toEqual([]);
    expect(activateBody.toLowerCase()).not.toContain('resend');
  });

  it('uses the shared N2 activation-token table — no second token table', () => {
    expect(verifyOtpBody).toContain('db.createAccountActivationToken');
    expect(dbIndexTs).toContain('CREATE TABLE IF NOT EXISTS account_activation_tokens');
    // The table's own CHECK already permits account_type = 'agent'; N4 adds no
    // table, no column and no index for the agent flow.
    expect(dbIndexTs).toContain("CHECK (account_type IN ('customer', 'agent'))");
  });

  it('adds exactly ONE column and ONE index to the agents table', () => {
    expect(schemaTs).toContain('email_verified_at: timestamp("email_verified_at", { withTimezone: true })');
    expect(dbIndexTs).toContain('ALTER TABLE agents ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ');
    // The ALTER must follow the agents CREATE TABLE, which migrationOrder
    // enforces repository-wide.
    expect(dbIndexTs.indexOf('CREATE TABLE IF NOT EXISTS agents')).toBeLessThan(
      dbIndexTs.indexOf('ALTER TABLE agents ADD COLUMN IF NOT EXISTS email_verified_at')
    );
  });

  it('does NOT make contact_email globally NOT NULL, and backfills nothing', () => {
    // A global NOT NULL would be destructive on a live table with existing NULL
    // rows AND would break the grandfather discriminator. N4 rewrites no row.
    expect(dbIndexTs).not.toMatch(/ALTER TABLE agents ALTER COLUMN contact_email SET NOT NULL/i);
    expect(dbIndexTs).not.toMatch(/UPDATE agents SET email_verified_at/i);
    expect(dbIndexTs).not.toMatch(/UPDATE agents SET contact_email/i);
  });

  it('the activation route is rate limited and follows the agent route convention', () => {
    const signature = activateBody.slice(0, activateBody.indexOf('async'));
    expect(signature).toContain('customerAuthLimiter');
    expect(signature).toContain('otpVerifyLimiter');
    // Plural '/api/agents/...', matching every existing agent route.
    expect(activateBody).toContain("app.post('/api/agents/activate'");
  });

  it('the activation email states that approval is a separate step', () => {
    // The email must not imply that verifying the address completes onboarding.
    const html = buildAgentActivationEmailHtml('Test Shop', 'https://example.test/x');
    expect(html.toLowerCase()).toContain('not the same as approval');
    expect(html).toContain('https://example.test/x');
  });
});



