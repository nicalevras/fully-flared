import { useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { useStoreCurrency } from '../../lib/use-store-currency';
import { formatDate } from '../../lib/format';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useAdminAction, type AdminPayload } from '../../components/AdminNav';
import { StatusBadge } from '../../components/StatusBadge';
import type { DiscountStatus } from '../../db/schema';
import { formatMoney } from '../../components/ProductCard';
import {
  btnDestructive,
  btnGhost,
  btnPrimary,
  cardCls,
  hintCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
  tableCls,
  tableWrap,
} from '../../components/ui';

type DiscountRow = {
  id: string;
  code: string;
  type: string;
  value: number;
  status: DiscountStatus;
  usage_count: number;
  min_purchase_cents: number;
  usage_limit: number | null;
  expires_at: string | null;
};

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .handler(async () => {
    const { env } = await import('cloudflare:workers');
    const [rows, count] = await Promise.all([
      env.DB.prepare(
        'SELECT id, code, type, value, status, usage_count, min_purchase_cents, usage_limit, expires_at FROM discounts ORDER BY created_at DESC LIMIT 100'
      ).all<DiscountRow>(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM discounts').first<{ n: number }>(),
    ]);
    return { discounts: rows.results, total: count?.n ?? rows.results.length };
  });

export const Route = createFileRoute('/admin/discounts')({
  loader: async () => getData(),
  component: Page,
});

function describe(d: DiscountRow, currency: string) {
  return d.type === 'percentage' ? `${d.value}% off` : `${formatMoney(d.value, currency)} off`;
}

function Page() {
  const adminAction = useAdminAction();

  const currency = useStoreCurrency();
  const { discounts, total } = Route.useLoaderData();
  const router = useRouter();
  const [form, setForm] = useState({
    code: '',
    type: 'percentage',
    value: '10',
    minPurchase: '',
    usageLimit: '',
    expiresAt: '',
  });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action: string, payload: AdminPayload, ok: string) {
    setBusy(true);
    const r = await adminAction(action, payload);
    setBusy(false);
    if (r.ok) {
      setMsg(ok);
      router.invalidate();
    } else setMsg(r.error ?? 'Failed');
  }

  return (
    <main>
      <h1 className={pageTitle}>Discounts</h1>
      <p className={pageSub}>
        Codes customers enter in the cart. Every code is re-validated on the server at checkout, so
        limits and expiry are enforced there, not in the browser.
        {total > discounts.length
          ? ` Showing the latest ${discounts.length} of ${total} codes.`
          : ''}
      </p>

      <section className={`${cardCls} mt-6 overflow-hidden`}>
        {discounts.length === 0 ? (
          <p className="p-5 text-sm text-zinc-500" role="status">
            No discount codes yet. Create your first one below.
          </p>
        ) : (
          <div className={tableWrap}>
            <table className={tableCls}>
              <caption className="sr-only">Discount codes</caption>
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Discount</th>
                  <th scope="col">Conditions</th>
                  <th scope="col">Used</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {discounts.map((d) => (
                  <tr key={d.id}>
                    <td className="font-mono text-[13px] font-medium">{d.code}</td>
                    <td>{describe(d, currency)}</td>
                    <td className="text-zinc-500">
                      {[
                        d.min_purchase_cents > 0
                          ? `Min ${formatMoney(d.min_purchase_cents, currency)}`
                          : null,
                        d.usage_limit != null ? `Limit ${d.usage_limit}` : null,
                        d.expires_at ? `Expires ${formatDate(d.expires_at)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'No conditions'}
                    </td>
                    <td className="text-zinc-500">{d.usage_count}×</td>
                    <td>
                      <StatusBadge value={d.status} />
                    </td>
                    <td className="text-right">
                      <span className="inline-flex gap-1">
                        <button
                          className={btnGhost}
                          disabled={busy}
                          onClick={() =>
                            run(
                              'discount.toggle',
                              { discountId: d.id, active: d.status !== 'active' },
                              `${d.code} is now ${d.status !== 'active' ? 'active' : 'inactive'}.`
                            )
                          }
                        >
                          {d.status === 'active' ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          className={btnDestructive}
                          disabled={busy}
                          onClick={async () => {
                            if (
                              !window.confirm(
                                `Delete discount code ${d.code}? Customers can no longer use it.`
                              )
                            )
                              return;
                            await run(
                              'discount.delete',
                              { discountId: d.id },
                              `${d.code} deleted.`
                            );
                          }}
                        >
                          Delete
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form
        className={`${cardCls} mt-5 space-y-4 p-5 sm:p-6`}
        onSubmit={async (e) => {
          e.preventDefault();
          await run(
            'discount.create',
            {
              code: form.code,
              type: form.type,
              value:
                form.type === 'percentage'
                  ? Number(form.value)
                  : Math.round(Number(form.value) * 100),
              minPurchaseCents: form.minPurchase ? Math.round(Number(form.minPurchase) * 100) : 0,
              usageLimit: form.usageLimit ? Number(form.usageLimit) : null,
              expiresAt: form.expiresAt || null,
            },
            `Discount ${form.code.toUpperCase()} created.`
          );
        }}
      >
        <h2 className="text-sm font-medium text-zinc-950">Create discount code</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className={labelCls} htmlFor="d-code">
              Code
            </label>
            <input
              id="d-code"
              placeholder="SUMMER10"
              className={inputCls}
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="d-kind">
              Type
            </label>
            <select
              id="d-kind"
              className={inputCls}
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              <option value="percentage">Percentage off</option>
              <option value="fixed_amount">Fixed amount off</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="d-value">
              {form.type === 'percentage' ? 'Percent off' : 'Amount off ($)'}
            </label>
            <input
              id="d-value"
              inputMode="decimal"
              placeholder="10"
              className={inputCls}
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
            />
            <p className={hintCls}>
              {form.type === 'percentage' ? '10 means 10% off.' : '10.00 means $10.00 off.'}
            </p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className={labelCls} htmlFor="d-min">
              Minimum order ($)
            </label>
            <input
              id="d-min"
              inputMode="decimal"
              placeholder="No minimum"
              className={inputCls}
              value={form.minPurchase}
              onChange={(e) => setForm({ ...form, minPurchase: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="d-limit">
              Total uses
            </label>
            <input
              id="d-limit"
              inputMode="numeric"
              placeholder="Unlimited"
              className={inputCls}
              value={form.usageLimit}
              onChange={(e) => setForm({ ...form, usageLimit: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="d-expires">
              Expires
            </label>
            <input
              id="d-expires"
              type="date"
              className={inputCls}
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
            />
          </div>
        </div>
        <button className={btnPrimary} type="submit" disabled={busy || !form.code}>
          {busy ? 'Creating…' : 'Create discount'}
        </button>
      </form>
      {msg ? (
        <p className="mt-4 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700" role="status">
          {msg}
        </p>
      ) : null}
    </main>
  );
}
