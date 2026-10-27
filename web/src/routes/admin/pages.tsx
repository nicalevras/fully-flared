import { staffMiddleware } from '../../server/staff-middleware';
import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { btnPrimary, cardCls, pageSub, pageTitle } from '../../components/ui';

type PageRow = { id: string; slug: string; title: string; content_html: string };

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .handler(async () => {
    const { env } = await import('cloudflare:workers');
    const rows = await env.DB.prepare(
      'SELECT id, slug, title, content_html FROM pages ORDER BY slug'
    ).all<PageRow>();
    return rows.results;
  });

export const Route = createFileRoute('/admin/pages')({
  loader: async () => getData(),
  component: Page,
});

function Page() {
  const pages = Route.useLoaderData();
  return (
    <main>
      <h1 className={pageTitle}>Pages</h1>
      <p className={pageSub}>
        Shipping, returns, privacy, and terms pages linked from your store footer. Open a page to
        edit it in its own workspace.
      </p>
      <div className="mt-5">
        <Link to="/admin/pages/$id" params={{ id: 'new' }} className={btnPrimary}>
          New page
        </Link>
      </div>
      <section className={`${cardCls} mt-5 divide-y divide-zinc-100 overflow-hidden`}>
        {pages.map((p) => (
          <Link
            key={p.id}
            to="/admin/pages/$id"
            params={{ id: p.id }}
            className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-zinc-50"
          >
            <span className="text-sm font-medium text-zinc-950">{p.title}</span>
            <span className="text-[13px] text-zinc-500">/pages/{p.slug}</span>
            <span className="ml-auto text-[13px] font-medium text-zinc-950">Edit</span>
          </Link>
        ))}
        {pages.length === 0 ? (
          <p className="p-5 text-sm text-zinc-500" role="status">
            No pages yet.
          </p>
        ) : null}
      </section>
    </main>
  );
}
