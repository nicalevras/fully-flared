import { inBrowser, seedAvailability, useAvailability } from '../lib/availability';
import { pageAvailability } from '../server/page-availability';
import { Link, createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getShopProductsPage, getStorefrontLayout } from '../server/catalog-read';
import { requestCanonicalBase } from '../server/canonical-base';
import { validateServerInput } from '../server/function-boundary';
import { shopPageInputSchema } from '../schemas/checkout';
import { storefrontPageSearch } from '../lib/search-params';
import { ProductCard } from '../components/ProductCard';
import { openSearchPalette } from '../components/SearchPalette';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card as UiCard } from '@/components/ui/card';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';
import { cn } from '@/lib/utils';
import { absoluteUrl, pagedPath, seoMeta } from '../lib/seo';

const getShop = createServerFn({ method: 'GET' })
  .validator(validateServerInput(shopPageInputSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const [catalog, layout] = await Promise.all([
      getShopProductsPage(env.DB, env, data.page),
      getStorefrontLayout(env.DB, env),
    ]);
    return {
      products: catalog.products,
      total: catalog.total,
      page: catalog.page,
      pageCount: catalog.pageCount,
      storeName: layout.storeName,
      canonicalBaseUrl: requestCanonicalBase(layout.canonicalBaseUrl),
      availability: await pageAvailability(
        data.live,
        catalog.products.map((p) => p.id),
        'products'
      ),
    };
  });

export const Route = createFileRoute('/_shop/shop')({
  validateSearch: storefrontPageSearch,
  search: { middlewares: [stripSearchParams({ page: 1 })] },
  loaderDeps: ({ search: { page } }) => ({ page }),
  loader: async ({ deps, preload }) =>
    seedAvailability(await getShop({ data: { page: deps.page, live: inBrowser() && !preload } })),
  staleTime: 20_000,
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: 'Shop all' }] };
    const url = absoluteUrl(loaderData.canonicalBaseUrl, pagedPath('/shop', loaderData.page));
    return {
      meta: seoMeta({
        title: `Shop all · ${loaderData.storeName}`,
        description: 'Every product in the store.',
        url,
      }),
      links: [{ rel: 'canonical', href: url }],
    };
  },
  component: ShopPage,
});

function ShopPage() {
  const { products, total, page, pageCount, availability: seed } = Route.useLoaderData();
  const availability = useAvailability(
    products.map((p) => p.id),
    'products',
    '',
    seed
  );

  return (
    <main className="py-10 lg:py-14">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[32px] font-normal tracking-tight text-zinc-950">Shop all</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {total} product{total === 1 ? '' : 's'} to explore.
            {pageCount > 1 ? ` Page ${page} of ${pageCount}.` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={openSearchPalette}
          className="hidden shrink-0 text-sm font-medium text-zinc-950 underline underline-offset-4 sm:block"
        >
          Search
        </button>
      </div>
      {products.length === 0 ? (
        <UiCard className="mt-8 border-dashed px-6 py-16 text-center" role="status">
          <p className="font-medium text-zinc-950">No products are live yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
            New products are on the way. Browse the collections in the meantime.
          </p>
          <Link to="/collections" className={cn(buttonVariants({ size: 'lg' }), 'mt-5')}>
            Browse collections
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
                  <Link to="/shop" search={{ page: page - 1 }}>
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
                  <Link to="/shop" search={{ page: page + 1 }}>
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
