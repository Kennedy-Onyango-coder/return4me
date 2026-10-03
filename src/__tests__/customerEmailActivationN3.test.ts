// N3 - CUSTOMER EMAIL ACTIVATION GATE.
//
// Two classes of test, because they prove different things and conflating them
// is how false confidence happens:
//  * EXECUTED tests drive the real db helpers against the real in-memory
//    database, so they witness the actual CAS behaviour (one consumer of a
//    token, one activation) rather than merely reading source.
//  * SOURCE tests assert the route contract, which cannot be executed here
//    because server.ts calls startServer() at import time. That limitation is
//    real and is stated here rather than papered over.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database.ts';
import {
  CUSTOMER_ACTIVATION_TTL_MS,
  buildCustomerActivationUrl,
  buildCustomerActivationEmailHtml,
} from '../services/customerAuth.ts';

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
const dbTs = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');
const schemaTs = fs.readFileSync(path.resolve(__dirname, '../db/schema.ts'), 'utf8');

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

/** Strips comments so a doc-comment explaining a rule is not itself a match. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const registerBody = routeBody("app.post('/api/customer/register'");
const activateBody = routeBody("app.post('/api/customer/activate'");
const loginVerifyBody = routeBody("app.post('/api/customer/login/verify'");
const registerCode = stripComments(registerBody);

const RAW_TOKEN = 'a'.repeat(64);

describe('N3 - registration contract', () => {
  it('requires an email', () => {
    expect(registerBody).toContain("const rawEmail = typeof req.body?.email === 'string'");
    expect(registerBody).toContain('Enter a valid email address');
  });

  it('trims then lowercases before persistence', () => {
    expect(registerBody).toContain('req.body.email.trim()');
    expect(registerBody).toContain('const email = rawEmail.toLowerCase()');
    expect(registerBody).toContain('db.getCustomerByEmail(email)');
  });

  it('rejects a duplicate email and surfaces 23505 as the same conflict', () => {
    expect(registerBody).toContain('already in use');
    expect(registerBody).toContain("if (e && (e as any).code === '23505')");
  });

  it('creates the customer INACTIVE with an unverified email', () => {
    expect(registerBody).toContain('createCustomerPendingActivation');
    expect(dbTs).toContain("status: 'pending_activation'");
    expect(dbTs).toContain('email_verified_at: null');
  });

  it('sends NO SMS', () => {
    expect(registerCode).not.toContain('sendCodeViaSms');
    expect(registerCode).not.toContain('generateCustomerOtp');
    expect(registerCode).not.toContain('createCustomerOtp');
    expect(registerCode).not.toContain('AuthService.sendSms');
  });

  it('issues no session at registration', () => {
    expect(registerCode).not.toContain('createCustomerSession');
    expect(registerCode).not.toContain('setCustomerSessionCookie');
  });

  it('keeps the throttle and a generic anti-enumeration shape', () => {
    expect(registerBody).toContain('customerOtpLastSent.get(throttleKey)');
    expect(registerBody).toContain("message: 'Akaunti imeundwa");
  });
});

describe('N3 - activation token', () => {
  it('generates 32 CSPRNG bytes', () => {
    expect(registerBody).toContain("crypto.randomBytes(32).toString('hex')");
  });

  it('persists only the HASH', () => {
    expect(registerBody).toContain('hashCode(rawToken)');
    const insert = registerBody.slice(registerBody.indexOf('createAccountActivationToken'));
    expect(insert.slice(0, 500)).not.toMatch(/,\s*rawToken\s*,?\s*\)/);
  });

  it('uses the customer account type and email_activation purpose', () => {
    expect(registerBody).toContain("'customer'");
    expect(registerBody).toContain("'email_activation'");
  });

  it('lives for 24 hours', () => {
    expect(registerBody).toContain('CUSTOMER_ACTIVATION_TTL_MS');
    expect(CUSTOMER_ACTIVATION_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('never logs or returns the token or the URL', () => {
    expect(registerCode).not.toMatch(/console\.(log|warn|error)[^;]*rawToken/);
    expect(registerBody).not.toMatch(/logAudit[^;]*rawToken/);
    expect(registerBody).not.toMatch(/logAudit[^;]*activationUrl/);
    const response = registerBody.slice(registerBody.lastIndexOf('return res.json'));
    expect(response).not.toContain('rawToken');
    expect(response).not.toContain('activationUrl');
  });

  it('keeps the token out of every audit record it writes', () => {
    const audits = registerBody.match(/logAudit\([\s\S]*?\);/g) || [];
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) {
      expect(a).not.toContain('rawToken');
      expect(a).not.toContain('activationUrl');
    }
  });
});

describe('N3 - activation URL and email body', () => {
  it('embeds the token only in the link', () => {
    expect(buildCustomerActivationUrl(RAW_TOKEN)).toContain('token=' + RAW_TOKEN);
  });

  it('percent-encodes the token', () => {
    expect(buildCustomerActivationUrl('a+b/c=')).toContain('token=a%2Bb%2Fc%3D');
  });

  it('states purpose, action and the 24h window', () => {
    const html = buildCustomerActivationEmailHtml('Test User', 'https://example.test/act');
    expect(html).toContain('Activate your Return4me account');
    expect(html).toContain('https://example.test/act');
    expect(html).toContain('24 hours');
  });

  it('escapes a crafted name so it cannot inject markup', () => {
    const html = buildCustomerActivationEmailHtml('<script>x</script>', 'https://example.test/act');
    expect(html).not.toContain('<script>');
  });
});

describe('N3 - activation endpoint', () => {
  it('validates and hashes the presented token', () => {
    expect(activateBody).toContain('db.getAccountActivationTokenByHash(hashCode(rawToken))');
  });

  it('checks purpose AND account type', () => {
    expect(activateBody).toContain("token.account_type !== 'customer' || token.purpose !== 'email_activation'");
  });

  it('returns ONE generic failure for every unusable-token reason', () => {
    // A token oracle would arise if unknown / wrong-type / consumed / expired
    // each produced a distinguishable response. They must share one body.
    expect(activateBody).toContain('const GENERIC =');
    const generic = (activateBody.match(/res\.status\(400\)\.json\(GENERIC\)/g) || []).length;
    expect(generic).toBeGreaterThanOrEqual(5);
  });

  it('consumes BEFORE activating, and activates BEFORE the session', () => {
    const consume = activateBody.indexOf('consumeAccountActivationToken');
    const activate = activateBody.indexOf('activateCustomerAccount');
    const session = activateBody.indexOf('createCustomerSession');
    expect(consume).toBeGreaterThan(-1);
    expect(activate).toBeGreaterThan(consume);
    expect(session).toBeGreaterThan(activate);
  });

  it('issues no session unless activation actually succeeded', () => {
    expect(activateBody).toContain('if (!activated) return res.status(400).json(GENERIC)');
    expect(activateBody.indexOf('createCustomerSession')).toBeGreaterThan(
      activateBody.indexOf('if (!activated)'),
    );
  });

  it('hashes the session token before storing it', () => {
    expect(activateBody).toContain('hashCode(rawSession)');
  });

  it('leaks nothing about the account in its responses', () => {
    expect(activateBody).not.toMatch(/res\.json\(\{[^}]*customer\?\.email/);
    expect(activateBody).not.toMatch(/res\.json\(\{[^}]*token_hash/);
  });
});

describe('N3 - executed: atomic single-use consumption', () => {
  it('only one concurrent consumption of the same token succeeds', async () => {
    await db.createAccountActivationToken(
      'ACT_RACE_1', 'customer', 'CUS_RACE_1', 'email_activation',
      'hash-race-1', new Date(Date.now() + 60000)
    );
    const [a, b, c] = await Promise.all([
      db.consumeAccountActivationToken('ACT_RACE_1'),
      db.consumeAccountActivationToken('ACT_RACE_1'),
      db.consumeAccountActivationToken('ACT_RACE_1'),
    ]);
    // Exactly one winner - the losers updated zero rows.
    expect([a, b, c].filter(Boolean)).toHaveLength(1);
  });

  it('refuses to consume an already-consumed token on a later call', async () => {
    await db.createAccountActivationToken(
      'ACT_REPLAY', 'customer', 'CUS_REPLAY', 'email_activation',
      'hash-replay', new Date(Date.now() + 60000)
    );
    expect(await db.consumeAccountActivationToken('ACT_REPLAY')).toBe(true);
    expect(await db.consumeAccountActivationToken('ACT_REPLAY')).toBe(false);
  });

  it('refuses to consume an EXPIRED token', async () => {
    await db.createAccountActivationToken(
      'ACT_EXPIRED', 'customer', 'CUS_EXPIRED', 'email_activation',
      'hash-expired', new Date(Date.now() - 1000)
    );
    expect(await db.consumeAccountActivationToken('ACT_EXPIRED')).toBe(false);
  });

  it('round-trips a token by hash', async () => {
    await db.createAccountActivationToken(
      'ACT_LOOKUP', 'customer', 'CUS_LOOKUP', 'email_activation',
      'hash-lookup', new Date(Date.now() + 60000)
    );
    const found: any = await db.getAccountActivationTokenByHash('hash-lookup');
    expect(found).toBeTruthy();
    expect(found.account_type).toBe('customer');
    expect(found.consumed_at).toBeFalsy();
    expect(await db.getAccountActivationTokenByHash('nope')).toBeUndefined();
  });
});

describe('N3 - executed: new customer is inactive until activated', () => {
  it('creates a pending_activation customer with NULL email_verified_at', async () => {
    const c: any = await db.createCustomerPendingActivation(
      'CUS_N3_1', 'Nina Test', '+254711111111', 'Nina@Example.COM'
    );
    expect(c.status).toBe('pending_activation');
    expect(c.email_verified_at).toBeFalsy();
    // Normalization is applied by the writer, not the caller.
    expect(c.email).toBe('nina@example.com');
  });

  it('activation sets email_verified_at AND status active in one step', async () => {
    await db.createCustomerPendingActivation('CUS_N3_2', 'Test', '+254722222222', 'a@b.co');
    expect(await db.activateCustomerAccount('CUS_N3_2')).toBe(true);
    const c: any = await db.getCustomerById('CUS_N3_2');
    expect(c.status).toBe('active');
    expect(c.email_verified_at).toBeTruthy();
  });

  it('cannot be activated twice', async () => {
    await db.createCustomerPendingActivation('CUS_N3_3', 'Test', '+254733333333', 'c@d.co');
    expect(await db.activateCustomerAccount('CUS_N3_3')).toBe(true);
    expect(await db.activateCustomerAccount('CUS_N3_3')).toBe(false);
  });
});

describe('N3 - executed: grandfathered customers are untouched', () => {
  it('a NULL-email active customer stays active and cannot be silently flipped', async () => {
    // Simulates a pre-N3 account: created the old way, status active, no email.
    const legacy: any = await db.createCustomer('CUS_LEGACY_1', 'Legacy User', '+254744444444');
    expect(legacy.status).toBe('active');
    expect(legacy.email).toBeFalsy();
    expect(legacy.email_verified_at).toBeFalsy();
    // activateCustomerAccount only writes FROM pending_activation, so an
    // already-active legacy row is unaffected.
    expect(await db.activateCustomerAccount('CUS_LEGACY_1')).toBe(false);
    const after: any = await db.getCustomerById('CUS_LEGACY_1');
    expect(after.status).toBe('active');
  });

  it('two NULL-email customers can coexist (partial unique index)', async () => {
    const a: any = await db.createCustomer('CUS_LEGACY_2', 'L2', '+254755555555');
    const b: any = await db.createCustomer('CUS_LEGACY_3', 'L3', '+254766666666');
    expect(a.email).toBeFalsy();
    expect(b.email).toBeFalsy();
  });

  it('a duplicate non-null email is rejected by the database', async () => {
    await db.createCustomerPendingActivation('CUS_DUP_1', 'A', '+254777777777', 'dup@x.co');
    await expect(
      db.createCustomerPendingActivation('CUS_DUP_2', 'B', '+254788888888', 'dup@x.co')
    ).rejects.toThrow();
  });

  it('email lookup is case-insensitive', async () => {
    await db.createCustomerPendingActivation('CUS_CASE_1', 'C', '+254799999999', 'Case@X.co');
    const found: any = await db.getCustomerByEmail('case@x.co');
    expect(found).toBeTruthy();
    expect(found.id).toBe('CUS_CASE_1');
  });
});

describe('N3 - login compatibility', () => {
  it('refuses a login for an account that has an email but is not verified', () => {
    expect(loginVerifyBody).toContain('if (customer.email && !customer.email_verified_at)');
  });

  it('does NOT block a grandfathered account that has no email at all', () => {
    // The guard must be conditioned on the account HAVING an email, otherwise
    // every pre-N3 customer would be locked out.
    expect(loginVerifyBody).toContain('customer.email && !customer.email_verified_at');
    expect(loginVerifyBody).not.toMatch(/if\s*\(!customer\.email_verified_at\)/);
  });

  it('still creates a session after the gate for legitimate logins', () => {
    expect(loginVerifyBody).toContain('createCustomerSession');
    expect(loginVerifyBody).toContain('setCustomerSessionCookie');
  });
});

describe('N3 - email failure behaviour', () => {
  it('a provider failure leaves the account inactive and issues no session', () => {
    expect(registerBody).toContain('if (!emailAccepted)');
    expect(registerBody).toContain('CUSTOMER_ACTIVATION_EMAIL_FAILED');
    expect(registerBody).toContain('res.status(503)');
    expect(registerCode.indexOf('createCustomerSession')).toBe(-1);
  });

  it('keeps the token valid after an email failure so activation can still succeed', () => {
    expect(registerBody).not.toContain('deleteAccountActivationToken');
  });
});

describe('N3 - no notification architecture invented', () => {
  it('the registration path never writes notification_events DIRECTLY', () => {
    // N5 CONTRACT UPDATE. This assertion originally forbade the registration
    // route from mentioning notification_events OR NotificationService at all,
    // because N5 had not been built yet and N3 was explicitly forbidden from
    // pre-empting it ("N5 owns the central notification service").
    //
    // Now that N5 exists, the route legitimately DOES call NotificationService —
    // that is the whole point of the stage. What must remain true, and is now
    // asserted more strongly, is that the route reaches the durable table ONLY
    // through that single service and never touches it itself. A route that
    // inserted its own notification_events row would be exactly the duplicated
    // architecture N5 was built to remove.
    // Asserted against the COMMENT-STRIPPED route body (registerCode), because
    // the route's own explanatory comment legitimately names the table. The point
    // is what the CODE does, not what the prose says it does.
    expect(registerCode).toContain('NotificationService.notify');
    expect(registerCode).not.toContain('notification_events');
    // No direct db write to the table from a route.
    expect(registerCode).not.toMatch(/db\.(?:insert|update)\(.*notification/i);
    // The ACTIVATION endpoint still creates no notification event at all: it
    // redeems a token, it does not send a message.
    expect(activateBody).not.toContain('NotificationService');
    expect(activateBody).not.toContain('notification_events');
  });
});

describe('N3 - schema supports the flow', () => {
  it('the shared activation-token table exists with the discriminator', () => {
    expect(schemaTs).toContain('export const account_activation_tokens');
    expect(schemaTs).toContain('account_type');
    expect(schemaTs).toContain('token_hash');
    expect(schemaTs).toContain('expires_at');
    expect(schemaTs).toContain('consumed_at');
  });

  it('customers carries email + email_verified_at', () => {
    expect(schemaTs).toContain('email_verified_at');
    expect(schemaTs).toContain('uq_customers_email');
  });
});
