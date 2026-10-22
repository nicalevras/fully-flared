import { useAvailability } from '../../lib/availability';
import { absoluteUrl, seoMeta } from '../../lib/seo';
import { getStorefrontLayout } from '../../server/catalog-read';
import { withRequestCanonicalBase } from '../../server/canonical-base';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getPublishedCollection } from '../../server/catalog-discovery';
import { validateServerInput } from '../../server/function-boundary';
import { collectionPageInputSchema, collectionSearchSchema } from '../../schemas/checkout';
import { ProductCard } from '../../components/ProductCard';
import { CollectionNotFound } from '../../components/NotFound';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';

const getCollection = createServerFn({ method: 'GET' })
  .validator(validateServerInput(collectionPageInputSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const layout = await getStorefrontLayout(env.DB, env);
    const result = await getPublishedCollection(env.DB, env, data.slug, data.page);
    if (!result) throw notFound();
    return { ...result, layout: withRequestCanonicalBase(layout) };
  });

export const Route = createFileRoute('/_shop/collections/$slug')({
  validateSearch: collectionSearchSchema,
  loaderDeps: ({ search: { page } }) => ({ page }),
  loader: async ({ params, deps }) =>
    getCollection({ data: { slug: params.slug, page: deps.page } }),
  headers: () => ({
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    'CDN-Cache-Control': 'max-age=300, stale-while-revalidate=600',
  }),
  notFoundComponent: CollectionNotFound,
  head: ({ loaderData }) => ({
    meta: loaderData
      ? seoMeta({
          title:
            loaderData.collection.seoTitle ||
            `${loaderData.collection.title} · ${loaderData.layout.storeName}`,
          description: loaderData.collection.seoDescription || loaderData.collection.description,
          url: absoluteUrl(
            loaderData.layout.canonicalBaseUrl,
            `/collections/${loaderData.collection.slug}`
          ),
        })
      : [],
    links: loaderData
      ? [
          {
            rel: 'canonical',
            href: absoluteUrl(
              loaderData.layout.canonicalBaseUrl,
              `/collections/${loaderData.collection.slug}`
            ),
          },
        ]
      : [],
  }),
  staleTime: 20_000,
  component: CollectionPage,
});

function CollectionPage() {
  const { collection, products, total, page, pageCount } = Route.useLoaderData();
  const availability = useAvailability(
    products.map((p) => p.id),
    'products',
    collection.slug
  );
  return (
    <main className="py-10 lg:py-14">
      <div className="max-w-2xl">
        <h1 className="text-[36px] font-normal tracking-tight">{collection.title}</h1>
        {collection.description ? (
          <p className="mt-3 leading-7 text-zinc-500">{collection.description}</p>
        ) : null}
        <p className="mt-3 text-sm text-zinc-500">
          {total} product{total === 1 ? '' : 's'}
          {pageCount > 1 ? ` · Page ${page} of ${pageCount}` : ''}
        </p>
      </div>
      {products.length === 0 ? (
        <Card
          className="mt-8 border-dashed px-6 py-14 text-center text-sm text-zinc-500"
          role="status"
        >
          Nothing is in this collection yet. Products added to it in the admin will appear here.
        </Card>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-x-5 gap-y-9 lg:grid-cols-4">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} availability={availability[p.id]} />
          ))}
        </div>
      )}
      {pageCount > 1 ? (
        <Pagination className="mt-10 justify-start" aria-label="Collection pages">
          <PaginationContent>
            {page > 1 ? (
              <PaginationItem>
                <Button asChild variant="ghost" size="sm">
                  <Link
                    to="/collections/$slug"
                    params={{ slug: collection.slug }}
                    search={{ page: page - 1 }}
                  >
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
                  <Link
                    to="/collections/$slug"
                    params={{ slug: collection.slug }}
                    search={{ page: page + 1 }}
                  >
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
