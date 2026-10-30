import { describe, expect, it } from 'vitest';
import { readUploadForm } from '../web/src/server/media';

const MiB = 1024 * 1024;

function multipart(bytes: number) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], 'photo.png', { type: 'image/png' }));
  return new Request('https://shop.test/api/media', { method: 'POST', body: form });
}

describe('media upload body size (MS-16)', () => {
  it('6 MiB body is rejected before parsing', async () => {
    const request = new Request('https://shop.test/api/media', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=x',
        'Content-Length': String(6 * MiB),
      },
      body: new Uint8Array(6 * MiB),
    });
    const result = await readUploadForm(request);
    expect(result instanceof Response && result.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });

  it('a 6 MiB body without Content-Length is rejected by the capped reader', async () => {
    const request = multipart(6 * MiB);
    expect(request.headers.get('Content-Length')).toBeNull();
    const result = await readUploadForm(request);
    expect(result instanceof Response && result.status).toBe(413);
  });

  it('a 1 MiB body without Content-Length uploads', async () => {
    const request = multipart(MiB);
    expect(request.headers.get('Content-Length')).toBeNull();
    const result = await readUploadForm(request);
    const file = result instanceof FormData ? result.get('file') : null;
    expect(file instanceof File && file.size).toBe(MiB);
  });
});
