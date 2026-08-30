import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Regression test: two places logged a full, unmasked M-Pesa phone number
// to production logs — a direct violation of this codebase's own
// no-full-phone-numbers-in-logs rule (already followed correctly via
// maskPhoneForLog in auth.ts's SMS-send logs, the sweep job, and the
// payout-disbursement log two lines above the refund one that had been
// missed):
//
// 1. services/payments.ts triggerIntasendRefund logged the raw refund
//    payload, whose transactions[0].account is the recipient's phone.
// 2. server.ts's IntaSend webhook handler logged the entire raw callback
//    payload (JSON.stringify(payload, null, 2)) before signature
//    verification, and IntaSend collection callbacks carry the payer's
//    phone_number.

const paymentsTs = fs.readFileSync(path.resolve(__dirname, '../payments.ts'), 'utf8');
const serverTs = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');

describe('phone numbers are masked before logging (payment paths)', () => {
  it('triggerIntasendRefund masks the account/phone before logging the payload', () => {
    const start = paymentsTs.indexOf('async triggerIntasendRefund');
    expect(start).toBeGreaterThan(-1);
    const body = paymentsTs.slice(start, start + 2000);
    const logLine = body.match(/console\.log\('\[INTASEND REFUND\][\s\S]*?\);/);
    expect(logLine, 'refund disbursement log statement not found').not.toBeNull();
    expect(logLine![0]).toMatch(/maskPhoneForLog\(t\.account\)/);
    // Guard against a naive raw JSON.stringify(payload) regression.
    expect(logLine![0]).not.toMatch(/JSON\.stringify\(payload,/);
  });

  it('the IntaSend webhook handler does not log the raw unredacted callback payload', () => {
    const start = serverTs.indexOf("app.post('/api/webhooks/intasend'");
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 1500);
    expect(body).not.toMatch(/console\.log\('\[INTASEND WEBHOOK\] Received callback event:', JSON\.stringify\(payload,/);
    expect(body).toMatch(/maskPhoneForLog\(payload\?\.phone_number\)/);
  });
});
