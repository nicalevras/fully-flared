import { afterEach, expect, it, vi } from 'vitest';
import { uploadMedia } from '../web/src/lib/upload';

afterEach(() => vi.unstubAllGlobals());
it.each([
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
])(
  'generates matching %s variants and leaves animated GIF originals intact',
  async (extension, type) => {
    const requests: FormData[] = [];
    const toBlob = vi.fn((callback: (value: Blob) => void, mime: string) =>
      callback(new Blob(['encoded'], { type: mime }))
    );
    vi.stubGlobal('document', {
      createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob }),
    });
    vi.stubGlobal('createImageBitmap', async () => ({ width: 640, height: 480, close() {} }));
    vi.stubGlobal('fetch', async (_url: string, options: { body: FormData }) => {
      requests.push(options.body);
      return Response.json({ id: 'original', key: `original.${extension}` });
    });
    await uploadMedia(new File(['original'], `original.${extension}`, { type }));
    if (extension === 'gif') {
      expect(requests).toHaveLength(1);
      expect(toBlob).not.toHaveBeenCalled();
    } else {
      expect(requests).toHaveLength(2);
      expect((requests[1]!.get('file') as File).type).toBe(type);
    }
  }
);
