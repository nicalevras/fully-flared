import { useEffect, useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { createFileRoute, useRouter, type SearchSchemaInput } from '@tanstack/react-router';
import { createServerFn, useServerFn } from '@tanstack/react-start';
import { PlusIcon, XIcon } from 'lucide-react';
import { StatusBadge } from '../../components/StatusBadge';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../components/AdminActionFeedback';
import {
  BlogPostEditor,
  getPostDetail,
  type BlogPostDetail,
} from '../../components/BlogPostEditor';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '../../components/ui/drawer';
import { formatDate } from '../../lib/format';
import { pageWindow } from '../../lib/catalog-page';
import type { ColumnDef, OnChangeFn, PaginationState } from '@tanstack/react-table';
import { DataTable, DataTableSearch } from '../../components/ui/data-table';
import { ftsPhrase, ftsUsable } from '../../lib/fts-search';
import type { DataTableFeatures } from '../../components/data-table-features';
import { isPageSize, pageSizeOptions } from '../../lib/search-params';
import { pageSizeSchema } from '../../schemas/pagination';
import * as z from 'zod';
import { validateServerInput } from '../../server/function-boundary';
import { mediaUrl } from '../../lib/media-url';
import type { PostStatus } from '../../db/schema';
import { Button, pageSub, pageTitle } from '../../components/ui';
import { Button as TableButton } from '@/components/ui/button';

type PostRow = {
  id: string;
  slug: string;
  title: string;
  status: PostStatus;
  excerpt: string;
  published_at: string | null;
  updated_at: string;
  cover_media_id: string | null;
  cover_key: string | null;
  cover_public_url: string | null;
  cover_variants_json: string | null;
};

const articlesColumns: ColumnDef<DataTableFeatures, PostRow>[] = [
  {
    id: 'title',
    accessorKey: 'title',
    header: 'Title',
    cell: ({ row }) => {
      const p = row.original;
      return (
        <span className="flex items-center gap-3 whitespace-normal">
          {p.cover_key ? (
            <img
              src={mediaUrl(
                { key: p.cover_key, publicUrl: p.cover_public_url, variants: coverVariants(p) },
                320
              )}
              alt=""
              loading="lazy"
              className="h-10 w-10 shrink-0 rounded-lg object-cover"
            />
          ) : (
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-sm font-medium text-zinc-500"
              aria-hidden
            >
              {p.title.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="min-w-0">
            <span className="block font-medium text-zinc-950">{p.title}</span>
            {p.excerpt ? (
              <span className="mt-0.5 block max-w-md truncate text-[13px] text-zinc-500">
                {p.excerpt}
              </span>
            ) : null}
          </span>
        </span>
      );
    },
  },
  {
    id: 'published',
    accessorFn: (row) => row.published_at,
    header: 'Published',
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-zinc-500">
        {row.original.published_at ? formatDate(row.original.published_at) : 'Not published yet'}
      </span>
    ),
  },
  {
    id: 'updated',
    accessorFn: (row) => row.updated_at,
    header: 'Updated',
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-zinc-500">{formatDate(row.original.updated_at)}</span>
    ),
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge value={row.original.status} />,
  },
];

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
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const q = data.q.trim();
    // < 3 chars cannot hit the trigram index; return nothing rather than scan.
    const where = q
      ? ftsUsable(q)
        ? 'WHERE p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)'
        : 'WHERE 1=0'
      : '';
    const binds = q && ftsUsable(q) ? [ftsPhrase(q)] : [];
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts p ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    const total = count?.n ?? 0;
    const { page, offset } = pageWindow(total, data.page, data.size);
    const rows = await env.DB.prepare(
      `SELECT p.id, p.slug, p.title, p.status, p.excerpt, p.published_at, p.updated_at, p.cover_media_id,
              m.r2_key AS cover_key, m.public_url AS cover_public_url,
              (SELECT json_group_array(json_object('width', width, 'url', COALESCE(public_url, '')))
               FROM (SELECT width, public_url FROM media_variants
                     WHERE media_id = m.id AND ready = 1 ORDER BY width)) AS cover_variants_json
       FROM posts p
       LEFT JOIN media m ON m.id = p.cover_media_id AND m.ready = 1 AND m.deletion_pending = 0
       ${where}
       ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...binds, data.size, offset)
      .all<PostRow>();
    return { posts: rows.results, total, page, pageSize: data.size };
  });

export const Route = createFileRoute('/admin/articles')({
  staleTime: 30_000,
  // The Tiptap editor renders in the browser only; the loader still runs on the server.
  ssr: 'data-only',
  validateSearch: (
    search: { edit?: unknown; q?: unknown; page?: unknown; size?: unknown } & SearchSchemaInput
  ) => ({
    edit: typeof search.edit === 'string' && search.edit ? search.edit : undefined,
    q: typeof search.q === 'string' && search.q ? search.q : undefined,
    page:
      typeof search.page === 'number' && Number.isInteger(search.page) && search.page > 0
        ? search.page
        : 1,
    size: isPageSize(search.size) ? search.size : undefined,
  }),
  loaderDeps: ({ search }) => ({ q: search.q ?? '', page: search.page, size: search.size ?? 25 }),
  loader: async ({ deps }) => getData({ data: deps }),
  component: AdminBlog,
});

function coverVariants(row: PostRow): Array<{ width: number; url: string }> | undefined {
  if (!row.cover_variants_json) return undefined;
  try {
    const parsed = JSON.parse(row.cover_variants_json) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    // Same fill the catalog publisher applies: variants stored without a
    // public URL are served through the media route at that width.
    return (parsed as Array<{ width: number; url: string }>).map((variant) => ({
      ...variant,
      url: variant.url || `/media/${encodeURIComponent(row.cover_key ?? '')}?w=${variant.width}`,
    }));
  } catch {
    return undefined;
  }
}

function AdminBlog() {
  const { posts, total, page, pageSize } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const editingId = search.edit && search.edit !== 'new' ? search.edit : null;
  const detailFn = useServerFn(getPostDetail);
  const [detail, setDetail] = useState<BlogPostDetail | null>(null);
  const [detailFor, setDetailFor] = useState('');
  useEffect(() => {
    if (!editingId) {
      setDetail(null);
      setDetailFor('');
      return;
    }
    let cancelled = false;
    setDetailFor('');
    detailFn({ data: editingId })
      .then((row) => {
        if (!cancelled) {
          setDetail(row);
          setDetailFor(editingId);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetail(null);
          setDetailFor(editingId);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [editingId]);
  const openEditor = (id: string) =>
    void navigate({ search: { q: search.q, page: search.page, size: search.size, edit: id } });
  const closeDrawer = () => {
    setCreateOpen(false);
    if (search.edit)
      void navigate({
        search: { q: search.q, page: search.page, size: search.size, edit: undefined },
      });
  };
  const handleSaved = () => {
    closeDrawer();
    router.invalidate();
  };
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
          <h1 className={pageTitle}>Articles</h1>
          <p className={pageSub}>Stories, guides, and announcements.</p>
        </div>
      </div>
      <AdminActionFeedback value={feedback} />
      <div className="mt-6" tabIndex={0} role="region" aria-label="Articles">
        <DataTable
          caption="Articles"
          columns={articlesColumns}
          data={posts}
          pageIndex={page - 1}
          pageSize={pageSize}
          rowCount={total}
          pageSizeOptions={pageSizeOptions}
          onPaginationChange={handlePaginationChange}
          onRowClick={(row) => openEditor(row.id)}
          tableClassName="min-w-[720px]"
          emptyMessage={search.q ? `No articles match "${search.q}".` : 'No posts yet.'}
          toolbar={
            <DataTableSearch
              value={search.q ?? ''}
              onSearch={(q) =>
                void navigate({
                  search: { q: q || undefined, page: 1, size: search.size, edit: undefined },
                })
              }
              placeholder="Search Articles"
              ariaLabel="Find an article"
            />
          }
          toolbarEnd={
            <TableButton
              type="button"
              size="sm"
              onClick={() => setCreateOpen(true)}
              className="h-8 rounded-md bg-zinc-950 text-white shadow-none hover:bg-zinc-800"
            >
              <PlusIcon /> New
            </TableButton>
          }
        />
      </div>

      {createOpen || search.edit === 'new' ? (
        <BlogPostEditor
          key="new"
          post={null}
          onClose={closeDrawer}
          onFeedback={setFeedback}
          onSaved={handleSaved}
        />
      ) : null}
      {editingId && detail && detailFor === editingId ? (
        <BlogPostEditor
          key={detail.id}
          post={detail}
          onClose={closeDrawer}
          onFeedback={setFeedback}
          onSaved={handleSaved}
        />
      ) : null}
      {editingId && detailFor === editingId && !detail ? (
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
              <DrawerTitle>Post not found</DrawerTitle>
              <DrawerDescription>This post does not exist.</DrawerDescription>
            </DrawerHeader>
            <div className="px-5 py-5 sm:px-6">
              <Button type="button" onClick={closeDrawer}>
                Back to posts
              </Button>
            </div>
          </DrawerContent>
        </Drawer>
      ) : null}
    </main>
  );
}
