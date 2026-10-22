import { useAvailability, availabilityLabel } from '../lib/availability';
import { Link, createFileRoute } from '@tanstack/react-router';
import { formatDate } from '../lib/format';
import { createServerFn } from '@tanstack/react-start';
import { type PublishedProductCard as Card } from '../server/catalog';
import {
  getHomeCollections,
  getHomeProductsPage,
  getStorefrontLayout,
} from '../server/catalog-read';
import { requestCanonicalBase } from '../server/canonical-base';
import { validateServerInput } from '../server/function-boundary';
import { collectionSearchSchema, homePageInputSchema } from '../schemas/checkout';
import { ProductCard } from '../components/ProductCard';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card as UiCard } from '@/components/ui/card';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { absoluteUrl, seoMeta } from '../lib/seo';
import { ArrowRightIcon, ReturnIcon, ShieldIcon, TruckIcon } from '../components/icons';

type HomeData = {
  holdMinutes: number;
  products: Card[];
  total: number;
  page: number;
  pageCount: number;
  featured: Card | null;
  storeName: string;
  canonicalBaseUrl: string;
  collections: Array<{ slug: string; title: string; description: string }>;
  posts: Array<{ slug: string; title: string; excerpt: string; published_at: string }>;
};

const getHome = createServerFn({ method: 'GET' })
  .validator(validateServerInput(homePageInputSchema))
  .handler(async ({ data }): Promise<HomeData> => {
    const { env } = await import('cloudflare:workers');
    // Catalogue pages come from the published KV snapshot (or the
    // bounded D1 fallback inside getHomeProductsPage), and the public
    // cache headers keep repeat views at the edge.
    const [catalog, layout, collections] = await Promise.all([
      getHomeProductsPage(env.DB, env, data.page),
      getStorefrontLayout(env.DB, env),
      getHomeCollections(env.DB, env),
    ]);
    return {
      holdMinutes: layout.limits.checkout_hold_minutes,
      products: catalog.products,
      total: catalog.total,
      page: catalog.page,
      pageCount: catalog.pageCount,
      featured: catalog.featured,
      storeName: layout.storeName,
      canonicalBaseUrl: requestCanonicalBase(layout.canonicalBaseUrl),
      collections,
      posts: layout.posts,
    };
  });

export const Route = createFileRoute('/_shop/')({
  validateSearch: collectionSearchSchema,
  loaderDeps: ({ search: { page } }) => ({ page }),
  loader: async ({ deps }) => getHome({ data: { page: deps.page } }),
  staleTime: 20_000,
  headers: () => ({
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    'CDN-Cache-Control': 'max-age=300, stale-while-revalidate=600',
  }),
  head: ({ loaderData }) => ({
    meta: loaderData
      ? seoMeta({
          title: loaderData.storeName,
          description: 'Shop the catalogue.',
          url: absoluteUrl(loaderData.canonicalBaseUrl, '/'),
        })
      : [{ title: 'Store' }],
    links: loaderData
      ? [{ rel: 'canonical', href: absoluteUrl(loaderData.canonicalBaseUrl, '/') }]
      : [],
  }),
  component: HomePage,
});

function HomePage() {
  const { products, total, page, pageCount, featured, storeName, collections, posts, holdMinutes } =
    Route.useLoaderData();
  const availability = useAvailability([
    ...new Set(
      [featured?.id, ...products.map((p) => p.id)].filter((id): id is string => Boolean(id))
    ),
  ]);

  return (
    <main>
      {/* Hero */}
      <section className="py-20 sm:py-24 lg:py-32">
        <div className="max-w-2xl">
          <h1 className="text-5xl font-normal tracking-[-0.03em] text-zinc-950 sm:text-6xl">
            {storeName}
          </h1>
          <p className="mt-5 text-lg leading-8 text-zinc-500">
            Goods made to be used every day. Browse the collection and choose something you’ll love.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="#catalogue" className={cn(buttonVariants({ size: 'lg' }))}>
              Shop products <ArrowRightIcon className="h-4 w-4" />
            </a>
            <Link to="/blog" className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}>
              Read the journal
            </Link>
          </div>
        </div>

        {featured?.imageKey ? (
          <Link to="/products/$slug" params={{ slug: featured.slug }} className="group mt-14 block">
            <div className="relative flex aspect-[16/8] items-center justify-center overflow-hidden rounded-2xl bg-zinc-100">
              <img
                src={`/media/${featured.imageKey}`}
                alt={featured.title}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
              />
              <div className="absolute bottom-4 left-4 flex items-center gap-3 rounded-full bg-white py-1.5 pr-4 pl-1.5 shadow-sm">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-950 text-xs font-medium text-white"
                  aria-hidden
                >
                  {featured.title.slice(0, 1).toUpperCase()}
                </span>
                <span className="flex items-center gap-1.5 text-sm">
                  <span className="font-medium text-zinc-950">{featured.title}</span>
                  {availability[featured.id] ? (
                    <span className="text-zinc-500">
                      {availabilityLabel(availability[featured.id])}
                    </span>
                  ) : (
                    <Skeleton className="h-4 w-16" aria-hidden />
                  )}
                </span>
              </div>
            </div>
          </Link>
        ) : null}
      </section>

      {/* Assurances */}
      <section
        aria-label="Why shop here"
        className="grid gap-8 border-y border-zinc-200 py-10 sm:grid-cols-3"
      >
        <div className="flex gap-3.5">
          <TruckIcon className="h-6 w-6 shrink-0 text-zinc-950" />
          <div>
            <h2 className="text-sm font-medium text-zinc-950">Fast, honest shipping</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-500">
              Rates by zone at checkout. Orders leave within 1-2 business days with tracking.
            </p>
          </div>
        </div>
        <div className="flex gap-3.5">
          <ReturnIcon className="h-6 w-6 shrink-0 text-zinc-950" />
          <div>
            <h2 className="text-sm font-medium text-zinc-950">30-day returns</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-500">
              Start a return from your account. Refunds go back to your original payment method.
            </p>
          </div>
        </div>
        <div className="flex gap-3.5">
          <ShieldIcon className="h-6 w-6 shrink-0 text-zinc-950" />
          <div>
            <h2 className="text-sm font-medium text-zinc-950">Stock you can trust</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-500">
              Your items are reserved for {holdMinutes} minutes while you pay, so the last unit is
              never sold twice.
            </p>
          </div>
        </div>
      </section>

      {/* Collections */}
      {collections.length > 0 ? (
        <section aria-label="Collections" className="pt-16">
          <div className="flex flex-wrap gap-2.5">
            {collections.map((c) => (
              <Link
                key={c.slug}
                to="/collections/$slug"
                params={{ slug: c.slug }}
                className={cn(buttonVariants({ variant: 'outline' }))}
              >
                {c.title}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* Catalogue */}
      <section id="catalogue" aria-label="Catalogue" className="scroll-mt-24 pt-16">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-normal tracking-tight text-zinc-950">Shop all</h2>
            <p className="mt-1 text-sm text-zinc-500">
              {total} product{total === 1 ? '' : 's'} to explore.
              {pageCount > 1 ? ` Page ${page} of ${pageCount}.` : ''}
            </p>
          </div>
          <Link
            to="/search"
            search={{ q: '' }}
            className="hidden shrink-0 text-sm font-medium text-zinc-950 underline underline-offset-4 sm:block"
          >
            Search
          </Link>
        </div>
        {products.length === 0 ? (
          <UiCard className="mt-8 border-dashed px-6 py-16 text-center" role="status">
            <p className="font-medium text-zinc-950">No products are live yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
              Add the first product from the store admin and it will appear here instantly.
            </p>
            <Link to="/admin/products" className={cn(buttonVariants({ size: 'lg' }), 'mt-5')}>
              Add a product
            </Link>
          </UiCard>
        ) : (
          <div className="mt-8 grid grid-cols-2 gap-x-5 gap-y-10 lg:grid-cols-4">
            {products.map((p) => (
              <ProductCard key={p.id} product={p} availability={availability[p.id]} />
            ))}
          </div>
        )}
        {pageCount > 1 ? (
          <Pagination className="mt-10 justify-start" aria-label="Catalogue pages">
            <PaginationContent>
              {page > 1 ? (
                <PaginationItem>
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/" search={{ page: page - 1 }}>
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
                    <Link to="/" search={{ page: page + 1 }}>
                      Next
                    </Link>
                  </Button>
                </PaginationItem>
              ) : null}
            </PaginationContent>
          </Pagination>
        ) : null}
      </section>

      {/* Journal */}
      {posts.length > 0 ? (
        <section aria-label="Journal" className="pt-20">
          <div className="flex items-end justify-between gap-4">
            <h2 className="text-2xl font-normal tracking-tight text-zinc-950">Journal</h2>
            <Link
              to="/blog"
              className="shrink-0 text-sm font-medium text-zinc-950 underline underline-offset-4"
            >
              All articles
            </Link>
          </div>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {posts.map((p) => (
              <Link key={p.slug} to="/blog/$slug" params={{ slug: p.slug }} className="group">
                <UiCard className="h-full p-6 transition-colors group-hover:border-zinc-300">
                  <time className="text-[13px] text-zinc-400" dateTime={p.published_at}>
                    {formatDate(p.published_at)}
                  </time>
                  <h3 className="mt-2.5 font-medium text-zinc-950 group-hover:underline group-hover:underline-offset-4">
                    {p.title}
                  </h3>
                  {p.excerpt ? (
                    <p className="mt-2 line-clamp-3 text-sm leading-6 text-zinc-500">{p.excerpt}</p>
                  ) : null}
                </UiCard>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
