import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('Email delivery semantics (email.ts)', () => {
  it('does not claim success in production when Resend is unconfigured', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    // Satisfy the db/index.ts production boot guard; the DB is never used here.
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?sslmode=require';
    try {
      const { EmailService } = await import('../email.ts');
      // Must be false — never "simulated success" — when no provider exists.
      await expect(EmailService.send('user@example.com', 'Subject', '<p>Hi</p>')).resolves.toBe(false);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('returns false for an empty recipient', async () => {
    const { EmailService } = await import('../email.ts');
    await expect(EmailService.send('', 'Subject', '<p>Hi</p>')).resolves.toBe(false);
  });

  it('brands customer emails as Return4me, not a third-party vendor', async () => {
    const { EmailService } = await import('../email.ts');
    const calls: any[] = [];
    (EmailService as any).send = async (to: string, subject: string, html: string) => {
      calls.push([to, subject, html]);
      return true;
    };
    await EmailService.sendPaymentReceivedEmail(
      'user@example.com', '+254700000000', 'National ID', 'CBD Hub', '+254711000000', 'R4M-1', '1234'
    );
    expect(calls).toHaveLength(1);
    const html = String(calls[0][2]);
    expect(html).toMatch(/Return4me/);
    expect(html).not.toMatch(/Jamoko Solutions Ltd/);
    expect(html).not.toMatch(/Lost & Found Verification Service/);
  });

  it('returns provider failure as false (no false success)', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    vi.doMock('resend', () => ({
      Resend: class {
        emails = { send: async () => ({ error: { message: 'rejected' } }) };
      },
    }));
    const { EmailService } = await import('../email.ts');
    await expect(EmailService.send('user@example.com', 'Subject', '<p>Hi</p>')).resolves.toBe(false);
  });
});
