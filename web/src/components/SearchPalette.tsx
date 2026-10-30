import { useEffect, useRef, useState } from 'react';
import { createServerFn, useServerFn } from '@tanstack/react-start';
import { useNavigate } from '@tanstack/react-router';
import * as z from 'zod';
import { validateServerInput } from '../server/function-boundary';
import type { PublishedProductCard } from '../server/catalog';
import { createSearchGate, runLatestSearch } from '../lib/global-search';
import { usePaletteNavigation } from '../lib/use-palette-navigation';
import { useStoreCurrency } from '../lib/use-store-currency';
import { formatMoney } from '../lib/format';
import { mediaUrl } from '../lib/media-url';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchIcon } from './icons';

type SuggestResult = { cards: PublishedProductCard[]; hasMore: boolean; limited?: true };

const suggest = createServerFn({ method: 'GET' })
  .validator(validateServerInput(z.object({ q: z.string().max(200) })))
  .handler(async ({ data }): Promise<SuggestResult> => {
    const { env } = await import('cloudflare:workers');
    const { getRequest, setResponseStatus } = await import('@tanstack/react-start/server');
    const { suggestCatalog } = await import('../server/catalog-discovery');
    const { storefrontLimited } = await import('../server/storefront-limit');
    const result = await suggestCatalog(env.DB, env, data.q, () =>
      storefrontLimited(env.STOREFRONT_LIMITER, 'search', getRequest())
    );
    if (result.limited) setResponseStatus(429);
    return result;
  });

const paletteSuggestions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<PublishedProductCard[]> => {
    const { env } = await import('cloudflare:workers');
    const { getPaletteSuggestions } = await import('../server/catalog-discovery');
    return getPaletteSuggestions(env.DB, env);
  }
);

let paletteSuggestionsCache: PublishedProductCard[] | null = null;

export const SEARCH_PALETTE_EVENT = 'ff:open-search-palette';

export function openSearchPalette() {
  window.dispatchEvent(new Event(SEARCH_PALETTE_EVENT));
}

type PaletteItem = {
  key: string;
  card: PublishedProductCard;
};

const itemCls =
  'relative flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm outline-hidden select-none';

export function SearchPaletteDialog() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [result, setResult] = useState<SuggestResult | null>(null);
  const [failed, setFailed] = useState(false);
  const gate = useRef(createSearchGate());
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef('');
  const cache = useRef(new Map<string, SuggestResult>());
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const run = useServerFn(suggest);
  const runSuggestions = useServerFn(paletteSuggestions);
  const navigate = useNavigate();
  const currency = useStoreCurrency();
  const [suggested, setSuggested] = useState<PublishedProductCard[] | null>(
    paletteSuggestionsCache
  );
  const suggestionsAsked = useRef(paletteSuggestionsCache !== null);

  const query = q.trim();
  const cards = result && !result.limited ? result.cards : [];
  const visibleCards = query.length >= 3 ? cards.slice(0, 8) : (suggested ?? []);
  const items: PaletteItem[] = visibleCards.map((card) => ({
    key: `product:${card.id}`,
    card,
  }));

  const close = () => {
    gate.current.invalidate();
    setOpen(false);
    setQ('');
    queryRef.current = '';
    setResult(null);
    setFailed(false);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target) requestAnimationFrame(() => target.focus({ preventScroll: true }));
  };

  const activate = (index: number) => {
    const item = items[index];
    if (!item) return;
    void navigate({ to: '/products/$slug', params: { slug: item.card.slug } });
    close();
  };

  const { active, setActive, reset, onKeyDown } = usePaletteNavigation(activate);
  const activeIndex = items.length > 0 ? Math.min(active, items.length - 1) : 0;

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
    window.addEventListener(SEARCH_PALETTE_EVENT, openDialog);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(SEARCH_PALETTE_EVENT, openDialog);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    if (window.matchMedia('(pointer: fine)').matches) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previousRoot = root.style.overflow;
    const previousBody = document.body.style.overflow;
    root.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previousRoot;
      document.body.style.overflow = previousBody;
    };
  }, [open]);

  useEffect(() => {
    if (!open || suggestionsAsked.current) return;
    suggestionsAsked.current = true;
    let cancelled = false;
    runSuggestions()
      .then((cards) => {
        paletteSuggestionsCache = cards;
        if (!cancelled) setSuggested(cards);
      })
      .catch(() => {
        if (!cancelled) setSuggested([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, runSuggestions]);

  useEffect(() => {
    queryRef.current = q;
    if (!open) return;
    if (query.length < 3) {
      gate.current.invalidate();
      setResult(null);
      setFailed(false);
      return;
    }
    const cached = cache.current.get(query.toLowerCase());
    if (cached) {
      setResult(cached);
      setFailed(false);
      reset();
      return;
    }
    setFailed(false);
    const timer = setTimeout(async () => {
      try {
        const outcome = await runLatestSearch(
          gate.current,
          query,
          () => queryRef.current,
          (value) => run({ data: { q: value } })
        );
        if (outcome.applied) {
          if (!outcome.value.limited) cache.current.set(query.toLowerCase(), outcome.value);
          setResult(outcome.value);
          setFailed(false);
          reset();
        }
      } catch {
        setResult(null);
        setFailed(true);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [open, q, query, run, reset]);

  if (!open) return null;

  let flatIndex = -1;
  const renderItem = (item: PaletteItem) => {
    flatIndex += 1;
    const index = flatIndex;
    const selected = index === activeIndex;
    return (
      <li key={item.key} role="option" id={`search-palette-item-${index}`} aria-selected={selected}>
        <button
          type="button"
          tabIndex={-1}
          className={selected ? `${itemCls} bg-muted text-foreground` : itemCls}
          onMouseMove={() => setActive(index)}
          onClick={() => activate(index)}
        >
          <>
            {item.card.imageKey ? (
              <img
                src={mediaUrl(
                  {
                    key: item.card.imageKey,
                    publicUrl: item.card.imagePublicUrl,
                    variants: item.card.imageVariants,
                  },
                  96
                )}
                alt=""
                loading="lazy"
                className="size-8 shrink-0 rounded-md object-cover"
              />
            ) : (
              <span
                className="flex size-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-xs font-medium text-zinc-500"
                aria-hidden
              >
                {item.card.title.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{item.card.title}</span>
            {item.card.priceCents != null ? (
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatMoney(item.card.priceCents, currency)}
              </span>
            ) : null}
          </>
        </button>
      </li>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[14vh] supports-backdrop-filter:backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search products"
        className="flex max-h-72 min-h-72 w-full max-w-xl flex-col overflow-hidden rounded-3xl bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-zinc-950/10"
      >
        <div className="mb-1 flex items-center gap-2 px-2">
          <SearchIcon className="size-4 shrink-0 opacity-50" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls="search-palette-list"
            aria-activedescendant={
              items.length > 0 ? `search-palette-item-${activeIndex}` : undefined
            }
            aria-label="Search products"
            value={q}
            placeholder="Search products…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else onKeyDown(e, items.length);
            }}
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {query.length >= 3 ? (
          <div
            id="search-palette-list"
            role="listbox"
            aria-label="Search results"
            className="min-h-0 flex-1 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {failed ? (
              <p className="py-6 text-center text-sm text-muted-foreground" role="alert">
                Search failed. Check your connection and try again.
              </p>
            ) : result?.limited ? (
              <p className="py-6 text-center text-sm text-muted-foreground" role="status">
                Too many searches. Give it a moment, then try again.
              </p>
            ) : result && cards.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No results found.</p>
            ) : result ? (
              <>
                <div role="group" aria-label="Results">
                  <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Results</p>
                  <ul>{items.map(renderItem)}</ul>
                </div>
                {result.hasMore ? (
                  <button
                    type="button"
                    className="w-full px-2 py-2 text-left text-[13px] text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      void navigate({ to: '/search', search: { q: query } });
                      close();
                    }}
                  >
                    View all results
                  </button>
                ) : null}
              </>
            ) : (
              <div role="group" aria-label="Results" aria-busy="true">
                <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Results</p>
                <ul aria-hidden>
                  {[0, 1, 2, 3, 4].map((row) => (
                    <li
                      key={row}
                      className="flex min-h-7 items-center gap-2 rounded-xl px-2 py-1.5"
                    >
                      <Skeleton className="size-8 shrink-0 rounded-md" />
                      <Skeleton className="h-4 min-w-0 flex-1" />
                      <Skeleton className="h-4 w-12 shrink-0" />
                    </li>
                  ))}
                </ul>
                <span className="sr-only" role="status">
                  Searching…
                </span>
              </div>
            )}
          </div>
        ) : suggested && suggested.length > 0 ? (
          <div
            id="search-palette-list"
            role="listbox"
            aria-label="Suggested products"
            className="min-h-0 flex-1 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div role="group" aria-label="Suggested">
              <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Suggested</p>
              <ul>{items.map(renderItem)}</ul>
            </div>
          </div>
        ) : (
          <p className="px-2 py-3 text-[13px] text-muted-foreground">
            Type at least three characters to search the catalog.
          </p>
        )}
      </div>
    </div>
  );
}
