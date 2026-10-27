import { useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { useStoreCurrency } from '../../lib/use-store-currency';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn, useServerFn } from '@tanstack/react-start';
import * as z from 'zod';
import { validateServerInput } from '../../server/function-boundary';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../components/AdminActionFeedback';
import { useAdminAction, type AdminPayload } from '../../components/AdminNav';
import { formatMoney } from '../../components/ProductCard';
import {
  btnPrimary,
  cardCls,
  hintCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
  tableCls,
} from '../../components/ui';

type Zone = {
  id: string;
  name: string;
  countries_json: string;
  rates: Array<{
    id: string;
    name: string;
    rate_cents: number;
    free_over_cents: number | null;
    kind: string;
    per_kg_cents: number | null;
  }>;
};

export function countryLabel(code: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase());
    return name ? `${name} (${code.toUpperCase()})` : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function rateKindLabel(kind: string): string {
  if (kind === 'weight') return 'Weight based';
  if (kind === 'free_over') return 'Free over threshold';
  return 'Flat';
}

const previewQuoteFn = createServerFn({ method: 'POST' })
  .middleware([staffMiddleware])
  .validator(
    validateServerInput(
      z.object({
        rateId: z.string().min(1).max(200),
        country: z
          .string()
          .trim()
          .length(2)
          .transform((s) => s.toUpperCase()),
        subtotalCents: z.number().int().min(0).max(100_000_000),
        weightGrams: z.number().int().min(0).max(1_000_000),
      })
    )
  )
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const { calculateShipping } = await import('../../server/checkout');
    try {
      const cents = await calculateShipping(
        env.DB,
        data.rateId,
        data.subtotalCents,
        data.weightGrams,
        data.country
      );
      return { ok: true as const, cents };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : 'Quote unavailable' };
    }
  });

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .handler(async () => {
    const { env } = await import('cloudflare:workers');
    const zones = await env.DB.prepare(
      'SELECT id, name, countries_json FROM shipping_zones ORDER BY name'
    ).all<{ id: string; name: string; countries_json: string }>();
    const out: Zone[] = [];
    for (const z of zones.results) {
      const rates = await env.DB.prepare(
        'SELECT id, name, amount_cents AS rate_cents, free_over_cents, kind, per_kg_cents FROM shipping_rates WHERE zone_id = ? ORDER BY amount_cents'
      )
        .bind(z.id)
        .all<Zone['rates'][number]>();
      out.push({ ...z, rates: rates.results });
    }
    return out;
  });

export const Route = createFileRoute('/admin/shipping')({
  loader: async () => getData(),
  component: Page,
});

function Page() {
  const adminAction = useAdminAction();

  const currency = useStoreCurrency();
  const zones = Route.useLoaderData();
  const router = useRouter();
  const [zone, setZone] = useState({ name: '', countries: 'US' });
  const [rate, setRate] = useState({
    zoneId: '',
    name: 'Standard',
    dollars: '0.00',
    freeOver: '',
    kind: 'flat',
    perKg: '',
  });
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    rateId: string;
    rateName: string;
    lastRate: boolean;
  } | null>(null);
  const [quote, setQuote] = useState({
    rateId: '',
    country: 'US',
    subtotal: '100.00',
    weightKg: '1',
  });
  const [quoteMsg, setQuoteMsg] = useState('');
  const previewQuote = useServerFn(previewQuoteFn);
  const [busy, setBusy] = useState(false);

  async function run(action: string, payload: AdminPayload, ok: string) {
    setBusy(true);
    const r = await adminAction(action, payload);
    setBusy(false);
    if (r.ok) {
      setFeedback({ kind: 'status', message: ok });
      router.invalidate();
    } else setFeedback({ kind: 'error', message: r.error ?? 'Failed' });
  }

  return (
    <main>
      <h1 className={pageTitle}>Shipping</h1>
      <p className={pageSub}>
        Zones group countries together; each zone needs at least one rate before customers there can
        check out. A $0 rate is free shipping, and a free-over threshold makes shipping free above
        an order total.
      </p>
      <AdminActionFeedback value={feedback} />

      <div className="mt-6 space-y-4">
        {zones.length === 0 ? (
          <p className={`${cardCls} p-5 text-sm text-zinc-500`} role="status">
            No shipping zones yet. Create your first zone below, for example “United States” with
            country code US.
          </p>
        ) : (
          zones.map((z) => (
            <section key={z.id} className={`${cardCls} overflow-hidden`}>
              <div className="flex flex-wrap items-baseline gap-x-3 px-5 pt-4 pb-3">
                <h2 className="text-sm font-medium text-zinc-950">{z.name}</h2>
                <span className="text-[13px] text-zinc-500">
                  {(JSON.parse(z.countries_json) as string[]).map(countryLabel).join(', ')}
                </span>
              </div>
              {z.rates.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-yellow-800" role="status">
                  No rates yet. Checkout cannot sell to this zone until you add one below.
                </p>
              ) : (
                <table className={tableCls}>
                  <caption className="sr-only">Shipping rates for {z.name}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Rate</th>
                      <th scope="col">Type</th>
                      <th scope="col">Price</th>
                      <th scope="col">Free over</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {z.rates.map((r) => (
                      <tr key={r.id}>
                        <td className="font-medium">{r.name}</td>
                        <td className="text-zinc-500">{rateKindLabel(r.kind)}</td>
                        <td>
                          {r.kind === 'weight'
                            ? `Base + ${formatMoney(r.per_kg_cents ?? 0, currency)}/kg: `
                            : ''}
                          {r.rate_cents === 0 ? 'Free' : formatMoney(r.rate_cents, currency)}
                        </td>
                        <td className="text-zinc-500">
                          {r.free_over_cents != null
                            ? formatMoney(r.free_over_cents, currency)
                            : '—'}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="text-sm text-red-700 underline"
                            disabled={busy}
                            onClick={() =>
                              setPendingDelete({
                                rateId: r.id,
                                rateName: r.name,
                                lastRate: z.rates.length === 1,
                              })
                            }
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))
        )}
      </div>

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-2">
        <form
          className={`${cardCls} space-y-4 p-5 sm:p-6`}
          onSubmit={async (e) => {
            e.preventDefault();
            await run(
              'shipping.createZone',
              {
                name: zone.name,
                countries: zone.countries
                  .split(',')
                  .map((s) => s.trim().toUpperCase())
                  .filter(Boolean),
              },
              'Zone created. Add a rate to it below.'
            );
          }}
        >
          <h2 className="text-sm font-medium text-zinc-950">Create zone</h2>
          <div>
            <label className={labelCls} htmlFor="z-name">
              Zone name
            </label>
            <input
              id="z-name"
              placeholder="United States"
              className={inputCls}
              value={zone.name}
              onChange={(e) => setZone({ ...zone, name: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="z-countries">
              Country codes
            </label>
            <input
              id="z-countries"
              placeholder="US, CA"
              className={inputCls}
              value={zone.countries}
              onChange={(e) => setZone({ ...zone, countries: e.target.value })}
            />
            <p className={hintCls}>ISO country codes, separated by commas.</p>
          </div>
          <button className={btnPrimary} type="submit" disabled={busy || !zone.name}>
            {busy ? 'Creating…' : 'Create zone'}
          </button>
        </form>

        <form
          className={`${cardCls} space-y-4 p-5 sm:p-6`}
          onSubmit={async (e) => {
            e.preventDefault();
            await run(
              'shipping.addRate',
              {
                zoneId: rate.zoneId,
                name: rate.name,
                kind: rate.kind,
                perKgCents: rate.perKg ? Math.round(Number(rate.perKg) * 100) : null,
                rateCents: Math.round(Number(rate.dollars) * 100),
                freeOverCents: rate.freeOver ? Math.round(Number(rate.freeOver) * 100) : null,
              },
              'Rate added.'
            );
          }}
        >
          <h2 className="text-sm font-medium text-zinc-950">Add rate</h2>
          <label className={labelCls}>
            Rate type
            <select
              className={inputCls}
              value={rate.kind}
              onChange={(e) => setRate({ ...rate, kind: e.target.value })}
            >
              <option value="flat">Flat</option>
              <option value="weight">Weight</option>
              <option value="free_over">Free over threshold</option>
            </select>
          </label>
          {rate.kind === 'weight' ? (
            <label className={labelCls}>
              Per started kg ($)
              <input
                className={inputCls}
                value={rate.perKg}
                onChange={(e) => setRate({ ...rate, perKg: e.target.value })}
              />
            </label>
          ) : null}
          <div>
            <label className={labelCls} htmlFor="r-zone">
              Zone
            </label>
            <select
              id="r-zone"
              className={inputCls}
              value={rate.zoneId}
              onChange={(e) => setRate({ ...rate, zoneId: e.target.value })}
            >
              <option value="">Select a zone</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="r-name">
              Rate name
            </label>
            <input
              id="r-name"
              placeholder="Standard"
              className={inputCls}
              value={rate.name}
              onChange={(e) => setRate({ ...rate, name: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="r-price">
                Price ($)
              </label>
              <input
                id="r-price"
                inputMode="decimal"
                className={inputCls}
                value={rate.dollars}
                onChange={(e) => setRate({ ...rate, dollars: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="r-free">
                Free over ($)
              </label>
              <input
                id="r-free"
                inputMode="decimal"
                placeholder="Optional"
                className={inputCls}
                value={rate.freeOver}
                onChange={(e) => setRate({ ...rate, freeOver: e.target.value })}
              />
            </div>
          </div>
          <button className={btnPrimary} type="submit" disabled={busy || !rate.zoneId}>
            {busy ? 'Adding…' : 'Add rate'}
          </button>
        </form>
      </div>
      <form
        className={`${cardCls} mt-5 space-y-4 p-5 sm:p-6`}
        onSubmit={async (e) => {
          e.preventDefault();
          setQuoteMsg('');
          const r = await previewQuote({
            data: {
              rateId: quote.rateId,
              country: quote.country,
              subtotalCents: Math.round(Number(quote.subtotal || 0) * 100),
              weightGrams: Math.round(Number(quote.weightKg || 0) * 1000),
            },
          });
          setQuoteMsg(
            r.ok
              ? `Sample quote: ${r.cents === 0 ? 'Free' : formatMoney(r.cents, currency)}`
              : (r.error ?? 'Quote unavailable')
          );
        }}
      >
        <h2 className="text-sm font-medium text-zinc-950">Sample quote</h2>
        <p className={hintCls}>
          Uses the same shipping calculation as checkout. Changing the sample does not change any
          rate.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="q-rate">
              Rate
            </label>
            <select
              id="q-rate"
              className={inputCls}
              value={quote.rateId}
              onChange={(e) => setQuote({ ...quote, rateId: e.target.value })}
            >
              <option value="">Select a rate</option>
              {zones.flatMap((z) =>
                z.rates.map((r) => (
                  <option key={r.id} value={r.id}>
                    {z.name}: {r.name}
                  </option>
                ))
              )}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="q-country">
              Country code
            </label>
            <input
              id="q-country"
              className={inputCls}
              value={quote.country}
              onChange={(e) => setQuote({ ...quote, country: e.target.value.toUpperCase() })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="q-subtotal">
              Order subtotal ($)
            </label>
            <input
              id="q-subtotal"
              inputMode="decimal"
              className={inputCls}
              value={quote.subtotal}
              onChange={(e) => setQuote({ ...quote, subtotal: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="q-weight">
              Total weight (kg)
            </label>
            <input
              id="q-weight"
              inputMode="decimal"
              className={inputCls}
              value={quote.weightKg}
              onChange={(e) => setQuote({ ...quote, weightKg: e.target.value })}
            />
          </div>
        </div>
        <button className={btnPrimary} type="submit" disabled={!quote.rateId}>
          Preview quote
        </button>
        {quoteMsg ? (
          <p className="text-sm text-zinc-700" role="status">
            {quoteMsg}
          </p>
        ) : null}
      </form>
      <ConfirmDialog
        request={
          pendingDelete
            ? {
                title: `Delete rate ${pendingDelete.rateName}?`,
                body: pendingDelete.lastRate
                  ? 'This is the last rate in its zone. Customers in that zone will not be able to check out until you add another rate.'
                  : 'Customers will no longer be able to choose this rate at checkout.',
                confirmLabel: 'Delete rate',
              }
            : null
        }
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          const rateId = pendingDelete.rateId;
          setPendingDelete(null);
          await run('shipping.deleteRate', { rateId }, 'Rate deleted.');
        }}
      />
    </main>
  );
}
