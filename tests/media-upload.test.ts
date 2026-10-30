import { describe, expect, it } from 'vitest';
import { uploadBodyRejection } from '../web/src/server/media';

const MiB = 1024 * 1024;

function upload(bytes: number, contentLength: string | null) {
  const headers = new Headers({ 'Content-Type': 'multipart/form-data; boundary=x' });
  if (contentLength !== null) headers.set('Content-Length', contentLength);
  return new Request('https://shop.test/api/media', {
    method: 'POST',
    headers,
    body: new Uint8Array(bytes),
  });
}

describe('media upload body size (MS-16)', () => {
  it('6 MiB body is rejected before parsing', () => {
    const request = upload(6 * MiB, String(6 * MiB));
    expect(uploadBodyRejection(request)?.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });

  it('a body without Content-Length is rejected', () => {
    expect(uploadBodyRejection(upload(16, null))?.status).toBe(411);
  });

  it('a 5 MiB image with its multipart framing is accepted', () => {
    expect(uploadBodyRejection(upload(5 * MiB + 1024, String(5 * MiB + 1024)))).toBeNull();
  });
});
