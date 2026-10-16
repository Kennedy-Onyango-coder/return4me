import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// BATCH S1 - THE SMS SIMULATION LOG MUST NOT PRINT A CODE.
//
// The defect: the dev/sandbox simulation branches printed the real credential.
//   * sendCodeViaSms  -> "Sending code <OTP> to <masked phone>"
//   * AuthService.sendSms -> "Sending to <masked phone>: <message>", where the
//     message is a full sentence that (on the pickup-code path) CONTAINS the code.
// Console output is not ephemeral: it is captured into CI job logs, terminal
// history and log shippers, all of which outlive a 5-minute OTP. A simulation
// log exists to say "nothing was sent, here is what WOULD have gone"; that is
// fully expressible without the credential.
//
// These are BEHAVIOURAL tests: the real functions run and the test reads what
// they actually handed to console.log. No SMS is sent and NO provider is
// contacted - the Africa's Talking credentials are the setup file's
// UNCONFIGURED value, so the simulation branch is the only one reachable.
// =============================================================================

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  // DELIBERATELY an assignment, not a delete: auth.ts calls dotenv.config() at
  // import time, and dotenv re-populates a key that is MISSING from process.env
  // from a developer's .env - which would arm the live SMS path. An empty string
  // is the setup file's "not configured" value (see setup.testEnv.ts).
  process.env.SMS_ENABLED = 'false';
  process.env.AFRICASTALKING_API_KEY = '';
  process.env.AFRICASTALKING_USERNAME = '';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

// Synthetic fixtures. The digits are distinctive so a substring search over the
// captured output is unambiguous.
const OTP = '482913';
const PICKUP_CODE = '739184';
const PHONE = '+254712345678';
const MASKED_PHONE = '+254712***678';

type Capture = { output: string; restore: () => void };

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

describe('the SMS simulation log says what happened without the code', () => {
  it('sendCodeViaSms simulates with the masked recipient and NO code', async () => {
    const mod = await import('../auth.ts');
    const capture = captureConsoleOutput();
    let result: { success: boolean; message: string };
    try {
      result = await mod.sendCodeViaSms(PHONE, OTP, 'OTP', `Your Return4me code is ${OTP}.`);
    } finally {
      capture.restore();
    }

    // Delivery semantics are unchanged: the sandbox still reports the simulation
    // as success so local/dev flows keep working.
    expect(result.success).toBe(true);
    // The signal a developer and the existing suite rely on is still there...
    expect(capture.output).toContain('SIMULATION, DEV/SANDBOX ONLY');
    // ...the existing phone masking is preserved...
    expect(capture.output).toContain(MASKED_PHONE);
    expect(capture.output).not.toContain(PHONE);
    // ...and the credential is not printed.
    expect(capture.output).not.toContain(OTP);
  });

  it('AuthService.sendSms simulates without printing the message (pickup-code path)', async () => {
    const mod = await import('../auth.ts');
    const capture = captureConsoleOutput();
    let delivered: boolean;
    try {
      delivered = await mod.AuthService.sendSms(
        PHONE,
        `Your Return4me pickup code is ${PICKUP_CODE}. Do not share it with anyone.`,
      );
    } finally {
      capture.restore();
    }

    expect(delivered).toBe(true);
    expect(capture.output).toContain('[SMS GATEWAY - SIMULATION]');
    expect(capture.output).toContain(MASKED_PHONE);
    // Neither the code nor the sentence that carries it reaches the log.
    expect(capture.output).not.toContain(PICKUP_CODE);
    expect(capture.output).not.toContain('pickup code');
  });
});

describe('production SMS behaviour is unchanged', () => {
  it('still fails closed and prints no simulation banner and no code', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    // Satisfy the db/index.ts production boot guard; the DB is never used here.
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?sslmode=require';
    try {
      const mod = await import('../auth.ts');
      const capture = captureConsoleOutput();
      let result: { success: boolean };
      try {
        result = await mod.sendCodeViaSms(PHONE, OTP, 'OTP', `Your Return4me code is ${OTP}.`);
      } finally {
        capture.restore();
      }

      // The fail-closed contract itself: never a simulated success in production.
      expect(result.success).toBe(false);
      expect(capture.output).toContain('Not claiming delivery');
      expect(capture.output).not.toContain('SIMULATION');
      expect(capture.output).not.toContain(OTP);
    } finally {
      process.env.NODE_ENV = previous;
      delete process.env.DATABASE_URL;
    }
  });
});
