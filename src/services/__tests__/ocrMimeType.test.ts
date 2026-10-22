
import { describe, it, expect } from 'vitest';
import { detectSupportedImageMimeType } from '../ocr';

function base64(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64');
}

const jpegBytes = [
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
];

const pngBytes = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
];

const webpBytes = [
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45,
  0x42, 0x50,
];

describe('detectSupportedImageMimeType', () => {
  it('accepts a valid JPEG data URI', () => {
    expect(
      detectSupportedImageMimeType(
        `data:image/jpeg;base64,${base64(jpegBytes)}`,
      ),
    ).toBe('image/jpeg');
  });

  it('accepts a valid PNG data URI', () => {
    expect(
      detectSupportedImageMimeType(
        `data:image/png;base64,${base64(pngBytes)}`,
      ),
    ).toBe('image/png');
  });

  it('accepts a valid WebP data URI', () => {
    expect(
      detectSupportedImageMimeType(
        `data:image/webp;base64,${base64(webpBytes)}`,
      ),
    ).toBe('image/webp');
  });

  it('accepts raw base64 by signature', () => {
    expect(detectSupportedImageMimeType(base64(pngBytes))).toBe('image/png');
  });

  it('rejects a MIME/signature mismatch', () => {
    expect(
      detectSupportedImageMimeType(
        `data:image/png;base64,${base64(jpegBytes)}`,
      ),
    ).toBeNull();
  });

  it('rejects malformed data URIs', () => {
    expect(
      detectSupportedImageMimeType('data:image/jpeg;base64'),
    ).toBeNull();

    expect(
      detectSupportedImageMimeType('data:image/jpeg;base64,'),
    ).toBeNull();
  });

  it('rejects invalid base64', () => {
    expect(
      detectSupportedImageMimeType('data:image/png;base64,!!!!'),
    ).toBeNull();

    expect(detectSupportedImageMimeType('!!!!')).toBeNull();
  });

  it('rejects truncated base64', () => {
    expect(
      detectSupportedImageMimeType(
        `data:image/jpeg;base64,${base64(jpegBytes).slice(0, -1)}`,
      ),
    ).toBeNull();
  });

  it('rejects truncated or corrupt images', () => {
    expect(
      detectSupportedImageMimeType(
        `data:image/jpeg;base64,${base64([0xff, 0xd8])}`,
      ),
    ).toBeNull();
  });

  it('rejects unsupported formats', () => {
    const gifBytes = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

    expect(
      detectSupportedImageMimeType(
        `data:image/gif;base64,${base64(gifBytes)}`,
      ),
    ).toBeNull();

    expect(detectSupportedImageMimeType(base64(gifBytes))).toBeNull();
  });

  it('accepts a data URI whose payload is wrapped across lines', () => {
    const largeBytes = [
      ...jpegBytes,
      ...jpegBytes,
      ...jpegBytes,
      ...jpegBytes,
      ...jpegBytes,
      ...jpegBytes,
    ];

    const singleLine = base64(largeBytes);

    // Insert an actual newline after each complete 76-character segment.
    const wrapped = singleLine.replace(
      /(.{76})/g,
      (_match) => _match + String.fromCharCode(10),
    );

    expect(wrapped.includes(String.fromCharCode(10))).toBe(true);

    expect(
      detectSupportedImageMimeType(
        `data:image/jpeg;base64,${wrapped}`,
      ),
    ).toBe('image/jpeg');
  });
});
