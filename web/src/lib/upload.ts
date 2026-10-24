import { checkImageDimensions, inspectRaster, MAX_IMAGE_BYTES, MAX_SVG_BYTES } from './image-input';
import { variantWidthsFor } from '../server/media';

export type UploadedMedia = { id: string; key: string; url?: string };

async function send(
  file: File,
  alt: string,
  originalKey?: string,
  width?: number
): Promise<UploadedMedia> {
  const form = new FormData();
  form.set('file', file);
  if (alt) form.set('alt', alt);
  if (originalKey) {
    form.set('variant_of', originalKey);
    form.set('variant_width', String(width));
  }
  const res = await fetch('/api/media', { method: 'POST', body: form });
  const body = (await res.json().catch(() => null)) as {
    id?: string;
    key?: string;
    url?: string;
    error?: string;
  } | null;
  if (!res.ok || !body?.key || (!originalKey && !body.id))
    throw Error(body?.error ?? `Upload failed (${res.status})`);
  return { id: body.id ?? '', key: body.key, ...(body.url ? { url: body.url } : {}) };
}

async function encode(bitmap: ImageBitmap, width: number): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw Error('Image conversion is unavailable in this browser.');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.82)
  );
  if (!blob || blob.type !== 'image/webp') throw Error('This browser cannot encode WebP images.');
  const meta = inspectRaster(new Uint8Array(await blob.arrayBuffer()));
  if (meta.type !== 'webp') throw Error('Image conversion did not produce WebP.');
  return new File([blob], 'image.webp', { type: 'image/webp' });
}

export async function uploadMedia(file: File, alt = ''): Promise<UploadedMedia> {
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) throw Error('Image must be at most 5 MiB.');
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    if (file.size > MAX_SVG_BYTES) throw Error('SVG must be at most 2 MiB.');
    return send(new File([file], file.name, { type: 'image/svg+xml' }), alt);
  }
  const meta = inspectRaster(new Uint8Array(await file.arrayBuffer()));
  const bitmap = await createImageBitmap(file);
  try {
    checkImageDimensions(bitmap.width, bitmap.height);
    const original =
      meta.type === 'webp'
        ? new File([file], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' })
        : await encode(bitmap, bitmap.width);
    const namedOriginal = new File([original], file.name.replace(/\.[^.]+$/, '') + '.webp', {
      type: 'image/webp',
    });
    const uploaded = await send(namedOriginal, alt);
    try {
      for (const width of variantWidthsFor(bitmap.width))
        await send(await encode(bitmap, width), '', uploaded.key, width);
    } catch {
      console.warn(JSON.stringify({ event: 'responsive_media_upload_failed' }));
    }
    return uploaded;
  } finally {
    bitmap.close();
  }
}
