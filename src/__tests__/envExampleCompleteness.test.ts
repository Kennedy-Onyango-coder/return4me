import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Phase 10 — CONFIGURATION COMPLETENESS.
//
// Why this exists: two environment variables were read by the application but
// documented nowhere (.env.example), which is how an operator could configure
// every visible credential and still get a silently broken deployment:
//
//   SMS_ENABLED                (F-3) — without it, zero OTPs and zero pickup
//                                     codes are delivered, in production,
//                                     while the credentials look complete.
//   ENABLE_DEV_PAYMENT_SIMULATION (F-4) — a development-only gate that fakes an
//                                     authoritative payment confirmation.
//
// and PORT (F-INFO-9) was not configurable at all before this phase, so it was
// not documented either.
//
// This test makes the omission structural rather than accidental: any
// process.env read inside the configuration areas below must either appear in
// .env.example or be on the explicit allow-list of intentional implementation
// details, so a future flag cannot be introduced invisibly.

const REPO_ROOT = path.resolve(__dirname, '../..');
const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');

/** The configuration areas this phase touched, plus where the flags are read. */
const CONFIG_AREA_FILES = [
  'src/server.ts',
  'src/services/auth.ts',
  'src/main.tsx',
  'src/config/serverPort.ts',
  'src/config/sentryDsn.ts',
  'src/services/escrowFunds.ts',
];

/**
 * Variables deliberately NOT documented in .env.example because they are not
 * deployment configuration the operator sets:
 *   NODE_ENV            — set by the runtime/platform, not by .env
 *   GCE_METADATA_HOST   — forced to 'none' by services/ocr.ts (an internal
 *   GCP_METADATA_HOST     guard, not a user-facing setting)
 */
const ALLOW_LISTED_INTERNAL = ['NODE_ENV', 'GCE_METADATA_HOST', 'GCP_METADATA_HOST'];

function documentedKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}

function usedKeysIn(source: string): Set<string> {
  const keys = new Set<string>();
  // process.env.NAME
  for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(match[1]);
  // import.meta.env.VITE_NAME (browser bundle)
  for (const match of source.matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)) keys.add(match[1]);
  return keys;
}

const documented = documentedKeys(envExample);
const used = new Set<string>();
for (const relative of CONFIG_AREA_FILES) {
  const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  for (const key of usedKeysIn(source)) used.add(key);
}

describe('.env.example documents every variable the configuration areas read', () => {
  it('finds environment variables to check (guards against a silently broken scan)', () => {
    expect(used.size).toBeGreaterThan(10);
  });

  it('documents every used variable, or explicitly allow-lists it', () => {
    const undocumented = [...used]
      .filter((key) => !documented.has(key))
      .filter((key) => !ALLOW_LISTED_INTERNAL.includes(key))
      .sort();

    expect(
      undocumented,
      `These variables are read by the application but are not documented in .env.example ` +
      `and are not on the internal allow-list: ${undocumented.join(', ')}. ` +
      `Add them to .env.example (or justify them in ALLOW_LISTED_INTERNAL).`,
    ).toEqual([]);
  });

  it('does not document a variable it then never reads (stale documentation)', () => {
    // Only asserted for the three flags this phase is responsible for, so the
    // check cannot fail for unrelated historical entries.
    for (const key of ['PORT', 'SMS_ENABLED', 'ENABLE_DEV_PAYMENT_SIMULATION']) {
      expect(documented.has(key), `${key} must be documented`).toBe(true);
      expect(used.has(key), `${key} must actually be read by the application`).toBe(true);
    }
  });
});
describe('the newly documented operational flags are explained, not just listed', () => {
  const lines = envExample.split(/\r?\n/);

  /**
   * The contiguous comment block immediately above a `KEY=` line — i.e. the
   * documentation actually attached to that variable.
   *
   * Matching every line that merely MENTIONS the key would be wrong: the useful
   * explanation lives on the surrounding lines, which mostly do not repeat the
   * variable name (e.g. the PORT block's validation range and default are
   * written on lines that never say "PORT"). This walks upward from the
   * assignment until it hits real content.
   */
  function documentationBlockFor(key: string): string {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index === -1) return '';
    const collected: string[] = [];
    for (let i = index - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.trim() === '') {
        collected.unshift(line);
        continue;
      }
      if (!line.trim().startsWith('#')) break;
      collected.unshift(line);
    }
    return collected.join('\n');
  }

  it('documents PORT, including the default and the strict validation range', () => {
    expect(envExample).toMatch(/^PORT=/m);
    const doc = documentationBlockFor('PORT');
    expect(doc.length).toBeGreaterThan(0);
    expect(doc).toContain('65535');
    expect(doc).toContain('3000');
  });

  it('documents SMS_ENABLED, including that it gates live dispatch and fails closed', () => {
    expect(envExample).toMatch(/^SMS_ENABLED=/m);
    const doc = documentationBlockFor('SMS_ENABLED');
    expect(doc.length).toBeGreaterThan(0);
    expect(doc).toContain('true');
    expect(doc.toLowerCase()).toContain('fail');
  });

  it('documents ENABLE_DEV_PAYMENT_SIMULATION as development/test-only', () => {
    expect(envExample).toMatch(/^ENABLE_DEV_PAYMENT_SIMULATION=/m);
    const doc = documentationBlockFor('ENABLE_DEV_PAYMENT_SIMULATION');
    expect(doc.length).toBeGreaterThan(0);
    expect(doc).toContain('DEVELOPMENT');
    expect(doc).toContain('ALLOW_MOCK_OTP_BYPASS');
    expect(doc).toContain('production');
  });

  it('ships both dev and payment gates disabled by default', () => {
    // A template that enables a money-simulating flag by default would be a
    // hazard; all three dev gates must default to false.
    expect(envExample).toMatch(/^SMS_ENABLED="false"/m);
    expect(envExample).toMatch(/^ENABLE_DEV_PAYMENT_SIMULATION="false"/m);
    expect(envExample).toMatch(/^ALLOW_MOCK_OTP_BYPASS="false"/m);
  });

  it('preserves the REPLACE_WITH_* placeholder convention for credentials', () => {
    for (const key of ['JWT_SECRET', 'ADMIN_PASSCODE', 'DOC_HASH_SALT', 'INTASEND_SECRET_KEY']) {
      const line = lines.find((candidate) => candidate.startsWith(`${key}=`));
      expect(line, `${key} must still be present`).toBeDefined();
      expect(line).toContain('REPLACE_WITH');
    }
  });
});

