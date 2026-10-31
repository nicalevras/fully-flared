import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
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

type QueryState =
  { query: string; kind: 'result'; value: GlobalSearchResult } | { query: string; kind: 'failed' };

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
  const [queryState, setQueryState] = useState<QueryState | null>(null);
  const gate = useRef(createSearchGate());
  const queryRef = useRef('');
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const run = useServerFn(searchFn);
  const { active, reset, onKeyDown: paletteKeyDown } = usePaletteNavigation();

  const close = () => {
    gate.current.invalidate();
    setOpen(false);
    setQ('');
    queryRef.current = '';
    setQueryState(null);
    reset();
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
    queryRef.current = q;
    const query = q.trim();
    if (!open || query.length < 2) return;
    const searchGate = gate.current;
    const timer = setTimeout(async () => {
      try {
        const outcome = await runLatestSearch(
          searchGate,
          query,
          () => queryRef.current,
          (value) => run({ data: { q: value } })
        );
        if (outcome.applied) {
          setQueryState({ query, kind: 'result', value: outcome.value });
          reset();
        }
      } catch {
        setQueryState({ query, kind: 'failed' });
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      searchGate.invalidate();
    };
  }, [open, q, run, reset]);

  const currentState = queryState?.query === q.trim() ? queryState : null;
  const result = currentState?.kind === 'result' ? currentState.value : null;
  const failed = currentState?.kind === 'failed';
  const linkCount =
    (result?.products.length ?? 0) + (result?.orders.length ?? 0) + (result?.customers.length ?? 0);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-zinc-950/40" />
        <Dialog.Popup
          initialFocus={() =>
            window.matchMedia('(pointer: fine)').matches ? inputRef.current : listRef.current
          }
          finalFocus={returnFocusRef}
          aria-label="Global search"
          className={`${cardCls} fixed top-20 left-1/2 z-50 max-h-[calc(100dvh-6rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-y-auto p-4 outline-none`}
          ref={listRef}
        >
          <label className="sr-only" htmlFor="ff-global-search">
            Search products, orders, and customers
          </label>
          <input
            id="ff-global-search"
            className={inputCls}
            ref={inputRef}
            value={q}
            placeholder="Search products, orders, customers"
            onChange={(e) => {
              gate.current.invalidate();
              queryRef.current = e.target.value;
              setQ(e.target.value);
              setQueryState(null);
              reset();
            }}
            onKeyDown={(e) => {
              paletteKeyDown(e, linkCount, (index) => {
                listRef.current?.querySelectorAll('a')[index]?.click();
              });
            }}
          />
          {failed ? (
            <p className="mt-3 text-sm text-red-700" role="alert">
              Search failed. Check your connection and try again.
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
                  No matches. Try a product title, order number, or email.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-sm text-zinc-500" role="status">
              Type at least two characters. Results link straight to the record.
            </p>
          )}
          <button
            type="button"
            className="mt-3 text-[13px] text-zinc-500 underline"
            onClick={close}
          >
            Close
          </button>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
