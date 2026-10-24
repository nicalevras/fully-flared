import { IMAGE_ACCEPT, IMAGE_GUIDANCE } from '../../lib/image-input';
import { useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { formatDate } from '../../lib/format';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn, useServerFn } from '@tanstack/react-start';
import * as z from 'zod';
import { validateServerInput } from '../../server/function-boundary';
import { requireStaffPermission } from '../../server/session';
import { getRequest } from '@tanstack/react-start/server';
import { mediaKeysInContent } from '../../server/media';
import { getSettings } from '../../server/settings';
import { useAdminAction, type AdminPayload } from '../../components/AdminNav';
import { uploadMedia } from '../../lib/upload';
import {
  btnDestructive,
  btnSmall,
  cardCls,
  inputCls,
  pageSub,
  pageTitle,
} from '../../components/ui';

type MediaRow = {
  id: string;
  r2_key: string;
  filename: string;
  content_type: string;
  alt_text: string;
  created_at: string;
  used_count: number;
  deletion_pending: number;
  ready: number;
};

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .handler(async () => {
    const { env } = await import('cloudflare:workers');
    const rows = await env.DB.prepare(
      `SELECT m.id, m.r2_key, m.filename, m.content_type, m.alt_text, m.created_at, m.deletion_pending,m.ready,
            (SELECT COUNT(*) FROM product_media pm WHERE pm.media_id = m.id)
            + (SELECT COUNT(*) FROM posts p WHERE p.cover_media_id = m.id) AS used_count
     FROM media m ORDER BY m.created_at DESC LIMIT 200`
    ).all<MediaRow>();
    // Content references (including percent-encoded forms SQL cannot
    // decode) are counted with the shared extractor, one per content row.
    const settings = await getSettings(env.DB);
    let requestOrigin = '';
    try {
      requestOrigin = new URL(getRequest().url).origin;
    } catch {
      requestOrigin = '';
    }
    let canonicalOrigin = '';
    try {
      canonicalOrigin = new URL(settings.canonicalBaseUrl).origin;
    } catch {
      canonicalOrigin = '';
    }
    const origins = [
      ...new Set([canonicalOrigin, requestOrigin, settings.mediaPublicBaseUrl].filter(Boolean)),
    ];
    const contentCounts = new Map<string, number>();
    const addContent = (html: string | null, json?: string | null) => {
      const keys = new Set([
        ...mediaKeysInContent(html, origins),
        ...mediaKeysInContent(json, origins),
      ]);
      for (const key of keys) contentCounts.set(key, (contentCounts.get(key) ?? 0) + 1);
    };
    const postContents = await env.DB.prepare('SELECT content_html, content_json FROM posts').all<{
      content_html: string | null;
      content_json: string | null;
    }>();
    for (const row of postContents.results) addContent(row.content_html, row.content_json);
    const pageContents = await env.DB.prepare('SELECT content_html FROM pages').all<{
      content_html: string | null;
    }>();
    for (const row of pageContents.results) addContent(row.content_html);
    const media = rows.results.map((row) => ({
      ...row,
      used_count: row.used_count + (contentCounts.get(row.r2_key) ?? 0),
    }));
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM media').first<{ n: number }>();
    return { media, total: count?.n ?? rows.results.length };
  });

export const Route = createFileRoute('/admin/media')({
  loader: async () => getData(),
  component: AdminMedia,
});

const publishExistingFn = createServerFn({ method: 'POST' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(z.object({})))
  .handler(async ({ context }) => {
    const { workerEnv: env } = await import('../../server/env');
    requireStaffPermission(context.staff, 'media', 'upload');
    const settings = await getSettings(env.DB);
    if (
      !settings.mediaPublicBaseUrl ||
      !env.PUBLIC_MEDIA ||
      !env.MEDIA_ZONE_ID ||
      !env.MEDIA_PURGE_TOKEN
    )
      throw Error('Configure public media storage, delivery URL and purge credentials first.');
    const { startMaintenance } = await import('../../server/maintenance');
    if (!(await startMaintenance(env, 'media-publication', crypto.randomUUID())))
      throw Error('Media publication is durable but could not be queued. Retry to resume it.');
    return { ok: true };
  });

function AdminMedia() {
  const adminAction = useAdminAction();
  const publishExisting = useServerFn(publishExistingFn);

  const { media, total } = Route.useLoaderData();
  const router = useRouter();
  const [alts, setAlts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [publishing, setPublishing] = useState(false);

  async function run(action: string, payload: AdminPayload, ok: string) {
    setBusy(true);
    const r = await adminAction(action, payload);
    setBusy(false);
    if (r.ok) {
      setMsg(ok);
      router.invalidate();
    } else setMsg(r.error ?? 'Failed');
  }

  return (
    <main>
      <button
        type="button"
        className={btnSmall}
        disabled={publishing}
        onClick={async () => {
          if (!window.confirm('Publish existing images to the configured public media storage?'))
            return;
          setPublishing(true);
          try {
            await publishExisting({ data: {} });
            setMsg(
              'Public media publication queued. Use this action again to resume an unfinished run.'
            );
          } catch {
            setMsg('Public media publication could not start. Check configuration and retry.');
          } finally {
            setPublishing(false);
          }
        }}
      >
        {publishing ? 'Queueing publication…' : 'Publish existing media'}
      </button>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={pageTitle}>Media</h1>
          <p className={pageSub}>
            {total} file{total === 1 ? '' : 's'} in your library. Alt text is what screen readers
            and search engines read — write it like a caption for someone who cannot see the image.
          </p>
        </div>
        <label className={`${btnSmall} cursor-pointer`}>
          {uploading ? 'Uploading…' : 'Upload image'}
          <input
            type="file"
            accept={IMAGE_ACCEPT}
            className="sr-only"
            aria-label="Upload image"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setUploading(true);
              try {
                await uploadMedia(file);
                setMsg(
                  'Image uploaded. Add its alt text below, then attach it from a product or post.'
                );
                router.invalidate();
              } catch (err) {
                setMsg(err instanceof Error ? err.message : 'Upload failed');
              } finally {
                setUploading(false);
              }
            }}
          />
        </label>
      </div>

      <p className="text-xs text-zinc-500">{IMAGE_GUIDANCE}</p>
      {media.length === 0 ? (
        <p className={`${cardCls} mt-6 p-5 text-sm text-zinc-500`} role="status">
          No media yet. Upload your first image above, or add one from a product page.
        </p>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {media.map((m) => (
            <li key={m.id} className={`${cardCls} overflow-hidden`}>
              {m.deletion_pending ? (
                <p className="p-5 text-sm text-zinc-500">
                  Deletion pending. Retry to remove the remaining files.
                </p>
              ) : !m.ready ? (
                <p className="p-5 text-sm text-zinc-500">
                  Upload incomplete. Remove this record and upload the image again.
                </p>
              ) : (
                <img
                  src={`/media/${m.r2_key}`}
                  alt={m.alt_text || m.filename}
                  className="aspect-[4/3] w-full object-cover"
                />
              )}
              <div className="space-y-3 p-4">
                <p className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate font-medium text-zinc-950">{m.filename}</span>
                </p>
                <p className="text-[13px] text-zinc-500">
                  {m.used_count > 0
                    ? `Used in ${m.used_count} place${m.used_count === 1 ? '' : 's'}`
                    : 'Not used anywhere yet'}
                  {' · '}
                  {formatDate(m.created_at)}
                </p>
                <div>
                  <label className="sr-only" htmlFor={`alt-${m.id}`}>
                    Alt text for {m.filename}
                  </label>
                  <input
                    id={`alt-${m.id}`}
                    className={inputCls}
                    placeholder="Describe this image"
                    value={alts[m.id] ?? m.alt_text}
                    onChange={(e) => setAlts({ ...alts, [m.id]: e.target.value })}
                  />
                </div>
                <span className="flex gap-1">
                  <button
                    className={btnSmall}
                    disabled={
                      busy || !!m.deletion_pending || (alts[m.id] ?? m.alt_text) === m.alt_text
                    }
                    onClick={() =>
                      run(
                        'media.updateAlt',
                        { mediaId: m.id, altText: alts[m.id] ?? '' },
                        `Alt text saved for ${m.filename}.`
                      )
                    }
                  >
                    Save alt text
                  </button>
                  <button
                    className={btnDestructive}
                    disabled={busy || m.used_count > 0}
                    title={
                      m.used_count > 0
                        ? 'In use — remove it from its product or post first'
                        : 'Delete this image'
                    }
                    onClick={async () => {
                      if (!window.confirm(`Delete ${m.filename} permanently?`)) return;
                      await run('media.delete', { mediaId: m.id }, `${m.filename} deleted.`);
                    }}
                  >
                    {m.deletion_pending ? 'Retry deletion' : 'Delete'}
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {msg ? (
        <p className="mt-4 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700" role="status">
          {msg}
        </p>
      ) : null}
    </main>
  );
}
