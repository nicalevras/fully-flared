import { useEffect, useState, type ReactNode } from 'react';
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getStorefrontLayout } from '../server/catalog-read';
import { cartCountFromCookie } from '../lib/cart-cookie';
import { BagIcon, MenuIcon, SearchIcon, UserIcon } from '../components/icons';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { CartDrawer } from '../components/CartDrawer';
import { openCart } from '../lib/cart';
import appCss from '../styles.css?url';
import geistRegular from '@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff2?url';
import type { StaffContext } from '../server/staff-middleware';

const getLayout = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('cloudflare:workers');
  // Root layout comes from the KV storefront snapshot when configured;
  // getStorefrontLayout falls back to D1 only when KV is absent/stale.
  // Public data only: this loader's output is baked into cacheable
  // storefront HTML, so it must be identical for every shopper. The
  // cart count is private state and loads separately (Phase 4).
  return getStorefrontLayout(env.DB, env);
});

// Private per-shopper state, fetched once after hydration. Never part
// of the public layout payload. The count mirrors the cart_count
// cookie that cart mutations maintain; it is a cosmetic badge only -
// the server cart is authoritative and checkout revalidates it, so a
// stale or hand-set cookie can mislabel the badge but never the cart.

export const Route = createRootRouteWithContext<{ staff?: StaffContext }>()({
  loader: async () => getLayout(),
  // Store name/collections change rarely — don't block every navigation
  // re-fetching them, which made the old page hang on screen during clicks.
  staleTime: 60_000,
  head: ({ loaderData }) => ({
    links: [
      { rel: 'stylesheet', href: appCss },
      {
        rel: 'preload',
        href: geistRegular,
        as: 'font',
        type: 'font/woff2',
        crossOrigin: 'anonymous',
      },
    ],
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: loaderData?.storeName ?? 'Store' },
    ],
  }),
  shellComponent: RootDocument,
  component: () => <Outlet />,
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
});

function NotFoundPage() {
  return (
    <main className="mx-auto max-w-xl py-20 text-center">
      <h1 className="text-3xl font-normal tracking-tight">Page not found</h1>
      <p className="mt-3 text-zinc-500">
        The page you are looking for does not exist or has moved.
      </p>
      <Link to="/" className={cn(buttonVariants({ size: 'lg' }), 'mt-6')}>
        Back to the store
      </Link>
    </main>
  );
}

function ErrorPage({ error }: ErrorComponentProps) {
  return (
    <main className="mx-auto max-w-xl py-20 text-center">
      <h1 className="text-3xl font-normal tracking-tight">Something went wrong</h1>
      <p className="mt-3 text-zinc-500">
        We hit an unexpected error loading this page. Please try again in a moment.
      </p>
      {import.meta.env.DEV ? (
        <p className="mt-3 text-xs text-red-600">
          {error instanceof Error ? error.message : String(error)}
        </p>
      ) : null}
      <Link to="/" className={cn(buttonVariants({ size: 'lg' }), 'mt-6')}>
        Back to the store
      </Link>
    </main>
  );
}

function CartCount() {
  // Neutral until the private count loads after hydration, so cached
  // public HTML renders the same badge for every shopper.
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(cartCountFromCookie(document.cookie));
  }, []);
  useEffect(() => {
    const onChanged = (e: Event) => {
      const next = (e as CustomEvent<{ count?: number }>).detail?.count;
      if (typeof next === 'number') setCount(next);
    };
    window.addEventListener('cart-changed', onChanged);
    return () => window.removeEventListener('cart-changed', onChanged);
  }, []);
  if (count === 0) return null;
  return (
    <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-zinc-950 px-1 text-[10px] font-medium text-white">
      {count}
    </span>
  );
}

export function StorefrontLayout() {
  const { storeName, announcementText, collections, collectionsTotal, limits } =
    Route.useLoaderData();
  const [menuOpen, setMenuOpen] = useState(false);

  const navLink =
    'rounded-full px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950';
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium"
      >
        Skip to content
      </a>
      {announcementText ? (
        <div className="bg-zinc-950 py-2 px-4 text-center text-[13px] font-medium text-white">
          {announcementText}
        </div>
      ) : null}
      <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-2 px-4 sm:px-6 lg:px-8">
          <Link to="/" className="text-base font-normal tracking-tight text-zinc-950">
            {storeName}
          </Link>
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="ml-1 hover:bg-zinc-100 md:hidden"
                aria-label="Open menu"
              >
                <MenuIcon className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 gap-0 p-0" aria-label="Menu">
              <SheetHeader className="px-4 py-4">
                <SheetTitle>Menu</SheetTitle>
              </SheetHeader>
              <nav className="px-2 py-2" aria-label="Mobile">
                <ul className="flex flex-col gap-1 text-[15px]">
                  <li>
                    <Link
                      to="/shop"
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-lg px-2 py-2 hover:bg-zinc-50"
                    >
                      Shop all
                    </Link>
                  </li>
                  {collections.map((c) => (
                    <li key={c.slug}>
                      <Link
                        to="/collections/$slug"
                        params={{ slug: c.slug }}
                        onClick={() => setMenuOpen(false)}
                        className="block rounded-lg px-2 py-2 hover:bg-zinc-50"
                      >
                        {c.title}
                      </Link>
                    </li>
                  ))}
                  {collectionsTotal > collections.length && (
                    <li>
                      <Link
                        to="/collections"
                        onClick={() => setMenuOpen(false)}
                        className="block rounded-lg px-2 py-2 hover:bg-zinc-50"
                      >
                        All collections
                      </Link>
                    </li>
                  )}
                  <li>
                    <Link
                      to="/blog"
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-lg px-2 py-2 hover:bg-zinc-50"
                    >
                      Journal
                    </Link>
                  </li>
                  <li>
                    <Link
                      to="/search"
                      search={{ q: '' }}
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-lg px-2 py-2 hover:bg-zinc-50"
                    >
                      Search
                    </Link>
                  </li>
                  <li>
                    <Link
                      to="/account"
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-lg px-2 py-2 hover:bg-zinc-50"
                    >
                      Account
                    </Link>
                  </li>
                </ul>
              </nav>
            </SheetContent>
          </Sheet>
          <nav className="ml-6 hidden items-center gap-1 md:flex" aria-label="Primary">
            <Link to="/shop" className={navLink}>
              Shop all
            </Link>
            {collections.map((c) => (
              <Link
                key={c.slug}
                to="/collections/$slug"
                params={{ slug: c.slug }}
                className={navLink}
              >
                {c.title}
              </Link>
            ))}
            {collectionsTotal > collections.length && (
              <Link to="/collections" className={navLink}>
                All collections
              </Link>
            )}
            <Link to="/blog" className={navLink}>
              Journal
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-0.5">
            <Button asChild variant="ghost" size="icon" className="hover:bg-zinc-100">
              <Link to="/search" search={{ q: '' }} aria-label="Search">
                <SearchIcon className="size-5" />
              </Link>
            </Button>
            <Button asChild variant="ghost" size="icon" className="hover:bg-zinc-100">
              <Link to="/account" aria-label="Account">
                <UserIcon className="size-5" />
              </Link>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={openCart}
              aria-label="Open cart"
              className="relative hover:bg-zinc-100"
            >
              <BagIcon className="size-5" />
              <CartCount />
            </Button>
          </div>
        </div>
      </header>

      <div id="main-content" className="mx-auto w-full max-w-7xl flex-1 px-4 sm:px-6 lg:px-8">
        <Outlet />
      </div>

      <CartDrawer
        initial={{ cartId: null, cartRevision: null, lines: [], zones: [], count: 0, limits }}
      />
      <footer className="mt-24 border-t border-zinc-100 bg-white">
        <div className="mx-auto grid w-full max-w-7xl gap-10 px-4 py-14 sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:px-8">
          <div>
            <p className="text-base font-normal tracking-tight text-zinc-950">{storeName}</p>
            <p className="mt-3 max-w-xs text-sm leading-6 text-zinc-400">
              Considered goods, honest prices, and shipping you can track from our door to yours.
            </p>
          </div>
          <nav aria-label="Shop">
            <p className="text-sm font-medium text-zinc-950">Shop</p>
            <ul className="mt-4 space-y-2.5 text-sm text-zinc-500">
              <li>
                <Link to="/shop" className="hover:text-zinc-950">
                  Shop all
                </Link>
              </li>
              {collections.map((c) => (
                <li key={c.slug}>
                  <Link
                    to="/collections/$slug"
                    params={{ slug: c.slug }}
                    className="hover:text-zinc-950"
                  >
                    {c.title}
                  </Link>
                </li>
              ))}
              <li>
                <Link to="/blog" className="hover:text-zinc-950">
                  Journal
                </Link>
              </li>
            </ul>
          </nav>
          <nav aria-label="Support">
            <p className="text-sm font-medium text-zinc-950">Support</p>
            <ul className="mt-4 space-y-2.5 text-sm text-zinc-500">
              <li>
                <Link
                  to="/pages/$slug"
                  params={{ slug: 'shipping' }}
                  className="hover:text-zinc-950"
                >
                  Shipping
                </Link>
              </li>
              <li>
                <Link
                  to="/pages/$slug"
                  params={{ slug: 'returns' }}
                  className="hover:text-zinc-950"
                >
                  Returns
                </Link>
              </li>
              <li>
                <Link to="/account" className="hover:text-zinc-950">
                  Track your order
                </Link>
              </li>
              <li>
                <Link to="/search" search={{ q: '' }} className="hover:text-zinc-950">
                  Search
                </Link>
              </li>
            </ul>
          </nav>
          <nav aria-label="Company">
            <p className="text-sm font-medium text-zinc-950">Company</p>
            <ul className="mt-4 space-y-2.5 text-sm text-zinc-500">
              <li>
                <Link
                  to="/pages/$slug"
                  params={{ slug: 'privacy' }}
                  className="hover:text-zinc-950"
                >
                  Privacy policy
                </Link>
              </li>
              <li>
                <Link to="/pages/$slug" params={{ slug: 'terms' }} className="hover:text-zinc-950">
                  Terms of service
                </Link>
              </li>
              <li>
                <Link to="/admin" className="hover:text-zinc-950">
                  Store admin
                </Link>
              </li>
            </ul>
          </nav>
        </div>
        <div className="border-t border-zinc-200">
          <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-2 px-4 py-5 text-[13px] text-zinc-400 sm:px-6 lg:px-8">
            <span>
              © {new Date().getFullYear()} {storeName}. All rights reserved.
            </span>
            <span className="ml-auto">Secure checkout powered by Stripe</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
