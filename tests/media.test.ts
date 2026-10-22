import { describe, expect, it } from 'vitest';
import { detectImageType, variantKey, variantWidthsFor } from '../web/src/server/media';

describe('upload byte detection', () => {
  it('detects supported images from bytes, not declared MIME', () => {
    expect(detectImageType(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toEqual({
      contentType: 'image/jpeg',
      extension: 'jpg',
    });
    expect(
      detectImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ).toEqual({ contentType: 'image/png', extension: 'png' });
    expect(detectImageType(new TextEncoder().encode('GIF89a'))).toEqual({
      contentType: 'image/gif',
      extension: 'gif',
    });
    const webp = new Uint8Array(12);
    webp.set(new TextEncoder().encode('RIFF'), 0);
    webp.set(new TextEncoder().encode('WEBP'), 8);
    expect(detectImageType(webp)).toEqual({ contentType: 'image/webp', extension: 'webp' });
  });

  it('rejects scripts, SVG, and spoofed content', () => {
    expect(detectImageType(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(detectImageType(new TextEncoder().encode('<script>alert(1)</script>'))).toBeNull();
    expect(detectImageType(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
  });
});

describe('responsive variants', () => {
  it('derives variant keys next to the original, matching the serving route', () => {
    expect(variantKey('abc-123.jpg', 640)).toBe('abc-123.w640.jpg');
    expect(variantKey('abc-123.png', 320)).toBe('abc-123.w320.png');
    expect(variantKey('noextension', 960)).toBe('noextension.w960');
  });

  it('never upscales and skips variants at or above the natural width', () => {
    expect(variantWidthsFor(2000)).toEqual([320, 640, 960, 1600]);
    expect(variantWidthsFor(1000)).toEqual([320, 640, 960]);
    expect(variantWidthsFor(640)).toEqual([320]);
    expect(variantWidthsFor(320)).toEqual([]);
    expect(variantWidthsFor(0)).toEqual([]);
    expect(variantWidthsFor(Number.NaN)).toEqual([]);
  });
});
