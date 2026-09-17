import { describe, it, expect } from 'vitest';
import {
  sentryDsnProblem,
  isSentryDsnUsable,
  sentryDsnProblemLabel,
} from '../sentryDsn';

// Phase 10 (F-5). Both Sentry bootstrap paths (server.ts and main.tsx) used to
// decide with a guard that only rejected an empty value and the substring
// 'REPLACE_WITH', then printed "initialized successfully" merely because
// Sentry.init() had not thrown. Sentry.init() does NOT throw on an unusable DSN
// — it logs its own warning and returns — so the app announced error tracking as
// live while no event could be delivered.
//
// These tests pin the replacement policy, including the exact configurations
// that were observed in this repository (the REPLACE_WITH_* template from
// .env.example, and the bare word 'placeholder' from a local .env).

describe('sentryDsnProblem — classifying a Sentry DSN', () => {
  it('accepts a well-formed DSN', () => {
    expect(sentryDsnProblem('https://abc123def456@o4506123456789.ingest.sentry.io/4506123456789')).toBeNull();
    expect(isSentryDsnUsable('https://abc123def456@o4506123456789.ingest.sentry.io/4506123456789')).toBe(true);
  });

  it('accepts the DSN variants the provider actually issues', () => {
    const plausible = [
      // regional ingest host
      'https://key@o1.ingest.us.sentry.io/42',
      // DSN carrying a secret key (key:secret@host)
      'https://publickey:secretkey@o1.ingest.sentry.io/42',
      // explicit port
      'https://key@localhost:9000/42',
      // trailing slash
      'https://key@o1.ingest.sentry.io/42/',
      // newer slug-style project identifier
      'https://key@o1.ingest.sentry.io/my-project',
      // http for a self-hosted instance
      'http://key@self-hosted.internal/3',
    ];
    for (const dsn of plausible) {
      expect(sentryDsnProblem(dsn), `expected ${dsn} to be accepted`).toBeNull();
    }
  });

  it("classifies the repository's REPLACE_WITH_* template as a placeholder", () => {
    // Exactly the value shipped in .env.example.
    expect(sentryDsnProblem('REPLACE_WITH_SENTRY_DSN_BACKEND')).toBe('placeholder');
    expect(sentryDsnProblem('REPLACE_WITH_VITE_SENTRY_DSN_FRONTEND')).toBe('placeholder');
    expect(isSentryDsnUsable('REPLACE_WITH_SENTRY_DSN_BACKEND')).toBe(false);
  });

  it("classifies the bare word 'placeholder' as unusable", () => {
    // This is the value observed in the local .env during the Phase 10 audit.
    // The OLD guard accepted it (it is non-empty and contains no
    // 'REPLACE_WITH'), initialised Sentry with it, and then reported success
    // while the SDK printed "Invalid Sentry Dsn: placeholder". That exact false
    // success is what this assertion prevents from returning.
    //
    // It classifies as 'placeholder' rather than 'malformed' because this
    // repository uses the literal word "placeholder" as a template value (see
    // the local .env), so the reservation about template values is the more
    // accurate of the two reasons. The substantive assertion is the boolean.
    const oldGuardWouldEnable = (dsn: string) => !!dsn && !dsn.includes('REPLACE_WITH') && dsn.trim() !== '';
    expect(oldGuardWouldEnable('placeholder')).toBe(true);
    expect(isSentryDsnUsable('placeholder')).toBe(false);
    expect(sentryDsnProblem('placeholder')).toBe('placeholder');
  });

  it('classifies missing or empty values as missing', () => {
    expect(sentryDsnProblem(undefined)).toBe('missing');
    expect(sentryDsnProblem(null)).toBe('missing');
    expect(sentryDsnProblem('')).toBe('missing');
    expect(sentryDsnProblem('   ')).toBe('missing');
    expect(sentryDsnProblem(42)).toBe('missing');
  });

  it('classifies MY_* template values as placeholders', () => {
    expect(sentryDsnProblem('MY_SENTRY_DSN')).toBe('placeholder');
    expect(sentryDsnProblem('my_sentry_dsn_backend')).toBe('placeholder');
  });

  it('classifies structurally invalid values as malformed', () => {
    for (const bad of [
      'not-a-dsn',
      'https://o1.ingest.sentry.io/42',      // no public key
      'https://key@',                        // no host
      'https://key@o1.ingest.sentry.io',     // no project path
      'ftp://key@o1.ingest.sentry.io/42',    // wrong scheme
      'https://key@o1.ingest.sentry.io/42 extra',
    ]) {
      expect(sentryDsnProblem(bad), `expected ${bad} to be malformed`).toBe('malformed');
    }
  });

  it('is case-insensitive about placeholder markers', () => {
    expect(sentryDsnProblem('replace_with_sentry_dsn')).toBe('placeholder');
    expect(sentryDsnProblem('Replace_With_Sentry_Dsn')).toBe('placeholder');
  });

  it('reports a non-empty human-readable reason for every problem', () => {
    for (const problem of ['missing', 'placeholder', 'malformed'] as const) {
      const label = sentryDsnProblemLabel(problem);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
