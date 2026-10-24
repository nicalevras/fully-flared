import { validateServerInput } from '../../server/function-boundary';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { formatMoney } from '../../components/ProductCard';
import { CheckIcon } from '../../components/icons';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { getRequest, appendResponseHeader } from '@tanstack/react-start/server';
import { parseCartCookie, clearCartCookieHeader, cartCountCookieHeader } from '../../server/cart';
import { successOrderInputSchema, successSearchSchema } from '../../schemas/checkout';
import { verifyOrderAccessToken } from '../../server/checkout';
import { getSessionUser } from '../../server/session';

type OrderView = {
  number: string;
  status: string;
  payment_status: string;
  total_cents: number;
  currency: string;
  customer_email: string;
  items: Array<{ sku: string; title: string; qty: number; unit_price_cents: number }>;
} | null;

const getOrder = createServerFn({ method: 'GET' })
  .validator(validateServerInput(successOrderInputSchema))
  .handler(async ({ data }): Promise<OrderView> => {
    const { workerEnv: env } = await import('../../server/env');
    // Order details are private: the signed token from the checkout redirect
    // or the signed-in owner of the order. The order id alone is not enough.
    const row = await env.DB.prepare(
      'SELECT number, status, payment_status, total_cents, currency, customer_email, user_id FROM orders WHERE id = ?'
    )
      .bind(data.orderId)
      .first<Omit<NonNullable<OrderView>, 'items'> & { user_id: string | null }>();
    if (!row) return null;
    const secret = env.BETTER_AUTH_SECRET ?? '';
    const tokenOk = secret ? await verifyOrderAccessToken(secret, data.orderId, data.token) : false;
    if (!tokenOk) {
      const user = await getSessionUser(env.DB, getRequest()).catch(() => null);
      if (!user || row.user_id !== user.id) return null;
    }
    const order = {
      number: row.number,
      status: row.status,
      payment_status: row.payment_status,
      total_cents: row.total_cents,
      currency: row.currency,
      customer_email: row.customer_email,
    };
    const cart = parseCartCookie(getRequest().headers.get('cookie'));
    if (
      cart &&
      (await env.DB.prepare(
        "SELECT 1 FROM carts c JOIN checkout_intents ci ON ci.cart_id=c.id WHERE ci.order_id=? AND c.id=? AND c.status='converted' AND ci.cart_revision=c.revision AND c.active_checkout_id=ci.id"
      )
        .bind(data.orderId, cart.id)
        .first())
    ) {
      appendResponseHeader('Set-Cookie', clearCartCookieHeader);
      appendResponseHeader('Set-Cookie', cartCountCookieHeader(0));
    }
    const items = await env.DB.prepare(
      'SELECT sku, title, qty, unit_price_cents FROM order_items WHERE order_id = ?'
    )
      .bind(data.orderId)
      .all<NonNullable<OrderView>['items'][number]>();
    return { ...order, items: items.results };
  });

export const Route = createFileRoute('/checkout/success')({
  validateSearch: successSearchSchema,
  loaderDeps: ({ search: { order, t } }) => ({ order, t }),
  loader: async ({ deps }) =>
    deps.order ? getOrder({ data: { orderId: deps.order, token: deps.t } }) : null,
  head: () => ({ meta: [{ title: 'Order confirmed' }, { name: 'robots', content: 'noindex' }] }),
  component: SuccessPage,
});

function SuccessPage() {
  const order = Route.useLoaderData();
  const router = useRouter();

  if (!order) {
    return (
      <main className="mx-auto max-w-xl py-16 text-center">
        <h1 className="text-3xl font-normal tracking-tight">We can&apos;t find that order</h1>
        <p className="mt-3 text-zinc-500">
          If you just paid, check your email for the confirmation, or track the order from your
          account.
        </p>
        <Link to="/account" className={cn(buttonVariants({ size: 'lg' }), 'mt-6')}>
          Go to your account
        </Link>
      </main>
    );
  }

  // Precedence: disputed and refunded describe the money more precisely
  // than cancellation, and a canceled order is never "confirmed" even when
  // a late payment briefly left payment_status='paid'.
  const state =
    order.payment_status === 'disputed'
      ? 'disputed'
      : order.payment_status === 'refunded' || order.status === 'refunded'
        ? 'refunded'
        : order.status === 'canceled'
          ? 'canceled'
          : order.payment_status === 'paid' || order.payment_status === 'partially_refunded'
            ? 'confirmed'
            : 'confirming';
  const heading = {
    confirmed: 'Thank you. Order confirmed',
    confirming: 'Order received',
    canceled: 'Order canceled',
    refunded: 'Order refunded',
    disputed: 'Payment under review',
  }[state];
  return (
    <main className="mx-auto max-w-2xl py-14">
      <div className="text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-50 text-green-700">
          <CheckIcon className="h-7 w-7" />
        </span>
        <h1 className="mt-5 text-3xl font-normal tracking-tight">{heading}</h1>
        <p className="mt-2 text-zinc-500">
          Order <strong className="text-zinc-950">{order.number}</strong>
          {state === 'confirmed' ? (
            <> is confirmed. A receipt is on its way to {order.customer_email}.</>
          ) : state === 'canceled' ? (
            <>
              {' '}
              was canceled and will not be fulfilled. If you paid for this order, watch your email
              at {order.customer_email} for updates about your payment.
            </>
          ) : state === 'refunded' ? (
            <> has been refunded. Questions? Contact us about order {order.number}.</>
          ) : state === 'disputed' ? (
            <>
              {' '}
              is being reviewed by your payment provider. Contact us if you need help with this
              order.
            </>
          ) : (
            <>
              {' '}
              is being confirmed with your payment provider. We&apos;ll email {
                order.customer_email
              }{' '}
              the moment payment clears, and this page will show Paid once it does.
            </>
          )}
        </p>
      </div>

      <Card className="mt-8 overflow-hidden p-0">
        <Table>
          <TableCaption className="sr-only">Order items</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Item</TableHead>
              <TableHead scope="col">Qty</TableHead>
              <TableHead scope="col" className="text-right">
                Price
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {order.items.map((i) => (
              <TableRow key={i.sku}>
                <TableCell className="font-medium">
                  {i.title}
                  <span className="block text-xs font-normal text-zinc-500">{i.sku}</span>
                </TableCell>
                <TableCell>{i.qty}</TableCell>
                <TableCell className="text-right">
                  {formatMoney(i.unit_price_cents * i.qty, order.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-100 px-5 py-3.5 text-sm">
          <span className="font-medium">Total {state === 'confirmed' ? '(paid)' : ''}</span>
          <span className="text-base font-medium">
            {formatMoney(order.total_cents, order.currency)}
          </span>
        </div>
      </Card>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        {state === 'confirming' ? (
          <Button onClick={() => router.invalidate()}>Refresh payment status</Button>
        ) : null}
        <Link to="/account" className={cn(buttonVariants({ size: 'lg' }))}>
          Track your order
        </Link>
        <Link to="/" className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}>
          Continue shopping
        </Link>
      </div>
    </main>
  );
}
