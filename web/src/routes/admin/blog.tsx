import { useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { BlogEditor } from '../../components/BlogEditor';
import { useAdminAction } from '../../components/AdminNav';
import { StatusBadge } from '../../components/StatusBadge';
import {
  formatDate,
  slugify,
  utcToLocalDateTimeInput,
  type LoadedSchedule,
} from '../../lib/format';
import { saveBlogPost } from '../../lib/blog-save';
import type { PostStatus } from '../../db/schema';
import { uploadMedia } from '../../lib/upload';
import {
  btnGhost,
  cardCls,
  hintCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
  tableCls,
  tableWrap,
  textareaCls,
} from '../../components/ui';

type PostRow = {
  id: string;
  slug: string;
  title: string;
  status: PostStatus;
  excerpt: string;
  content_html: string;
  content_json: string | null;
  seo_title: string | null;
  seo_description: string | null;
  published_at: string | null;
  cover_media_id: string | null;
  tags: string;
  author_name: string | null;
};

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .handler(async () => {
    const { env } = await import('cloudflare:workers');
    const [rows, count] = await Promise.all([
      env.DB.prepare(
        `SELECT p.id, p.slug, p.title, p.status, p.excerpt, p.content_html, p.content_json,
              p.seo_title, p.seo_description, p.published_at, p.cover_media_id,
              COALESCE(GROUP_CONCAT(t.name, ', '), '') AS tags, u.name AS author_name
       FROM posts p
       LEFT JOIN post_tags pt ON pt.post_id = p.id
       LEFT JOIN tags t ON t.id = pt.tag_id
       LEFT JOIN user u ON u.id = p.author_id
       GROUP BY p.id
       ORDER BY p.created_at DESC LIMIT 100`
      ).all<PostRow>(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM posts').first<{ n: number }>(),
    ]);
    return { posts: rows.results, total: count?.n ?? rows.results.length };
  });

export const Route = createFileRoute('/admin/blog')({
  loader: async () => getData(),
  component: AdminBlog,
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

function AdminBlog() {
  const adminAction = useAdminAction();

  const { posts, total } = Route.useLoaderData();
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [loadedSchedule, setLoadedSchedule] = useState<LoadedSchedule | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [msg, setMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  return (
    <main>
      <h1 className={pageTitle}>Blog</h1>
      <p className={pageSub}>
        Publish stories, guides, and announcements. Published posts get SEO meta, structured data,
        and a sitemap entry automatically.
        {total > posts.length ? ` Showing the latest ${posts.length} of ${total} posts.` : ''} Click
        a post to edit it.
      </p>
      <section className={`${cardCls} mt-6 overflow-hidden`}>
        {posts.length === 0 ? (
          <p className="p-5 text-sm text-zinc-500" role="status">
            No posts yet. Write your first one below.
          </p>
        ) : (
          <div className={tableWrap}>
            <table className={tableCls}>
              <caption className="sr-only">Blog posts</caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Published</th>
                  <th scope="col">URL</th>
                  <th scope="col" className="text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr key={p.id}>
                    <td className="font-medium text-zinc-950">{p.title}</td>
                    <td>
                      <StatusBadge value={p.status} />
                    </td>
                    <td className="text-zinc-500">
                      {p.published_at ? formatDate(p.published_at) : '—'}
                    </td>
                    <td className="text-zinc-500">/blog/{p.slug}</td>
                    <td className="text-right">
                      <span className="inline-flex gap-1">
                        <button
                          className={btnGhost}
                          onClick={() => {
                            const localValue = p.published_at
                              ? utcToLocalDateTimeInput(p.published_at)
                              : '';
                            setLoadedSchedule(
                              p.published_at ? { localValue, iso: p.published_at } : null
                            );
                            setForm({
                              id: p.id,
                              slug: p.slug,
                              title: p.title,
                              status: p.status,
                              excerpt: p.excerpt,
                              contentHtml: p.content_html,
                              seoTitle: p.seo_title ?? '',
                              seoDescription: p.seo_description ?? '',
                              tags: p.tags,
                              coverMediaId: p.cover_media_id ?? '',
                              publishedAt: localValue,
                            });
                            setMsg(
                              `Editing “${p.title}”. The editor below is loaded with its content.`
                            );
                            document
                              .getElementById('post-editor')
                              ?.scrollIntoView({ behavior: 'smooth' });
                          }}
                        >
                          Edit
                        </button>
                        {p.status === 'published' ? (
                          <Link to="/blog/$slug" params={{ slug: p.slug }} className={btnGhost}>
                            View
                          </Link>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section id="post-editor" className="mt-6 space-y-4 scroll-mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-zinc-950">
            {form.id ? `Editing “${form.title}”` : 'Write a post'}
          </h2>
          {form.id ? (
            <button
              className={btnGhost}
              onClick={() => {
                setForm(EMPTY);
                setLoadedSchedule(null);
                setEditorEpoch((epoch) => epoch + 1);
              }}
            >
              Write a new post instead
            </button>
          ) : null}
        </div>
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
                    setErrorMsg(err instanceof Error ? err.message : 'Cover upload failed');
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
            Use “Insert image” in the editor toolbar to upload and embed images in the article.
          </p>
        </div>
        <BlogEditor
          key={form.id || `new-${editorEpoch}`}
          initialHtml={form.contentHtml}
          onSave={async (html, json) => {
            const result = await saveBlogPost(
              adminAction,
              { ...form, contentHtml: html, contentJson: json },
              loadedSchedule
            );
            if (result.ok) {
              setMsg(
                form.status === 'published' ? 'Post saved and published.' : 'Post saved as a draft.'
              );
              setForm(EMPTY);
              setLoadedSchedule(null);
              if (result.created) setEditorEpoch((epoch) => epoch + 1);
              router.invalidate();
            } else setErrorMsg(result.error);
          }}
        />
      </section>
      {errorMsg ? (
        <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {errorMsg}
        </p>
      ) : null}
      `n{' '}
      {msg ? (
        <p className="mt-4 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700" role="status">
          {msg}
        </p>
      ) : null}
    </main>
  );
}
