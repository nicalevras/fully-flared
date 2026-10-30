import { useMemo, useState } from 'react';
import { useStoreCurrency } from '../lib/use-store-currency';
import { Link, createFileRoute } from '@tanstack/react-router';
import { formatMoney } from '../lib/format';
import { mediaUrl } from '../lib/media-url';
import {
  nextQtyOnIncrement,
  rateCost,
  ratePriceLabel,
  useServerCart,
  zoneForCountry,
} from '../lib/cart';
import { getCart } from '../lib/cartFns';
import { countryName, shippableCountries } from '../lib/cart-destination';
import { BagIcon, ShieldIcon } from '../components/icons';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_shop/cart')({
  loader: async () => getCart(),
  head: () => ({ meta: [{ title: 'Cart' }, { name: 'robots', content: 'noindex' }] }),
  component: CartPage,
});

function CartPage() {
  const currency = useStoreCurrency();
  const initial = Route.useLoaderData();
  const { lines, zones, view, setQty, pending, error } = useServerCart(initial);
  const countries = useMemo(() => shippableCountries(zones), [zones]);
  const [chosenCountry, setCountry] = useState<string | null>(null);
  const country = chosenCountry ?? countries[0] ?? '';
  const [rateId, setRateId] = useState('');

  const zone = useMemo(() => zoneForCountry(zones, country), [zones, country]);
  const rate = zone?.rates.find((r) => r.id === rateId) ?? zone?.rates[0];
  const subtotal = lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
  const totalWeight = lines.reduce((s, l) => s + (l.weightGrams ?? 0) * l.qty, 0);
  const shipping = rate ? rateCost(rate, subtotal, totalWeight) : 0;
  const total = subtotal + shipping;
  const freeOver = rate?.kind === 'free_over' ? rate.freeOverCents : null;
  const awayFromFree = freeOver != null ? Math.max(freeOver - subtotal, 0) : null;
  const itemCount = lines.reduce((n, l) => n + l.qty, 0);

  if (lines.length === 0) {
    return (
      <main className="py-14 lg:py-20">
        <div className="mx-auto max-w-md text-center" role="status">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-zinc-100">
            <BagIcon className="h-6 w-6 text-zinc-500" />
          </span>
          <h1 className="mt-5 text-2xl font-medium tracking-tight text-zinc-950">
            Your cart is empty
          </h1>
          <p className="mt-2 text-sm leading-6 text-zinc-500">
            When you add products, they will appear here with live prices and stock.
          </p>
          <Link to="/" className={cn(buttonVariants({ size: 'lg' }), 'mt-6')}>
            Start shopping
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="py-10 lg:py-14">
      <h1 className="text-3xl font-normal tracking-tight text-zinc-950">
        Your cart{' '}
        <span className="text-lg font-normal text-zinc-400">
          ({itemCount} item{itemCount === 1 ? '' : 's'})
        </span>
      </h1>

      {error ? (
        <Alert variant="destructive" role="alert" className="mt-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-8 grid items-start gap-10 lg:grid-cols-[1fr_400px]">
        <section aria-label="Items">
          <ul className="divide-y divide-zinc-200 border-y border-zinc-200">
            {lines.map((l) => (
              <li key={l.sku} className="flex gap-4 py-5">
                <span
                  className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-2xl font-light text-zinc-400 select-none"
                  aria-hidden
                >
                  {l.cover ? (
                    <img
                      src={mediaUrl(l.cover, 320)}
                      alt=""
                      className="h-full w-full rounded-xl object-cover"
                    />
                  ) : (
                    l.productTitle.slice(0, 1).toUpperCase()
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-zinc-950">{l.productTitle}</p>
                      <p className="mt-0.5 text-[13px] text-zinc-500">
                        {l.sku} · {l.available} available
                      </p>
                    </div>
                    <p className="text-sm font-medium whitespace-nowrap text-zinc-950">
                      {formatMoney(l.priceCents * l.qty, currency)}
                    </p>
                  </div>
                  <div className="mt-3 flex items-center gap-4">
                    <span className="inline-flex items-center rounded-full border border-zinc-300">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="h-[28px] w-[33px] text-zinc-600 hover:text-zinc-950"
                        disabled={pending}
                        aria-label={`Decrease quantity for ${l.productTitle}`}
                        onClick={() => void setQty(l.sku, l.qty - 1)}
                      >
                        <span className="text-base leading-none" aria-hidden>
                          −
                        </span>
                      </Button>
                      <span className="w-7 text-center text-sm font-medium" aria-live="polite">
                        {l.qty}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="h-[28px] w-[33px] text-zinc-600 hover:text-zinc-950"
                        disabled={pending}
                        aria-label={`Increase quantity for ${l.productTitle}`}
                        onClick={() =>
                          void setQty(l.sku, nextQtyOnIncrement(l.qty, view.limits.cart_max_qty))
                        }
                      >
                        <span className="text-base leading-none" aria-hidden>
                          +
                        </span>
                      </Button>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      className="text-zinc-500 hover:text-red-600"
                      onClick={() => void setQty(l.sku, 0)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <Link
            to="/"
            className="mt-5 inline-block text-sm font-medium text-zinc-950 underline underline-offset-4"
          >
            Continue shopping
          </Link>
          <p className="mt-6 text-[13px] leading-5 text-zinc-400">
            Prices, stock, discounts, and shipping are recomputed securely on the server when you
            check out. Inventory is allocated after payment authorization when you pay.
          </p>
        </section>

        <Card className="p-6 lg:sticky lg:top-24" aria-label="Order summary">
          <h2 className="text-base font-medium text-zinc-950">Order summary</h2>

          {awayFromFree != null && awayFromFree > 0 ? (
            <div className="mt-4">
              <p className="text-[13px] text-zinc-500">
                You are{' '}
                <strong className="text-zinc-950">{formatMoney(awayFromFree, currency)}</strong>{' '}
                away from free shipping
              </p>
              <Progress
                className="mt-2"
                value={Math.min(100, (subtotal / (freeOver ?? 1)) * 100)}
                aria-label="Progress to free shipping"
              />
            </div>
          ) : freeOver != null ? (
            <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-[13px] font-medium text-green-700">
              Your order ships free.
            </p>
          ) : null}

          <div className="mt-5 space-y-4">
            <div>
              <Label htmlFor="co-country">Country</Label>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger id="co-country" className="mt-1.5 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {countries.map((c) => (
                    <SelectItem key={c} value={c}>
                      {countryName(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {zone ? (
            <fieldset className="mt-5">
              <legend className="text-sm font-medium text-zinc-900">Delivery — {zone.name}</legend>
              <ToggleGroup
                type="single"
                variant="outline"
                value={rate?.id ?? ''}
                onValueChange={(value) => {
                  if (value) setRateId(value);
                }}
                className="mt-2.5 flex flex-col items-stretch gap-2"
                aria-label="Delivery options"
              >
                {zone.rates.map((r) => (
                  <ToggleGroupItem
                    key={r.id}
                    value={r.id}
                    className="flex h-auto w-full items-center justify-between px-3.5 py-3"
                  >
                    <span>{r.name}</span>
                    <span className="font-medium">
                      {ratePriceLabel(r, subtotal, totalWeight, currency)}
                    </span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </fieldset>
          ) : zones.length === 0 ? (
            <p className="mt-5 text-[13px] leading-5 text-zinc-500">
              Shipping is not configured. Checkout requires an explicit rate, including a $0 rate
              for free shipping. The store owner can add zones in Admin → Shipping.
            </p>
          ) : (
            <p className="mt-5 text-[13px] leading-5 text-zinc-500">
              Delivery is not available to {countryName(country)}. Choose a supported destination to
              see delivery options and totals.
            </p>
          )}

          <p className="mt-5 text-[13px] leading-5 text-zinc-500">
            Discount codes are applied at checkout.
          </p>

          <dl className="mt-6 space-y-2.5 border-t border-zinc-200 pt-5 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-500">Subtotal</dt>
              <dd className="font-medium text-zinc-950">{formatMoney(subtotal, currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Shipping</dt>
              <dd className="font-medium text-zinc-950">
                {rate ? (shipping === 0 ? 'Free' : formatMoney(shipping, currency)) : 'Unavailable'}
              </dd>
            </div>
            <div className="flex justify-between border-t border-zinc-200 pt-3.5 text-base font-medium text-zinc-950">
              <dt>Total</dt>
              <dd>{formatMoney(total, currency)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-[13px] text-zinc-400">
            Taxes calculated at checkout when enabled. Shipping address is collected securely by
            Stripe.
          </p>

          <Link to="/checkout" className={cn(buttonVariants({ size: 'lg' }), 'mt-5 h-12 w-full')}>
            Check out
          </Link>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[13px] text-zinc-400">
            <ShieldIcon className="h-4 w-4" /> Secure checkout powered by Stripe
          </p>
        </Card>
      </div>
    </main>
  );
}
