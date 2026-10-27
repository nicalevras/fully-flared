import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import * as z from 'zod';
import { staffMiddleware } from '../../server/staff-middleware';
import { validateServerInput } from '../../server/function-boundary';
import { useAdminAction } from '../../components/AdminNav';
import {
  applyMultiOutcome,
  parseMultiAdjustments,
  retryableItems,
  summarizeMulti,
  type MultiAdjustmentItem,
} from '../../lib/inventory-multi';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../components/AdminActionFeedback';
import {
  btnPrimary,
  btnSmall,
  cardCls,
  hintCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
  tableCls,
  tableWrap,
} from '../../components/ui';

const inventoryInput = z.object({
  q: z.string().max(200).optional().default(''),
  sku: z.string().max(100).optional().default(''),
});

type InventoryDetail = {
  sku: string;
  variantTitle: string;
  productId: string;
  productTitle: string;
  onHand: number;
  reserved: number;
  available: number;
  history: Array<{
    id: string;
    delta_on_hand: number;
    delta_reserved: number;
    reason: string;
    created_at: string;
  }>;
};

type InventoryData = {
  matches: Array<{ sku: string; variantTitle: string; productTitle: string }>;
  detail: InventoryDetail | null;
};

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(inventoryInput))
  .handler(async ({ data }): Promise<InventoryData> => {
    const { env } = await import('cloudflare:workers');
    const db = env.DB;
    const q = data.q.trim();
    const matches = q
      ? (
          await db
            .prepare(
              `SELECT v.sku, v.title AS variantTitle, p.title AS productTitle
               FROM variants v JOIN products p ON p.id = v.product_id
               WHERE v.sku LIKE ? ESCAPE '\\' OR p.title LIKE ? ESCAPE '\\'
               ORDER BY v.sku LIMIT 20`
            )
            .bind(`${q.replace(/[\\%_]/g, '\\$&')}%`, `%${q.replace(/[\\%_]/g, '\\$&')}%`)
            .all<{ sku: string; variantTitle: string; productTitle: string }>()
        ).results
      : [];
    const sku = data.sku.trim();
    if (!sku) return { matches, detail: null };
    const head = await db
      .prepare(
        `SELECT v.sku, v.title AS variantTitle, v.product_id AS productId, p.title AS productTitle,
                COALESCE(s.on_hand, 0) AS onHand, COALESCE(s.reserved, 0) AS reserved
         FROM variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN stock s ON s.sku = v.sku
         WHERE v.sku = ?`
      )
      .bind(sku)
      .first<{
        sku: string;
        variantTitle: string;
        productId: string;
        productTitle: string;
        onHand: number;
        reserved: number;
      }>();
    if (!head) return { matches, detail: null };
    const history = await db
      .prepare(
        'SELECT id, delta_on_hand, delta_reserved, reason, created_at FROM stock_ledger WHERE sku = ? ORDER BY created_at DESC, id DESC LIMIT 50'
      )
      .bind(sku)
      .all<InventoryDetail['history'][number]>();
    return {
      matches,
      detail: {
        ...head,
        available: head.onHand - head.reserved,
        history: history.results,
      },
    };
  });

export const Route = createFileRoute('/admin/inventory')({
  validateSearch: (search: { q?: unknown; sku?: unknown }) => ({
    q: typeof search.q === 'string' ? search.q : '',
    sku: typeof search.sku === 'string' ? search.sku : '',
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getData({ data: deps }),
  component: AdminInventory,
});

function AdminInventory() {
  const adminAction = useAdminAction();
  const { matches, detail } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [query, setQuery] = useState(search.q);
  const [direction, setDirection] = useState<'increase' | 'decrease'>('increase');
  const [amount, setAmount] = useState('1');
  const [reason, setReason] = useState('restock');
  const [note, setNote] = useState('');
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [multiText, setMultiText] = useState('');
  const [multiReason, setMultiReason] = useState('restock');
  const [multiItems, setMultiItems] = useState<MultiAdjustmentItem[] | null>(null);
  const [multiBusy, setMultiBusy] = useState(false);

  async function runMulti(itemsToRun: MultiAdjustmentItem[]) {
    setMultiBusy(true);
    let current = multiItems ?? itemsToRun;
    for (const item of itemsToRun) {
      const result = await adminAction('stock.adjust', {
        sku: item.sku,
        delta: item.delta,
        reason: item.reason,
        note: item.note,
        operationId: item.operationId,
      });
      current = applyMultiOutcome(current, item.sku, {
        ok: result.ok,
        message: result.ok
          ? (result.data as { replayed?: boolean } | undefined)?.replayed
            ? 'Already recorded. Not applied twice.'
            : 'Recorded'
          : result.error,
      });
      setMultiItems(current);
    }
    setMultiBusy(false);
    const summary = summarizeMulti(current);
    if (summary.complete) {
      setFeedback({ kind: 'status', message: `All ${summary.total} adjustments recorded.` });
    } else if (summary.partial) {
      setFeedback({
        kind: 'error',
        message: `${summary.applied} of ${summary.total} adjustments recorded. Review the failed rows, then retry only those rows.`,
      });
    } else {
      setFeedback({
        kind: 'error',
        message: 'No adjustments were recorded. Review the rows below.',
      });
    }
  }

  return (
    <main>
      <h1 className={pageTitle}>Inventory</h1>
      <p className={pageSub}>
        Look up a SKU, see what is on hand, reserved, and available, and record adjustments that can
        never be applied twice.
      </p>
      <AdminActionFeedback value={feedback} />

      <form
        className={`${cardCls} mt-5 flex flex-wrap items-end gap-3 p-4`}
        onSubmit={(event) => {
          event.preventDefault();
          void navigate({ search: { q: query.trim(), sku: search.sku } });
        }}
      >
        <div className="min-w-48 flex-1">
          <label className={labelCls} htmlFor="inventory-q">
            Find a SKU or product
          </label>
          <input
            id="inventory-q"
            className={inputCls}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="SKU starts with, or part of a product title"
          />
        </div>
        <button type="submit" className={btnPrimary}>
          Search
        </button>
      </form>

      {matches.length > 0 ? (
        <ul className={`${cardCls} mt-4 divide-y divide-zinc-100`}>
          {matches.map((match) => (
            <li key={match.sku}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-zinc-50"
                onClick={() => void navigate({ search: { q: search.q, sku: match.sku } })}
              >
                <span className="font-medium text-zinc-950">{match.sku}</span>
                <span className="text-zinc-500">
                  {match.productTitle} · {match.variantTitle}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : search.q ? (
        <p className={`${cardCls} mt-4 p-4 text-sm text-zinc-500`} role="status">
          No SKUs match that search.
        </p>
      ) : null}

      {search.sku && !detail ? (
        <p className={`${cardCls} mt-4 p-4 text-sm text-zinc-500`} role="status">
          No stock record for {search.sku}.
        </p>
      ) : null}

      <section className={`${cardCls} mt-5 p-5`}>
        <h2 className="text-sm font-medium text-zinc-950">Adjust several SKUs</h2>
        <p className="mt-1 text-sm text-zinc-500">
          One SKU and a signed amount per line, for example TEE-1, 5 or HAT-2, -3. At most 20 SKUs
          at once. Review the list before anything is recorded.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="multi-lines">
              SKUs and amounts
            </label>
            <textarea
              id="multi-lines"
              className={inputCls}
              rows={5}
              value={multiText}
              onChange={(event) => {
                setMultiText(event.target.value);
                setMultiItems(null);
              }}
              placeholder={'TEE-1, 5\nHAT-2, -3'}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="multi-reason">
              Reason for every row
            </label>
            <select
              id="multi-reason"
              className={inputCls}
              value={multiReason}
              onChange={(event) => {
                setMultiReason(event.target.value);
                setMultiItems(null);
              }}
            >
              <option value="restock">Restock</option>
              <option value="correction">Correction</option>
              <option value="damaged">Damaged</option>
              <option value="return">Return</option>
            </select>
          </div>
        </div>
        {!multiItems ? (
          <button
            type="button"
            className={btnPrimary}
            onClick={() => {
              const parsed = parseMultiAdjustments(
                multiText,
                { reason: multiReason, note: '' },
                () => crypto.randomUUID()
              );
              if (parsed.errors.length > 0) {
                setFeedback({ kind: 'error', message: parsed.errors.join(' ') });
                return;
              }
              setMultiItems(parsed.items);
            }}
          >
            Review adjustments
          </button>
        ) : (
          <div className="mt-3">
            <div className={tableWrap} tabIndex={0} role="region" aria-label="Reviewed adjustments">
              <table className={`${tableCls} min-w-[520px]`}>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Change</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {multiItems.map((item) => (
                    <tr key={item.operationId}>
                      <td>{item.sku}</td>
                      <td>{item.delta > 0 ? `+${item.delta}` : item.delta}</td>
                      <td>
                        {item.status === 'pending'
                          ? 'Not recorded yet'
                          : item.status === 'applied'
                            ? item.message
                            : `Failed. ${item.message}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {summarizeMulti(multiItems).pending > 0 ? (
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={multiBusy}
                  onClick={() => void runMulti(retryableItems(multiItems))}
                >
                  {multiBusy ? 'Recording...' : 'Record reviewed adjustments'}
                </button>
              ) : null}
              {retryableItems(multiItems).length > 0 && summarizeMulti(multiItems).failed > 0 ? (
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={multiBusy}
                  onClick={() => void runMulti(retryableItems(multiItems))}
                >
                  Retry failed rows only
                </button>
              ) : null}
              <button
                type="button"
                className={btnSmall}
                disabled={multiBusy}
                onClick={() => setMultiItems(null)}
              >
                Edit list
              </button>
            </div>
            {summarizeMulti(multiItems).partial ? (
              <p className="mt-2 text-sm text-amber-700" role="status">
                Partial success. Recorded rows stay recorded. Retrying sends only the failed rows,
                with their original operation IDs, so nothing is adjusted twice.
              </p>
            ) : null}
          </div>
        )}
      </section>

      {detail ? (
        <>
          <section className={`${cardCls} mt-5 p-5 sm:p-6`}>
            <h2 className="text-sm font-medium text-zinc-950">
              {detail.sku} · {detail.productTitle} · {detail.variantTitle}
            </h2>
            <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
              <div className="rounded-xl bg-zinc-50 p-3">
                <dt className="text-xs text-zinc-500">On hand</dt>
                <dd className="text-lg font-medium text-zinc-950">{detail.onHand}</dd>
              </div>
              <div className="rounded-xl bg-zinc-50 p-3">
                <dt className="text-xs text-zinc-500">Reserved</dt>
                <dd className="text-lg font-medium text-zinc-950">{detail.reserved}</dd>
              </div>
              <div className="rounded-xl bg-zinc-50 p-3">
                <dt className="text-xs text-zinc-500">Available</dt>
                <dd className="text-lg font-medium text-zinc-950">{detail.available}</dd>
              </div>
            </dl>

            <form
              className="mt-5 grid gap-3 sm:grid-cols-4"
              onSubmit={async (event) => {
                event.preventDefault();
                const qty = Number(amount);
                if (!Number.isInteger(qty) || qty <= 0) {
                  setFeedback({ kind: 'error', message: 'Enter a whole amount above zero.' });
                  return;
                }
                setBusy(true);
                const result = await adminAction('stock.adjust', {
                  sku: detail.sku,
                  delta: direction === 'increase' ? qty : -qty,
                  reason,
                  note,
                  operationId,
                });
                setBusy(false);
                if (result.ok) {
                  const data = result.data as { replayed?: boolean } | undefined;
                  setFeedback({
                    kind: 'status',
                    message: data?.replayed
                      ? 'That adjustment was already recorded. Nothing changed twice.'
                      : 'Stock adjusted and written to the ledger.',
                  });
                  setOperationId(crypto.randomUUID());
                  setAmount('1');
                  setNote('');
                  void navigate({ search: { q: search.q, sku: detail.sku }, replace: true });
                } else {
                  setFeedback({
                    kind: 'error',
                    message:
                      result.error ??
                      'Adjustment failed. Retrying with the same details is safe; it will not apply twice.',
                  });
                }
              }}
            >
              <div>
                <label className={labelCls} htmlFor="adj-direction">
                  Adjustment
                </label>
                <select
                  id="adj-direction"
                  className={inputCls}
                  value={direction}
                  onChange={(event) =>
                    setDirection(event.target.value === 'decrease' ? 'decrease' : 'increase')
                  }
                >
                  <option value="increase">Increase</option>
                  <option value="decrease">Decrease</option>
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="adj-amount">
                  Amount
                </label>
                <input
                  id="adj-amount"
                  className={inputCls}
                  inputMode="numeric"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="adj-reason">
                  Reason
                </label>
                <select
                  id="adj-reason"
                  className={inputCls}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                >
                  <option value="restock">Restock</option>
                  <option value="correction">Correction</option>
                  <option value="damaged">Damaged</option>
                  <option value="return">Return</option>
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="adj-note">
                  Note (optional)
                </label>
                <input
                  id="adj-note"
                  className={inputCls}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
              <div className="sm:col-span-4">
                <button type="submit" className={btnPrimary} disabled={busy}>
                  {busy ? 'Adjusting...' : 'Record adjustment'}
                </button>
                <p className={hintCls}>
                  Every adjustment is written to the stock ledger. If a submission result is
                  uncertain, retrying with the same details replays safely instead of adjusting
                  twice.
                </p>
              </div>
            </form>
          </section>

          <section className={`${cardCls} mt-5 overflow-hidden`}>
            <div className="flex items-center justify-between p-4">
              <h2 className="text-sm font-medium text-zinc-950">Movement history</h2>
              <button
                type="button"
                className={btnSmall}
                onClick={() => {
                  const lines = [
                    'created_at,delta_on_hand,delta_reserved,reason',
                    ...detail.history.map(
                      (row) =>
                        `${row.created_at},${row.delta_on_hand},${row.delta_reserved},${row.reason}`
                    ),
                  ];
                  const url = URL.createObjectURL(
                    new Blob([lines.join('\n')], { type: 'text/csv' })
                  );
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = `inventory-${detail.sku}.csv`;
                  link.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Export CSV
              </button>
            </div>
            {detail.history.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-zinc-500" role="status">
                No movements recorded for this SKU yet.
              </p>
            ) : (
              <div className={tableWrap} tabIndex={0} role="region" aria-label="Stock movements">
                <table className={`${tableCls} min-w-[520px]`}>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>On hand change</th>
                      <th>Reserved change</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.history.map((row) => (
                      <tr key={row.id}>
                        <td>{row.created_at}</td>
                        <td>{row.delta_on_hand}</td>
                        <td>{row.delta_reserved}</td>
                        <td>{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}
