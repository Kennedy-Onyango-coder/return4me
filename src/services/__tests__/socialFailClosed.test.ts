import { describe, it, expect, afterEach, vi } from 'vitest';

// P0 fix: postToTelegram/postToFacebook/postToTwitter (and the duplicated
// inline versions inside broadcastItemReunited) used to unconditionally
// `return true` when their platform's credentials were missing — meaning
// a production deploy with misconfigured/missing social credentials would
// report every post as successfully published, and the caller
// (broadcastVerifiedItem/broadcastItemReunited) would write a 'published'
// row to social_publications for a post that never actually went out.
// Fixed to fail closed ('permanent_failure' — missing config won't fix
// itself on retry) in production while preserving the
// sandbox-outbox convenience in development, matching the fail-closed
// pattern already used by this codebase's storage, payment, and DB
// fallback paths.

const ORIGINAL_ENV = { ...process.env };
const minimalItem = {
  id: 'TEST-ITEM-SOCIALFAILCLOSED',
  category_id: null,
  location_description: 'Test location',
  description: 'Test description',
  is_sensitive_document: false,
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('social platform posting fails closed in production when credentials are missing', () => {
  it("postToTelegram returns 'permanent_failure' in production with missing credentials, instead of a fake success", async () => {
    vi.resetModules();
    const { SocialService } = await import('../social');
    // This sandbox environment auto-injects placeholder values from
    // .env.example (e.g. TELEGRAM_BOT_TOKEN="REPLACE_WITH_TELEGRAM_BOT_TOKEN")
    // as a side effect of the import itself — clearing credentials must
    // happen AFTER import, not before, or the "missing credentials" branch
    // never gets exercised at all (a truthy placeholder skips straight to
    // a real, doomed-to-fail network call instead). Stubbing fetch to
    // reject immediately is a second, independent safety net: if a real
    // fetch is ever reached despite that (e.g. a placeholder value
    // slipping through), the test fails fast and deterministically instead
    // of hanging on a real network call this sandbox can't complete anyway.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network calls are stubbed out in this test'))));
    process.env.NODE_ENV = 'production';
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHANNEL_ID;

    const result = await SocialService.postToTelegram(minimalItem as any);
    expect(result).toBe('permanent_failure');
  });

  it("postToTelegram still returns 'published' (sandbox outbox) in development with missing credentials", async () => {
    vi.resetModules();
    const { SocialService } = await import('../social');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network calls are stubbed out in this test'))));
    process.env.NODE_ENV = 'development';
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHANNEL_ID;

    const result = await SocialService.postToTelegram(minimalItem as any);
    expect(result).toBe('published');
  });

  it("postToFacebook returns 'permanent_failure' in production with missing credentials", async () => {
    vi.resetModules();
    const { SocialService } = await import('../social');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network calls are stubbed out in this test'))));
    process.env.NODE_ENV = 'production';
    delete process.env.FACEBOOK_PAGE_ID;
    delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

    const result = await SocialService.postToFacebook(minimalItem as any);
    expect(result).toBe('permanent_failure');
  });

  it("postToFacebook still returns 'published' (sandbox outbox) in development with missing credentials", async () => {
    vi.resetModules();
    const { SocialService } = await import('../social');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network calls are stubbed out in this test'))));
    process.env.NODE_ENV = 'development';
    delete process.env.FACEBOOK_PAGE_ID;
    delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

    const result = await SocialService.postToFacebook(minimalItem as any);
    expect(result).toBe('published');
  });

  it("postToTwitter returns 'permanent_failure' in production with missing credentials", async () => {
    vi.resetModules();
    const { SocialService } = await import('../social');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network calls are stubbed out in this test'))));
    process.env.NODE_ENV = 'production';
    delete process.env.TWITTER_API_KEY;
    delete process.env.TWITTER_API_SECRET;
    delete process.env.TWITTER_ACCESS_TOKEN;
    delete process.env.TWITTER_ACCESS_TOKEN_SECRET;

    const result = await SocialService.postToTwitter(minimalItem as any);
    expect(result).toBe('permanent_failure');
  });

  it("postToTwitter still returns 'published' (sandbox outbox) in development with missing credentials", async () => {
    vi.resetModules();
    const { SocialService } = await import('../social');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network calls are stubbed out in this test'))));
    process.env.NODE_ENV = 'development';
    delete process.env.TWITTER_API_KEY;
    delete process.env.TWITTER_API_SECRET;
    delete process.env.TWITTER_ACCESS_TOKEN;
    delete process.env.TWITTER_ACCESS_TOKEN_SECRET;

    const result = await SocialService.postToTwitter(minimalItem as any);
    expect(result).toBe('published');
  });
});
