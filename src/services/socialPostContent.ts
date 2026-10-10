// SOCIAL POST CONTENT — THE ONE CANONICAL SOURCE OF PUBLIC POST FACTS AND THE
// TWO PLATFORM FORMATTERS (PHASE 1, D-2B-C SOCIAL REDESIGN)
// ============================================================================
// Facebook and Telegram posts must be two renderings of ONE set of privacy-
// transformed facts. Before this module, each postTo* function assembled its
// own text inline inside social.ts, with the two platforms drifting on labels,
// content and the claim link. Everything a public post may contain is now
// decided once in buildPostFacts() and rendered by formatFacebookPost() /
// formatTelegramPost().
//
// WHAT LIVES HERE
//   * sanitizeSocialText / escapeTelegramHtml — moved VERBATIM from social.ts
//     (re-exported there, so existing import sites and their tests keep
//     working). They are formatting primitives every post consumes.
//   * resolvePublicBaseUrl — the canonical public origin, read from the SAME
//     PUBLIC_APP_URL the activation links use, with the deployed canonical
//     domain as the production fallback. Never a hardcoded development host.
//   * buildReportLink — the REAL supported public entry point
//     `/?claim=<itemId>` (App.tsx translates it to the safe public item page
//     /item/<itemId>; see legacyClaimItemId in utils/publicRoutes.ts). It
//     never carries tokens, phone numbers or internal-only identifiers: the
//     item id is the same public identifier the /item/:id page already uses.
//   * formatReportTimestampKenya — the report's OWN created_at rendered in
//     Africa/Nairobi time. When the timestamp is missing or unparseable the
//     line is OMITTED — the publishing time is never substituted.
//   * buildPostFacts — status, category, description, masked clues, location
//     label, timestamp, verified shop name and claim link. Phone numbers and
//     claimant data are not representable in this structure.
//   * formatFacebookPost / formatTelegramPost — the two platform renderings,
//     emoji-free by construction, each inside its platform's documented
//     length bound.
//
// WHAT DELIBERATELY LIVES ELSEWHERE
//   * WHICH values are safe to publish (masking, verification fail-closed
//     gate, location generalisation) — services/publicRecognition.ts, the
//     only transform private item data may pass through before publication.
//   * transport, media upload, idempotency, retry classification —
//     services/social.ts.
//
// LOST versus FOUND: the current publish triggers (agentOps confirm-dropoff
// and confirm-handover) only ever publish FOUND notices and the reunited
// follow-up; there is no lost-report publication path in the application
// today. The formatters nevertheless model both statuses — with the location
// label each requires — so any future lost-report publisher reuses this one
// pipeline instead of assembling text again.

/** Report status rendered at the top of every post. */
export type SocialPostStatus = 'FOUND' | 'LOST';

export const FACEBOOK_POST_MAX_LENGTH = 6000;
export const TELEGRAM_POST_MAX_LENGTH = 4096; // Telegram sendMessage HTML limit
export const TELEGRAM_CAPTION_MAX_LENGTH = 1024; // sendPhoto caption limit

/**
 * The deployed canonical origin. Used when PUBLIC_APP_URL is unset or is a
 * development/loopback address that must never be published to a public
 * audience. This is the domain the platform's sitemap, privacy policy and
 * already-published social links use — the verified public entry point, not a
 * development host.
 */
export const CANONICAL_PUBLIC_BASE_URL = 'https://return4me.co.ke';

/**
 * The existing, supported public link form for a report. App.tsx translates
 * `/?claim=<itemId>` into the safe public item page — it is never an implicit
 * claim or authentication action — and links already published in this form
 * must keep working, so new posts keep the same shape.
 */
export function buildReportLink(baseUrl: string, itemId: string | null | undefined): string | null {
  if (!itemId) return null;
  const id = itemId.trim();
  // The public item id is the same identifier /item/:id already exposes. It
  // is validated as a bounded, URL-safe token so a hostile value can never
  // reshape the link, inject a query string or smuggle contact data.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return null;
  return `${baseUrl}/?claim=${encodeURIComponent(id)}`;
}

/**
 * Resolves the canonical public origin for links that leave the platform.
 *
 * Order:
 *   1. PUBLIC_APP_URL — the SAME variable customerAuth.ts builds activation
 *      links from (one origin-resolution seam, not two) — but only when it is
 *      a real http(s) origin a member of the public can reach.
 *   2. Anything loopback (http://localhost, 127.0.0.1, [::1]) is rejected: a
 *      public post must never carry a development host.
 *   3. Otherwise the deployed canonical domain.
 */
export function resolvePublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.PUBLIC_APP_URL || '').trim();
  if (!raw) return CANONICAL_PUBLIC_BASE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return CANONICAL_PUBLIC_BASE_URL;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      return CANONICAL_PUBLIC_BASE_URL;
    }
    return url.origin;
  } catch {
    return CANONICAL_PUBLIC_BASE_URL;
  }
}

/**
 * The branded image used IN PLACE of a sensitive document's photo. The real
 * document image is never published; this placeholder uses an existing
 * first-party brand asset (the logo wordmark on its neutral background) so
 * the post reads as intentional rather than as a broken attachment.
 */
export const SENSITIVE_DOCUMENT_PLACEHOLDER_ASSET = '/assets/logo_wordmark_white_bg.jpg';

/** Absolute URL of the privacy placeholder, on the canonical base URL. */
export function resolveSensitivePlaceholderUrl(baseUrl: string): string {
  return `${baseUrl}${SENSITIVE_DOCUMENT_PLACEHOLDER_ASSET}`;
}

/**
 * Formats the report's OWN created timestamp in Kenya local time
 * (Africa/Nairobi), in the application's established Kenyan display shape.
 * Returns null when the value is absent or unparseable — the publishing time
 * is never substituted for the report's original timestamp.
 */
export function formatReportTimestampKenya(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleString('en-GB', {
      timeZone: 'Africa/Nairobi',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return null;
  }
}

/**
 * Sanitizes untrusted, Finder-controlled free text (item.description,
 * item.location_description) before it reaches ANY public social post.
 * A Finder filling out the found-item report is an anonymous member of the
 * public — this text must be treated the same as any other untrusted user
 * input, not as safe content just because it came through our own form.
 *
 * Strips:
 * - full URLs (http/https/www.) — prevents a Finder embedding a phishing
 *   link disguised as part of a legitimate Return4me post
 * - phone numbers (Kenyan mobile formats) and email addresses — prevents
 *   PII leakage and off-platform contact-fishing through a "found item"
 *   post
 * - excessive whitespace a Finder could use to visually break the post's
 *   formatting
 *
 * When htmlEscape is true (Telegram, which posts with parse_mode: 'HTML'),
 * also escapes &, <, > so the text can never be interpreted as markup —
 * without this, a description like `<a href="evil.com">real return4me
 * link</a>` would render as an actual clickable link inside our own post.
 */
export function sanitizeSocialText(raw: string | null | undefined, opts: { htmlEscape?: boolean } = {}): string {
  let text = (raw || '').toString();

  text = text.replace(/https?:\/\/\S+/gi, '[link removed]');
  text = text.replace(/\bwww\.\S+/gi, '[link removed]');
  text = text.replace(/(?:\+254|254|0)[71]\d{8}\b/g, '[phone removed]');
  text = text.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email removed]');
  text = text.replace(/\s{3,}/g, '  ').trim();

  if (opts.htmlEscape) {
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return text || 'Not provided.';
}

/**
 * HTML-escapes a value for Telegram's HTML parse mode ONLY — no URL/phone/
 * email scrubbing (unlike sanitizeSocialText). Use this for admin-
 * controlled values (category names, Agent business name/address) that
 * aren't Finder-supplied free text but should still never be able to
 * break Telegram's HTML parsing or inject markup — e.g. if a category
 * name is ever edited to include a stray `<` character. For genuinely
 * untrusted Finder-controlled text (description, location), use
 * sanitizeSocialText(..., { htmlEscape: true }) instead, which also
 * strips embedded links/phone numbers/emails.
 */
export function escapeTelegramHtml(raw: string | null | undefined): string {
  return (raw || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Everything a public post may contain. Built ONCE per broadcast. */
export interface SocialPostFacts {
  status: SocialPostStatus;
  /** Bilingual category label ("English / Kiswahili"), admin-controlled. */
  categoryLabel: string;
  /** True when the item is a sensitive document (server-classified). */
  isSensitive: boolean;
  /** Verified description clue; only ever populated for non-sensitive items. */
  description: string | null;
  /** Masked recognition clues from PublicRecognitionService. */
  nameClue: string | null;
  documentNumberClue: string | null;
  /** Already-generalised public location ("Area, Town" shape). */
  location: string;
  /** Report-created timestamp in Kenya local time, or null when unknown. */
  reportedAt: string | null;
  /** Verified registered agent shop name, or null when absent. */
  shopName: string | null;
  /** "Shop, address" collection point, or null when no verified agent. */
  collectionPoint: string | null;
  /** The real supported public link, or null when it cannot be built safely. */
  claimUrl: string | null;
}

export interface SocialPostFactsInput {
  status: SocialPostStatus;
  categoryLabel: string;
  isSensitive: boolean;
  /** Sanitised description clue (never raw Finder text — caller's contract). */
  description: string | null;
  nameClue: string | null;
  documentNumberClue: string | null;
  location: string;
  createdAtIso?: string | null;
  /** Agent business name. A blank/unverified value is treated as absent. */
  shopName?: string | null;
  agentAddress?: string | null;
  itemId: string;
}

/**
 * The location label each status requires. A found item describes where the
 * ITEM was found; a lost item describes the last place the OWNER reported.
 */
export function locationLabelFor(status: SocialPostStatus): string {
  return status === 'LOST' ? 'Last reported location' : 'Location found';
}

/**
 * Assembles the single source of public post facts.
 *
 * Invariants:
 *   * no phone number, claimant detail, raw identifier or raw document image
 *     URL is representable here — the inputs are the already-privacy-
 *     transformed clues and the verified shop name only;
 *   * a missing shop name is recorded as null (the formatters fall back to
 *     the approved neutral "Return4me Hub" — a business name is never
 *     fabricated);
 *   * a missing or unsafe claim link is null, and the formatters explain how
 *     to find the report instead of inventing a destination.
 */
export function buildPostFacts(input: SocialPostFactsInput): SocialPostFacts {
  const shopName = (input.shopName || '').trim();
  const agentAddress = (input.agentAddress || '').trim();
  const baseUrl = resolvePublicBaseUrl();

  return {
    status: input.status,
    categoryLabel: input.categoryLabel,
    isSensitive: input.isSensitive,
    description: input.description,
    nameClue: input.nameClue,
    documentNumberClue: input.documentNumberClue,
    location: input.location,
    reportedAt: formatReportTimestampKenya(input.createdAtIso),
    shopName: shopName || null,
    collectionPoint: shopName ? `${shopName}${agentAddress ? `, ${agentAddress}` : ''}` : null,
    claimUrl: buildReportLink(baseUrl, input.itemId),
  };
}

/** The status heading each status renders with. */
function statusHeading(status: SocialPostStatus, kind: string): string {
  return status === 'LOST' ? `LOST ${kind}` : `FOUND ${kind}`;
}


/**
 * FACEBOOK — the fuller rendering. Plain text (a Page feed post needs no HTML
 * markup), one heading, the factual block, the shared call to action and the
 * claim link.
 */
export function formatFacebookPost(facts: SocialPostFacts): string {
  const kind = facts.isSensitive ? 'DOCUMENT' : 'ITEM';
  const lines: string[] = [];

  lines.push(`RETURN4ME — ${statusHeading(facts.status, kind)}`);
  lines.push('');
  lines.push(`CATEGORY: ${sanitizeSocialText(facts.categoryLabel)}`);

  if (facts.nameClue) {
    lines.push(`NAME: ${sanitizeSocialText(facts.nameClue)}`);
  }
  if (facts.documentNumberClue) {
    lines.push(`DOCUMENT NUMBER: ${sanitizeSocialText(facts.documentNumberClue)}`);
  }
  if (facts.description) {
    lines.push('');
    lines.push(`DESCRIPTION: ${sanitizeSocialText(facts.description)}`);
  }

  lines.push('');
  lines.push(`${locationLabelFor(facts.status).toUpperCase()}: ${sanitizeSocialText(facts.location)}`);
  if (facts.reportedAt) {
    lines.push(`REPORTED: ${facts.reportedAt} (Kenya time)`);
  }
  lines.push(`COLLECTION POINT: ${sanitizeSocialText(facts.collectionPoint || 'Return4me Hub, Kenya')}`);
  lines.push('');
  lines.push('Physically verified by an authorized Return4me agent hub.');
  lines.push('');
  lines.push(privacyNote(facts));
  lines.push('');
  if (facts.claimUrl) {
    // The claim URL is FIRST-PARTY and server-constructed from the canonical
    // base URL plus a validated item id (see buildReportLink) — it is NOT
    // untrusted Finder free text, so it must NOT pass through
    // sanitizeSocialText, which would strip the very "https://" link it is our
    // job to publish (it reduced this line to "CLAIM LINK: [link removed]").
    // It is safe to print verbatim.
    lines.push(`CLAIM LINK: ${facts.claimUrl}`);
  } else {
    lines.push('To start a claim, visit return4me.co.ke and search for this report — no other link is ever needed.');
  }

  const text = lines.join('\n');
  return text.length > FACEBOOK_POST_MAX_LENGTH ? `${text.slice(0, FACEBOOK_POST_MAX_LENGTH - 1)}…` : text;
}

/**
 * TELEGRAM — the compact rendering of the SAME facts, with the same privacy
 * decisions. Uses parse_mode HTML, so every interpolated value is escaped
 * and the claim link is a real clickable <a>. Same 4096-character message
 * bound the provider enforces.
 */
export function formatTelegramPost(facts: SocialPostFacts): string {
  const kind = facts.isSensitive ? 'DOCUMENT' : 'ITEM';
  const esc = escapeTelegramHtml;
  const safe = (raw: string) => escapeTelegramHtml(sanitizeSocialText(raw));

  const lines: string[] = [];

  lines.push(`<b>RETURN4ME — ${esc(statusHeading(facts.status, kind))}</b>`);
  lines.push('');
  lines.push(`<b>Category:</b> ${esc(sanitizeSocialText(facts.categoryLabel))}`);

  if (facts.nameClue) {
    lines.push(`<b>Name:</b> <code>${esc(sanitizeSocialText(facts.nameClue))}</code>`);
  }
  if (facts.documentNumberClue) {
    lines.push(`<b>Document number:</b> <code>${esc(sanitizeSocialText(facts.documentNumberClue))}</code>`);
  }
  if (facts.description) {
    lines.push('');
    lines.push(`<b>Description:</b> ${esc(sanitizeSocialText(facts.description, { htmlEscape: true }))}`);
  }

  lines.push('');
  lines.push(`<b>${esc(locationLabelFor(facts.status))}:</b> ${safe(facts.location)}`);
  if (facts.reportedAt) {
    lines.push(`<b>Reported:</b> ${esc(facts.reportedAt)} (Kenya time)`);
  }
  lines.push(`<b>Collection point:</b> ${safe(facts.collectionPoint || 'Return4me Hub, Kenya')}`);
  lines.push('');
  lines.push('Physically verified by an authorized Return4me agent hub.');
  lines.push('');
  lines.push(esc(privacyNote(facts)));
  lines.push('');
  if (facts.claimUrl) {
    lines.push(`<b>Claim link:</b> <a href="${esc(facts.claimUrl)}">${esc(facts.claimUrl)}</a>`);
  } else {
    lines.push('To start a claim, visit return4me.co.ke and search for this report — no other link is ever needed.');
  }

  const text = lines.join('\n');
  return text.length > TELEGRAM_POST_MAX_LENGTH ? `${text.slice(0, TELEGRAM_POST_MAX_LENGTH - 1)}…` : text;
}

/** One facts object, rendered as the privacy note both platforms share. */
function privacyNote(facts: SocialPostFacts): string {
  if (!facts.isSensitive) {
    return 'Think this item is yours? Start the secure claim below. This post alone is never enough to claim an item — ownership is verified privately through Return4me.';
  }
  return 'The document image and sensitive details are withheld from this post to protect the owner. The clues above are for recognition only — verify ownership privately through Return4me, and never share your documents in replies to this post.';
}
