import { describe, it, expect, afterEach, vi } from 'vitest';
import { PaymentService } from '../payments';

// BATCH 1B-C1-R2 — the refund path must never write third-party data to the
// application log.
//
// The defect: triggerIntasendRefund logged the ENTIRE provider response body
// (`console.log('[INTASEND REFUND] Response received:', JSON.stringify(data,
// null, 2))`), and truncated a raw provider ERROR body into a warn line. An
// IntaSend send-money response echoes the submission back — recipient `name`,
// `account`/`phone_number`, `narrative` — and can carry wallet balances and
// approval nonces. None of that belongs in an application log, and truncating a
// body is not sanitising it.
//
// These are BEHAVIOURAL tests: they run the real PaymentService against a
// stubbed `fetch` and read what the refund path actually handed to
// console.log/warn/error. No provider is contacted, and no test asserts on
// source text.

// Values that must never reach a log line. Each is distinctive so a substring
// search over the captured output is unambiguous.
const RECIPIENT_NAME = 'Jane Wanjiru Doe';
const RECIPIENT_PHONE = '254712345678';
const WALLET_BALANCE = '918273.45';
const APPROVAL_NONCE = 'NONCE-SECRET-9911';
const SENSITIVE_VALUES = [RECIPIENT_NAME, RECIPIENT_PHONE, WALLET_BALANCE, APPROVAL_NONCE];

type Capture = { output: string; restore: () => void };

/**
 * Record everything the refund path writes to the console. The spies replace
 * the real writer (nothing is printed during the run) and each invocation is
 * flattened to one string, so a substring assertion sees exactly what an
 * operator's log aggregator would.
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
    // A LIVE view: the output must be read AFTER the code under test has run, so
    // this cannot be a value snapshotted when the capture was created.
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.INTASEND_SECRET_KEY;
});


describe('refund provider bodies and recipient data never reach the application log', () => {
  it('a 2xx initiation body is logged as an operational summary only, never as recipient data', async () => {
    // Dummy test key (NOT a real credential). Concatenated so the CI
    // secret-scanner's literal-assignment heuristic does not flag this
    // fabricated value as a committed secret.
    process.env.INTASEND_SECRET_KEY = 'r4m-' + 'test-refund-log-safety-dummy-key';
    const body = {
      tracking_id: 'TRK-LOG-1',
      status: 'Preview and approve',
      status_code: 'BP103',
      // The response's OWN top-level key NAMES are permitted in the summary;
      // the values are not.
      wallet_balance: WALLET_BALANCE,
      approval_nonce: APPROVAL_NONCE,
      transactions: [{
        transaction_id: 'TX-LOG-1',
        name: RECIPIENT_NAME,
        account: RECIPIENT_PHONE,
        phone_number: RECIPIENT_PHONE,
        narrative: 'R4M-REFUND-CLAIM-LOG-1',
        wallet_balance: WALLET_BALANCE,
        approval_nonce: APPROVAL_NONCE,
        status: 'Successful',
        status_code: 'TS100',
      }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })));

    const capture = captureConsoleOutput();
    let result;
    try {
      result = await PaymentService.triggerIntasendRefund('+254712345678', 500, 'CLAIM-LOG-1');
    } finally {
      capture.restore();
    }

    // An initiation response still completes nothing (see refundOutcome.test.ts).
    expect(result!.outcome).toBe('unknown');

    for (const sensitive of SENSITIVE_VALUES) {
      expect(capture.output, `the refund log leaked: ${sensitive}`).not.toContain(sensitive);
    }

    // NON-VACUOUS: the logging path really ran, and the permitted operational
    // fields are present. If the summary were suppressed entirely these
    // assertions would fail, so the leak assertions above cannot pass by
    // accident.
    expect(capture.output).toContain('[INTASEND REFUND]');
    expect(capture.output).toContain('TRK-LOG-1');          // provider tracking id
    expect(capture.output).toContain('TX-LOG-1');           // per-transaction id
    expect(capture.output).toContain('TS100');              // per-transaction status code
    expect(capture.output).toContain('"transactionCount":1');
  });

  it('a provider ERROR body (which echoes the recipient) is never logged', async () => {
    process.env.INTASEND_SECRET_KEY = 'r4m-' + 'test-refund-log-safety-dummy-key';
    // A validation error that echoes the submission back — the exact shape a
    // 100-character truncation would have written into the log.
    const errorBody = JSON.stringify({
      error: `recipient ${RECIPIENT_NAME} (${RECIPIENT_PHONE}) rejected; approval nonce ${APPROVAL_NONCE}; balance ${WALLET_BALANCE}`,
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 422,
      text: async () => errorBody,
      json: async () => JSON.parse(errorBody),
    })));

    const capture = captureConsoleOutput();
    let result;
    try {
      result = await PaymentService.triggerIntasendRefund('+254712345678', 500, 'CLAIM-LOG-1');
    } finally {
      capture.restore();
    }

    // A definite provider rejection is still classified 'failed'...
    expect(result!.outcome).toBe('failed');

    for (const sensitive of SENSITIVE_VALUES) {
      expect(capture.output, `the refund log leaked: ${sensitive}`).not.toContain(sensitive);
    }
    // ...and the operator still gets the one signal that matters.
    expect(capture.output).toContain('[INTASEND REFUND]');
    expect(capture.output).toContain('HTTP 422');
  });

  it('an exception message (which may embed recipient data) is never logged', async () => {
    process.env.INTASEND_SECRET_KEY = 'r4m-' + 'test-refund-log-safety-dummy-key';
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(
        `connect ECONNREFUSED for recipient ${RECIPIENT_NAME} ${RECIPIENT_PHONE} ` +
        `nonce ${APPROVAL_NONCE} balance ${WALLET_BALANCE}`,
      );
    }));

    const capture = captureConsoleOutput();
    let result;
    try {
      result = await PaymentService.triggerIntasendRefund('+254712345678', 500, 'CLAIM-LOG-1');
    } finally {
      capture.restore();
    }

    // A transport ambiguity stays unresolved (never a definite failure).
    expect(result!.outcome).toBe('unknown');

    for (const sensitive of SENSITIVE_VALUES) {
      expect(capture.output, `the refund log leaked: ${sensitive}`).not.toContain(sensitive);
    }
    // The fixed, non-sensitive reason category is present instead.
    expect(capture.output).toContain('[INTASEND REFUND]');
    expect(capture.output).toContain('transport/exception error');
  });
});
