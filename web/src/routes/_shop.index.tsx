import { inBrowser, seedAvailability, useAvailability } from '../lib/availability';
import { pageAvailability } from '../server/page-availability';
import { validateServerInput } from '../server/function-boundary';
import { homeInputSchema } from '../schemas/checkout';
import { Link, createFileRoute } from '@tanstack/react-router';
import { formatDate } from '../lib/format';
import { createServerFn } from '@tanstack/react-start';
import { getHomeCollections, getStorefrontLayout } from '../server/catalog-read';
import { getFeaturedRails } from '../server/catalog-discovery';
import { requestCanonicalBase } from '../server/canonical-base';
import { ProductCard } from '../components/ProductCard';
import { mediaSrcSet, mediaUrl } from '../lib/media-url';
import { buttonVariants } from '@/components/ui/button';
import { Card as UiCard } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { absoluteUrl, seoMeta } from '../lib/seo';
import { ArrowRightIcon, ReturnIcon, ShieldIcon, TruckIcon } from '../components/icons';

const getHome = createServerFn({ method: 'GET' })
  .validator(validateServerInput(homeInputSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const [layout, collections] = await Promise.all([
      getStorefrontLayout(env.DB, env),
      getHomeCollections(env.DB, env),
    ]);
    const rails = await getFeaturedRails(env.DB, env, layout.featured);
    return {
      storeName: layout.storeName,
      hero: layout.hero,
      canonicalBaseUrl: requestCanonicalBase(layout.canonicalBaseUrl),
      rails,
      collections,
      posts: layout.posts,
      availability: await pageAvailability(
        data.live,
        rails.flatMap((rail) => rail.products.map((p) => p.id)),
        'products'
      ),
    };
  });

export const Route = createFileRoute('/_shop/')({
  loader: async ({ preload }) =>
    seedAvailability(await getHome({ data: { live: inBrowser() && !preload } })),
  staleTime: 20_000,
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
  const { storeName, hero, rails, collections, posts, availability: seed } = Route.useLoaderData();
  const availability = useAvailability(
    [...new Set(rails.flatMap((rail) => rail.products.map((p) => p.id)))],
    'products',
    '',
    seed
  );

  return (
    <main>
      {/* Hero */}
      <section className="py-20 sm:py-24 lg:py-32">
        <div className={hero ? 'grid items-center gap-10 lg:grid-cols-2 lg:gap-14' : undefined}>
          <div className="max-w-2xl">
            <h1 className="text-5xl font-normal tracking-[-0.03em] text-zinc-950 sm:text-6xl">
              {storeName}
            </h1>
            <p className="mt-5 text-lg leading-8 text-zinc-500">
              Goods made to be used every day. Browse the collection and choose something you’ll
              love.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/shop" className={cn(buttonVariants({ size: 'lg' }))}>
                Shop all products <ArrowRightIcon className="h-4 w-4" />
              </Link>
              <Link
                to="/articles"
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}
              >
                Read articles
              </Link>
            </div>
          </div>
          {hero ? (
            <img
              src={mediaUrl(hero, 960)}
              srcSet={mediaSrcSet(hero)}
              sizes="(min-width: 1024px) 50vw, 100vw"
              alt=""
              className="aspect-[4/5] w-full rounded-2xl object-cover"
            />
          ) : null}
        </div>
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
              Opening checkout does not reserve inventory. Stock is allocated after payment
              authorization, before the payment is captured.
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

      {/* Featured collections */}
      {rails.map((rail) => (
        <section key={rail.slug} aria-label={rail.title} className="pt-16">
          <div className="flex items-end justify-between gap-4">
            <h2 className="text-2xl font-normal tracking-tight text-zinc-950">{rail.title}</h2>
            <Link
              to="/collections/$slug"
              params={{ slug: rail.slug }}
              className="shrink-0 text-sm font-medium text-zinc-950 underline underline-offset-4"
            >
              View all
            </Link>
          </div>
          <div className="mt-8 grid grid-cols-2 gap-x-5 gap-y-10 lg:grid-cols-4">
            {rail.products.map((p) => (
              <ProductCard key={p.id} product={p} availability={availability[p.id]} />
            ))}
          </div>
        </section>
      ))}

      {/* Articles */}
      {posts.length > 0 ? (
        <section aria-label="Articles" className="pt-20">
          <div className="flex items-end justify-between gap-4">
            <h2 className="text-2xl font-normal tracking-tight text-zinc-950">Articles</h2>
            <Link
              to="/articles"
              className="shrink-0 text-sm font-medium text-zinc-950 underline underline-offset-4"
            >
              All articles
            </Link>
          </div>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {posts.map((p) => (
              <Link key={p.slug} to="/articles/$slug" params={{ slug: p.slug }} className="group">
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
