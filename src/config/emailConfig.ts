// EMAIL TRANSPORT CONFIGURATION.
//
// ONE module decides the three things that were previously decided inline (and
// inconsistently) inside `services/email.ts`:
//   * which From address the platform sends as,
//   * whether a Reply-To is advertised, and
//   * whether PRODUCTION is allowed to boot at all without a working provider.
//
// WHY A SEPARATE MODULE (and why an injected env object): this mirrors
// `adminNotificationEmail.ts`, which resolves its address from an injected env
// so the rule is unit-testable without mutating the real process environment.
// The boot guard must apply exactly the same rules the transport applies —
// duplicating them is how a deployment ends up "validated" against a rule the
// sender does not actually follow.
//
// PLACEHOLDERS COUNT AS MISSING. `.env.example` ships
// RESEND_API_KEY="REPLACE_WITH_RESEND_API_KEY". The previous check only rejected
// an empty string, the literal name `RESEND_API_KEY`, or a value containing
// `your_` — so a deployment that copied `.env.example` verbatim built a REAL
// Resend SDK client whose API key was the literal text
// "REPLACE_WITH_RESEND_API_KEY", issued a real outbound HTTPS request to a third
// party, and relied on Resend answering 401 to avoid an actual send. The
// placeholder test now lives here, once, and is used by both the sender and the
// boot guard.

export type EmailEnv = Record<string, string | undefined>;

/** Resend's shared sandbox sender. It only delivers to the account owner. */
export const RESEND_TEST_SENDER = 'onboarding@resend.dev';

/**
 * The platform's own verified-domain sender.
 *
 * `return4me.co.ke` is the domain verified in Resend, so an address at that
 * domain is what production must send from. The DISPLAY NAME is part of the
 * value on purpose: on a phone's collapsed inbox list an address-only From is
 * read as suspicious, and this is the one line of every message a recipient
 * sees before trusting it.
 */
export const DEFAULT_FROM_EMAIL = 'Return4me <no-reply@return4me.co.ke>';

/** The published support mailbox; also the footer address of every template. */
export const DEFAULT_REPLY_TO_EMAIL = 'support@return4me.co.ke';

/**
 * Substrings that mark a value as documentation text rather than a credential.
 *
 * Deliberately NOT including short generic fragments such as `MY_`: a test
 * fixture key (e.g. `MY_TEST_ONLY_FAKE_RESEND_API_KEY`) is intentionally
 * non-placeholder so the transport still constructs a (mocked) client, and a
 * genuine key would never contain these markers.
 */
const PLACEHOLDER_MARKERS = [
  'REPLACE_WITH',
  'PLACEHOLDER',
  'CHANGEME',
  'EXAMPLE',
  'YOUR_',
];

/** Trims, and drops one layer of wrapping quotes a dashboard may have kept. */
function normalize(value: string | undefined): string | null {
  if (value === undefined || value === null) return null;
  let text = String(value).trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      text = text.slice(1, -1).trim();
    }
  }
  return text;
}

/**
 * Is this a value that could actually authenticate against Resend?
 *
 * Shared by the transport (`getResendClient`) and the boot guard so the two can
 * never disagree about whether the platform is configured.
 */
export function isConfiguredResendApiKey(apiKey: string | undefined | null): boolean {
  const value = normalize(apiKey ?? undefined);
  if (value === null || value === '') return false;
  if (value === 'RESEND_API_KEY') return false;
  const upper = value.toUpperCase();
  if (PLACEHOLDER_MARKERS.some((marker) => upper.includes(marker))) return false;
  // A real Resend key is 36+ characters. A short stub cannot authenticate, and
  // treating it as configured is what causes a live request driven by a typo.
  if (value.length < 12) return false;
  return true;
}

/**
 * The From address, in precedence order:
 *   1. `EMAIL_FROM`          — the canonical name.
 *   2. `RESEND_FROM_EMAIL`   — the legacy alias, still honoured so an existing
 *                              deployment does not silently change sender.
 *   3. `DEFAULT_FROM_EMAIL`  — the verified-domain platform sender.
 *
 * An explicitly configured value is returned as-is (including Resend's sandbox
 * sender): the operator's explicit choice is respected, and
 * `emailTransportDiagnostics()` reports it so the choice is visible rather than
 * silently overridden.
 */
export function resolveEmailFrom(env: EmailEnv = process.env): string {
  const canonical = normalize(env.EMAIL_FROM);
  if (canonical) return canonical;
  const legacy = normalize(env.RESEND_FROM_EMAIL);
  if (legacy) return legacy;
  return DEFAULT_FROM_EMAIL;
}

/**
 * The Reply-To address.
 *
 * Defaults to the support mailbox (the same address printed in every template
 * footer) so a reply reaches a human instead of the unattended no-reply sender.
 * An EXPLICITLY empty value (`EMAIL_REPLY_TO=""`) or an off-switch (`none`,
 * `off`, `false`, `disabled`) suppresses the header entirely, which is what a
 * deployment with no monitored mailbox should do rather than advertise a
 * mailbox that bounces.
 */
export function resolveEmailReplyTo(env: EmailEnv = process.env): string | null {
  const raw = normalize(env.EMAIL_REPLY_TO);
  if (raw === null) return DEFAULT_REPLY_TO_EMAIL;
  if (raw === '') return null;
  if (/^(none|off|false|disabled)$/i.test(raw)) return null;
  return raw;
}

export type EmailTransportDiagnostics = {
  /** True when a usable RESEND_API_KEY is present. */
  apiKeyConfigured: boolean;
  /** The From address that will actually be sent, after precedence. */
  from: string;
  /** The Reply-To address, or null when suppressed. */
  replyTo: string | null;
  /** True when the resolved From is Resend's sandbox sender. */
  usingResendTestSender: boolean;
  /** Human-readable reasons the transport is not production-ready. */
  problems: string[];
};

/** Inspects the environment without sending anything. */
export function emailTransportDiagnostics(env: EmailEnv = process.env): EmailTransportDiagnostics {
  const apiKeyConfigured = isConfiguredResendApiKey(env.RESEND_API_KEY);
  const from = resolveEmailFrom(env);
  const replyTo = resolveEmailReplyTo(env);
  const usingResendTestSender = from.toLowerCase().includes(RESEND_TEST_SENDER);

  const problems: string[] = [];
  if (!apiKeyConfigured) {
    problems.push('RESEND_API_KEY is missing, empty or still a placeholder value.');
  }
  if (usingResendTestSender) {
    problems.push(
      `The sender is Resend's shared test address (${RESEND_TEST_SENDER}). It can only deliver to the Resend account owner, ` +
        'so real users would receive nothing. Configure EMAIL_FROM with an address on the verified return4me.co.ke domain.'
    );
  }
  if (!replyTo) {
    problems.push('No Reply-To is configured, so replies to a message go to an unattended mailbox.');
  }

  return { apiKeyConfigured, from, replyTo, usingResendTestSender, problems };
}

/**
 * Boot-time verification of the transactional email transport.
 *
 * PRODUCTION: throws when no usable RESEND_API_KEY is present. There is no
 * console outbox in production (the transport fails closed), so a production
 * deployment without a provider cannot send ANY transactional email — not an
 * activation link, not a payment confirmation, not a handover notice. Starting
 * anyway would serve traffic while silently unable to complete those flows, and
 * that is strictly worse than refusing to start.
 *
 * NON-PRODUCTION: never throws. It warns, because the dev/test transport has a
 * deliberate console outbox that makes an unconfigured machine fully workable.
 *
 * A resolvable-but-risky configuration (the sandbox sender, no Reply-To) warns
 * in BOTH modes rather than throwing: it can still deliver, and an operator
 * running a staging deployment is allowed to choose it.
 *
 * The caller decides fatality (see `startServer()` in server.ts): this function
 * stays pure so it can be unit-tested and never kills a test process.
 */
export function assertEmailTransportConfiguration(env: EmailEnv = process.env): EmailTransportDiagnostics {
  const diagnostics = emailTransportDiagnostics(env);

  if (env.NODE_ENV !== 'production') {
    if (!diagnostics.apiKeyConfigured) {
      console.warn(
        '[EMAIL CONFIG] RESEND_API_KEY is not configured. Non-production email goes to the console outbox ' +
          '(see [DEV MAIL LOG] / [SANDBOX EMAIL OUTBOX]); nothing leaves this machine.'
      );
    }
    for (const problem of diagnostics.problems) {
      if (problem.startsWith('RESEND_API_KEY')) continue; // already reported above
      console.warn(`[EMAIL CONFIG] WARNING: ${problem}`);
    }
    return diagnostics;
  }

  if (!diagnostics.apiKeyConfigured) {
    throw new Error(
      'RESEND_API_KEY is missing, empty or a placeholder. Production transactional email cannot be delivered, ' +
        'and the transport fails closed rather than reporting a send that never happened. ' +
        'Configure a real Resend API key (or run with NODE_ENV set to development for the console outbox).'
    );
  }

  for (const problem of diagnostics.problems) {
    console.warn(`[EMAIL CONFIG] WARNING (production): ${problem}`);
  }
  console.log(
    `[EMAIL CONFIG] Transactional email ready. From: ${diagnostics.from} | Reply-To: ${diagnostics.replyTo ?? '(none)'}`
  );
  return diagnostics;
}
