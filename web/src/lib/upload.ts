import * as z from 'zod';
// Single media-upload path for every admin surface. The server route checks
// magic bytes and size; this helper only builds the multipart request and
// normalizes the response/error shape.
export type UploadedMedia = { id: string; key: string; url?: string };

const uploadResponseSchema = z
  .object({
    id: z.string().optional(),
    key: z.string().optional(),
    url: z.string().optional(),
    error: z.string().optional(),
  })
  .loose();

export async function uploadMedia(file: File, alt = ''): Promise<UploadedMedia> {
  const form = new FormData();
  form.set('file', file);
  if (alt) form.set('alt', alt);
  const res = await fetch('/api/media', { method: 'POST', body: form });
  const body = uploadResponseSchema.safeParse(await res.json().catch(() => null)).data ?? null;
  if (!res.ok || !body?.id || !body.key) {
    throw new Error(body?.error ?? `Upload failed (${res.status})`);
  }
  const uploaded: UploadedMedia = {
    id: body.id,
    key: body.key,
    ...(body.url ? { url: body.url } : {}),
  };
  // Best-effort responsive variants, generated here because Workers has no
  // image codec: decode once, downscale on canvas (never upscale), and post
  // each variant against the original key. A failure leaves the original
  // serving every width, exactly as before variants existed.
  try {
    await uploadVariants(file, uploaded.key);
  } catch {
    console.warn(JSON.stringify({ event: 'responsive_media_upload_failed' }));
  }
  return uploaded;
}

async function uploadVariants(file: File, originalKey: string): Promise<void> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return;
  const contentType = originalKey.endsWith('.jpg')
    ? 'image/jpeg'
    : originalKey.endsWith('.png')
      ? 'image/png'
      : originalKey.endsWith('.webp')
        ? 'image/webp'
        : null;
  // Canvas cannot encode GIF; keep its original animation rather than replacing it.
  if (!contentType) return;
  const extension = originalKey.slice(originalKey.lastIndexOf('.') + 1);
  const { variantWidthsFor } = await import('../server/media');
  const bitmap = await createImageBitmap(file);
  try {
    const widths = variantWidthsFor(bitmap.width);
    for (const width of widths) {
      const height = Math.round((bitmap.height * width) / bitmap.width);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, contentType, 0.82)
      );
      if (!blob) continue;
      const form = new FormData();
      form.set('file', new File([blob], `variant-${width}.${extension}`, { type: contentType }));
      form.set('variant_of', originalKey);
      form.set('variant_width', String(width));
      const result = await fetch('/api/media', { method: 'POST', body: form });
      if (!result.ok) throw Error('Responsive upload failed');
    }
  } finally {
    bitmap.close();
  }
}
