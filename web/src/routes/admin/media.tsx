import { useState } from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import { staffMiddleware } from '../../server/staff-middleware';
import { formatDate } from '../../lib/format';
import { createFileRoute, useRouter, type SearchSchemaInput } from '@tanstack/react-router';
import { createServerFn, useServerFn } from '@tanstack/react-start';
import * as z from 'zod';
import { validateServerInput } from '../../server/function-boundary';
import { requireStaffPermission } from '../../server/session';
import { getSettings } from '../../server/settings';
import { mediaUrl, type MediaSource } from '../../lib/media-url';
import { pageWindow } from '../../lib/catalog-page';
import { AdminRowActions } from '../../components/AdminDataTable';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useAdminAction, type AdminPayload } from '../../components/AdminNav';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../components/AdminActionFeedback';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '../../components/ui/drawer';
import type { ColumnDef, OnChangeFn, PaginationState } from '@tanstack/react-table';
import { DataTable, DataTableSearch } from '../../components/ui/data-table';
import { ftsPhrase, ftsUsable } from '../../lib/fts-search';
import type { DataTableFeatures } from '../../components/data-table-features';
import { isPageSize, pageSizeOptions } from '../../lib/search-params';
import { pageSizeSchema } from '../../schemas/pagination';
import { uploadMedia } from '../../lib/upload';
import {
  Button,
  btnDestructive,
  btnPrimary,
  btnSmall,
  hintCls,
  inputCls,
  labelCls,
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
  deletion_pending: number;
  ready: number;
  public_url: string | null;
  variants_json: string | null;
};

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(
    validateServerInput(
      z.object({
        q: z.string().max(200).default(''),
        page: z.number().int().min(1).default(1),
        size: pageSizeSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    requireStaffPermission(context.staff, 'media', 'view');
    const { env } = await import('cloudflare:workers');
    const q = data.q.trim();
    // < 3 chars cannot hit the trigram index; return nothing rather than scan.
    const where = q
      ? ftsUsable(q)
        ? 'WHERE m.rowid IN (SELECT rowid FROM media_fts WHERE media_fts MATCH ?)'
        : 'WHERE 1=0'
      : '';
    const binds = q && ftsUsable(q) ? [ftsPhrase(q)] : [];
    const countRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM media m ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    const totalCount = countRow?.n ?? 0;
    const { page, offset } = pageWindow(totalCount, data.page, data.size);
    const rows = await env.DB.prepare(
      `SELECT m.id, m.r2_key, m.filename, m.content_type, m.alt_text, m.created_at, m.deletion_pending, m.ready, m.public_url,
            (SELECT json_group_array(json_object('width', width, 'url', COALESCE(public_url, '')))
             FROM (SELECT width, public_url FROM media_variants
                   WHERE media_id = m.id AND ready = 1 ORDER BY width)) AS variants_json
     FROM media m ${where} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...binds, data.size, offset)
      .all<MediaRow>();
    return { media: rows.results, total: totalCount, page, pageSize: data.size };
  });

export const getMediaDetail = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(z.object({ mediaId: z.string().min(1) })))
  .handler(async ({ data, context }): Promise<{ usedCount: number } | null> => {
    requireStaffPermission(context.staff, 'media', 'view');
    const { env } = await import('cloudflare:workers');
    const row = await env.DB.prepare('SELECT r2_key FROM media WHERE id = ?')
      .bind(data.mediaId)
      .first<{ r2_key: string }>();
    if (!row) return null;
    const settings = await getSettings(env.DB);
    const structural = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM product_media WHERE media_id = ?)
            + (SELECT COUNT(*) FROM posts WHERE cover_media_id = ?) AS n`
    )
      .bind(data.mediaId, data.mediaId)
      .first<{ n: number }>();
    // Content references are counted with the same substring predicates the
    // media.delete claim uses. Percent-encoded keys cannot be matched in
    // SQL; media.delete's full scan stays the final gate.
    const content = await env.DB.prepare(
      `WITH keys(k) AS (VALUES (?))
       SELECT
         (SELECT COUNT(*) FROM posts
           WHERE instr(REPLACE(content_html, '\\/', '/'), '/media/' || k) > 0
              OR instr(REPLACE(COALESCE(content_json, ''), '\\/', '/'), '/media/' || k) > 0)
         + (SELECT COUNT(*) FROM pages
           WHERE instr(REPLACE(content_html, '\\/', '/'), '/media/' || k) > 0)
         + (SELECT COUNT(*) FROM products
           WHERE instr(REPLACE(COALESCE(description, ''), '\\/', '/'), '/media/' || k) > 0) AS n
       FROM keys`
    )
      .bind(row.r2_key)
      .first<{ n: number }>();
    return {
      usedCount:
        (structural?.n ?? 0) +
        (content?.n ?? 0) +
        (settings.logoMediaId === data.mediaId ? 1 : 0) +
        (settings.heroMediaId === data.mediaId ? 1 : 0),
    };
  });

export const Route = createFileRoute('/admin/media')({
  staleTime: 30_000,
  validateSearch: (
    search: { q?: unknown; edit?: unknown; page?: unknown; size?: unknown } & SearchSchemaInput
  ) => ({
    q: typeof search.q === 'string' && search.q ? search.q : undefined,
    edit: typeof search.edit === 'string' && search.edit ? search.edit : undefined,
    page:
      typeof search.page === 'number' && Number.isInteger(search.page) && search.page > 0
        ? search.page
        : 1,
    size: isPageSize(search.size) ? search.size : undefined,
  }),
  loaderDeps: ({ search }) => ({
    q: search.q ?? '',
    page: search.page,
    size: search.size ?? 25,
    edit: search.edit ?? '',
  }),
  loader: async ({ deps: { edit, ...list } }) => {
    const [data, detail] = await Promise.all([
      getData({ data: list }),
      // Usage stays unknown, and delete stays disabled, if it cannot be read.
      edit ? getMediaDetail({ data: { mediaId: edit } }).catch(() => null) : null,
    ]);
    return { ...data, usedCount: detail?.usedCount ?? null };
  },
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

function mediaSource(row: MediaRow): MediaSource {
  let variants: Array<{ width: number; url: string }> | undefined;
  if (row.variants_json) {
    try {
      const parsed = JSON.parse(row.variants_json) as unknown;
      if (Array.isArray(parsed)) {
        // Same fill the catalog publisher applies: variants stored without a
        // public URL are served through the media route at that width.
        variants = (parsed as Array<{ width: number; url: string }>).map((variant) => ({
          ...variant,
          url: variant.url || `/media/${encodeURIComponent(row.r2_key)}?w=${variant.width}`,
        }));
      }
    } catch {
      variants = undefined;
    }
  }
  return { key: row.r2_key, publicUrl: row.public_url, variants };
}

function usedLabel(usedCount: number): string {
  return usedCount > 0
    ? `Used in ${usedCount} place${usedCount === 1 ? '' : 's'}`
    : 'Not used anywhere yet';
}

function MediaDrawer({
  row,
  usedCount,
  busy,
  onClose,
  onSaveAlt,
  onDelete,
}: {
  row: MediaRow;
  usedCount: number | null;
  busy: boolean;
  onClose: () => void;
  onSaveAlt: (altText: string) => Promise<boolean>;
  onDelete: (row: MediaRow) => void;
}) {
  const [alt, setAlt] = useState(row.alt_text);
  const [discardOpen, setDiscardOpen] = useState(false);
  const dirty = alt !== row.alt_text;
  const requestClose = () => {
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  };
  return (
    <Drawer
      instant
      swipeDirection="right"
      open
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DrawerContent
        className="w-full max-w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0 sm:max-w-2xl"
        initialFocus={false}
      >
        <DrawerClose
          render={
            <button
              type="button"
              aria-label="Close"
              className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-950"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </button>
          }
        />
        <DrawerHeader className="p-5 pr-14 pb-0 sm:p-6 sm:pr-14 sm:pb-0">
          <DrawerTitle>{row.filename}</DrawerTitle>
          <DrawerDescription>
            {row.content_type} · {formatDate(row.created_at)}
            {usedCount !== null ? ` · ${usedLabel(usedCount)}` : ''}
          </DrawerDescription>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {row.deletion_pending ? (
            <p className="rounded-xl bg-zinc-50 px-4 py-10 text-center text-sm text-zinc-500">
              Deletion pending. Retry to remove the remaining files.
            </p>
          ) : !row.ready ? (
            <p className="rounded-xl bg-zinc-50 px-4 py-10 text-center text-sm text-zinc-500">
              Upload incomplete. Remove this record and upload the image again.
            </p>
          ) : (
            <img
              src={mediaUrl(mediaSource(row), 960)}
              alt={row.alt_text || row.filename}
              className="aspect-[4/3] w-full rounded-xl bg-zinc-100 object-cover"
            />
          )}
          <div className="mt-5">
            <label className={labelCls} htmlFor="media-alt">
              Alt text
            </label>
            <input
              id="media-alt"
              className={inputCls}
              placeholder="Describe this image"
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
            />
            <p className={hintCls}>
              What screen readers and search engines read. Write it like a caption for someone who
              cannot see the image.
            </p>
          </div>
          <div className="mt-6 border-t border-zinc-100 pt-4">
            <button
              type="button"
              className={btnDestructive}
              disabled={busy || usedCount === null || usedCount > 0}
              title={
                usedCount !== null && usedCount > 0
                  ? 'In use. Remove it from its product or post first'
                  : 'Delete this image'
              }
              onClick={() => onDelete(row)}
            >
              {row.deletion_pending ? 'Retry deletion' : 'Delete image'}
            </button>
            {usedCount !== null && usedCount > 0 ? (
              <p className={hintCls}>In use. Remove it from its product or post first.</p>
            ) : null}
          </div>
        </div>
        {dirty ? (
          <div className="border-t border-zinc-100 bg-white px-5 py-3.5 sm:px-6">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button type="button" className={btnSmall} disabled={busy} onClick={onClose}>
                Discard
              </button>
              <button
                type="button"
                className={btnPrimary}
                disabled={busy}
                onClick={async () => {
                  if (await onSaveAlt(alt)) onClose();
                }}
              >
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        ) : null}
        <ConfirmDialog
          request={
            discardOpen
              ? {
                  title: 'Discard unsaved changes?',
                  body: "Your changes to this image haven't been saved.",
                  confirmLabel: 'Discard changes',
                }
              : null
          }
          busy={false}
          onCancel={() => setDiscardOpen(false)}
          onConfirm={() => {
            setDiscardOpen(false);
            onClose();
          }}
        />
      </DrawerContent>
    </Drawer>
  );
}

function AdminMedia() {
  const adminAction = useAdminAction();
  const publishExisting = useServerFn(publishExistingFn);

  const { media, total, page, pageSize, usedCount } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    action: () => void | Promise<void>;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [publishing, setPublishing] = useState(false);

  async function run(action: string, payload: AdminPayload, ok: string): Promise<boolean> {
    setBusy(true);
    const r = await adminAction(action, payload);
    setBusy(false);
    if (r.ok) {
      setFeedback({ kind: 'status', message: ok });
      router.invalidate();
      return true;
    }
    setFeedback({ kind: 'error', message: r.error ?? 'Failed' });
    return false;
  }

  const closeDrawer = () => {
    if (search.edit)
      void navigate({
        search: { q: search.q, page: search.page, size: search.size, edit: undefined },
      });
  };
  const editingRow = search.edit ? (media.find((m) => m.id === search.edit) ?? null) : null;
  const detailFn = useServerFn(getMediaDetail);

  const requestDelete = async (row: MediaRow) => {
    try {
      const detail = await detailFn({ data: { mediaId: row.id } });
      if (!detail || detail.usedCount > 0) {
        setFeedback({
          kind: 'error',
          message: `In use. Remove ${row.filename} from its product or post first.`,
        });
        return;
      }
    } catch {
      setFeedback({ kind: 'error', message: 'Could not check where this image is used.' });
      return;
    }
    askDelete(row);
  };

  const askDelete = (row: MediaRow) => {
    setConfirm({
      title: `Delete ${row.filename}?`,
      body: 'This permanently deletes the image file.',
      confirmLabel: 'Delete image',
      action: async () => {
        if (await run('media.delete', { mediaId: row.id }, `${row.filename} deleted.`)) {
          closeDrawer();
        }
      },
    });
  };

  const mediaColumns: ColumnDef<DataTableFeatures, MediaRow>[] = [
    {
      id: 'file',
      accessorKey: 'filename',
      header: 'File',
      cell: ({ row }) => {
        const m = row.original;
        return (
          <span className="flex items-center gap-3 whitespace-normal">
            {m.deletion_pending || !m.ready ? (
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-sm font-medium text-zinc-500"
                aria-hidden
              >
                {m.filename.slice(0, 1).toUpperCase()}
              </span>
            ) : (
              <img
                src={mediaUrl(mediaSource(m), 320)}
                alt=""
                loading="lazy"
                className="h-10 w-10 shrink-0 rounded-lg object-cover"
              />
            )}
            <span className="min-w-0">
              <span className="block font-medium text-zinc-950">{m.filename}</span>
              <span className="mt-0.5 block text-[13px] text-zinc-500">
                {m.deletion_pending
                  ? 'Deletion pending'
                  : !m.ready
                    ? 'Upload incomplete'
                    : m.alt_text || 'No alt text'}
              </span>
            </span>
          </span>
        );
      },
    },
    {
      id: 'type',
      accessorFn: (row) => row.content_type,
      header: 'Type',
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-zinc-500">{row.original.content_type}</span>
      ),
    },
    {
      id: 'uploaded',
      accessorFn: (row) => row.created_at,
      header: 'Uploaded',
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-zinc-500">
          {formatDate(row.original.created_at)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      enableHiding: false,
      cell: ({ row }) => {
        const m = row.original;
        return (
          <div className="flex justify-end">
            <AdminRowActions label={`Actions for ${m.filename}`}>
              <DropdownMenuItem
                onSelect={() =>
                  void navigate({
                    search: { q: search.q, page: search.page, size: search.size, edit: m.id },
                  })
                }
              >
                Open
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                variant="destructive"
                onSelect={() => void requestDelete(m)}
              >
                {m.deletion_pending ? 'Retry deletion' : 'Delete'}
              </DropdownMenuItem>
            </AdminRowActions>
          </div>
        );
      },
    },
  ];

  const handlePaginationChange: OnChangeFn<PaginationState> = (updater) => {
    const current = { pageIndex: page - 1, pageSize };
    const next = typeof updater === 'function' ? updater(current) : updater;
    void navigate({
      search: {
        q: search.q,
        page: next.pageIndex + 1,
        size: isPageSize(next.pageSize) ? next.pageSize : pageSize,
        edit: undefined,
      },
    });
  };

  return (
    <main>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className={pageTitle}>Media</h1>
          <p className={pageSub}>
            {total} file{total === 1 ? '' : 's'} in your library.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnSmall}
            disabled={publishing}
            onClick={() =>
              setConfirm({
                title: 'Publish existing images?',
                body: 'Existing images will be published to the configured public media storage.',
                confirmLabel: 'Publish images',
                action: async () => {
                  setPublishing(true);
                  try {
                    await publishExisting({ data: {} });
                    setFeedback({
                      kind: 'status',
                      message:
                        'Public media publication queued. Use this action again to resume an unfinished run.',
                    });
                  } catch {
                    setFeedback({
                      kind: 'error',
                      message:
                        'Public media publication could not start. Check configuration and retry.',
                    });
                  } finally {
                    setPublishing(false);
                  }
                },
              })
            }
          >
            {publishing ? 'Queueing publication…' : 'Publish existing media'}
          </button>
          <label className={`${btnPrimary} cursor-pointer`}>
            <PlusIcon className="size-4" />
            {uploading ? 'Uploading…' : 'Upload image'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              aria-label="Upload image"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setUploading(true);
                try {
                  await uploadMedia(file);
                  setFeedback({
                    kind: 'status',
                    message:
                      'Image uploaded. Open it to add alt text, then attach it from a product or post.',
                  });
                  router.invalidate();
                } catch (err) {
                  setFeedback({
                    kind: 'error',
                    message: err instanceof Error ? err.message : 'Upload failed',
                  });
                } finally {
                  setUploading(false);
                }
              }}
            />
          </label>
        </div>
      </div>
      <AdminActionFeedback value={feedback} />

      <div className="mt-6" tabIndex={0} role="region" aria-label="Media">
        <DataTable
          caption="Media"
          columns={mediaColumns}
          data={media}
          pageIndex={page - 1}
          pageSize={pageSize}
          rowCount={total}
          pageSizeOptions={pageSizeOptions}
          onPaginationChange={handlePaginationChange}
          onRowClick={(row) =>
            void navigate({
              search: { q: search.q, page: search.page, size: search.size, edit: row.id },
            })
          }
          tableClassName="min-w-[640px]"
          emptyMessage={search.q ? `No files match "${search.q}".` : 'No media yet.'}
          toolbar={
            <DataTableSearch
              value={search.q ?? ''}
              onSearch={(q) =>
                void navigate({
                  search: { q: q || undefined, page: 1, size: search.size, edit: undefined },
                })
              }
              placeholder="Search Files"
              ariaLabel="Find a file"
            />
          }
        />
      </div>

      {editingRow ? (
        <MediaDrawer
          key={editingRow.id}
          row={editingRow}
          usedCount={usedCount}
          busy={busy}
          onClose={closeDrawer}
          onSaveAlt={async (altText) =>
            run(
              'media.updateAlt',
              { mediaId: editingRow.id, altText },
              `Alt text saved for ${editingRow.filename}.`
            )
          }
          onDelete={askDelete}
        />
      ) : null}
      {search.edit && !editingRow ? (
        <Drawer
          instant
          swipeDirection="right"
          open
          onOpenChange={(next) => {
            if (!next) closeDrawer();
          }}
        >
          <DrawerContent
            className="w-full max-w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0 sm:max-w-2xl"
            initialFocus={false}
          >
            <DrawerClose
              render={
                <button
                  type="button"
                  aria-label="Close"
                  className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-950"
                >
                  <XIcon />
                  <span className="sr-only">Close</span>
                </button>
              }
            />
            <DrawerHeader className="p-5 pr-14 pb-0 sm:p-6 sm:pr-14 sm:pb-0">
              <DrawerTitle>File not found</DrawerTitle>
              <DrawerDescription>This file does not exist.</DrawerDescription>
            </DrawerHeader>
            <div className="px-5 py-5 sm:px-6">
              <Button type="button" onClick={closeDrawer}>
                Back to media
              </Button>
            </div>
          </DrawerContent>
        </Drawer>
      ) : null}
      <ConfirmDialog
        request={
          confirm
            ? { title: confirm.title, body: confirm.body, confirmLabel: confirm.confirmLabel }
            : null
        }
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const current = confirm;
          setConfirm(null);
          if (current) void current.action();
        }}
      />
    </main>
  );
}
