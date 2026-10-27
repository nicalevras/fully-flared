import { useState } from 'react';
import { staffMiddleware } from '../../../server/staff-middleware';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../../../server/function-boundary';
import { idString } from '../../../schemas/common';
import { useAdminAction } from '../../../components/AdminNav';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../../components/AdminActionFeedback';
import {
  btnGhost,
  btnPrimary,
  btnSecondary,
  cardCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
  textareaCls,
} from '../../../components/ui';

type PageRow = { id: string; slug: string; title: string; content_html: string };

const getPage = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(idString))
  .handler(async ({ data: pageId }): Promise<PageRow | null> => {
    if (pageId === 'new') return null;
    const { env } = await import('cloudflare:workers');
    const row = await env.DB.prepare('SELECT id, slug, title, content_html FROM pages WHERE id = ?')
      .bind(pageId)
      .first<PageRow>();
    return row ?? null;
  });

export const Route = createFileRoute('/admin/pages_/$id')({
  loader: async ({ params }) => getPage({ data: params.id }),
  component: PageEditor,
});

function PageEditor() {
  const page = Route.useLoaderData();
  return <EditorForm key={page?.id ?? 'new'} page={page} />;
}

function EditorForm({ page }: { page: PageRow | null }) {
  const adminAction = useAdminAction();
  const router = useRouter();
  const [form, setForm] = useState({
    id: page?.id ?? '',
    slug: page?.slug ?? '',
    title: page?.title ?? '',
    contentHtml: page?.content_html ?? '',
  });
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [busy, setBusy] = useState(false);

  return (
    <main>
      <Link to="/admin/pages" className="text-[13px] font-medium text-zinc-500 hover:text-zinc-950">
        Pages
      </Link>
      <h1 className={`${pageTitle} mt-2`}>{page ? `Edit /pages/${page.slug}` : 'New page'}</h1>
      <p className={pageSub}>
        Saving a page makes it live on the storefront now. Page content is edited as HTML because
        storefront pages use markup the rich text editor would rewrite. The server sanitizes the
        saved HTML before it can render.
      </p>
      <AdminActionFeedback value={feedback} />
      <section className={`${cardCls} mt-5 space-y-4 p-5 sm:p-6`}>
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
            rows={14}
            value={form.contentHtml}
            onChange={(e) => setForm({ ...form, contentHtml: e.target.value })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={btnPrimary}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await adminAction('page.save', form);
              setBusy(false);
              if (r.ok) {
                setFeedback({
                  kind: 'status',
                  message: 'Page saved. It is live on the storefront now.',
                });
                router.invalidate();
              } else setFeedback({ kind: 'error', message: r.error ?? 'Failed' });
            }}
          >
            {busy ? 'Saving...' : 'Save page'}
          </button>
          <Link to="/admin/pages" className={btnSecondary}>
            Back to pages
          </Link>
          {!page ? (
            <span className={btnGhost} aria-hidden>
              New page
            </span>
          ) : null}
        </div>
      </section>
    </main>
  );
}
