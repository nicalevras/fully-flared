import { createFileRoute } from '@tanstack/react-router';
import { requireStaff, requireStaffPermission } from '../../server/session';
import { VARIANT_WIDTHS, detectImageType, variantKey } from '../../server/media';
import { mediaUploadMetaSchema } from '../../schemas/account';

export const Route = createFileRoute('/api/media')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        try {
          const staff = await requireStaff(env.DB, request);
          requireStaffPermission(staff, 'media', 'upload');
        } catch {
          return Response.json({ error: 'Staff access required' }, { status: 403 });
        }
        const form = await request.formData();
        const file = form.get('file');
        if (!(file instanceof File))
          return Response.json({ error: 'file is required' }, { status: 400 });
        const meta = mediaUploadMetaSchema.safeParse({
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        });
        if (!meta.success) {
          return Response.json(
            {
              ok: false,
              error: 'Invalid upload',
              fieldErrors: meta.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
              })),
            },
            { status: 400 }
          );
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const detected = detectImageType(bytes);
        if (!detected) return Response.json({ error: 'Unsupported image type' }, { status: 400 });
        if (file.type && file.type !== detected.contentType) {
          return Response.json(
            { error: 'File contents do not match the declared image type' },
            { status: 400 }
          );
        }
        // Variant upload: the admin browser generated a resized copy of an
        // already-uploaded original. Store it under the derived variant key
        // (no media row; the serving route negotiates ?w= against it).
        const variantOf = form.get('variant_of');
        const variantWidth = Number(form.get('variant_width') ?? 0);
        if (form.has('variant_of') || form.has('variant_width')) {
          if (typeof variantOf !== 'string' || variantOf.length === 0 || variantOf.length > 200) {
            return Response.json({ error: 'Original image is required' }, { status: 400 });
          }
          if (!(VARIANT_WIDTHS as readonly number[]).includes(variantWidth)) {
            return Response.json({ error: 'Unsupported variant width' }, { status: 400 });
          }
          const original = await env.DB.prepare(
            'SELECT r2_key,content_type FROM media WHERE r2_key=? AND deletion_pending=0'
          )
            .bind(variantOf)
            .first<{ r2_key: string; content_type: string }>();
          if (!original)
            return Response.json({ error: 'Original image not found' }, { status: 404 });
          if (original.content_type !== detected.contentType) {
            return Response.json(
              { error: 'Variant format must match the original' },
              { status: 400 }
            );
          }
          const key = variantKey(original.r2_key, variantWidth);
          await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: detected.contentType } });
          const stillActive = await env.DB.prepare(
            'SELECT id FROM media WHERE r2_key=? AND deletion_pending=0'
          )
            .bind(original.r2_key)
            .first();
          if (!stillActive) {
            try {
              await env.MEDIA.delete(key);
            } catch {
              console.error(JSON.stringify({ event: 'late_media_variant_cleanup_failed', key }));
              return Response.json({ error: 'Image deletion cleanup failed' }, { status: 503 });
            }
            return Response.json({ error: 'Image is being deleted' }, { status: 409 });
          }
          return Response.json({
            variant: true,
            key,
            url: `/media/${original.r2_key}?w=${variantWidth}`,
          });
        }
        const key = `${crypto.randomUUID()}.${detected.extension}`;
        await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: detected.contentType } });
        const mediaId = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO media (id, r2_key, filename, content_type, alt_text, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(mediaId, key, file.name, detected.contentType, '', new Date().toISOString())
          .run();
        return Response.json({ id: mediaId, key, url: `/media/${key}` });
      },
    },
  },
});
