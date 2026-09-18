import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// P12 REGRESSION TEST — duplicate-claim detection compared UNNORMALIZED phones.
//
// Every claim is PERSISTED with `owner_phone: normalizedOwnerPhone`, the E.164
// form produced by toE164Kenyan() at the top of POST /api/claims/submit. The
// duplicate guard, however, compared the RAW client string against that stored
// value:
//
//     const cleanOwnerPhone = ownerPhone.replace(/\s+/g, '');
//     c.owner_phone.replace(/\s+/g, '') === cleanOwnerPhone
//
// A claimant submitting the ordinary Kenyan local format (`0796770739` — what
// the app's own frontend sends) could therefore never match their own earlier
// claim. The `sameOwnerClaim` branch below it is what returns the existing claim
// with "Unarejelea claim yako ya awali."; because it never fired, execution fell
// through to the DIFFERENT-claimant branch, which creates a second claim row
// (status 'disputed') AND an ownership dispute between that person's own two
// claims.
//
// Observed live against a real PostgreSQL 18 instance, one item, one person:
//   POST /api/claims/submit  (repeat, same phone) -> 409 + a NEW claim id
//   SELECT count(*) FROM claims WHERE item_id = ... -> 2
//   POST /api/claims/:id/payment-session -> 423
//     "This item has an unresolved ownership dispute"
// i.e. the item was frozen for its rightful claimant by their own duplicate,
// until an admin manually cleared the spurious dispute.
//
// /lookup, /pay and /payment-auth already compare toE164Kenyan() forms, so these
// tests pin the duplicate guard to that same standard.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

/** The body of the claims-submit handler alone, comments stripped. */
function submitHandler(): string {
  const start = serverTs.indexOf("app.post('/api/claims/submit'");
  expect(start).toBeGreaterThan(-1);
  const rest = serverTs.slice(start);
  const next = rest.slice(1).search(/\n  app\.[a-z]+\(/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  return body
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('duplicate-claim detection normalizes phone numbers on both sides', () => {
  it('no longer compares the raw client string against the stored value', () => {
    const handler = submitHandler();
    expect(handler).not.toMatch(/cleanOwnerPhone/);
    expect(handler).not.toMatch(/c\.owner_phone\.replace\(\/\\s\+\/g, ''\)/);
  });

  it('normalizes the STORED phone with the same primitive used on input', () => {
    const handler = submitHandler();
    expect(handler).toMatch(/normalizeOwnerPhone\(c\.owner_phone\)/);
    expect(handler).toMatch(/toE164Kenyan\(String\(p \|\| ''\)\.replace\(\/\\s\+\/g, ''\)\)/);
  });

  it('compares against the NORMALIZED value that is actually persisted', () => {
    const handler = submitHandler();
    // The persisted value is normalizedOwnerPhone (validated /^\+254\d{9}$/).
    expect(handler).toMatch(/owner_phone: normalizedOwnerPhone,/);
    expect(handler).toMatch(/const targetOwnerPhone = normalizedOwnerPhone;/);
  });

  it('both the same-owner and the different-owner branches use the normalizer', () => {
    const handler = submitHandler();
    const sameOwner = handler.match(/normalizeOwnerPhone\(c\.owner_phone\) === targetOwnerPhone/g) || [];
    const differentOwner = handler.match(/normalizeOwnerPhone\(c\.owner_phone\) !== targetOwnerPhone/g) || [];
    expect(sameOwner.length, 'same-owner branch must use the normalizer').toBe(1);
    expect(differentOwner.length, 'different-owner branch must use the normalizer').toBe(1);
  });

  it('still returns the existing claim to a returning claimant (branch preserved)', () => {
    const handler = submitHandler();
    expect(handler).toMatch(/Unarejelea claim yako ya awali\./);
    expect(handler).toMatch(/toOwnerSafeClaimView\(sameOwnerClaim\)/);
  });
});
