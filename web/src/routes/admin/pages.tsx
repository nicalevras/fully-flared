import { useEffect, useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { createFileRoute, useRouter, type SearchSchemaInput } from '@tanstack/react-router';
import { createServerFn, useServerFn } from '@tanstack/react-start';
import { PlusIcon } from 'lucide-react';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../components/AdminActionFeedback';
import { PageEditor, getPageDetail, type PageDetail } from '../../components/PageEditor';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet';
import type { ColumnDef, OnChangeFn, PaginationState } from '@tanstack/react-table';
import { DataTable, DataTableSearch } from '../../components/ui/data-table';
import { ftsPhrase, ftsUsable } from '../../lib/fts-search';
import type { DataTableFeatures } from '../../components/data-table-features';
import { formatDate } from '../../lib/format';
import { pageWindow } from '../../lib/catalog-page';
import { isPageSize, pageSizeOptions, pageSizeSchema } from '../../schemas/pagination';
import * as z from 'zod';
import { validateServerInput } from '../../server/function-boundary';
import { Button } from '../../components/ui';

type PageRow = { id: string; slug: string; title: string; updated_at: string };

const pagesColumns: ColumnDef<DataTableFeatures, PageRow>[] = [
  {
    id: 'title',
    accessorKey: 'title',
    header: 'Title',
    cell: ({ row }) => (
      <span className="block whitespace-normal">
        <span className="block font-medium text-zinc-950">{row.original.title}</span>
        <span className="mt-0.5 block text-[13px] text-zinc-500">/pages/{row.original.slug}</span>
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
        ? 'WHERE rowid IN (SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?)'
        : 'WHERE 1=0'
      : '';
    const binds = q && ftsUsable(q) ? [ftsPhrase(q)] : [];
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pages ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    const total = count?.n ?? 0;
    const { page, offset } = pageWindow(total, data.page, data.size);
    const rows = await env.DB.prepare(
      `SELECT id, slug, title, updated_at FROM pages ${where} ORDER BY slug LIMIT ? OFFSET ?`
    )
      .bind(...binds, data.size, offset)
      .all<PageRow>();
    return { pages: rows.results, total, page, pageSize: data.size };
  });

export const Route = createFileRoute('/admin/pages')({
  staleTime: 30_000,
  // The Tiptap editor renders in the browser only; the loader still runs on the server.
  ssr: 'data-only',
  validateSearch: (
    search: { edit?: unknown; q?: unknown; page?: unknown; size?: unknown } & SearchSchemaInput
  ) => ({
    edit: typeof search.edit === 'string' && search.edit ? search.edit : undefined,
    q: typeof search.q === 'string' && search.q ? search.q.slice(0, 200) : undefined,
    page:
      typeof search.page === 'number' && Number.isInteger(search.page) && search.page > 0
        ? search.page
        : 1,
    size: isPageSize(search.size) ? search.size : undefined,
  }),
  loaderDeps: ({ search }) => ({ q: search.q ?? '', page: search.page, size: search.size ?? 25 }),
  loader: async ({ deps }) => getData({ data: deps }),
  component: AdminPages,
});

function AdminPages() {
  const { pages, total, page, pageSize } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const editingId = search.edit && search.edit !== 'new' ? search.edit : null;
  const detailFn = useServerFn(getPageDetail);
  const [detail, setDetail] = useState<PageDetail | null>(null);
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
    void navigate({ search: { q: search.q, page: search.page, size: search.size, edit: id } });
  const closeSheet = () => {
    setCreateOpen(false);
    if (search.edit)
      void navigate({
        search: { q: search.q, page: search.page, size: search.size, edit: undefined },
      });
  };
  const handleSaved = () => {
    closeSheet();
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
          <h1 className="text-[28px] leading-tight font-medium tracking-tight text-zinc-950">
            Pages
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Shipping, returns, privacy, and terms pages linked from your store footer.
          </p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <PlusIcon className="size-4" />
          New
        </Button>
      </div>
      <AdminActionFeedback value={feedback} />
      {pages.length === 0 && !search.q ? (
        <div className="mt-8 rounded-xl bg-zinc-50 px-6 py-14 text-center" role="status">
          <p className="text-sm text-zinc-500">
            {search.q ? `No pages match "${search.q}".` : 'No pages yet. Write your first one.'}
          </p>
          <Button type="button" className="mt-4" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4" />
            New
          </Button>
        </div>
      ) : (
        <div className="mt-8" tabIndex={0} role="region" aria-label="Pages">
          <DataTable
            caption="Pages"
            columns={pagesColumns}
            data={pages}
            pageIndex={page - 1}
            pageSize={pageSize}
            rowCount={total}
            pageSizeOptions={pageSizeOptions}
            onPaginationChange={handlePaginationChange}
            onRowClick={(row) => openEditor(row.id)}
            emptyMessage={search.q ? `No pages match "${search.q}".` : 'No pages yet.'}
            toolbar={
              <DataTableSearch
                minCharsHint
                value={search.q ?? ''}
                onSearch={(q) =>
                  void navigate({
                    search: { q: q || undefined, page: 1, size: search.size, edit: undefined },
                  })
                }
                placeholder="Filter by title…"
                ariaLabel="Find a page"
              />
            }
          />
        </div>
      )}
      {createOpen || search.edit === 'new' ? (
        <PageEditor
          key="new"
          page={null}
          onClose={closeSheet}
          onFeedback={setFeedback}
          onSaved={handleSaved}
        />
      ) : null}
      {editingId && detail && detailFor === editingId ? (
        <PageEditor
          key={detail.id}
          page={detail}
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
              <SheetTitle>Page not found</SheetTitle>
              <SheetDescription>This page does not exist.</SheetDescription>
            </SheetHeader>
            <div className="px-5 py-5 sm:px-6">
              <Button type="button" onClick={closeSheet}>
                Back to pages
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </main>
  );
}
