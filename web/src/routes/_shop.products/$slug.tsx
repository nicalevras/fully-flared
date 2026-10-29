import { useAvailability, purchaseAvailability } from '../../lib/availability';
import { useState } from 'react';
import { useStoreCurrency } from '../../lib/use-store-currency';
import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseStatus } from '@tanstack/react-start/server';
import { validateServerInput } from '../../server/function-boundary';
import { loadProductPage } from '../../server/storefront-pages';
import { requestCanonicalBase } from '../../server/canonical-base';
import { storefrontLimited } from '../../server/storefront-limit';
import { slugParamSchema } from '../../schemas/checkout';
import { formatMoney } from '../../components/ProductCard';
import { absoluteUrl, jsonLd, seoMeta } from '../../lib/seo';
import { CheckIcon, ReturnIcon, ShieldIcon, TruckIcon } from '../../components/icons';
import { ProductNotFound } from '../../components/NotFound';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { addToCart, openCart } from '../../lib/cart';
import type { StoreLimits } from '../../lib/settings-definitions';
import { mediaUrl, mediaSrcSet, type MediaSource } from '../../lib/media-url';

type Variant = {
  id: string;
  sku: string;
  title: string;
  priceCents: number;
  compareAtCents: number | null;
  status: string;
  continueSelling: boolean;
  weightGrams: number | null;
};
type ProductDetail = {
  limits: StoreLimits;
  id: string;
  slug: string;
  title: string;
  description: string;
  seoTitle: string | null;
  seoDescription: string | null;
  variants: Variant[];
  images: Array<MediaSource & { alt: string }>;
  storeName: string;
  seoTitleTemplate: string;
  canonicalBaseUrl: string;
  currency: string;
};

const getProduct = createServerFn({ method: 'GET' })
  .validator(validateServerInput(slugParamSchema))
  .handler(async ({ data: slug }): Promise<ProductDetail> => {
    const { env } = await import('cloudflare:workers');
    const { layout, doc } = await loadProductPage(env.DB, env, slug, async () => {
      if (await storefrontLimited(env.STOREFRONT_LIMITER, 'product', getRequest())) {
        setResponseStatus(429);
        throw notFound();
      }
    });
    return {
      ...doc,
      limits: layout.limits,
      storeName: layout.storeName,
      seoTitleTemplate: layout.seoTitleTemplate,
      canonicalBaseUrl: requestCanonicalBase(layout.canonicalBaseUrl),
      currency: layout.currency,
    };
  });

export const Route = createFileRoute('/_shop/products/$slug')({
  loader: async ({ params }) => getProduct({ data: params.slug }),
  staleTime: 20_000,
  notFoundComponent: ProductNotFound,
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: 'Store' }] };
    const url = absoluteUrl(loaderData.canonicalBaseUrl, `/products/${loaderData.slug}`);
    const firstImage = loaderData.images[0];
    const firstVariant = loaderData.variants.find((v) => v.status === 'active');
    return {
      meta: seoMeta({
        title:
          loaderData.seoTitle ??
          loaderData.seoTitleTemplate
            .replaceAll('{product}', loaderData.title)
            .replaceAll('{title}', loaderData.title)
            .replaceAll('{store_name}', loaderData.storeName),
        description: loaderData.seoDescription ?? loaderData.description,
        url,
        type: 'product',
        image: firstImage
          ? absoluteUrl(loaderData.canonicalBaseUrl, mediaUrl(firstImage))
          : undefined,
      }),
      links: [{ rel: 'canonical', href: url }],
      ...jsonLd({
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: loaderData.title,
        description: loaderData.seoDescription ?? loaderData.description,
        url,
        ...(firstImage
          ? { image: absoluteUrl(loaderData.canonicalBaseUrl, mediaUrl(firstImage)) }
          : {}),
        ...(firstVariant
          ? {
              offers: {
                '@type': 'Offer',
                url,
                priceCurrency: loaderData.currency,
                price: (firstVariant.priceCents / 100).toFixed(2),
              },
            }
          : {}),
      }),
    };
  },
  component: ProductPage,
});

function ProductPage() {
  const currency = useStoreCurrency();
  const product = Route.useLoaderData();
  const availability = useAvailability([product.id], 'product', product.slug)[product.id];
  const activeVariants = product.variants.filter((v) => v.status === 'active');
  const [selectedSku, setSelectedSku] = useState(activeVariants[0]?.sku ?? '');
  const [imageIdx, setImageIdx] = useState(0);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [cartError, setCartError] = useState('');
  const selected = activeVariants.find((v) => v.sku === selectedSku) ?? activeVariants[0];
  const purchase = purchaseAvailability(selected?.sku, product.limits.cart_max_qty, availability);
  const chosenQty = Math.max(1, Math.min(qty, purchase.maxQty));
  const onSale = selected?.compareAtCents != null && selected.compareAtCents > selected.priceCents;

  return (
    <main className="py-8 lg:py-12">
      <nav aria-label="Breadcrumb" className="pb-8 text-[13px] text-zinc-500">
        <Link to="/" className="hover:text-zinc-950">
          Home
        </Link>
        <span className="mx-1.5 text-zinc-300">/</span>
        <span className="text-zinc-950">{product.title}</span>
      </nav>

      <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <div className="relative flex aspect-[4/5] items-center justify-center overflow-hidden rounded-2xl bg-zinc-100">
            {product.images.length > 0 ? (
              <img
                src={
                  product.images[imageIdx] ? mediaUrl(product.images[imageIdx]!, 960) : undefined
                }
                srcSet={
                  product.images[imageIdx] ? mediaSrcSet(product.images[imageIdx]!) : undefined
                }
                sizes="(max-width: 1024px) 100vw, 50vw"
                alt={product.images[imageIdx]?.alt || product.title}
                className="h-full w-full object-cover"
              />
            ) : (
              <span
                className="text-[160px] leading-none font-light text-zinc-200 select-none"
                aria-hidden
              >
                {product.title.slice(0, 1).toUpperCase()}
              </span>
            )}
            {onSale ? (
              <span className="absolute top-4 left-4">
                <Badge variant="destructive">Sale</Badge>
              </span>
            ) : null}
          </div>
          {product.images.length > 1 ? (
            <ToggleGroup
              type="single"
              value={String(imageIdx)}
              onValueChange={(value) => {
                if (value) setImageIdx(Number(value));
              }}
              className="mt-3 flex gap-2"
              aria-label="Product images"
            >
              {product.images.map((image, i) => (
                <ToggleGroupItem
                  key={image.key}
                  value={String(i)}
                  aria-label={`View image ${i + 1}`}
                  className={`h-16 w-16 overflow-hidden rounded-lg p-0 ${imageIdx === i ? 'ring-2 ring-zinc-950 ring-offset-2' : 'opacity-70 hover:opacity-100'}`}
                >
                  <img src={mediaUrl(image)} alt="" className="h-full w-full object-cover" />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
        </div>

        <section>
          <h1 className="text-3xl font-normal tracking-tight text-zinc-950">{product.title}</h1>
          {selected ? (
            <p className="mt-3 flex flex-wrap items-baseline gap-2.5">
              <span className="text-xl font-normal text-zinc-950">
                {formatMoney(selected.priceCents, currency)}
              </span>
              {onSale ? (
                <span className="text-zinc-400 line-through">
                  {formatMoney(selected.compareAtCents!, currency)}
                </span>
              ) : null}
              {onSale ? (
                <Badge variant="destructive">
                  Save {formatMoney(selected.compareAtCents! - selected.priceCents, currency)}
                </Badge>
              ) : null}
            </p>
          ) : null}
          {product.description ? (
            <p className="mt-4 leading-7 whitespace-pre-wrap text-zinc-600">
              {product.description}
            </p>
          ) : null}

          {activeVariants.length > 1 ? (
            <fieldset className="mt-7">
              <legend className="text-sm font-medium text-zinc-950">
                Options
                {selected ? (
                  <span className="font-normal text-zinc-500"> — {selected.title}</span>
                ) : null}
              </legend>
              <ToggleGroup
                type="single"
                variant="outline"
                value={selected?.sku ?? ''}
                onValueChange={(value) => {
                  if (value) setSelectedSku(value);
                }}
                className="mt-2.5 flex flex-wrap justify-start gap-2"
                aria-label="Options"
              >
                {activeVariants.map((v) => (
                  <ToggleGroupItem key={v.sku} value={v.sku} className="rounded-full px-4">
                    {v.title}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </fieldset>
          ) : null}

          {!availability ? <Skeleton className="mt-6 h-5 w-44" aria-hidden /> : null}
          {availability ? (
            <p className="mt-6 flex items-center gap-2 text-sm" role="status">
              {purchase.variant?.available != null && purchase.variant.available > 0
                ? purchase.variant.available <= 5
                  ? `Only ${purchase.variant.available} left in stock`
                  : 'In stock, ready to ship'
                : purchase.buyable
                  ? 'Available on backorder'
                  : 'Out of stock'}
            </p>
          ) : null}

          <div className="mt-5 flex items-stretch gap-3">
            <div className="flex items-center rounded-full border border-zinc-300">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-[42px] w-[38px] text-zinc-600 hover:text-zinc-950"
                aria-label="Decrease quantity"
                onClick={() => setQty(Math.max(1, chosenQty - 1))}
              >
                <span className="text-lg leading-none" aria-hidden>
                  −
                </span>
              </Button>
              <span className="w-8 text-center text-sm font-medium" aria-live="polite">
                {chosenQty}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-[42px] w-[38px] text-zinc-600 hover:text-zinc-950"
                aria-label="Increase quantity"
                disabled={!purchase.buyable || chosenQty >= purchase.maxQty}
                onClick={() => setQty(Math.min(purchase.maxQty, chosenQty + 1))}
              >
                <span className="text-lg leading-none" aria-hidden>
                  +
                </span>
              </Button>
            </div>
            <Button
              size="lg"
              className="h-12 flex-1"
              disabled={adding || !purchase.buyable}
              onClick={async () => {
                if (!selected) return;
                setAdding(true);
                setCartError('');
                try {
                  await addToCart(selected.sku, chosenQty);
                  setAdded(true);
                  openCart();
                  setTimeout(() => setAdded(false), 1500);
                } catch {
                  setCartError('Could not add this item. Please try again.');
                } finally {
                  setAdding(false);
                }
              }}
            >
              {adding
                ? 'Adding…'
                : added
                  ? 'Added to cart'
                  : purchase.buyable
                    ? purchase.variant?.available === 0 && purchase.variant.continueSelling
                      ? 'Backorder'
                      : 'Add to cart'
                    : 'Sold out'}
            </Button>
          </div>
          {added ? (
            <p className="mt-3 text-sm text-green-700" role="status">
              Added to your cart.
            </p>
          ) : null}

          {cartError ? (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{cartError}</AlertDescription>
            </Alert>
          ) : null}
          <ul className="mt-8 space-y-3.5 border-t border-zinc-200 pt-6 text-sm leading-6 text-zinc-500">
            <li className="flex gap-2.5">
              <TruckIcon className="h-5 w-5 shrink-0 text-zinc-950" /> Ships within 1–2 business
              days. Rates and delivery options are calculated at checkout by your shipping zone.
            </li>
            <li className="flex gap-2.5">
              <ReturnIcon className="h-5 w-5 shrink-0 text-zinc-950" /> 30-day returns. Start a
              return from your account page after delivery.
            </li>
            <li className="flex gap-2.5">
              <ShieldIcon className="h-5 w-5 shrink-0 text-zinc-950" /> Secure checkout via Stripe.
              Opening checkout does not reserve inventory. Stock is allocated after payment
              authorization.
            </li>
            <li className="flex gap-2.5">
              <CheckIcon className="h-5 w-5 shrink-0 text-zinc-950" /> SKU {selected?.sku ?? '-'} ·
              Track your order any time from{' '}
              <Link to="/account" className="text-zinc-950 underline underline-offset-2">
                your account
              </Link>
              .
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}
