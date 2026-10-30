import { afterEach, expect, it, vi } from 'vitest';
import { uploadMedia } from '../web/src/lib/upload';
import { at } from './helpers/fixtures';
import { readFileSync } from 'node:fs';
import { describe } from 'vitest';

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
      const file = at(requests, 1).get('file');
      if (!(file instanceof File)) throw new Error('expected the variant upload to carry a file');
      expect(file.type).toBe(type);
    }
  }
);

describe('image upload node pairing', () => {
  it('keeps results paired with their files and retains failures for retry', () => {
    const node = readFileSync(
      'web/src/components/tiptap-node/image-upload-node/image-upload-node.tsx',
      'utf8'
    );
    expect(node).toContain('results.map((result, index) => ({ file: files[index]!, ...result }))');
    expect(node).not.toContain('results.filter((url)');
    expect(node).not.toContain('files[index]?.name');
    expect(node).toContain('const hasFailures = successes.length < results.length');
    expect(node).toContain('if (!hasFailures) chain.deleteRange');
    expect(node).toContain('onRetry={() => void handleRetry(fileItem)}');
    expect(node).toContain("fileItem.status === 'error' && onRetry");
  });
});
