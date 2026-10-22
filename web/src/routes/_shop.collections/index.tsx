import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { listAllCollections } from '../../server/catalog-read';
import { validateServerInput } from '../../server/function-boundary';
import { collectionPageInputSchema, collectionSearchSchema } from '../../schemas/checkout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';

const getCollections = createServerFn({ method: 'GET' })
  .validator(validateServerInput(collectionPageInputSchema.omit({ slug: true })))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    return listAllCollections(env.DB, env, data.page);
  });

export const Route = createFileRoute('/_shop/collections/')({
  validateSearch: collectionSearchSchema,
  loaderDeps: ({ search: { page } }) => ({ page }),
  loader: async ({ deps }) => getCollections({ data: { page: deps.page } }),
  headers: () => ({
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    'CDN-Cache-Control': 'max-age=300, stale-while-revalidate=600',
  }),
  head: () => ({ meta: [{ title: 'Collections' }] }),
  component: CollectionsIndex,
});

function CollectionsIndex() {
  const { collections, total, page, pageCount } = Route.useLoaderData();
  return (
    <main className="py-10 lg:py-14">
      <h1 className="text-[32px] font-normal tracking-tight">Collections</h1>
      <p className="mt-2 text-sm text-zinc-500">
        {total} collection{total === 1 ? '' : 's'}
        {pageCount > 1 ? ` · Page ${page} of ${pageCount}` : ''}
      </p>
      {collections.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500" role="status">
          No collections yet.
        </p>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {collections.map((c) => (
            <li key={c.slug}>
              <Card className="h-full p-5">
                <Link
                  to="/collections/$slug"
                  params={{ slug: c.slug }}
                  className="font-medium text-zinc-950 hover:underline"
                >
                  {c.title}
                </Link>
                {c.description && <p className="mt-1 text-sm text-zinc-500">{c.description}</p>}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {pageCount > 1 ? (
        <Pagination className="mt-10 justify-start" aria-label="Collection pages">
          <PaginationContent>
            {page > 1 ? (
              <PaginationItem>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/collections" search={{ page: page - 1 }}>
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
                  <Link to="/collections" search={{ page: page + 1 }}>
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
