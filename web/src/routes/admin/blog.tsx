import { staffMiddleware } from '../../server/staff-middleware';
import { Link, createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { StatusBadge } from '../../components/StatusBadge';
import { formatDate } from '../../lib/format';
import type { PostStatus } from '../../db/schema';
import {
  btnGhost,
  btnPrimary,
  cardCls,
  pageSub,
  pageTitle,
  tableCls,
  tableWrap,
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
  // The Tiptap editor renders in the browser only; the loader still runs on the server.
  ssr: 'data-only',
  loader: async () => getData(),
  component: AdminBlog,
});

function AdminBlog() {
  const { posts, total } = Route.useLoaderData();
  return (
    <main>
      <h1 className={pageTitle}>Blog</h1>
      <p className={pageSub}>
        Publish stories, guides, and announcements. Published posts get SEO meta, structured data,
        and a sitemap entry automatically.
        {total > posts.length ? ` Showing the latest ${posts.length} of ${total} posts.` : ''} Open
        a post to edit it in its own workspace.
      </p>
      <div className="mt-5">
        <Link to="/admin/blog/$id" params={{ id: 'new' }} className={btnPrimary}>
          Write a post
        </Link>
      </div>
      <section className={`${cardCls} mt-5 overflow-hidden`}>
        {posts.length === 0 ? (
          <p className="p-5 text-sm text-zinc-500" role="status">
            No posts yet. Write your first one.
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
                        <Link to="/admin/blog/$id" params={{ id: p.id }} className={btnGhost}>
                          Edit
                        </Link>
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
    </main>
  );
}
