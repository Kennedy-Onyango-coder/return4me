import { describe, it, expect } from 'vitest';
import { sanitizeSocialText, escapeTelegramHtml } from '../social';

// A Finder submitting a found-item report is an anonymous member of the
// public. Their free-text description and location fields flow directly
// into public Telegram/Facebook/Twitter posts — these tests pin down that
// none of that text can be used to inject a phishing link disguised as
// part of a legitimate Return4me post, break Telegram's HTML parsing, or
// leak a phone number/email through what's supposed to be an anonymized
// "found item" notice.

describe('sanitizeSocialText', () => {
  it('strips http(s) URLs', () => {
    const result = sanitizeSocialText('Found near https://evil-phishing-site.com/claim-now');
    expect(result).not.toContain('evil-phishing-site.com');
    expect(result).toContain('[link removed]');
  });

  it('strips www. URLs without a protocol', () => {
    const result = sanitizeSocialText('Contact www.fake-return4me.com for details');
    expect(result).not.toContain('fake-return4me.com');
  });

  it('strips Kenyan phone numbers in 07/01, 254, and +254 formats', () => {
    expect(sanitizeSocialText('Call 0712345678 now')).not.toContain('0712345678');
    expect(sanitizeSocialText('Call 254712345678 now')).not.toContain('254712345678');
    expect(sanitizeSocialText('Call +254712345678 now')).not.toContain('254712345678');
    expect(sanitizeSocialText('Call 0112345678 now')).not.toContain('0112345678');
  });

  it('strips email addresses', () => {
    const result = sanitizeSocialText('Reach me at scammer@fake-domain.com please');
    expect(result).not.toContain('scammer@fake-domain.com');
    expect(result).toContain('[email removed]');
  });

  it('HTML-escapes when htmlEscape is true, preventing a fake <a> tag from becoming a real clickable link in Telegram', () => {
    const raw = 'Real return4me link <a href="http://phishing.example">click here</a>';
    const result = sanitizeSocialText(raw, { htmlEscape: true });
    expect(result).not.toContain('<a href');
    expect(result).toContain('&lt;a href');
  });

  it('does NOT HTML-escape by default (plain-text platforms like Facebook/Twitter)', () => {
    const result = sanitizeSocialText('5 < 10 and 10 > 5');
    expect(result).toBe('5 < 10 and 10 > 5');
  });

  it('collapses excessive whitespace a Finder could use to break post formatting', () => {
    const result = sanitizeSocialText('Normal text\n\n\n\n\n\nwith huge gaps     between words');
    expect(result).not.toMatch(/\s{3,}/);
  });

  it('falls back to a safe default for empty/null/undefined input', () => {
    expect(sanitizeSocialText(null)).toBe('Not provided.');
    expect(sanitizeSocialText(undefined)).toBe('Not provided.');
    expect(sanitizeSocialText('')).toBe('Not provided.');
  });

  it('leaves ordinary, legitimate location/description text untouched', () => {
    const result = sanitizeSocialText('Black backpack found near Westgate Mall, Nairobi');
    expect(result).toBe('Black backpack found near Westgate Mall, Nairobi');
  });
});

describe('escapeTelegramHtml', () => {
  // Every value interpolated into a Telegram post (which uses HTML parse
  // mode) must go through this — including admin-controlled values like
  // category names and Agent business name/address, not just Finder free
  // text — so a stray `<` anywhere can never be interpreted as markup.

  it('neutralizes a fake <b> tag', () => {
    const result = escapeTelegramHtml('<b>fake</b>');
    expect(result).not.toContain('<b>');
    expect(result).toBe('&lt;b&gt;fake&lt;/b&gt;');
  });

  it('neutralizes a fake phishing <a href> link so it never becomes clickable', () => {
    const result = escapeTelegramHtml('<a href="https://evil.example">Click</a>');
    expect(result).not.toContain('<a href');
    expect(result).not.toMatch(/<a[^&]/); // no real unescaped <a tag survives
  });

  it('neutralizes an <img> tag', () => {
    const result = escapeTelegramHtml('<img src=x onerror=alert(1)>');
    expect(result).not.toContain('<img');
    expect(result).toContain('&lt;img');
  });

  it('neutralizes a <script> tag', () => {
    const result = escapeTelegramHtml('<script>alert(1)</script>');
    expect(result).not.toContain('<script>');
    expect(result).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes bare ampersands too, so escaped entities never double-decode oddly', () => {
    expect(escapeTelegramHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('falls back to an empty string for null/undefined rather than throwing', () => {
    expect(escapeTelegramHtml(null)).toBe('');
    expect(escapeTelegramHtml(undefined)).toBe('');
  });

  it('leaves ordinary text with no special characters completely unchanged', () => {
    expect(escapeTelegramHtml('National ID')).toBe('National ID');
  });
});
