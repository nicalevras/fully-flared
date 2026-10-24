import { absoluteUrl, pagedPath, seoMeta } from '../../lib/seo';
import { loadPostsIndex } from '../../server/storefront-pages';
import { withRequestCanonicalBase } from '../../server/canonical-base';
import { Link, createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { formatDate } from '../../lib/format';
import { mediaUrl } from '../../lib/media-url';
import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../../server/function-boundary';
import { homePageInputSchema } from '../../schemas/checkout';
import { storefrontPageSearch } from '../../lib/search-params';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';

const getPosts = createServerFn({ method: 'GET' })
  .validator(validateServerInput(homePageInputSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const { layout, posts } = await loadPostsIndex(env.DB, env, data.page);
    return { ...posts, layout: withRequestCanonicalBase(layout) };
  });

export const Route = createFileRoute('/_shop/blog/')({
  validateSearch: storefrontPageSearch,
  search: { middlewares: [stripSearchParams({ page: 1 })] },
  loaderDeps: ({ search: { page } }) => ({ page }),
  loader: async ({ deps }) => getPosts({ data: { page: deps.page } }),
  staleTime: 20_000,
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [], links: [] };
    const url = absoluteUrl(
      loaderData.layout.canonicalBaseUrl,
      pagedPath('/blog', loaderData.page)
    );
    return {
      meta: seoMeta({
        title: `Journal · ${loaderData.layout.storeName}`,
        description: 'Articles and updates.',
        url,
      }),
      links: [{ rel: 'canonical', href: url }],
    };
  },
  component: BlogIndex,
});

function BlogIndex() {
  const { posts, page, pageCount } = Route.useLoaderData();
  return (
    <main className="py-10 lg:py-14">
      <div className="max-w-2xl">
        <h1 className="text-4xl font-normal tracking-tight text-zinc-950">Journal</h1>
        <p className="mt-3 leading-7 text-zinc-500">
          Stories, guides, and notes from the store: how things are made, how to care for them, and
          what is coming next.
        </p>
      </div>
      {posts.length === 0 ? (
        <Card
          className="mt-10 border-dashed px-6 py-14 text-center text-sm text-zinc-500"
          role="status"
        >
          No articles published yet. The first post written in Admin → Blog will appear here.
        </Card>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-x-5 gap-y-10 lg:grid-cols-4">
          {posts.map((post) => (
            <article key={post.slug} className="group">
              <Link to="/blog/$slug" params={{ slug: post.slug }} className="block">
                <div className="relative flex aspect-[4/5] items-center justify-center overflow-hidden rounded-xl bg-zinc-100">
                  {post.cover_key ? (
                    <img
                      src={mediaUrl({ key: post.cover_key, publicUrl: post.cover_public_url })}
                      alt={post.title}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    />
                  ) : (
                    <span
                      className="text-6xl leading-none font-light text-zinc-300 select-none transition-transform duration-500 group-hover:scale-105"
                      aria-hidden
                    >
                      {post.title.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="pt-3">
                  <h2 className="text-sm leading-snug font-medium text-zinc-950">{post.title}</h2>
                  <time className="mt-1 block text-xs text-zinc-400" dateTime={post.published_at}>
                    {formatDate(post.published_at)}
                  </time>
                  {post.excerpt ? (
                    <p className="mt-2 line-clamp-3 text-sm leading-6 text-zinc-500">
                      {post.excerpt}
                    </p>
                  ) : null}
                </div>
              </Link>
            </article>
          ))}
        </div>
      )}
      {pageCount > 1 ? (
        <Pagination className="mt-10 justify-start" aria-label="Journal pages">
          <PaginationContent>
            {page > 1 ? (
              <PaginationItem>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/blog" search={{ page: page - 1 }}>
                    Previous
                  </Link>
                </Button>
              </PaginationItem>
            ) : null}
            <PaginationItem>
              <span className="px-2 text-sm text-zinc-500">
                Page {page} of {pageCount}
              </span>
            </PaginationItem>
            {page < pageCount ? (
              <PaginationItem>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/blog" search={{ page: page + 1 }}>
                    Next
                  </Link>
                </Button>
              </PaginationItem>
            ) : null}
          </PaginationContent>
        </Pagination>
      ) : null}
    </main>
  );
}
