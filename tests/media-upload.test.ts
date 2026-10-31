import { describe, expect, it, vi } from 'vitest';
import { readUploadForm } from '../web/src/server/media';

const MiB = 1024 * 1024;

async function multipart(bytes: number) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], 'photo.png', { type: 'image/png' }));
  const encoded = new Response(form);
  return new Request('https://shop.test/api/media', {
    method: 'POST',
    headers: encoded.headers,
    body: await encoded.arrayBuffer(),
  });
}

function streamedMultipart(body: ReadableStream<Uint8Array>) {
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
    body,
    duplex: 'half',
  };
  return new Request('https://shop.test/api/media', init);
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
    const request = await multipart(6 * MiB);
    expect(request.headers.get('Content-Length')).toBeNull();
    const result = await readUploadForm(request);
    expect(result instanceof Response && result.status).toBe(413);
  });

  it('a 1 MiB body without Content-Length uploads', async () => {
    const request = await multipart(MiB);
    expect(request.headers.get('Content-Length')).toBeNull();
    const result = await readUploadForm(request);
    const file = result instanceof FormData ? result.get('file') : null;
    expect(file instanceof File && file.size).toBe(MiB);
  });

  it('waits for an oversized network stream to cancel before returning', async () => {
    const cancel = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(MiB));
      },
      cancel,
    });
    const request = streamedMultipart(body);
    const result = await readUploadForm(request);
    expect(result instanceof Response && result.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel.mock.settledResults[0]?.type).toBe('fulfilled');
    expect(body.locked).toBe(false);
  });

  it('propagates a network stream failure and releases its reader', async () => {
    const failure = new Error('upload connection interrupted');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    const request = streamedMultipart(body);
    await expect(readUploadForm(request)).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });
});
