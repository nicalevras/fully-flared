import { createFileRoute } from '@tanstack/react-router';
import { requireStaff, requireStaffPermission } from '../../server/session';
import { VARIANT_WIDTHS, detectImageType, readUploadForm, variantKey } from '../../server/media';
import { mediaUploadMetaSchema } from '../../schemas/account';
import { getSettings } from '../../server/settings';
import {
  publishMediaObject,
  publicMediaEnvironment,
  purgePublicMedia,
} from '../../server/media-delivery';
import { enqueueCatalogRebuild } from '../../server/catalog-publisher';

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
        const form = await readUploadForm(request);
        if (form instanceof Response) return form;
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
        const settings = await getSettings(env.DB),
          deliveryEnv = publicMediaEnvironment(env);
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
          if (!VARIANT_WIDTHS.some((width) => width === variantWidth)) {
            return Response.json({ error: 'Unsupported variant width' }, { status: 400 });
          }
          const original = await env.DB.prepare(
            'SELECT id,r2_key,content_type FROM media WHERE r2_key=? AND ready=1 AND deletion_pending=0'
          )
            .bind(variantOf)
            .first<{ id: string; r2_key: string; content_type: string }>();
          if (!original)
            return Response.json({ error: 'Original image not found' }, { status: 404 });
          if (original.content_type !== detected.contentType) {
            return Response.json(
              { error: 'Variant format must match the original' },
              { status: 400 }
            );
          }
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          const legacyKey = variantKey(original.r2_key, variantWidth),
            dot = legacyKey.lastIndexOf('.');
          const proposedKey = `${legacyKey.slice(0, dot)}.${digest.slice(0, 16)}${legacyKey.slice(dot)}`;
          const existing = await env.DB.prepare(
            'SELECT sha256,r2_key,public_url FROM media_variants WHERE media_id=? AND width=?'
          )
            .bind(original.id, variantWidth)
            .first<{ sha256: string; r2_key: string; public_url: string | null }>();
          if (existing && existing.sha256 !== digest)
            return Response.json(
              { error: 'Upload a new original to replace a published image' },
              { status: 409 }
            );
          const key = existing?.r2_key ?? proposedKey;
          const claim = crypto.randomUUID();
          const uploadUntil = new Date(Date.now() + 120_000).toISOString();
          await env.DB.prepare(
            `INSERT INTO media_variants(media_id,width,r2_key,content_type,bytes,sha256,created_at,upload_claim_until,upload_claim_token) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM media WHERE id=? AND deletion_pending=0) ON CONFLICT(media_id,width) DO UPDATE SET upload_claim_until=excluded.upload_claim_until,upload_claim_token=excluded.upload_claim_token WHERE media_variants.sha256=excluded.sha256 AND (media_variants.upload_claim_until IS NULL OR media_variants.upload_claim_until<=?)`
          )
            .bind(
              original.id,
              variantWidth,
              key,
              detected.contentType,
              bytes.length,
              digest,
              new Date().toISOString(),
              uploadUntil,
              claim,
              original.id,
              new Date().toISOString()
            )
            .run();
          const registered = await env.DB.prepare(
            'SELECT r2_key,upload_claim_token FROM media_variants WHERE media_id=? AND width=?'
          )
            .bind(original.id, variantWidth)
            .first<{ r2_key: string; upload_claim_token: string | null }>();
          if (registered?.r2_key !== key || registered.upload_claim_token !== claim)
            return Response.json(
              { error: 'A responsive upload is already in progress. Retry shortly.' },
              { status: 409 }
            );
          let publicUrl: string | null = null;
          let uploadReady = false;
          try {
            await env.MEDIA.put(key, bytes, {
              httpMetadata: { contentType: detected.contentType },
            });
            publicUrl =
              existing?.public_url ??
              (await publishMediaObject(
                env.DB,
                deliveryEnv,
                original.id,
                key,
                bytes,
                detected.contentType,
                settings.mediaPublicBaseUrl
              ));
            const saved = await env.DB.prepare(
              `UPDATE media_variants SET public_url=COALESCE(public_url,?),ready=1 WHERE media_id=? AND width=? AND sha256=? AND upload_claim_token=? AND upload_claim_until>? AND EXISTS(SELECT 1 FROM media WHERE id=? AND deletion_pending=0 AND ready=1)`
            )
              .bind(
                publicUrl,
                original.id,
                variantWidth,
                digest,
                claim,
                new Date().toISOString(),
                original.id
              )
              .run();
            uploadReady = Boolean(saved.meta.changes);
          } finally {
            await env.DB.prepare(
              'UPDATE media_variants SET upload_claim_until=NULL,upload_claim_token=NULL WHERE media_id=? AND width=? AND upload_claim_token=?'
            )
              .bind(original.id, variantWidth, claim)
              .run();
          }
          const stillActive = await env.DB.prepare(
            'SELECT id FROM media WHERE r2_key=? AND deletion_pending=0'
          )
            .bind(original.r2_key)
            .first();
          if (!stillActive) {
            try {
              await env.MEDIA.delete(key);
              if (publicUrl && deliveryEnv.PUBLIC_MEDIA)
                await deliveryEnv.PUBLIC_MEDIA.delete(`media/${key}`);
              if (publicUrl) await purgePublicMedia(deliveryEnv, [publicUrl]);
            } catch {
              console.error(JSON.stringify({ event: 'late_media_variant_cleanup_failed', key }));
              return Response.json({ error: 'Image deletion cleanup failed' }, { status: 503 });
            }
            return Response.json({ error: 'Image is being deleted' }, { status: 409 });
          }
          if (!uploadReady)
            return Response.json(
              { error: 'Responsive upload changed. Retry shortly.' },
              { status: 409 }
            );
          await enqueueCatalogRebuild(env);
          return Response.json({
            variant: true,
            key,
            url: publicUrl ?? `/media/${original.r2_key}?w=${variantWidth}`,
          });
        }
        const key = `${crypto.randomUUID()}.${detected.extension}`;
        const mediaId = crypto.randomUUID();
        const claim = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO media (id,r2_key,filename,content_type,alt_text,created_at,ready,upload_claim_token,upload_claim_until) VALUES (?,?,?,?,?,?,0,?,?)'
        )
          .bind(
            mediaId,
            key,
            file.name,
            detected.contentType,
            '',
            new Date().toISOString(),
            claim,
            new Date(Date.now() + 120_000).toISOString()
          )
          .run();
        let publicUrl: string | null = null;
        try {
          await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: detected.contentType } });
          publicUrl = await publishMediaObject(
            env.DB,
            deliveryEnv,
            mediaId,
            key,
            bytes,
            detected.contentType,
            settings.mediaPublicBaseUrl
          );
          const saved = await env.DB.prepare(
            'UPDATE media SET public_url=?,ready=1 WHERE id=? AND upload_claim_token=? AND upload_claim_until>? AND deletion_pending=0'
          )
            .bind(publicUrl, mediaId, claim, new Date().toISOString())
            .run();
          if (!saved.meta.changes) throw Error('Image deletion won the upload race');
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'media_upload_incomplete',
              mediaId,
              code: 'storage_or_metadata_failed',
            })
          );
          throw error;
        } finally {
          await env.DB.prepare(
            'UPDATE media SET upload_claim_token=NULL,upload_claim_until=NULL WHERE id=? AND upload_claim_token=?'
          )
            .bind(mediaId, claim)
            .run();
        }
        await enqueueCatalogRebuild(env);
        return Response.json({ id: mediaId, key, url: publicUrl ?? `/media/${key}` });
      },
    },
  },
});
