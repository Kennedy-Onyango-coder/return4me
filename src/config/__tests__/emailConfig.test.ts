import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_FROM_EMAIL,
  DEFAULT_REPLY_TO_EMAIL,
  RESEND_TEST_SENDER,
  assertEmailTransportConfiguration,
  emailTransportDiagnostics,
  isConfiguredResendApiKey,
  resolveEmailFrom,
  resolveEmailReplyTo,
} from '../emailConfig';

// TRANSACTIONAL EMAIL TRANSPORT CONFIGURATION (Resend).
//
// `config/emailConfig.ts` decides three things that were previously decided
// inline (and inconsistently) inside `services/email.ts`: which From address the
// platform sends as, whether a Reply-To is advertised, and whether PRODUCTION is
// allowed to boot at all without a working provider. `startServer()` in
// server.ts now calls `assertEmailTransportConfiguration()`, which makes the
// third decision fatal in production.
//
// These tests pin the policy through the INJECTED env object, so no assertion
// depends on (or mutates) the real process environment. The fixture key is the
// same one the delivery tests use: deliberately NOT a placeholder marker, so the
// transport is treated as configured, while being obviously fake.

/** A syntactically usable key that contains no placeholder marker. */
const FAKE_KEY = 'MY_TEST_ONLY_FAKE_RESEND_API_KEY';

/** Silence the guard's own diagnostics so a failing expectation is readable. */
function silentConsole() {
  return {
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isConfiguredResendApiKey — a placeholder is not a credential', () => {
  it('accepts a key that could actually authenticate', () => {
    expect(isConfiguredResendApiKey(FAKE_KEY)).toBe(true);
  });

  it('rejects absent, empty and whitespace-only values', () => {
    expect(isConfiguredResendApiKey(undefined)).toBe(false);
    expect(isConfiguredResendApiKey(null)).toBe(false);
    expect(isConfiguredResendApiKey('')).toBe(false);
    expect(isConfiguredResendApiKey('   ')).toBe(false);
  });

  it('rejects the literal variable name and the .env.example placeholder', () => {
    expect(isConfiguredResendApiKey('RESEND_API_KEY')).toBe(false);
    expect(isConfiguredResendApiKey('REPLACE_WITH_RESEND_API_KEY')).toBe(false);
  });

  it('rejects documentation text a dashboard may have exported', () => {
    expect(isConfiguredResendApiKey('your_resend_api_key_here')).toBe(false);
    expect(isConfiguredResendApiKey('CHANGEME')).toBe(false);
    expect(isConfiguredResendApiKey('example-key-value')).toBe(false);
  });

  it('rejects a stub too short to authenticate', () => {
    expect(isConfiguredResendApiKey('re_123')).toBe(false);
  });

  it('unwraps a value still carrying the dashboard quote marks', () => {
    expect(isConfiguredResendApiKey(`"${FAKE_KEY}"`)).toBe(true);
    expect(isConfiguredResendApiKey(`'${FAKE_KEY}'`)).toBe(true);
  });
});

describe('resolveEmailFrom — precedence', () => {
  it('prefers EMAIL_FROM', () => {
    expect(resolveEmailFrom({ EMAIL_FROM: 'a@return4me.co.ke', RESEND_FROM_EMAIL: 'b@return4me.co.ke' }))
      .toBe('a@return4me.co.ke');
  });

  it('still honours the legacy RESEND_FROM_EMAIL so a live sender never changes silently', () => {
    expect(resolveEmailFrom({ RESEND_FROM_EMAIL: 'legacy@return4me.co.ke' })).toBe('legacy@return4me.co.ke');
  });

  it('falls back to the platform sender when neither is set', () => {
    expect(resolveEmailFrom({})).toBe(DEFAULT_FROM_EMAIL);
    expect(resolveEmailFrom({ EMAIL_FROM: '   ', RESEND_FROM_EMAIL: '' })).toBe(DEFAULT_FROM_EMAIL);
  });
});

describe('resolveEmailReplyTo — a reply must reach a human or be suppressed', () => {
  it('defaults to the support mailbox', () => {
    expect(resolveEmailReplyTo({})).toBe(DEFAULT_REPLY_TO_EMAIL);
  });

  it('honours an explicit mailbox', () => {
    expect(resolveEmailReplyTo({ EMAIL_REPLY_TO: 'help@return4me.co.ke' })).toBe('help@return4me.co.ke');
  });

  it('suppresses the header on an empty value or an off-switch', () => {
    expect(resolveEmailReplyTo({ EMAIL_REPLY_TO: '' })).toBeNull();
    for (const off of ['none', 'off', 'false', 'disabled', 'NONE', 'Disabled']) {
      expect(resolveEmailReplyTo({ EMAIL_REPLY_TO: off }), `EMAIL_REPLY_TO=${off}`).toBeNull();
    }
  });
});

describe('emailTransportDiagnostics — inspects without sending', () => {
  it('reports a fully unconfigured transport', () => {
    const d = emailTransportDiagnostics({});
    expect(d.apiKeyConfigured).toBe(false);
    expect(d.from).toBe(DEFAULT_FROM_EMAIL);
    expect(d.replyTo).toBe(DEFAULT_REPLY_TO_EMAIL);
    expect(d.usingResendTestSender).toBe(false);
    expect(d.problems.some((p) => p.startsWith('RESEND_API_KEY'))).toBe(true);
  });

  it('flags the sandbox sender, because it only delivers to the key owner', () => {
    const d = emailTransportDiagnostics({ RESEND_API_KEY: FAKE_KEY, EMAIL_FROM: RESEND_TEST_SENDER });
    expect(d.usingResendTestSender).toBe(true);
    expect(d.problems.some((p) => p.includes(RESEND_TEST_SENDER))).toBe(true);
  });

  it('flags a suppressed Reply-To', () => {
    const d = emailTransportDiagnostics({ RESEND_API_KEY: FAKE_KEY, EMAIL_REPLY_TO: 'none' });
    expect(d.replyTo).toBeNull();
    expect(d.problems.some((p) => p.includes('Reply-To'))).toBe(true);
  });

  it('reports a production-ready configuration with no problems at all', () => {
    const d = emailTransportDiagnostics({ RESEND_API_KEY: FAKE_KEY, EMAIL_FROM: DEFAULT_FROM_EMAIL });
    expect(d).toEqual({
      apiKeyConfigured: true,
      from: DEFAULT_FROM_EMAIL,
      replyTo: DEFAULT_REPLY_TO_EMAIL,
      usingResendTestSender: false,
      problems: [],
    });
  });
});

describe('assertEmailTransportConfiguration — fatal in production, advisory elsewhere', () => {
  it('refuses to boot in production without a usable key', () => {
    silentConsole();
    expect(() => assertEmailTransportConfiguration({ NODE_ENV: 'production' }))
      .toThrow(/RESEND_API_KEY is missing, empty or a placeholder/);
  });

  it('refuses to boot when the key is still the .env.example placeholder', () => {
    silentConsole();
    expect(() => assertEmailTransportConfiguration({
      NODE_ENV: 'production',
      RESEND_API_KEY: 'REPLACE_WITH_RESEND_API_KEY',
    })).toThrow();
  });

  it('announces readiness when production is fully configured', () => {
    const spies = silentConsole();
    const d = assertEmailTransportConfiguration({ NODE_ENV: 'production', RESEND_API_KEY: FAKE_KEY });
    expect(d.apiKeyConfigured).toBe(true);
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.log).toHaveBeenCalledTimes(1);
    expect(String(spies.log.mock.calls[0][0])).toContain('Transactional email ready');
  });

  it('warns but still boots when production is served by the sandbox sender', () => {
    const spies = silentConsole();
    const d = assertEmailTransportConfiguration({
      NODE_ENV: 'production',
      RESEND_API_KEY: FAKE_KEY,
      EMAIL_FROM: RESEND_TEST_SENDER,
    });
    expect(d.usingResendTestSender).toBe(true);
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(String(spies.warn.mock.calls[0][0])).toContain('WARNING (production)');
  });

  it('never throws outside production — the console outbox keeps the flows testable', () => {
    const spies = silentConsole();
    for (const nodeEnv of ['development', 'test', undefined]) {
      const d = assertEmailTransportConfiguration({ NODE_ENV: nodeEnv });
      expect(d.apiKeyConfigured).toBe(false);
    }
    expect(spies.warn).toHaveBeenCalledTimes(3);
    expect(String(spies.warn.mock.calls[0][0])).toContain('console outbox');
  });

  it('stays quiet when a non-production environment is fully configured', () => {
    const spies = silentConsole();
    assertEmailTransportConfiguration({ NODE_ENV: 'development', RESEND_API_KEY: FAKE_KEY });
    expect(spies.warn).not.toHaveBeenCalled();
  });

  it('returns the diagnostics so a caller can log exactly what it decided', () => {
    silentConsole();
    const d = assertEmailTransportConfiguration({
      NODE_ENV: 'test',
      RESEND_API_KEY: FAKE_KEY,
      EMAIL_FROM: DEFAULT_FROM_EMAIL,
    });
    expect(d.from).toBe(DEFAULT_FROM_EMAIL);
    expect(d.replyTo).toBe(DEFAULT_REPLY_TO_EMAIL);
    expect(d.problems).toEqual([]);
  });
});
