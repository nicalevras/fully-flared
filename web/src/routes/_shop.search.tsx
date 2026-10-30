import { inBrowser, seedAvailability, useAvailability } from '../lib/availability';
import { pageAvailability } from '../server/page-availability';
import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseStatus } from '@tanstack/react-start/server';
import { validateServerInput } from '../server/function-boundary';
import { searchCatalog } from '../server/catalog-discovery';
import { storefrontLimited } from '../server/storefront-limit';
import * as z from 'zod';
import { catalogSearch } from '../lib/search-params';
import { ProductCard } from '../components/ProductCard';
import { SearchIcon } from '../components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

const search = createServerFn({ method: 'GET' })
  .validator(
    validateServerInput(
      z.object({
        q: z.string().max(200),
        cursor: z.string().max(500).optional(),
        live: z.boolean().default(false),
      })
    )
  )
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const result = await searchCatalog(env.DB, env, data.q, data.cursor, () =>
      storefrontLimited(env.STOREFRONT_LIMITER, 'search', getRequest())
    );
    if (result.limited) setResponseStatus(429);
    return {
      ...result,
      availability: await pageAvailability(
        data.live,
        result.cards.map((p) => p.id),
        'products'
      ),
    };
  });

export const Route = createFileRoute('/_shop/search')({
  validateSearch: catalogSearch,
  loaderDeps: ({ search: { q, cursor } }) => ({ q, cursor }),
  loader: async ({ deps, preload }) =>
    seedAvailability(await search({ data: { ...deps, live: inBrowser() && !preload } })),
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
    q,
    data.availability
  );
  return (
    <main className="py-10 lg:py-14">
      <h1 className="text-[32px] font-normal tracking-tight">Search</h1>
      {/* Keyed by the URL query: a new search remounts the form with the
          current value instead of copying props into state in an effect. */}
      <SearchForm key={q} initial={q} />

      {q && data.limited ? (
        <p className="mt-8 text-sm text-zinc-500" role="status">
          Too many searches, try again in a minute.
        </p>
      ) : q ? (
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
                <Link to="/shop" className="text-zinc-950 underline underline-offset-2">
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
