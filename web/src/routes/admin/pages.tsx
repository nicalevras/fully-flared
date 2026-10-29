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
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { formatDate } from '../../lib/format';
import { pageWindow } from '../../lib/catalog-page';
import { AdminPagination } from '../../components/AdminPagination';
import * as z from 'zod';
import { validateServerInput } from '../../server/function-boundary';
import { Button } from '../../components/ui';

type PageRow = { id: string; slug: string; title: string; updated_at: string };

const PAGE_SIZE = 25;

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(z.object({ page: z.number().int().min(1).default(1) })))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM pages').first<{ n: number }>();
    const total = count?.n ?? 0;
    const { page, offset } = pageWindow(total, data.page, PAGE_SIZE);
    const rows = await env.DB.prepare(
      'SELECT id, slug, title, updated_at FROM pages ORDER BY slug LIMIT ? OFFSET ?'
    )
      .bind(PAGE_SIZE, offset)
      .all<PageRow>();
    return { pages: rows.results, total, page, pageSize: PAGE_SIZE };
  });

export const Route = createFileRoute('/admin/pages')({
  staleTime: 30_000,
  // The Tiptap editor renders in the browser only; the loader still runs on the server.
  ssr: 'data-only',
  validateSearch: (search: { edit?: unknown; page?: unknown } & SearchSchemaInput) => ({
    edit: typeof search.edit === 'string' && search.edit ? search.edit : undefined,
    page:
      typeof search.page === 'number' && Number.isInteger(search.page) && search.page > 0
        ? search.page
        : 1,
  }),
  loaderDeps: ({ search }) => ({ page: search.page }),
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
  const openEditor = (id: string) => void navigate({ search: { page: search.page, edit: id } });
  const closeSheet = () => {
    setCreateOpen(false);
    if (search.edit) void navigate({ search: { page: search.page, edit: undefined } });
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
      {pages.length === 0 ? (
        <div className="mt-8 rounded-xl bg-zinc-50 px-6 py-14 text-center" role="status">
          <p className="text-sm text-zinc-500">No pages yet. Write your first one.</p>
          <Button type="button" className="mt-4" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4" />
            New
          </Button>
        </div>
      ) : (
        <div className="mt-8" tabIndex={0} role="region" aria-label="Pages">
          <Table className="min-w-[560px]">
            <TableCaption className="sr-only">Pages</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Title</TableHead>
                <TableHead scope="col">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pages.map((p) => (
                <TableRow key={p.id} className="cursor-pointer" onClick={() => openEditor(p.id)}>
                  <TableCell className="whitespace-normal">
                    <span className="block font-medium text-zinc-950">{p.title}</span>
                    <span className="mt-0.5 block text-[13px] text-zinc-500">/pages/{p.slug}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-zinc-500">
                    {formatDate(p.updated_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <AdminPagination
        label="Pages pagination"
        page={page}
        total={total}
        pageSize={pageSize}
        onPage={(next) => void navigate({ search: { page: next, edit: undefined } })}
      />
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
