import { afterEach, expect, it, vi } from 'vitest';
import { uploadMedia } from '../web/src/lib/upload';
import { png, webp } from './helpers/image-fixtures';

afterEach(() => vi.unstubAllGlobals());
function browser(failVariant = false, outputType = 'image/webp') {
  const requests: FormData[] = [];
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width: 640, height: 480, close }));
  const toBlob = vi.fn((callback: (value: Blob) => void, mime: string) =>
    callback(new Blob([webp()], { type: outputType === 'image/webp' ? mime : outputType }))
  );
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob }),
  });
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('fetch', async (_url: string, options: { body: FormData }) => {
    requests.push(options.body);
    return failVariant && requests.length > 1
      ? Response.json({ error: 'failed' }, { status: 500 })
      : Response.json({ id: 'original', key: 'original.webp' });
  });
  return { requests, close, decode, toBlob };
}
it('converts before uploading and makes variants from one decoded source', async () => {
  const b = browser();
  await uploadMedia(new File([png()], 'photo.png', { type: 'image/png' }));
  expect(b.decode).toHaveBeenCalledTimes(1);
  expect(b.toBlob).toHaveBeenCalledTimes(2);
  expect(b.requests).toHaveLength(2);
  expect((b.requests[0]!.get('file') as File).type).toBe('image/webp');
  expect(b.close).toHaveBeenCalledTimes(1);
});
it('preserves static WebP original bytes and keeps original after thumbnail failure', async () => {
  const b = browser(true),
    original = webp();
  const result = await uploadMedia(new File([original], 'photo.webp', { type: 'image/webp' }));
  expect(result.id).toBe('original');
  expect(new Uint8Array(await (b.requests[0]!.get('file') as File).arrayBuffer())).toEqual(
    original
  );
  expect(b.toBlob).toHaveBeenCalledTimes(1);
  expect(b.close).toHaveBeenCalled();
});
it('rejects animations, huge dimensions, malformed data and GIF before decoding or uploading', async () => {
  const b = browser();
  for (const bytes of [
    webp(640, 480, true),
    png(640, 480, true),
    png(12000, 12000),
    new TextEncoder().encode('GIF89a'),
    new Uint8Array([1, 2, 3]),
  ])
    await expect(
      uploadMedia(new File([bytes], 'image.png', { type: 'image/png' }))
    ).rejects.toThrow();
  expect(b.decode).not.toHaveBeenCalled();
  expect(b.requests).toHaveLength(0);
});
it('rejects encoder fallback before any upload and closes bitmap', async () => {
  const b = browser(false, 'image/png');
  await expect(uploadMedia(new File([png()], 'image.png', { type: 'image/png' }))).rejects.toThrow(
    'cannot encode WebP'
  );
  expect(b.requests).toHaveLength(0);
  expect(b.close).toHaveBeenCalled();
});
