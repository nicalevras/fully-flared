import { useEffect, useRef, useState } from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { staffMiddleware } from '../../server/staff-middleware';
import { Link, createFileRoute, useRouter, useRouterState } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useAdminAction, type AdminPayload } from '../../components/AdminNav';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SeoPreview } from '../../components/SeoPreview';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../components/AdminActionFeedback';
import { slugify } from '../../lib/format';
import { MAX_RAILS } from '../../lib/catalog-limits';
import * as z from 'zod';
import { validateServerInput } from '../../server/function-boundary';
import { adminProductDiscovery } from '../../server/admin-product-discovery';
import { normalizeProductSearch } from '../../lib/product-search';
import { labelCls, textareaCls } from '../../components/ui';
import { DataTableSearch } from '../../components/ui/data-table';
import { ftsPhrase, ftsUsable } from '../../lib/fts-search';
import {
  AdminColumnToggle,
  AdminDataTableShell,
  AdminRowActions,
} from '../../components/AdminDataTable';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { SearchIcon } from '../../components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { ArrowLeftIcon, CheckIcon, LoaderCircleIcon, PlusIcon, XIcon } from 'lucide-react';

type CollectionRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  seo_title: string | null;
  seo_description: string | null;
  kind: string;
  rule_json: string | null;
  featured_rank: number | null;
  productIds: string[];
};

type ProductOption = { id: string; title: string; status: string; image_key: string | null };
const featuredRankOf = (value: string) => (value.trim() ? Number(value) : null);

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(
    validateServerInput(
      z.object({
        q: z.string().max(200).default(''),
        cq: z.string().max(200).default(''),
        pcursor: z.string().max(2000).optional(),
      })
    )
  )
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const db = env.DB;
    const cq = data.cq.trim();
    // < 3 chars cannot hit the trigram index; return nothing rather than scan.
    const colWhere = cq
      ? ftsUsable(cq)
        ? 'WHERE rowid IN (SELECT rowid FROM collections_fts WHERE collections_fts MATCH ?)'
        : 'WHERE 1=0'
      : '';
    const colBinds = cq && ftsUsable(cq) ? [ftsPhrase(cq)] : [];
    const cols = await db
      .prepare(
        `SELECT id, slug, title, description, seo_title, seo_description, kind, rule_json, featured_rank FROM collections ${colWhere} ORDER BY title`
      )
      .bind(...colBinds)
      .all<Omit<CollectionRow, 'productIds'>>();
    const discovery = await adminProductDiscovery(
      db,
      normalizeProductSearch({ q: data.q, mode: data.q ? 'title' : null, cursor: data.pcursor })
    );
    const products: ProductOption[] =
      discovery.state === 'refine'
        ? []
        : discovery.products.map((product) => ({
            id: product.id,
            title: product.title,
            status: product.status,
            image_key: product.image_key,
          }));
    const out: CollectionRow[] = [];
    for (const c of cols.results) {
      const members = await db
        .prepare('SELECT product_id FROM product_collections WHERE collection_id = ?')
        .bind(c.id)
        .all<{ product_id: string }>();
      out.push({ ...c, productIds: members.results.map((m) => m.product_id) });
    }
    const memberIds = [...new Set(out.flatMap((c) => c.productIds))];
    let memberProducts: ProductOption[] = [];
    if (memberIds.length > 0) {
      const placeholders = memberIds.map(() => '?').join(',');
      const found = await db
        .prepare(
          `SELECT p.id, p.title, p.status,
            (SELECT m.r2_key FROM product_media pm JOIN media m ON m.id = pm.media_id
              WHERE pm.product_id = p.id AND m.ready = 1 AND m.deletion_pending = 0
              ORDER BY pm.position LIMIT 1) AS image_key
            FROM products p WHERE p.id IN (${placeholders})`
        )
        .bind(...memberIds)
        .all<ProductOption>();
      memberProducts = found.results;
    }
    return {
      collections: out,
      products,
      memberProducts,
      nextCursor: discovery.nextCursor,
      previousCursor: discovery.previousCursor,
      refineSearch: discovery.state === 'refine',
    };
  });

export const Route = createFileRoute('/admin/collections')({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q.slice(0, 200) : '',
    cq: typeof search.cq === 'string' ? search.cq.slice(0, 200) : '',
    pcursor: typeof search.pcursor === 'string' ? search.pcursor.slice(0, 2000) : '',
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getData({ data: deps }),
  component: AdminCollections,
});

function AdminCollections() {
  const adminAction = useAdminAction();

  const { collections, products, memberProducts, nextCursor, refineSearch } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [productQuery, setProductQuery] = useState(search.q);
  const router = useRouter();
  const routerLoading = useRouterState({ select: (state) => state.isLoading });
  const [form, setForm] = useState({
    title: '',
    slug: '',
    description: '',
    featuredRank: '',
  });
  const [slugEdited, setSlugEdited] = useState(false);
  const [editing, setEditing] = useState<
    Record<
      string,
      {
        title: string;
        description: string;
        seoTitle: string;
        seoDescription: string;
        featuredRank: string;
      }
    >
  >({});
  const [members, setMembers] = useState<Record<string, string[]>>({});
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<string[]>(['details']);
  useEffect(() => {
    if (editingId) setOpenSections(['details']);
  }, [editingId]);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    action: () => void | Promise<void>;
  } | null>(null);
  const [paletteFor, setPaletteFor] = useState<string | null>(null);
  const [hiddenCols, setHiddenCols] = useState<ReadonlySet<string>>(new Set());
  const toggleCol = (id: string, visible: boolean) =>
    setHiddenCols((prev) => {
      const n = new Set(prev);
      if (visible) n.delete(id);
      else n.add(id);
      return n;
    });

  const [knownProducts, setKnownProducts] = useState<Record<string, ProductOption>>({});
  const [resultIds, setResultIds] = useState<string[]>([]);
  const [resultQuery, setResultQuery] = useState('');
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    setKnownProducts((prev) => {
      const next = { ...prev };
      for (const product of [...memberProducts, ...products]) next[product.id] = product;
      return next;
    });
  }, [memberProducts, products]);

  useEffect(() => {
    if (paletteFor === null) return;
    loadingMoreRef.current = false;
    setResultIds((prev) => {
      const base = resultQuery === search.q ? prev : [];
      const merged = [...base];
      for (const product of products) if (!merged.includes(product.id)) merged.push(product.id);
      return merged.length === prev.length && base === prev ? prev : merged;
    });
    if (resultQuery !== search.q) setResultQuery(search.q);
  }, [products, paletteFor, search.q, resultQuery]);

  useEffect(() => {
    if (paletteFor === null) return;
    const timer = setTimeout(() => {
      const q = productQuery.trim();
      if (q !== search.q) void navigate({ search: { q, cq: search.cq, pcursor: '' } });
    }, 300);
    return () => clearTimeout(timer);
  }, [productQuery, paletteFor, search.q, navigate]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || paletteFor === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && nextCursor && !loadingMoreRef.current) {
        loadingMoreRef.current = true;
        void navigate({ search: { q: search.q, cq: search.cq, pcursor: nextCursor } });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [paletteFor, nextCursor, search.q, navigate]);

  const toggleProduct = (c: CollectionRow, id: string) => {
    const current = memberOf(c);
    setMembers({
      ...members,
      [c.id]: current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    });
  };

  const memberOf = (c: CollectionRow) => members[c.id] ?? c.productIds;
  const editOf = (c: CollectionRow) =>
    editing[c.id] ?? {
      title: c.title,
      description: c.description,
      seoTitle: c.seo_title ?? '',
      seoDescription: c.seo_description ?? '',
      featuredRank: c.featured_rank?.toString() ?? '',
    };

  // Effective rank is the unsaved draft when one exists, else the persisted rank.
  const takenRanksOf = (excludeId?: string) => {
    const taken = new Map<string, string>();
    for (const other of collections) {
      if (other.id === excludeId) continue;
      const rank = editing[other.id]?.featuredRank ?? other.featured_rank?.toString() ?? '';
      if (rank.trim() && !taken.has(rank)) taken.set(rank, other.title);
    }
    return taken;
  };
  const firstFreeRank = (taken: Map<string, string>) =>
    Array.from({ length: MAX_RAILS }, (_, i) => String(i + 1)).find((rank) => !taken.has(rank));

  const editingCollection = collections.find((c) => c.id === editingId) ?? null;

  const detailsDirtyOf = (c: CollectionRow) => {
    const ed = editOf(c);
    return (
      ed.title !== c.title ||
      ed.description !== c.description ||
      ed.seoTitle !== (c.seo_title ?? '') ||
      ed.seoDescription !== (c.seo_description ?? '') ||
      ed.featuredRank !== (c.featured_rank?.toString() ?? '')
    );
  };
  const productsDirtyOf = (c: CollectionRow) => {
    if (c.kind === 'rule') return false;
    const selected = memberOf(c);
    return (
      selected.length !== c.productIds.length || selected.some((id) => !c.productIds.includes(id))
    );
  };

  const renderEditor = (c: CollectionRow) => {
    const ed = editOf(c);
    const selected = memberOf(c);
    const taken = takenRanksOf(c.id);
    const allTaken = firstFreeRank(taken) === undefined;
    const featured = ed.featuredRank.trim() !== '';
    return (
      <Accordion type="multiple" value={openSections} onValueChange={setOpenSections}>
        <AccordionItem value="details">
          <AccordionTrigger>Details</AccordionTrigger>
          <AccordionContent>
            <div>
              <div className="mt-3">
                <label className={labelCls} htmlFor={`c-title-${c.id}`}>
                  Title
                </label>
                <Input
                  className="rounded-lg"
                  id={`c-title-${c.id}`}
                  value={ed.title}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      [c.id]: { ...ed, title: e.target.value },
                    })
                  }
                />
              </div>
              <div className="mt-4">
                <label className={labelCls} htmlFor={`c-desc-${c.id}`}>
                  Description
                </label>
                <textarea
                  id={`c-desc-${c.id}`}
                  className={textareaCls}
                  rows={2}
                  value={ed.description}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      [c.id]: { ...ed, description: e.target.value },
                    })
                  }
                />
              </div>
            </div>

            <div className="mt-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <label className={labelCls} htmlFor={`c-featured-${c.id}`}>
                    Featured
                  </label>
                  <p className="mt-0.5 text-[13px] text-zinc-500">
                    Display this collection on the home page
                  </p>
                </div>
                <Switch
                  id={`c-featured-${c.id}`}
                  checked={featured}
                  disabled={allTaken && !featured}
                  onCheckedChange={(pressed) =>
                    setEditing({
                      ...editing,
                      [c.id]: {
                        ...ed,
                        featuredRank: pressed ? ed.featuredRank || firstFreeRank(taken) || '' : '',
                      },
                    })
                  }
                />
              </div>
              {featured ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span className="text-[13px] text-zinc-500">Position</span>
                  <ToggleGroup
                    type="single"
                    spacing={0}
                    value={ed.featuredRank}
                    onValueChange={(value) => {
                      if (value) setEditing({ ...editing, [c.id]: { ...ed, featuredRank: value } });
                    }}
                    aria-label="Featured position"
                    className="rounded-full bg-zinc-50 p-1"
                  >
                    {Array.from({ length: MAX_RAILS }, (_, i) => String(i + 1)).map((rank) => {
                      const holder = taken.get(rank);
                      const blocked = holder !== undefined && rank !== ed.featuredRank;
                      return (
                        <ToggleGroupItem
                          key={rank}
                          value={rank}
                          disabled={blocked}
                          aria-label={
                            blocked ? `Position ${rank}, taken by ${holder}` : `Position ${rank}`
                          }
                          className="rounded-full px-3.5 text-[13px] text-zinc-500 data-[state=on]:bg-zinc-950 data-[state=on]:text-white disabled:opacity-40"
                        >
                          {rank}
                        </ToggleGroupItem>
                      );
                    })}
                  </ToggleGroup>
                </div>
              ) : allTaken ? (
                <p className="mt-2 text-xs text-zinc-500">
                  All {MAX_RAILS} home positions are taken — unfeature another collection first.
                </p>
              ) : null}
            </div>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="products">
          <AccordionTrigger>
            Products in this collection ({selected.length} selected)
          </AccordionTrigger>
          <AccordionContent>
            <div>
              {c.kind === 'rule' ? (
                <p className="text-sm text-zinc-500">
                  This collection fills itself: every active product matching its rule appears in
                  the store automatically.
                </p>
              ) : (
                <div>
                  <div className="mt-3 flex flex-wrap gap-3">
                    {selected.map((id) => {
                      const product = knownProducts[id];
                      return (
                        <div key={id} className="group w-24 sm:w-28">
                          <div className="relative aspect-[4/5] overflow-hidden rounded-xl bg-zinc-50">
                            {product?.image_key ? (
                              <img
                                src={`/media/${product.image_key}`}
                                alt=""
                                className="absolute inset-0 h-full w-full object-cover"
                              />
                            ) : (
                              <span
                                className="absolute inset-0 flex items-center justify-center text-lg font-medium text-zinc-400"
                                aria-hidden
                              >
                                {(product?.title ?? '?').slice(0, 1).toUpperCase()}
                              </span>
                            )}
                            <button
                              type="button"
                              aria-label={`Remove ${product?.title ?? id} from ${c.title}`}
                              onClick={() =>
                                setMembers({
                                  ...members,
                                  [c.id]: selected.filter((x) => x !== id),
                                })
                              }
                              className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 opacity-100 transition-opacity hover:text-zinc-950 focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                            >
                              <XIcon className="size-3.5" />
                            </button>
                          </div>
                          <p className="mt-1.5 truncate text-xs text-zinc-600">
                            {product?.title ?? id}
                            {product && product.status !== 'active' ? ' (draft)' : ''}
                          </p>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => {
                        setResultIds([]);
                        setResultQuery(search.q);
                        if (search.pcursor)
                          void navigate({ search: { q: search.q, cq: search.cq, pcursor: '' } });
                        setPaletteFor(c.id);
                      }}
                      className="group/add w-24 text-left sm:w-28"
                    >
                      <span className="flex aspect-[4/5] flex-col items-center justify-center gap-1.5 rounded-xl bg-zinc-50 text-zinc-500 transition-colors group-hover/add:bg-zinc-100 group-hover/add:text-zinc-950">
                        <PlusIcon className="size-5" />
                        <span className="text-xs font-medium">Add</span>
                      </span>
                      <span className="mt-1.5 block truncate text-xs text-zinc-600">
                        Add products
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="metadata">
          <AccordionTrigger>Metadata</AccordionTrigger>
          <AccordionContent>
            <div>
              <div className="mt-3 max-w-md">
                <label className={labelCls} htmlFor={`c-seo-${c.id}`}>
                  SEO title
                </label>
                <Input
                  className="rounded-lg"
                  id={`c-seo-${c.id}`}
                  value={ed.seoTitle}
                  placeholder="Optional"
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      [c.id]: { ...ed, seoTitle: e.target.value },
                    })
                  }
                />
              </div>
              <div className="mt-4 max-w-md">
                <label className={labelCls} htmlFor={`c-seodesc-${c.id}`}>
                  SEO description
                </label>
                <textarea
                  id={`c-seodesc-${c.id}`}
                  className={textareaCls}
                  rows={3}
                  value={ed.seoDescription}
                  placeholder="Optional"
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      [c.id]: { ...ed, seoDescription: e.target.value },
                    })
                  }
                />
              </div>
              <div className="mt-4 max-w-md">
                <SeoPreview
                  path={`/collections/${c.slug}`}
                  seoTitle={ed.seoTitle}
                  seoDescription={ed.seoDescription}
                  titleFallback={ed.title}
                  descriptionFallback={ed.description}
                  emptyDescription="No description yet. Search engines will use the collection page content."
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  };

  const renderSearch = (c: CollectionRow) => {
    const searching = routerLoading || productQuery.trim() !== search.q;
    const visibleProducts =
      resultIds.length > 0
        ? resultIds
            .map((id) => knownProducts[id])
            .filter((prod): prod is ProductOption => Boolean(prod))
        : products;
    return (
      <>
        <div className="border-b border-zinc-100 px-3 py-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-[18px] w-[18px] -translate-y-1/2 text-zinc-400" />
            <Input
              autoFocus
              aria-label="Find products to add"
              value={productQuery}
              onChange={(event) => setProductQuery(event.target.value)}
              placeholder="Search product titles"
              className="rounded-lg pr-9 pl-9"
            />
            {searching ? (
              <LoaderCircleIcon className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-zinc-400" />
            ) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-busy={searching}>
          {refineSearch ? (
            <p className="px-3 py-6 text-center text-sm text-zinc-500">
              This search is too broad. Add more of the title to narrow it down.
            </p>
          ) : visibleProducts.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-zinc-500">No products found.</p>
          ) : (
            visibleProducts.map((prod) => {
              const isSelected = memberOf(c).includes(prod.id);
              return (
                <button
                  key={prod.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => toggleProduct(c, prod.id)}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:outline-none"
                >
                  {prod.image_key ? (
                    <img
                      src={`/media/${prod.image_key}`}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-xs font-medium text-zinc-500"
                      aria-hidden
                    >
                      {prod.title.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-950">
                    {prod.title}
                    {prod.status !== 'active' ? (
                      <span className="text-zinc-500"> (draft)</span>
                    ) : null}
                  </span>
                  {isSelected ? <CheckIcon className="size-4 shrink-0 text-zinc-950" /> : null}
                </button>
              );
            })
          )}
          <div ref={sentinelRef} className="h-1" />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-3 py-2.5">
          <Button type="button" variant="outline" size="sm" onClick={() => setPaletteFor(null)}>
            <ArrowLeftIcon className="size-4" />
            Back
          </Button>
          <Button type="button" size="sm" onClick={() => setPaletteFor(null)}>
            Done
          </Button>
        </div>
      </>
    );
  };

  async function run(
    action: string,
    payload: AdminPayload,
    ok: string,
    opts?: { quiet?: boolean }
  ) {
    if (!opts?.quiet) setBusy(true);
    const r = await adminAction(action, payload);
    if (!opts?.quiet) {
      setBusy(false);
      if (r.ok) {
        setFeedback({ kind: 'status', message: ok });
        router.invalidate();
      } else setFeedback({ kind: 'error', message: r.error ?? 'Failed' });
    }
    return r;
  }

  const discardChanges = (c: CollectionRow) => {
    const nextEditing = { ...editing };
    delete nextEditing[c.id];
    setEditing(nextEditing);
    const nextMembers = { ...members };
    delete nextMembers[c.id];
    setMembers(nextMembers);
  };

  const askDelete = (c: CollectionRow) => {
    setConfirm({
      title: `Delete collection ${c.title}?`,
      body: 'Products stay. Only the grouping is removed.',
      confirmLabel: 'Delete collection',
      action: async () => {
        if (
          (await run('collection.delete', { collectionId: c.id }, `Collection ${c.title} deleted.`))
            .ok
        ) {
          discardChanges(c);
          setEditingId(null);
        }
      },
    });
  };

  async function saveCollection(c: CollectionRow) {
    const ed = editOf(c);
    const selected = memberOf(c);
    const wantDetails = detailsDirtyOf(c);
    const wantProducts = productsDirtyOf(c);
    if (!wantDetails && !wantProducts) return;
    setBusy(true);
    const failures: string[] = [];
    let anyOk = false;
    if (wantDetails) {
      const r = await run(
        'collection.update',
        {
          collectionId: c.id,
          title: ed.title,
          description: ed.description,
          seoTitle: ed.seoTitle,
          seoDescription: ed.seoDescription,
          kind: c.kind,
          ruleJson: c.rule_json ?? '',
          featuredRank: featuredRankOf(ed.featuredRank),
        },
        '',
        { quiet: true }
      );
      if (r.ok) anyOk = true;
      else failures.push(`Details couldn't be saved — ${r.error ?? 'Failed'}`);
    }
    if (wantProducts) {
      const r = await run(
        'collection.setProducts',
        { collectionId: c.id, productIds: selected },
        '',
        { quiet: true }
      );
      if (r.ok) anyOk = true;
      else failures.push(`Products couldn't be saved — ${r.error ?? 'Failed'}`);
    }
    setBusy(false);
    if (anyOk) router.invalidate();
    if (failures.length > 0) {
      setFeedback({ kind: 'error', message: failures.join(' ') });
    } else {
      setFeedback({ kind: 'status', message: `Collection ${ed.title} saved.` });
      setEditingId(null);
      setPaletteFor(null);
    }
  }

  const confirmDialog = (
    <ConfirmDialog
      request={
        confirm
          ? { title: confirm.title, body: confirm.body, confirmLabel: confirm.confirmLabel }
          : null
      }
      busy={busy}
      onCancel={() => setConfirm(null)}
      onConfirm={() => {
        const current = confirm;
        setConfirm(null);
        if (current) void current.action();
      }}
    />
  );

  return (
    <main>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[28px] leading-tight font-medium tracking-tight text-zinc-950">
            Collections
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Group products into collections that appear in the store header and on their own pages.
          </p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <PlusIcon className="size-4" />
          New
        </Button>
      </div>
      <AdminActionFeedback value={feedback} />

      <Sheet open={createOpen} onOpenChange={setCreateOpen}>
        <SheetContent
          className="w-full gap-0 overflow-hidden p-0 sm:max-w-2xl"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <SheetHeader className="p-5 pr-14 pb-0 sm:p-6 sm:pr-14 sm:pb-0">
            <SheetTitle>New collection</SheetTitle>
            <SheetDescription>
              Group products into a collection that appears in the store.
            </SheetDescription>
          </SheetHeader>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                (
                  await run(
                    'collection.create',
                    {
                      title: form.title,
                      slug: form.slug || slugify(form.title),
                      description: form.description,
                      featuredRank: featuredRankOf(form.featuredRank),
                    },
                    'Collection created.'
                  )
                ).ok
              ) {
                setForm({ title: '', slug: '', description: '', featuredRank: '' });
                setSlugEdited(false);
                setCreateOpen(false);
              }
            }}
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
              <div>
                <label className={labelCls} htmlFor="n-title">
                  Title
                </label>
                <Input
                  className="rounded-lg"
                  id="n-title"
                  placeholder="e.g. New arrivals"
                  value={form.title}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      title: e.target.value,
                      slug: slugEdited && form.slug ? form.slug : slugify(e.target.value),
                    })
                  }
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="n-slug">
                  Slug
                </label>
                <Input
                  className="rounded-lg"
                  id="n-slug"
                  placeholder="new-arrivals"
                  value={form.slug}
                  onChange={(e) => {
                    setSlugEdited(e.target.value !== '');
                    setForm({ ...form, slug: e.target.value });
                  }}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="n-desc">
                  Description
                </label>
                <textarea
                  id="n-desc"
                  className={textareaCls}
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <div>
                {(() => {
                  const taken = takenRanksOf();
                  const allTaken = firstFreeRank(taken) === undefined;
                  const featured = form.featuredRank.trim() !== '';
                  return (
                    <>
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <label className={labelCls} htmlFor="n-featured">
                            Featured
                          </label>
                          <p className="mt-0.5 text-[13px] text-zinc-500">
                            Display this collection on the home page
                          </p>
                        </div>
                        <Switch
                          id="n-featured"
                          checked={featured}
                          disabled={allTaken && !featured}
                          onCheckedChange={(pressed) =>
                            setForm({
                              ...form,
                              featuredRank: pressed
                                ? form.featuredRank || firstFreeRank(taken) || ''
                                : '',
                            })
                          }
                        />
                      </div>
                      {featured ? (
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <span className="text-[13px] text-zinc-500">Position</span>
                          <ToggleGroup
                            type="single"
                            spacing={0}
                            value={form.featuredRank}
                            onValueChange={(value) => {
                              if (value) setForm({ ...form, featuredRank: value });
                            }}
                            aria-label="Featured position"
                            className="rounded-full bg-zinc-50 p-1"
                          >
                            {Array.from({ length: MAX_RAILS }, (_, i) => String(i + 1)).map(
                              (rank) => {
                                const holder = taken.get(rank);
                                const blocked = holder !== undefined && rank !== form.featuredRank;
                                return (
                                  <ToggleGroupItem
                                    key={rank}
                                    value={rank}
                                    disabled={blocked}
                                    aria-label={
                                      blocked
                                        ? `Position ${rank}, taken by ${holder}`
                                        : `Position ${rank}`
                                    }
                                    className="rounded-full px-3.5 text-[13px] text-zinc-500 data-[state=on]:bg-zinc-950 data-[state=on]:text-white disabled:opacity-40"
                                  >
                                    {rank}
                                  </ToggleGroupItem>
                                );
                              }
                            )}
                          </ToggleGroup>
                        </div>
                      ) : allTaken ? (
                        <p className="mt-2 text-xs text-zinc-500">
                          All {MAX_RAILS} home positions are taken — unfeature another collection
                          first.
                        </p>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            </div>
            <div className="flex items-center justify-end border-t border-zinc-100 bg-white px-5 py-3.5 sm:px-6">
              <Button type="submit" disabled={busy || !form.title}>
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>

      {collections.length === 0 ? (
        <p className="mt-8 rounded-2xl bg-zinc-50 p-5 text-sm text-zinc-500" role="status">
          No collections yet. Use New to create your first one.
        </p>
      ) : (
        <div className="mt-8" tabIndex={0} role="region" aria-label="Collections">
          <AdminDataTableShell
            toolbar={
              <div className="flex flex-wrap items-center gap-2">
                <DataTableSearch
                  minCharsHint
                  value={search.cq}
                  onSearch={(cq) => void navigate({ search: { ...search, cq } })}
                  placeholder="Filter collections…"
                  ariaLabel="Find a collection"
                />
                <AdminColumnToggle
                  columns={[
                    { id: 'products', label: 'Products' },
                    { id: 'featured', label: 'Featured' },
                  ]}
                  hidden={hiddenCols}
                  onToggle={toggleCol}
                />
              </div>
            }
          >
            <Table className="min-w-[640px]">
              <TableCaption className="sr-only">Collections</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Collection</TableHead>
                  {hiddenCols.has('products') ? null : <TableHead scope="col">Products</TableHead>}
                  {hiddenCols.has('featured') ? null : <TableHead scope="col">Featured</TableHead>}
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {collections.map((c) => {
                  const selected = memberOf(c);
                  return (
                    <TableRow
                      key={c.id}
                      className="cursor-pointer"
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest('a, button')) return;
                        setEditingId(c.id);
                      }}
                    >
                      <TableCell className="whitespace-normal">
                        <span className="font-medium text-zinc-950">{c.title}</span>
                        <span className="block text-[13px] text-zinc-500">
                          /collections/{c.slug}
                        </span>
                      </TableCell>
                      {hiddenCols.has('products') ? null : (
                        <TableCell className="text-zinc-500">
                          {selected.length} product{selected.length === 1 ? '' : 's'}
                        </TableCell>
                      )}
                      {hiddenCols.has('featured') ? null : (
                        <TableCell className="text-zinc-500">
                          {c.featured_rank ? `#${c.featured_rank}` : '—'}
                        </TableCell>
                      )}
                      <TableCell className="text-right">
                        <AdminRowActions label={`Actions for ${c.title}`}>
                          <DropdownMenuItem onSelect={() => setEditingId(c.id)}>
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link to="/collections/$slug" params={{ slug: c.slug }}>
                              View in store
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={busy}
                            variant="destructive"
                            onSelect={() => askDelete(c)}
                          >
                            Delete
                          </DropdownMenuItem>
                        </AdminRowActions>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </AdminDataTableShell>
        </div>
      )}

      <Sheet
        open={editingCollection !== null}
        onOpenChange={(open) => {
          if (open || !editingCollection) return;
          if (detailsDirtyOf(editingCollection) || productsDirtyOf(editingCollection)) {
            const c = editingCollection;
            setConfirm({
              title: 'Discard unsaved changes?',
              body: `Your changes to ${c.title} haven't been saved.`,
              confirmLabel: 'Discard changes',
              action: () => {
                discardChanges(c);
                setEditingId(null);
                setPaletteFor(null);
              },
            });
            return;
          }
          discardChanges(editingCollection);
          setEditingId(null);
          setPaletteFor(null);
        }}
      >
        <SheetContent
          className="w-full gap-0 overflow-hidden p-0 sm:max-w-2xl"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          {editingCollection ? (
            paletteFor === editingCollection.id ? (
              <>
                <SheetHeader className="p-4 pb-0">
                  <SheetTitle>Add products</SheetTitle>
                  <SheetDescription>{editingCollection.title}</SheetDescription>
                </SheetHeader>
                <div className="flex min-h-0 flex-1 flex-col">
                  {renderSearch(editingCollection)}
                </div>
              </>
            ) : (
              <>
                <SheetHeader className="p-5 pr-24 pb-0 sm:p-6 sm:pr-24 sm:pb-0">
                  <SheetTitle>{editingCollection.title}</SheetTitle>
                  <SheetDescription>/collections/{editingCollection.slug}</SheetDescription>
                </SheetHeader>
                <div className="absolute top-3 right-12 z-20">
                  <AdminRowActions label={`Actions for ${editingCollection.title}`}>
                    <DropdownMenuItem asChild>
                      <Link to="/collections/$slug" params={{ slug: editingCollection.slug }}>
                        View in store
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={busy}
                      variant="destructive"
                      onSelect={() => askDelete(editingCollection)}
                    >
                      Delete
                    </DropdownMenuItem>
                  </AdminRowActions>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
                  {renderEditor(editingCollection)}
                </div>
                {detailsDirtyOf(editingCollection) || productsDirtyOf(editingCollection) ? (
                  <div className="flex flex-wrap items-center justify-end gap-3 border-t border-zinc-100 bg-white px-5 py-3.5 sm:px-6">
                    <span className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          discardChanges(editingCollection);
                          setEditingId(null);
                          setPaletteFor(null);
                        }}
                      >
                        Discard
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => void saveCollection(editingCollection)}
                      >
                        {busy ? 'Saving…' : 'Save changes'}
                      </Button>
                    </span>
                  </div>
                ) : null}
              </>
            )
          ) : null}
          {editingCollection ? confirmDialog : null}
        </SheetContent>
      </Sheet>
      {editingCollection ? null : confirmDialog}
    </main>
  );
}
