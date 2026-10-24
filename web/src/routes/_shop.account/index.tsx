import { useState } from 'react';
import { LocalDate } from '../../components/LocalDate';
import { Link, createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { getSessionUser, twoFactorEnabledOf } from '../../server/session';
import { claimVerifiedGuestOrders } from '../../server/account';
import { formatMoney } from '../../components/ProductCard';
import { StatusBadge } from '../../components/StatusBadge';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { addresses as addressesT } from '../../db/schema';
import { authClient } from '../../lib/auth-client';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';
import { cn } from '@/lib/utils';
import { addToCart, openCart } from '../../lib/cart';
import { reorderItems } from '../../lib/reorder';
import { accountActionFn, createReturnFn } from '../../lib/shopFns';
import { useRouter } from '@tanstack/react-router';
import type { AccountActionInput } from '../../schemas/account';
import {
  canRequestReturn,
  customerReturnLabel,
  groupReturnsByOrder,
} from '../../lib/account-returns';
import {
  loadAccountOrders,
  type AccountOrderRow,
  type AccountReturnRow,
} from '../../server/account-orders';
import { validateServerInput } from '../../server/function-boundary';
import { pageInputSchema } from '../../schemas/pagination';
import { accountSearch } from '../../lib/search-params';

type OrderRow = AccountOrderRow;
type ReturnRow = AccountReturnRow;
type AddressRow = {
  id: string;
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  phone: string;
  is_default: number;
};

const getAccount = createServerFn({ method: 'GET' })
  .validator(validateServerInput(pageInputSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const request = getRequest();
    const user = await getSessionUser(env.DB, request);
    if (!user)
      return {
        user: null,
        orders: [] as OrderRow[],
        returns: [] as ReturnRow[],
        addresses: [] as AddressRow[],
        totalOrders: 0,
        page: 1,
        pageCount: 1,
      };
    // Orders are matched by user_id only. Guest orders are claimed into the
    // account solely when the account email is verified — an unverified
    // signup with someone else's email sees nothing.
    await claimVerifiedGuestOrders(
      env.DB,
      user as { id: string; email: string; emailVerified?: boolean }
    );
    const d = getDb(env.DB);
    const accountOrders = await loadAccountOrders(env.DB, user.id, data.page);
    const addresses = await d
      .select({
        id: addressesT.id,
        name: addressesT.name,
        line1: addressesT.line1,
        line2: addressesT.line2,
        city: addressesT.city,
        region: addressesT.state,
        postal_code: addressesT.postalCode,
        country: addressesT.country,
        phone: addressesT.phone,
        is_default: addressesT.isDefault,
      })
      .from(addressesT)
      .where(eq(addressesT.userId, user.id))
      .orderBy(desc(addressesT.isDefault));
    return {
      user: {
        email: user.email,
        name: user.name,
        role: user.role,
        twoFactorEnabled: twoFactorEnabledOf(user),
      },
      orders: accountOrders.orders,
      returns: accountOrders.returns,
      totalOrders: accountOrders.totalOrders,
      page: accountOrders.page,
      pageCount: accountOrders.pageCount,
      addresses: addresses.map((a) => ({
        ...a,
        line2: a.line2 ?? '',
        region: a.region ?? '',
        phone: a.phone ?? '',
        is_default: a.is_default ? 1 : 0,
      })),
    };
  });

export const Route = createFileRoute('/_shop/account/')({
  validateSearch: accountSearch,
  loaderDeps: ({ search: { page } }) => ({ page }),
  loader: async ({ deps }) => getAccount({ data: { page: deps.page } }),
  head: () => ({ meta: [{ title: 'Your account' }, { name: 'robots', content: 'noindex' }] }),
  component: AccountPage,
});

function AccountPage() {
  const { user, orders, returns, addresses, totalOrders, page, pageCount } = Route.useLoaderData();
  const router = useRouter();
  const [msg, setMsg] = useState('');
  const [returningId, setReturningId] = useState('');
  const [reason, setReason] = useState('');
  const [returnQtys, setReturnQtys] = useState<Record<string, number>>({});
  const [returnBusy, setReturnBusy] = useState(false);
  const [reorderMsg, setReorderMsg] = useState<Record<string, string>>({});
  const [addressForm, setAddressForm] = useState({
    name: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    country: 'US',
    phone: '',
  });
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [totpUri, setTotpUri] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [backupCodesSaved, setBackupCodesSaved] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ current: '', next: '' });
  const [passwordMsg, setPasswordMsg] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [password, setPassword] = useState('');
  const returnsByOrder = groupReturnsByOrder(returns);

  async function accountAction(payload: AccountActionInput) {
    const data = await accountActionFn({ data: payload });
    if (data.ok) router.invalidate();
    else setMsg(data.error);
    return data.ok;
  }

  if (!user) {
    return (
      <main className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-[28px] font-normal tracking-tight">Your account</h1>
        <p className="mt-3 leading-7 text-zinc-500">
          Sign in to see your orders, follow deliveries as they ship, and start a return.
        </p>
        <Link to="/auth/sign-in" className={cn(buttonVariants({ size: 'lg' }), 'mt-6')}>
          Sign in
        </Link>
        <p className="mt-4 text-sm text-zinc-500">
          New here? You can create an account on the sign-in page. It takes a few seconds.
        </p>
      </main>
    );
  }

  return (
    <main className="py-10 lg:py-14">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[32px] font-normal tracking-tight">
            Welcome back{user.name ? `, ${user.name.split(' ')[0]}` : ''}
          </h1>
          <p className="mt-1.5 text-sm text-zinc-500">{user.email}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await authClient.signOut();
            await router.invalidate();
            router.navigate({ to: '/' });
          }}
        >
          Sign out
        </Button>
      </div>

      <h2 className="mt-10 pb-4 text-xl font-medium">Your orders</h2>
      {orders.length === 0 ? (
        <Card className="border-dashed px-6 py-14 text-center" role="status">
          <p className="font-medium">No orders yet</p>
          <p className="mt-1 text-sm text-zinc-500">
            Orders you place while signed in (or with this email) will show up here with live
            status.
          </p>
          <Link to="/" className={cn(buttonVariants({ size: 'lg' }), 'mt-5')}>
            Browse products
          </Link>
        </Card>
      ) : (
        <div className="space-y-4">
          {orders.map((o) => {
            const orderReturns = returnsByOrder.get(o.id) ?? [];
            const canReturn = canRequestReturn({
              paymentStatus: o.payment_status,
              returns: orderReturns,
              items: o.items,
            });
            return (
              <Card key={o.id} className="p-5">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <p className="font-medium">{o.number}</p>
                  <StatusBadge value={o.payment_status} />
                  <StatusBadge value={o.status} />
                  <span className="ml-auto text-[15px] font-medium">
                    {formatMoney(o.total_cents, o.currency)}
                  </span>
                </div>
                <p className="mt-2 text-[13px] text-zinc-500">
                  Placed <LocalDate value={o.created_at} />
                  {o.tracking_number ? (
                    <>
                      {' '}
                      · Tracking{' '}
                      <span className="text-zinc-950 tabular-nums">{o.tracking_number}</span>. Use
                      it on your carrier&apos;s site to follow delivery
                    </>
                  ) : null}
                </p>
                <Progress status={o.status} payment={o.payment_status} />
                {o.items.length > 0 ? (
                  <ul className="mt-3 space-y-1 text-sm text-zinc-500">
                    {o.items.map((i) => (
                      <li key={i.sku}>
                        {i.qty} × {i.title} <span className="text-zinc-400">({i.sku})</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-4 flex flex-wrap items-center gap-3 text-[13px]">
                  {o.items.length > 0 ? (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0"
                      onClick={async () => {
                        const { added, failed } = await reorderItems(o.items, addToCart);
                        if (failed.length > 0) {
                          const parts: string[] = [];
                          const unavailable = failed
                            .filter((f) => f.unavailable)
                            .map((f) => f.title);
                          const generic = failed.filter((f) => !f.unavailable).map((f) => f.title);
                          if (unavailable.length > 0)
                            parts.push(`No longer available: ${unavailable.join(', ')}`);
                          if (generic.length > 0) parts.push(`Couldn't add: ${generic.join(', ')}`);
                          setReorderMsg({ ...reorderMsg, [o.id]: parts.join('. ') + '.' });
                        } else {
                          setReorderMsg({ ...reorderMsg, [o.id]: '' });
                        }
                        if (added.length > 0) openCart();
                      }}
                    >
                      Reorder
                    </Button>
                  ) : null}
                  {reorderMsg[o.id] ? (
                    <span className="text-zinc-500" role="status">
                      {reorderMsg[o.id]}
                    </span>
                  ) : null}
                  {orderReturns.map((ret) => (
                    <span key={ret.id} className="text-zinc-500">
                      Return {customerReturnLabel(ret.status)}, requested{' '}
                      <LocalDate value={ret.created_at} />.
                    </span>
                  ))}
                  {canReturn ? (
                    returningId === o.id ? (
                      <span className="flex flex-wrap items-center gap-2">
                        {o.items.map((i) => {
                          const remaining = i.qty - i.returned_qty;
                          return (
                            <span key={i.id} className="flex items-center gap-1.5 text-zinc-600">
                              <Label htmlFor={`return-qty-${i.id}`}>{i.title}</Label>
                              <Input
                                id={`return-qty-${i.id}`}
                                type="number"
                                min={0}
                                max={remaining}
                                aria-label={`Quantity of ${i.title} to return`}
                                value={returnQtys[i.id] ?? remaining}
                                onChange={(e) =>
                                  setReturnQtys({
                                    ...returnQtys,
                                    [i.id]: Math.max(
                                      0,
                                      Math.min(remaining, Number(e.target.value) || 0)
                                    ),
                                  })
                                }
                                className="w-16"
                              />
                              <span className="text-zinc-400">of {remaining}</span>
                            </span>
                          );
                        })}
                        <Label className="sr-only" htmlFor={`return-reason-${o.id}`}>
                          Reason for return
                        </Label>
                        <Input
                          id={`return-reason-${o.id}`}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="Reason (optional)"
                        />
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0"
                          disabled={returnBusy}
                          onClick={async () => {
                            setReturnBusy(true);
                            try {
                              const items = o.items
                                .map((i) => ({
                                  orderItemId: i.id,
                                  qty: returnQtys[i.id] ?? i.qty - i.returned_qty,
                                }))
                                .filter((i) => i.qty > 0);
                              if (items.length === 0) {
                                setMsg('Choose at least one item to return.');
                                return;
                              }
                              const data = await createReturnFn({
                                data: { orderId: o.id, reason, items },
                              });
                              setMsg(
                                data.ok
                                  ? `Return requested for ${o.number}. We will email you the next steps.`
                                  : (data.error ?? 'Return request failed')
                              );
                              if (data.ok) {
                                setReturningId('');
                                setReason('');
                              }
                            } catch {
                              setMsg(
                                'Return request could not reach the server. Please try again.'
                              );
                            } finally {
                              setReturnBusy(false);
                            }
                          }}
                        >
                          {returnBusy ? 'Sending…' : 'Submit return'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-auto p-0 text-zinc-500"
                          onClick={() => setReturningId('')}
                        >
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0"
                        onClick={() => setReturningId(o.id)}
                      >
                        Request a return
                      </Button>
                    )
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {pageCount > 1 ? (
        <Pagination className="mt-6 justify-start" aria-label="Order history pages">
          <PaginationContent>
            {page > 1 ? (
              <PaginationItem>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/account" search={{ page: page - 1 }}>
                    Previous
                  </Link>
                </Button>
              </PaginationItem>
            ) : null}
            <PaginationItem>
              <span className="px-2 text-sm text-zinc-500">
                Page {page} of {pageCount} · {totalOrders} orders
              </span>
            </PaginationItem>
            {page < pageCount ? (
              <PaginationItem>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/account" search={{ page: page + 1 }}>
                    Next
                  </Link>
                </Button>
              </PaginationItem>
            ) : null}
          </PaginationContent>
        </Pagination>
      ) : null}
      {msg ? (
        <Alert className="mt-4">
          <AlertDescription>{msg}</AlertDescription>
        </Alert>
      ) : null}

      <h2 className="mt-12 pb-4 text-xl font-medium">Address book</h2>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          {addresses.length === 0 ? (
            <p className="text-sm text-zinc-500" role="status">
              No saved addresses yet. Add one and it is ready for your next checkout.
            </p>
          ) : (
            addresses.map((a) => (
              <Card key={a.id} className="p-4">
                <p className="text-sm font-medium text-zinc-950">
                  {a.name}
                  {a.is_default ? (
                    <Badge variant="secondary" className="ml-2">
                      Default
                    </Badge>
                  ) : null}
                </p>
                <address className="mt-1 text-sm leading-6 text-zinc-500 not-italic">
                  {a.line1}
                  {a.line2 ? (
                    <>
                      <br />
                      {a.line2}
                    </>
                  ) : null}
                  <br />
                  {a.city}, {a.region} {a.postal_code}
                  <br />
                  {a.country}
                  {a.phone ? (
                    <>
                      <br />
                      {a.phone}
                    </>
                  ) : null}
                </address>
                <span className="mt-2 flex gap-3 text-[13px]">
                  {!a.is_default ? (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0"
                      onClick={() =>
                        accountAction({
                          action: 'address.update',
                          addressId: a.id,
                          name: a.name,
                          line1: a.line1,
                          line2: a.line2,
                          city: a.city,
                          region: a.region,
                          postalCode: a.postal_code,
                          country: a.country,
                          phone: a.phone,
                          isDefault: true,
                        })
                      }
                    >
                      Make default
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto p-0 text-zinc-500 hover:text-red-600"
                    onClick={() => accountAction({ action: 'address.delete', addressId: a.id })}
                  >
                    Delete
                  </Button>
                </span>
              </Card>
            ))
          )}
        </div>
        <Card className="p-5">
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await accountAction({
                  action: 'address.create',
                  ...addressForm,
                  isDefault: addresses.length === 0,
                })
              ) {
                setAddressForm({
                  name: '',
                  line1: '',
                  line2: '',
                  city: '',
                  region: '',
                  postalCode: '',
                  country: 'US',
                  phone: '',
                });
                setMsg('Address saved.');
              }
            }}
          >
            <h3 className="text-sm font-medium text-zinc-950">Add an address</h3>
            <div>
              <Label htmlFor="ad-name">Full name</Label>
              <Input
                id="ad-name"

                value={addressForm.name}
                onChange={(e) => setAddressForm({ ...addressForm, name: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="ad-line1">Address line 1</Label>
              <Input
                id="ad-line1"

                value={addressForm.line1}
                onChange={(e) => setAddressForm({ ...addressForm, line1: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="ad-line2">Address line 2</Label>
              <Input
                id="ad-line2"

                value={addressForm.line2}
                onChange={(e) => setAddressForm({ ...addressForm, line2: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ad-city">City</Label>
                <Input
                  id="ad-city"

                  value={addressForm.city}
                  onChange={(e) => setAddressForm({ ...addressForm, city: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="ad-region">State / region</Label>
                <Input
                  id="ad-region"

                  value={addressForm.region}
                  onChange={(e) => setAddressForm({ ...addressForm, region: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ad-postal">Postal code</Label>
                <Input
                  id="ad-postal"

                  value={addressForm.postalCode}
                  onChange={(e) => setAddressForm({ ...addressForm, postalCode: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="ad-country">Country</Label>
                <Input
                  id="ad-country"

                  value={addressForm.country}
                  onChange={(e) => setAddressForm({ ...addressForm, country: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="ad-phone">Phone</Label>
              <Input
                id="ad-phone"

                value={addressForm.phone}
                onChange={(e) => setAddressForm({ ...addressForm, phone: e.target.value })}
              />
            </div>
            <Button type="submit" size="sm">
              Save address
            </Button>
          </form>
        </Card>
      </div>

      <h2 className="mt-12 pb-4 text-xl font-medium">Security</h2>
      <Card className="space-y-3 p-5">
        <p className="text-sm text-zinc-950">Two-factor authentication (TOTP)</p>
        {user.twoFactorEnabled ? (
          <p className="text-sm text-green-700" role="status">
            Two-factor authentication is on for your account.
          </p>
        ) : (
          <>
            <p className="text-sm leading-6 text-zinc-500">
              {['owner', 'manager', 'support', 'warehouse', 'admin'].includes(user.role ?? '')
                ? 'Required for staff accounts: the admin stays locked until two-factor is on. '
                : ''}
              Add an authenticator app for a second step at sign-in.
            </p>
            {!totpUri ? (
              <span className="flex flex-wrap items-end gap-2">
                <span>
                  <Label htmlFor="tf-password">Current password</Label>
                  <Input
                    id="tf-password"
                    type="password"
                    className="w-64"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </span>
                <Button
                  variant="outline"
                  onClick={async () => {
                    const res = await authClient.twoFactor.enable({ password });
                    if (res.data && 'totpURI' in res.data && res.data.totpURI) {
                      setTotpUri(res.data.totpURI);
                      setBackupCodes(res.data.backupCodes);
                    } else
                      setMsg(
                        res.error?.message ??
                          'Could not start two-factor setup. Check your password.'
                      );
                  }}
                >
                  Set up two-factor
                </Button>
              </span>
            ) : (
              <span className="flex flex-wrap items-end gap-2">
                <span className="block w-full min-w-0 space-y-2">
                  <span className="block text-[13px] text-zinc-500">
                    Add this to your authenticator app, or type the secret key in manually:
                  </span>
                  <code className="block max-w-full rounded-lg bg-zinc-50 px-3 py-2 text-xs break-all text-zinc-700 select-all">
                    {totpUri}
                  </code>
                  <span className="block text-[13px] text-zinc-500">Secret key</span>
                  <code className="block max-w-full rounded-lg bg-zinc-50 px-3 py-2 font-mono text-sm break-all text-zinc-950 select-all">
                    {new URL(totpUri).searchParams.get('secret') ?? ''}
                  </code>
                  {backupCodes.length > 0 ? (
                    <>
                      <span className="block text-[13px] text-zinc-500">
                        Backup codes. Each works once if you lose your authenticator. They are shown
                        only now, so store them somewhere safe:
                      </span>
                      <code className="grid max-w-md grid-cols-2 gap-1 rounded-lg bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-950 select-all">
                        {backupCodes.map((code) => (
                          <span key={code}>{code}</span>
                        ))}
                      </code>
                      <label className="flex items-center gap-2 text-sm text-zinc-700">
                        <input
                          type="checkbox"
                          checked={backupCodesSaved}
                          onChange={(e) => setBackupCodesSaved(e.target.checked)}
                        />
                        I saved my backup codes
                      </label>
                    </>
                  ) : null}
                </span>
                <span>
                  <Label htmlFor="tf-code">6-digit code</Label>
                  <Input
                    id="tf-code"
                    inputMode="numeric"
                    className="w-36"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                  />
                </span>
                <Button
                  variant="outline"
                  disabled={backupCodes.length > 0 && !backupCodesSaved}
                  onClick={async () => {
                    const res = await authClient.twoFactor.verifyTotp({ code: totpCode });
                    if (res.error) setMsg(res.error.message ?? 'That code did not verify.');
                    else {
                      setMsg('Two-factor is on. Your admin access is unlocked.');
                      setBackupCodes([]);
                      router.invalidate();
                    }
                  }}
                >
                  Verify and turn on
                </Button>
              </span>
            )}
          </>
        )}
      </Card>
      <Card className="mt-4 space-y-3 p-5">
        <p className="text-sm text-zinc-950">Change password</p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await authClient.changePassword({
              currentPassword: passwordForm.current,
              newPassword: passwordForm.next,
              revokeOtherSessions: true,
            });
            if (res.error) {
              setPasswordMsg(res.error.message ?? 'Could not change your password.');
            } else {
              setPasswordForm({ current: '', next: '' });
              setPasswordMsg('Password changed. Your other sessions were signed out.');
            }
          }}
        >
          <span>
            <Label htmlFor="cp-current">Current password</Label>
            <Input
              id="cp-current"
              type="password"
              autoComplete="current-password"
              className="w-64"
              required
              value={passwordForm.current}
              onChange={(e) => setPasswordForm({ ...passwordForm, current: e.target.value })}
            />
          </span>
          <span>
            <Label htmlFor="cp-next">New password</Label>
            <Input
              id="cp-next"
              type="password"
              autoComplete="new-password"
              className="w-64"
              required
              value={passwordForm.next}
              onChange={(e) => setPasswordForm({ ...passwordForm, next: e.target.value })}
            />
          </span>
          <Button type="submit" variant="outline">
            Change password
          </Button>
        </form>
        {passwordMsg ? (
          <p className="text-sm text-zinc-600" role="status">
            {passwordMsg}
          </p>
        ) : null}
      </Card>

      <h2 className="mt-12 pb-4 text-xl font-medium">Your data</h2>
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-zinc-500">
            Download everything this store holds about you: profile, orders, returns, and addresses.
          </p>
          <a
            href="/api/account?export=1"
            className={cn(buttonVariants({ variant: 'outline' }), 'ml-auto')}
          >
            Export my data (JSON)
          </a>
        </div>
        <div className="border-t border-zinc-100 pt-4">
          <p className="text-sm font-medium text-red-600">Delete my account</p>
          <p className="mt-1 text-sm leading-6 text-zinc-500">
            Deletes your sign-in, sessions, and addresses. Past orders stay as anonymised financial
            records, as the law requires. This cannot be undone.
          </p>
          <span className="mt-3 flex flex-wrap items-center gap-2">
            <Label className="sr-only" htmlFor="del-email">
              Type your email to confirm deletion
            </Label>
            <Input
              id="del-email"
              placeholder={user.email}
              className="w-72"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
            />
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteConfirm !== user.email}
              onClick={async () => {
                if (!window.confirm('Delete your account permanently?')) return;
                if (
                  await accountAction({ action: 'account.delete', confirmEmail: deleteConfirm })
                ) {
                  await authClient.signOut();
                  await router.invalidate();
                  router.navigate({ to: '/' });
                }
              }}
            >
              Delete account
            </Button>
          </span>
        </div>
      </Card>
    </main>
  );
}

function Progress({ status, payment }: { status: string; payment: string }) {
  const steps = ['Placed', 'Paid', 'Shipped', 'Delivered'];
  const current =
    status === 'delivered' ? 3 : status === 'shipped' ? 2 : payment === 'paid' ? 1 : 0;
  if (status === 'canceled' || status === 'cancelled' || payment === 'refunded') {
    return (
      <p className="mt-3 text-[13px] font-medium text-red-600">
        This order was {payment === 'refunded' ? 'refunded' : 'canceled'}.
      </p>
    );
  }
  return (
    <ol className="mt-4 flex items-center gap-0" aria-label={`Order progress: ${steps[current]}`}>
      {steps.map((s, i) => (
        <li key={s} className="flex flex-1 items-center last:flex-none">
          <span className="flex items-center gap-2">
            <Badge
              variant={i <= current ? 'default' : 'secondary'}
              className="size-6 justify-center rounded-full p-0 text-[11px]"
            >
              {i + 1}
            </Badge>
            <span
              className={`hidden text-xs font-medium sm:block ${i <= current ? 'text-zinc-950' : 'text-zinc-400'}`}
            >
              {s}
            </span>
          </span>
          {i < steps.length - 1 ? (
            <Separator className={cn('mx-2 flex-1', i < current && 'bg-zinc-950')} aria-hidden />
          ) : null}
        </li>
      ))}
    </ol>
  );
}
