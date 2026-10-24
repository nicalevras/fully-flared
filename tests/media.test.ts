import { describe, expect, it } from 'vitest';
import { variantKey, variantWidthsFor } from '../web/src/server/media';

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

it('bounds static containers and rejects animation, cropped AVIF and inconsistent WebP frames', async () => {
  const { inspectRaster } = await import('../web/src/lib/image-input');
  const { png, webp } = await import('./helpers/image-fixtures');
  const box = (name: string, ...parts: Uint8Array[]) => {
    const bytes = new Uint8Array(8 + parts.reduce((n, p) => n + p.length, 0));
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set(new TextEncoder().encode(name), 4);
    let offset = 8;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  };
  const avif = (brand = 'avif', cropped = false, width = 640) => {
    const dims = new Uint8Array(12),
      view = new DataView(dims.buffer);
    view.setUint32(4, width);
    view.setUint32(8, 480);
    const ftyp = box('ftyp', new TextEncoder().encode(`${brand}0000${brand}`));
    const meta = box(
      'meta',
      new Uint8Array(4),
      box('iprp', box('ipco', box('ispe', dims), ...(cropped ? [box('clap')] : [])))
    );
    return new Uint8Array([...ftyp, ...meta]);
  };
  expect(inspectRaster(avif()).type).toBe('avif');
  expect(inspectRaster(png()).width).toBe(640);
  const inconsistent = webp();
  new DataView(inconsistent.buffer).setUint16(44, 12000, true);
  for (const bytes of [
    avif('avis'),
    avif('avif', true),
    avif('avif', false, 12000),
    avif().slice(0, -1),
    png(640, 480, true),
    webp(640, 480, true),
    inconsistent,
  ])
    expect(() => inspectRaster(bytes)).toThrow();
});
