import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P1 (B-2) — PICKUP-CODE RECOVERY, plus the B-4 SMS-failure UX change.
//
// The end-to-end audit proved an owner could be PERMANENTLY stranded: once a
// claim reached 'escrow_held' the 6-digit pickup code was generated, only its
// hash was stored, and the plaintext was sent by a fire-and-forget SMS. If that
// SMS was never delivered there was NO recovery path at all — the agent is
// correctly blocked from handover without the code, and the money stays in
// escrow with no way forward.
//
// These tests pin the recovery endpoint's security contract so the fix cannot
// regress into an existence oracle, a plaintext leak, or an SMS-spam amplifier.
const routeTs = fs.readFileSync(path.resolve(__dirname, '../routes/customerClaims.ts'), 'utf8');
const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
// P2-A3.1: the claim-OTP route now lives in routes/claims.ts.
const CLAIMS_ROUTE_TS = fs.readFileSync(path.resolve(__dirname, '../routes/claims.ts'), 'utf8');

const resendStart = routeTs.indexOf("'/api/customer/claims/:claimId/pickup-code/resend'");
const resendBody = resendStart > -1 ? routeTs.slice(resendStart, resendStart + 7000) : '';

describe('pickup-code recovery — route shape and authorization', () => {
  it('is registered on the customer claim router behind the customer session', () => {
    expect(resendStart).toBeGreaterThan(-1);
    expect(resendBody).toMatch(/requireCustomerAuth/);
  });

  it('never trusts a body-supplied identity (no customer id, phone, email or owner name)', () => {
    // Identity comes ONLY from the httpOnly session cookie resolved into
    // req.customer. The claim id is a path param and is only ever a lookup key.
    expect(resendBody).not.toMatch(/req\.body\?\.(customerId|customer_id|phone|email|ownerName|owner_phone)/i);
    expect(resendBody).toMatch(/req\.params\?\.claimId/);
  });

  it('binds the customer to the claim through the existing customer_claim_links primitive', () => {
    // Not authorized by claim id alone, by phone equality, or by name: the
    // link row only exists because the customer separately proved control of
    // the claim through the claim OTP plus the claim's security answers.
    expect(resendBody).toMatch(/getCustomerClaimLinkForClaim\(claimId\)/);
    expect(resendBody).toMatch(/link\.customer_id !== req\.customer\.id/);
  });

  it('uses the shared pickup-eligibility helper rather than a re-listed status set', () => {
    expect(resendBody).toMatch(/isPickupEligibleClaimStatus\(claim\.status\)/);
    expect(routeTs).toMatch(/import \{[^}]*isPickupEligibleClaimStatus[^}]*\} from '\.\.\/config\/claimStatuses'/);
  });
});

describe('pickup-code recovery — no claim-existence oracle', () => {
  it('returns the SAME 404 and SAME message for unknown, unlinked and other-owner claims', () => {
    const notLinkedCount = (resendBody.match(/MESSAGES\.notLinked/g) || []).length;
    expect(notLinkedCount).toBeGreaterThanOrEqual(2);
    // E1 INTRODUCED A 403 — but for a reason that cannot be an oracle: "this
    // account has no verified email destination". The ownership refusals still
    // return 404 MESSAGES.notLinked FIRST, so the status a non-owner sees is
    // unchanged; the 403 is unreachable without passing that proof. Asserted as
    // an ORDER property, which is the property that actually matters here.
    expect(resendBody).toContain('EMAIL_VERIFICATION_REQUIRED_MESSAGE');
    const first403 = resendBody.indexOf('res.status(403)');
    // The LAST ownership refusal that precedes it: every 404 branch comes first,
    // and the 403 is unreachable without passing them. (`resendBody` also covers
    // the neighbouring claim-link route, hence scoping to the offset.)
    const lastNotLinkedBefore403 = resendBody.lastIndexOf('MESSAGES.notLinked', first403);
    expect(first403).toBeGreaterThan(-1);
    expect(lastNotLinkedBefore403).toBeGreaterThan(-1);
    expect(lastNotLinkedBefore403).toBeLessThan(first403);
  });

  it('never words a refusal so as to reveal existence or ownership', () => {
    expect(resendBody).not.toMatch(/does not exist|not found|belongs to another/i);
  });
});

describe('pickup-code recovery — plaintext secrecy', () => {
  it('never returns the code, hash or phone in the HTTP response', () => {
    // The success envelope is exactly { success: true }.
    expect(resendBody).toMatch(/return res\.json\(\{ success: true \}\);/);
    expect(resendBody).not.toMatch(/res\.json\(\{[^}]*(pickupCode|codeHash|code:)/i);
  });

  it('never writes the plaintext into the audit log', () => {
    const audits = resendBody.match(/logAudit\([\s\S]*?\n\s*\);/g) || [];
    expect(audits.length).toBeGreaterThanOrEqual(2);
    for (const a of audits) {
      // `${code}` interpolated into an audit row would leak the secret.
      expect(a).not.toMatch(/\$\{code\}/);
      expect(a).not.toMatch(/\$\{pickupCode\}/);
    }
  });

  it('persists ONLY the hash, never the plaintext', () => {
    expect(resendBody).toMatch(/createPickupCode\(claimId, codeHash\)/);
    expect(resendBody).not.toMatch(/createPickupCode\(claimId, code\)/);
  });

  it('generates the code with crypto.randomInt, not Math.random', () => {
    expect(resendBody).toMatch(/crypto\.randomInt\(100000,\s*1000000\)/);
    expect(resendBody).not.toMatch(/Math\.random/);
  });
});

describe('pickup-code recovery — invalidation and send-before-persist ordering', () => {
  it('regenerates a NEW code that overwrites the stored hash (previous code invalidated)', () => {
    // createPickupCode updates in place and clears verified_at, so the previous
    // code stops working the moment the new one is persisted.
    expect(resendBody).toMatch(/await db\.createPickupCode\(claimId, codeHash\);/);
    const dbTs = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');
    const fn = dbTs.indexOf('public async createPickupCode');
    expect(fn).toBeGreaterThan(-1);
    const fnBody = dbTs.slice(fn, fn + 900);
    expect(fnBody).toMatch(/update\(claimPickupCodesTable\)/);
    expect(fnBody).toMatch(/code_hash: codeHash/);
    expect(fnBody).toMatch(/verified_at: null/);
  });

  it('sends the EMAIL BEFORE persisting, so a failed send cannot destroy the working code', () => {
    // THE ordering fix. Storing first and then failing to deliver would destroy
    // the previous code and never deliver the new one, leaving the owner with
    // no usable code and no way to get one — the permanent strand we removed.
    //
    // E1 UPDATED THE ANCHOR ONLY. The seam is now sendPickupCodeEmail (the email
    // OTP wrapper) instead of sendPickupCodeSms (the SMS notification wrapper).
    // The property under test — send strictly before persist — is unchanged and
    // is asserted exactly as strictly as before.
    const sendIdx = resendBody.indexOf('await sendPickupCodeEmail(');
    const persistIdx = resendBody.indexOf('await db.createPickupCode');
    expect(sendIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeLessThan(persistIdx);
  });

  it('persists nothing at all when the provider rejects the message', () => {
    // E1: same anchor change as above; the ordering property is identical.
    const sendIdx = resendBody.indexOf('await sendPickupCodeEmail(');
    const failIdx = resendBody.indexOf('if (!emailResult.success)');
    const persistIdx = resendBody.indexOf('await db.createPickupCode');
    expect(failIdx).toBeGreaterThan(sendIdx);
    expect(failIdx).toBeLessThan(persistIdx);
  });
});

describe('pickup-code recovery — email failure UX (B-4)', () => {
  it('returns 503 with a retryable message when the provider rejects', () => {
    // 503 (retryable) — not 500 (our fault) and never 200 (a lie).
    expect(resendBody).toMatch(/if \(!emailResult\.success\)[\s\S]{0,600}?res\.status\(503\)/);
  });

  it('judges delivery on the provider ACCEPTANCE result, not on absence of a throw', () => {
    expect(resendBody).toMatch(/emailResult\.success/);
  });

  it('the claim-OTP failure path was also converted from 500 to 503', () => {
    // P2-A3.1: the claim-OTP route was extracted VERBATIM into routes/claims.ts,
    // so the window is read from whichever file now owns it. E1 then re-homed its
    // transport onto the shared email OTP seam (sendClaimVerificationEmail), so
    // the anchor moved from the literal gateway label ('CLAIM OTP') to the seam
    // call site. The guarantee (a provider rejection is retryable 503, never 500)
    // is unchanged.
    const src = serverTs.includes("'CLAIM OTP'") ? serverTs : CLAIMS_ROUTE_TS;
    const fnStart = src.indexOf('await sendClaimVerificationEmail({');
    expect(fnStart).toBeGreaterThan(-1);
    const window = src.slice(fnStart, fnStart + 6000);
    // N7: the window was widened from 1400 chars. The property under test — a
    // provider rejection is a retryable 503, never a 500 — is unchanged, and the
    // regex is unchanged; the distance simply grew because the delivery call is
    // now a one-line wrapper around the notification seam instead of an inline
    // 6-argument gateway call.
    //
    // WIDENED AGAIN (3000 → 6000) when /api/claims/submit gained a route-level
    // security docblock a few lines above the claim-OTP route. That is pure
    // prose between the anchor and the 503, so the distance grew while the
    // guarantee did not move one character. The two regexes below are still the
    // original ones and still the whole point of the test.
    expect(window).toMatch(/res\.status\(503\)/);
    expect(window).not.toMatch(/res\.status\(500\)/);
  });
});

describe('pickup-code recovery — abuse resistance', () => {
  it('enforces a per-claim cooldown independent of the client', () => {
    expect(routeTs).toMatch(/PICKUP_CODE_RESEND_COOLDOWN_MS/);
    expect(resendBody).toMatch(/customerOtpLastSent\.get\(throttleKey\)/);
    expect(resendBody).toMatch(/res\.status\(429\)/);
  });

  it('enforces a rate limit bound to the CLAIM, not only to the caller IP', () => {
    expect(routeTs).toMatch(/const pickupCodeResendLimiter = rateLimit\(/);
    // Keyed on the claim id so rotating source addresses cannot bypass it.
    const limStart = routeTs.indexOf('const pickupCodeResendLimiter');
    const limBody = routeTs.slice(limStart, limStart + 700);
    expect(limBody).toMatch(/keyGenerator:[\s\S]{0,220}?params\?\.claimId/);
  });

  it('adds an IP-independent global ceiling because every send costs real money', () => {
    expect(routeTs).toMatch(/global-pickup-code-resend-bucket/);
    expect(resendBody).toMatch(/pickupCodeResendGlobalLimiter/);
  });

  it('audits both the success and the failure outcome', () => {
    expect(resendBody).toMatch(/PICKUP_CODE_RESENT/);
    expect(resendBody).toMatch(/PICKUP_CODE_RESEND_FAILED/);
  });
});

describe('pickup-code recovery — the hash-only model is not weakened', () => {
  it('the pickup codes table still stores only a hash', () => {
    const schemaTs = fs.readFileSync(path.resolve(__dirname, '../db/schema.ts'), 'utf8');
    const t = schemaTs.indexOf('claim_pickup_codes');
    expect(t).toBeGreaterThan(-1);
    const body = schemaTs.slice(t, t + 1000);
    expect(body).toMatch(/code_hash/);
    // No plaintext column may ever be added to solve the ordering problem.
    expect(body).not.toMatch(/code_plaintext|plain_code|code_text/);
  });
});

