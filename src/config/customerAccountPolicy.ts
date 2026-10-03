// =============================================================================
// BATCH 2 - CUSTOMER ACCOUNT DATA & SESSION SECURITY (policy).
//
// PURE: no db, no react, no express. The single place a session timeout is
// defined, a device label is derived from a User-Agent, and every customer-facing
// string for this batch lives. Routes and the auth boundary read from here, so a
// timeout number can never be duplicated across handlers.
//
// WHY THE TIMEOUT IS HERE AND NOT IN A HANDLER
//   `requireCustomerAuth` is the single customer authorization boundary, so the
//   idle rule is enforced in ONE place. Handlers cannot disagree with it and
//   cannot opt out of it.
//
// RELATIONSHIP TO THE EXISTING ABSOLUTE LIFETIME
//   A customer session already expires absolutely after
//   CUSTOMER_SESSION_TTL_MS (7 days). An inactivity rule is only meaningful if
//   it is STRICTER than that, or it could never fire: three days of idle is well
//   inside the seven-day absolute window, so a stolen-but-abandoned session dies
//   sooner than a session that is still being used. A session that is actively
//   used keeps refreshing `last_seen_at` on every authenticated request, so an
//   active customer is never logged out by this rule.
// =============================================================================

/**
 * Idle window after which a customer session stops being accepted.
 *
 * Chosen deliberately shorter than CUSTOMER_SESSION_TTL_MS (the absolute 7-day
 * lifetime in services/customerAuth.ts) so that inactivity is the stricter of
 * the two rules and therefore the one that actually governs a stolen session.
 * Deliberately NOT scattered through route handlers.
 */
export const CUSTOMER_SESSION_INACTIVITY_TIMEOUT_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * Whether a session has been idle beyond the configured window.
 *
 * STRICT `<`: a session is rejected only once the idle duration is strictly
 * greater than the timeout, so a session sitting exactly at the boundary is
 * still accepted. The comparison is made on a caller-supplied `now` so the
 * boundary is testable to the millisecond rather than only in practice.
 *
 * A NULL `lastSeenAt` means the column was never written (a row created before
 * the activity clock existed). That is treated as NOT idle rather than as
 * infinitely idle: guessing "expired" would lock out legacy sessions on the
 * strength of a missing value, which is the wrong direction to fail.
 */
export function isSessionIdle(lastSeenAt: Date | string | null | undefined, now: Date): boolean {
  if (!lastSeenAt) return false;
  const t = lastSeenAt instanceof Date ? lastSeenAt.getTime() : new Date(lastSeenAt).getTime();
  if (Number.isNaN(t)) return false;
  return now.getTime() - t > CUSTOMER_SESSION_INACTIVITY_TIMEOUT_MS;
}

// -----------------------------------------------------------------------------
// DEVICE LABELS
//
// The raw User-Agent is stored (it is the only honest evidence of what device a
// session belongs to) but is NOT returned to the customer: it is a long,
// brittle fingerprint that names browser builds and is useless to the person
// trying to decide whether a session is theirs. This derives the short label a
// customer actually recognises instead.
// -----------------------------------------------------------------------------

export interface DeviceLabel {
  /** Short human label, e.g. "Chrome on Android". */
  label: string;
  /** Coarse family, used for grouping/ordering in the UI. */
  platform: 'mobile' | 'tablet' | 'desktop' | 'unknown';
  browser: string;
}

/**
 * Derive a customer-safe device label from a User-Agent.
 *
 * Recognises only the handful of families a Return4me customer is likely to
 * sign in from. An unrecognised agent yields an honest "Unknown device" rather
 * than an empty string, because a blank row would be worse than an uninformative
 * one: the customer still needs to tell their sessions apart by last-seen time.
 *
 * Purely a presentation transform. It never returns any part of the raw agent.
 */
export function deriveDeviceLabel(userAgent: string | null | undefined): DeviceLabel {
  const ua = (userAgent ?? '').toLowerCase();
  if (!ua.trim()) {
    return { label: 'Unknown device', platform: 'unknown', browser: 'Unknown' };
  }

  const browser = (() => {
    // Order matters: Edge and Chrome both advertise "Safari", and several
    // in-app browsers advertise "Chrome", so the more specific token is tested
    // first.
    if (ua.includes('edg/') || ua.includes('edge')) return 'Edge';
    if (ua.includes('opr/') || ua.includes('opera')) return 'Opera';
    if (ua.includes('firefox')) return 'Firefox';
    if (ua.includes('samsungbrowser')) return 'Samsung Internet';
    if (ua.includes('crios')) return 'Chrome';
    if (ua.includes('chrome')) return 'Chrome';
    if (ua.includes('safari')) return 'Safari';
    return 'Unknown';
  })();

  const platform = (() => {
    if (ua.includes('ipad') || ua.includes('tablet')) return 'tablet';
    if (ua.includes('mobi') || ua.includes('iphone') || ua.includes('android')) return 'mobile';
    if (ua.includes('windows') || ua.includes('macintosh') || ua.includes('linux')) return 'desktop';
    return 'unknown';
  })();

  const os = (() => {
    if (ua.includes('windows')) return 'Windows';
    if (ua.includes('iphone') || ua.includes('ipad')) return 'iOS';
    if (ua.includes('android')) return 'Android';
    if (ua.includes('macintosh') || ua.includes('mac os')) return 'macOS';
    if (ua.includes('linux')) return 'Linux';
    return 'Unknown system';
  })();

  const label = browser === 'Unknown' || platform === 'unknown'
    ? (os === 'Unknown system' ? 'Unknown device' : os)
    : browser + ' on ' + os;
  return { label, platform, browser };
}

// -----------------------------------------------------------------------------
// CUSTOMER-FACING STRINGS (BATCH 2 section 7)
//
// Plain service language only. No architecture, transport or infrastructure
// vocabulary, and specifically none of: AI, escrow, API, webhook, provider,
// retry, OCR.
// -----------------------------------------------------------------------------

export const CUSTOMER_ACCOUNT_STRINGS = {
  sessionIdle: {
    en: 'You have been signed out because you have not used your account for a while. Please sign in again.',
    sw: 'Umeondolewa kwa sababu hukuutumii akaunti yako kwa muda mrefu. Tafadhali ingia tena.',
  },
  revokeOthersDone: {
    en: 'You have been signed out on all your other devices.',
    sw: 'Umeondolewa kwenye vifaa vyako vyote vingine.',
  },
  erasureStarted: {
    en: 'Your request has been received. Your personal details have been removed while the records we must keep for legal and financial reasons have been kept.',
    sw: 'Ombi lako limepokelewa. Taarifa zako za binafsi zimeondolewa huku rekodi tunazopaswa kuhifadhi kwa sababu za kisheria na fedha zimebaki.',
  },
  nameUpdated: {
    en: 'Your name has been updated.',
    sw: 'Jina lako limebadilishwa.',
  },
  identityVerificationSent: {
    en: 'We have sent a verification message. Your current details stay unchanged until you complete it.',
    sw: 'Tumetumia ujumbe wa uthibitisho. Taarifa zako za sasa zinabaki hazibadilishwi hadi uukamilishe.',
  },
} as const;

// -----------------------------------------------------------------------------
// IDENTITY CHANGE (G3)
// -----------------------------------------------------------------------------

/** Which identifier a pending identity change is for. */
export type CustomerIdentityKind = 'email' | 'phone';

export const CUSTOMER_IDENTITY_KINDS: readonly CustomerIdentityKind[] = ['email', 'phone'];

/** How long an unverified identity change stays valid before it must be retried. */
export const IDENTITY_CHANGE_VERIFICATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Whether an identity change has been verified and may become authoritative.
 *
 * Single-use and time-bounded: the same predicate decides both whether a
 * verification code may be redeemed and whether a pending change may be applied,
 * so there is no window in which an expired change could still be applied.
 */
export function isIdentityChangeUsable(row: {
  expires_at: Date | string | null | undefined;
  consumed_at: Date | string | null | undefined;
} | null | undefined, now: Date): boolean {
  if (!row) return false;
  if (row.consumed_at) return false;
  if (!row.expires_at) return false;
  return new Date(row.expires_at).getTime() > now.getTime();
}
