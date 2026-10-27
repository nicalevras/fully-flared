import { useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { useStoreCurrency } from '../../lib/use-store-currency';
import { formatDate } from '../../lib/format';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import * as z from 'zod';
import { validateServerInput } from '../../server/function-boundary';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { btnPrimary as primaryBtn } from '../../components/ui';
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
  .validator(validateServerInput(z.object({ q: z.string().max(64).default('') })))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const q = data.q.trim().toUpperCase();
    const [rows, count] = await Promise.all([
      q
        ? env.DB.prepare(
            "SELECT id, code, type, value, status, usage_count, min_purchase_cents, usage_limit, expires_at FROM discounts WHERE code LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 100"
          )
            .bind(`${q.replace(/[\\%_]/g, '\\$&')}%`)
            .all<DiscountRow>()
        : env.DB.prepare(
            'SELECT id, code, type, value, status, usage_count, min_purchase_cents, usage_limit, expires_at FROM discounts ORDER BY created_at DESC LIMIT 100'
          ).all<DiscountRow>(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM discounts').first<{ n: number }>(),
    ]);
    return { discounts: rows.results, total: count?.n ?? rows.results.length };
  });

export const Route = createFileRoute('/admin/discounts')({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q.slice(0, 64) : '',
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getData({ data: deps }),
  component: Page,
});

function describe(d: DiscountRow, currency: string) {
  return d.type === 'percentage' ? `${d.value}% off` : `${formatMoney(d.value, currency)} off`;
}

function Page() {
  const adminAction = useAdminAction();

  const currency = useStoreCurrency();
  const { discounts, total } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [codeQuery, setCodeQuery] = useState(search.q);
  const [editingId, setEditingId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DiscountRow | null>(null);
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

  async function run(action: string, payload: AdminPayload, ok: string): Promise<boolean> {
    setBusy(true);
    const r = await adminAction(action, payload);
    setBusy(false);
    if (r.ok) {
      setMsg(ok);
      router.invalidate();
      return true;
    }
    setMsg(r.error ?? 'Failed');
    return false;
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

      <form
        className={`${cardCls} mt-5 flex flex-wrap items-end gap-3 p-4`}
        onSubmit={(event) => {
          event.preventDefault();
          void navigate({ search: { q: codeQuery.trim() } });
        }}
      >
        <div className="min-w-52 flex-1">
          <label className={labelCls} htmlFor="discount-q">
            Find a code
          </label>
          <input
            id="discount-q"
            className={inputCls}
            value={codeQuery}
            onChange={(event) => setCodeQuery(event.target.value)}
            placeholder="SUMMER"
          />
        </div>
        <button type="submit" className={primaryBtn}>
          Search
        </button>
      </form>

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
                          type="button"
                          className={btnGhost}
                          disabled={busy}
                          onClick={() => {
                            setEditingId(d.id);
                            setForm({
                              code: d.code,
                              type: d.type,
                              value:
                                d.type === 'percentage'
                                  ? String(d.value)
                                  : (d.value / 100).toFixed(2),
                              minPurchase: d.min_purchase_cents
                                ? (d.min_purchase_cents / 100).toFixed(2)
                                : '',
                              usageLimit: d.usage_limit != null ? String(d.usage_limit) : '',
                              expiresAt: d.expires_at ? d.expires_at.slice(0, 10) : '',
                            });
                            document
                              .getElementById('discount-form')
                              ?.scrollIntoView({ behavior: 'smooth' });
                          }}
                        >
                          Edit
                        </button>
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
                          onClick={() => setDeleteTarget(d)}
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
        id="discount-form"
        className={`${cardCls} mt-5 space-y-4 p-5 sm:p-6`}
        onSubmit={async (e) => {
          e.preventDefault();
          const succeeded = await run(
            editingId ? 'discount.update' : 'discount.create',
            {
              ...(editingId ? { discountId: editingId } : {}),
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
            editingId
              ? `Discount ${form.code.toUpperCase()} updated. Checkout validates the new terms on the next order.`
              : `Discount ${form.code.toUpperCase()} created.`
          );
          // FF-05: a failed update keeps the merchant in edit mode with
          // their input intact. Only success leaves editing.
          if (succeeded && editingId) setEditingId('');
        }}
      >
        <h2 className="text-sm font-medium text-zinc-950">
          {editingId ? `Edit discount ${form.code}` : 'Create discount code'}
        </h2>
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
        <span className="flex flex-wrap gap-2">
          <button className={btnPrimary} type="submit" disabled={busy || !form.code}>
            {busy ? 'Saving…' : editingId ? 'Save discount' : 'Create discount'}
          </button>
          {editingId ? (
            <button
              type="button"
              className={btnGhost}
              disabled={busy}
              onClick={() => {
                setEditingId('');
                setForm({
                  code: '',
                  type: 'percentage',
                  value: '10',
                  minPurchase: '',
                  usageLimit: '',
                  expiresAt: '',
                });
              }}
            >
              Cancel edit
            </button>
          ) : null}
        </span>
      </form>
      <ConfirmDialog
        request={
          deleteTarget
            ? {
                title: 'Delete this discount?',
                body: `Delete discount code ${deleteTarget.code}? Customers can no longer use it. Orders already placed keep their recorded totals.`,
                confirmLabel: 'Delete discount',
              }
            : null
        }
        busy={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          const d = deleteTarget;
          setDeleteTarget(null);
          if (d) await run('discount.delete', { discountId: d.id }, `${d.code} deleted.`);
        }}
      />
      {msg ? (
        <p className="mt-4 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700" role="status">
          {msg}
        </p>
      ) : null}
    </main>
  );
}
