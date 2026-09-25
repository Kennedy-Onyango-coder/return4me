import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CLAIM_UNAVAILABLE_MESSAGE } from '../config/claimStatuses';
import { toPublicItemView } from '../services/publicItemView';
import { isSafeReturnPath, parsePublicRoute, accountPath } from '../utils/publicRoutes';

// =============================================================================
// PHASE 16.1 BATCH 2A — SECURITY / AUTHENTICATION INTEGRITY
// =============================================================================
// Regression tripwires for the security findings this batch actually fixed, in
// the same source-audit style the rest of this suite uses (there is no jsdom /
// React harness here, and server.ts does not export its Express app separately
// from startServer()'s bootstrap — see claimOtpAbuseGate.test.ts,
// adminRouteAudit.test.ts and claimTrackingDisclosure.test.ts for the same
// rationale).
//
// Every assertion below corresponds to code that CHANGED in this batch, or to a
// previously-unpinned security contract that this batch verified:
//
//   1. The claim-ownership oracle (claim existence + owner-phone confirmation)
//      on the claim-ID-keyed routes that take the owner's registered phone.
//   2. The agent-rating mutation is no longer anonymously reachable.
//   3. The payment-session initiate route proves ownership before reading state.
//   4. A browser token store is never an authorization input on the server.
//   5. The customer session stays an httpOnly cookie, resolved server-side only.
//   6. The post-authentication return path is still a closed, app-owned list.
//   7. The public item projection still publishes nothing private.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const serverTs = read('src/server.ts');
const customerAuthTs = read('src/services/customerAuth.ts');

/** The body of one route handler: its registration through to the next route. */
function routeBody(marker: string): string {
  const start = serverTs.indexOf(marker);
  expect(start, `route not found in server.ts: ${marker}`).toBeGreaterThan(-1);
  const after = serverTs.slice(start);
  const next = after.indexOf('\n  app.', 10);
  return serverTs.slice(start, next > -1 ? start + next : start + 6000);
}

// ---------------------------------------------------------------------------
// 1. THE CLAIM-OWNERSHIP ORACLE IS CLOSED
// ---------------------------------------------------------------------------
// These four routes take the claim's registered owner phone as their ownership
// proof. Each used to answer an UNKNOWN claim with 404 and a WRONG PHONE with
// 403 + different wording, and to run the claim-STATUS gate before the phone
// comparison. On a ~900,000-combination claim-ID space (CLM-100000..CLM-999999)
// that made them an enumeration oracle: an anonymous caller could learn whether
// a guessed claim ID existed, whether a guessed number was its registered owner
// phone, and — for a claim that did exist — which state it was in.
//
// /lookup (Phase 7C.7, R2) and /pickup-details (F4/F9) were already fixed to
// return ONE response for both ownership failures and to consult state only
// after ownership is proven. These routes now follow the same rule.
const PHONE_OWNERSHIP_ROUTES: Array<{ marker: string; stateGate: string }> = [
  { marker: "app.post('/api/claims/:id/request-otp'", stateGate: "claim.status !== 'pending_verification'" },
  { marker: "app.post('/api/claims/:id/payment-auth'", stateGate: "claim.status !== 'pending_payment'" },
  { marker: "app.post('/api/claims/:id/payment-session'", stateGate: "claim.status !== 'pending_payment'" },
  { marker: "app.post('/api/claims/:id/pay'", stateGate: "claim.status !== 'pending_payment'" },
];

describe('the claim-ownership oracle is closed on every phone-ownership claim route', () => {
  for (const { marker, stateGate } of PHONE_OWNERSHIP_ROUTES) {
    describe(marker.replace(/^app\.post\('/, '').replace(/'$/, ''), () => {
      const body = routeBody(marker);

      it('answers an unknown claim and a wrong phone with ONE status and ONE body', () => {
        const unified = body.match(/return res\.status\(404\)\.json\(\{ error: CLAIM_UNAVAILABLE_MESSAGE \}\);/g) || [];
        expect(unified, 'both ownership failures must share this exact response').toHaveLength(2);
        // The old, distinguishable phone-mismatch response is gone.
        expect(body).not.toContain('Nambari ya simu uliyoweka hailingani');
      });

      it('proves ownership BEFORE the claim status is consulted', () => {
        const ownershipIdx = body.indexOf('normalizedInput !== normalizedOwner');
        const stateIdx = body.indexOf(stateGate);
        expect(ownershipIdx, 'phone comparison present').toBeGreaterThan(-1);
        expect(stateIdx, 'state gate present').toBeGreaterThan(-1);
        expect(ownershipIdx).toBeLessThan(stateIdx);
      });

      it('rejects a missing phone BEFORE any database read (no probe via a malformed body)', () => {
        const guardIdx = body.indexOf('if (!phone)');
        const readIdx = body.indexOf('db.getClaim(claimId)');
        expect(guardIdx, 'required-field guard present').toBeGreaterThan(-1);
        expect(readIdx, 'claim read present').toBeGreaterThan(-1);
        expect(guardIdx).toBeLessThan(readIdx);
      });
    });
  }
  it('the shared body is the same wording /lookup and /pickup-details already return', () => {
    // One literal, imported by server.ts — so these routes cannot drift apart
    // again into two subtly different answers.
    expect(CLAIM_UNAVAILABLE_MESSAGE).toBe(
      'Claim haikupatikana au nambari ya simu hailingani. / Claim not found, or the phone number does not match.'
    );
    expect(serverTs).toMatch(
      /import \{[^}]*\bCLAIM_UNAVAILABLE_MESSAGE\b[^}]*\} from '\.\/config\/claimStatuses'/
    );
  });
});



// ---------------------------------------------------------------------------
// 2. THE AGENT-RATING MUTATION IS NO LONGER ANONYMOUS
// ---------------------------------------------------------------------------
// POST /api/claims/:id/rate writes to a real agent hub's public reputation. It
// was reachable by nothing but a guessed claim ID, justified in-code by "owners
// aren't logged in" — a premise Phase 16 removed when it made the Track My Claim
// journey customer-authenticated. It now resolves the SAME session cookie the
// rest of the owner journey does. Every pre-existing gate stays in force.
describe('POST /api/claims/:id/rate resolves the customer session, not just a claim ID', () => {
  const rate = routeBody("app.post('/api/claims/:id/rate'");

  it('mounts requireCustomerAuth ahead of everything else', () => {
    expect(serverTs).toMatch(
      /app\.post\('\/api\/claims\/:id\/rate',\s*requireCustomerAuth,\s*claimGuessLimiter,/
    );
    const markerIdx = serverTs.indexOf("app.post('/api/claims/:id/rate'");
    const line = serverTs.slice(markerIdx, serverTs.indexOf('\n', markerIdx));
    const authIdx = line.indexOf('requireCustomerAuth');
    const limiterIdx = line.indexOf('claimGuessLimiter');
    expect(authIdx).toBeGreaterThan(-1);
    // The authentication boundary is the FIRST middleware on the route.
    expect(authIdx).toBeLessThan(limiterIdx);
  });

  it('it is the same middleware /lookup uses — not a second authentication mechanism', () => {
    expect(serverTs).toMatch(
      /app\.post\('\/api\/claims\/lookup',\s*requireCustomerAuth,\s*claimGuessLimiter,/
    );
    expect(customerAuthTs).toContain('export async function requireCustomerAuth');
  });

  it('keeps the discrete limiter, the post-handover status gate and the once-per-claim dedup', () => {
    expect(rate).toMatch(/claimGuessLimiter/);
    expect(rate).toMatch(/\['pending_settlement', 'releasing', 'released'\]\.includes\(claim\.status\)/);
    expect(rate).toMatch(/markClaimRatedIfNotAlready/);
    expect(rate).toMatch(/if \(!wonRatingSlot\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. THE PAYMENT-SESSION INITIATE ROUTE PROVES OWNERSHIP BEFORE STATE
// ---------------------------------------------------------------------------
// Its ownership proof is the short-lived paymentAuthToken (minted by
// /payment-auth, which itself requires the registered owner phone). The token is
// now validated BEFORE the claim is read, so "no such claim" and "invalid token"
// are indistinguishable (both 403) and the claim's state is never consulted for
// an unproven caller.
describe('POST /api/claims/:id/payment-session/:sessionId/initiate authorizes before reading state', () => {
  const initiate = routeBody("app.post('/api/claims/:id/payment-session/:sessionId/initiate'");

  it('validates the ownership token before reading the claim', () => {
    const tokenIdx = initiate.indexOf('getClaimPaymentAuthToken');
    const claimIdx = initiate.indexOf('db.getClaim(claimId)');
    expect(tokenIdx, 'token validation present').toBeGreaterThan(-1);
    expect(claimIdx, 'claim read present').toBeGreaterThan(-1);
    expect(tokenIdx).toBeLessThan(claimIdx);
  });

  it('keeps its session-isolation, expiry and CAS guarantees', () => {
    expect(initiate).toMatch(/session\.claim_id !== claimId/);
    expect(initiate).toMatch(/session\.expires_at/);
    expect(initiate).toMatch(/reservePaymentSession\(sessionId\)/);
  });
});

// ---------------------------------------------------------------------------
// 4. A BROWSER TOKEN STORE IS NEVER A SERVER-SIDE AUTHORITY (§8)
// ---------------------------------------------------------------------------
// localStorage.admin_token / localStorage.agent_token are PRESENTATIONAL client
// state (App.tsx / Navbar.tsx), and the product intends them to stay that way.
// The server must authorize from the signed JWT in the Authorization header
// (agent/admin) or the httpOnly cookie (customer) — never from anything a
// browser can write. This pins that permanently: no server-side module may even
// mention a browser storage API or a browser token key.
function serverSideSources(): string[] {
  const out: string[] = ['src/server.ts'];
  for (const dir of ['src/routes', 'src/services', 'src/db']) {
    const walk = (abs: string) => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = path.join(abs, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          out.push(path.relative(repoRoot, child).replace(/\\/g, '/'));
        }
      }
    };
    walk(path.resolve(repoRoot, dir));
  }
  return out;
}

describe('the server never reads a browser token store', () => {
  const files = serverSideSources();

  it('collects a meaningful set of server-side modules (guards the walker itself)', () => {
    expect(files.length).toBeGreaterThan(15);
    expect(files).toContain('src/server.ts');
    expect(files).toContain('src/services/customerAuth.ts');
    expect(files).toContain('src/routes/customerClaims.ts');
  });

  it('no server-side module touches localStorage/sessionStorage or a browser token key', () => {
    for (const file of files) {
      const source = read(file);
      for (const banned of ['localStorage', 'sessionStorage', 'admin_token', 'agent_token']) {
        expect(source.includes(banned), `${file} must not reference ${banned}`).toBe(false);
      }
    }
  });

  it('localStorage is used ONLY by the presentational client surfaces that legitimately own it', () => {
    // The one place a token is written is App.tsx's token state, and the one
    // place it is read for chrome is Navbar.tsx. Neither is an authorization
    // decision, and neither is imported by the server.
    expect(read('src/App.tsx')).toContain("localStorage.getItem('admin_token')");
    expect(read('src/components/Navbar.tsx')).toContain("localStorage.getItem('admin_token')");
  });
});

// ---------------------------------------------------------------------------
// 5. THE CUSTOMER SESSION IS AN httpOnly COOKIE, RESOLVED SERVER-SIDE ONLY (§3)
// ---------------------------------------------------------------------------
describe('the customer session remains server-side and cookie-based', () => {
  it('keeps the hardened cookie attributes on r4m_customer_session', () => {
    expect(customerAuthTs).toContain("export const CUSTOMER_SESSION_COOKIE = 'r4m_customer_session';");
    const start = customerAuthTs.indexOf('export function customerCookieOptions');
    const end = customerAuthTs.indexOf('export function setCustomerSessionCookie');
    expect(start, 'customerCookieOptions present').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const options = customerAuthTs.slice(start, end);
    expect(options).toMatch(/httpOnly:\s*true/);
    // Secure in production only, so the development/test environment still works.
    expect(options).toMatch(/secure:\s*process\.env\.NODE_ENV === 'production'/);
    expect(options).toMatch(/sameSite:\s*'lax'/);
    expect(options).toMatch(/path:\s*'\/'/);
  });

  it('the raw session token is only ever written to the cookie, never to a response body', () => {
    expect(customerAuthTs).toMatch(/res\.cookie\(CUSTOMER_SESSION_COOKIE, token/);
    expect(customerAuthTs).not.toMatch(/json\(\{[^}]*rawToken/);
    // And the browser never receives the stored session hash either.
    expect(customerAuthTs).not.toMatch(/res\.json\([^)]*token_hash/);
  });

  it('requireCustomerAuth reads identity EXCLUSIVELY from the cookie', () => {
    const start = customerAuthTs.indexOf('export async function requireCustomerAuth');
    const end = customerAuthTs.indexOf('export async function resolveOptionalCustomer');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const middleware = customerAuthTs.slice(start, end);
    expect(middleware).toMatch(/readCookie\(req, CUSTOMER_SESSION_COOKIE\)/);
    // No client-supplied id/phone/query/header may select the account.
    expect(middleware).not.toMatch(/req\.body/);
    expect(middleware).not.toMatch(/req\.query/);
    expect(middleware).not.toMatch(/req\.params/);
    expect(middleware).not.toMatch(/headers\.authorization/i);
  });
});

// ---------------------------------------------------------------------------
// 6. THE RETURN PATH IS STILL A CLOSED, APP-OWNED LIST (§10)
// ---------------------------------------------------------------------------
describe('the post-authentication return path cannot become an open redirect', () => {
  it('accepts only the documented internal destinations', () => {
    for (const ok of ['/', '/report-lost', '/lost', '/lost?track=1', '/item/R4M-123ABC']) {
      expect(isSafeReturnPath(ok), `must stay safe: ${ok}`).toBe(true);
    }
    expect(accountPath('/report-lost')).toBe('/account?next=%2Freport-lost');
    expect(accountPath('/lost?track=1')).toBe('/account?next=%2Flost%3Ftrack%3D1');
  });

  it('rejects every off-site, scheme-bearing or non-path destination', () => {
    for (const hostile of [
      'https://evil.example',
      'http://evil.example/account',
      '//evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'account',
      '/console',
      '/agent_portal',
      '/account',
      '',
    ]) {
      expect(isSafeReturnPath(hostile), `must stay unsafe: ${hostile}`).toBe(false);
      expect(parsePublicRoute('/account', `?next=${encodeURIComponent(hostile)}`)).toEqual({
        kind: 'account',
        next: null,
      });
    }
  });

  it('honours ONLY the `next` parameter — no redirect/return/continue/callback aliases exist', () => {
    for (const param of ['redirect', 'redirectTo', 'return', 'continue', 'callback', 'url']) {
      expect(parsePublicRoute('/account', `?${param}=https%3A%2F%2Fevil.example`)).toEqual({
        kind: 'account',
        next: null,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 7. THE PUBLIC PROJECTION STILL PUBLISHES NOTHING PRIVATE (§12)
// ---------------------------------------------------------------------------
describe('toPublicItemView is a whitelist that leaks nothing, even from a fully populated row', () => {
  const rawItem: any = {
    id: 'R4M-123ABC',
    category_id: 'national-id',
    photo_url: 'https://cdn.example/secret-id.jpg',
    ocr_extracted_number: '12345678',
    ocr_extracted_name: 'JOHN DOE',
    document_number_hash: 'deadbeefcafe',
    document_name_fuzzy: null,
    // Phase 16.1 (GEO-16-03): the canonical county is PART of the public shape.
    // It is deliberately set to a county that the free-text location below does
    // NOT mention, so the positive assertion cannot pass by string accident.
    found_county: 'Mombasa',
    location_description: 'Moi Avenue, Nairobi',
    latitude: -1.2921,
    longitude: 36.8219,
    description: 'found near the matatu stage',
    finder_phone: '+254712345678',
    finder_email: 'finder@example.com',
    locked_total_fee: 1500,
    declared_value: 5000,
    assigned_agent_id: 'AGT-1',
    rejection_reason: 'internal review note',
    status: 'at_agent',
    is_sensitive_document: true,
    isDescriptionOnly: false,
    security_answers: { lastDigits: '9876' },
    owner_phone: '+254700000000',
  };
  const rawAgent: any = {
    id: 'AGT-1',
    business_name: 'Test Hub',
    contact_phone: '+254733000000',
    location_address: 'Moi Avenue, Nairobi',
    latitude: -1.29,
    longitude: 36.82,
    rating: 4.5,
    rating_count: 10,
    mpesa_till_or_paybill: '112233',
    national_id_hash: 'agent-hash',
    refundable_deposit: 500,
    warning_count: 2,
    id_document_photo_url: 'https://cdn.example/agent-id.jpg',
  };

  it('emits exactly the documented public field set', () => {
    const view = toPublicItemView(rawItem, rawAgent);
    expect(Object.keys(view).sort()).toEqual(
      [
        'id',
        'category_id',
        'photo_url',
        'is_sensitive_document',
        'document_name_fuzzy',
        'found_county',
        'administrative_unit_id',
        'administrative_unit_name',
        'location_description',
        'description',
        'isDescriptionOnly',
        'created_at',
        'status',
        'agent',
      ].sort()
    );
    // The agent is reduced to the hub's name plus a coarse area — no contact
    // phone, no exact address, no GPS.
    expect(Object.keys(view.agent).sort()).toEqual(['business_name', 'rough_area']);
    expect(view.agent.rough_area).toBe('Moi Avenue');
  });

  it('a sensitive document publishes neither its photo nor its free-text description', () => {
    const view = toPublicItemView(rawItem, rawAgent);
    expect(view.is_sensitive_document).toBe(true);
    expect(view.photo_url).toBeNull();
    expect(view.description).toBeNull();
  });

  it('publishes the CANONICAL county (and only at county level)', () => {
    // Phase 16.1 (GEO-16-03): the county is the coarsest geography the
    // product models, and the public shape now carries it — straight from the
    // county column, NOT read out of the free-text location ("Moi Avenue,
    // Nairobi" above).
    const view = toPublicItemView(rawItem, rawAgent);
    expect(view.found_county).toBe('Mombasa');
    expect(view.location_description).toBe('Moi Avenue, Nairobi');
    for (const finer of ['sub_county', 'city', 'town', 'ward', 'village']) {
      expect(view, `the public shape must stay at county level (${finer})`).not.toHaveProperty(finer);
    }
  });

  it('no private value survives into the serialized response', () => {
    const json = JSON.stringify(toPublicItemView(rawItem, rawAgent));
    for (const leak of [
      'JOHN DOE',
      '12345678',
      'deadbeefcafe',
      '+254712345678',
      'finder@example.com',
      '1500',
      '5000',
      'internal review note',
      '9876',
      '+254700000000',
      '+254733000000',
      '112233',
      'agent-hash',
      'agent-id.jpg',
      'secret-id.jpg',
      '-1.2921',
      '36.8219',
    ]) {
      expect(json, `must not leak ${leak}`).not.toContain(leak);
    }
  });
});
