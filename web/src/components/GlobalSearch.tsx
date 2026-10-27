import { useEffect, useRef, useState } from 'react';
import { createServerFn, useServerFn } from '@tanstack/react-start';
import { Link } from '@tanstack/react-router';
import * as z from 'zod';
import { staffMiddleware } from '../server/staff-middleware';
import { validateServerInput } from '../server/function-boundary';
import { roleCan } from '../lib/permissions';
import type { GlobalSearchResult } from '../server/admin-global-search';
import { cardCls, inputCls } from './ui';

const searchFn = createServerFn({ method: 'POST' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(z.object({ q: z.string().max(200) })))
  .handler(async ({ context, data }): Promise<GlobalSearchResult> => {
    const { env } = await import('cloudflare:workers');
    const { globalSearch } = await import('../server/admin-global-search');
    const role = context.staff.role;
    return globalSearch(env.DB, data.q, {
      orders: roleCan(role, 'order', 'view'),
      customers: roleCan(role, 'user', 'list'),
    });
  });

export const GLOBAL_SEARCH_EVENT = 'ff:open-global-search';

export function GlobalSearchTrigger() {
  return (
    <button
      type="button"
      className="mx-3 mb-3 flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-[13px] text-zinc-500 hover:bg-zinc-50"
      onClick={() => window.dispatchEvent(new Event(GLOBAL_SEARCH_EVENT))}
    >
      <span>Search</span>
      <span aria-hidden="true">Ctrl K</span>
    </button>
  );
}

export function GlobalSearchDialog() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [result, setResult] = useState<GlobalSearchResult | null>(null);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const run = useServerFn(searchFn);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(GLOBAL_SEARCH_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(GLOBAL_SEARCH_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) {
      setResult(null);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      const r = await run({ data: { q: query } });
      if (seq.current === mine) {
        setResult(r);
        setActive(0);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [open, q, run]);

  if (!open) return null;
  const close = () => {
    seq.current++;
    setOpen(false);
    setQ('');
    setResult(null);
  };
  const linkCount =
    (result?.products.length ?? 0) + (result?.orders.length ?? 0) + (result?.customers.length ?? 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-950/40 p-4 pt-20">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
        className={`${cardCls} w-full max-w-lg p-4`}
        ref={listRef}
      >
        <label className="sr-only" htmlFor="ff-global-search">
          Search products, orders, and customers
        </label>
        <input
          id="ff-global-search"
          className={inputCls}
          autoFocus
          value={q}
          placeholder="Search products, orders, customers"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, Math.max(linkCount - 1, 0)));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              listRef.current?.querySelectorAll('a')[active]?.click();
            }
          }}
        />
        {result ? (
          <div className="mt-3 space-y-4">
            {result.products.length ? (
              <div>
                <h2 className="text-[11px] font-medium text-zinc-500">Products</h2>
                <ul>
                  {result.products.map((p, i) => (
                    <li key={p.id}>
                      <Link
                        to="/admin/products/$id"
                        params={{ id: p.id }}
                        onClick={close}
                        className={
                          i === active
                            ? 'block bg-zinc-100 px-2 py-1.5 text-sm'
                            : 'block px-2 py-1.5 text-sm'
                        }
                      >
                        {p.title} <span className="text-zinc-500">{p.status}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {result.orders.length ? (
              <div>
                <h2 className="text-[11px] font-medium text-zinc-500">Orders</h2>
                <ul>
                  {result.orders.map((o, i) => (
                    <li key={o.id}>
                      <Link
                        to="/admin/orders/$id"
                        params={{ id: o.id }}
                        onClick={close}
                        className={
                          result.products.length + i === active
                            ? 'block bg-zinc-100 px-2 py-1.5 text-sm'
                            : 'block px-2 py-1.5 text-sm'
                        }
                      >
                        {o.number} <span className="text-zinc-500">{o.customer_email}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {result.customers.length ? (
              <div>
                <h2 className="text-[11px] font-medium text-zinc-500">Customers</h2>
                <ul>
                  {result.customers.map((c, i) => (
                    <li key={c.email}>
                      {c.accountId ? (
                        <Link
                          to="/admin/customers/$id"
                          params={{ id: c.accountId }}
                          onClick={close}
                          className={
                            result.products.length + result.orders.length + i === active
                              ? 'block bg-zinc-100 px-2 py-1.5 text-sm'
                              : 'block px-2 py-1.5 text-sm'
                          }
                        >
                          {c.email} <span className="text-zinc-500">account</span>
                        </Link>
                      ) : (
                        <Link
                          to="/admin/customers"
                          search={{ page: 1, q: c.email, email: '' }}
                          onClick={close}
                          className={
                            result.products.length + result.orders.length + i === active
                              ? 'block bg-zinc-100 px-2 py-1.5 text-sm'
                              : 'block px-2 py-1.5 text-sm'
                          }
                        >
                          {c.email} <span className="text-zinc-500">guest orders</span>
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {linkCount === 0 ? (
              <p className="text-sm text-zinc-500" role="status">
                No matches. Try a product title, SKU, order number, or email.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-zinc-500" role="status">
            Type at least two characters. Results link straight to the record.
          </p>
        )}
        <button type="button" className="mt-3 text-[13px] text-zinc-500 underline" onClick={close}>
          Close
        </button>
      </div>
    </div>
  );
}
