import { useState } from 'react';
import { staffMiddleware } from '../../../server/staff-middleware';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../../../server/function-boundary';
import { idString } from '../../../schemas/common';
import { BlogEditor } from '../../../components/BlogEditor';
import { useAdminAction } from '../../../components/AdminNav';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../../components/AdminActionFeedback';
import { slugify, utcToLocalDateTimeInput, type LoadedSchedule } from '../../../lib/format';
import { saveBlogPost } from '../../../lib/blog-save';
import { useDraftRecovery } from '../../../lib/use-draft-recovery';
import { uploadMedia } from '../../../lib/upload';
import {
  btnGhost,
  btnPrimary,
  btnSecondary,
  cardCls,
  hintCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
  textareaCls,
} from '../../../components/ui';

type PostRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  excerpt: string;
  content_html: string;
  seo_title: string | null;
  seo_description: string | null;
  published_at: string | null;
  cover_media_id: string | null;
  tags: string;
  updated_at: string;
};

const getPost = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(idString))
  .handler(
    async ({ data: postId, context }): Promise<{ post: PostRow | null; staffId: string }> => {
      if (postId === 'new') return { post: null, staffId: context.staff.id };
      const { env } = await import('cloudflare:workers');
      const row = await env.DB.prepare(
        `SELECT p.id, p.slug, p.title, p.status, p.excerpt, p.content_html,
              p.seo_title, p.seo_description, p.published_at, p.cover_media_id, p.updated_at,
              COALESCE(GROUP_CONCAT(t.name, ', '), '') AS tags
       FROM posts p
       LEFT JOIN post_tags pt ON pt.post_id = p.id
       LEFT JOIN tags t ON t.id = pt.tag_id
       WHERE p.id = ?
       GROUP BY p.id`
      )
        .bind(postId)
        .first<PostRow>();
      return { post: row ?? null, staffId: context.staff.id };
    }
  );

export const Route = createFileRoute('/admin/blog_/$id')({
  ssr: 'data-only',
  loader: async ({ params }) => getPost({ data: params.id }),
  component: BlogPostEditor,
});

const EMPTY = {
  id: '',
  slug: '',
  title: '',
  status: 'draft',
  excerpt: '',
  contentHtml: '',
  seoTitle: '',
  seoDescription: '',
  tags: '',
  coverMediaId: '',
  publishedAt: '',
};

function BlogPostEditor() {
  const { post, staffId } = Route.useLoaderData();
  return <EditorForm key={post?.id ?? 'new'} post={post} staffId={staffId} />;
}

function EditorForm({ post, staffId }: { post: PostRow | null; staffId: string }) {
  const adminAction = useAdminAction();
  const router = useRouter();
  const [form, setForm] = useState(() =>
    post
      ? {
          id: post.id,
          slug: post.slug,
          title: post.title,
          status: post.status,
          excerpt: post.excerpt,
          contentHtml: post.content_html,
          seoTitle: post.seo_title ?? '',
          seoDescription: post.seo_description ?? '',
          tags: post.tags,
          coverMediaId: post.cover_media_id ?? '',
          publishedAt: post.published_at ? utcToLocalDateTimeInput(post.published_at) : '',
        }
      : EMPTY
  );
  const [loadedSchedule] = useState<LoadedSchedule | null>(() =>
    post?.published_at
      ? { localValue: utcToLocalDateTimeInput(post.published_at), iso: post.published_at }
      : null
  );
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [contentHtml, setContentHtml] = useState(form.contentHtml);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const serverFields = {
    title: post?.title ?? '',
    slug: post?.slug ?? '',
    status: post?.status ?? 'draft',
    excerpt: post?.excerpt ?? '',
    contentHtml: post?.content_html ?? '',
    seoTitle: post?.seo_title ?? '',
    seoDescription: post?.seo_description ?? '',
    tags: post?.tags ?? '',
    coverMediaId: post?.cover_media_id ?? '',
    publishedAt: post?.published_at ? utcToLocalDateTimeInput(post.published_at) : '',
  };
  const draft = useDraftRecovery({
    staffId,
    entityType: 'post',
    entityId: post?.id ?? 'new',
    baseUpdatedAt: post?.updated_at ?? null,
    serverFields,
    currentFields: { ...form, contentHtml },
  });

  return (
    <main>
      <Link to="/admin/blog" className="text-[13px] font-medium text-zinc-500 hover:text-zinc-950">
        Blog
      </Link>
      <h1 className={`${pageTitle} mt-2`}>{post ? `Edit ${post.title}` : 'Write a post'}</h1>
      <p className={pageSub}>
        Published posts get SEO meta, structured data, and a sitemap entry automatically. Saving a
        published post makes the change live. A draft stays off the storefront.
      </p>
      <AdminActionFeedback value={feedback} />
      {draft.recovery ? (
        <section className={`${cardCls} mt-4 p-4`} aria-label="Recovered draft">
          <p className="text-sm text-zinc-600">
            You have unsaved work for this post, saved on this device{' '}
            {new Date(draft.recovery.draft.savedAt).toLocaleString()}.
            {draft.recovery.stale
              ? ' The post changed on the server after that. The server version stays authoritative until you save over it.'
              : ''}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={btnPrimary}
              onClick={() => {
                const fields = draft.recovery?.draft.fields;
                if (!fields) return;
                setForm((current) => ({ ...current, ...fields, contentHtml: current.contentHtml }));
                setContentHtml(fields.contentHtml ?? '');
                setEditorEpoch((epoch) => epoch + 1);
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
      <section className="mt-6 space-y-4">
        <div className={`${cardCls} grid gap-4 p-5 sm:p-6 lg:grid-cols-3`}>
          <div>
            <label className={labelCls} htmlFor="b-title">
              Title
            </label>
            <input
              id="b-title"
              placeholder="Post title"
              className={inputCls}
              value={form.title}
              onChange={(e) =>
                setForm({
                  ...form,
                  title: e.target.value,
                  slug: form.id ? form.slug : form.slug || slugify(e.target.value),
                })
              }
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="b-slug">
              Slug
            </label>
            <input
              id="b-slug"
              placeholder="post-slug"
              className={inputCls}
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="b-status">
              Status
            </label>
            <select
              id="b-status"
              className={inputCls}
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="scheduled">Scheduled</option>
            </select>
          </div>
          {form.status === 'scheduled' ? (
            <div>
              <label className={labelCls} htmlFor="b-when">
                Publish at
              </label>
              <input
                id="b-when"
                type="datetime-local"
                className={inputCls}
                value={form.publishedAt}
                onChange={(e) => setForm({ ...form, publishedAt: e.target.value })}
              />
            </div>
          ) : null}
          <div>
            <label className={labelCls} htmlFor="b-tags">
              Tags
            </label>
            <input
              id="b-tags"
              className={inputCls}
              placeholder="care, cotton, news"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
            />
            <p className={hintCls}>Comma-separated. Shown on the article and used for browsing.</p>
          </div>
          <div>
            <label className={labelCls} htmlFor="b-cover">
              Cover image
            </label>
            <input
              id="b-cover"
              className={inputCls}
              placeholder="Upload below, then it fills in"
              value={form.coverMediaId}
              onChange={(e) => setForm({ ...form, coverMediaId: e.target.value })}
            />
            <label className="mt-2 inline-flex cursor-pointer items-center text-[13px] font-medium text-zinc-950 underline underline-offset-2">
              Upload a cover image
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="sr-only"
                aria-label="Upload cover image"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  try {
                    const d = await uploadMedia(file);
                    setForm((f) => ({ ...f, coverMediaId: d.id }));
                  } catch (err) {
                    setFeedback({
                      kind: 'error',
                      message: err instanceof Error ? err.message : 'Cover upload failed',
                    });
                  }
                }}
              />
            </label>
          </div>
          <div className="lg:col-span-3">
            <label className={labelCls} htmlFor="b-excerpt">
              Excerpt
            </label>
            <textarea
              id="b-excerpt"
              className={textareaCls}
              rows={2}
              placeholder="One or two sentences shown in listings and search results."
              value={form.excerpt}
              onChange={(e) => setForm({ ...form, excerpt: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="b-seo-title">
              SEO title
            </label>
            <input
              id="b-seo-title"
              className={inputCls}
              placeholder="Optional"
              value={form.seoTitle}
              onChange={(e) => setForm({ ...form, seoTitle: e.target.value })}
            />
          </div>
          <div className="lg:col-span-2">
            <label className={labelCls} htmlFor="b-seo-desc">
              SEO description
            </label>
            <input
              id="b-seo-desc"
              className={inputCls}
              placeholder="Optional, defaults to the excerpt"
              value={form.seoDescription}
              onChange={(e) => setForm({ ...form, seoDescription: e.target.value })}
            />
          </div>
          <p className={`${hintCls} lg:col-span-3`}>
            Use Insert image in the editor toolbar to upload and embed images in the article.
          </p>
        </div>
        <BlogEditor
          key={`${form.id || 'new'}-${editorEpoch}`}
          initialHtml={contentHtml}
          showSave
          onChange={(html) => setContentHtml(html)}
          onSave={async (html, json) => {
            const result = await saveBlogPost(
              adminAction,
              { ...form, contentHtml: html, contentJson: json },
              loadedSchedule
            );
            if (result.ok) {
              draft.clearDraft();
              setFeedback({
                kind: 'status',
                message:
                  form.status === 'published'
                    ? 'Post saved and published. It is live on the storefront.'
                    : form.status === 'scheduled'
                      ? 'Post saved and scheduled.'
                      : 'Post saved as a draft. It is not on the storefront.',
              });
              router.invalidate();
            } else setFeedback({ kind: 'error', message: result.error });
          }}
        />
        <div className="flex gap-2">
          <Link to="/admin/blog" className={btnSecondary}>
            Back to posts
          </Link>
          {post && post.status === 'published' ? (
            <Link to="/blog/$slug" params={{ slug: post.slug }} className={btnGhost}>
              View on storefront
            </Link>
          ) : null}
        </div>
      </section>
    </main>
  );
}
