import { useEffect, useRef, useState } from 'react';
import { createServerFn, useServerFn } from '@tanstack/react-start';
import { Link } from '@tanstack/react-router';
import * as z from 'zod';
import { staffMiddleware } from '../server/staff-middleware';
import { validateServerInput } from '../server/function-boundary';
import { roleCan } from '../lib/permissions';
import type { GlobalSearchResult } from '../server/admin-global-search';
import { createSearchGate, runLatestSearch } from '../lib/global-search';
import { usePaletteNavigation } from '../lib/use-palette-navigation';
import { SearchIcon } from './icons';
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

export function GlobalSearchMobileTrigger() {
  return (
    <button
      type="button"
      aria-label="Open global search"
      className="ml-auto flex size-10 shrink-0 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-50"
      onClick={() => window.dispatchEvent(new Event(GLOBAL_SEARCH_EVENT))}
    >
      <SearchIcon className="size-5" />
    </button>
  );
}

export function GlobalSearchDialog() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [result, setResult] = useState<GlobalSearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const gate = useRef(createSearchGate());
  const queryRef = useRef('');
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const run = useServerFn(searchFn);
  const { active, reset, onKeyDown: paletteKeyDown } = usePaletteNavigation();

  const close = () => {
    gate.current.invalidate();
    setOpen(false);
    setQ('');
    queryRef.current = '';
    setResult(null);
    setSearchError(null);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target) requestAnimationFrame(() => target.focus({ preventScroll: true }));
  };

  useEffect(() => {
    const openDialog = () => {
      if (document.activeElement instanceof HTMLElement) {
        returnFocusRef.current = document.activeElement;
      }
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openDialog();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(GLOBAL_SEARCH_EVENT, openDialog);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(GLOBAL_SEARCH_EVENT, openDialog);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    queryRef.current = q;
    const query = q.trim();
    if (!open || query.length < 2) return;
    const timer = setTimeout(async () => {
      try {
        const outcome = await runLatestSearch(
          gate.current,
          query,
          () => queryRef.current,
          (value) => run({ data: { q: value } })
        );
        if (outcome.applied) {
          setResult(outcome.value);
          setSearchError(null);
          reset();
        }
      } catch {
        setResult(null);
        setSearchError('Search failed. Check your connection and try again.');
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [open, q, run, reset]);

  if (!open) return null;
  const linkCount =
    (result?.products.length ?? 0) + (result?.orders.length ?? 0) + (result?.customers.length ?? 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-950/40 p-4 pt-20"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
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
          onChange={(e) => {
            setQ(e.target.value);
            if (e.target.value.trim().length < 2) {
              gate.current.invalidate();
              setResult(null);
              setSearchError(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            else
              paletteKeyDown(e, linkCount, (index) => {
                listRef.current?.querySelectorAll('a')[index]?.click();
              });
          }}
        />
        {searchError ? (
          <p className="mt-3 text-sm text-red-700" role="alert">
            {searchError}
          </p>
        ) : result ? (
          <div className="mt-3 space-y-4">
            {result.products.length ? (
              <div>
                <h2 className="text-[11px] font-medium text-zinc-500">Products</h2>
                <ul>
                  {result.products.map((p, i) => (
                    <li key={p.id}>
                      <Link
                        to="/admin/products"
                        search={{ edit: p.id }}
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
