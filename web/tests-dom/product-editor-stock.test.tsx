// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProductEditor, type ProductDetail } from '@/components/ProductEditor';
import type { AdminPayload } from '@/components/AdminNav';
import { Route as ProductsRoute } from '@/routes/admin/products/index';
import { renderRoute } from './render-route';

type ActionResult = { ok: true } | { ok: false; uncertain: true; error: string };
const action = vi.fn(async (_action: string, _payload: AdminPayload): Promise<ActionResult> => ({
  ok: true,
}));
const productDetail = vi.hoisted(() => vi.fn());

vi.mock('@/components/AdminNav', () => ({ useAdminAction: () => action }));
vi.mock('@/lib/use-store-currency', () => ({ useStoreCurrency: () => 'USD' }));
vi.mock('@/components/ExpandableEditor', () => ({ ExpandableEditor: () => null }));
vi.mock('@/components/ProductCreateDrawer', () => ({ ProductCreateDrawer: () => null }));
vi.mock('@/components/ProductEditor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ProductEditor')>()),
  getProductDetail: productDetail,
}));
vi.mock('@/server/admin-product-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/admin-product-discovery')>()),
  adminProductDiscovery: async () => ({
    products: [],
    nextCursor: null,
    previousCursor: null,
    state: 'ready',
  }),
}));
vi.mock('@tanstack/react-start', async (importOriginal) => {
  type Handler = (ctx: { data: unknown; context: object }) => unknown;
  type Builder = {
    middleware: () => Builder;
    validator: () => Builder;
    handler: (fn: Handler) => (opts?: { data?: unknown }) => Promise<unknown>;
  };
  const builder: Builder = {
    middleware: () => builder,
    validator: () => builder,
    handler: (fn) => async (opts) => fn({ data: opts?.data, context: {} }),
  };
  return {
    ...(await importOriginal<typeof import('@tanstack/react-start')>()),
    createServerFn: () => builder,
    useServerFn: <T,>(fn: T) => fn,
  };
});
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  getRouteApi: () => ({ useRouteContext: () => ({ staff: null }) }),
}));

beforeEach(() => {
  action.mockReset();
  action.mockResolvedValue({ ok: true });
});

const product = (onHand: number): ProductDetail => ({
  id: 'p1',
  slug: 'tote',
  title: 'Tote',
  description: '',
  status: 'active',
  seo_title: null,
  seo_description: null,
  revision: null,
  processed_revision: null,
  variants: [
    {
      id: 'v1',
      sku: 'TOTE-001',
      title: 'Default',
      price_cents: 2000,
      compare_at_cents: null,
      status: 'active',
      weight_grams: null,
      continue_selling: 0,
      on_hand: onHand,
      reserved: 0,
    },
  ],
  media: [],
  collections: [],
  allCollections: [],
});

async function stageStockTotal(total: string) {
  await userEvent.click(await screen.findByRole('button', { name: 'Variants', hidden: true }));
  const stock = screen.getByLabelText('Stock total for TOTE-001');
  await userEvent.clear(stock);
  await userEvent.type(stock, total);
}

const save = () =>
  userEvent.click(screen.getByRole('button', { name: 'Save changes', hidden: true }));
const stockAdjusts = () =>
  action.mock.calls.filter(([name]) => name === 'stock.adjust').map(([, payload]) => payload);

it('after invalidate, the delta uses the new on_hand', async () => {
  productDetail.mockResolvedValue(product(5));
  const router = createRouter({
    routeTree: ProductsRoute,
    history: createMemoryHistory({ initialEntries: ['/?edit=p1'] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await stageStockTotal('10');

  productDetail.mockResolvedValue(product(7));
  await act(() => router.invalidate({ sync: true }));
  await save();

  expect(stockAdjusts()).toEqual([expect.objectContaining({ sku: 'TOTE-001', delta: 3 })]);
});

it('a retried save replays the same operationId', async () => {
  action.mockResolvedValueOnce({ ok: false, uncertain: true, error: 'Connection lost' });
  await renderRoute(() => (
    <ProductEditor product={product(5)} open onClose={() => {}} refresh={async () => {}} />
  ));
  await stageStockTotal('10');
  await save();
  await save();

  const [first, second] = stockAdjusts();
  expect(first).toEqual(expect.objectContaining({ delta: 5, operationId: expect.any(String) }));
  expect(second).toEqual(first);
});

it('sends the reason picked for the staged stock change', async () => {
  await renderRoute(() => (
    <ProductEditor product={product(5)} open onClose={() => {}} refresh={async () => {}} />
  ));
  await stageStockTotal('3');
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Reason for TOTE-001', hidden: true })
  );
  await userEvent.click(await screen.findByRole('option', { name: 'Damaged', hidden: true }));
  await save();

  expect(stockAdjusts()).toEqual([expect.objectContaining({ delta: -2, reason: 'damaged' })]);
});
