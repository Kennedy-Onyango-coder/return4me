import { describe, it, expect } from 'vitest';
import {
  buildPostFacts,
  formatFacebookPost,
  formatTelegramPost,
  buildReportLink,
  resolvePublicBaseUrl,
  formatReportTimestampKenya,
  resolveSensitivePlaceholderUrl,
  locationLabelFor,
  CANONICAL_PUBLIC_BASE_URL,
  SENSITIVE_DOCUMENT_PLACEHOLDER_ASSET,
  FACEBOOK_POST_MAX_LENGTH,
  TELEGRAM_POST_MAX_LENGTH,
} from '../socialPostContent';

// =============================================================================
// D-2B-C SOCIAL REDESIGN — the ONE canonical post-facts source and its two
// platform renderers. These are the public-facing words and links that go to
// Facebook and Telegram, so every privacy rule is asserted here directly:
// found-vs-lost wording and location labels, the report's OWN timestamp in
// Kenya time, verified shop name (never a phone number), masked names and
// document numbers, the sensitive-document placeholder, no emoji, the canonical
// base URL and a valid claim destination, platform length bounds and escaping.
//
// Pure functions only — no network, no provider, no real post is ever produced.
// =============================================================================

// A pragmatic emoji / pictograph matcher: the post copy must never contain an
// emoji, per the brief. Covers the main emoji planes plus the variation
// selector and the dingbat/arrow blocks that "decorative" text tends to use.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

const REPORTED_AT = '2026-01-01T09:15:00.000Z'; // -> 12:15 Africa/Nairobi (EAT, UTC+3)

function sensitiveFacts(overrides: Partial<Parameters<typeof buildPostFacts>[0]> = {}) {
  return buildPostFacts({
    status: 'FOUND',
    categoryLabel: 'National ID Card / Kitambulisho',
    isSensitive: true,
    description: null,
    nameClue: 'Kennedy O***** A****',
    documentNumberClue: '•••• 5678',
    location: 'Nairobi City',
    createdAtIso: REPORTED_AT,
    shopName: 'Westlands Recovery Hub',
    agentAddress: 'Waiyaki Way',
    itemId: 'ABC123',
    ...overrides,
  });
}

function ordinaryFacts(overrides: Partial<Parameters<typeof buildPostFacts>[0]> = {}) {
  return buildPostFacts({
    status: 'FOUND',
    categoryLabel: 'Backpack / Mkeka',
    isSensitive: false,
    description: 'Black backpack with a red zipper.',
    nameClue: null,
    documentNumberClue: null,
    location: 'Westlands, Nairobi',
    createdAtIso: REPORTED_AT,
    shopName: 'Westlands Recovery Hub',
    agentAddress: 'Waiyaki Way',
    itemId: 'XYZ789',
    ...overrides,
  });
}

describe('found versus lost wording and location labels', () => {
  it('labels the location "Location found" for a FOUND item', () => {
    expect(locationLabelFor('FOUND')).toBe('Location found');
    const fb = formatFacebookPost(ordinaryFacts());
    expect(fb.toUpperCase()).toContain('LOCATION FOUND');
    expect(fb).not.toContain('Last reported location');
  });

  it('labels the location "Last reported location" for a LOST item', () => {
    expect(locationLabelFor('LOST')).toBe('Last reported location');
    const fb = formatFacebookPost(ordinaryFacts({ status: 'LOST' }));
    expect(fb.toUpperCase()).toContain('LAST REPORTED LOCATION');
  });

  it('heads a FOUND notice and a LOST notice differently', () => {
    const foundFb = formatFacebookPost(ordinaryFacts());
    const lostFb = formatFacebookPost(ordinaryFacts({ status: 'LOST' }));
    expect(foundFb).toContain('FOUND');
    expect(lostFb).toContain('LOST');
  });

  it('marks a sensitive post as a DOCUMENT and an ordinary post as an ITEM, on both platforms', () => {
    expect(formatFacebookPost(sensitiveFacts())).toContain('DOCUMENT');
    expect(formatTelegramPost(sensitiveFacts())).toContain('DOCUMENT');
    expect(formatFacebookPost(ordinaryFacts())).toContain('ITEM');
    expect(formatTelegramPost(ordinaryFacts())).toContain('ITEM');
  });
});

describe('report timestamp and timezone', () => {
  it('renders the report\'s OWN created_at in Kenya local time (UTC+3)', () => {
    // 09:15Z -> 12:15 in Africa/Nairobi.
    expect(formatReportTimestampKenya(REPORTED_AT)).toContain('12:15');
    const fb = formatFacebookPost(ordinaryFacts());
    expect(fb).toContain('12:15');
    expect(fb.toLowerCase()).toContain('kenya time');
  });

  it('never substitutes the publishing time — a missing timestamp omits the line entirely', () => {
    expect(formatReportTimestampKenya(null)).toBeNull();
    expect(formatReportTimestampKenya(undefined)).toBeNull();
    expect(formatReportTimestampKenya('not-a-date')).toBeNull();
    const facts = buildPostFacts({
      status: 'FOUND', categoryLabel: 'Item', isSensitive: false, description: 'd',
      nameClue: null, documentNumberClue: null, location: 'Nairobi',
      createdAtIso: null, shopName: 'Hub', agentAddress: '', itemId: 'NO-TS',
    });
    const fb = formatFacebookPost(facts);
    expect(fb).not.toMatch(/REPORTED:/i);
    // And the facts object carries no invented timestamp either.
    expect(facts.reportedAt).toBeNull();
  });
});
describe('verified shop name included; phone numbers and claimant data excluded', () => {
  it('includes the verified registered shop name on both platforms', () => {
    const fb = formatFacebookPost(sensitiveFacts());
    const tg = formatTelegramPost(sensitiveFacts());
    expect(fb).toContain('Westlands Recovery Hub');
    expect(tg).toContain('Westlands Recovery Hub');
  });

  it('omits the shop name (neutral fallback) when it is absent or unverified — never fabricates a business name', () => {
    const facts = ordinaryFacts({ shopName: '', agentAddress: '' });
    const fb = formatFacebookPost(facts);
    expect(fb).toContain('Return4me Hub');
    expect(fb).not.toContain('Westlands Recovery Hub');
  });

  it('never renders a phone number or private contact detail — SocialPostFacts has no field for it', () => {
    const facts = ordinaryFacts();
    expect(Object.keys(facts)).not.toContain('phone');
    expect(Object.keys(facts)).not.toContain('contactPhone');
    const fb = formatFacebookPost(facts);
    const tg = formatTelegramPost(facts);
    expect(fb).not.toMatch(/\+?254\d{7,}|\b0[71]\d{8}\b/);
    expect(tg).not.toMatch(/\+?254\d{7,}|\b0[71]\d{8}\b/);
  });
});

describe('full first name and masked subsequent names', () => {
  it('shows the full first name and masks the rest, never re-exposing the source name', () => {
    const fb = formatFacebookPost(sensitiveFacts({ nameClue: 'Kennedy O***** A****' }));
    expect(fb).toContain('Kennedy O***** A****');
    expect(fb).not.toContain('Otieno');
    expect(fb).not.toContain('Abuga');
  });
});

describe('sensitive-document placeholder selection', () => {
  it('exposes a first-party branded placeholder asset for sensitive documents', () => {
    expect(SENSITIVE_DOCUMENT_PLACEHOLDER_ASSET).toMatch(/^\/assets\//);
    const url = resolveSensitivePlaceholderUrl(CANONICAL_PUBLIC_BASE_URL);
    expect(url).toBe(`https://return4me.co.ke${SENSITIVE_DOCUMENT_PLACEHOLDER_ASSET}`);
    expect(url).not.toContain('localhost');
  });

describe('canonical base URL and a valid report/claim destination', () => {
  it('builds the claim link from the canonical base URL and a validated item id', () => {
    expect(buildReportLink(CANONICAL_PUBLIC_BASE_URL, 'ABC123')).toBe('https://return4me.co.ke/?claim=ABC123');
  });

  it('refuses to build a link for a missing, blank or malformed item id', () => {
    expect(buildReportLink(CANONICAL_PUBLIC_BASE_URL, null)).toBeNull();
    expect(buildReportLink(CANONICAL_PUBLIC_BASE_URL, undefined)).toBeNull();
    expect(buildReportLink(CANONICAL_PUBLIC_BASE_URL, '   ')).toBeNull();
    expect(buildReportLink(CANONICAL_PUBLIC_BASE_URL, 'bad id with spaces')).toBeNull();
    expect(buildReportLink(CANONICAL_PUBLIC_BASE_URL, 'x'.repeat(200))).toBeNull();
  });

  it('never publishes a hardcoded development host as the base URL', () => {
    expect(resolvePublicBaseUrl({ PUBLIC_APP_URL: 'http://localhost:5173' })).toBe(CANONICAL_PUBLIC_BASE_URL);
    expect(resolvePublicBaseUrl({ PUBLIC_APP_URL: 'http://127.0.0.1:3000' })).toBe(CANONICAL_PUBLIC_BASE_URL);
    expect(resolvePublicBaseUrl({})).toBe(CANONICAL_PUBLIC_BASE_URL);
  });

  it('renders a real, clickable claim link on both platforms', () => {
    const fb = formatFacebookPost(ordinaryFacts());
    const tg = formatTelegramPost(ordinaryFacts());
    expect(fb).toContain('https://return4me.co.ke/?claim=XYZ789');
    expect(tg).toContain('<a href="https://return4me.co.ke/?claim=XYZ789">');
  });
});

describe('missing / unsafe link fallback', () => {
  it('falls back to a search-the-site instruction when there is no safe claim link', () => {
    const facts = ordinaryFacts({ itemId: '' });
    expect(facts.claimUrl).toBeNull();
    const fb = formatFacebookPost(facts);
    const tg = formatTelegramPost(facts);
    expect(fb).not.toContain('CLAIM LINK: https');
    expect(fb).toContain('return4me.co.ke');
    expect(tg).toContain('return4me.co.ke');
  });
});

describe('platform length limits and escaping', () => {
  it('keeps Facebook within its 6000-character bound and Telegram within 4096', () => {
    const long = ordinaryFacts({ description: 'x'.repeat(20000), location: 'y'.repeat(5000) });
    expect(formatFacebookPost(long).length).toBeLessThanOrEqual(FACEBOOK_POST_MAX_LENGTH);
    expect(formatTelegramPost(long).length).toBeLessThanOrEqual(TELEGRAM_POST_MAX_LENGTH);
  });

  it('escapes user-supplied description text for Telegram HTML so it can never inject markup', () => {
    const facts = ordinaryFacts({ description: '<a href="http://evil">click</a> <b>bold</b>' });
    const tg = formatTelegramPost(facts);
    expect(tg).not.toContain('<a href="http://evil"');
    expect(tg).toContain('&lt;a href=');
  });

  it('strips a phone number and a URL that a Finder embedded in the free-text description', () => {
    const facts = ordinaryFacts({ description: 'Call 0712345678 or see https://phish.example/claim' });
    const tg = formatTelegramPost(facts);
    expect(tg).not.toContain('0712345678');
    expect(tg).not.toContain('phish.example');
  });
});

describe('no emoji in generated post copy', () => {
  it('produces emoji-free copy for every status/sensitivity combination', () => {
    const variants = [
      ordinaryFacts(),
      sensitiveFacts(),
      ordinaryFacts({ status: 'LOST' }),
      sensitiveFacts({ status: 'LOST' }),
      ordinaryFacts({ shopName: '', agentAddress: '', itemId: '' }),
    ];
    for (const facts of variants) {
      expect(EMOJI.test(formatFacebookPost(facts))).toBe(false);
      expect(EMOJI.test(formatTelegramPost(facts))).toBe(false);
    }
  });
});

describe('Facebook and Telegram parity of privacy rules', () => {
  it('both platforms publish the same masked name, masked number, location label, timestamp, shop name and claim link', () => {
    const facts = sensitiveFacts();
    const fb = formatFacebookPost(facts);
    const tg = formatTelegramPost(facts);
    for (const shared of ['Kennedy O***** A****', '•••• 5678', 'Nairobi City', 'Westlands Recovery Hub', 'https://return4me.co.ke/?claim=ABC123']) {
      expect(fb, `facebook must carry ${shared}`).toContain(shared);
      expect(tg, `telegram must carry ${shared}`).toContain(shared);
    }
    for (const forbidden of ['Otieno', 'Abuga', 'Kennedy Otieno Abuga']) {
      expect(fb).not.toContain(forbidden);
      expect(tg).not.toContain(forbidden);
    }
  });
});

  it('a sensitive facts object never carries the raw document image — only clues', () => {
    const facts = sensitiveFacts();
    expect(Object.keys(facts)).not.toContain('photoUrl');
    expect(Object.keys(facts)).not.toContain('imageUrl');
    expect(facts.description).toBeNull();
  });
});


