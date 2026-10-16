import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// BATCH S1 - THE SANDBOX EMAIL OUTBOX MUST NOT PRINT A MESSAGE BODY.
//
// The defect: whenever Resend had no usable key - which is EVERY test run and
// every local run - EmailService printed the FULL text/plain and text/html
// parts to the console. An activation email carries its one-time link twice in
// each part (the button href plus the raw-URL fallback, and the plain-text
// rendering of both), so every registration of a customer or an agent wrote a
// LIVE activation token into the console, and from there into any captured CI
// log. A log outlives a 24h token by a very long way.
//
// These are BEHAVIOURAL tests: they run the real EmailService through the real
// sandbox branch and read what it actually handed to console.log. Nothing is
// emailed and no provider is contacted - RESEND_API_KEY is absent by
// construction, so the sandbox branch is the only one reachable.
// =============================================================================

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  // DELIBERATELY an assignment, not a delete. Several modules in this graph call
  // dotenv.config() at import time, and dotenv re-populates a key that is
  // MISSING from process.env from the developer's .env - which armed the live
  // Resend path in the first draft of this test (a real client was constructed
  // and the send failed with a provider error). An empty string is the setup
  // file's "not configured" value, which dotenv will not overwrite.
  process.env.RESEND_API_KEY = '';
  // NETWORK KILL-SWITCH (belt and braces): the sandbox branch must be selected
  // without any client being constructed. If that assumption ever breaks, this
  // mock fails the test loudly and LOCALLY instead of letting the suite contact
  // Resend with whatever key the machine happens to hold. Same seam
  // src/services/__tests__/emailDelivery.test.ts uses.
  vi.doMock('resend', () => ({
    Resend: class {
      emails = {
        send: async () => {
          throw new Error('sandboxOutboxRedaction: a real Resend client must never be constructed here');
        },
      };
    },
  }));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

// Synthetic, obviously-fake fixtures. Neither is a credential from any system.
const CUSTOMER_TOKEN = 'r4m-outbox-customer-token-5c1b9e';
const AGENT_TOKEN = 'r4m-outbox-agent-token-7d2f4a';

type Capture = { output: string; restore: () => void };

/**
 * Record everything the outbox writes to the console, flattened to the text a
 * log aggregator would receive. Same pattern as
 * src/services/__tests__/refundLogSafety.test.ts.
 */
function captureConsoleOutput(): Capture {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(
      args
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg)))
        .join(' '),
    );
  };
  const log = vi.spyOn(console, 'log').mockImplementation(record as typeof console.log);
  const warn = vi.spyOn(console, 'warn').mockImplementation(record as typeof console.warn);
  const error = vi.spyOn(console, 'error').mockImplementation(record as typeof console.error);
  return {
    // A LIVE view: read AFTER the code under test has run.
    get output() {
      return lines.join('\n');
    },
    restore: () => {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    },
  };
}

describe('the sandbox email outbox prints no body and no activation token', () => {
  it('a simulated CUSTOMER activation email keeps its token out of the console', async () => {
    const { EmailService } = await import('../email.ts');
    const { buildCustomerActivationUrl, buildCustomerActivationEmailHtml } = await import('../customerAuth.ts');

    const url = buildCustomerActivationUrl(CUSTOMER_TOKEN);
    const html = buildCustomerActivationEmailHtml('Test Person', url);
    // The premise: the real message body DOES carry the live link.
    expect(html).toContain(CUSTOMER_TOKEN);

    const capture = captureConsoleOutput();
    let accepted: boolean;
    try {
      accepted = await EmailService.send('customer@example.com', 'Activate your Return4me account', html);
    } finally {
      capture.restore();
    }

    // The sandbox still behaves like a sandbox: it reports acceptance...
    expect(accepted).toBe(true);
    expect(capture.output).toContain('[SANDBOX EMAIL OUTBOX]');
    expect(capture.output).toContain('Simulated: no email was sent');
    // ...and keeps the useful, non-sensitive metadata.
    expect(capture.output).toContain('customer@example.com');
    expect(capture.output).toContain('Activate your Return4me account');

    // ...but neither the token nor the body reaches the log.
    expect(capture.output).not.toContain(CUSTOMER_TOKEN);
    expect(capture.output).not.toContain(url);
    expect(capture.output).not.toContain('/activate-email');
    expect(capture.output).not.toContain('<a ');
    expect(capture.output).not.toContain('Activate my account');
  });
});

describe('the sandbox email outbox prints no body and no activation token', () => {
  it('a simulated AGENT activation email keeps its token out of the console', async () => {
    const { EmailService } = await import('../email.ts');
    const { buildAgentActivationUrl, buildAgentActivationEmailHtml } = await import('../customerAuth.ts');

    const url = buildAgentActivationUrl(AGENT_TOKEN);
    const html = buildAgentActivationEmailHtml('Test Agent Business', url);
    expect(html).toContain(AGENT_TOKEN);

    const capture = captureConsoleOutput();
    let accepted: boolean;
    try {
      accepted = await EmailService.send('agent@example.com', 'Verify your Return4me agent email', html);
    } finally {
      capture.restore();
    }

    expect(accepted).toBe(true);
    expect(capture.output).toContain('[SANDBOX EMAIL OUTBOX]');
    expect(capture.output).not.toContain(AGENT_TOKEN);
    expect(capture.output).not.toContain(url);
    expect(capture.output).not.toContain('/activate-agent-email');
    expect(capture.output).not.toContain('<a ');
  });

  it('the explicit text/plain part is not printed either (sendWithId)', async () => {
    const { EmailService } = await import('../email.ts');
    const { buildCustomerActivationUrl } = await import('../customerAuth.ts');
    const url = buildCustomerActivationUrl(CUSTOMER_TOKEN);

    const capture = captureConsoleOutput();
    try {
      await EmailService.sendWithId(
        'customer@example.com',
        'Activate your Return4me account',
        `<p>Activate: <a href="${url}">Activate my account</a></p>`,
        `Activate your account: ${url}`,
      );
    } finally {
      capture.restore();
    }

    expect(capture.output).toContain('[SANDBOX EMAIL OUTBOX]');
    expect(capture.output).not.toContain(CUSTOMER_TOKEN);
    expect(capture.output).not.toContain(url);
  });
});

describe('production email behaviour is unchanged', () => {
  it('still fails closed with NO outbox output and no body when Resend is unconfigured', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    // Satisfy the db/index.ts production boot guard; the DB is never used here.
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?sslmode=require';
    try {
      const { EmailService } = await import('../email.ts');
      const capture = captureConsoleOutput();
      let accepted: boolean;
      try {
        accepted = await EmailService.send(
          'customer@example.com',
          'Activate your Return4me account',
          `<p>Activate: <a href="https://return4me.co.ke/activate-email?token=${CUSTOMER_TOKEN}">Activate</a></p>`,
        );
      } finally {
        capture.restore();
      }

      // The fail-closed contract itself: never a simulated success in production.
      expect(accepted).toBe(false);
      // No outbox banner at all, so that branch cannot print a body...
      expect(capture.output).not.toContain('[SANDBOX EMAIL OUTBOX]');
      // ...and the refusal line carries no credential.
      expect(capture.output).toContain('RESEND_API_KEY is not configured in production');
      expect(capture.output).not.toContain(CUSTOMER_TOKEN);
    } finally {
      process.env.NODE_ENV = previous;
      delete process.env.DATABASE_URL;
    }
  });
});
