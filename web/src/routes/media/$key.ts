import { createFileRoute } from '@tanstack/react-router';
import { VARIANT_WIDTHS, variantKey } from '../../server/media';

const VARIANT_WIDTH_SET = new Set<number>(VARIANT_WIDTHS);

export const Route = createFileRoute('/media/$key')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { env } = await import('cloudflare:workers');
        const url = new URL(request.url);
        const requestedWidth = Number(url.searchParams.get('w') ?? 0);
        const active = await env.DB.prepare(
          'SELECT 1 FROM media WHERE r2_key=? AND ready=1 AND deletion_pending=0'
        )
          .bind(params.key)
          .first();
        if (!active) return new Response('Not found', { status: 404 });
        let object: R2ObjectBody | null = null;
        if (VARIANT_WIDTH_SET.has(requestedWidth)) {
          const variant = await env.DB.prepare(
            'SELECT v.r2_key FROM media_variants v JOIN media m ON m.id=v.media_id WHERE m.r2_key=? AND v.width=? AND v.ready=1 AND m.deletion_pending=0'
          )
            .bind(params.key, requestedWidth)
            .first<{ r2_key: string }>();
          object = await env.MEDIA.get(variant?.r2_key ?? variantKey(params.key, requestedWidth));
        }
        object ??= await env.MEDIA.get(params.key);
        if (!object) return new Response('Not found', { status: 404 });

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('ETag', object.httpEtag);
        headers.set('Cache-Control', 'public, max-age=300, must-revalidate');
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'image/jpeg');

        const ifNoneMatch = request.headers.get('If-None-Match');
        if (
          ifNoneMatch &&
          ifNoneMatch.replace(/W\//g, '') === object.httpEtag.replace(/W\//g, '')
        ) {
          return new Response(null, { status: 304, headers });
        }
        return new Response(object.body, { headers });
      },
    },
  },
});
