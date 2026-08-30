import { describe, it, expect, afterEach, vi } from 'vitest';

// A tiny valid 1x1 PNG (magic bytes 89 50 4E 47) as base64, so the upload
// gets past the magic-byte/size validation and reaches the storage
// fallback branch under test.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('production storage fail-closed guarantee', () => {
  it('throws in production when STORAGE_* env vars are missing, instead of embedding a data: URI', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    delete process.env.STORAGE_ENDPOINT;
    delete process.env.STORAGE_BUCKET;
    delete process.env.STORAGE_KEY;
    delete process.env.STORAGE_SECRET;

    const { uploadBase64Image } = await import('../storage');
    await expect(uploadBase64Image(TINY_PNG_BASE64, 'photos')).rejects.toThrow(/STORAGE_/);
  });

  it('does NOT throw in development with missing STORAGE_* env vars (data: URI fallback is a dev-only convenience)', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'development';
    delete process.env.STORAGE_ENDPOINT;
    delete process.env.STORAGE_BUCKET;
    delete process.env.STORAGE_KEY;
    delete process.env.STORAGE_SECRET;

    const { uploadBase64Image } = await import('../storage');
    const result = await uploadBase64Image(TINY_PNG_BASE64, 'photos');
    expect(result).toMatch(/^data:image\/png;base64,/);
  });
});
