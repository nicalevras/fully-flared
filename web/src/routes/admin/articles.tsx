import { useEffect, useState } from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { staffMiddleware } from '../../server/staff-middleware';
import { createFileRoute, useRouter, type SearchSchemaInput } from '@tanstack/react-router';
import { createServerFn, useServerFn } from '@tanstack/react-start';
import { PlusIcon } from 'lucide-react';
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet';
import { formatDate } from '../../lib/format';
import { pageWindow } from '../../lib/catalog-page';
import { AdminPagination } from '../../components/AdminPagination';
import * as z from 'zod';
import { validateServerInput } from '../../server/function-boundary';
import { mediaUrl } from '../../lib/media-url';
import type { PostStatus } from '../../db/schema';
import { Button, inputCls, labelCls } from '../../components/ui';

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

const PAGE_SIZE = 25;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(
    validateServerInput(
      z.object({
        q: z.string().max(200).default(''),
        page: z.number().int().min(1).default(1),
      })
    )
  )
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const q = data.q.trim();
    const where = q ? `WHERE p.title LIKE ? ESCAPE '\\'` : '';
    const binds = q ? [`%${escapeLike(q)}%`] : [];
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts p ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    const total = count?.n ?? 0;
    const { page, offset } = pageWindow(total, data.page, PAGE_SIZE);
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
      .bind(...binds, PAGE_SIZE, offset)
      .all<PostRow>();
    return { posts: rows.results, total, page, pageSize: PAGE_SIZE };
  });

export const Route = createFileRoute('/admin/articles')({
  staleTime: 30_000,
  // The Tiptap editor renders in the browser only; the loader still runs on the server.
  ssr: 'data-only',
  validateSearch: (
    search: { edit?: unknown; q?: unknown; page?: unknown } & SearchSchemaInput
  ) => ({
    edit: typeof search.edit === 'string' && search.edit ? search.edit : undefined,
    q: typeof search.q === 'string' && search.q ? search.q : undefined,
    page:
      typeof search.page === 'number' && Number.isInteger(search.page) && search.page > 0
        ? search.page
        : 1,
  }),
  loaderDeps: ({ search }) => ({ q: search.q ?? '', page: search.page }),
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
  const [query, setQuery] = useState(search.q ?? '');

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);
  const openEditor = (id: string) =>
    void navigate({ search: { q: search.q, page: search.page, edit: id } });
  const closeSheet = () => {
    setCreateOpen(false);
    if (search.edit) void navigate({ search: { q: search.q, page: search.page, edit: undefined } });
  };
  const handleSaved = () => {
    closeSheet();
    router.invalidate();
  };

  return (
    <main>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[28px] leading-tight font-medium tracking-tight text-zinc-950">
            Articles
          </h1>
          <p className="mt-1 text-sm text-zinc-500">Stories, guides, and announcements.</p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <PlusIcon className="size-4" />
          New
        </Button>
      </div>
      <AdminActionFeedback value={feedback} />
      <form
        className="mt-5 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void navigate({
            search: { q: query.trim() || undefined, page: 1, edit: undefined },
          });
        }}
      >
        <div className="min-w-48 flex-1">
          <label className={labelCls} htmlFor="articles-q">
            Find an article
          </label>
          <input
            id="articles-q"
            className={inputCls}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Part of a title"
          />
        </div>
        <Button type="submit">Search</Button>
      </form>
      {posts.length === 0 ? (
        <div className="mt-8 rounded-xl bg-zinc-50 px-6 py-14 text-center" role="status">
          <p className="text-sm text-zinc-500">
            {search.q ? `No articles match "${search.q}".` : 'No posts yet. Write your first one.'}
          </p>
          <Button type="button" className="mt-4" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4" />
            New
          </Button>
        </div>
      ) : (
        <div className="mt-8" tabIndex={0} role="region" aria-label="Articles">
          <Table className="min-w-[720px]">
            <TableCaption className="sr-only">Articles</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Title</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Published</TableHead>
                <TableHead scope="col">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {posts.map((p) => {
                const variants = coverVariants(p);
                return (
                  <TableRow key={p.id} className="cursor-pointer" onClick={() => openEditor(p.id)}>
                    <TableCell className="whitespace-normal">
                      <span className="flex items-center gap-3">
                        {p.cover_key ? (
                          <img
                            src={mediaUrl(
                              { key: p.cover_key, publicUrl: p.cover_public_url, variants },
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
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={p.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-zinc-500">
                      {p.published_at ? formatDate(p.published_at) : 'Not published yet'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-zinc-500">
                      {formatDate(p.updated_at)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <AdminPagination
        label="Articles pagination"
        page={page}
        total={total}
        pageSize={pageSize}
        onPage={(next) => void navigate({ search: { q: search.q, page: next, edit: undefined } })}
      />
      {createOpen || search.edit === 'new' ? (
        <BlogPostEditor
          key="new"
          post={null}
          onClose={closeSheet}
          onFeedback={setFeedback}
          onSaved={handleSaved}
        />
      ) : null}
      {editingId && detail && detailFor === editingId ? (
        <BlogPostEditor
          key={detail.id}
          post={detail}
          onClose={closeSheet}
          onFeedback={setFeedback}
          onSaved={handleSaved}
        />
      ) : null}
      {editingId && detailFor === editingId && !detail ? (
        <Sheet
          open
          onOpenChange={(next) => {
            if (!next) closeSheet();
          }}
        >
          <SheetContent
            className="w-full gap-0 overflow-hidden p-0 sm:max-w-4xl"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <SheetHeader className="p-5 pr-14 pb-0 sm:p-6 sm:pr-14 sm:pb-0">
              <SheetTitle>Post not found</SheetTitle>
              <SheetDescription>This post does not exist.</SheetDescription>
            </SheetHeader>
            <div className="px-5 py-5 sm:px-6">
              <Button type="button" onClick={closeSheet}>
                Back to posts
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </main>
  );
}
