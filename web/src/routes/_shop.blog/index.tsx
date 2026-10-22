import { absoluteUrl, seoMeta } from '../../lib/seo';
import { getStorefrontLayout, listPublishedPosts } from '../../server/catalog-read';
import { withRequestCanonicalBase } from '../../server/canonical-base';
import { Link, createFileRoute } from '@tanstack/react-router';
import { formatDate } from '../../lib/format';
import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../../server/function-boundary';
import { collectionSearchSchema, homePageInputSchema } from '../../schemas/checkout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';

const getPosts = createServerFn({ method: 'GET' })
  .validator(validateServerInput(homePageInputSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    return {
      ...(await listPublishedPosts(env.DB, env, data.page)),
      layout: withRequestCanonicalBase(await getStorefrontLayout(env.DB, env)),
    };
  });

export const Route = createFileRoute('/_shop/blog/')({
  validateSearch: collectionSearchSchema,
  loaderDeps: ({ search: { page } }) => ({ page }),
  loader: async ({ deps }) => getPosts({ data: { page: deps.page } }),
  staleTime: 20_000,
  headers: () => ({
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    'CDN-Cache-Control': 'max-age=3600, stale-while-revalidate=86400',
  }),
  head: ({ loaderData }) => ({
    meta: loaderData
      ? seoMeta({
          title: `Journal · ${loaderData.layout.storeName}`,
          description: 'Articles and updates.',
          url: absoluteUrl(loaderData.layout.canonicalBaseUrl, '/blog'),
        })
      : [],
    links: loaderData
      ? [{ rel: 'canonical', href: absoluteUrl(loaderData.layout.canonicalBaseUrl, '/blog') }]
      : [],
  }),
  component: BlogIndex,
});

function BlogIndex() {
  const { posts, page, pageCount } = Route.useLoaderData();
  const [first, ...rest] = posts;
  return (
    <main className="py-10 lg:py-14">
      <div className="max-w-2xl">
        <h1 className="text-4xl font-normal tracking-tight text-zinc-950">Journal</h1>
        <p className="mt-3 leading-7 text-zinc-500">
          Stories, guides, and notes from the store: how things are made, how to care for them, and
          what is coming next.
        </p>
      </div>
      {pageCount > 1 ? (
        <Pagination className="mt-6 justify-start" aria-label="Journal pages">
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

      {posts.length === 0 ? (
        <Card
          className="mt-10 border-dashed px-6 py-14 text-center text-sm text-zinc-500"
          role="status"
        >
          No articles published yet. The first post written in Admin → Blog will appear here.
        </Card>
      ) : (
        <>
          {first ? (
            <Link to="/blog/$slug" params={{ slug: first.slug }} className="group mt-10 block">
              <Card className="bg-zinc-950 p-7 text-white sm:p-9">
                <time className="text-xs font-medium text-white/50" dateTime={first.published_at}>
                  {formatDate(first.published_at)}
                </time>
                <h2 className="mt-2.5 max-w-2xl text-[26px] leading-snug font-medium group-hover:underline group-hover:underline-offset-4">
                  {first.title}
                </h2>
                {first.excerpt ? (
                  <p className="mt-2.5 line-clamp-3 max-w-2xl leading-7 text-white/65">
                    {first.excerpt}
                  </p>
                ) : null}
                <span className="mt-5 inline-block text-sm font-medium underline underline-offset-4">
                  Read article
                </span>
              </Card>
            </Link>
          ) : null}
          <div className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {rest.map((p) => (
              <Link key={p.slug} to="/blog/$slug" params={{ slug: p.slug }} className="group">
                <Card className="h-full p-5 transition-colors group-hover:border-zinc-300">
                  <time className="text-xs font-medium text-zinc-400" dateTime={p.published_at}>
                    {formatDate(p.published_at)}
                  </time>
                  <h3 className="mt-2 text-base leading-snug font-medium text-zinc-950 group-hover:underline group-hover:underline-offset-4">
                    {p.title}
                  </h3>
                  {p.excerpt ? (
                    <p className="mt-2 line-clamp-3 text-sm leading-6 text-zinc-500">{p.excerpt}</p>
                  ) : null}
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
