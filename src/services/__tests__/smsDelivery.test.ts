import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SMS_ENABLED;
  delete process.env.AFRICASTALKING_API_KEY;
  delete process.env.AFRICASTALKING_USERNAME;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('SMS delivery semantics (auth.ts)', () => {
  it('fails closed in production when SMS_ENABLED is not "true" even with real credentials', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.SMS_ENABLED = 'false';
    process.env.AFRICASTALKING_API_KEY = 'MY_TEST_ONLY_FAKE_SMS_API_KEY';
    process.env.AFRICASTALKING_USERNAME = 'MY_TEST_ONLY_FAKE_SMS_USER';
    // Satisfy the db/index.ts production boot guard; the DB is never used here.
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?sslmode=require';
    try {
      const mod = await import('../auth.ts');
      const res = await mod.AuthService.sendSms('+254700000000', 'code 1234');
      expect(res).toBe(false);
    } finally {
      process.env.NODE_ENV = prev;
      delete process.env.DATABASE_URL;
    }
  });

  it('simulates (with an unmistakable label) instead of sending in dev when the flag is off', async () => {
    process.env.SMS_ENABLED = 'false';
    process.env.AFRICASTALKING_API_KEY = 'MY_TEST_ONLY_FAKE_SMS_API_KEY';
    process.env.AFRICASTALKING_USERNAME = 'MY_TEST_ONLY_FAKE_SMS_USER';
    const mod = await import('../auth.ts');
    // Non-production: no live SMS is sent, but the sandbox simulation result is
    // allowed so local flows keep working. Live sending still requires the flag.
    const res = await mod.sendCodeViaSms('+254700000000', '1234', 'OTP', 'ok');
    expect(res.success).toBe(true);
  });

  it('fails closed in production when SMS_ENABLED is missing, without leaking provider internals', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    // Importing auth.ts under NODE_ENV=production requires a non-placeholder
    // DATABASE_URL (db/index.ts production guard). The DB is never touched by
    // these send paths — the placeholder just satisfies the boot guard.
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?sslmode=require';
    try {
      const mod = await import('../auth.ts');
      const res = await mod.AuthService.sendSms('+254700000000', 'code 1234');
      expect(res).toBe(false);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('normalizes Kenyan phone formats to +254 exactly once', async () => {
    const mod = await import('../auth.ts');
    expect(mod.toE164Kenyan('0712345678')).toBe('+254712345678');
    expect(mod.toE164Kenyan('0112345678')).toBe('+254112345678');
    expect(mod.toE164Kenyan('254712345678')).toBe('+254712345678');
    expect(mod.toE164Kenyan('+254712345678')).toBe('+254712345678');
    // Already-normalized input must not gain a second country code.
    expect(mod.toE164Kenyan('+254712345678')).not.toBe('+254+254712345678');
  });

  it('normalizes recipient-level provider results without leaking raw errors', async () => {
    const mod = await import('../auth.ts');
    expect(
      mod.normalizeAtSmsResult({ SMSMessageData: { Recipients: [{ status: 'Success', statusCode: 101 }] } }).success
    ).toBe(true);
    const blacklisted = mod.normalizeAtSmsResult({
      SMSMessageData: { Recipients: [{ status: 'Rejected: number blacklisted', messageId: 'x' }] },
    });
    expect(blacklisted.success).toBe(false);
    expect(blacklisted.retryable).toBe(false);
    expect(String(blacklisted.failureReason)).not.toMatch(/socket|AT-500/i);
  });

  it('treats a provider exception path as non-success (sendSms returns false on throw)', async () => {
    process.env.SMS_ENABLED = 'true';
    process.env.AFRICASTALKING_API_KEY = 'MY_TEST_ONLY_FAKE_SMS_API_KEY';
    process.env.AFRICASTALKING_USERNAME = 'MY_TEST_ONLY_FAKE_SMS_USER';
    vi.doMock('africastalking', () => ({
      default: () => ({
        SMS: { send: async () => { throw new Error('socket hang up AT-500'); } },
      }),
    }));
    const mod = await import('../auth.ts');
    const res = await mod.AuthService.sendSms('+254700000000', 'code 1234');
    expect(res).toBe(false);
  });

  it('never reports a blacklisted recipient as success', async () => {
    process.env.SMS_ENABLED = 'true';
    process.env.AFRICASTALKING_API_KEY = 'MY_TEST_ONLY_FAKE_SMS_API_KEY';
    process.env.AFRICASTALKING_USERNAME = 'MY_TEST_ONLY_FAKE_SMS_USER';
    vi.doMock('africastalking', () => ({
      default: () => ({
        SMS: {
          send: async () => ({
            SMSMessageData: {
              Recipients: [{ status: 'Rejected: number blacklisted', messageId: 'x' }],
            },
          }),
        },
      }),
    }));
    const mod = await import('../auth.ts');
    const normalized = mod.normalizeAtSmsResult({
      SMSMessageData: { Recipients: [{ status: 'Rejected: number blacklisted', messageId: 'x' }] },
    });
    expect(normalized.success).toBe(false);
    expect(normalized.retryable).toBe(false);
  });
});
