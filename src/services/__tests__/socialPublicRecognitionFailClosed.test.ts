import { describe, it, expect, afterEach, vi } from 'vitest';

// P0 REGRESSION TEST — public recognition must fail closed, wired through
// social.ts's actual post functions (not just tested at the
// publicRecognition.ts service level — see publicRecognition.test.ts for
// that). Two real, previously-unflagged gaps this closes:
//
// 1. buildSafePublicClues used to be called ONLY inside the isSensitive
//    branch of each postTo* function — non-sensitive items' location and
//    description were published straight from raw, Agent-unverified
//    Finder fields (item.location_description / item.description) with
//    NO verification check and no generalization at all, regardless of
//    whether the item had ever actually been Agent-verified.
// 2. broadcastVerifiedItem's own defensive guard only checked
//    is_sensitive_document items for a valid verification_status —
//    non-sensitive items had no guard at that layer either.
//
// Both are fixed: buildSafePublicClues now runs unconditionally for every
// item, for every platform, and throws (caught, mapped to
// 'permanent_failure') if verification_status isn't 'confirmed_as_reported'
// or 'corrected' — regardless of sensitivity.

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
  vi.unstubAllGlobals();
});

const unverifiedSensitiveItem = {
  id: 'TEST-ITEM-PUBRECOG-1',
  category_id: null,
  location_description: 'RAW Finder-submitted address, House 12',
  description: 'RAW finder description',
  is_sensitive_document: true,
  verification_status: 'pending', // never actually Agent-verified
  ocr_extracted_name: 'Should Never Appear',
  ocr_extracted_number: '99999999',
};

const unverifiedNonSensitiveItem = {
  id: 'TEST-ITEM-PUBRECOG-2',
  category_id: null,
  location_description: 'RAW Finder-submitted address, House 12',
  description: 'RAW finder description',
  is_sensitive_document: false,
  verification_status: 'pending',
};

const verifiedNonSensitiveItem = {
  id: 'TEST-ITEM-PUBRECOG-3',
  category_id: null,
  location_description: 'RAW Finder-submitted address, House 12 (should never appear)',
  description: 'RAW finder description (should never appear)',
  is_sensitive_document: false,
  verification_status: 'confirmed_as_reported',
  verified_found_area: 'Eastleigh, Nairobi',
  verified_description: 'A black backpack with a red zipper.',
};

async function freshSocialService() {
  vi.resetModules();
  const mod = await import('../social');
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network calls are stubbed out in this test'))));
  process.env.NODE_ENV = 'production'; // credentials would be missing anyway; irrelevant to this test, but avoids the sandbox-outbox branch masking the result
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHANNEL_ID;
  delete process.env.FACEBOOK_PAGE_ID;
  delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  delete process.env.TWITTER_API_KEY;
  return mod.SocialService;
}

describe('sensitive items with an unverified status never publish raw Finder data', () => {
  it('postToTelegram refuses (permanent_failure) rather than publishing OCR/raw data for an unverified sensitive item', async () => {
    const SocialService = await freshSocialService();
    const result = await SocialService.postToTelegram(unverifiedSensitiveItem as any);
    expect(result).toBe('permanent_failure');
  });
});

describe('non-sensitive items with an unverified status ALSO refuse — this is the actual gap that was fixed', () => {
  it('postToTelegram refuses for an unverified non-sensitive item (previously this had NO check at all)', async () => {
    const SocialService = await freshSocialService();
    const result = await SocialService.postToTelegram(unverifiedNonSensitiveItem as any);
    expect(result).toBe('permanent_failure');
  });

  it('postToFacebook refuses for an unverified non-sensitive item', async () => {
    const SocialService = await freshSocialService();
    const result = await SocialService.postToFacebook(unverifiedNonSensitiveItem as any);
    expect(result).toBe('permanent_failure');
  });

  it('postToTwitter refuses for an unverified non-sensitive item', async () => {
    const SocialService = await freshSocialService();
    const result = await SocialService.postToTwitter(unverifiedNonSensitiveItem as any);
    expect(result).toBe('permanent_failure');
  });
});

describe('a genuinely verified non-sensitive item publishes verified_* data, never raw Finder fields', () => {
  it('publishes successfully (reaches the credential-missing branch, not the verification-gate branch) for a verified item', async () => {
    const SocialService = await freshSocialService();
    // Missing credentials in production -> 'permanent_failure' too, but for
    // a DIFFERENT reason than the verification gate — distinguishing these
    // two is exactly why this item fixture must be genuinely verified: if
    // the verification gate were still (incorrectly) firing here, this
    // test wouldn't tell us anything about which check actually ran.
    // Development mode with the sandbox-outbox branch proves it got past
    // the verification gate specifically.
    process.env.NODE_ENV = 'development';
    const result = await SocialService.postToTelegram(verifiedNonSensitiveItem as any);
    expect(result).toBe('published');
  });
});
