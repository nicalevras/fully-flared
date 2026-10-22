import { useAvailability } from '../lib/availability';
import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../server/function-boundary';
import { searchCatalog } from '../server/catalog-discovery';
import * as z from 'zod';
import { searchQueryParamSchema } from '../schemas/checkout';
import { ProductCard } from '../components/ProductCard';
import { SearchIcon } from '../components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

const search = createServerFn({ method: 'GET' })
  .validator(
    validateServerInput(
      z.object({ q: z.string().max(200), cursor: z.string().max(500).optional() })
    )
  )
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    return searchCatalog(env.DB, env, data.q, data.cursor);
  });

export const Route = createFileRoute('/_shop/search')({
  validateSearch: searchQueryParamSchema.extend({
    cursor: z.string().max(500).optional().catch(undefined),
  }),
  loaderDeps: ({ search: { q, cursor } }) => ({ q, cursor }),
  loader: async ({ deps }) => search({ data: deps }),
  headers: () => ({
    'Cache-Control': 'public, max-age=30, stale-while-revalidate=120',
    'CDN-Cache-Control': 'max-age=120, stale-while-revalidate=300',
  }),
  head: () => ({ meta: [{ title: 'Search' }, { name: 'robots', content: 'noindex' }] }),
  component: SearchPage,
});

function SearchForm({ initial }: { initial: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState(initial);
  return (
    <form
      className="mt-6 flex max-w-xl items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        navigate({ to: '/search', search: { q: value } });
      }}
    >
      <div className="relative min-w-0 flex-1">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 h-5 w-5 -translate-y-1/2 text-zinc-400" />
        <Label className="sr-only" htmlFor="search-input">
          Search products
        </Label>
        <Input
          id="search-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search products…"
          className="pl-10"
        />
      </div>
      <Button type="submit" className="shrink-0">
        Search
      </Button>
    </form>
  );
}

function SearchPage() {
  const data = Route.useLoaderData();
  const results = data.cards;
  const { q } = Route.useSearch();
  const availability = useAvailability(
    results.map((p) => p.id),
    'products',
    q
  );
  return (
    <main className="py-10 lg:py-14">
      <h1 className="text-[32px] font-normal tracking-tight">Search</h1>
      {/* Keyed by the URL query: a new search remounts the form with the
          current value instead of copying props into state in an effect. */}
      <SearchForm key={q} initial={q} />

      {q ? (
        <>
          <p className="mt-8 text-sm text-zinc-500" role="status">
            {results.length}
            {data.nextCursor ? '+' : ''} result{results.length === 1 ? '' : 's'} for{' '}
            <strong className="text-zinc-950">“{q}”</strong>
          </p>
          {results.length === 0 ? (
            <Card className="mt-6 border-dashed px-6 py-14 text-center">
              <p className="font-medium">No matches</p>
              <p className="mt-1 text-sm text-zinc-500">
                Try a different word, or browse{' '}
                <Link to="/" className="text-zinc-950 underline underline-offset-2">
                  everything in the store
                </Link>
                .
              </p>
            </Card>
          ) : (
            <div className="mt-6 grid grid-cols-2 gap-x-5 gap-y-9 lg:grid-cols-4">
              {results.map((p) => (
                <ProductCard key={p.id} product={p} availability={availability[p.id]} />
              ))}
            </div>
          )}
          {data.nextCursor && (
            <p className="mt-8">
              <Button asChild variant="outline">
                <Link to="/search" search={{ q, cursor: data.nextCursor }}>
                  More results
                </Link>
              </Button>
            </p>
          )}
        </>
      ) : (
        <p className="mt-8 text-sm text-zinc-500">
          Start typing to search titles and descriptions across the whole catalog.
        </p>
      )}
    </main>
  );
}
