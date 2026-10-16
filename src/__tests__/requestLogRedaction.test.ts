import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// BATCH S1 - THE [HTTP] LOGGER IS REALLY WIRED TO THE REDACTOR.
//
// Behavioural, not a source grep: createApp() (the REAL application) is mounted
// on an ephemeral socket under NODE_ENV=production - the deterministic,
// socket-free branch the P2 suite uses - and requests are made over real HTTP
// while console.log is captured. startServer() is NEVER called, so there is no
// production server, no schema migration, no background sweep and no provider
// contact.
//
// The 512-character bound and the ErrorBoundary -> ErrBoundary sanitisation are
// asserted here too, because both are properties of the WIRING rather than of
// the pure helper (src/utils/__tests__/safeRequestLog.test.ts owns the helper's
// own rules).
//
// A short source-level block follows: it pins the exact call site (the helper is
// imported and called with req.url, the ErrorBoundary replace is applied to the
// REDACTED value, the pre-fix expression is gone, and the SEO planner still
// receives the ORIGINAL req.url). A black-box test cannot distinguish those from
// an equivalent-but-different call site, and the planner half is a correctness
// property that no response body reveals.
// =============================================================================

const { createApp } = await import('../server.ts');

const CUSTOMER_TOKEN = 'r4m-log-wiring-customer-token-9a1c3e';
const AGENT_TOKEN = 'r4m-log-wiring-agent-token-4b8d2f';

let server: any = null;
let base = '';

beforeAll(async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const app = await createApp();
    server = await new Promise<any>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  } finally {
    process.env.NODE_ENV = previous;
  }
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Capture = { output: string; restore: () => void };

/** Same capture pattern as src/services/__tests__/refundLogSafety.test.ts. */
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

/** The URL the logger wrote for a single request to `method` + `pathPart`. */
function loggedUrl(capture: Capture, method: string, pathPart: string): string {
  const prefix = `[HTTP] ${method} `;
  const lines = capture.output
    .split('\n')
    .filter((line) => line.startsWith(prefix) && (line === `[HTTP] ${method} ${pathPart}` || line.startsWith(`[HTTP] ${method} ${pathPart}?`)));
  expect(lines.length, `expected exactly one [HTTP] line for ${method} ${pathPart}`).toBe(1);
  return lines[0].slice(prefix.length);
}

describe('the real request logger cannot write a credential', () => {
  it('logs [REDACTED] for a customer activation link and keeps the diagnostics', async () => {
    const capture = captureConsoleOutput();
    try {
      await fetch(`${base}/activate-email?token=${CUSTOMER_TOKEN}&utm_source=email`);
    } finally {
      capture.restore();
    }

    const url = loggedUrl(capture, 'GET', '/activate-email');
    expect(url).toBe('/activate-email?token=[REDACTED]&utm_source=email');
    expect(capture.output).not.toContain(CUSTOMER_TOKEN);
  });

  it('redacts an AGENT activation link the same way', async () => {
    const capture = captureConsoleOutput();
    try {
      await fetch(`${base}/activate-agent-email?token=${AGENT_TOKEN}`);
    } finally {
      capture.restore();
    }

    expect(loggedUrl(capture, 'GET', '/activate-agent-email')).toBe(
      '/activate-agent-email?token=[REDACTED]',
    );
    expect(capture.output).not.toContain(AGENT_TOKEN);
  });

  it('redacts EVERY occurrence of a duplicated parameter on an API request', async () => {
    const capture = captureConsoleOutput();
    let status: number;
    try {
      const res = await fetch(
        `${base}/api/r4m-s1-no-such-endpoint?token=${CUSTOMER_TOKEN}&token=${AGENT_TOKEN}&page=2`,
      );
      status = res.status;
    } finally {
      capture.restore();
    }

    // The API contract itself is untouched: still a JSON 404 from the terminator.
    expect(status).toBe(404);
    expect(loggedUrl(capture, 'GET', '/api/r4m-s1-no-such-endpoint')).toBe(
      '/api/r4m-s1-no-such-endpoint?token=[REDACTED]&token=[REDACTED]&page=2',
    );
    expect(capture.output).not.toContain(CUSTOMER_TOKEN);
    expect(capture.output).not.toContain(AGENT_TOKEN);
  });

  it('still logs an ordinary path verbatim', async () => {
    const capture = captureConsoleOutput();
    try {
      await fetch(`${base}/api/categories`);
    } finally {
      capture.restore();
    }

    expect(loggedUrl(capture, 'GET', '/api/categories')).toBe('/api/categories');
  });

  it('keeps the existing ErrorBoundary -> ErrBoundary sanitisation', async () => {
    const capture = captureConsoleOutput();
    try {
      await fetch(`${base}/api/r4m-s1-error-boundary?component=ErrorBoundary`);
    } finally {
      capture.restore();
    }

    expect(loggedUrl(capture, 'GET', '/api/r4m-s1-error-boundary')).toBe(
      '/api/r4m-s1-error-boundary?component=ErrBoundary',
    );
    expect(capture.output).not.toContain('ErrorBoundary');
  });

  it('cannot be flooded: the logged URL is capped at 512 characters', async () => {
    const capture = captureConsoleOutput();
    try {
      await fetch(`${base}/api/r4m-s1-long?q=${'a'.repeat(900)}`);
    } finally {
      capture.restore();
    }

    const url = loggedUrl(capture, 'GET', '/api/r4m-s1-long');
    expect(url.length).toBe(512);
    expect(url.endsWith('...[truncated]')).toBe(true);
  });
});

describe('source wiring (what a black-box request cannot distinguish)', () => {
  const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

  it('the logger imports the redactor and calls it on req.url', () => {
    expect(serverTs).toContain("import { redactRequestUrlForLog } from './utils/safeRequestLog'");
    expect(serverTs).toContain('const redactedUrl = redactRequestUrlForLog(req.url);');
    // The ErrorBoundary sanitisation is applied to the REDACTED value.
    expect(serverTs).toContain("const safeUrl = redactedUrl.replace(/ErrorBoundary/gi, 'ErrBoundary');");
    // The pre-fix expression - the raw URL straight into the sanitisation - is gone.
    expect(serverTs).not.toContain("const safeUrl = req.url.replace(/ErrorBoundary/gi, 'ErrBoundary');");
  });

  it('the SEO planner still receives the ORIGINAL req.url', () => {
    // The planner needs the real query string, so redaction must apply to what is
    // LOGGED and never to req.url itself.
    expect(serverTs).toContain("planPageRequest(req.path, queryIndex === -1 ? '' : req.url.slice(queryIndex))");
    expect(serverTs).not.toContain('planPageRequest(req.path, redactRequestUrlForLog');
  });
});
