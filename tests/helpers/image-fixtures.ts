export function webp(width = 640, height = 480, animated = false): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  const set = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  set(0, 'RIFF');
  view.setUint32(4, 40, true);
  set(8, 'WEBP');
  set(12, 'VP8X');
  view.setUint32(16, 10, true);
  bytes[20] = animated ? 2 : 0;
  for (let i = 0; i < 3; i++) {
    bytes[24 + i] = ((width - 1) >> (8 * i)) & 255;
    bytes[27 + i] = ((height - 1) >> (8 * i)) & 255;
  }
  set(30, 'VP8 ');
  view.setUint32(34, 10, true);
  bytes.set([0, 0, 0, 157, 1, 42], 38);
  view.setUint16(44, width, true);
  view.setUint16(46, height, true);
  return bytes;
}
export function png(width = 640, height = 480, animated = false): Uint8Array {
  const bytes = new Uint8Array(animated ? 57 : 45),
    view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode('IHDR'), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  let offset = 33;
  if (animated) {
    bytes.set(new TextEncoder().encode('acTL'), offset + 4);
    offset += 12;
  }
  bytes.set(new TextEncoder().encode('IEND'), offset + 4);
  return bytes;
}
