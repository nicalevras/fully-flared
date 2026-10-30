import { useEffect, useState } from 'react';
import { useStoreCurrency } from '../lib/use-store-currency';
import { Link } from '@tanstack/react-router';
import { formatMoney } from '../lib/format';
import { mediaUrl } from '../lib/media-url';
import { BagIcon } from './icons';
import { XIcon } from 'lucide-react';
import { nextQtyOnIncrement, useServerCart, zoneForCountry, type CartView } from '../lib/cart';
import { useCartDestination } from '../lib/cart-destination';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';

export function CartDrawer({ initial }: { initial: CartView }) {
  const currency = useStoreCurrency();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(initial.lines.length > 0);
  const { pending, error, view, lines, setQty, refresh } = useServerCart(initial);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('cart-open', onOpen);
    return () => window.removeEventListener('cart-open', onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Refresh once on open (the loader seed already rendered real lines, so
    // this never flashes an empty cart). Focus, Escape-to-close, focus
    // return and scroll locking are owned by the Drawer primitive.
    void refresh().finally(() => setLoaded(true));
  }, [open, refresh]);

  const subtotal = lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
  const itemCount = lines.reduce((n, l) => n + l.qty, 0);
  const { country } = useCartDestination(view.zones);
  const rate = zoneForCountry(view.zones, country)?.rates[0];
  const freeOver = rate?.kind === 'free_over' ? rate.freeOverCents : null;
  const awayFromFree = freeOver != null ? Math.max(freeOver - subtotal, 0) : null;

  return (
    <Drawer swipeDirection="right" open={open} onOpenChange={setOpen}>
      <DrawerContent
        className="w-full max-w-[calc(100vw-1rem)] gap-0 p-0 sm:max-w-md"
        aria-label="Cart"
      >
        <DrawerClose
          render={
            <Button type="button" variant="ghost" size="icon-sm" className="absolute top-3 right-3">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          }
        />
        <DrawerHeader className="px-6 py-5">
          <DrawerTitle className="text-base">
            Your cart
            {lines.length > 0 ? <span className="text-zinc-400"> ({itemCount})</span> : null}
          </DrawerTitle>
        </DrawerHeader>

        {error ? (
          <div className="px-6 pb-2">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        {!loaded && lines.length === 0 ? (
          <div
            className="flex flex-1 flex-col gap-5 px-6 py-5"
            role="status"
            aria-label="Loading cart"
          >
            {[0, 1].map((i) => (
              <div key={i} className="flex gap-4">
                <Skeleton className="h-20 w-16 shrink-0 rounded-lg" />
                <span className="flex flex-1 flex-col gap-2 py-1">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </span>
              </div>
            ))}
          </div>
        ) : lines.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <BagIcon className="h-8 w-8 text-zinc-300" />
            <p className="mt-4 text-sm font-medium text-zinc-950">Your cart is empty</p>
            <p className="mt-1 max-w-60 text-sm leading-6 text-zinc-500">
              Add something you will use every day.
            </p>
            <Button className="mt-6" onClick={() => setOpen(false)}>
              Continue shopping
            </Button>
          </div>
        ) : (
          <>
            {awayFromFree != null && awayFromFree > 0 ? (
              <div className="px-6 pb-2">
                <p className="text-[13px] text-zinc-500">
                  You are{' '}
                  <span className="font-medium text-zinc-950">
                    {formatMoney(awayFromFree, currency)}
                  </span>{' '}
                  away from free shipping
                </p>
                <Progress
                  className="mt-2"
                  value={Math.min(100, (subtotal / (freeOver ?? 1)) * 100)}
                  aria-label="Progress to free shipping"
                />
              </div>
            ) : freeOver != null ? (
              <p className="px-6 pb-2 text-[13px] font-medium text-green-700">
                Your order ships free
              </p>
            ) : null}

            <ul className="flex-1 divide-y divide-zinc-100 overflow-y-auto px-6">
              {lines.map((l) => (
                <li key={l.sku} className="flex gap-4 py-5">
                  <span
                    className="flex h-20 w-16 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-xl font-light text-zinc-400 select-none"
                    aria-hidden
                  >
                    {l.cover ? (
                      <img
                        src={mediaUrl(l.cover, 320)}
                        alt=""
                        className="h-full w-full rounded-lg object-cover"
                      />
                    ) : (
                      l.productTitle.slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-normal text-zinc-950">{l.productTitle}</p>
                      <p className="text-sm whitespace-nowrap text-zinc-950">
                        {formatMoney(l.priceCents * l.qty, currency)}
                      </p>
                    </div>
                    <p className="mt-0.5 text-[13px] text-zinc-400">{l.sku}</p>
                    <div className="mt-3 flex items-center gap-4">
                      <span className="inline-flex items-center rounded-full border border-zinc-200">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="h-[24px] w-[29px] text-zinc-500 hover:text-zinc-950"
                          disabled={pending}
                          aria-label={`Decrease quantity for ${l.productTitle}`}
                          onClick={() => void setQty(l.sku, l.qty - 1)}
                        >
                          <span className="text-base leading-none" aria-hidden>
                            −
                          </span>
                        </Button>
                        <span className="w-6 text-center text-[13px]" aria-live="polite">
                          {l.qty}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="h-[24px] w-[29px] text-zinc-500 hover:text-zinc-950"
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
                        className="h-auto p-0 text-[13px] leading-5 font-normal text-zinc-400 hover:text-zinc-950"
                        onClick={() => void setQty(l.sku, 0)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <Separator />
            <DrawerFooter className="px-6 py-5">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-medium text-zinc-950">Subtotal</span>
                <span className="text-base font-medium text-zinc-950">
                  {formatMoney(subtotal, currency)}
                </span>
              </div>
              <p className="text-[13px] text-zinc-400">
                Shipping and taxes calculated at checkout.
              </p>
              <Button asChild size="lg" className="mt-2 w-full">
                <Link to="/checkout" onClick={() => setOpen(false)}>
                  Check out
                </Link>
              </Button>
              <Button asChild variant="ghost" className="w-full">
                <Link to="/cart" onClick={() => setOpen(false)}>
                  View cart
                </Link>
              </Button>
            </DrawerFooter>
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}
