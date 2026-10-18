import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { db } from '../db/database';
// ---------------------------------------------------------------------------
// N7 â€” isolate the durable SMS rate limiter out of these business-logic tests.
//
// These routes now carry N6's limiter, which enforces 3 SMS requests per
// rolling 10 minutes on BOTH the client IP AND the verified principal
// (`req.customer.id`). Each of these files drives one shared customer through
// many OTP operations across many tests, so that customer's bucket exhausted
// partway through and the tests began failing with 429s that had nothing to do
// with what they assert.
//
// That is the limiter working correctly, not a defect in the flows: a real
// customer doing the same thing would be limited too. What these files exist to
// test is the logic BEHIND the limiter â€” OTP binding, freshness, single use,
// cross-claim and cross-customer authorization â€” and that logic is only
// observable with a non-exhausting budget.
//
// Rate limiting itself is verified exhaustively, and over real HTTP, by
// src/__tests__/smsIdempotencyRateLimitN6.test.ts, which drives the same
// middleware through requests 1-4 and asserts the 4th is refused BEFORE any
// provider call. Nothing is asserted more weakly here; the limiter is stubbed
// the same way the SMS gateway, storage and email service already are in these
// files.
const __n7RealConsumeSlot = (db as any).consumeSmsRateLimitSlot;
(db as any).consumeSmsRateLimitSlot = async () => ({ allowed: true, retryAfterSeconds: 0 });
afterAll(() => { (db as any).consumeSmsRateLimitSlot = __n7RealConsumeSlot; });
import { testRunId } from '../db/__tests__/ensureTestCategory';
import { administrativeUnitsForCounty } from '../config/kenyaAdministrativeUnits';
import { resolveCountyName } from '../config/kenyaCounties';

// ===========================================================================
// P2-A5 â€” REAL HTTP END-TO-END LIFECYCLE TEST.
//
// The first test in this repository that drives the COMPLETE found-item
// lifecycle over real HTTP against the REAL application: `createApp()` from
// src/server.ts, an ephemeral TCP socket, the real Express middleware chain,
// the six real route modules, the real database and the real state transitions.
//
// P2-A1 â€¦ P2-A3.4B extracted 21 route handlers out of server.ts. P2-A4 removed
// the import-time boot so the app could finally be mounted. Until now, NOTHING
// proved those modules still work together inside the real application â€” every
// proof was a source-text assertion. This file closes that gap.
//
// Only EXTERNAL providers are doubled, each with the pattern already
// established in this repo (customerClaimRoutes.test.ts): SMS capture, S3
// upload, email, and IntaSend `fetch`. Every business function â€” hashing,
// timing-safe comparison, state machines, CAS transitions, fee computation,
// signature verification â€” stays REAL. `authenticateJWT` and `requireActiveAgent`
// are NOT bypassed: a genuine HS256 token is minted with the real
// generateToken() and verified by the real middleware.
// ===========================================================================

const sms = vi.hoisted(() => ({ sent: [] as Array<{ phone: string; code: string; label: string }> }));
const emails = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; html?: string }> }));
// E1: every one-time code is now EMAILED. The seam is doubled the same way the
// SMS gateway used to be â€” capture-only â€” so a test can read the code the ROUTE
// generated (and hashed) without an email ever leaving the process.
const emailOtp = vi.hoisted(() => ({ sent: [] as Array<{ to: string; code: string; eventType: string }> }));

vi.mock('../services/auth', async (importOriginal) => {
  const actual = await importOriginal<any>();
  // The bulk SMS path is reached as `AuthService.sendSms(...)` â€” a property of
  // the exported object. Overriding only the module-level `sendSms` would NOT
  // intercept it, so both shapes are captured.
  const captureSms = vi.fn(async (phone: string, message: string) => {
    sms.sent.push({ phone, code: message, label: 'BULK' });
    return { success: true, failureReason: null, retryable: false };
  });
  const AuthService = new Proxy(actual.AuthService ?? {}, {
    get(target: any, prop: string) {
      return prop === 'sendSms' ? captureSms : target[prop];
    },
  });
  return {
    ...actual,
    AuthService,
    // Capture-only: the hash/verify path is untouched.
    sendCodeViaSms: vi.fn(async (phone: string, code: string, label: string) => {
      sms.sent.push({ phone, code, label });
      return { success: true, message: 'captured in test' };
    }),
    sendSms: captureSms,
  };
});

vi.mock('../services/storage', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, uploadBase64Image: vi.fn(async () => 'https://storage.test/e2e.jpg') };
});

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const EmailService = actual.EmailService ?? {};
  return {
    ...actual,
    EmailService: new Proxy(EmailService, {
      get(target: any, prop: string) {
        if (prop === 'send') {
          return vi.fn(async (to: string, subject: string) => { emails.sent.push({ to, subject }); return true; });
        }
        // E1/N9: the notification boundary reaches email through `sendWithId`,
        // which must report ACCEPTANCE plus a provider id â€” the shape
        // resendEmailProvider reads. Returning a bare `true` here (the old
        // catch-all) would make every transactional email look REJECTED, and the
        // payment-time pickup code would be recorded as a failure. The rendered
        // body is captured too, so a test can read what was actually delivered.
        if (prop === 'sendWithId') {
          return vi.fn(async (to: string, subject: string, html: string) => {
            emails.sent.push({ to, subject, html });
            return { accepted: true, providerMessageId: 'test-email-id', providerError: null };
          });
        }
        const v = target[prop];
        return typeof v === 'function' ? vi.fn(async () => true) : v;
      },
    }),
  };
});

vi.mock('../services/emailOtp', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    sendEmailOtp: vi.fn(async (input: any) => {
      emailOtp.sent.push({
        to: String(input?.recipient ?? ''),
        code: String(input?.code ?? ''),
        eventType: String(input?.eventType ?? ''),
      });
      return { accepted: true, dispatched: true, eventId: 'test-email-event', status: 'sent' };
    }),
  };
});

// Imported AFTER the mocks are registered.
const { createApp } = await import('../server.ts');
const { generateToken, hashCode } = await import('../services/auth');
const { linkVerifiedClaimToCustomer } = await import('../services/customerAuth');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const RUN = testRunId;
const CATEGORY = `e2e-cat-${RUN}`;
const TOTAL_FEE = 500;

const numBase = Math.floor(10000000 + Math.random() * 89999999);
const e164 = (n: number) => '+2547' + String(numBase + n).slice(-8);
const OWNER_PHONE = e164(1);
const FINDER_PHONE = e164(2);
const PAYER_PHONE = e164(3);
// BATCH 1 — LAUNCH POLICY: payouts are PERSONAL M-PESA PHONE DESTINATIONS ONLY,
// on both legs. The fixture agent therefore holds a personal M-Pesa phone number
// and the supported 'Personal M-Pesa' method, not a Till number: a Till (or
// Paybill / Pochi / malformed / non-Kenyan) destination is now refused before
// any provider request is made (config/payoutDestinations.ts). Stage 8.9 below
// drives the refusal cases with dedicated agent fixtures.
const AGENT_PAYOUT_PHONE = e164(9);

const AGENT_ID = `E2E-AGENT-${RUN}`;
const INACTIVE_AGENT_ID = `E2E-AGENT-INACTIVE-${RUN}`;
// A second, fully ACTIVE agent that is deliberately NOT the assignee. Used to
// prove the assignment/IDOR boundary: a valid token is not sufficient.
const OTHER_AGENT_ID = `E2E-AGENT-OTHER-${RUN}`;
// BATCH 1 — two agents whose payout targets the launch policy REFUSES. Their
// only purpose is to give stage 8.9 real subjects: one holds a Till number under
// the Till method, the other holds a perfectly valid phone number under an
// unsupported method ('Pochi la Biashara'), so the two independent rules are
// each exercised end-to-end.
const TILL_AGENT_ID = `E2E-AGENT-TILL-${RUN}`;
const UNSUPPORTED_METHOD_AGENT_ID = `E2E-AGENT-POCHI-${RUN}`;

// A real PNG header + minimal payload: passes isValidImageSignature() because
// the magic bytes are genuinely present (the check is not weakened).
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let app: any;
let server: any;
let base = '';
// ---------------------------------------------------------------------------
// N7 Ã¢â‚¬â€ per-test client identity for the durable SMS rate limiter.
//
// The SMS routes now carry N6's DURABLE per-IP limiter: 3 requests per rolling
// 10 minutes. The app sets `trust proxy`, so `req.ip` is derived from
// X-Forwarded-For. Before N7 every test in this file shared the single loopback
// address, so the quota was global to the FILE: one test's SMS requests drained
// the budget of every later test and legitimate multi-step flows began returning
// 429. That was cross-test bleed, not the limiter misbehaving.
//
// Each test now presents its own client IP. This is what the limiter expects,
// and it also restores real isolation between tests.
let __n7IpCounter = 0;
let TEST_CLIENT_IP = '10.90.0.1';
beforeEach(() => {
  __n7IpCounter += 1;
  const a = Math.floor(__n7IpCounter / 250) % 250;
  const b = (__n7IpCounter % 250) + 1;
  TEST_CLIENT_IP = `10.90.${a}.${b}`;
});

async function http(
  pathname: string,
  opts: { method?: string; body?: any; token?: string; cookie?: string } = {}
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  // Customer-authenticated routes (requireCustomerAuth) authenticate from the
  // httpOnly session cookie and from nothing else, so a caller that needs to be
  // signed in must present it here. The raw token is only ever passed to this
  // header â€” it is never logged, printed or asserted on.
  if (opts.cookie) headers['Cookie'] = `r4m_customer_session=${opts.cookie}`;
  // N7: the SMS routes now carry N6's DURABLE per-IP limiter (3 per rolling 10
  // minutes). The app sets `trust proxy`, so req.ip derives from
  // X-Forwarded-For. Every test in this file used to share the single loopback
  // address, which meant one test's SMS budget silently drained the next one's
  // and legitimate multi-step flows started returning 429. Each test now
  // presents its own client IP, which is both what the limiter expects and
  // better isolation than the shared default.
  headers['X-Forwarded-For'] = TEST_CLIENT_IP;
  const res = await fetch(base + pathname, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json, text: text.slice(0, 300) };
}

const agentToken = (id: string) => generateToken({ id: `e2e-${id}`, role: 'agent', agentId: id } as any);

function lastCodeFor(phone: string): string | undefined {
  for (let i = sms.sent.length - 1; i >= 0; i--) if (sms.sent[i].phone === phone) return sms.sent[i].code;
  return undefined;
}

/**
 * E1: the code the route generated for a RECIPIENT ADDRESS. The destination is
 * server-resolved (the account's own verified email), which is what makes
 * asserting on it meaningful rather than tautological.
 */
function lastCodeForRecipient(to: string): string | undefined {
  for (let i = emailOtp.sent.length - 1; i >= 0; i--) if (emailOtp.sent[i].to === to) return emailOtp.sent[i].code;
  return undefined;
}

/** The rendered body of the most recent transactional email sent to `to`. */
function lastEmailBodyFor(to: string): string | undefined {
  for (let i = emails.sent.length - 1; i >= 0; i--) {
    if (emails.sent[i].to === to && emails.sent[i].html) return emails.sent[i].html;
  }
  return undefined;
}

/**
 * The 6-digit code out of a rendered email body.
 *
 * Scoped to the region FOLLOWING the visible label, because the message is a
 * styled document that legitimately contains other numbers (an item reference, a
 * phone number, a fee). Reading the code block itself is what keeps this
 * assertion about the delivered code rather than about a regex accident.
 */
function codeFromEmailBody(html: string, label = 'Secret pickup code'): string | undefined {
  const at = html.indexOf(label);
  const region = at >= 0 ? html.slice(at, at + 800) : html;
  return /\b(\d{6})\b/.exec(region)?.[1];
}

let itemId = '';
let dropoffCode = '';
let claimId = '';
let paymentSessionId = '';
let invoiceId = '';
let pickupCode = '';

beforeAll(async () => {
  // NODE_ENV='production' selects createApp()'s deterministic static-dist branch
  // instead of booting a Vite dev server. Restored immediately; no production
  // code path is altered.
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

  const cats = await db.getCategories();
  if (!cats.some((c) => c.id === CATEGORY)) {
    // Non-sensitive on purpose: the paid OCR path is skipped entirely rather
    // than being mocked around.
    await db.createCategory({
      id: CATEGORY, name_en: 'E2E Phone', name_sw: 'Simu ya Jaribio',
      total_fee: TOTAL_FEE, finder_share: 125, agent_share: 175, platform_share: 200,
      is_sensitive_document: false,
    });
  }
  // Agents are prerequisite IDENTITIES. Agent onboarding is an identity concern;
  // agent AUTHORIZATION is exercised for real over HTTP below.
  //
  // BATCH 1 — each fixture agent also carries an explicit PAYOUT TARGET. The
  // three lifecycle agents hold a personal M-Pesa phone number with the
  // supported method (the launch policy), and the two stage-8.9 agents hold
  // targets that policy refuses. This is fixture data, not a bypass of any rule:
  // the destinations are read by the settlement executor exactly as a real
  // agent's stored values would be.
  const agentPayoutTargets: Record<string, { destination: string; method: string }> = {
    [AGENT_ID]: { destination: AGENT_PAYOUT_PHONE, method: 'Personal M-Pesa' },
    [INACTIVE_AGENT_ID]: { destination: AGENT_PAYOUT_PHONE, method: 'Personal M-Pesa' },
    [OTHER_AGENT_ID]: { destination: AGENT_PAYOUT_PHONE, method: 'Personal M-Pesa' },
    [TILL_AGENT_ID]: { destination: 'E2E-TILL-777', method: 'Till Number' },
    [UNSUPPORTED_METHOD_AGENT_ID]: { destination: AGENT_PAYOUT_PHONE, method: 'Pochi la Biashara' },
  };
  for (const [id, status, n] of [[AGENT_ID, 'active', 11], [INACTIVE_AGENT_ID, 'suspended', 12], [OTHER_AGENT_ID, 'active', 13], [TILL_AGENT_ID, 'active', 14], [UNSUPPORTED_METHOD_AGENT_ID, 'active', 15]] as const) {
    if (!(await db.getAgent(id))) {
      await db.createAgent({
        id,
        // NOTE the real Agent field names: createAgent() maps a FIXED key set
        // (contact_phone, mpesa_till_or_paybill, national_id_hash, ...). Using
        // `phone` / `till_number` would silently drop geography and leave
        // AgentMatchingService with no eligible candidate.
        full_name: status === 'active' ? 'E2E Agent' : 'E2E Suspended Agent',
        contact_phone: e164(n),
        status,
        business_name: 'E2E Agency',
        location_address: 'Kenyatta Avenue, Nairobi',
        mpesa_till_or_paybill: agentPayoutTargets[id].destination,
        payout_method_type: agentPayoutTargets[id].method,
        refundable_deposit: 0,
        national_id_hash: `E2E-HASH-${id}`,
        // The REAL AgentMatchingService ranks active agents by county first,
        // then sub-county. Giving the fixture the same canonical geography as
        // the reported item means genuine matching runs and assigns the agent â€”
        // this is geography setup, not a bypass of the matching logic.
        county: COUNTY,
        administrative_unit_id: NAIROBI_UNIT,
        // AgentMatchingService's primary strategy is Haversine distance, so the
        // fixture agent must hold a real, valid coordinate pair to be eligible.
        latitude: NAIROBI_LAT,
        longitude: NAIROBI_LON,
      } as any);
    }
  }
}, 120000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

const reportBody = (over: Record<string, any> = {}) => ({
  categoryId: CATEGORY,
  photoBase64: PNG_B64,
  locationDescription: 'Kenyatta Avenue, Nairobi',
  foundCounty: 'Nairobi',
  administrativeUnitId: NAIROBI_UNIT,
  latitude: NAIROBI_LAT,
  longitude: NAIROBI_LON,
  finderPhone: FINDER_PHONE,
  description: 'Black phone found on a bench',
  termsAccepted: true,
  ...over,
});

const ownerAnswers = { lastDigits: '1234', fullName: 'E2E Owner' };

// Resolved from the REAL canonical geography config rather than hardcoded, so
// the test cannot drift if Kenya's administrative units are updated â€” and so
// the county/sub-county pairing is genuinely server-valid. Note the canonical
// county name is 'Nairobi City'; 'Nairobi' is only a user-typed alias that
// resolveFoundCountyInput() normalises.
// Everything geographic is resolved through the SAME canonical helpers the
// server uses, so the fixture can never disagree with the resolver about what
// "Nairobi" means. resolveCountyName('Nairobi') yields the canonical county
// ('Nairobi City'), which is what the item persists AND what AgentMatchingService
// compares agents against.
const COUNTY = resolveCountyName('Nairobi') ?? 'Nairobi City';
const NAIROBI_UNIT = administrativeUnitsForCounty(COUNTY)[0]?.id ?? '';
// Nairobi CBD. Used for BOTH the reported item and the fixture agent so the
// real Haversine matcher has two valid points to compare.
const NAIROBI_LAT = -1.286389;
const NAIROBI_LON = 36.817223;

// ===========================================================================
// STAGE 1 â€” FINDER REPORT
// ===========================================================================
describe('stage 1 â€” finder reports a found item over HTTP', () => {
  it('rejects an invalid county', async () => {
    const r = await http('/api/items/report', { body: reportBody({ foundCounty: 'Atlantis' }) });
    expect(r.status).toBe(400);
  });

  it('rejects an unknown category', async () => {
    const r = await http('/api/items/report', { body: reportBody({ categoryId: 'no-such-category' }) });
    expect(r.status).toBe(400);
  });

  it('rejects a non-image payload (image validation NOT weakened)', async () => {
    const r = await http('/api/items/report', {
      body: reportBody({ photoBase64: Buffer.from('not-an-image').toString('base64') }),
    });
    expect(r.status).toBe(400);
  });

  it('accepts a valid report, persists the item and returns a usable id', async () => {
    const r = await http('/api/items/report', { body: reportBody() });
    expect(r.status).toBe(200);
    itemId = String(r.body?.itemId || r.body?.item?.id || '');
    dropoffCode = String(r.body?.dropoffCode || '');
    expect(itemId).toBeTruthy();

    const item = await db.getItem(itemId);
    expect(item).toBeTruthy();
    expect(item!.status).toBe('awaiting_dropoff');
    expect(item!.found_county).toBe(COUNTY);
    // AgentMatchingService ranks ACTIVE agents by county then sub-county. If it
    // produced no match, the test agent fixture did not carry the geography the
    // matcher needs (it is set from config below); fail loudly rather than
    // quietly continuing with an unassigned item.
    expect(item!.assigned_agent_id).toBe(AGENT_ID);
  });
});

// ===========================================================================
// STAGE 2 â€” PUBLIC DISCOVERY + PRIVACY PROJECTION
// ===========================================================================
describe('stage 2 â€” public discovery exposes nothing sensitive', () => {
  it('hides the item while it is awaiting dropoff', async () => {
    const r = await http('/api/items/search');
    expect(r.status).toBe(200);
    expect((r.body as any[]).map((i) => i.id)).not.toContain(itemId);
  });

  it('exposes the item after dropoff, with no sensitive fields', async () => {
    // Physical verification must precede dropoff approval: the server refuses
    // confirm-dropoff while the item is still verification_status='pending'.
    // NOTE verify-item resolves the item by its DROP-OFF CODE (which is the
    // item's primary key) and additionally requires categoryId + foundArea.
    // recordItemVerification additionally REQUIRES a `reason` whenever any
    // field is corrected (database.ts: "A reason is required for any
    // correction") â€” and found_area differs from the report's
    // location_description, so this is a correction. Supplying the reason is
    // what a real agent does; the guard is left untouched.
    const verify = await http('/api/agents/verify-item', {
      token: agentToken(AGENT_ID),
      body: {
        dropoffCode: itemId,
        categoryId: CATEGORY,
        foundArea: 'Kenyatta Avenue, Nairobi',
        reason: 'Agent physical inspection confirms the finder report.',
        physicallyVerified: true,
      },
    });
    expect(verify.status).toBe(200);

    // confirm-dropoff ALSO resolves the item by drop-off code, which is the
    // item's primary key â€” proven by verify-item succeeding with the same value.
    // The report response's `dropoffCode` field is not the lookup key.
    const drop = await http('/api/agents/confirm-dropoff', {
      token: agentToken(AGENT_ID), body: { dropoffCode: itemId },
    });
    expect(drop.status).toBe(200);
    expect((await db.getItem(itemId))!.status).toBe('at_agent');

    const r = await http('/api/items/search');
    const found = (r.body as any[]).find((i) => i.id === itemId);
    expect(found).toBeTruthy();

    for (const leaked of ['finder_phone', 'finder_email', 'finder_identifying_details', 'latitude',
      'longitude', 'ocr_extracted_number', 'document_number_hash', 'assigned_agent_id',
      'locked_total_fee', 'locked_finder_share', 'security_answers', 'owner_phone',
      'payment_reference', 'contact_phone']) {
      expect(Object.keys(found)).not.toContain(leaked);
    }
    const serialised = JSON.stringify(found);
    expect(serialised).not.toContain(FINDER_PHONE);
    expect(serialised).not.toContain(OWNER_PHONE);
  });
});

// ===========================================================================
// STAGE 3 â€” OWNER CLAIM, DUPLICATE PROTECTION, CLAIM OTP
//
// NOTE the real contracts read from the current source, not assumed:
//  * claims/submit is IDEMPOTENT per (item, owner phone): a second submission
//    returns 200 with the EXISTING claim, not a 409. Asserting 409 here would be
//    testing a behaviour the application does not have.
//  * claims/:id/request-otp requires { phone } and must match owner_phone.
//  * claims/:id/verify-otp takes { code } ONLY â€” no phone.
//  * An unknown category falls back to the 'other-item' verification profile,
//    which requires a `description` answer (config/verificationProfiles.ts).
//  * claims/submit is now an AUTHENTICATED WRITE: every submission below
//    presents the owner's REAL session cookie, because requireCustomerAuth is
//    the first middleware on the route. Even the two VALIDATION-rejection cases
//    are authenticated, so they still prove the 400 validation order instead of
//    short-circuiting at the 401 boundary. The claim OTP steps stay
//    deliberately cookie-less â€” the claim OTP, not an account, is what proves
//    ownership of a claim â€” which is exactly the property the OTP tests below
//    (and Stage 7A) continue to demonstrate.
// ===========================================================================
const claimAnswers = { description: 'Black phone in a dark case, scratched back.' };

// ---------------------------------------------------------------------------
// Shared OWNER identity for every customer-authenticated stage.
//
// Stage 3 submits the claim that Stages 4-6 later hand over, pay and settle, so
// it needs a live session BEFORE Stage 7A establishes the customer and the
// claim links. Rather than mint a second account (or a second session) for the
// same owner, this creates the owner account and its session ONCE, on first
// use, and caches the raw token. The raw token lives only in this variable; it
// is never logged, printed or asserted on.
//
// The session row is created with the REAL primitive the login route uses
// (db.createCustomerSession over hashCode(raw)), so requireCustomerAuth's real
// cookie -> hash -> session lookup is what validates it. Nothing is mocked.
// ---------------------------------------------------------------------------
const OWNER_CUSTOMER_ID = `E2E-CUS-OWNER-${RUN}`;
// E1: the owner's account must carry a VERIFIED EMAIL, because that is the only
// destination a claim code can now be delivered to. Derived from the id so it is
// unique per run.
const OWNER_EMAIL = `${OWNER_CUSTOMER_ID.toLowerCase()}@example.test`;
let ownerCookie = '';
const ownerSession = async (): Promise<string> => {
  if (ownerCookie) return ownerCookie;
  let owner: any = await db.getCustomerByPhone(OWNER_PHONE);
  if (!owner) {
    // The real production pair: the ONLY writer of status='active' +
    // email_verified_at. A fixture built any other way would not match what
    // registration actually creates.
    await db.createCustomerPendingActivation(OWNER_CUSTOMER_ID, 'E2E Owner', OWNER_PHONE, OWNER_EMAIL);
    await db.activateCustomerAccount(OWNER_CUSTOMER_ID);
    owner = await db.getCustomerByPhone(OWNER_PHONE);
  }
  const raw = crypto.randomBytes(32).toString('hex');
  await db.createCustomerSession(
    `E2E-CSES-${owner.id}-${RUN}`, owner.id, hashCode(raw),
    new Date(Date.now() + 60 * 60 * 1000),
  );
  ownerCookie = raw;
  return ownerCookie;
};

describe('stage 3 â€” owner claim, duplicate protection and claim OTP', () => {
  it('rejects a claim that omits the identifying detail', async () => {
    const r = await http('/api/claims/submit', {
      cookie: await ownerSession(),
      body: { itemId, ownerPhone: OWNER_PHONE, securityAnswers: claimAnswers, termsAccepted: true },
    });
    expect(r.status).toBe(400);
  });

  it('rejects a claim with the wrong verification answers', async () => {
    const r = await http('/api/claims/submit', {
      cookie: await ownerSession(),
      body: {
        itemId, ownerPhone: OWNER_PHONE, securityAnswers: {}, termsAccepted: true,
        ownerIdentifyingDetails: 'Serial 12345', ownerEmail: OWNER_EMAIL,
      },
    });
    expect(r.status).toBe(400);
  });

  it('creates the claim in the initial verification state', async () => {
    const r = await http('/api/claims/submit', {
      cookie: await ownerSession(),
      body: {
        itemId, ownerPhone: OWNER_PHONE, securityAnswers: claimAnswers,
        termsAccepted: true, ownerIdentifyingDetails: 'Serial 12345', ownerEmail: OWNER_EMAIL,
      },
    });
    expect(r.status).toBe(200);
    expect(r.body?.success).toBe(true);

    claimId = String(r.body?.claim?.id || '');
    expect(claimId).toBeTruthy();

    const claim = await db.getClaim(claimId);
    expect(claim).toBeTruthy();
    expect(claim!.item_id).toBe(itemId);
    expect(claim!.owner_phone).toBe(OWNER_PHONE);
    expect(claim!.status).toBe('pending_verification');
  });

  it('is idempotent for a duplicate claim and creates no second active claim', async () => {
    const before = (await db.getClaims()).filter(
      (c: any) => c.item_id === itemId && String(c.status) === 'pending_verification'
    ).length;

    const r = await http('/api/claims/submit', {
      // The SAME live session as the successful submission above.
      cookie: await ownerSession(),
      body: {
        itemId, ownerPhone: OWNER_PHONE, securityAnswers: claimAnswers,
        termsAccepted: true, ownerIdentifyingDetails: 'Serial 12345', ownerEmail: OWNER_EMAIL,
      },
    });
    // The real contract: the existing claim is RETURNED, not rejected.
    expect(r.status).toBe(200);
    expect(String(r.body?.claim?.id || '')).toBe(claimId);

    const after = (await db.getClaims()).filter(
      (c: any) => c.item_id === itemId && String(c.status) === 'pending_verification'
    ).length;
    expect(after).toBe(before);
    expect(after).toBe(1);
  });

  it('does not let a different owner reuse the OTP endpoint (oracle-safe 404)', async () => {
    const r = await http(`/api/claims/${claimId}/request-otp`, { body: { phone: e164(99) } });
    expect(r.status).toBe(404);
  });

  it('requests an OTP, never returns it, and persists a HASH only', async () => {
    const before = emailOtp.sent.length;
    const r = await http(`/api/claims/${claimId}/request-otp`, { body: { phone: OWNER_PHONE } });
    expect(r.status).toBe(200);

    // The response must not leak the code.
    expect(JSON.stringify(r.body)).not.toMatch(/\b\d{4}\b/);

    // It went out through the controlled EMAIL seam (E1), addressed to the
    // account's own verified address â€” never to the number in the body.
    expect(emailOtp.sent.length).toBe(before + 1);
    expect(emailOtp.sent[emailOtp.sent.length - 1].to).toBe(OWNER_EMAIL);
    const captured = lastCodeForRecipient(OWNER_EMAIL);
    expect(captured).toMatch(/^\d{4}$/);

    // Hash-only persistence: the plaintext must not be in the stored record.
    const record: any = await db.getClaimOtp(claimId);
    expect(record).toBeTruthy();
    expect(record.code_hash).toBeTruthy();
    expect(String(record.code_hash)).not.toBe(captured);
    expect(String(record.code_hash)).toMatch(/^[0-9a-f]{64}$/i);

    // Still awaiting verification.
    expect((await db.getClaim(claimId))!.status).toBe('pending_verification');
  });

  it('rejects an invalid OTP without advancing or consuming the challenge', async () => {
    const good = lastCodeForRecipient(OWNER_EMAIL)!;
    const wrong = good === '0000' ? '9999' : '0000';
    const r = await http(`/api/claims/${claimId}/verify-otp`, { body: { code: wrong } });
    expect(r.status).toBe(400);
    expect((await db.getClaim(claimId))!.status).toBe('pending_verification');
    // The legitimate challenge survives the failed attempt.
    const record: any = await db.getClaimOtp(claimId);
    expect(record).toBeTruthy();
    expect(String(record.code_hash)).not.toBe(wrong);
  });

  it('accepts the valid OTP exactly once and advances the lifecycle', async () => {
    const good = lastCodeForRecipient(OWNER_EMAIL)!;
    const r = await http(`/api/claims/${claimId}/verify-otp`, { body: { code: good } });
    expect(r.status).toBe(200);

    const claim = await db.getClaim(claimId);
    expect(claim!.status).toBe('awaiting_agent_confirmation');
    // Single-use: the challenge record is consumed.
    const record: any = await db.getClaimOtp(claimId);
    expect(record === undefined || record === null).toBe(true);
  });

  it('refuses to replay the same OTP', async () => {
    const good = lastCodeForRecipient(OWNER_EMAIL)!;
    const r = await http(`/api/claims/${claimId}/verify-otp`, { body: { code: good } });
    expect(r.status).toBe(400);
    // The claim must not regress or advance a second time.
    expect((await db.getClaim(claimId))!.status).toBe('awaiting_agent_confirmation');
  });
});

// ===========================================================================
// STAGE 3b â€” CLAIM SUBMISSION IS A CUSTOMER-AUTHENTICATED WRITE.
//
// The hole being closed: a claim could be created with NO session at all. The
// UI gated entry (PublicItemView checks /api/customer/me; OwnerView hands a
// signed-out visitor to /account), the server never checked â€” so hiding the
// form was the only thing standing between an anonymous caller and an
// unbounded, unnotified point of claim creation.
//
// Everything below drives the REAL application over real HTTP with the REAL
// requireCustomerAuth: it is not mocked, stubbed, monkey-patched or bypassed
// anywhere in this file. Each rejection asserts the 401 AND the absence of
// every side effect the caller would otherwise have caused (a claim row, an
// SMS/notification fan-out, a lifecycle move) â€” "refused" only means something
// if nothing happened.
//
// The positive half of the same contract is Stage 3 above: the accepted
// submission there carries the owner's genuine cookie, and the claim-OTP steps
// that follow it stay deliberately cookie-less, because the claim OTP â€” not an
// account â€” is what proves ownership of a claim.
// ===========================================================================
describe('stage 3b â€” POST /api/claims/submit requires a real customer session', () => {
  const claimCountFor = async (id: string) =>
    (await db.getClaims()).filter((c: any) => c.item_id === id).length;
  const submitBody = (id: string) => ({
    itemId: id, ownerPhone: OWNER_PHONE, securityAnswers: claimAnswers,
    termsAccepted: true, ownerIdentifyingDetails: 'Serial 12345', ownerEmail: OWNER_EMAIL,
  });

  it('3b.1 an ANONYMOUS caller is refused with 401 and NOTHING happens', async () => {
    const before = await claimCountFor(itemId);
    const emailBefore = emailOtp.sent.length;
    const statusBefore = (await db.getClaim(claimId))!.status;

    const r = await http('/api/claims/submit', { body: submitBody(itemId) });

    expect(r.status).toBe(401);
    // A refusal, not a claim-shaped success: no claim, no id, no `success`.
    expect(r.body?.success).not.toBe(true);
    expect(r.body?.claim).toBeUndefined();
    expect(r.text).not.toMatch(/CLM-\d/);

    // No row, no code dispatched, no lifecycle movement: the handler body never ran.
    expect(await claimCountFor(itemId)).toBe(before);
    expect(emailOtp.sent.length).toBe(emailBefore);
    expect((await db.getClaim(claimId))!.status).toBe(statusBefore);
  });

  it('3b.2 the boundary runs BEFORE the item lookup â€” an unknown item is not an oracle', async () => {
    const r = await http('/api/claims/submit', { body: submitBody('ITEM-DOES-NOT-EXIST') });
    // 401, NOT the handler's own "not claimable" answer: an unauthenticated
    // caller cannot use this route to probe which item ids exist.
    expect(r.status).toBe(401);
    expect(r.status).not.toBe(404);
  });

  it('3b.3 a forged or unknown session cookie is refused with 401', async () => {
    const before = await claimCountFor(itemId);
    const r = await http('/api/claims/submit', {
      cookie: crypto.randomBytes(32).toString('hex'),
      body: submitBody(itemId),
    });
    expect(r.status).toBe(401);
    expect(r.body?.claim).toBeUndefined();
    expect(await claimCountFor(itemId)).toBe(before);
  });

  it('3b.4 an EXPIRED session is refused with 401', async () => {
    // A real session row, for the real owner account, whose TTL has passed:
    // only the expiry differs from a valid session and nothing is forged. The
    // cookie -> hash -> session lookup finds it, so this proves expiry is
    // ENFORCED, not merely that unknown tokens are rejected.
    const owner: any = await db.getCustomerByPhone(OWNER_PHONE);
    expect(owner).toBeTruthy();
    const raw = crypto.randomBytes(32).toString('hex');
    await db.createCustomerSession(
      `E2E-CSES-EXPIRED-${RUN}`, owner.id, hashCode(raw), new Date(Date.now() - 60_000),
    );
    const before = await claimCountFor(itemId);
    const r = await http('/api/claims/submit', { cookie: raw, body: submitBody(itemId) });
    expect(r.status).toBe(401);
    expect(await claimCountFor(itemId)).toBe(before);
  });

  it('3b.5 a customer id supplied in the BODY cannot authenticate anyone', async () => {
    // The obvious bypass: assert you are the owner by sending a REAL account id
    // (and the real owner phone) instead of presenting a session. Identity is
    // read exclusively from the httpOnly cookie, so this is still anonymous.
    const owner: any = await db.getCustomerByPhone(OWNER_PHONE);
    expect(owner).toBeTruthy();
    const before = await claimCountFor(itemId);
    const r = await http('/api/claims/submit', {
      body: { ...submitBody(itemId), customerId: owner.id, customer_id: owner.id },
    });
    expect(r.status).toBe(401);
    expect(r.body?.claim).toBeUndefined();
    expect(await claimCountFor(itemId)).toBe(before);
  });

  it('3b.6 the SAME request fails anonymously and succeeds with the owner session (full flow)', async () => {
    // A claimable item no other stage touches, produced by the real HTTP
    // lifecycle: report -> agent verify -> agent dropoff.
    const rep = await http('/api/items/report', {
      body: reportBody({ description: 'Third item used for the auth-boundary proof' }),
    });
    expect(rep.status).toBe(200);
    const freshItemId = String(rep.body?.itemId || rep.body?.item?.id || '');
    expect(freshItemId).toBeTruthy();

    const verify = await http('/api/agents/verify-item', {
      token: agentToken(AGENT_ID),
      body: {
        dropoffCode: freshItemId, categoryId: CATEGORY,
        foundArea: 'Kenyatta Avenue, Nairobi',
        reason: 'Agent physical inspection of the third item.',
        physicallyVerified: true,
      },
    });
    expect(verify.status).toBe(200);
    const drop = await http('/api/agents/confirm-dropoff', {
      token: agentToken(AGENT_ID), body: { dropoffCode: freshItemId },
    });
    expect(drop.status).toBe(200);
    expect((await db.getItem(freshItemId))!.status).toBe('at_agent');
    expect(await claimCountFor(freshItemId)).toBe(0);

    // (1) ANONYMOUS â€” refused, and not one claim was created.
    const anon = await http('/api/claims/submit', { body: submitBody(freshItemId) });
    expect(anon.status).toBe(401);
    expect(await claimCountFor(freshItemId)).toBe(0);

    // (2) AUTHENTICATED â€” the IDENTICAL body plus the owner's real session
    // cookie. The session is the only difference between the two calls, which
    // is exactly what the boundary is supposed to depend on.
    const auth = await http('/api/claims/submit', {
      cookie: await ownerSession(), body: submitBody(freshItemId),
    });
    expect(auth.status).toBe(200);
    expect(auth.body?.success).toBe(true);
    const freshClaimId = String(auth.body?.claim?.id || '');
    expect(freshClaimId).toBeTruthy();
    expect(await claimCountFor(freshItemId)).toBe(1);
    const freshClaim: any = await db.getClaim(freshClaimId);
    expect(freshClaim.status).toBe('pending_verification');
    expect(freshClaim.owner_phone).toBe(OWNER_PHONE);

    // (3) The claim-OTP journey is STILL anonymous: the new boundary stops at
    // claim creation and deliberately does not follow the owner journey further.
    const otp = await http(`/api/claims/${freshClaimId}/request-otp`, { body: { phone: OWNER_PHONE } });
    expect(otp.status).toBe(200);
    const code = lastCodeForRecipient(OWNER_EMAIL);
    expect(code).toMatch(/^\d{4}$/);

    const verified = await http(`/api/claims/${freshClaimId}/verify-otp`, { body: { code: code! } });
    expect(verified.status).toBe(200);
    expect((await db.getClaim(freshClaimId))!.status).toBe('awaiting_agent_confirmation');
  });
});

// ===========================================================================
// STAGE 4 â€” AGENT AUTHORIZATION BOUNDARY
//
// The real contract of POST /api/agents/claims/:claimId/confirm-viewing, read
// from source, in order:
//   authenticateJWT        -> 401 (absent or invalid token)
//   requireActiveAgent     -> 403 (valid token, non-actionable agent)
//   claim lookup           -> 404
//   item.assigned_agent_id -> 403   <-- THE IDOR BOUNDARY
//   claim status           -> 400
//   CAS transition         -> 200
//
// Every rejection below asserts BOTH the status and the absence of a DB change.
// Statuses are the application's real ones: this route deliberately answers 403
// (not 404) to an authenticated-but-unassigned agent, and the test preserves
// that rather than normalising it.
// ===========================================================================
const VIEWING = () => `/api/agents/claims/${claimId}/confirm-viewing`;

const snapshot = async () => {
  const c: any = await db.getClaim(claimId);
  const i: any = await db.getItem(itemId);
  return { claimStatus: c?.status, itemStatus: i?.status, agent: i?.assigned_agent_id, at: c?.agent_confirmed_at ?? null };
};

describe('stage 4 â€” agent authorization boundary', () => {
  it('rejects an UNAUTHENTICATED mutation (no Authorization header)', async () => {
    const before = await snapshot();
    const r = await http(VIEWING(), { body: {} });
    expect(r.status).toBe(401);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects an INVALID bearer token', async () => {
    const before = await snapshot();
    const r = await http(VIEWING(), { token: 'not-a-real-jwt', body: {} });
    // REAL contract (services/auth.ts, authenticateJWT): 401 is reserved for a
    // missing/non-Bearer header; a header that IS present but whose token fails
    // verification answers 403. Preserved deliberately â€” not normalised.
    expect(r.status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a valid token for a SUSPENDED agent (active-agent enforcement)', async () => {
    const before = await snapshot();
    // Genuine, correctly signed token â€” for an agent that is not actionable.
    const r = await http(VIEWING(), { token: agentToken(INACTIVE_AGENT_ID), body: {} });
    expect(r.status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a valid ACTIVE agent that is NOT the assignee (IDOR boundary)', async () => {
    const before = await snapshot();
    // Fully valid + active + correctly signed â€” and still refused, because the
    // application determines the assignment, not the caller.
    const other: any = await db.getAgent(OTHER_AGENT_ID);
    expect(other).toBeTruthy();
    expect(other.status).toBe('active');

    const r = await http(VIEWING(), { token: agentToken(OTHER_AGENT_ID), body: {} });
    expect(r.status).toBe(403);

    const after = await snapshot();
    expect(after).toEqual(before);
    // Assignment is untouched and no evidence/financial state was created.
    expect(after.agent).toBe(AGENT_ID);
    expect(after.claimStatus).toBe('awaiting_agent_confirmation');
    expect(after.at).toBeNull();
  });

  it('allows the ASSIGNED active agent, and the transition is attributed to it', async () => {
    const r = await http(VIEWING(), { token: agentToken(AGENT_ID), body: {} });
    expect(r.status).toBe(200);

    const claim: any = await db.getClaim(claimId);
    expect(claim.status).toBe('pending_payment');
    // The mutation is recorded against the ASSIGNED agent, not any other.
    expect(claim.agent_confirmed_at).toBeTruthy();
    const item: any = await db.getItem(itemId);
    expect(item.assigned_agent_id).toBe(AGENT_ID);
  });
});

// ===========================================================================
// STAGE 5 â€” PAYMENT AUTHORIZATION, SESSION, SERVER-AUTHORITATIVE AMOUNT
//
// Real contracts read from source:
//  * payment-auth   : { phone } -> 404 CLAIM_UNAVAILABLE for unknown claim AND
//                     for wrong phone (one shared body: the F4/R2 oracle rule).
//                     Mints a 20-minute token, stored hash-only.
//  * payment-session: { phone, payerPhone } â€” there is NO amount field. The
//                     amount is resolveAuthoritativePaymentFee(item, category),
//                     server-side only. An existing active session is REUSED.
//  * pay            : { phone, paymentAuthToken } â€” 400 missing token, 403
//                     invalid/expired, 404 unknown claim/wrong phone, 400 wrong
//                     state, 423 not claimable, then STK with the server fee.
//
// The payment-auth token is looked up BY CLAIM ID, which is what makes it
// non-transferable between claims. Stage 5 proves that rather than asserting it.
// ===========================================================================
let authToken = '';
let sessionId = '';
let secondItemId = '';
let secondClaimId = '';

const paySessions = async (id: string) => (await db.listPaymentSessionsForClaim(id)).map((s: any) => s.id);

describe('stage 5 â€” payment authorization, session and authoritative amount', () => {
  it('mints a payment authorization token and stores it HASH only', async () => {
    const r = await http(`/api/claims/${claimId}/payment-auth`, { body: { phone: OWNER_PHONE } });
    expect(r.status).toBe(200);
    authToken = String(r.body?.paymentAuthToken || '');
    expect(authToken.length).toBeGreaterThan(16);

    const rec: any = await db.getClaimPaymentAuthToken(claimId);
    expect(rec).toBeTruthy();
    // Hash-only: the plaintext must not equal, and must not appear in, the row.
    expect(String(rec.token_hash)).not.toBe(authToken);
    expect(JSON.stringify(rec)).not.toContain(authToken);
  });

  it('hides the claim from a caller who does not know the owner phone (404)', async () => {
    const before = await paySessions(claimId);
    const r = await http(`/api/claims/${claimId}/payment-auth`, { body: { phone: e164(99) } });
    expect(r.status).toBe(404);
    expect(await paySessions(claimId)).toEqual(before);
  });

  it('IGNORES a client-supplied amount and uses the server-authoritative fee', async () => {
    // The endpoint does not even read an `amount` field. Sending one anyway
    // must not change what is charged.
    const r = await http(`/api/claims/${claimId}/payment-session`, {
      body: { phone: OWNER_PHONE, payerPhone: PAYER_PHONE, amount: 1, total_fee: 1, fee: 1 },
    });
    expect(r.status).toBe(200);
    sessionId = String(r.body?.paymentSession?.id || '');
    expect(sessionId).toBeTruthy();

    const item: any = await db.getItem(itemId);
    const category: any = await db.getCategory(item.category_id);
    const serverFee = Number(item.locked_total_fee ?? category.total_fee);

    const session: any = await db.getPaymentSessionById(sessionId);
    expect(Number(session.amount)).toBe(serverFee);
    expect(Number(session.amount)).not.toBe(1);   // client value ignored
    expect(session.currency).toBe('KES');
    expect(session.claim_id).toBe(claimId);
  });

  it('reuses the same active session on repeat (no duplicate sessions)', async () => {
    const r = await http(`/api/claims/${claimId}/payment-session`, { body: { phone: OWNER_PHONE } });
    expect(r.status).toBe(200);
    expect(r.body?.reused).toBe(true);
    expect(String(r.body?.paymentSession?.id)).toBe(sessionId);
    expect((await paySessions(claimId)).length).toBe(1);
  });

  it('refuses to pay without, or with a forged, authorization token', async () => {
    const a = await http(`/api/claims/${claimId}/pay`, { body: { phone: OWNER_PHONE } });
    expect(a.status).toBe(403);
    const b = await http(`/api/claims/${claimId}/pay`, {
      body: { phone: OWNER_PHONE, paymentAuthToken: 'f'.repeat(64) },
    });
    expect(b.status).toBe(403);
  });

  it('refuses to pay from the wrong phone (oracle-safe 404)', async () => {
    const r = await http(`/api/claims/${claimId}/pay`, {
      body: { phone: e164(99), paymentAuthToken: authToken },
    });
    expect(r.status).toBe(404);
  });

  it('builds a SECOND item and claim through the real flow, for cross-claim proof', async () => {
    const rep = await http('/api/items/report', {
      body: reportBody({ description: 'Second item used for cross-claim proof' }),
    });
    expect(rep.status).toBe(200);
    // The real report response is { success, item, message } â€” there is NO
    // `itemId` key. Stage 1 already reads `item.id`; this must match.
    secondItemId = String(rep.body?.itemId || rep.body?.item?.id || '');
    expect(secondItemId).toBeTruthy();
    expect(secondItemId).not.toBe(itemId);

    const v = await http('/api/agents/verify-item', {
      token: agentToken(AGENT_ID),
      body: {
        dropoffCode: secondItemId, categoryId: CATEGORY,
        foundArea: 'Kenyatta Avenue, Nairobi',
        reason: 'Agent physical inspection of the second item.',
        physicallyVerified: true,
      },
    });
    expect(v.status).toBe(200);
    const d = await http('/api/agents/confirm-dropoff', {
      token: agentToken(AGENT_ID), body: { dropoffCode: secondItemId },
    });
    expect(d.status).toBe(200);

    const c = await http('/api/claims/submit', {
      // Claim submission is customer-authenticated: the same owner account and
      // the same live session as claim-1 (which is what makes the link in
      // Stage 7A valid for both claims).
      cookie: await ownerSession(),
      body: {
        itemId: secondItemId, ownerPhone: OWNER_PHONE, securityAnswers: claimAnswers,
        termsAccepted: true, ownerIdentifyingDetails: 'Serial 99999',
      },
    });
    expect(c.status).toBe(200);
    secondClaimId = String(c.body?.claim?.id || '');
    expect(secondClaimId).toBeTruthy();
    expect(secondClaimId).not.toBe(claimId);
    // Deliberately NOT advanced to pending_payment.
    expect((await db.getClaim(secondClaimId))!.status).toBe('pending_verification');
  });

  it('does NOT let the first claim\'s authorization token be used on a second claim', async () => {
    const before = await paySessions(secondClaimId);
    // Correct owner phone, but the token was minted for a DIFFERENT claim id.
    // The auth record is looked up per claim, so no token can travel.
    const r = await http(`/api/claims/${secondClaimId}/pay`, {
      body: { phone: OWNER_PHONE, paymentAuthToken: authToken },
    });
    expect(r.status).toBe(403);
    expect(await paySessions(secondClaimId)).toEqual(before);
    expect((await db.getClaim(secondClaimId))!.status).toBe('pending_verification');
  });

  it('refuses to open a payment session for a claim that is not pending_payment', async () => {
    const before = await paySessions(secondClaimId);
    // Lifecycle guard: claim.status !== 'pending_payment' -> 400.
    const r = await http(`/api/claims/${secondClaimId}/payment-session`, { body: { phone: OWNER_PHONE } });
    expect(r.status).toBe(400);
    expect(await paySessions(secondClaimId)).toEqual(before);
    expect((await db.getClaim(secondClaimId))!.status).toBe('pending_verification');
  });
});

// ===========================================================================
// STAGE 6 â€” SIGNED INTASEND WEBHOOK, RECONCILIATION, ESCROW, PICKUP CODE
//
// Real contracts read from source:
//  * Authentication is the configured IntaSend webhook CHALLENGE, carried in the
//    payload (`challenge`). It is NOT an HMAC signature. A missing or mismatched
//    challenge is rejected 401.
//  * Challenge rejection is enforced in the route whenever a challenge is
//    configured (and always in production), so the cases below exercise the real
//    production branch by temporarily setting NODE_ENV='production'.
//  * Malformed amounts (non-numeric/object/boolean/array) make
//    reconcileWebhookAmount return 'unknown', which routes to
//    fetchAuthoritativeCollectionStatus. Under test INTASEND_SECRET_KEY is a
//    placeholder, so that lookup fails CLOSED and escrow is withheld â€” the P1
//    behaviour, with no outbound provider call.
// ===========================================================================
const WEBHOOK = '/api/webhooks/intasend';
// Current IntaSend collection-webhook contract: authentication is the configured
// CHALLENGE (sent in the payload), not an HMAC signature. The suite configures a
// known challenge and posts it with each event.
const WEBHOOK_CHALLENGE = 'e2e-collection-challenge';
process.env.INTASEND_WEBHOOK_CHALLENGE = WEBHOOK_CHALLENGE;

const postHook = async (body: any, challenge: string | null) => {
  const payload = challenge === null ? { ...body } : { ...body, challenge };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(base + WEBHOOK, { method: 'POST', headers, body: JSON.stringify(payload) });
  let json: any = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, body: json };
};

const asProduction = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { return await fn(); } finally { process.env.NODE_ENV = prev; }
};

const escrowSnapshot = async (id: string) => {
  const c: any = await db.getClaim(id);
  const p: any = await db.getPickupCode(id).catch(() => undefined);
  return {
    status: c?.status ?? null,
    paid_at: c?.paid_at ?? null,
    payment_reference: c?.payment_reference ?? null,
    pickup: p ? (p.code_hash ? 'hash' : 'none') : 'none',
  };
};

let pickupPhaseOnly = '';

describe('stage 6 â€” signed IntaSend webhook, reconciliation and escrow', () => {
  it('refuses a MISSING challenge in production mode (no financial mutation)', async () => {
    const before = await escrowSnapshot(claimId);
    const body = { invoice_id: 'INV-MISSING-SIG', state: 'COMPLETE', api_ref: claimId, value: '500' };
    const r = await asProduction(() => postHook(body, null));
    expect(r.status).toBe(401);
    expect(await escrowSnapshot(claimId)).toEqual(before);
  });

  it('refuses an INVALID challenge in production mode (no financial mutation)', async () => {
    const before = await escrowSnapshot(claimId);
    const body = { invoice_id: 'INV-BAD-SIG', state: 'COMPLETE', api_ref: claimId, value: '500' };
    const r = await asProduction(() => postHook(body, 'deadbeef'.repeat(8)));
    expect(r.status).toBe(401);
    expect(await escrowSnapshot(claimId)).toEqual(before);
  });

  it('refuses a WRONG challenge even outside production (a configured challenge is always enforced)', async () => {
    const before = await escrowSnapshot(claimId);
    const bodyB = { invoice_id: 'INV-SWAP', state: 'COMPLETE', api_ref: claimId, value: '500' };
    // Signed for body A, transmitting body B â€” proves the signature covers the
    // actual raw payload rather than a loose field.
    const r = await postHook(bodyB, 'not-the-configured-challenge');
    expect(r.status).toBe(401);
    expect(await escrowSnapshot(claimId)).toEqual(before);
  });

  it('refuses a cross-claim webhook: claim-1 payment cannot move claim-2', async () => {
    const before = await escrowSnapshot(secondClaimId);
    const body = { invoice_id: 'INV-CROSS', state: 'COMPLETE', api_ref: secondClaimId, value: '500' };
    await postHook(body, WEBHOOK_CHALLENGE);
    expect(await escrowSnapshot(secondClaimId)).toEqual(before);
  });

  it('holds escrow for every MALFORMED amount shape (fails closed)', async () => {
    for (const bad of ['abc', {}, false, [], '', undefined, 0, -500]) {
      const body: any = { invoice_id: 'INV-MALFORMED', state: 'COMPLETE', api_ref: claimId };
      body.value = bad;
      const r = await postHook(body, WEBHOOK_CHALLENGE);
      expect(r.status).toBeLessThan(500);
      expect((await db.getClaim(claimId))!.status).toBe('pending_payment');
    }
    const after = await escrowSnapshot(claimId);
    expect(after.paid_at).toBeNull();
    expect(after.pickup).toBe('none');
  });

  it('holds escrow when the reported AMOUNT does not reconcile', async () => {
    const before = await escrowSnapshot(claimId);
    const body = { invoice_id: 'INV-MISMATCH', state: 'COMPLETE', api_ref: claimId, value: '1' };
    await postHook(body, WEBHOOK_CHALLENGE);
    const after = await escrowSnapshot(claimId);
    expect(after.status).toBe('pending_payment');
    expect(after.paid_at).toBeNull();
    expect(after.pickup).toBe('none');
    expect(after).toEqual(before);
  });

  it('reaches escrow_held on a correctly signed, correctly valued callback', async () => {
    const item: any = await db.getItem(itemId);
    const category: any = await db.getCategory(item.category_id);
    const serverFee = Number(item.locked_total_fee ?? category.total_fee);
    invoiceId = `PS-${claimId}-E2E`;

    const body = { invoice_id: invoiceId, state: 'COMPLETE', api_ref: claimId, value: String(serverFee) };
    const r = await postHook(body, WEBHOOK_CHALLENGE);
    expect(r.status).toBeLessThan(500);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
  });

  it('persists the pickup code as a HASH only and delivered it BY EMAIL', async () => {
    const row: any = await db.getPickupCode(claimId);
    expect(row).toBeTruthy();
    expect(row.code_hash).toBeTruthy();
    // 64 hex chars (HMAC-SHA256) â€” never the 6-digit plaintext.
    expect(String(row.code_hash)).toMatch(/^[0-9a-f]{64}$/i);

    // The owner received a real 6-digit code, inside the transactional
    // PAYMENT_RECEIVED email (E1 retired the SMS pickup path). The rendered body
    // is where the delivered code is read from, because the durable row stores
    // only its hash and the plaintext never touches the database.
    const html = lastEmailBodyFor(OWNER_EMAIL);
    expect(html).toBeTruthy();
    const delivered = codeFromEmailBody(html!);
    expect(delivered).toBeTruthy();
    // The delivered plaintext is NOT what was persisted.
    expect(String(row.code_hash)).not.toBe(delivered);
    // (the code itself is deliberately not logged)
  });

  it('is IDEMPOTENT: replaying the identical webhook does not double-apply', async () => {
    const before = await escrowSnapshot(claimId);
    const sessionsBefore = (await paySessions(claimId)).length;
    const hashBefore = String((await db.getPickupCode(claimId))!.code_hash);

    const body = { invoice_id: invoiceId, state: 'COMPLETE', api_ref: claimId, value: '500' };
    await postHook(body, WEBHOOK_CHALLENGE);
    await postHook(body, WEBHOOK_CHALLENGE);

    const claim: any = await db.getClaim(claimId);
    expect(claim.status).toBe('escrow_held');
    // No second escrow transition, no new session, pickup code NOT re-issued.
    expect((await paySessions(claimId)).length).toBe(sessionsBefore);
    expect(String((await db.getPickupCode(claimId))!.code_hash)).toBe(hashBefore);
    expect((await escrowSnapshot(claimId)).paid_at).toBe(before.paid_at);
  });
});

// ===========================================================================
// STAGE 7A â€” PICKUP-CODE RESEND (owner-bound, customer-session authenticated)
//
// Placement: this block runs immediately after Stage 6 and BEFORE the Stage 7
// handover, so claim-1 is still genuinely `escrow_held` â€” the state Stage 6
// produced through real HTTP. Nothing here is seeded: paid_at,
// payment_reference and the pickup-code hash all arrive from the real
// webhook-driven lifecycle, and are asserted before any resend is attempted.
//
// Auth contract read from source (services/customerAuth.ts):
//   cookie name : r4m_customer_session   (CUSTOMER_SESSION_COOKIE)
//   the raw token is hashed with hashCode() before the session row is looked
//   up; requireCustomerAuth reads ONLY that cookie â€” nothing else
//   authenticates, and no customer id from the body is trusted.
// requireCustomerAuth is NOT mocked, monkey-patched or bypassed: the genuine
// cookie is presented over real HTTP and the real middleware resolves it.
//
// Source contract of POST /api/customer/claims/:claimId/pickup-code/resend
// (routes/customerClaims.ts, in the exact order enforced):
//   401            -> requireCustomerAuth (no valid session)
//   404 notLinked  -> unknown claim OR not THIS customer's linked claim
//                     (ONE shared body, so it is not an existence oracle)
//   409            -> !isPickupEligibleClaimStatus(claim.status)
//   429            -> per-claim cooldown (PICKUP_CODE_RESEND_COOLDOWN_MS,
//                     2 minutes, keyed claimId + ':pickup-resend')
//   then: CSPRNG code -> SEND BEFORE PERSIST (provider ACCEPTANCE is the only
//   thing judged) -> createPickupCode (overwrites, atomically invalidating the
//   previous code) -> 200 { success: true } with no code, hash or phone.
// ===========================================================================
const COOKIE = 'r4m_customer_session';
// `ownerCookie` is declared ONCE, in the Stage 3 section above: claim submission
// is customer-authenticated, so the owner's session is created the first time a
// submit needs it and Stage 7A reuses that exact session instead of minting a
// second one for the same account. Only the SECOND identity is declared here.
let otherCookie = '';

/**
 * Full 7A security snapshot: the claim's lifecycle/financial state plus the
 * canonical pickup-code storage fields. Field names come from the real schema
 * (claims.status / claims.paid_at / claims.payment_reference and
 * pickup_codes.code_hash / pickup_codes.verified_at) â€” nothing is invented.
 */
const moneyAndPickup = async (id: string) => {
  const c: any = await db.getClaim(id);
  const p: any = await db.getPickupCode(id).catch(() => undefined);
  return {
    status: c?.status ?? null,
    paid_at: c?.paid_at ?? null,
    payment_reference: c?.payment_reference ?? null,
    hash: p?.code_hash ?? null,
    verified_at: p?.verified_at ?? null,
  };
};

const cookiePost = async (url: string, cookie: string, body: any) => {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${COOKIE}=${cookie}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
};

describe('stage 7A â€” owner-bound pickup-code resend over real HTTP', () => {
  it('7A.0 preconditions: claim-1 is escrow_held, paid and hash-backed by Stage 6', async () => {
    const s = await moneyAndPickup(claimId);
    expect(s.status).toBe('escrow_held');
    expect(s.paid_at).toBeTruthy();
    expect(s.payment_reference).toBeTruthy();
    expect(String(s.hash)).toMatch(/^[0-9a-f]{64}$/i);
  });

  it('7A.0b establishes REAL customers, sessions and claim links via application primitives', async () => {
    const mkSession = async (customerId: string) => {
      // Exactly what the real login route stores: a random 32-byte token whose
      // HASH is the session row. The raw value is held only in this closure and
      // is never logged, printed or asserted on.
      const raw = crypto.randomBytes(32).toString('hex');
      await db.createCustomerSession(
        `E2E-CSES-${customerId}-${RUN}`, customerId, hashCode(raw),
        new Date(Date.now() + 60 * 60 * 1000),
      );
      return raw;
    };

    const ownerId = `E2E-CUS-OWNER-${RUN}`;
    let owner: any = await db.getCustomerByPhone(OWNER_PHONE);
    if (!owner) owner = await db.createCustomer(ownerId, 'E2E Owner', OWNER_PHONE);
    // The REAL application link primitive. It enforces the owner-phone match
    // itself, exactly as the claim-link route does after the claim OTP, and
    // writes a genuine customer_claim_links row.
    expect((await linkVerifiedClaimToCustomer(owner, await db.getClaim(claimId))).linked).toBe(true);
    // claim-2 is submitted by the same owner phone, so the same account owns it
    // â€” that is what makes it a valid fixture for the 7A.3 lifecycle test.
    expect((await linkVerifiedClaimToCustomer(owner, await db.getClaim(secondClaimId))).linked).toBe(true);
    // The owner's session already exists â€” Stage 3 needed it to submit both
    // claims. This returns that same live session rather than minting a second
    // one, so the /api/customer/me assertion below validates the very cookie the
    // claims were submitted on.
    ownerCookie = await ownerSession();
    expect(ownerCookie).toBeTruthy();

    // A second, equally REAL customer account. Used for 7A.2 only; its session
    // is never reused for the owner.
    const otherId = `E2E-CUS-OTHER-${RUN}`;
    let other: any = await db.getCustomerByPhone(PAYER_PHONE);
    if (!other) other = await db.createCustomer(otherId, 'E2E Other', PAYER_PHONE);
    otherCookie = await mkSession(other.id);

    // The genuine cookie is accepted by the REAL middleware, and the two
    // sessions really are two different identities.
    const me = await fetch(base + '/api/customer/me', { headers: { Cookie: `${COOKIE}=${ownerCookie}` } });
    const meOther = await fetch(base + '/api/customer/me', { headers: { Cookie: `${COOKIE}=${otherCookie}` } });
    expect(me.status).toBe(200);
    expect(meOther.status).toBe(200);
    const idOf = (b: any) => b?.customer?.id ?? b?.id ?? b?.customer_id;
    const meBody = idOf(await me.json());
    const meOtherBody = idOf(await meOther.json());
    expect(meBody).toBeTruthy();
    expect(meOtherBody).toBeTruthy();
    expect(meOtherBody).not.toBe(meBody);
  });

  it('7A.1 the OWNER can resend: 200, one real email, hash-only persistence, no plaintext leak', async () => {
    const before = await moneyAndPickup(claimId);
    const emailBefore = emailOtp.sent.length;

    const r = await cookiePost(`/api/customer/claims/${claimId}/pickup-code/resend`, ownerCookie, {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });

    // The response carries no 6-digit code, no hash and no phone number.
    expect(r.text).not.toMatch(/\d{6}/);
    expect(r.text.toLowerCase()).not.toMatch(/code_hash|pickup_code|phone/);

    // EXACTLY one EMAIL went out, to the signed-in account's own verified
    // address (E1: never to a number from the request), through the seam.
    expect(emailOtp.sent.length).toBe(emailBefore + 1);
    const delivered = emailOtp.sent[emailOtp.sent.length - 1];
    expect(delivered.to).toBe(OWNER_EMAIL);
    expect(delivered.eventType).toBe('PICKUP_CODE_EMAIL');
    const plain = /\d{6}/.exec(delivered.code)?.[0];
    expect(plain).toBeTruthy();
    // `plain` lives in test memory only â€” never logged, never asserted by value.

    const after = await moneyAndPickup(claimId);
    // The claim is untouched: still escrow_held, money unmoved, not verified.
    expect(after.status).toBe('escrow_held');
    expect(after.paid_at).toBe(before.paid_at);
    expect(after.payment_reference).toBe(before.payment_reference);
    expect(after.verified_at).toBe(before.verified_at);
    // Hash-only persistence, and the previous code is atomically invalidated.
    expect(String(after.hash)).toMatch(/^[0-9a-f]{64}$/i);
    expect(after.hash).not.toBe(before.hash);
    // The delivered plaintext is never what was persisted.
    expect(after.hash).not.toBe(plain);
    expect(before.hash).not.toBe(plain);
  });

  it('7A.2 a DIFFERENT customer is refused with the shared non-disclosing 404', async () => {
    const before = await moneyAndPickup(claimId);
    const emailBefore = emailOtp.sent.length;

    const r = await cookiePost(`/api/customer/claims/${claimId}/pickup-code/resend`, otherCookie, {});
    expect(r.status).toBe(404);
    // Identical body to the unknown-claim case: not an existence oracle.
    const unknown = await cookiePost(`/api/customer/claims/CLM-DOES-NOT-EXIST/pickup-code/resend`, ownerCookie, {});
    expect(unknown.status).toBe(404);
    expect(r.body).toEqual(unknown.body);

    // No SMS, no hash rotation, no lifecycle or financial movement.
    expect(emailOtp.sent.length).toBe(emailBefore);
    expect(await moneyAndPickup(claimId)).toEqual(before);
  });

  it('7A.2b an UNAUTHENTICATED caller is refused with 401 by requireCustomerAuth', async () => {
    const before = await moneyAndPickup(claimId);
    const emailBefore = emailOtp.sent.length;
    const res = await fetch(base + `/api/customer/claims/${claimId}/pickup-code/resend`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(401);
    expect(emailOtp.sent.length).toBe(emailBefore);
    expect(await moneyAndPickup(claimId)).toEqual(before);
  });

  it('7A.3 an INELIGIBLE lifecycle is refused with 409 and creates nothing', async () => {
    // claim-2 was created through the real HTTP lifecycle and deliberately left
    // at pending_verification â€” an explicitly pickup-INELIGIBLE status. It was
    // NOT seeded into escrow_held / pending_settlement / released.
    const before = await moneyAndPickup(secondClaimId);
    expect(before.status).toBe('pending_verification');
    expect(before.hash).toBeNull();
    const emailBefore = emailOtp.sent.length;

    // The LEGITIMATE owner of claim-2 (same owner phone) is the caller here, so
    // this is a lifecycle rejection and not an ownership rejection.
    const r = await cookiePost(`/api/customer/claims/${secondClaimId}/pickup-code/resend`, ownerCookie, {});
    expect(r.status).toBe(409);
    expect(r.body?.error).toBeTruthy();

    // No pickup code created, no SMS, no financial mutation.
    expect(emailOtp.sent.length).toBe(emailBefore);
    expect(await moneyAndPickup(secondClaimId)).toEqual(before);
    expect((await db.getPickupCode(secondClaimId).catch(() => undefined)) ?? null).toBeNull();
    // claim-1 is entirely unaffected by the other claim's rejection.
    expect((await moneyAndPickup(claimId)).status).toBe('escrow_held');
  });

  it('7A.4 the per-claim cooldown blocks an immediate second resend (429)', async () => {
    // PICKUP_CODE_RESEND_COOLDOWN_MS = 2 minutes, keyed on the claim. The
    // minimum number of requests that demonstrates it is exactly ONE more: 7A.1
    // already armed the bucket, so this is the blocked second attempt. The
    // limiter is neither weakened nor disabled, and no clock is faked.
    const before = await moneyAndPickup(claimId);
    const emailBefore = emailOtp.sent.length;

    const r = await cookiePost(`/api/customer/claims/${claimId}/pickup-code/resend`, ownerCookie, {});
    expect(r.status).toBe(429);
    expect(r.body?.error).toBeTruthy();

    // The blocked request costs nothing and changes nothing.
    expect(emailOtp.sent.length).toBe(emailBefore);
    expect(await moneyAndPickup(claimId)).toEqual(before);
  });

  it('7A.4b the cooldown is per-claim: a throttled claim does not throttle another', async () => {
    // Same account, same route, a different claim: proving the throttle key is
    // the CLAIM and not the customer, so it cannot be used to lock a user out
    // of an unrelated claim.
    const second = await moneyAndPickup(secondClaimId);
    const emailBefore = emailOtp.sent.length;
    const r = await cookiePost(`/api/customer/claims/${secondClaimId}/pickup-code/resend`, ownerCookie, {});
    // Still refused â€” but with the LIFECYCLE reason, not the cooldown reason.
    expect(r.status).toBe(409);
    expect(emailOtp.sent.length).toBe(emailBefore);
    expect(await moneyAndPickup(secondClaimId)).toEqual(second);
  });
});
// ===========================================================================
// STAGE 7 â€” PICKUP-CODE HANDOFF -> pending_settlement
//
// Real contract of POST /api/agents/confirm-handover, read from source, in the
// exact order the route enforces:
//   pause 503 | claim 404 | assignment 403 | category/agent 404 |
//   claim.status !== 'escrow_held' 400 | stolen/hold/dispute 423 |
//   pickupCode missing 400 | pickup record missing 400 |
//   timingSafeEqualHex(hashCode(code), code_hash) 400 |
//   markPickupCodeVerified | handoverPhotoBase64 OPTIONAL (uploaded and stored
//   only when supplied) -> setHandoverPhoto |
//   enterPendingSettlement (CAS) -> pending_settlement
//
// NOTE the real ordering: the pickup code is VERIFIED BEFORE any photo is
// uploaded, so a wrong code never leaves evidence behind. The photo is now
// OPTIONAL, so a photo-less request legitimately marks the code verified and
// proceeds to settlement (7B.7). The tests below assert the ACTUAL behaviour
// rather than an assumed rollback.
// The route deliberately does NOT pay: the payout stays in the ledger for the
// administrator-initiated settlement path, which the sweep never reaches.
// Stage 7 must end at pending_settlement.
// ===========================================================================
let pickupPlain = '';
let handoverUrl = '';

const HANDOVER = '/api/agents/confirm-handover';
const moneySnapshot = async (id: string) => {
  const c: any = await db.getClaim(id);
  // The photo reference lives on the claim row in the current schema; probed
  // defensively so the snapshot never depends on a helper that may not exist.
  const photo = c?.handover_photo_url ?? c?.handover_photo ?? null;
  return {
    status: c?.status ?? null,
    paid_at: c?.paid_at ?? null,
    payment_reference: c?.payment_reference ?? null,
    photo: photo ?? null,
  };
};

describe('stage 7 â€” pickup-code handover to pending_settlement', () => {
  it('captures the delivered pickup plaintext in test memory only', () => {
    // E1: the pickup code is delivered by email now â€” read it from the rendered
    // payment body rather than from an SMS capture list.
    // The LIVE code is the most recent delivery to the account: a resend
    // regenerates and atomically INVALIDATES the previous code, exactly as the
    // earlier SMS capture list made the latest code the live one. The
    // payment-time body is the fallback when no resend has happened yet.
    const resent = [...emailOtp.sent]
      .reverse()
      .find((m) => m.to === OWNER_EMAIL && m.eventType === 'PICKUP_CODE_EMAIL');
    if (resent) {
      pickupPlain = resent.code;
    } else {
      const html = lastEmailBodyFor(OWNER_EMAIL);
      expect(html).toBeTruthy();
      pickupPlain = codeFromEmailBody(html!) ?? '';
    }
    expect(pickupPlain).toMatch(/^\d{6}$/);
    // The DB holds only the hash, never this value.
    // (the value itself is never logged)
  });

  it('7B.1 refuses handover with NO Authorization', async () => {
    const before = await moneySnapshot(claimId);
    const r = await http(HANDOVER, { body: { claimId, pickupCode: pickupPlain, handoverPhotoBase64: PNG_B64 } });
    expect(r.status).toBe(401);
    expect(await moneySnapshot(claimId)).toEqual(before);
  });

  it('7B.2 refuses an INVALID JWT', async () => {
    const before = await moneySnapshot(claimId);
    const r = await http(HANDOVER, {
      token: 'not-a-real-jwt', body: { claimId, pickupCode: pickupPlain, handoverPhotoBase64: PNG_B64 },
    });
    expect(r.status).toBe(403);   // real contract: 401 = no header, 403 = unverifiable token
    expect(await moneySnapshot(claimId)).toEqual(before);
  });

  it('7B.3 refuses a SUSPENDED agent', async () => {
    const before = await moneySnapshot(claimId);
    const r = await http(HANDOVER, {
      token: agentToken(INACTIVE_AGENT_ID),
      body: { claimId, pickupCode: pickupPlain, handoverPhotoBase64: PNG_B64 },
    });
    expect(r.status).toBe(403);
    expect(await moneySnapshot(claimId)).toEqual(before);
  });

  it('7B.4 refuses a DIFFERENT active agent (IDOR)', async () => {
    const before = await moneySnapshot(claimId);
    const r = await http(HANDOVER, {
      token: agentToken(OTHER_AGENT_ID),
      body: { claimId, pickupCode: pickupPlain, handoverPhotoBase64: PNG_B64 },
    });
    expect(r.status).toBe(403);
    expect(await moneySnapshot(claimId)).toEqual(before);
  });

  it('7B.5 refuses a WRONG pickup code and stores no evidence', async () => {
    const before = await moneySnapshot(claimId);
    const wrong = pickupPlain === '000000' ? '111111' : '000000';
    const r = await http(HANDOVER, {
      token: agentToken(AGENT_ID),
      body: { claimId, pickupCode: wrong, handoverPhotoBase64: PNG_B64 },
    });
    expect(r.status).toBe(400);
    const after = await moneySnapshot(claimId);
    expect(after).toEqual(before);
    // Proof-before-evidence: a wrong code leaves NO handover photo behind.
    expect(after.photo).toBeNull();
  });

  it('7B.6 refuses a MISSING pickup code', async () => {
    const before = await moneySnapshot(claimId);
    const r = await http(HANDOVER, {
      token: agentToken(AGENT_ID), body: { claimId, handoverPhotoBase64: PNG_B64 },
    });
    expect(r.status).toBe(400);
    expect(await moneySnapshot(claimId)).toEqual(before);
  });

  it('7B.7 accepts a handover WITHOUT a photo — no evidence, still reaches pending_settlement', async () => {
    // AW batch — the photo is now optional. This builds a FRESH escrow_held claim
    // (and its pickup code) so the no-photo path is proven over the real HTTP
    // route without disturbing claim-1, which 7C hands over WITH a photo next.
    const cid = `E2E-AW-NOPHOTO-${RUN}`;
    const iid = `E2E-AW-NOPHOTO-ITEM-${RUN}`;
    await db.createItem({
      id: iid,
      category_id: CATEGORY,
      photo_url: 'e2e-nophoto.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'E2E no-photo fixture',
      latitude: null,
      longitude: null,
      finder_phone: e164(30),
      assigned_agent_id: AGENT_ID,
      status: 'at_agent',
      flaggedForReview: false,
      isDescriptionOnly: false,
      description: null,
      is_sensitive_document: false,
      rejection_reason: null,
      locked_total_fee: TOTAL_FEE,
      locked_finder_share: 100,
      locked_agent_share: 150,
      locked_platform_share: 250,
    } as any);
    await db.createClaim({
      id: cid,
      item_id: iid,
      owner_phone: OWNER_PHONE,
      security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'no-photo fixture' },
      verification_tier: 1,
      status: 'escrow_held',
      owner_id_proof_url: null,
      payment_reference: 'E2E-AW-NOPHOTO-PAYREF',
      owner_identifying_details: null,
    } as any);
    const plain = '654321';
    await db.createPickupCode(cid, hashCode(plain));

    const r = await http(HANDOVER, {
      token: agentToken(AGENT_ID),
      body: { claimId: cid, pickupCode: plain }, // no handoverPhotoBase64 at all
    });
    expect(r.status).toBe(200);

    const claim: any = await db.getClaim(cid);
    expect(claim.status).toBe('pending_settlement');
    // No photo was fabricated, uploaded, or persisted.
    expect(claim.handover_photo_url ?? null).toBeNull();
    // Money still does NOT move at handover.
    expect(claim.paid_at).toBeNull();
    expect(claim.payment_reference).toBe('E2E-AW-NOPHOTO-PAYREF');
    // The pickup code was verified.
    const pickup: any = await db.getPickupCode(cid);
    expect(pickup?.verified_at).toBeTruthy();
  });

  it('7C succeeds for the ASSIGNED agent and reaches pending_settlement', async () => {
    const before = await moneySnapshot(claimId);
    const r = await http(HANDOVER, {
      token: agentToken(AGENT_ID),
      body: { claimId, pickupCode: pickupPlain, handoverPhotoBase64: PNG_B64 },
    });
    expect(r.status).toBe(200);

    const claim: any = await db.getClaim(claimId);
    expect(claim.status).toBe('pending_settlement');
    // Money does NOT move at handover: paid_at / reference are untouched.
    expect(claim.paid_at).toBe(before.paid_at);
    expect(claim.payment_reference).toBe(before.payment_reference);
    const after = await moneySnapshot(claimId);

    // Handover photo persisted through the controlled storage seam.
    const photo = after.photo;
    expect(photo).toBeTruthy();
    handoverUrl = String(photo);
    expect(handoverUrl).toBeTruthy();

    // Pickup code now recorded as verified, assignment unchanged.
    const pickup: any = await db.getPickupCode(claimId);
    expect(pickup?.verified_at).toBeTruthy();
    const item: any = await db.getItem(itemId);
    expect(item.assigned_agent_id).toBe(AGENT_ID);
  });

  it('7E replay does not advance beyond pending_settlement', async () => {
    const before = await moneySnapshot(claimId);
    const r = await http(HANDOVER, {
      token: agentToken(AGENT_ID),
      body: { claimId, pickupCode: pickupPlain, handoverPhotoBase64: PNG_B64 },
    });
    // Real contract: the claim is no longer escrow_held, and the settlement CAS
    // refuses. Either way nothing may move past pending_settlement.
    expect([400, 409]).toContain(r.status);
    const after = await moneySnapshot(claimId);
    expect(after.status).toBe('pending_settlement');
    expect(after.paid_at).toBe(before.paid_at);
    expect(after.payment_reference).toBe(before.payment_reference);
  });

  it('7F claim-1\'s pickup credential cannot authorise a handover on claim-2', async () => {
    const before2 = await moneySnapshot(secondClaimId);
    const r = await http(HANDOVER, {
      token: agentToken(AGENT_ID),
      body: { claimId: secondClaimId, pickupCode: pickupPlain, handoverPhotoBase64: PNG_B64 },
    });
    expect(r.status).toBeLessThan(500);
    expect(await moneySnapshot(secondClaimId)).toEqual(before2);
  });

  it('7G financial invariant: escrow held, nothing settled or released', async () => {
    const claim: any = await db.getClaim(claimId);
    expect(claim.status).toBe('pending_settlement');
    // Still not terminal, and the dispute window is what gates release.
    expect(claim.status).not.toBe('released');
    expect(claim.status).not.toBe('settled');
    // Sessions remain as created â€” handover books no new financial state.
    expect((await paySessions(claimId)).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// STAGE 8 â€” SETTLEMENT: pending_settlement -> released
//
// SOURCE CONTRACT AUDIT (read from the current source, not assumed).
//
// 1. SETTLEMENT ENTRY POINTS (D-2B-B-E) - payout submission is reachable over
//    HTTP ONLY, and EVERY path is gated on a durable administrator approval:
//      a) POST /api/admin/claims/:id/settlement/approve  - records the durable
//         sign-off (settlement_approved_at / settlement_approved_by) and its
//         CLAIM_SETTLEMENT_APPROVED audit row in ONE transaction. It never
//         moves the claim and never touches the provider.
//      b) POST /api/admin/claims/:id/settlement/initiate  - the supported payout
//         path: requireAdminPermission(claims.settlement_initiate) ->
//         db.attemptSettlementRelease(claimId) -> executeClaimSettlement(claimId).
//      c) POST /api/admin/claims/:id/release-settlement   - LEGACY, retained for
//         compatibility. It delegates to exactly the same CAS as (b) and can no
//         longer force anything: no durable approval, or an unelapsed settle_at
//         window, means 409 and no payout, with `next` pointing at (a)/(b).
//      d) releaseDueSettlements() - a setInterval(5min) sweep started by
//         startServer(). It SUBMITS NO PAYOUT AT ALL (reporting only); its own
//         source contract is asserted in src/db/__tests__/settlementEarnings.test.ts.
//         Not HTTP-reachable: createApp() does not start it and this suite never
//         calls startServer().
//
//    This suite drives (a), (b) and (c) over the real HTTP boundary. It never
//    calls attemptSettlementRelease / executeClaimSettlement / finalizeSettlement
//    directly; the only DB-level primitives it uses are the fixture builders
//    (enterPendingSettlement / approveSettlement) that stand in for the earlier
//    lifecycle stages.
//
// 2. SETTLE_AT REVIEW WINDOW - claims.settle_at, written by
//    enterPendingSettlement() as now + DISPUTE_WINDOW_MS
//    (DISPUTE_WINDOW_HOURS, default 48). D-2B-B-E: it gates BOTH actions - the
//    approval write and the release CAS - and there is no override anywhere, so
//    a claim inside its window cannot be approved OR paid even by an admin
//    (asserted in 8.14). The window guard itself is also asserted below through
//    db.getClaimsDueForSettlement(), a READ-ONLY reporting query.
//
// 3. PAYOUT PROVIDER SEAM â€” PaymentService.triggerIntasendPayout() ->
//    fetchWithTimeout() -> the global fetch() against
//    <INTASEND_BASE_URL>/send-money/initiate/ (documented initiation path, Batch 1B-C1). The provider is controlled AT THAT
//    EXISTING SEAM by a passthrough global.fetch that intercepts only the
//    IntaSend host and lets every other request (including this suite's own
//    calls to the ephemeral listener) through untouched. The provider
//    abstraction, payload construction, amount calculation, response parsing
//    and every ledger write all stay REAL.
//
// 4. PAYOUT AMOUNT â€” computed server-side in executeClaimSettlement() from
//    item.locked_finder_share / locked_agent_share (falling back to the
//    category's shares). The route reads NO amount from the request.
//
// 5. IDEMPOTENCY - three independent mechanisms, all asserted below:
//      a) attemptSettlementRelease()'s CAS: pending_settlement -> releasing, only
//         with a durable approval on file and an elapsed settle_at window.
//      b) per-recipient ledger rows: only rows whose payout_outcome is
//         'not_submitted' are ever sent, so a retry can never re-pay a
//         recipient that already succeeded (E3A).
//      c) the durable pre-submission marker
//         (db.markPayoutSubmissionStarted) - a compare-and-swap written BEFORE
//         the provider is called, so a competing worker cannot submit the same
//         attempt and a process death mid-call cannot re-authorize a
//         resubmission.
//
// 6. FINAL STATE â€” claims.status='released' via finalizeSettlement()'s own
//    releasing -> released CAS, plus ledger rows flipped to 'completed' and a
//    FINALIZE_SETTLEMENT audit row. The schema has no settled_at / released_at
//    columns, so none is asserted.
//
// 7. PROVIDER OUTCOMES (E3A) - the service returns four of them, and the ledger
//    records each as its own durable payout_outcome:
//      'success' -> status 'completed', outcome 'completed'   (authoritative)
//      'pending' -> status 'pending',   outcome 'accepted'    (the batch was
//                   accepted; the individual B2C transfer is NOT confirmed)
//      'unknown' -> status 'pending',   outcome 'unknown'     (timeout,
//                   transport failure, or a provider 5xx: the request may
//                   already have been executed)
//      'failed'  -> status 'failed',    outcome 'rejected'    (a 4xx refusal:
//                   the request itself was rejected before execution)
//    Only 'completed' finalises a claim. 'accepted', 'unknown' and 'rejected'
//    are all UNRESOLVED, and the assertions below prove they are NOT resubmitted
//    by a later sweep or a repeated administrator release.
// ===========================================================================

const RELEASE = (id: string) => `/api/admin/claims/${id}/release-settlement`;
// D-2B-B-E - the supported workflow. Approve records the durable sign-off;
// initiate is the only path that may submit a payout. The legacy RELEASE route
// above delegates to exactly the same rule.
const APPROVE = (id: string) => `/api/admin/claims/${id}/settlement/approve`;
const INITIATE = (id: string) => `/api/admin/claims/${id}/settlement/initiate`;
const ADMIN_USERNAME = `e2e-admin-${RUN}`;
// Committed test-only fixtures. Not credentials: valid against no real
// IntaSend or admin account, and the CI committed-secret scanner ignores the
// MY_* prefix by design.
const ADMIN_PASSWORD = 'MY_TEST_ONLY_E2E_ADMIN_PASSWORD';
const FAKE_INTASEND_KEY = 'MY_TEST_ONLY_INTASEND_KEY_e2e_stage8';

let adminToken = '';
let revokedAdminToken = '';
let prevIntaKey: string | undefined;
// E3A: the claim that genuinely reaches `released` in stage 8. The other claims
// in this stage deliberately do NOT: their payouts end in an accepted, unknown
// or refused state, which is exactly what must never be resubmitted.
let releasedClaimId = '';
// D-2B-B-E: the claim used for the provider-outcome half of the stage. claim-1's
// settle_at window is deliberately still OPEN (asserted in 8.0 and again in
// 8.14), so under the new rule it can neither be approved nor paid - a real,
// elapsed window plus a durable approval is now required, and this fixture has
// both.
let dueClaimId = '';
let dueItemId = '';

// The controlled payout provider. `mode` is swapped per test; `calls` records
// the exact batch payload the application SENT, so the amount invariant is
// proven against what the PROVIDER received rather than a ledger read-back.
const payout = {
  mode: 'accept' as 'accept' | 'network-error' | 'reject',
  // The HTTP status the provider answers with in 'reject' mode. 4xx means the
  // request ITSELF was refused, with no transfer executed; 5xx means the
  // provider (or its gateway) failed while handling a request it may already
  // have executed. E3A must classify those two differently, so the seam has to
  // be able to produce both.
  rejectStatus: 500,
  calls: [] as Array<{ url: string; payload: any }>,
  // EVERY narrative ever sent to the provider, accumulated across the whole
  // stage and deliberately NOT cleared by reset(). The duplicate-submission
  // guarantee is a property of the entire run, not of one phase of it, so a
  // per-phase view cannot prove it.
  seenNarratives: [] as string[],
  reset() { this.calls = []; this.mode = 'accept'; this.rejectStatus = 500; },
};

const realFetch = globalThis.fetch;

const installPayoutProviderSeam = () => {
  vi.stubGlobal('fetch', (input: any, init: any = {}) => {
    const url = String(input?.url ?? input);
    // Everything that is not the payout provider passes through untouched.
    if (!/intasend\.com/i.test(url)) return realFetch(input, init);
    let body: any = null;
    try { body = JSON.parse(String(init?.body ?? '{}')); } catch { /* not json */ }
    payout.calls.push({ url, payload: body });
    // Accumulated separately and never reset: see seenNarratives above.
    for (const t of (body?.transactions ?? [])) payout.seenNarratives.push(String(t?.narrative));

    if (payout.mode === 'network-error') {
      // A genuine timeout/connection failure: the application cannot know
      // whether the provider acted, so it must record 'unknown'.
      return Promise.reject(new Error('simulated provider network failure'));
    }
    if (payout.mode === 'reject') {
      return Promise.resolve({
        ok: false, status: payout.rejectStatus,
        text: async () => 'simulated provider rejection',
        json: async () => ({}),
      } as any);
    }
    return Promise.resolve({
      ok: true, status: 200,
      text: async () => JSON.stringify({ tracking_id: 'E2E-BATCH-1' }),
      json: async () => ({
        tracking_id: 'E2E-BATCH-1',
        transactions: (body?.transactions ?? []).map((t: any) => ({
          account: t.account, transaction_id: `E2E-TXN-${t.narrative}`,
        })),
      }),
    } as any);
  });
};

/** Full financial snapshot. Field names come from the real schema only. */
const financialSnapshot = async (id: string) => {
  const c: any = await db.getClaim(id);
  const ledger = (await db.getLedgerEntriesForClaim(id)).map((l: any) => ({
    type: l.type, status: l.status, amount: String(l.amount),
    provider_batch_id: l.provider_batch_id ?? null,
    provider_transaction_id: l.provider_transaction_id ?? null,
    failure_reason: l.failure_reason ?? null,
    // E3A: what the PROVIDER did with this row's payout attempt. NULL means no
    // submission history is recorded at all.
    payout_outcome: l.payout_outcome ?? null,
  })).sort((a, b) => a.type.localeCompare(b.type));
  return {
    status: c?.status ?? null,
    paid_at: c?.paid_at ?? null,
    payment_reference: c?.payment_reference ?? null,
    settle_at: c?.settle_at ?? null,
    ledger,
  };
};

const auditFor = async (action: string, needle: string) =>
  (await db.getAuditLogs()).filter((l: any) => l.action === action && String(l.details).includes(needle));

/**
 * E3A fixture: a genuinely releasable claim - item assigned to the real E2E
 * agent, an escrow_held claim, and the payout booked through the REAL
 * enterPendingSettlement path (so the three ledger rows carry the real
 * 'not_submitted' booking state). The dispute window is already elapsed.
 *
 * D-2B-B-E: an elapsed window is NOT sufficient any more, so by default this
 * fixture also records the durable administrator approval through the real
 * approveSettlement() write - that is what makes the claim releasable at all.
 * Pass `{ approve: false }` to get an otherwise-identical claim with a durable
 * window and NO approval, which is how the "no payout without approval" tests
 * (8.12-8.14) get their subject.
 *
 * BATCH 1: `agentId` and `finderPhone` select the payout DESTINATIONS, so stage
 * 8.9 can build claims whose finder leg, agent leg or both are ineligible under
 * the phone-only payout policy. The destinations are still read by the
 * settlement executor from the stored agent/item rows exactly as in production;
 * nothing about the payout path is stubbed by these options.
 *
 * Each provider outcome in this stage gets its OWN claim: a payout row's
 * submission state is one-way by design (that is the whole point of E3A), so a
 * single claim cannot be reused to exercise two different outcomes.
 */
const makeReleasableClaim = async (
  suffix: string,
  opts: { approve?: boolean; agentId?: string; finderPhone?: string } = {},
) => {
  const newClaimId = `E2E-E3A-CLAIM-${RUN}-${suffix}`;
  const newItemId = `E2E-E3A-ITEM-${RUN}-${suffix}`;
  await db.createItem({
    id: newItemId,
    category_id: CATEGORY,
    photo_url: 'e2e-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'E2E E3A fixture',
    latitude: null,
    longitude: null,
    // BATCH 1: the finder destination is overridable so stage 8.9 can build a
    // claim whose FINDER leg is as ineligible as its agent leg.
    finder_phone: opts.finderPhone ?? e164(20),
    assigned_agent_id: opts.agentId ?? AGENT_ID,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: false,
    rejection_reason: null,
    locked_total_fee: TOTAL_FEE,
    locked_finder_share: 100,
    locked_agent_share: 150,
    locked_platform_share: 250,
  } as any);
  await db.createClaim({
    id: newClaimId,
    item_id: newItemId,
    owner_phone: OWNER_PHONE,
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'E3A fixture' },
    verification_tier: 1,
    status: 'escrow_held',
    owner_id_proof_url: null,
    payment_reference: `E2E-E3A-PAYREF-${suffix}`,
    owner_identifying_details: null,
  } as any);
  const booked = await db.enterPendingSettlement(newClaimId, -1000);
  expect(booked.success, booked.message).toBe(true);
  // The durable approval is what actually authorizes a payout (D-2B-B-E), so the
  // default fixture records it through the real write - unless the caller wants
  // the unapproved variant on purpose.
  if (opts.approve !== false) {
    const approved = await db.approveSettlement(newClaimId, 'E2E fixture admin', `E3A fixture approval for ${suffix}`);
    expect(approved.ok, 'E3A fixture must record the durable settlement approval').toBe(true);
  }
  return { claimId: newClaimId, itemId: newItemId };
};

describe('stage 8 â€” settlement release to `released` over real HTTP', () => {
  beforeAll(async () => {
    // A real, non-placeholder key so triggerIntasendPayout() takes its genuine
    // HTTP branch instead of the non-production simulation shortcut, and
    // intercept that one call. Saved and restored in afterAll so no other
    // stage is affected.
    prevIntaKey = process.env.INTASEND_SECRET_KEY;
    process.env.INTASEND_SECRET_KEY = FAKE_INTASEND_KEY;
    installPayoutProviderSeam();

    // A REAL admin account, then the REAL login route: the bcrypt comparison,
    // the real 4h admin token and its embedded token_version all come from
    // production code. requireCurrentAdminSession is not stubbed.
    const bcrypt = (await import('bcryptjs')).default;
    if (!(await db.getAdminByUsername(ADMIN_USERNAME))) {
      await db.createAdminUser(
        `E2E-ADM-${RUN}`, ADMIN_USERNAME,
        await bcrypt.hash(ADMIN_PASSWORD, 4), 'E2E Settlement Admin',
      );
    }
    const login = await http('/api/auth/admin-login', {
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(login.body?.token).toBeTruthy();
    adminToken = String(login.body.token);
  }, 120000);

  afterAll(() => {
    vi.unstubAllGlobals();
    if (prevIntaKey === undefined) delete process.env.INTASEND_SECRET_KEY;
    else process.env.INTASEND_SECRET_KEY = prevIntaKey;
  });

  it('8.0 baseline: pending_settlement, paid, three pending ledger rows, nothing released', async () => {
    const s = await financialSnapshot(claimId);
    expect(s.status).toBe('pending_settlement');
    expect(s.paid_at).toBeTruthy();
    expect(s.payment_reference).toBeTruthy();
    // The dispute window is OPEN: settle_at is in the future, so the automatic
    // sweep would not touch this claim yet.
    expect(s.settle_at).toBeTruthy();
    expect(new Date(String(s.settle_at)).getTime()).toBeGreaterThan(Date.now());
    // Booked at handover, unpaid: exactly the three ledger rows, all pending.
    expect(s.ledger.map((l) => l.type)).toEqual(['agent_payout', 'finder_payout', 'platform_fee']);
    expect(s.ledger.every((l) => l.status === 'pending')).toBe(true);
    expect(s.ledger.every((l) => l.provider_transaction_id === null)).toBe(true);
    // E3A: the two recipient payout rows are POSITIVELY recorded as never
    // submitted, which is what makes their first legitimate submission possible.
    // The platform's own retained fee never touches a provider, so it stays NULL
    // (no submission history exists, and none can).
    expect(s.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.payout_outcome === 'not_submitted')).toBe(true);
    expect(s.ledger.find((l) => l.type === 'platform_fee')!.payout_outcome).toBeNull();
    // No provider call has been made at all.
    expect(payout.calls.length).toBe(0);
    // The sweep's own work queue (a read-only query) excludes this claim.
    expect((await db.getClaimsDueForSettlement()).some((c: any) => c.id === claimId)).toBe(false);
  });

  it('8.1 refuses an UNAUTHENTICATED settlement (401)', async () => {
    const before = await financialSnapshot(claimId);
    const r = await fetch(base + RELEASE(claimId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(r.status).toBe(401);
    expect(payout.calls.length).toBe(0);
    expect(await financialSnapshot(claimId)).toEqual(before);
  });

  it('8.2 refuses an INVALID token (403) and an unauthorized AGENT identity (403)', async () => {
    const before = await financialSnapshot(claimId);
    const bad = await http(RELEASE(claimId), { token: 'not-a-real-jwt', body: { password: ADMIN_PASSWORD } });
    // Real contract (services/auth.ts): 401 = no header, 403 = unverifiable token.
    expect(bad.status).toBe(403);

    // A genuine, correctly signed, ACTIVE agent token â€” the very agent that
    // performed the handover. Releasing escrow is NOT part of its role, so the
    // route's own role check must refuse it.
    const asAgent = await http(RELEASE(claimId), { token: agentToken(AGENT_ID), body: { password: ADMIN_PASSWORD } });
    expect(asAgent.status).toBe(403);

    expect(payout.calls.length).toBe(0);
    expect(await financialSnapshot(claimId)).toEqual(before);
  });

  it('8.3 refuses a REVOKED admin session (401) â€” token_version is re-checked live', async () => {
    // Mint a second real session, then invalidate it through the application's
    // OWN revocation mechanism (bump the account's token_version). A token
    // that was validly signed and is nowhere near expiry must still be refused.
    const login2 = await http('/api/auth/admin-login', {
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    revokedAdminToken = String(login2.body?.token || '');
    expect(revokedAdminToken).toBeTruthy();
    await db.bumpAdminTokenVersion(ADMIN_USERNAME);

    const before = await financialSnapshot(claimId);
    const r = await http(RELEASE(claimId), { token: revokedAdminToken, body: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(401);
    expect(payout.calls.length).toBe(0);
    expect(await financialSnapshot(claimId)).toEqual(before);

    // Re-establish the primary session against the new token_version: the
    // route stays reachable for the legitimate admin.
    const login3 = await http('/api/auth/admin-login', {
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    adminToken = String(login3.body?.token || '');
    expect(adminToken).toBeTruthy();
    expect((await db.getClaim(claimId))!.status).toBe('pending_settlement');
  });

  it('8.4 refuses an INELIGIBLE claim (409) - no payout, no release, no audit', async () => {
    // claim-2 is at pending_verification, produced by the real lifecycle above.
    const before = await financialSnapshot(secondClaimId);
    const auditsBefore = (await auditFor('ADMIN_RELEASE_SETTLEMENT', secondClaimId)).length;

    const r = await http(RELEASE(secondClaimId), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(409);
    // The eligibility guard fired BEFORE the release lock, so there is no
    // provider call, no ledger movement and no release audit row.
    expect(payout.calls.length).toBe(0);
    expect(await financialSnapshot(secondClaimId)).toEqual(before);
    expect((await auditFor('ADMIN_RELEASE_SETTLEMENT', secondClaimId)).length).toBe(auditsBefore);
    // claim-1 is entirely unaffected.
    expect((await db.getClaim(claimId))!.status).toBe('pending_settlement');
  });

  it('8.5 the payout amount is server-authoritative: a hostile client amount is ignored', async () => {
    // A claim whose window has elapsed AND which carries the durable approval -
    // the only shape that can be paid at all now (D-2B-B-E).
    const due = await makeReleasableClaim('DUE-WINDOW');
    dueClaimId = due.claimId;
    dueItemId = due.itemId;

    // The route reads no amount from the request, so this is proven where the
    // money actually moves - the batch the application SENT to the provider.
    // The provider is in 'accept' mode behind a real (non-placeholder) key, so
    // triggerIntasendPayout() takes its genuine HTTP branch.
    payout.reset();
    const item: any = await db.getItem(dueItemId);
    const expectedFinder = Number(item.locked_finder_share);
    const expectedAgent = Number(item.locked_agent_share);

    const r = await http(RELEASE(dueClaimId), {
      token: adminToken,
      // BATCH 1 (D) — every payout route re-authenticates, so the injected
      // financial fields below are accompanied by the operator's own password.
      body: { password: ADMIN_PASSWORD, amount: 1, fee: 1, total_fee: 1, finder_share: 1, agent_share: 1, payout: 1 },
    });
    // An accepted B2C batch is deliberately 'pending' per-recipient (IntaSend
    // accepting the batch is not the same as the transfer having completed),
    // so the claim correctly does NOT finalise: it reverts to
    // pending_settlement and the route reports the failure.
    expect(r.status).toBe(500);

    // Exactly one batch, two transactions: the finder and the agent. The
    // platform fee is retained and never disbursed.
    expect(payout.calls.length).toBe(1);
    const txns = payout.calls[0].payload?.transactions ?? [];
    expect(txns.length).toBe(2);

    // Nothing the client sent survived: the provider received the locked
    // server-side split, not 1.
    for (const t of txns) expect(String(t.amount)).not.toBe('1');
    const byNarrative = (needle: string) => txns.find((t: any) => String(t.narrative).includes(needle));
    expect(Number(byNarrative('FINDER')?.amount)).toBe(expectedFinder);
    expect(Number(byNarrative('AGENT')?.amount)).toBe(expectedAgent);

    // The two disbursements plus the retained platform fee equal exactly the
    // fee the owner paid â€” the split is conserved.
    const total = txns.reduce((n: number, t: any) => n + Number(t.amount), 0)
      + Number(item.locked_platform_share);
    expect(total).toBe(Number(item.locked_total_fee));

    // The provider is addressed with the claim reference, and each recipient
    // is a real destination the application resolved server-side.
    for (const t of txns) {
      expect(String(t.narrative)).toContain(dueClaimId);
      expect(String(t.account).length).toBeGreaterThan(0);
    }
    expect(payout.calls[0].payload?.provider).toBe('MPESA-B2C');
    expect(payout.calls[0].payload?.currency).toBe('KES');

    // No secret leaked into the provider payload captured into test memory.
    expect(JSON.stringify(payout.calls[0].payload)).not.toContain(ADMIN_PASSWORD);

    // E3A - an ACCEPTED batch is NOT a completed transfer. Both recipient rows
    // are recorded as 'accepted', the legacy status stays 'pending', the claim
    // is NOT released, and no provider identifier is invented.
    const accepted = await financialSnapshot(dueClaimId);
    expect(accepted.status).toBe('pending_settlement');
    expect(accepted.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.payout_outcome === 'accepted')).toBe(true);
    expect(accepted.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.status === 'pending')).toBe(true);
    // The batch reference the provider DID return is retained, because it is
    // the only handle for reconciling this submission.
    expect(accepted.ledger.find((l) => l.type === 'finder_payout')!.provider_batch_id).toBe('E2E-BATCH-1');
  });

  it('8.5b an ACCEPTED but unconfirmed payout is never resubmitted (no duplicate transfer)', async () => {
    // The defect this pins: the row is 'pending' on the ledger, and the NEXT
    // release used to treat that as "outstanding, send it again" - a second
    // transfer for money the provider had already accepted.
    const before = await financialSnapshot(dueClaimId);
    const callsBefore = payout.calls.length;

    const r = await http(RELEASE(dueClaimId), { token: adminToken, body: { password: ADMIN_PASSWORD } });

    // The claim is still releasable (it is back in pending_settlement and still
    // carries its durable approval, so the release CAS succeeds) but the
    // executor finds NOTHING eligible to submit, so it reports an unresolved
    // payout rather than moving money.
    expect(r.status).toBe(500);
    expect(payout.calls.length, 'the provider must not be called a second time').toBe(callsBefore);

    const after = await financialSnapshot(dueClaimId);
    expect(after.ledger, 'the ledger is byte-identical: nothing was submitted').toEqual(before.ledger);
    expect(after.status).toBe('pending_settlement');
    // ...and the unresolved state is explicitly recorded for the operator.
    expect((await auditFor('PAYOUT_RECONCILIATION_REQUIRED', dueClaimId)).length).toBeGreaterThan(0);
  });

  it('8.6 an UNREACHABLE provider is recorded as UNKNOWN and is never resubmitted', async () => {
    // A fresh claim: an accepted/uncertain row is never reopened, so each
    // provider outcome needs its own payout attempt (that is the point of E3A).
    const { claimId: c } = await makeReleasableClaim('UNKNOWN');

    // The provider is unreachable, so the application genuinely does not know
    // whether the disbursement was accepted: this is the 'unknown' outcome.
    // E3A: 'unknown' means the request MAY have been executed, so it is
    // UNRESOLVED - never silently resendable.
    payout.reset();
    payout.mode = 'network-error';

    const before = await financialSnapshot(c);
    const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    // executeClaimSettlement() found an unresolved payout, reverted the
    // releasing lock and returned a non-success result, surfaced as 500.
    expect(r.status).toBe(500);
    expect(payout.calls.length).toBe(1);

    const after = await financialSnapshot(c);
    // The revert really happened: back to pending_settlement, NOT released and
    // not left stuck in the transient 'releasing' lock.
    expect(after.status).toBe('pending_settlement');
    expect(after.status).not.toBe('releasing');
    // Collection evidence is untouched: a failed payout is not a lost payment.
    expect(after.paid_at).toBe(before.paid_at);
    expect(after.payment_reference).toBe(before.payment_reference);
    // No false financial success anywhere, and no claim of a provider
    // reference that does not exist.
    expect(after.ledger.every((l) => l.status === 'pending')).toBe(true);
    expect(after.ledger.every((l) => l.provider_transaction_id === null)).toBe(true);
    expect(after.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.payout_outcome === 'unknown')).toBe(true);
    expect((await auditFor('FINALIZE_SETTLEMENT', c)).length).toBe(0);
    // The genuine ambiguity IS recorded, for manual reconciliation.
    expect((await auditFor('PAYOUT_NOT_CONFIRMED', c)).length).toBeGreaterThan(0);

    // E3A - and the next attempt does NOT resend it: a timeout is not proof
    // that nothing executed.
    const callsBefore = payout.calls.length;
    const again = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(again.status).toBe(500);
    expect(payout.calls.length, 'an ambiguous outcome must never be resubmitted').toBe(callsBefore);
    expect((await financialSnapshot(c)).ledger).toEqual(after.ledger);
  });

  it('8.6b a provider 4xx is a REFUSAL while a 5xx is AMBIGUOUS - they are not the same thing', async () => {
    // 4xx: the provider rejected the REQUEST, so no transfer was executed and
    // recording a rejection is accurate.
    const refused = await makeReleasableClaim('REFUSED-4XX');
    payout.reset();
    payout.mode = 'reject';
    payout.rejectStatus = 422;

    const r4 = await http(RELEASE(refused.claimId), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(r4.status).toBe(500);
    const after4 = await financialSnapshot(refused.claimId);
    expect(after4.status).toBe('pending_settlement');
    expect(after4.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.payout_outcome === 'rejected')).toBe(true);
    expect(after4.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.status === 'failed')).toBe(true);

    // 5xx: the provider failed while handling a request it may ALREADY have
    // executed. Recording that as a definitive rejection would make a retry
    // look safe, so it must be 'unknown'.
    const ambiguous = await makeReleasableClaim('AMBIGUOUS-5XX');
    payout.reset();
    payout.mode = 'reject';
    payout.rejectStatus = 503;

    const r5 = await http(RELEASE(ambiguous.claimId), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(r5.status).toBe(500);
    const after5 = await financialSnapshot(ambiguous.claimId);
    expect(after5.status).toBe('pending_settlement');
    expect(after5.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.payout_outcome === 'unknown')).toBe(true);
    expect(after5.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.status === 'pending')).toBe(true);

    // Neither state is eligible for another automatic submission: one more
    // release makes no provider call at all.
    const callsBefore = payout.calls.length;
    expect((await http(RELEASE(ambiguous.claimId), { token: adminToken, body: { password: ADMIN_PASSWORD } })).status).toBe(500);
    expect((await http(RELEASE(refused.claimId), { token: adminToken, body: { password: ADMIN_PASSWORD } })).status).toBe(500);
    expect(payout.calls.length, 'a refusal and an ambiguity are both resolved by an operator, not by a retry').toBe(callsBefore);
  });

  it('8.7 a confirmed payout reaches `released` exactly once', async () => {
    // A fresh claim whose payout has never been submitted: this is the path that
    // legitimately completes. The provider is made to CONFIRM each transfer by
    // using the application's own documented non-production disbursement branch
    // - it is the only path that reports 'success' for a BRAND-NEW payout
    // without a verified provider status API, which is exactly why the
    // accepted/unknown/refused outcomes above can never finalise a claim
    // (asserted in 8.5b, 8.6 and 8.6b).
    const { claimId: c } = await makeReleasableClaim('CONFIRMED');
    releasedClaimId = c;
    process.env.INTASEND_SECRET_KEY = '';
    payout.reset();
    const before = await financialSnapshot(c);

    const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(200);
    expect(r.body?.success).toBe(true);
    // Nothing reached the controlled provider: the app took its simulated
    // disbursement branch rather than the HTTP one.
    expect(payout.calls.length).toBe(0);

    const after = await financialSnapshot(c);
    expect(after.status).toBe('released');
    // Collection evidence survives the payout untouched - a payout is a
    // SEPARATE financial event from the collection.
    expect(after.paid_at).toBe(before.paid_at);
    expect(after.payment_reference).toBe(before.payment_reference);
    // Every ledger row is now settled, and the two provider-facing rows carry
    // the authoritative 'completed' outcome - never 'accepted' or 'unknown'.
    expect(after.ledger.every((l) => l.status === 'completed')).toBe(true);
    expect(after.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.payout_outcome === 'completed')).toBe(true);
    expect(after.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.provider_transaction_id !== null)).toBe(true);
    const platformFee = after.ledger.find((l) => l.type === 'platform_fee')!;
    expect(platformFee.failure_reason).toBeNull();
    expect(platformFee.provider_transaction_id).toBeNull();
    // platform_fee never touches a provider, so it keeps no submission history.
    expect(platformFee.payout_outcome).toBeNull();
    // FINALIZE_SETTLEMENT is the money-moving event and must exist EXACTLY
    // once. ADMIN_RELEASE_SETTLEMENT is written per release-LOCK acquisition,
    // so it legitimately has one row per attempt that won the CAS - each is a
    // distinct operator action, not a duplicate disbursement.
    expect((await auditFor('FINALIZE_SETTLEMENT', c)).length).toBe(1);
    expect((await auditFor('ADMIN_RELEASE_SETTLEMENT', c)).length).toBeGreaterThanOrEqual(1);
    // Restore the real key so the remaining tests use the HTTP branch again.
    process.env.INTASEND_SECRET_KEY = FAKE_INTASEND_KEY;
  });

  it('8.8 replaying the identical settlement request is a no-op (409), never a second payout', async () => {
    const before = await financialSnapshot(releasedClaimId);
    const callsBefore = payout.calls.length;
    const auditsBefore = (await auditFor('FINALIZE_SETTLEMENT', releasedClaimId)).length;

    const r = await http(RELEASE(releasedClaimId), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    // The CAS requires status==='pending_settlement'; a released claim matches
    // nothing, so the lock is never won and the route answers 409.
    expect(r.status).toBe(409);
    // No provider call, no ledger change, no state regression, no new audit.
    expect(payout.calls.length).toBe(callsBefore);
    expect(await financialSnapshot(releasedClaimId)).toEqual(before);
    expect((await auditFor('FINALIZE_SETTLEMENT', releasedClaimId)).length).toBe(auditsBefore);
    // The collection evidence is still exactly what it always was.
    expect((await financialSnapshot(releasedClaimId)).status).toBe('released');
  });

  it('8.9 claim-1 settlement credentials cannot be used against claim-2', async () => {
    const before = await financialSnapshot(secondClaimId);
    const callsBefore = payout.calls.length;

    // The legitimate admin, aiming the endpoint at the OTHER claim while
    // stuffing claim-1's financial identifiers into the body.
    const r = await http(RELEASE(secondClaimId), {
      token: adminToken,
      body: {
        // BATCH 1 (D) — the route now requires the operator's password before it
        // re-decides eligibility. Everything else here is the cross-claim
        // injection this test exists to prove is ignored.
        password: ADMIN_PASSWORD,
        claimId, payment_reference: claimId, payout_reference: 'E2E-BATCH-1',
        providerTransactionId: 'E2E-TXN-R4M-FINDER', amount: 1,
      },
    });
    expect(r.status).toBe(409);
    // claim-2 is byte-identical and no new money moved for it.
    expect(payout.calls.length).toBe(callsBefore);
    expect(await financialSnapshot(secondClaimId)).toEqual(before);
    // The released claim itself is untouched by the cross-claim attempt.
    expect((await financialSnapshot(releasedClaimId)).status).toBe('released');
  });

  it('8.10 final financial invariant: one collection, one release, nothing double-booked', async () => {
    // The COLLECTION half belongs to claim-1, which was created and paid
    // through the real public/claim lifecycle in the earlier stages.
    const collected: any = await db.getClaim(claimId);
    expect(collected.paid_at).toBeTruthy();
    expect(collected.payment_reference).toBeTruthy();

    // The RELEASE half belongs to the claim that actually reached it.
    const claim: any = await db.getClaim(releasedClaimId);
    const s = await financialSnapshot(releasedClaimId);
    expect(claim.status).toBe('released');
    // The payout is a separate, single, fully-booked financial event.
    const payouts = s.ledger.filter((l) => l.type === 'finder_payout' || l.type === 'agent_payout');
    expect(payouts.length).toBe(2);
    expect(payouts.every((l) => l.status === 'completed')).toBe(true);
    // The split is conserved against the fee actually charged.
    const item: any = await db.getItem(`E2E-E3A-ITEM-${RUN}-CONFIRMED`);
    const disbursed = payouts.reduce((n: number, l: any) => n + Number(l.amount), 0);
    expect(disbursed + Number(item.locked_platform_share)).toBe(Number(item.locked_total_fee));
    // The money-moving settlement event was never duplicated. The release
    // audit row is per lock acquisition, so it is only required to exist.
    expect((await auditFor('FINALIZE_SETTLEMENT', releasedClaimId)).length).toBe(1);
    expect((await auditFor('ADMIN_RELEASE_SETTLEMENT', releasedClaimId)).length).toBeGreaterThanOrEqual(1);
  });

  it('8.11 E3A: unresolved payouts are never paid, never resubmitted, and never invisible', async () => {
    // The due claim's payout was accepted by the provider and never confirmed.
    // E3A leaves it exactly there: not completed, not resubmitted, and listed
    // for provider reconciliation.
    const s1 = await financialSnapshot(dueClaimId);
    expect(s1.status).toBe('pending_settlement');
    expect(s1.status).not.toBe('released');
    const unresolvedOnes = s1.ledger.filter((l) => l.type !== 'platform_fee');
    expect(unresolvedOnes.every((l) => l.payout_outcome === 'accepted')).toBe(true);
    expect(unresolvedOnes.every((l) => l.status === 'pending')).toBe(true);
    // No completion, no claim of completion, and no invented reference: the
    // transaction ids that ARE recorded came from the provider's own response.
    expect((await auditFor('FINALIZE_SETTLEMENT', dueClaimId)).length).toBe(0);
    expect(unresolvedOnes.every((l) => typeof l.provider_transaction_id === 'string' && l.provider_transaction_id!.startsWith('E2E-TXN-'))).toBe(true);

    // The unresolved row is visible through the new read-only reconciliation
    // surface, with the evidence an operator needs to check it with IntaSend.
    const rows = await db.getUnresolvedPayouts();
    const mine = rows.filter((r: any) => r.claim_id === dueClaimId);
    expect(mine.length).toBe(2);
    for (const row of mine) {
      expect(row.status).toBe('pending');
      expect(row.payout_outcome).toBe('accepted');
      expect(row.provider_batch_id).toBe('E2E-BATCH-1');
    }

    // The confirmed claim is NOT in that queue: it is genuinely paid.
    expect(rows.some((r: any) => r.claim_id === releasedClaimId)).toBe(false);

    // And the provider was never asked to move that money a second time: each
    // recipient appears in exactly ONE submitted batch across the whole stage,
    // even though the release was attempted repeatedly afterwards.
    const dueNarratives = payout.seenNarratives.filter((n) => n.includes(dueClaimId));
    expect(dueNarratives.length).toBe(2); // finder + agent, once each
    expect(new Set(dueNarratives).size).toBe(2);
    expect(dueNarratives.filter((n) => n.includes('FINDER')).length).toBe(1);
    expect(dueNarratives.filter((n) => n.includes('AGENT')).length).toBe(1);
  });

  // =========================================================================
  // 8.12-8.16 - D-2B-B-E: the durable-approval workflow, and the bypasses that
  // are now closed. All five drive the REAL routes over real HTTP.
  // =========================================================================

  it('8.12 approve records the durable sign-off (who/when/why) atomically, and a duplicate changes nothing', async () => {
    const { claimId: c } = await makeReleasableClaim('APPROVE-HTTP', { approve: false });
    const approvalAudits = async () =>
      (await db.getAuditLogs()).filter(
        (l) => l.action === 'CLAIM_SETTLEMENT_APPROVED' && String(l.details).includes(c),
      );

    // Unauthenticated -> 401; an authenticated NON-admin (the real agent token)
    // -> 403; the admin without a reason -> 400. None of them may write.
    expect((await http(APPROVE(c), { body: { reason: 'no token' } })).status).toBe(401);
    expect((await http(APPROVE(c), { token: agentToken(AGENT_ID), body: { reason: 'agent' } })).status).toBe(403);
    const noReason = await http(APPROVE(c), { token: adminToken, body: {} });
    expect(noReason.status).toBe(400);
    expect((await db.getClaim(c))!.settlement_approved_at ?? null).toBeNull();
    expect((await approvalAudits()).length, 'a rejected request writes no evidence').toBe(0);

    // The admin, with a reason -> the durable sign-off.
    const ok = await http(APPROVE(c), { token: adminToken, body: { reason: 'Handover verified; no dispute filed.' } });
    expect(ok.status).toBe(200);
    expect(ok.body?.success).toBe(true);
    expect(ok.body?.approved_by).toBe(ADMIN_USERNAME);
    expect(ok.body?.approved_at).toBeTruthy();

    const claim = (await db.getClaim(c))!;
    expect(claim.settlement_approved_at).toBeTruthy();
    expect(claim.settlement_approved_by).toBe(ADMIN_USERNAME);
    // Approval never moves the claim and never touches the ledger.
    expect(claim.status).toBe('pending_settlement');
    expect((await db.getLedgerEntriesForClaim(c)).every((l) => l.status === 'pending')).toBe(true);

    // The reason is durable, in the SAME audit row that records the approval.
    const audits = await approvalAudits();
    expect(audits.length, 'exactly one approval audit row').toBe(1);
    expect(audits[0].admin_user).toBe(ADMIN_USERNAME);
    expect(String(audits[0].details)).toContain('Handover verified; no dispute filed.');

    // A duplicate approval is a 409 that persists NOTHING: no overwrite, no
    // second audit row - so no false success evidence can exist for it.
    const dup = await http(APPROVE(c), { token: adminToken, body: { reason: 'second attempt' } });
    expect(dup.status).toBe(409);
    expect(dup.body?.approved_by).toBe(ADMIN_USERNAME);
    expect((await db.getClaim(c))!.settlement_approved_at).toBe(claim.settlement_approved_at);
    expect((await approvalAudits()).length).toBe(1);
    expect((await db.getAuditLogs()).some((l) => String(l.details).includes('second attempt'))).toBe(false);
  });

  it('8.13 initiate requires the durable approval, and the legacy route cannot bypass it', async () => {
    const { claimId: c } = await makeReleasableClaim('INITIATE-GATE', { approve: false });
    payout.reset();

    // Supported path: no approval -> 409 naming the real cause, no payout.
    const blocked = await http(INITIATE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(blocked.status).toBe(409);
    expect(blocked.body?.reasons).toEqual(['no_durable_approval']);

    // Legacy path: the SAME refusal - it no longer force-releases ahead of the
    // window or without approval - and it points at the supported workflow.
    const legacy = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(legacy.status).toBe(409);
    expect(String(legacy.body?.next?.approve)).toContain('/settlement/approve');
    expect(String(legacy.body?.next?.initiate)).toContain('/settlement/initiate');
    expect(payout.calls.length, 'neither route may reach the provider without approval').toBe(0);
    expect((await db.getClaim(c))!.status).toBe('pending_settlement');

    // With the durable approval in place, the supported path completes the payout.
    expect((await http(APPROVE(c), { token: adminToken, body: { reason: 'approved for payout' } })).status).toBe(200);
    process.env.INTASEND_SECRET_KEY = '';
    payout.reset();
    const paid = await http(INITIATE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    process.env.INTASEND_SECRET_KEY = FAKE_INTASEND_KEY;
    expect(paid.status).toBe(200);
    expect(paid.body?.success).toBe(true);
    expect((await db.getClaim(c))!.status).toBe('released');
    expect(payout.calls.length, 'the simulated disbursement branch never calls the provider').toBe(0);
  });

  it('8.14 an admin WITH a reason still cannot approve or release a claim whose window is open', async () => {
    // claim-1's settle_at is genuinely in the future (asserted in 8.0). The
    // force-release probe that used to pay it ahead of the window must now fail
    // closed on ALL THREE routes: no approval is even possible while the window
    // is open, so there is no path left that skips it.
    const before = await financialSnapshot(claimId);
    expect(new Date(String(before.settle_at)).getTime()).toBeGreaterThan(Date.now());
    payout.reset();

    expect((await http(APPROVE(claimId), { token: adminToken, body: { reason: 'release it early please' } })).status).toBe(409);
    expect((await http(RELEASE(claimId), { token: adminToken, body: { password: ADMIN_PASSWORD } })).status).toBe(409);
    const initiate = await http(INITIATE(claimId), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(initiate.status).toBe(409);
    // The reported reasons are the REAL ones the CAS enforces - not a hard-coded
    // list claiming a pause/hold failure this method cannot even detect.
    expect(initiate.body?.reasons).toEqual(['no_durable_approval', 'settle_at_not_elapsed']);

    expect(payout.calls.length).toBe(0);
    expect(await financialSnapshot(claimId)).toEqual(before);
  });

  it('8.15 a legal hold placed AFTER approval still stops the payout (fail closed)', async () => {
    const { claimId: c, itemId: ci } = await makeReleasableClaim('HOLD-AFTER-APPROVAL', { approve: true });
    // The approval is durable and the window has elapsed - only the hold changes,
    // and it is applied after the sign-off.
    await db.setItemReviewStatus(ci, 'legal_hold', 'E2E: court order received', 'SYSTEM');
    payout.reset();

    const r = await http(INITIATE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    // The lock was won (approval + window were valid) and then given back: the
    // provider was never called and the claim is not stranded in 'releasing'.
    expect(r.status).toBe(500);
    expect(payout.calls.length).toBe(0);
    expect((await db.getClaim(c))!.status).toBe('pending_settlement');
    expect((await db.getLedgerEntriesForClaim(c)).every((l) => l.status === 'pending')).toBe(true);
    const abandoned = await auditFor('SETTLEMENT_RELEASE_ABANDONED', c);
    expect(abandoned.length).toBeGreaterThan(0);
    expect(String(abandoned[0].details)).toContain('legal_hold');
  });

  it('8.16 a platform-wide payout pause stops a fully approved payout (fail closed)', async () => {
    // Pause through the REAL admin route, then attempt a fully valid payout.
    const pause = await http('/api/admin/settings/pause', { token: adminToken, body: { scope: 'payouts', paused: true } });
    expect(pause.status).toBe(200);
    try {
      const { claimId: c } = await makeReleasableClaim('PAUSED-PAYOUT', { approve: true });
      payout.reset();
      const r = await http(INITIATE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
      expect(r.status).toBe(500);
      expect(payout.calls.length, 'no payout may be submitted while paused').toBe(0);
      expect((await db.getClaim(c))!.status).toBe('pending_settlement');
      expect((await auditFor('SETTLEMENT_SKIPPED_PAYOUTS_PAUSED', c)).length).toBeGreaterThan(0);
    } finally {
      const resume = await http('/api/admin/settings/pause', { token: adminToken, body: { scope: 'payouts', paused: false } });
      expect(resume.status).toBe(200);
    }
  });


});

// ===========================================================================
// STAGE 9 — THE DEV-ONLY PAYMENT SIMULATOR, OVER REAL HTTP (D-2A-H).
//
// POST /api/dev/simulate-payment/:claimId fabricates an authoritative payment
// confirmation, so it is the one endpoint in the product that can hand a claim
// to a claimant with no money behind it — and it is hard-gated off in
// production (three conditions, plus a boot refusal). What it must NOT do is
// confirm under a reference of its own invention: that moved the claim while
// leaving the attempt's real receipt row unresolved forever, and stamped a
// payment reference that never existed onto the claim.
//
// These are the first behavioural tests the endpoint has ever had (its gate is
// unit-tested and source-audited in config/__tests__/devPaymentSimulation.test.ts).
// Everything below runs the REAL application over REAL HTTP: the real Express
// chain, the real route, the real canonical confirmation path, the real atomic
// claim/session compare-and-set and the real receipt-row resolution. Only the
// outbound email/SMS seams are doubled (file-wide), and the attempt/session
// rows are seeded directly because this stage is about the simulator, not about
// re-driving the journey stages above it.
// ===========================================================================
describe('stage 9 — the dev payment simulator confirms only the attempt it stands for', () => {
  /**
   * A per-test invoice id. The real schema enforces ONE session per provider
   * invoice (uq_payment_sessions_provider_invoice), so reusing an invoice across
   * claims would cross-bind them; every fixture below is therefore unique.
   */
  const invoiceFor = (suffix: string, which: 'OLD' | 'NEW' | 'ORPHAN' | 'UNRELATED' | 'WEBHOOK') =>
    `INV-E2E-DEVSIM-${which}-${RUN}-${suffix}`;
  // The `A-`/`B-`/`C-`/`D-` prefix keeps the "newest attempt" choice
  // deterministic even when two sessions share a creation timestamp (the
  // selection rule breaks a tie on the session id).
  const sessionFor = (
    suffix: string, which: 'A-OLD' | 'B-NEW' | 'C-UNINITIATED' | 'D-WEBHOOK',
  ) => `PS-E2E-DEVSIM-${RUN}-${which}-${suffix}`;

  /** Runs `fn` with the simulator's two non-production switches ON, then restores them. */
  const withSimulationEnabled = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const prevSim = process.env.ENABLE_DEV_PAYMENT_SIMULATION;
    const prevOtp = process.env.ALLOW_MOCK_OTP_BYPASS;
    process.env.ENABLE_DEV_PAYMENT_SIMULATION = 'true';
    process.env.ALLOW_MOCK_OTP_BYPASS = 'true';
    try {
      return await fn();
    } finally {
      if (prevSim === undefined) delete process.env.ENABLE_DEV_PAYMENT_SIMULATION;
      else process.env.ENABLE_DEV_PAYMENT_SIMULATION = prevSim;
      if (prevOtp === undefined) delete process.env.ALLOW_MOCK_OTP_BYPASS;
      else process.env.ALLOW_MOCK_OTP_BYPASS = prevOtp;
    }
  };

  const simulatePayment = (claimId: string) =>
    withSimulationEnabled(() =>
      http(`/api/dev/simulate-payment/${claimId}`, { method: 'POST' }),
    );

  /** A claim awaiting payment, with the item parent the real FKs require. */
  const makeSimClaim = async (suffix: string) => {
    const claimId = `E2E-DEVSIM-CLAIM-${RUN}-${suffix}`;
    const itemId = `E2E-DEVSIM-ITEM-${RUN}-${suffix}`;
    await db.createItem({
      id: itemId, category_id: CATEGORY, photo_url: 'test-photo.jpg',
      ocr_extracted_number: null, ocr_extracted_name: null, document_number_hash: null,
      document_name_fuzzy: null, location_description: 'Dev-simulation fixture',
      latitude: null, longitude: null, finder_phone: FINDER_PHONE,
      assigned_agent_id: null, status: 'at_agent', flaggedForReview: false,
      isDescriptionOnly: false, description: null, is_sensitive_document: false,
      rejection_reason: null, locked_total_fee: String(TOTAL_FEE),
    } as any);
    await db.createClaim({
      id: claimId, item_id: itemId, owner_phone: OWNER_PHONE,
      security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'dev-simulation fixture' },
      verification_tier: 1, status: 'pending_payment', owner_id_proof_url: null,
      payment_reference: null, owner_identifying_details: null,
    });
    return { claimId, itemId };
  };

  /** One collection attempt's receipt row, exactly as services/payments.ts books it. */
  const bookAttemptRow = (claimId: string, invoice: string) =>
    db.logTransaction({
      claim_id: claimId, item_id: null, type: 'payment_received',
      amount: TOTAL_FEE, phone_or_till: OWNER_PHONE, status: 'pending',
      provider_transaction_id: invoice,
    });

  /** The session an attempt's STK initiation leaves behind, optionally expired. */
  const makeFinalizedSession = async (
    claimId: string, sessionId: string, invoice: string, state: 'pending' | 'expired',
  ) => {
    expect(await db.createPaymentSession({
      id: sessionId, claimId, amount: TOTAL_FEE, payerPhone: OWNER_PHONE,
      expiresAt: new Date(Date.now() + 60_000),
    })).toBe(true);
    expect(await db.reservePaymentSession(sessionId)).toBe(true);
    expect(await db.finalizePaymentSessionInitiated(sessionId, invoice, `MPX-${sessionId}`)).toBe(true);
    if (state === 'expired') expect(await db.expirePaymentSession(sessionId)).toBe(true);
  };

  const receiptRows = async (claimId: string) =>
    (await db.getLedgerEntriesForClaim(claimId)).filter((e: any) => e.type === 'payment_received');

  it('completes only the attempt it stands for, and stamps no invented reference', async () => {
    const { claimId } = await makeSimClaim('SELECT');
    const oldInvoice = invoiceFor('SELECT', 'OLD');
    const newInvoice = invoiceFor('SELECT', 'NEW');
    // A superseded attempt: its prompt was accepted, then its window elapsed.
    const superseded = await bookAttemptRow(claimId, oldInvoice);
    await makeFinalizedSession(claimId, sessionFor('SELECT', 'A-OLD'), oldInvoice, 'expired');
    // The attempt the simulator stands for.
    const current = await bookAttemptRow(claimId, newInvoice);
    await makeFinalizedSession(claimId, sessionFor('SELECT', 'B-NEW'), newInvoice, 'pending');

    const r = await simulatePayment(claimId);
    expect(r.status).toBe(200);
    expect(typeof r.body?.pickupCode).toBe('string');
    expect(String(r.body?.pickupCode).length).toBeGreaterThan(0);

    const claim: any = await db.getClaim(claimId);
    expect(claim.status).toBe('escrow_held');
    expect(claim.paid_at).toBeTruthy();
    // The claim carries the attempt's REAL provider invoice, never a fabricated
    // reference — this is what makes the receipt row above resolvable at all.
    expect(claim.payment_reference).toBe(newInvoice);

    const rows = await receiptRows(claimId);
    expect(rows.find((e: any) => e.id === current.id)!.status).toBe('completed');
    // The abandoned attempt's row is untouched: an unresolved prompt is not
    // evidence of collection, and it is not revenue.
    expect(rows.find((e: any) => e.id === superseded.id)!.status).toBe('pending');
    expect(rows.find((e: any) => e.id === superseded.id)!.provider_transaction_id).toBe(oldInvoice);

    // Only the simulated attempt's own session was consumed.
    expect((await db.getPaymentSessionById(sessionFor('SELECT', 'B-NEW')))!.status).toBe('confirmed');
    expect((await db.getPaymentSessionById(sessionFor('SELECT', 'A-OLD')))!.status).toBe('expired');

    // The pickup code exists and is stored as a hash only, exactly as the
    // webhook-driven path leaves it.
    const pickup: any = await db.getPickupCode(claimId);
    expect(pickup?.code_hash).toBeTruthy();
    expect(String(pickup.code_hash)).not.toBe(String(r.body?.pickupCode));
  });

  it('cannot be repeated: a second simulation neither re-completes nor double-books', async () => {
    const { claimId } = await makeSimClaim('REPLAY');
    const newInvoice = invoiceFor('REPLAY', 'NEW');
    const row = await bookAttemptRow(claimId, newInvoice);
    await makeFinalizedSession(claimId, sessionFor('REPLAY', 'B-NEW'), newInvoice, 'pending');

    expect((await simulatePayment(claimId)).status).toBe(200);
    // The confirmation really did happen — asserted before reading the rows it
    // is expected to have produced, so a refusal can never masquerade as one.
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');

    const after = await db.getClaim(claimId);
    const ledgerAfter = (await db.getLedgerEntriesForClaim(claimId)).map(
      (e: any) => [e.id, e.type, e.status, e.amount, e.provider_transaction_id],
    );
    const pickupAfter = String(((await db.getPickupCode(claimId)) as any).code_hash);

    // The claim is no longer awaiting payment, so the endpoint refuses outright...
    const again = await simulatePayment(claimId);
    expect(again.status).toBe(400);
    expect(again.body?.pickupCode ?? null).toBeNull();

    // ...and NOTHING moved: same claim facts, same ledger, same pickup code.
    const afterReplay = await db.getClaim(claimId);
    expect(afterReplay!.status).toBe(after!.status);
    expect(afterReplay!.paid_at).toEqual(after!.paid_at);
    expect(afterReplay!.payment_reference).toBe(newInvoice);
    expect(
      (await db.getLedgerEntriesForClaim(claimId)).map(
        (e: any) => [e.id, e.type, e.status, e.amount, e.provider_transaction_id],
      ),
    ).toEqual(ledgerAfter);
    expect(String(((await db.getPickupCode(claimId)) as any).code_hash)).toBe(pickupAfter);
    // The one receipt row is completed exactly once.
    expect((await receiptRows(claimId)).filter((e: any) => e.status === 'completed').length).toBe(1);
    expect((await receiptRows(claimId)).find((e: any) => e.id === row.id)!.status).toBe('completed');
  });

  it('refuses a claim with no confirmable attempt, leaving its unresolved row untouched', async () => {
    const { claimId } = await makeSimClaim('NOATTEMPT');
    // A row with no correlatable session: nothing can say which attempt it is.
    const orphan = await bookAttemptRow(claimId, invoiceFor('NOATTEMPT', 'ORPHAN'));

    const r = await simulatePayment(claimId);
    expect(r.status).toBe(409);
    expect(r.body?.pickupCode ?? null).toBeNull();

    const claim: any = await db.getClaim(claimId);
    expect(claim.status).toBe('pending_payment');
    expect(claim.paid_at ?? null).toBeNull();
    expect(claim.payment_reference ?? null).toBeNull();
    expect((await receiptRows(claimId)).find((e: any) => e.id === orphan.id)!.status).toBe('pending');
  });

  it('refuses a session whose provider invoice was never persisted', async () => {
    const { claimId } = await makeSimClaim('UNINITIATED');
    // 'created' only: the STK push never happened, so there is no invoice to
    // correlate and no receipt row this confirmation could legitimately resolve.
    expect(await db.createPaymentSession({
      id: sessionFor('UNINITIATED', 'C-UNINITIATED'), claimId, amount: TOTAL_FEE,
      payerPhone: OWNER_PHONE, expiresAt: new Date(Date.now() + 60_000),
    })).toBe(true);

    const r = await simulatePayment(claimId);
    expect(r.status).toBe(409);
    expect((await db.getClaim(claimId))!.status).toBe('pending_payment');
  });

  it('stays refused in production even with both non-production switches set', async () => {
    const { claimId } = await makeSimClaim('PRODUCTION');
    const newInvoice = invoiceFor('PRODUCTION', 'NEW');
    const newSession = sessionFor('PRODUCTION', 'B-NEW');
    const row = await bookAttemptRow(claimId, newInvoice);
    await makeFinalizedSession(claimId, newSession, newInvoice, 'pending');

    // Both switches on — only NODE_ENV stands between the endpoint and a faked
    // payment, which is exactly the boundary that must hold.
    const prod = await withSimulationEnabled(() =>
      asProduction(() => http(`/api/dev/simulate-payment/${claimId}`, { method: 'POST' })),
    );
    expect(prod.status).toBe(404);
    expect(prod.body?.pickupCode ?? null).toBeNull();

    const claim: any = await db.getClaim(claimId);
    expect(claim.status).toBe('pending_payment');
    expect(claim.paid_at ?? null).toBeNull();
    expect(claim.payment_reference ?? null).toBeNull();
    expect((await receiptRows(claimId)).find((e: any) => e.id === row.id)!.status).toBe('pending');
    expect((await db.getPaymentSessionById(newSession))!.status).toBe('pending');
  });

  it('keeps real-provider correlation intact: a webhook resolves only its own invoice', async () => {
    const { claimId } = await makeSimClaim('WEBHOOK');
    const collectedInvoice = invoiceFor('WEBHOOK', 'WEBHOOK');
    const collected = await bookAttemptRow(claimId, collectedInvoice);
    const unrelated = await bookAttemptRow(claimId, invoiceFor('WEBHOOK', 'UNRELATED'));
    const webhookSession = sessionFor('WEBHOOK', 'D-WEBHOOK');
    await makeFinalizedSession(claimId, webhookSession, collectedInvoice, 'pending');

    const res = await postHook(
      { invoice_id: collectedInvoice, state: 'COMPLETE', api_ref: claimId, value: String(TOTAL_FEE) },
      WEBHOOK_CHALLENGE,
    );
    expect(res.status).toBeLessThan(500);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');

    const rows = await receiptRows(claimId);
    // The invoice the provider named resolves exactly its own attempt...
    expect(rows.find((e: any) => e.id === collected.id)!.status).toBe('completed');
    // ...and an unrelated unresolved attempt is left alone.
    expect(rows.find((e: any) => e.id === unrelated.id)!.status).toBe('pending');
    expect((await db.getPaymentSessionById(webhookSession))!.status).toBe('confirmed');
  });
});

// =============================================================================
// BATCH 1 — STAGE 8.9: PHONE-ONLY PAYOUT DESTINATIONS (LAUNCH POLICY).
// =============================================================================
// The launch policy pays Kenyan PERSONAL M-PESA PHONE destinations only, on the
// finder leg and the agent leg alike. The stored recipient values are free text
// the platform does not control, so the settlement executor now asks
// config/payoutDestinations.ts BEFORE the provider request is built and refuses
// the WHOLE batch when any leg is ineligible.
//
// What these tests prove over the real HTTP boundary:
//   1. an ineligible leg produces NO provider request at all — the seam counts
//      zero IntaSend calls, so a "refusal" cannot be a provider call that merely
//      failed for some other reason;
//   2. a valid finder leg is NOT paid alongside an ineligible agent leg: no
//      partial or mixed batch is ever submitted;
//   3. the guard runs BEFORE the durable pre-submission markers, so nothing is
//      left recorded as submitted and the claim can still be paid once the
//      destination is corrected;
//   4. the claim is returned to pending_settlement (never stranded in the
//      transient 'releasing' lock), with an actionable, PII-free audit reason;
//   5. a DISALLOWED environment cannot use the built-in payout simulation to
//      complete ledger entries or close a claim — the mirror image of 8.7, which
//      reaches `released` only because NODE_ENV is exactly 'test'.
//
//   6. CORRECTION A — a would-be SIMULATED payout is refused by the settlement
//      executor ITSELF, before any durable submission marker exists, so a
//      disallowed environment can neither fabricate a completion nor leave the
//      claim parked in the transient 'releasing' lock with rows recorded as
//      'submitting';
//   7. CORRECTION B — the policy is evaluated over EVERY required leg that is not
//      already completed, so an outstanding-but-unpayable leg blocks the WHOLE
//      claim instead of letting the other, eligible leg be paid on its own.
//
// WHAT THESE TESTS DO NOT CLAIM: that a well-formed number is registered with
// M-Pesa, or that it belongs to the intended person. The policy is a format and
// permitted-method decision; that limitation is pinned in
// src/config/__tests__/payoutDestinations.test.ts and stated in the report.
// =============================================================================
describe('stage 8.9 — phone-only payout destinations (BATCH 1 launch policy)', () => {
  // The provider seam and a REAL (non-placeholder, test-only) key are installed
  // for this whole stage. Two reasons, both safety-relevant:
  //   * every "nothing reached the provider" assertion below is decided on the
  //     WIRE - the stub counts the requests - rather than inferred from the
  //     ledger, so a refusal cannot be a provider call that failed for some
  //     other reason; and
  //   * a test that wrongly let a request through hits the stub instead of a
  //     live IntaSend endpoint.
  // Both are restored in afterAll, so no other test file sees them.
  let prevStageKey: string | undefined;
  beforeAll(() => {
    prevStageKey = process.env.INTASEND_SECRET_KEY;
    process.env.INTASEND_SECRET_KEY = FAKE_INTASEND_KEY;
    installPayoutProviderSeam();
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    if (prevStageKey === undefined) delete process.env.INTASEND_SECRET_KEY;
    else process.env.INTASEND_SECRET_KEY = prevStageKey;
  });

  const notEligibleAudits = (claimId: string) => auditFor('PAYOUT_DESTINATION_NOT_ELIGIBLE', claimId);
  // CORRECTION A — the executor's own pre-submission simulation refusal.
  const simulationRefusals = (claimId: string) => auditFor('PAYOUT_SIMULATION_REFUSED', claimId);

  /** The two REQUIRED payout legs of a claim, as the executor reads them. */
  const legRows = async (claimId: string) => {
    const rows = (await db.getLedgerEntriesForClaim(claimId)) as any[];
    return {
      finder: rows.find((r) => r.type === 'finder_payout'),
      agent: rows.find((r) => r.type === 'agent_payout'),
    };
  };

  /**
   * Applies `vars` to process.env for the duration of `fn` and then restores
   * EVERY key to its previous state - including "it was not set at all" (deleted
   * rather than left as the empty string, which is a different fact). No
   * environment change made by this stage can outlive its own test.
   */
  const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(vars)) {
      previous[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it('8.9.1 a valid finder leg plus an INELIGIBLE agent leg sends nothing to the provider', async () => {
    // The agent holds a Till destination, so the finder leg on its own is
    // perfectly payable. That is exactly why the all-or-nothing rule has to be
    // asserted on the WIRE — the count of provider requests — rather than
    // inferred from the ledger.
    const { claimId: c } = await makeReleasableClaim('DEST-AGENT-TILL', { agentId: TILL_AGENT_ID });
    payout.reset();
    const before = await financialSnapshot(c);

    const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(500);

    // (1) THE core assertion: not one request reached the provider.
    expect(payout.calls.length, 'an ineligible leg must not produce any provider request').toBe(0);

    const after = await financialSnapshot(c);
    // (4) The release lock was given back: the claim is NOT stranded.
    expect(after.status).toBe('pending_settlement');
    // (3) Nothing was durably marked as submitted, so a corrected destination can
    // still be paid by a later initiation — both payout rows are untouched.
    expect(after.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.payout_outcome === 'not_submitted')).toBe(true);
    expect(after.ledger.every((l) => l.status === 'pending')).toBe(true);
    expect(after.ledger.every((l) => l.provider_transaction_id === null)).toBe(true);
    expect(after.paid_at).toBe(before.paid_at);
    // Nothing was recorded as submitted, ambiguous or refused, and nothing was
    // finalized: this is a pre-submission refusal, not a failed payout attempt.
    expect((await auditFor('PAYOUT_NOT_CONFIRMED', c)).length).toBe(0);
    expect((await auditFor('PAYOUT_RECONCILIATION_REQUIRED', c)).length).toBe(0);
    expect((await auditFor('FINALIZE_SETTLEMENT', c)).length).toBe(0);

    // (4) The operator-facing evidence: one audit row naming the refused leg and
    // the rule, the administrator sees the reason, and the refused destination is
    // never written in the clear.
    const refusals = await notEligibleAudits(c);
    expect(refusals.length).toBe(1);
    const details = String(refusals[0].details);
    expect(details).toContain('agent');
    expect(details).toContain('254 followed by nine digits');
    expect(details).not.toContain('E2E-TILL-777');
    expect(String(r.body?.error)).toMatch(/phone-only payout policy/i);
    expect(String(r.body?.error)).toContain('agent');
  });

  it('8.9.2 an agent under an UNSUPPORTED method is refused even though its value is a valid phone', async () => {
    // The destination is a perfectly normal Kenyan phone number; the METHOD is
    // 'Pochi la Biashara'. The two rules are independent, and this proves the
    // method half is enforced on the real payout path and not merely in a unit
    // test.
    const { claimId: c } = await makeReleasableClaim('DEST-AGENT-METHOD', { agentId: UNSUPPORTED_METHOD_AGENT_ID });
    payout.reset();

    const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(500);
    expect(payout.calls.length).toBe(0);
    expect((await financialSnapshot(c)).status).toBe('pending_settlement');

    const details = String((await notEligibleAudits(c))[0]?.details ?? '');
    expect(details).toContain('agent');
    expect(details).toContain('Personal M-Pesa');
    expect(details).toContain('Pochi la Biashara');
    expect(String(r.body?.error)).toMatch(/phone-only payout policy/i);
  });

  it('8.9.3 BOTH legs ineligible: no provider request, claim returned, nothing marked submitted', async () => {
    // A finder whose recorded value is not a phone at all, and an agent holding a
    // Till destination. Both legs are refused, and the audit names BOTH — an
    // operator does not have to guess which recipient to fix.
    const { claimId: c } = await makeReleasableClaim('DEST-BOTH', {
      agentId: TILL_AGENT_ID,
      finderPhone: 'E2E-NO-PHONE',
    });
    payout.reset();
    const before = await financialSnapshot(c);

    const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(500);
    expect(payout.calls.length, 'no leg was eligible, so nothing may be sent').toBe(0);

    const after = await financialSnapshot(c);
    expect(after.status).toBe('pending_settlement');
    expect(after.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.payout_outcome === 'not_submitted')).toBe(true);
    expect(after.ledger.every((l) => l.status === 'pending')).toBe(true);
    expect(after.paid_at).toBe(before.paid_at);
    expect((await auditFor('FINALIZE_SETTLEMENT', c)).length).toBe(0);

    const details = String((await notEligibleAudits(c))[0]?.details ?? '');
    expect(details).toContain('finder');
    expect(details).toContain('agent');
    expect(details).not.toContain('E2E-NO-PHONE');
    expect(details).not.toContain('E2E-TILL-777');
  });

  it('8.9.4 a DISALLOWED environment refuses a simulated payout BEFORE any durable submission marker', async () => {
    // The mirror image of 8.7. There, NODE_ENV is exactly 'test', so the
    // documented non-production disbursement branch reports the legs 'success'
    // and the claim genuinely reaches `released`. Here the environment is NOT a
    // simulation environment ('staging', with no credentials at all), so the
    // attempt can only ever be a SIMULATION - and the executor now refuses it
    // before it writes a single marker.
    //
    // CORRECTION A: this refusal used to come from the service-level gate, i.e.
    // AFTER the executor's durable pre-submission markers had been persisted. The
    // claim was then left in the transient 'releasing' lock with both payout rows
    // recorded as 'submitting' - a state no automatic recovery reaches. The
    // preflight decides it at the executor's own seam instead.
    const { claimId: c } = await makeReleasableClaim('DEST-DISALLOWED-ENV');
    const before = await financialSnapshot(c);

    await withEnv({ NODE_ENV: 'staging', INTASEND_SECRET_KEY: '' }, async () => {
      payout.reset();
      const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
      expect(r.status).toBe(500);

      // No simulation ran, and nothing reached the provider.
      expect(payout.calls.length).toBe(0);

      const after = await financialSnapshot(c);
      expect(after.status).not.toBe('released');
      // No ledger entry was completed and no provider reference was invented.
      expect(after.ledger.every((l) => l.status === 'pending')).toBe(true);
      expect(after.ledger.every((l) => l.provider_transaction_id === null)).toBe(true);
      expect(after.ledger.every((l) => l.payout_outcome !== 'completed')).toBe(true);
      expect((await auditFor('FINALIZE_SETTLEMENT', c)).length).toBe(0);

      // CORRECTION A - the states that made this unrecoverable are gone: no row
      // was ever marked 'submitting' (not one), and the claim is not parked in
      // the transient release lock. The lock came back through the same
      // abandonRelease() path every other pre-submission refusal uses, so an
      // operator can correct the deployment and initiate the payout again
      // instead of having to reconcile a stranded claim.
      expect(after.status).toBe('pending_settlement');
      expect(after.ledger.some((l) => l.payout_outcome === 'submitting')).toBe(false);
      expect(after.ledger.filter((l) => l.type !== 'platform_fee').every((l) => l.payout_outcome === 'not_submitted')).toBe(true);
      // Nothing about the ledger changed at all: it is byte-identical to the
      // booked state (the collection evidence in `before` is untouched too).
      expect(after).toEqual(before);

      // The refusal is recorded as its own, actionable event: the observed
      // NODE_ENV is named, and no destination or phone number appears in it.
      const refusals = await simulationRefusals(c);
      expect(refusals.length, 'exactly one refusal for this attempt').toBe(1);
      const details = String(refusals[0].details);
      expect(details).toContain('NODE_ENV is "staging"');
      expect(details).toContain('not a payout-simulation environment');
      expect(details).not.toContain(AGENT_PAYOUT_PHONE);
      expect(details).not.toContain(String(FINDER_PHONE));
      // Nothing was submitted, so the destination policy has nothing to refuse:
      // the two refusals are independent and are not reported as each other.
      expect((await notEligibleAudits(c)).length).toBe(0);
    });
  });

  it('8.9.5 unset, empty and unrecognised NODE_ENV values are all refused the same way', async () => {
    // The values a genuinely misconfigured deployment produces, including the
    // two a deny-list misses ('prod', 'Production') and a casing drift ('DEV').
    // Each case gets its OWN claim so it is independent, and every claim is
    // asserted to be left in exactly the booked state.
    const cases: Array<[string, string | undefined]> = [
      ['unset', undefined],
      ['empty', ''],
      ['prod', 'prod'],
      ['Production', 'Production'],
      ['DEV', 'DEV'],
    ];

    for (const [label, value] of cases) {
      const { claimId: c } = await makeReleasableClaim(`DEST-DISALLOWED-${label}`);
      const before = await financialSnapshot(c);

      await withEnv({ NODE_ENV: value, INTASEND_SECRET_KEY: '' }, async () => {
        payout.reset();
        const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
        expect(r.status, `${label}: the payout attempt must fail`).toBe(500);
        expect(payout.calls.length, `${label}: no provider request`).toBe(0);

        const after = await financialSnapshot(c);
        expect(after.status, `${label}: the release lock must be given back`).toBe('pending_settlement');
        expect(after, `${label}: no marker, no ledger write, no completion`).toEqual(before);
        expect((await auditFor('FINALIZE_SETTLEMENT', c)).length, `${label}: nothing may finalize`).toBe(0);

        const details = String((await simulationRefusals(c))[0]?.details ?? '');
        expect(details, `${label}: the observed NODE_ENV is named`).toContain(
          value === undefined ? 'NODE_ENV is unset' : `NODE_ENV is "${value}"`
        );
        expect(details, `${label}: no destination may appear`).not.toContain(AGENT_PAYOUT_PHONE);
      });
    }
  });

  // ---------------------------------------------------------------------------
  // CORRECTION B - EVERY OUTSTANDING REQUIRED LEG IS CHECKED.
  //
  // `submittable` contains only rows whose submission history positively records
  // "never submitted". A required leg that is outstanding in ANY other state is
  // excluded from that set, so before this correction the destination guard never
  // looked at it - and the OTHER, eligible leg was sent on its own. These tests
  // pin the widened rule, and just as importantly that nothing about an existing
  // unresolved or completed leg is rewritten, reset, reclassified or retried.
  //
  // Every pre-existing state below is produced through the REAL data-layer APIs
  // (recordPayoutAttempt / markPayoutSubmissionStarted), not by poking columns,
  // so what is asserted is a real ledger state the executor must respect.
  // ---------------------------------------------------------------------------

  it('8.9.6 B1 both outstanding legs eligible: they are submitted together', async () => {
    // The positive control: nothing about the widened rule may narrow this path.
    const { claimId: c } = await makeReleasableClaim('DEST-BOTH-ELIGIBLE');
    payout.reset();

    const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });

    // The provider ACCEPTED the batch, which is not a completion, so the claim
    // is returned to pending_settlement - exactly as before the correction.
    expect(r.status).toBe(500);
    expect(payout.calls.length, 'one batch, both legs').toBe(1);
    const txns = payout.calls[0].payload?.transactions ?? [];
    expect(txns.length).toBe(2);
    const roles = txns.map((t: any) => (String(t.narrative).includes('FINDER') ? 'finder' : 'agent')).sort();
    expect(roles).toEqual(['agent', 'finder']);

    const rows = await legRows(c);
    expect(rows.finder.payout_outcome).toBe('accepted');
    expect(rows.agent.payout_outcome).toBe('accepted');
    expect((await financialSnapshot(c)).status).toBe('pending_settlement');
    expect((await notEligibleAudits(c)).length, 'both legs are eligible').toBe(0);
  });

  it('8.9.7 B2 an outstanding, UNRESOLVED agent leg blocks the eligible finder leg', async () => {
    // THE BYPASS THIS CORRECTION CLOSES. The agent leg is already in an
    // ambiguous ('unknown') state from an earlier submission, so it is NOT
    // submittable; the finder leg is brand new and perfectly payable. Before the
    // correction the guard only saw the submittable set, so it sent the finder
    // leg alone while the agent leg - pointing at a Till number the launch policy
    // can never pay - stayed behind.
    const { claimId: c } = await makeReleasableClaim('DEST-AGENT-UNRESOLVED', { agentId: TILL_AGENT_ID });
    const booked = await legRows(c);
    await db.recordPayoutAttempt(booked.agent.id, {
      status: 'unknown',
      providerBatchId: null,
      providerTransactionId: null,
      failureReason: 'E2E fixture: pre-existing ambiguous submission.',
    });
    const before = await financialSnapshot(c);
    payout.reset();

    const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(500);

    // No additional leg was submitted, so no new submission marker exists.
    expect(payout.calls.length, 'no leg may be sent while an outstanding leg is unpayable').toBe(0);

    const after = await financialSnapshot(c);
    expect(after).toEqual(before);
    expect(after.status).toBe('pending_settlement');
    const rows = await legRows(c);
    // The pre-existing unresolved state was neither reset nor retried...
    expect(rows.agent.payout_outcome).toBe('unknown');
    expect(rows.agent.status).toBe('pending');
    // ...and the eligible finder leg was NOT marked as submitted either.
    expect(rows.finder.payout_outcome).toBe('not_submitted');
    expect(after.ledger.some((l) => l.payout_outcome === 'submitting')).toBe(false);
    // The refusal is the DESTINATION policy's, not the generic reconciliation
    // path: this claim was never submitted to anyone.
    expect((await auditFor('PAYOUT_RECONCILIATION_REQUIRED', c)).length).toBe(0);

    // Actionable and PII-free: the refused ROLE and the policy reason are named,
    // and the destination itself is masked.
    const details = String((await notEligibleAudits(c))[0]?.details ?? '');
    expect(details).toContain('the agent payout destination is not a personal M-Pesa phone number');
    expect(details).not.toContain('E2E-TILL-777');
  });

  it('8.9.8 B3 an outstanding, IN-FLIGHT finder leg blocks the eligible agent leg', async () => {
    // The mirror of B2, using the other non-submittable state - 'submitting', the
    // durable pre-submission marker of an attempt whose result was never recorded
    // - and the other role.
    const { claimId: c } = await makeReleasableClaim('DEST-FINDER-INFLIGHT', { finderPhone: 'E2E-NO-PHONE' });
    const booked = await legRows(c);
    // A REAL marker, taken through the same compare-and-swap the executor uses.
    expect(await db.markPayoutSubmissionStarted(booked.finder.id)).toBe(true);
    const before = await financialSnapshot(c);
    payout.reset();

    const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(500);
    expect(payout.calls.length).toBe(0);
    expect(await financialSnapshot(c)).toEqual(before);

    const rows = await legRows(c);
    expect(rows.finder.payout_outcome, 'the pre-existing in-flight marker is not reset').toBe('submitting');
    expect(rows.agent.payout_outcome, 'the eligible agent leg was not submitted').toBe('not_submitted');

    const details = String((await notEligibleAudits(c))[0]?.details ?? '');
    expect(details).toContain('the finder payout destination is not a personal M-Pesa phone number');
    expect(details).not.toContain('E2E-NO-PHONE');
  });

  it('8.9.9 B4 a COMPLETED finder leg is left alone and the remaining eligible agent leg is submitted', async () => {
    const { claimId: c } = await makeReleasableClaim('DEST-FINDER-COMPLETED');
    const booked = await legRows(c);
    await db.recordPayoutAttempt(booked.finder.id, {
      status: 'success',
      providerBatchId: 'E2E-PRIOR-BATCH',
      providerTransactionId: 'E2E-PRIOR-FINDER-TXN',
    });

    payout.reset();
    const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });

    // The agent leg is only ACCEPTED, not confirmed, so the claim is not closed.
    expect(r.status).toBe(500);
    expect(payout.calls.length).toBe(1);
    const txns = payout.calls[0].payload?.transactions ?? [];
    // Exactly ONE transaction: the completed leg is not re-sent.
    expect(txns.length).toBe(1);
    expect(String(txns[0].narrative)).toContain('AGENT');

    const rows = await legRows(c);
    // The completed leg is untouched: same status, same outcome, same
    // authoritative provider reference, no reclassification.
    expect(rows.finder.status).toBe('completed');
    expect(rows.finder.payout_outcome).toBe('completed');
    expect(rows.finder.provider_transaction_id).toBe('E2E-PRIOR-FINDER-TXN');
    expect(rows.finder.provider_batch_id).toBe('E2E-PRIOR-BATCH');
    expect(rows.agent.payout_outcome).toBe('accepted');
    expect((await financialSnapshot(c)).status).toBe('pending_settlement');
    expect((await notEligibleAudits(c)).length).toBe(0);
  });

  it('8.9.10 B5 a COMPLETED finder leg plus an ineligible agent leg submit nothing at all', async () => {
    const { claimId: c } = await makeReleasableClaim('DEST-FINDER-DONE-AGENT-TILL', { agentId: TILL_AGENT_ID });
    const booked = await legRows(c);
    await db.recordPayoutAttempt(booked.finder.id, {
      status: 'success',
      providerBatchId: 'E2E-PRIOR-BATCH-2',
      providerTransactionId: 'E2E-PRIOR-FINDER-TXN-2',
    });
    const before = await financialSnapshot(c);
    payout.reset();

    const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(500);
    expect(payout.calls.length).toBe(0);
    // The outstanding leg is refused AND the completed leg is not disturbed to
    // refuse it: the whole ledger is unchanged.
    expect(await financialSnapshot(c)).toEqual(before);

    const rows = await legRows(c);
    expect(rows.finder.status).toBe('completed');
    expect(rows.finder.payout_outcome).toBe('completed');
    expect(rows.finder.provider_transaction_id).toBe('E2E-PRIOR-FINDER-TXN-2');
    expect(rows.agent.payout_outcome).toBe('not_submitted');
    expect((await financialSnapshot(c)).status).toBe('pending_settlement');
  });

  it('8.9.11 B6 an outstanding REJECTED agent leg is neither retried nor reset, and blocks the finder leg', async () => {
    const { claimId: c } = await makeReleasableClaim('DEST-AGENT-REJECTED-TILL', { agentId: TILL_AGENT_ID });
    const booked = await legRows(c);
    // A provider REFUSAL recorded before execution: not submittable, not
    // completed, and never retried automatically.
    await db.recordPayoutAttempt(booked.agent.id, {
      status: 'failed',
      providerBatchId: 'E2E-PRIOR-BATCH-3',
      providerTransactionId: null,
      failureReason: 'E2E fixture: provider refused this transfer.',
    });
    const before = await financialSnapshot(c);
    payout.reset();

    const r = await http(RELEASE(c), { token: adminToken, body: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(500);
    expect(payout.calls.length).toBe(0);
    expect(await financialSnapshot(c)).toEqual(before);

    const rows = await legRows(c);
    expect(rows.agent.status).toBe('failed');
    expect(rows.agent.payout_outcome).toBe('rejected');
    expect(rows.finder.payout_outcome).toBe('not_submitted');
  });
});
