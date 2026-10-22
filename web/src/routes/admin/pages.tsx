import { useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useAdminAction } from '../../components/AdminNav';
import {
  btnGhost,
  btnPrimary,
  cardCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
  textareaCls,
} from '../../components/ui';

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
  const adminAction = useAdminAction();

  const pages = Route.useLoaderData();
  const router = useRouter();
  const [form, setForm] = useState({ id: '', slug: '', title: '', contentHtml: '' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <main>
      <h1 className={pageTitle}>Pages</h1>
      <p className={pageSub}>
        Shipping, returns, privacy, and terms pages linked from your store footer. Click a page to
        edit it.
      </p>

      <section className={`${cardCls} mt-6 divide-y divide-zinc-100 overflow-hidden`}>
        {pages.map((p) => (
          <button
            key={p.id}
            className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-zinc-50"
            onClick={() =>
              setForm({ id: p.id, slug: p.slug, title: p.title, contentHtml: p.content_html })
            }
          >
            <span className="text-sm font-medium text-zinc-950">{p.title}</span>
            <span className="text-[13px] text-zinc-500">/pages/{p.slug}</span>
            <span className="ml-auto text-[13px] font-medium text-zinc-950">Edit</span>
          </button>
        ))}
        {pages.length === 0 ? (
          <p className="p-5 text-sm text-zinc-500" role="status">
            No pages yet.
          </p>
        ) : null}
      </section>

      <section className={`${cardCls} mt-5 space-y-4 p-5 sm:p-6`}>
        <h2 className="text-sm font-medium text-zinc-950">
          {form.id ? `Editing /pages/${form.slug}` : 'New page'}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="pg-slug">
              Slug
            </label>
            <input
              id="pg-slug"
              className={inputCls}
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="pg-title">
              Title
            </label>
            <input
              id="pg-title"
              className={inputCls}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="pg-content">
            Content (HTML)
          </label>
          <textarea
            id="pg-content"
            className={`${textareaCls} leading-6`}
            rows={10}
            value={form.contentHtml}
            onChange={(e) => setForm({ ...form, contentHtml: e.target.value })}
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            className={btnPrimary}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await adminAction('page.save', form);
              setBusy(false);
              if (r.ok) {
                setMsg('Page saved. It is live on the storefront now.');
                router.invalidate();
              } else setMsg(r.error ?? 'Failed');
            }}
          >
            {busy ? 'Saving…' : 'Save page'}
          </button>
          {form.id ? (
            <button
              className={btnGhost}
              onClick={() => setForm({ id: '', slug: '', title: '', contentHtml: '' })}
            >
              Start a new page instead
            </button>
          ) : null}
        </div>
      </section>
      {msg ? (
        <p className="mt-4 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700" role="status">
          {msg}
        </p>
      ) : null}
    </main>
  );
}
