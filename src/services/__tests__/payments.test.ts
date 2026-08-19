import { describe, it, expect } from 'vitest';
import { isPlaceholderKey } from '../payments';

// isPlaceholderKey is the single gate that decides whether a payment
// call actually hits IntaSend with real money, or safely no-ops into
// simulation mode. Its own comment documents the actual production
// incident this function exists to prevent: a key literally set to the
// word "placeholder" wasn't recognized as fake, so the app made a real
// network call with an invalid key instead of simulating. That makes this
// arguably the single highest-consequence pure function in the codebase
// to regress silently — worth pinning down explicitly.

describe('isPlaceholderKey', () => {
  it('treats undefined, null, and empty string as placeholders', () => {
    expect(isPlaceholderKey(undefined)).toBe(true);
    expect(isPlaceholderKey(null)).toBe(true);
    expect(isPlaceholderKey('')).toBe(true);
    expect(isPlaceholderKey('   ')).toBe(true);
  });

  it('recognizes every documented placeholder convention', () => {
    expect(isPlaceholderKey('REPLACE_WITH_INTASEND_SECRET_KEY')).toBe(true);
    expect(isPlaceholderKey('placeholder')).toBe(true);
    expect(isPlaceholderKey('your_key_here')).toBe(true);
    expect(isPlaceholderKey('your-key-here')).toBe(true);
    expect(isPlaceholderKey('changeme')).toBe(true);
    expect(isPlaceholderKey('change_me')).toBe(true);
    expect(isPlaceholderKey('xxx')).toBe(true);
    expect(isPlaceholderKey('todo')).toBe(true);
    expect(isPlaceholderKey('tbd')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isPlaceholderKey('PLACEHOLDER')).toBe(true);
    expect(isPlaceholderKey('Your_Key_Here')).toBe(true);
    expect(isPlaceholderKey('ChangeMe')).toBe(true);
  });

  it('does not flag a real-looking secret key as a placeholder', () => {
    expect(isPlaceholderKey('ISSecretKey_a8f3k2m9x7q1w4e6r8t0y2u5i7o9p1a3s5d')).toBe(false);
    expect(isPlaceholderKey('sk_live_51H8xJ2KzQm9L3nP7vR4tY6uI8oA0sD2fG5h')).toBe(false);
  });

  it('does not false-positive on a real key that happens to contain a substring like "x"', () => {
    // A key containing the letter sequence 'xxx' as a coincidental
    // substring (not the whole trimmed value) should NOT be flagged —
    // only an exact 'xxx' (after trim/lowercase) is a placeholder.
    expect(isPlaceholderKey('boxxxer_secret_9f8e7d6c5b4a3210')).toBe(false);
  });
});
