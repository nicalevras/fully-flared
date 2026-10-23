import { useEffect, useMemo, useRef, useState } from 'react';
import { useStoreCurrency } from '../../lib/use-store-currency';
import { Link, createFileRoute } from '@tanstack/react-router';
import { checkoutQuoteFn } from '../../lib/shopFns';
import { validateServerInput } from '../../server/function-boundary';
import { confirmCheckoutFn } from '../../lib/checkoutFns';
import type { ReviewQuote } from '../../server/authorized-checkout';
import { createServerFn, useServerFn } from '@tanstack/react-start';
import * as z from 'zod';
import { formatMoney } from '../../components/ProductCard';
import { ShieldIcon } from '../../components/icons';
import { TurnstileWidget } from '../../components/TurnstileWidget';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { rateCost, useServerCart } from '../../lib/cart';
import { getCart } from '../../lib/cartFns';
import { checkoutStorage, resetCheckoutIntent } from '../../lib/checkout-intent';
import { getRequest } from '@tanstack/react-start/server';
import { getSessionUser } from '../../server/session';
import { getSettings } from '../../server/settings';

const getCheckoutConfig = createServerFn({ method: 'GET' })
  .validator(validateServerInput(z.object({})))
  .handler(async () => {
    const { env } = await import('cloudflare:workers');
    const settings = await getSettings(env.DB);
    return {
      turnstileSiteKey: settings.turnstileSiteKey,
      authenticated: Boolean(await getSessionUser(env.DB, getRequest())),
    };
  });

export const Route = createFileRoute('/checkout/')({
  loader: async () => {
    const [config, cart] = await Promise.all([getCheckoutConfig({ data: {} }), getCart()]);
    return { ...config, cart };
  },
  head: () => ({ meta: [{ title: 'Checkout' }, { name: 'robots', content: 'noindex' }] }),
  component: CheckoutPage,
});

function CheckoutPage() {
  const storeCurrency = useStoreCurrency();
  const { turnstileSiteKey, cart: initialCart, authenticated } = Route.useLoaderData();
  const { view: cart, refresh: refreshCart } = useServerCart(initialCart);
  const lines = cart.lines;
  const zones = cart.zones;
  const loaded = true;
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileResetRef = useRef<(() => void) | null>(null);
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState('US');
  const [rateId, setRateId] = useState('');
  const [code, setCode] = useState('');
  const [appliedCode, setAppliedCode] = useState('');
  const [discountAmount, setDiscountAmount] = useState(0);
  const [discountMsg, setDiscountMsg] = useState('');
  const [applyingCode, setApplyingCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState({
    name: '',
    line1: '',
    line2: '',
    city: '',
    state: '',
    postalCode: '',
    phone: '',
  });
  const shippingAddress = useMemo(() => ({ ...address, country }), [address, country]);
  const [review, setReview] = useState<{
    intentId: string;
    quoteHash: string;
    quote: ReviewQuote;
  } | null>(null);
  const [reminderConsent, setReminderConsent] = useState(false);
  const confirmFn = useServerFn(confirmCheckoutFn);
  const pendingRequest = useRef<AbortController | null>(null);
  const detailsRef = useRef('');
  detailsRef.current = JSON.stringify({
    cartId: cart.cartId,
    cartRevision: cart.cartRevision,
    email,
    shippingAddress,
    rateId,
    appliedCode,
    lines,
    reminderConsent,
  });
  useEffect(() => () => pendingRequest.current?.abort(), []);
  useEffect(() => {
    setReview(null);
  }, [email, country, rateId, appliedCode, address, lines, reminderConsent]);

  const zone = useMemo(() => zones.find((z) => z.countries.includes(country)), [zones, country]);
  const rate = zone?.rates.find((r) => r.id === rateId) ?? zone?.rates[0];
  const subtotal = lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
  const shipping = rate
    ? rateCost(
        rate,
        subtotal - discountAmount,
        lines.reduce((s, l) => s + (l.weightGrams ?? 0) * l.qty, 0)
      )
    : 0;
  const localTotal = Math.max(subtotal - discountAmount, 0) + shipping;
  const quoteFn = useServerFn(checkoutQuoteFn);
  const [quote, setQuote] = useState<Awaited<ReturnType<typeof checkoutQuoteFn>> | null>(null);
  const currency = review?.quote.currency ?? quote?.currency ?? storeCurrency;
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [quoteError, setQuoteError] = useState('');
  const [quoting, setQuoting] = useState(false);
  useEffect(() => {
    setQuote(null);
    setQuoteError('');
    if (!email.includes('@') || !rate) return;
    const controller = new AbortController();
    setQuoting(true);
    const timer = setTimeout(() => {
      void quoteFn({
        data: {
          email,
          lines: lines.map((l) => ({ sku: l.sku, qty: l.qty })),
          shippingCountry: country,
          shippingRateId: rate.id,
          ...(appliedCode ? { discountCode: appliedCode } : {}),
        },
        signal: controller.signal,
      })
        .then((value) => {
          if (!controller.signal.aborted) setQuote(value);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setQuoteError(
              'We could not quote this order. Check your shipping selection and try again.'
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setQuoting(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [email, country, rate?.id, appliedCode, lines, quoteFn, quoteNonce]);
  const total = review?.quote.totalCents ?? quote?.totalCents ?? localTotal;

  async function applyCode() {
    setApplyingCode(true);
    try {
      const { validateDiscountFn } = await import('../../lib/shopFns');
      const data = await validateDiscountFn({ data: { code, subtotalCents: subtotal } });
      if (data.valid) {
        setDiscountAmount(data.amountCents ?? 0);
        setAppliedCode(code.toUpperCase());
        setDiscountMsg(`You save ${formatMoney(data.amountCents ?? 0, currency)}.`);
      } else {
        setDiscountAmount(0);
        setAppliedCode('');
        setDiscountMsg(data.error ?? 'That code is not valid for this order.');
      }
    } catch {
      setDiscountMsg('We could not check that code right now. Your cart is unchanged.');
    } finally {
      setApplyingCode(false);
    }
  }

  async function pay() {
    const controller = new AbortController();
    pendingRequest.current = controller;
    const submittedDetails = detailsRef.current;
    setBusy(true);
    setError('');
    try {
      const {
        checkoutInputKey,
        checkoutStorage,
        classifyCheckoutResponse,
        ensureGuestBootstrap,
        getCheckoutIntent,
        resetCheckoutIntent,
      } = await import('../../lib/checkout-intent');
      const confirmed = quote
        ? {
            quoteRevision: quote.configRevision,
            confirmedQuote: {
              subtotalCents: quote.subtotalCents,
              discountCents: quote.discountCents,
              shippingCents: quote.shippingCents,
              totalCents: quote.totalCents,
            },
          }
        : {};
      const inputKey = await checkoutInputKey({
        ...confirmed,
        cartId: cart.cartId ?? '',
        cartRevision: cart.cartRevision ?? 0,
        email,
        lines: lines.map((l) => ({ sku: l.sku, qty: l.qty })),
        shippingCountry: country,
        shippingRateId: rate?.id ?? '',
        discountCode: appliedCode || undefined,
        shippingAddress,
        reminderConsent,
      });
      const { intentId } = getCheckoutIntent(checkoutStorage(), inputKey);
      // Guest ownership is established before any commerce state: the
      // capability cookie is minted by the bootstrap endpoint under an
      // exclusive Web Lock held across the round-trip, so initially
      // empty tabs share one capability instead of racing mints. No
      // Web Locks means no safe serialization — fail closed here,
      // before the checkout request creates anything.
      const locks =
        typeof navigator !== 'undefined' && 'locks' in navigator
          ? (navigator.locks as unknown as Parameters<typeof ensureGuestBootstrap>[0])
          : undefined;
      const bootstrapped =
        authenticated ||
        (await ensureGuestBootstrap(locks, async () => {
          const res = await fetch('/api/checkout/guest-session', { method: 'POST' });
          if (!res.ok) throw new Error('guest bootstrap failed');
        }));
      if (!bootstrapped) {
        setError(
          'Checkout needs a browser with tab coordination (Web Locks). Try a current browser; nothing was ordered.'
        );
        return;
      }
      const res = await fetch('/api/checkout', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intentId,
          cartId: cart.cartId,
          cartRevision: cart.cartRevision,
          ...confirmed,
          email,
          lines: lines.map((l) => ({ sku: l.sku, qty: l.qty })),
          // Only the confirmed (applied) code is submitted — never the
          // unapplied text in the coupon box, which could change the
          // total away from the displayed quote.
          discountCode: appliedCode || undefined,
          shippingRateId: rate?.id,
          shippingCountry: country,
          shippingAddress,
          reminderConsent,
          turnstileToken: turnstileToken || undefined,
        }),
      });
      const data = (await res.json()) as {
        checkoutUrl?: string;
        state?: string;
        error?: string;
        code?: string;
        orderId?: string;
        orderUrl?: string;
        intentId?: string;
        quoteHash?: string;
        quote?: ReviewQuote;
      };
      if (controller.signal.aborted) return;
      if (submittedDetails !== detailsRef.current) {
        setError('Checkout details changed. Prepare a fresh review.');
        return;
      }
      if (
        res.ok &&
        data.state === 'review_ready' &&
        data.intentId &&
        data.quoteHash &&
        data.quote
      ) {
        setReview({ intentId: data.intentId, quoteHash: data.quoteHash, quote: data.quote });
        return;
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        setError(
          `Checkout is busy. ${retryAfter > 0 ? `Try again in ${retryAfter} seconds.` : 'Please retry shortly.'}`
        );
        return;
      }
      if (data.code === 'STALE_ATTEMPT') {
        resetCheckoutIntent(checkoutStorage());
        setReview(null);
        await refreshCart(true);
        setError('Your cart changed. Reload checkout to review the current cart.');
        return;
      }
      if (data.code === 'STALE_QUOTE') {
        // Pricing moved since the displayed quote: drop the intent and
        // the stale quote so the page requotes and the shopper reviews
        // updated totals before resubmitting.
        resetCheckoutIntent(checkoutStorage());
        setQuote(null);
        setQuoteNonce((n) => n + 1);
        setError('Prices changed while you were checking out. Updated totals are shown below.');
        return;
      }
      const action = classifyCheckoutResponse(res.status, data);
      if (action.kind === 'redirect') {
        // Redirect immediately: the server already converted the cart and
        // cleared its cookies in the checkout response, so nothing here is
        // allowed to fail or delay navigation to Stripe.
        window.location.href = action.url;
        return;
      }
      if (action.kind === 'paid') {
        window.location.href = data.orderUrl ?? `/checkout/success?order=${action.orderId}`;
        return;
      }
      if (action.kind === 'pending') {
        setError('Payment is being prepared. Wait a moment, then try again.');
        return;
      }
      if (action.terminal) resetCheckoutIntent(checkoutStorage());
      setError(action.message);
      setTurnstileToken('');
      turnstileResetRef.current?.();
    } catch {
      setError('Checkout could not reach the server. Your cart is unchanged; please try again.');
      setTurnstileToken('');
      turnstileResetRef.current?.();
    } finally {
      setBusy(false);
      if (pendingRequest.current === controller) pendingRequest.current = null;
    }
  }

  async function confirmAndPay() {
    if (!review) return;
    const controller = new AbortController();
    pendingRequest.current = controller;
    const submittedDetails = detailsRef.current;
    setBusy(true);
    setError('');
    try {
      const result = await confirmFn({
        data: { intentId: review.intentId, quoteHash: review.quoteHash },
        signal: controller.signal,
      });
      if (!result.ok) {
        resetCheckoutIntent(checkoutStorage());
        setReview(null);
        await refreshCart(true);
        setError(result.error);
        return;
      }
      if (!controller.signal.aborted && submittedDetails === detailsRef.current)
        window.location.href = result.checkoutUrl;
    } catch {
      setError('This checkout changed or could not be confirmed. Review it again.');
      setReview(null);
    } finally {
      setBusy(false);
      if (pendingRequest.current === controller) pendingRequest.current = null;
    }
  }

  const summary = (
    <div>
      <ul className="space-y-4">
        {lines.map((l) => {
          const title = l.productTitle;
          return (
            <li key={l.sku} className="flex items-center gap-3.5">
              <span
                className="relative flex h-14 w-12 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-base font-light text-zinc-400 select-none"
                aria-hidden
              >
                {title.slice(0, 1).toUpperCase()}
                <Badge variant="secondary" className="absolute -top-1.5 -right-1.5">
                  {l.qty}
                </Badge>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-zinc-950">{title}</span>
                <span className="block text-[13px] text-zinc-400">{l.sku}</span>
              </span>
              <span className="text-sm text-zinc-950">
                {formatMoney(
                  (quote?.items.find((item) => item.sku === l.sku)?.unitPriceCents ??
                    l.priceCents) * l.qty,
                  currency
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-6">
        <Label className="sr-only" htmlFor="co-code">
          Discount code
        </Label>
        <div className="flex gap-2">
          <Input
            id="co-code"
            disabled={busy}
            placeholder="Discount code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="min-w-0 flex-1"
          />
          <Button variant="outline" onClick={applyCode} disabled={!code || busy || applyingCode}>
            Apply
          </Button>
        </div>
        {discountMsg ? (
          <p className="mt-2 text-[13px] text-green-700" role="status">
            {discountMsg}
          </p>
        ) : null}
      </div>

      <dl className="mt-6 space-y-2.5 border-t border-zinc-200 pt-5 text-sm">
        <div className="flex justify-between">
          <dt className="text-zinc-500">Subtotal</dt>
          <dd className="text-zinc-950">
            {formatMoney(review?.quote.subtotalCents ?? quote?.subtotalCents ?? subtotal, currency)}
          </dd>
        </div>
        {(review?.quote.discountCents ?? quote?.discountCents ?? discountAmount) > 0 ? (
          <div className="flex justify-between text-green-700">
            <dt>Discount{appliedCode ? ` (${appliedCode})` : ''}</dt>
            <dd>
              −
              {formatMoney(
                review?.quote.discountCents ?? quote?.discountCents ?? discountAmount,
                currency
              )}
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between">
          <dt className="text-zinc-500">Shipping</dt>
          <dd className="text-zinc-950">
            {lines.length === 0
              ? '—'
              : !rate
                ? 'Unavailable'
                : (review?.quote.shippingCents ?? quote?.shippingCents ?? shipping) === 0
                  ? 'Free'
                  : formatMoney(
                      review?.quote.shippingCents ?? quote?.shippingCents ?? shipping,
                      currency
                    )}
          </dd>
        </div>
        <div className="flex items-baseline justify-between border-t border-zinc-200 pt-3.5">
          <dt className="text-base font-medium text-zinc-950">Total</dt>
          <dd className="text-lg font-medium text-zinc-950">{formatMoney(total, currency)}</dd>
        </div>
      </dl>
      {review ? (
        <p className="mt-2 text-[13px] text-zinc-500">
          Tax: {formatMoney(review.quote.taxCents, review.quote.currency)}. The reviewed total
          includes shipping, discounts and tax.
        </p>
      ) : (
        <p className="mt-2 text-[13px] text-zinc-400">
          Prepare your order to review the final tax and total.
        </p>
      )}
    </div>
  );

  if (lines.length === 0) {
    return (
      <main className="mx-auto w-full max-w-xl px-4 py-20 text-center">
        <h1 className="text-2xl font-normal tracking-tight text-zinc-950">Your cart is empty</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500">There is nothing to check out yet.</p>
        <Link to="/" className={cn(buttonVariants({ size: 'lg' }), 'mt-6')}>
          Return to the store
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto grid w-full max-w-6xl lg:min-h-[calc(100vh-4rem)] lg:grid-cols-[1fr_440px]">
      {/* Details */}
      <section className="px-4 py-8 sm:px-6 lg:px-8 lg:py-12" aria-label="Checkout details">
        <div className="mx-auto max-w-xl lg:mx-0">
          <h1 className="sr-only">Checkout</h1>

          <h2 className="text-lg font-normal text-zinc-950">Contact</h2>
          <div className="mt-3.5">
            <Label htmlFor="ck-email">Email</Label>
            <Input
              id="ck-email"
              disabled={busy}
              type="email"
              autoComplete="email"
              placeholder="Email for your receipt and tracking"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5"
            />
          </div>

          <h2 className="mt-10 text-lg font-normal text-zinc-950">Delivery</h2>
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              disabled={busy}
              checked={reminderConsent}
              onChange={(e) => setReminderConsent(e.target.checked)}
            />
            Email me once if I leave this checkout unfinished. Optional; I can ask the store to
            suppress reminders.
          </label>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {(
              [
                ['name', 'Full name', 'name'],
                ['line1', 'Address', 'address-line1'],
                ['line2', 'Apartment / suite (optional)', 'address-line2'],
                ['city', 'City', 'address-level2'],
                ['state', 'State / region', 'address-level1'],
                ['postalCode', 'Postal code', 'postal-code'],
                ['phone', 'Phone (optional)', 'tel'],
              ] as const
            ).map(([key, label, complete]) => (
              <div key={key}>
                <Label htmlFor={`shipping-${key}`}>{label}</Label>
                <Input
                  disabled={busy}
                  id={`shipping-${key}`}
                  autoComplete={complete}
                  value={address[key]}
                  onChange={(e) => setAddress((old) => ({ ...old, [key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div className="mt-3.5">
            <Label htmlFor="ck-country">Country</Label>
            <Select
              disabled={busy}
              value={country}
              onValueChange={(value) => {
                setCountry(value);
                setRateId('');
              }}
            >
              <SelectTrigger id="ck-country" className="mt-1.5 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...new Set(zones.flatMap((z) => z.countries))].map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {zone ? (
            <fieldset className="mt-4">
              <legend className="text-sm font-medium text-zinc-900">
                Shipping method — {zone.name}
              </legend>
              <ToggleGroup
                disabled={busy}
                type="single"
                variant="outline"
                value={rate?.id ?? ''}
                onValueChange={(value) => {
                  if (value) setRateId(value);
                }}
                className="mt-2.5 flex flex-col items-stretch gap-2"
                aria-label="Shipping method"
              >
                {zone.rates.map((r) => {
                  return (
                    <ToggleGroupItem
                      key={r.id}
                      value={r.id}
                      className="flex h-auto w-full items-center justify-between px-3.5 py-3"
                    >
                      <span>{r.name}</span>
                      <span>
                        {rateCost(
                          r,
                          subtotal - discountAmount,
                          lines.reduce((s, l) => s + (l.weightGrams ?? 0) * l.qty, 0)
                        ) === 0
                          ? 'Free'
                          : formatMoney(
                              rateCost(
                                r,
                                subtotal - discountAmount,
                                lines.reduce((s, l) => s + (l.weightGrams ?? 0) * l.qty, 0)
                              ),
                              currency
                            )}
                      </span>
                    </ToggleGroupItem>
                  );
                })}
              </ToggleGroup>
            </fieldset>
          ) : (
            <p className="mt-4 text-sm leading-6 text-zinc-500">
              Shipping is unavailable for this destination. Checkout is disabled until a rate is
              configured.
            </p>
          )}
          <p className="mt-3 text-[13px] leading-5 text-zinc-400">
            Review your delivery details here. Payment credentials are collected securely by Stripe.
          </p>

          <h2 className="mt-10 text-lg font-normal text-zinc-950">Payment</h2>
          {review ? (
            <div className="mt-4 rounded-lg border border-zinc-200 p-4 text-sm" role="status">
              <strong>Review your order</strong>
              <p className="mt-2">
                {address.name} · {address.line1}
                {address.line2 ? `, ${address.line2}` : ''}, {address.city}, {address.state}{' '}
                {address.postalCode}, {country}
              </p>
              <p>
                {rate?.name} · Total {formatMoney(review.quote.totalCents, review.quote.currency)},
                including {formatMoney(review.quote.taxCents, review.quote.currency)} tax.
              </p>
              <p className="mt-2">Confirm these details before continuing to Stripe.</p>
            </div>
          ) : null}
          <p className="mt-2 text-sm leading-6 text-zinc-500">
            Payment is collected by Stripe on the next step — card, Apple Pay, and Google Pay where
            available. Your payment session lasts {cart.limits.checkout_session_minutes} minutes.
            Stock is allocated after payment authorization; opening checkout does not reserve it.
          </p>
          {!loaded ? (
            <p className="mt-4 text-sm text-zinc-500" role="status">
              Loading current prices and stock…
            </p>
          ) : null}
          {quoteError ? (
            <Alert variant="destructive" role="alert" className="mt-4">
              <AlertDescription>{quoteError}</AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive" role="alert" className="mt-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="mt-5">
            <TurnstileWidget
              siteKey={turnstileSiteKey}
              action="checkout"
              onToken={setTurnstileToken}
              resetRef={turnstileResetRef}
            />
          </div>
          <Button
            size="lg"
            className="mt-5 h-12 w-full"
            onClick={review ? confirmAndPay : pay}
            disabled={
              !email ||
              !address.name.trim() ||
              !address.line1.trim() ||
              !address.city.trim() ||
              !address.postalCode.trim() ||
              busy ||
              applyingCode ||
              !loaded ||
              !rate ||
              quoting ||
              !quote ||
              Boolean(quoteError) ||
              (Boolean(turnstileSiteKey) && !turnstileToken && !review)
            }
          >
            {busy
              ? review
                ? 'Opening secure payment…'
                : 'Preparing final review…'
              : `${review ? 'Confirm and pay' : 'Review order'} · ${formatMoney(total, currency)}`}
          </Button>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[13px] text-zinc-400">
            <ShieldIcon className="h-4 w-4" /> Encrypted and secure — powered by Stripe
          </p>
          <Link
            to="/cart"
            className="mt-5 inline-block text-sm text-zinc-500 underline-offset-4 hover:text-zinc-950 hover:underline"
          >
            Return to cart
          </Link>
        </div>
      </section>

      {/* Summary */}
      <aside
        className="border-t border-zinc-100 bg-zinc-50 px-4 py-8 sm:px-6 lg:border-t-0 lg:border-l lg:px-8 lg:py-12"
        aria-label="Order summary"
      >
        <div className="lg:sticky lg:top-12">{summary}</div>
      </aside>
    </main>
  );
}
