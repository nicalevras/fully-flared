import { imageMeta } from 'image-meta';

export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/bmp,image/svg+xml';
export const IMAGE_GUIDANCE =
  'Static JPEG, PNG, WebP, AVIF, BMP or SVG. No GIFs or animations. Raster images become lossy WebP; sharp text may change. Maximum 5 MiB, 24 megapixels and 8192 px per side. SVG maximum 2 MiB.';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_SVG_BYTES = 2 * 1024 * 1024;
export const SVG_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox";
const text = (bytes: Uint8Array, start: number, length: number) =>
  new TextDecoder().decode(bytes.subarray(start, start + length));

export function checkImageDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 24_000_000
  )
    throw Error('Image exceeds 24 megapixels or 8192 pixels per side.');
}

function chunks(
  bytes: Uint8Array,
  start: number,
  littleEndian: boolean,
  visit: (kind: string, offset: number, size: number) => void
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw Error('Malformed image container.');
    const kind = text(bytes, offset + (littleEndian ? 0 : 4), 4);
    const length = view.getUint32(offset + (littleEndian ? 4 : 0), littleEndian);
    const size = littleEndian ? length + 8 + (length % 2) : length;
    if (size < 8 || offset + size > bytes.length) throw Error('Malformed image container.');
    visit(kind, offset, size);
    offset += size;
  }
}

export function inspectRaster(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw Error('Image must be at most 5 MiB.');
  const meta = imageMeta(bytes);
  if (!meta.type || !['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp'].includes(meta.type))
    throw Error('Use a static JPEG, PNG, WebP, AVIF, BMP or SVG. GIFs are not accepted.');
  checkImageDimensions(meta.width, meta.height);
  if (meta.type === 'webp') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length < 20 ||
      text(bytes, 0, 4) !== 'RIFF' ||
      text(bytes, 8, 4) !== 'WEBP' ||
      view.getUint32(4, true) + 8 !== bytes.length
    )
      throw Error('Malformed WebP image.');
    let pictures = 0;
    chunks(bytes, 12, true, (kind, offset, size) => {
      if (kind === 'VP8X' && offset !== 12)
        throw Error('WebP must have a single leading canvas header.');
      if (
        kind === 'ANIM' ||
        kind === 'ANMF' ||
        (kind === 'VP8X' && (size !== 18 || (bytes[offset + 8] ?? 0) & 2))
      )
        throw Error('Animated images are not accepted.');
      if (kind === 'VP8 ' || kind === 'VP8L') {
        pictures++;
        const payload = offset + 8;
        let width: number, height: number;
        if (kind === 'VP8 ') {
          if (
            size < 18 ||
            bytes[payload + 3] !== 0x9d ||
            bytes[payload + 4] !== 1 ||
            bytes[payload + 5] !== 0x2a ||
            (bytes[payload] ?? 1) & 1
          )
            throw Error('Malformed WebP frame.');
          width = view.getUint16(payload + 6, true) & 0x3fff;
          height = view.getUint16(payload + 8, true) & 0x3fff;
        } else {
          if (size < 14 || bytes[payload] !== 0x2f) throw Error('Malformed WebP frame.');
          const dimensions = view.getUint32(payload + 1, true);
          if (dimensions >>> 29) throw Error('Unsupported WebP lossless version.');
          width = (dimensions & 0x3fff) + 1;
          height = ((dimensions >>> 14) & 0x3fff) + 1;
        }
        checkImageDimensions(width, height);
        if (width !== meta.width || height !== meta.height)
          throw Error('WebP frame dimensions do not match its canvas.');
      }
    });
    if (pictures !== 1) throw Error('Malformed WebP image.');
  }
  if (meta.type === 'png') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    let ended = false;
    while (offset < bytes.length) {
      if (ended || offset + 12 > bytes.length) throw Error('Malformed PNG image.');
      const size = view.getUint32(offset);
      const kind = text(bytes, offset + 4, 4);
      if (
        (offset === 8 && kind !== 'IHDR') ||
        (kind === 'IHDR' && (offset !== 8 || size !== 13)) ||
        (kind === 'IEND' && size !== 0)
      )
        throw Error('Malformed PNG image.');
      if (offset + size + 12 > bytes.length) throw Error('Malformed PNG image.');
      if (['acTL', 'fcTL', 'fdAT'].includes(kind)) throw Error('Animated images are not accepted.');
      ended = kind === 'IEND';
      offset += size + 12;
    }
    if (!ended) throw Error('Malformed PNG image.');
  }
  if (meta.type === 'avif') {
    let staticBrand = false,
      dimensionsFound = false;
    const visit = (input: Uint8Array, depth: number): void => {
      if (depth > 8) throw Error('Malformed AVIF image.');
      const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
      chunks(input, 0, false, (kind, offset, size) => {
        if (kind === 'moov') throw Error('Animated images are not accepted.');
        if (kind === 'clap') throw Error('AVIF cropped dimensions are not supported.');
        if (kind === 'ftyp') {
          if (size < 16 || size % 4) throw Error('Malformed AVIF image.');
          for (let i = offset + 8; i < offset + size; i += 4) {
            if (i === offset + 12) continue;
            const brand = text(input, i, 4);
            if (brand === 'avis' || brand === 'msf1')
              throw Error('Animated images are not accepted.');
            if (brand === 'avif') staticBrand = true;
          }
        }
        if (kind === 'ispe') {
          if (size !== 20) throw Error('Malformed AVIF dimensions.');
          checkImageDimensions(view.getUint32(offset + 12), view.getUint32(offset + 16));
          dimensionsFound = true;
        }
        if (['meta', 'iprp', 'ipco'].includes(kind))
          visit(input.subarray(offset + (kind === 'meta' ? 12 : 8), offset + size), depth + 1);
      });
    };
    visit(bytes, 0);
    if (!staticBrand || !dimensionsFound) throw Error('Static AVIF could not be established.');
  }
  return meta;
}
