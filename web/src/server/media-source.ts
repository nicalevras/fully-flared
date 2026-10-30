import * as z from 'zod';
import type { MediaSource } from '../lib/media-url';

const variantSchema = z.object({ width: z.number(), url: z.string() });

/** Variants from a stored JSON array, skipping malformed entries; unreadable
 *  JSON yields none. */
export function parseMediaVariants(json: string | null): MediaSource['variants'] {
  try {
    const parsed: unknown = json ? JSON.parse(json) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((v: unknown) => {
      const variant = variantSchema.safeParse(v);
      return variant.success ? [variant.data] : [];
    });
  } catch {
    return [];
  }
}

/** Resolve media ids to renderable sources in one query: ready media only,
 * variants carrying the public URL or the /media fallback the publisher uses. */
export async function resolveMediaSources(
  db: D1Database,
  ids: string[]
): Promise<Map<string, MediaSource>> {
  const wanted = [...new Set(ids.filter(Boolean))];
  const sources = new Map<string, MediaSource>();
  if (!wanted.length) return sources;
  const placeholders = wanted.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT m.id, m.r2_key, m.public_url,
        (SELECT json_group_array(json_object('width', v.width, 'url', COALESCE(v.public_url, '/media/' || m.r2_key || '?w=' || v.width)))
         FROM media_variants v WHERE v.media_id = m.id AND v.ready = 1 ORDER BY v.width) AS variants_json
       FROM media m WHERE m.id IN (${placeholders}) AND m.ready = 1 AND m.deletion_pending = 0`
    )
    .bind(...wanted)
    .all<{
      id: string;
      r2_key: string;
      public_url: string | null;
      variants_json: string | null;
    }>();
  for (const row of rows.results) {
    sources.set(row.id, {
      key: row.r2_key,
      publicUrl: row.public_url ?? null,
      variants: parseMediaVariants(row.variants_json),
    });
  }
  return sources;
}
