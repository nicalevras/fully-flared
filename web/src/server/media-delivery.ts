import type { WorkerEnv } from './env';
import { variantKey } from './media';
import { canonicalizeMediaUrls, mediaKeysInContent } from './media';
import { getSettings } from './settings';

export async function publishedMediaContent(db: D1Database, html: string) {
  const settings = await getSettings(db),
    origins = [settings.canonicalBaseUrl, settings.mediaPublicBaseUrl];
  const keys = mediaKeysInContent(html, origins).slice(0, 500);
  if (!keys.length) return html;
  const rows = await db
    .prepare(
      'SELECT r2_key,public_url FROM media WHERE ready=1 AND deletion_pending=0 AND public_url IS NOT NULL AND r2_key IN(SELECT value FROM json_each(?)) LIMIT 500'
    )
    .bind(JSON.stringify(keys))
    .all<{ r2_key: string; public_url: string }>();
  const urls = new Map(rows.results.map((r) => [r.r2_key, r.public_url]));
  const normalized = canonicalizeMediaUrls(html, origins);
  return normalized.replace(
    /(?:https?:\/\/[^\s"'<>]+)?\/media\/([A-Za-z0-9._-]+)(?:\?w=\d+)?/g,
    (token, key: string) => {
      if (token.startsWith('http') && !origins.includes(new URL(token).origin)) return token;
      return urls.get(key) ?? token;
    }
  );
}

export function publicMediaEnvironment(env: Cloudflare.Env): WorkerEnv {
  return env;
}

/** R2 object storage and CDN eviction are separate operations. Keep the pending
 * database record until every storage deletion and purge has succeeded. */
export async function deleteMediaObjects(
  db: D1Database,
  env: WorkerEnv,
  mediaId: string,
  key: string
) {
  const originalClaim = await db
    .prepare('SELECT 1 FROM media WHERE id=? AND upload_claim_until>?')
    .bind(mediaId, new Date().toISOString())
    .first();
  const publicClaim = await db
    .prepare('SELECT 1 FROM media_publications WHERE media_id=? AND claim_expires_at>? LIMIT 1')
    .bind(mediaId, new Date().toISOString())
    .first();
  if (originalClaim || publicClaim)
    throw Error('An image upload is finishing. Retry deletion shortly.');
  if (
    await db
      .prepare('SELECT 1 FROM media_variants WHERE media_id=? AND upload_claim_until>? LIMIT 1')
      .bind(mediaId, new Date().toISOString())
      .first()
  )
    throw Error('A responsive upload is finishing. Retry deletion shortly.');
  const original = await db
    .prepare('SELECT public_url FROM media WHERE id=?')
    .bind(mediaId)
    .first<{ public_url: string | null }>();
  const variants = await db
    .prepare('SELECT r2_key,public_url FROM media_variants WHERE media_id=?')
    .bind(mediaId)
    .all<{ r2_key: string; public_url: string | null }>();
  const keys = new Set([
    key,
    ...[320, 640, 960, 1600].map((w) => variantKey(key, w)),
    ...variants.results.map((v) => v.r2_key),
  ]);
  const urls = [original?.public_url, ...variants.results.map((v) => v.public_url)].filter(
    (u): u is string => Boolean(u)
  );
  const publications = await db
    .prepare('SELECT object_key,public_url FROM media_publications WHERE media_id=?')
    .bind(mediaId)
    .all<{ object_key: string; public_url: string }>();
  for (const publication of publications.results) {
    keys.add(publication.object_key);
    urls.push(publication.public_url);
  }
  for (const objectKey of keys) await env.MEDIA.delete(objectKey);
  if (urls.length) {
    if (!env.PUBLIC_MEDIA) throw Error('Public media binding is required for deletion');
    for (const objectKey of keys) await env.PUBLIC_MEDIA.delete(`media/${objectKey}`);
    await purgePublicMedia(env, urls);
  }
  await db
    .prepare(
      "UPDATE media_publications SET state='deleted',claim_token=NULL,claim_expires_at=NULL,updated_at=? WHERE media_id=?"
    )
    .bind(new Date().toISOString(), mediaId)
    .run();
}

export async function purgePublicMedia(env: WorkerEnv, urls: string[]) {
  if (!urls.length) return;
  if (!env.MEDIA_ZONE_ID || !env.MEDIA_PURGE_TOKEN)
    throw Error('Public media purge configuration is required');
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.MEDIA_ZONE_ID}/purge_cache`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.MEDIA_PURGE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: urls }),
      signal: AbortSignal.timeout(10_000),
    }
  );
  const result = (await response.json()) as { success?: boolean };
  if (!response.ok || !result.success) throw Error('Public media purge failed');
}

export async function publishMediaObject(
  db: D1Database,
  env: WorkerEnv,
  mediaId: string,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  baseUrl: string
): Promise<string | null> {
  if (!baseUrl) return null;
  if (!env.PUBLIC_MEDIA || !env.MEDIA_ZONE_ID || !env.MEDIA_PURGE_TOKEN)
    throw Error('Public media storage and purge configuration are required');
  const publicUrl = `${baseUrl.replace(/\/$/, '')}/media/${encodeURIComponent(key)}`;
  const token = crypto.randomUUID(),
    timestamp = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO media_publications(id,media_id,object_key,public_url,claim_token,claim_expires_at,fencing,updated_at)
    SELECT ?,?,?,?,?,?,1,? WHERE EXISTS(SELECT 1 FROM media WHERE id=? AND deletion_pending=0)
    ON CONFLICT(public_url) DO UPDATE SET claim_token=excluded.claim_token,claim_expires_at=excluded.claim_expires_at,fencing=media_publications.fencing+1,updated_at=excluded.updated_at
    WHERE media_publications.media_id=excluded.media_id AND media_publications.object_key=excluded.object_key AND media_publications.state!='deleted'
      AND (media_publications.claim_expires_at IS NULL OR media_publications.claim_expires_at<=?)`
    )
    .bind(
      crypto.randomUUID(),
      mediaId,
      key,
      publicUrl,
      token,
      new Date(Date.now() + 120_000).toISOString(),
      timestamp,
      mediaId,
      timestamp
    )
    .run();
  const publication = await db
    .prepare('SELECT id,state,claim_token,fencing FROM media_publications WHERE public_url=?')
    .bind(publicUrl)
    .first<{ id: string; state: string; claim_token: string | null; fencing: number }>();
  if (!publication || publication.claim_token !== token)
    throw Error('Public media publication is busy or deleted');
  try {
    if (publication.state !== 'ready')
      await env.PUBLIC_MEDIA.put(`media/${key}`, bytes, {
        httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
      });
    const updated = await db
      .prepare(
        `UPDATE media_publications SET state='ready',last_error_code=NULL,updated_at=?
      WHERE id=? AND claim_token=? AND fencing=? AND claim_expires_at>? AND state!='deleted'
      AND EXISTS(SELECT 1 FROM media WHERE id=? AND deletion_pending=0)`
      )
      .bind(
        new Date().toISOString(),
        publication.id,
        token,
        publication.fencing,
        new Date().toISOString(),
        mediaId
      )
      .run();
    if (!updated.meta.changes) {
      const active = await db
        .prepare('SELECT 1 FROM media WHERE id=? AND deletion_pending=0')
        .bind(mediaId)
        .first();
      if (!active) {
        await env.PUBLIC_MEDIA.delete(`media/${key}`);
        await purgePublicMedia(env, [publicUrl]);
        await db
          .prepare(
            "UPDATE media_publications SET state='deleted',updated_at=? WHERE id=? AND claim_token=?"
          )
          .bind(new Date().toISOString(), publication.id, token)
          .run();
      }
      throw Error('Media publication claim lost');
    }
    return publicUrl;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'media_publication_incomplete',
        mediaId,
        code: 'storage_or_metadata_failed',
      })
    );
    await db
      .prepare(
        "UPDATE media_publications SET last_error_code='storage_or_metadata_failed',updated_at=? WHERE id=? AND claim_token=?"
      )
      .bind(new Date().toISOString(), publication.id, token)
      .run();
    throw error;
  } finally {
    await db
      .prepare(
        'UPDATE media_publications SET claim_token=NULL,claim_expires_at=NULL WHERE id=? AND claim_token=? AND fencing=?'
      )
      .bind(publication.id, token, publication.fencing)
      .run();
  }
}

/** One immutable object per delivery; operators explicitly start this sweep. */
export async function publishExistingMediaPage(env: WorkerEnv, cursor: string, cutoff: string) {
  const settings = await getSettings(env.DB);
  if (!settings.mediaPublicBaseUrl)
    throw Error('Configure the public media base URL before publishing');
  const row = await env.DB.prepare(
    `SELECT * FROM (
    SELECT id AS media_id,r2_key,content_type,0 AS width FROM media WHERE ready=1 AND deletion_pending=0 AND created_at<=?
    UNION ALL SELECT v.media_id,v.r2_key,v.content_type,v.width FROM media_variants v JOIN media m ON m.id=v.media_id
      WHERE v.ready=1 AND m.ready=1 AND m.deletion_pending=0 AND v.created_at<=?)
    WHERE r2_key>? ORDER BY r2_key LIMIT 1`
  )
    .bind(cutoff, cutoff, cursor)
    .first<{ media_id: string; r2_key: string; content_type: string; width: number }>();
  if (!row) return { cursor, checked: 0, done: true };
  const object = await env.MEDIA.get(row.r2_key);
  if (!object || object.size > 10 * 1024 * 1024)
    throw Error('Source image is missing or exceeds the upload limit');
  const url = await publishMediaObject(
    env.DB,
    env,
    row.media_id,
    row.r2_key,
    new Uint8Array(await object.arrayBuffer()),
    row.content_type,
    settings.mediaPublicBaseUrl
  );
  const result = row.width
    ? await env.DB.prepare(
        'UPDATE media_variants SET public_url=? WHERE media_id=? AND width=? AND r2_key=? AND ready=1 AND EXISTS(SELECT 1 FROM media WHERE id=? AND deletion_pending=0)'
      )
        .bind(url, row.media_id, row.width, row.r2_key, row.media_id)
        .run()
    : await env.DB.prepare(
        'UPDATE media SET public_url=? WHERE id=? AND ready=1 AND deletion_pending=0'
      )
        .bind(url, row.media_id)
        .run();
  if (!result.meta.changes) throw Error('Media changed during publication');
  const { enqueueCatalogRebuild } = await import('./catalog-publisher');
  await enqueueCatalogRebuild(env);
  return { cursor: row.r2_key, checked: 1, done: false };
}
