import { describe, it, expect } from 'vitest';
import {
  parseServerPort,
  resolveServerPort,
  DEFAULT_SERVER_PORT,
  MIN_TCP_PORT,
  MAX_TCP_PORT,
} from '../serverPort';

// Phase 10 (F-1). server.ts used to hardcode `const PORT = 3000;`, so the
// listen port was simply not configurable — a managed container platform
// (Cloud Run) injects PORT and routes traffic/health checks to what it assigned,
// so the app could boot "successfully" and serve nothing. These tests pin the
// replacement contract: strict whole-string parsing, a safe default, and a
// rejection that is REPORTED rather than silently swallowed.
//
// The resolver is a pure function taking the raw value as an argument precisely
// so it can be tested here — server.ts boots the entire application on import
// (Vite middleware, DB migrations, background sweeps, listeners) and cannot be
// imported by a test.

describe('parseServerPort — strict whole-string validation', () => {
  it('accepts a plain valid port', () => {
    expect(parseServerPort('3000')).toBe(3000);
    expect(parseServerPort('8080')).toBe(8080);
  });

  it('accepts the inclusive TCP boundaries', () => {
    expect(parseServerPort(String(MIN_TCP_PORT))).toBe(1);
    expect(parseServerPort(String(MAX_TCP_PORT))).toBe(65535);
  });

  it('rejects every documented invalid example', () => {
    for (const bad of ['abc', '-1', '0', '65536', '1.5', '3000xyz']) {
      expect(parseServerPort(bad), `expected "${bad}" to be rejected`).toBeNull();
    }
  });

  it('rejects whitespace-polluted values instead of trimming them', () => {
    // dotenv already strips surrounding whitespace from real .env values, so a
    // padded value here indicates a genuine misconfiguration. Silently trimming
    // it would hide that.
    for (const bad of [' 3000', '3000 ', ' 3000 ', '\t3000', '3 000', '3000\n']) {
      expect(parseServerPort(bad), `expected ${JSON.stringify(bad)} to be rejected`).toBeNull();
    }
  });

  it('never parses a prefix out of a longer string', () => {
    // The concrete regression this guards against: permissive parseInt() would
    // read all of these as 3000 and boot on a port the operator never asked for.
    expect(parseServerPort('3000xyz')).toBeNull();
    expect(parseServerPort('3000.9')).toBeNull();
    expect(parseServerPort('3000abc')).toBeNull();
    expect(parseServerPort('+3000')).toBeNull();
    expect(parseServerPort('1e3')).toBeNull();
    expect(parseServerPort('0x0BB8')).toBeNull();
  });

  it('rejects out-of-range values', () => {
    // 0 is deliberately invalid: it asks the OS for a random ephemeral port,
    // which is never the address a deployment is reached on.
    expect(parseServerPort('0')).toBeNull();
    expect(parseServerPort('-1')).toBeNull();
    expect(parseServerPort('65536')).toBeNull();
    expect(parseServerPort('999999999')).toBeNull();
  });

  it('rejects absent or non-string input', () => {
    expect(parseServerPort(undefined)).toBeNull();
    expect(parseServerPort(null)).toBeNull();
    expect(parseServerPort('')).toBeNull();
    expect(parseServerPort(3000)).toBeNull();
    expect(parseServerPort({})).toBeNull();
  });

  it('never returns NaN or a non-integer for any rejected input', () => {
    const inputs = ['abc', '-1', '0', '65536', '1.5', '3000xyz', ' 3000 ', '', undefined, null, '1e3', '3 000'];
    for (const input of inputs) {
      const result = parseServerPort(input);
      if (result !== null) {
        expect(Number.isInteger(result)).toBe(true);
        expect(Number.isNaN(result)).toBe(false);
      } else {
        expect(result).toBeNull();
      }
    }
  });
});

describe('resolveServerPort — the port the server actually binds', () => {
  it('falls back to 3000 when PORT is absent, with no rejection to report', () => {
    for (const absent of [undefined, null, '']) {
      const resolution = resolveServerPort(absent);
      expect(resolution.port).toBe(DEFAULT_SERVER_PORT);
      expect(resolution.port).toBe(3000);
      expect(resolution.source).toBe('default');
      // Nothing was ignored, so the caller must not warn.
      expect(resolution.rejectedRawValue).toBeNull();
    }
  });

  it('uses the environment value when it is valid', () => {
    const resolution = resolveServerPort('8080');
    expect(resolution.port).toBe(8080);
    expect(resolution.source).toBe('env');
    expect(resolution.rejectedRawValue).toBeNull();
  });

  it('still uses 3000 when it is explicitly configured as 3000', () => {
    // Local development must be unaffected by this change.
    const resolution = resolveServerPort('3000');
    expect(resolution.port).toBe(3000);
    expect(resolution.source).toBe('env');
  });

  it('falls back to 3000 for an invalid PORT instead of crashing, and reports what was ignored', () => {
    for (const bad of ['abc', '-1', '0', '65536', '1.5', '3000xyz', ' 3000 ']) {
      const resolution = resolveServerPort(bad);
      expect(resolution.port, `expected fallback for "${bad}"`).toBe(DEFAULT_SERVER_PORT);
      expect(resolution.source).toBe('default');
      // The operator must be able to see, in the boot log, exactly what was
      // ignored — a silently swallowed misconfiguration is the defect.
      expect(resolution.rejectedRawValue).toBe(bad.trim());
    }
  });

  it('always resolves to a valid, usable TCP port', () => {
    for (const input of [undefined, null, '', 'abc', '-1', '0', '65536', '1.5', '3000xyz', '8080', '1', '65535']) {
      const { port } = resolveServerPort(input);
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThanOrEqual(MIN_TCP_PORT);
      expect(port).toBeLessThanOrEqual(MAX_TCP_PORT);
    }
  });
});
