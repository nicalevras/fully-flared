import { useState } from 'react';
import { staffMiddleware } from '../../../server/staff-middleware';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../../../server/function-boundary';
import { idString } from '../../../schemas/common';
import { useAdminAction } from '../../../components/AdminNav';
import { useDraftRecovery } from '../../../lib/use-draft-recovery';
import { btnPrimary as primaryBtn } from '../../../components/ui';
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

type PageRow = {
  id: string;
  slug: string;
  title: string;
  content_html: string;
  updated_at: string;
};

const getPage = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(idString))
  .handler(
    async ({ data: pageId, context }): Promise<{ page: PageRow | null; staffId: string }> => {
      if (pageId === 'new') return { page: null, staffId: context.staff.id };
      const { env } = await import('cloudflare:workers');
      const row = await env.DB.prepare(
        'SELECT id, slug, title, content_html, updated_at FROM pages WHERE id = ?'
      )
        .bind(pageId)
        .first<PageRow>();
      return { page: row ?? null, staffId: context.staff.id };
    }
  );

export const Route = createFileRoute('/admin/pages_/$id')({
  loader: async ({ params }) => getPage({ data: params.id }),
  component: PageEditor,
});

function PageEditor() {
  const { page, staffId } = Route.useLoaderData();
  return <EditorForm key={page?.id ?? 'new'} page={page} staffId={staffId} />;
}

function EditorForm({ page, staffId }: { page: PageRow | null; staffId: string }) {
  const adminAction = useAdminAction();
  const router = useRouter();
  const [form, setForm] = useState({
    id: page?.id ?? '',
    slug: page?.slug ?? '',
    title: page?.title ?? '',
    contentHtml: page?.content_html ?? '',
    updatedAt: page?.updated_at ?? '',
  });
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [busy, setBusy] = useState(false);
  const draft = useDraftRecovery({
    staffId,
    entityType: 'page',
    entityId: page?.id ?? 'new',
    baseUpdatedAt: page?.updated_at ?? null,
    serverFields: {
      slug: page?.slug ?? '',
      title: page?.title ?? '',
      contentHtml: page?.content_html ?? '',
    },
    currentFields: { slug: form.slug, title: form.title, contentHtml: form.contentHtml },
  });

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
      {draft.recovery ? (
        <section className={`${cardCls} mt-4 p-4`} aria-label="Recovered draft">
          <p className="text-sm text-zinc-600">
            You have unsaved work for this page, saved on this device{' '}
            {new Date(draft.recovery.draft.savedAt).toLocaleString()}.
            {draft.recovery.stale
              ? ' The page changed on the server after that. The server version stays authoritative until you save over it.'
              : ''}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={primaryBtn}
              onClick={() => {
                const fields = draft.recovery?.draft.fields;
                if (!fields) return;
                setForm((current) => ({ ...current, ...fields }));
                draft.markRecovered();
              }}
            >
              Recover this work
            </button>
            <button type="button" className={btnSecondary} onClick={draft.discardRecovery}>
              Discard it
            </button>
          </div>
        </section>
      ) : draft.savedAt ? (
        <p className="mt-3 text-[13px] text-zinc-500" role="status">
          Draft saved on this device {new Date(draft.savedAt).toLocaleTimeString()}. It is only on
          this device and is removed when you save.
        </p>
      ) : null}
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
              const r = await adminAction('page.save', {
                ...form,
                ...(form.updatedAt ? { expectedUpdatedAt: form.updatedAt } : {}),
              });
              setBusy(false);
              if (r.ok) {
                draft.clearDraft();
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
