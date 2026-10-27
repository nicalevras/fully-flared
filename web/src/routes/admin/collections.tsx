import { useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useAdminAction, type AdminPayload } from '../../components/AdminNav';
import { ConfirmDialog } from '../../components/ConfirmDialog';
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
import {
  btnDestructive,
  btnPrimary,
  btnSmall,
  cardCls,
  hintCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
  textareaCls,
} from '../../components/ui';

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

type RuleDraft = { kind: string; ruleType: string; ruleValue: string };
const ruleJsonOf = (d: RuleDraft) =>
  d.kind !== 'rule'
    ? ''
    : JSON.stringify(
        d.ruleType === 'title_contains'
          ? { type: 'title_contains', value: d.ruleValue }
          : { type: d.ruleType, value: Math.round(Number(d.ruleValue || 0) * 100) }
      );
type ProductOption = { id: string; title: string; status: string };
const featuredRankOf = (value: string) => (value.trim() ? Number(value) : null);

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(z.object({ q: z.string().max(200).default('') })))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const db = env.DB;
    const cols = await db
      .prepare(
        'SELECT id, slug, title, description, seo_title, seo_description, kind, rule_json, featured_rank FROM collections ORDER BY title'
      )
      .all<Omit<CollectionRow, 'productIds'>>();
    const discovery = await adminProductDiscovery(
      db,
      normalizeProductSearch({ q: data.q, mode: data.q ? 'title' : null })
    );
    const products: ProductOption[] =
      discovery.state === 'refine'
        ? []
        : discovery.products.map((product) => ({
            id: product.id,
            title: product.title,
            status: product.status,
          }));
    const out: CollectionRow[] = [];
    for (const c of cols.results) {
      const members = await db
        .prepare('SELECT product_id FROM product_collections WHERE collection_id = ?')
        .bind(c.id)
        .all<{ product_id: string }>();
      out.push({ ...c, productIds: members.results.map((m) => m.product_id) });
    }
    return { collections: out, products, refineSearch: discovery.state === 'refine' };
  });

export const Route = createFileRoute('/admin/collections')({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q.slice(0, 200) : '',
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getData({ data: deps }),
  component: AdminCollections,
});

function AdminCollections() {
  const adminAction = useAdminAction();

  const { collections, products, refineSearch } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [productQuery, setProductQuery] = useState(search.q);
  const router = useRouter();
  const [form, setForm] = useState({
    title: '',
    slug: '',
    description: '',
    kind: 'manual',
    ruleType: 'title_contains',
    ruleValue: '',
    featuredRank: '',
  });
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
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, RuleDraft>>({});
  const [members, setMembers] = useState<Record<string, string[]>>({});
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    action: () => void | Promise<void>;
  } | null>(null);

  const memberOf = (c: CollectionRow) => members[c.id] ?? c.productIds;
  const editOf = (c: CollectionRow) =>
    editing[c.id] ?? {
      title: c.title,
      description: c.description,
      seoTitle: c.seo_title ?? '',
      seoDescription: c.seo_description ?? '',
      featuredRank: c.featured_rank?.toString() ?? '',
    };
  const ruleOf = (c: CollectionRow): RuleDraft => {
    const draft = ruleDrafts[c.id];
    if (draft) return draft;
    try {
      const r = JSON.parse(c.rule_json ?? '{}') as { type?: string; value?: string | number };
      return {
        kind: c.kind,
        ruleType: r.type ?? 'title_contains',
        ruleValue:
          r.type === 'title_contains'
            ? String(r.value ?? '')
            : String((Number(r.value ?? 0) / 100).toFixed(2)),
      };
    } catch {
      return { kind: c.kind, ruleType: 'title_contains', ruleValue: '' };
    }
  };

  async function run(action: string, payload: AdminPayload, ok: string) {
    setBusy(true);
    const r = await adminAction(action, payload);
    setBusy(false);
    if (r.ok) {
      setFeedback({ kind: 'status', message: ok });
      router.invalidate();
    } else setFeedback({ kind: 'error', message: r.error ?? 'Failed' });
    return r.ok;
  }

  return (
    <main>
      <h1 className={pageTitle}>Collections</h1>
      <p className={pageSub}>
        Group products into collections that appear in the store header and on their own pages, like
        /collections/your-slug.
      </p>
      <AdminActionFeedback value={feedback} />

      <form
        className={`${cardCls} mt-5 flex flex-wrap items-end gap-3 p-4`}
        onSubmit={(event) => {
          event.preventDefault();
          void navigate({ search: { q: productQuery.trim() } });
        }}
      >
        <div className="min-w-52 flex-1">
          <label className={labelCls} htmlFor="collection-product-q">
            Find products to add
          </label>
          <input
            id="collection-product-q"
            className={inputCls}
            value={productQuery}
            onChange={(event) => setProductQuery(event.target.value)}
            placeholder="Search product titles"
          />
        </div>
        <button type="submit" className={btnPrimary}>
          Search products
        </button>
      </form>
      <p className="mt-2 text-[13px] text-zinc-500">
        Product choices come from the catalog search, one page of 50 at a time, so collections can
        include products beyond the first 200.
        {refineSearch ? ' This search is too broad. Add more of the title to narrow it down.' : ''}
      </p>

      <div className="mt-6 space-y-5">
        {collections.length === 0 ? (
          <p className={`${cardCls} p-5 text-sm text-zinc-500`} role="status">
            No collections yet. Create your first one below.
          </p>
        ) : (
          collections.map((c) => {
            const ed = editOf(c);
            const selected = memberOf(c);
            return (
              <section key={c.id} className={`${cardCls} p-5 sm:p-6`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-medium text-zinc-950">{c.title}</h2>
                    <p className="mt-0.5 text-[13px] text-zinc-500">
                      /collections/{c.slug} · {selected.length} product
                      {selected.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <span className="flex gap-1">
                    <Link to="/collections/$slug" params={{ slug: c.slug }} className={btnSmall}>
                      View in store
                    </Link>
                    <button
                      className={btnDestructive}
                      disabled={busy}
                      onClick={() =>
                        setConfirm({
                          title: `Delete collection ${c.title}?`,
                          body: 'Products stay. Only the grouping is removed.',
                          confirmLabel: 'Delete collection',
                          action: async () => {
                            await run(
                              'collection.delete',
                              { collectionId: c.id },
                              `Collection ${c.title} deleted.`
                            );
                          },
                        })
                      }
                    >
                      Delete
                    </button>
                  </span>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <div>
                    <label className={labelCls} htmlFor={`c-title-${c.id}`}>
                      Title
                    </label>
                    <input
                      id={`c-title-${c.id}`}
                      className={inputCls}
                      value={ed.title}
                      onChange={(e) =>
                        setEditing({ ...editing, [c.id]: { ...ed, title: e.target.value } })
                      }
                    />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor={`c-seo-${c.id}`}>
                      SEO title
                    </label>
                    <input
                      id={`c-seo-${c.id}`}
                      className={inputCls}
                      value={ed.seoTitle}
                      placeholder="Optional"
                      onChange={(e) =>
                        setEditing({ ...editing, [c.id]: { ...ed, seoTitle: e.target.value } })
                      }
                    />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor={`c-featured-${c.id}`}>
                      Feature on home (order)
                    </label>
                    <input
                      id={`c-featured-${c.id}`}
                      className={inputCls}
                      type="number"
                      min={1}
                      max={MAX_RAILS}
                      value={ed.featuredRank}
                      placeholder="Off"
                      onChange={(e) =>
                        setEditing({ ...editing, [c.id]: { ...ed, featuredRank: e.target.value } })
                      }
                    />
                  </div>
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
                      setEditing({ ...editing, [c.id]: { ...ed, description: e.target.value } })
                    }
                  />
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <div>
                    <label className={labelCls} htmlFor={`c-kind-${c.id}`}>
                      Type
                    </label>
                    <select
                      id={`c-kind-${c.id}`}
                      className={inputCls}
                      value={ruleOf(c).kind}
                      onChange={(e) =>
                        setRuleDrafts({
                          ...ruleDrafts,
                          [c.id]: { ...ruleOf(c), kind: e.target.value },
                        })
                      }
                    >
                      <option value="manual">Manual — I pick the products</option>
                      <option value="rule">Rule-based — automatic</option>
                    </select>
                  </div>
                  {ruleOf(c).kind === 'rule' ? (
                    <>
                      <div>
                        <label className={labelCls} htmlFor={`c-ruletype-${c.id}`}>
                          Rule
                        </label>
                        <select
                          id={`c-ruletype-${c.id}`}
                          className={inputCls}
                          value={ruleOf(c).ruleType}
                          onChange={(e) =>
                            setRuleDrafts({
                              ...ruleDrafts,
                              [c.id]: { ...ruleOf(c), ruleType: e.target.value },
                            })
                          }
                        >
                          <option value="title_contains">Title contains</option>
                          <option value="price_lte">Price at or under ($)</option>
                          <option value="price_gte">Price at or over ($)</option>
                        </select>
                      </div>
                      <div>
                        <label className={labelCls} htmlFor={`c-rulevalue-${c.id}`}>
                          Value
                        </label>
                        <input
                          id={`c-rulevalue-${c.id}`}
                          className={inputCls}
                          value={ruleOf(c).ruleValue}
                          placeholder={
                            ruleOf(c).ruleType === 'title_contains' ? 'e.g. Tote' : 'e.g. 50.00'
                          }
                          onChange={(e) =>
                            setRuleDrafts({
                              ...ruleDrafts,
                              [c.id]: { ...ruleOf(c), ruleValue: e.target.value },
                            })
                          }
                        />
                      </div>
                    </>
                  ) : null}
                </div>
                <button
                  className={`${btnSmall} mt-3`}
                  disabled={busy}
                  onClick={() =>
                    run(
                      'collection.update',
                      {
                        collectionId: c.id,
                        title: ed.title,
                        description: ed.description,
                        seoTitle: ed.seoTitle,
                        seoDescription: ed.seoDescription,
                        kind: ruleOf(c).kind,
                        ruleJson: ruleJsonOf(ruleOf(c)),
                        featuredRank: featuredRankOf(ed.featuredRank),
                      },
                      `Collection ${ed.title} saved.`
                    )
                  }
                >
                  Save details
                </button>

                {c.kind === 'rule' ? (
                  <p className="mt-5 border-t border-zinc-100 pt-4 text-sm text-zinc-500">
                    This collection fills itself: every active product matching the rule appears in
                    the store automatically. Change the rule above and save to recompute it.
                  </p>
                ) : (
                  <fieldset className="mt-5 border-t border-zinc-100 pt-4">
                    <legend className="text-sm font-medium text-zinc-950">
                      Products in this collection ({selected.length} selected)
                    </legend>
                    <p className={hintCls}>
                      Selected products stay selected even when a search does not show them on this
                      page.
                    </p>
                    {products.length === 0 ? (
                      <p className={hintCls}>No products exist yet.</p>
                    ) : (
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        {products.map((p) => {
                          const on = selected.includes(p.id);
                          return (
                            <button
                              key={p.id}
                              aria-pressed={on}
                              className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${on ? 'bg-zinc-950 text-white' : 'border border-zinc-300 text-zinc-700 hover:border-zinc-950'}`}
                              onClick={() =>
                                setMembers({
                                  ...members,
                                  [c.id]: on
                                    ? selected.filter((x) => x !== p.id)
                                    : [...selected, p.id],
                                })
                              }
                            >
                              {p.title}
                              {p.status !== 'active' ? ' (draft)' : ''}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <button
                      className={`${btnSmall} mt-3`}
                      disabled={busy}
                      onClick={() =>
                        run(
                          'collection.setProducts',
                          { collectionId: c.id, productIds: selected },
                          `Products updated for ${c.title}.`
                        )
                      }
                    >
                      Save products
                    </button>
                  </fieldset>
                )}
              </section>
            );
          })
        )}
      </div>

      <form
        className={`${cardCls} mt-5 space-y-4 p-5 sm:p-6`}
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await run(
              'collection.create',
              {
                title: form.title,
                slug: form.slug || slugify(form.title),
                description: form.description,
                kind: form.kind,
                ruleJson: ruleJsonOf(form),
                featuredRank: featuredRankOf(form.featuredRank),
              },
              'Collection created.'
            )
          ) {
            setForm({
              title: '',
              slug: '',
              description: '',
              kind: 'manual',
              ruleType: 'title_contains',
              ruleValue: '',
              featuredRank: '',
            });
          }
        }}
      >
        <h2 className="text-sm font-medium text-zinc-950">Create collection</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className={labelCls} htmlFor="n-title">
              Title
            </label>
            <input
              id="n-title"
              className={inputCls}
              placeholder="e.g. New arrivals"
              value={form.title}
              onChange={(e) =>
                setForm({
                  ...form,
                  title: e.target.value,
                  slug: form.slug || slugify(e.target.value),
                })
              }
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="n-slug">
              Slug
            </label>
            <input
              id="n-slug"
              className={inputCls}
              placeholder="new-arrivals"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="n-featured">
              Feature on home (order)
            </label>
            <input
              id="n-featured"
              className={inputCls}
              type="number"
              min={1}
              max={MAX_RAILS}
              placeholder="Off"
              value={form.featuredRank}
              onChange={(e) => setForm({ ...form, featuredRank: e.target.value })}
            />
          </div>
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
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className={labelCls} htmlFor="n-kind">
              Type
            </label>
            <select
              id="n-kind"
              className={inputCls}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              <option value="manual">Manual — I pick the products</option>
              <option value="rule">Rule-based — automatic</option>
            </select>
          </div>
          {form.kind === 'rule' ? (
            <>
              <div>
                <label className={labelCls} htmlFor="n-ruletype">
                  Rule
                </label>
                <select
                  id="n-ruletype"
                  className={inputCls}
                  value={form.ruleType}
                  onChange={(e) => setForm({ ...form, ruleType: e.target.value })}
                >
                  <option value="title_contains">Title contains</option>
                  <option value="price_lte">Price at or under ($)</option>
                  <option value="price_gte">Price at or over ($)</option>
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="n-rulevalue">
                  Value
                </label>
                <input
                  id="n-rulevalue"
                  className={inputCls}
                  value={form.ruleValue}
                  placeholder={form.ruleType === 'title_contains' ? 'e.g. Tote' : 'e.g. 50.00'}
                  onChange={(e) => setForm({ ...form, ruleValue: e.target.value })}
                />
              </div>
            </>
          ) : null}
        </div>
        <button type="submit" disabled={busy || !form.title} className={btnPrimary}>
          {busy ? 'Creating…' : 'Create collection'}
        </button>
      </form>
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
    </main>
  );
}
