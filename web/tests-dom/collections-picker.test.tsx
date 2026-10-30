// @vitest-environment happy-dom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderTree } from './render-route';

vi.mock('@/components/AdminNav', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/AdminNav')>()),
  useAdminAction: () => async () => ({ ok: true, data: {} }),
}));

const { Route: CollectionsRoute } = await import('@/routes/admin/collections');

type Entry = { isIntersecting: boolean };
const observers: Array<(entries: Entry[]) => void> = [];
class StubObserver {
  constructor(readonly fire: (entries: Entry[]) => void) {
    observers.push(fire);
  }
  observe() {}
  disconnect() {}
}

const product = (id: string, title: string) => ({ id, title, status: 'active', image_key: null });
const pages: Record<string, { products: ReturnType<typeof product>[]; nextCursor: string | null }> =
  {
    '': { products: [product('p1', 'Alpha tee'), product('p2', 'Beta tee')], nextCursor: 'c2' },
    c2: { products: [product('p3', 'Gamma tee')], nextCursor: null },
    gamma: { products: [product('p3', 'Gamma tee')], nextCursor: null },
  };

async function openPicker() {
  const { component, validateSearch } = CollectionsRoute.options;
  const rootRoute = createRootRoute({ component: Outlet });
  const collectionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/collections',
    ...(validateSearch ? { validateSearch } : {}),
    loaderDeps: ({ search }) => ({ key: search.q || search.pcursor }),
    loader: ({ deps }) => ({
      collections: [
        {
          id: 'col_1',
          slug: 'tees',
          title: 'Tees',
          description: '',
          seo_title: null,
          seo_description: null,
          kind: 'manual',
          rule_json: null,
          featured_rank: null,
          productIds: [],
        },
      ],
      memberProducts: [],
      previousCursor: null,
      refineSearch: false,
      ...pages[deps.key],
    }),
    ...(component ? { component } : {}),
  });
  await renderTree(rootRoute.addChildren([collectionsRoute]), '/admin/collections');
  await userEvent.click(await screen.findByText('Tees'));
  await userEvent.click(await screen.findByRole('button', { name: /^Products/ }));
  await userEvent.click(await screen.findByRole('button', { name: /^Add/ }));
  return screen.findByRole('dialog', { name: 'Add products' });
}

beforeEach(() => vi.stubGlobal('IntersectionObserver', StubObserver));
afterEach(() => {
  observers.length = 0;
  vi.unstubAllGlobals();
});

it('loading the next page keeps the products already listed', async () => {
  const picker = await openPicker();
  expect(within(picker).getByRole('button', { name: /Alpha tee/ })).toBeTruthy();

  observers.at(-1)?.([{ isIntersecting: true }]);

  expect(await within(picker).findByRole('button', { name: /Gamma tee/ })).toBeTruthy();
  expect(within(picker).getByRole('button', { name: /Alpha tee/ })).toBeTruthy();
  expect(within(picker).getByRole('button', { name: /Beta tee/ })).toBeTruthy();
});

it('a new search lists only its own results', async () => {
  const picker = await openPicker();
  const input = within(picker).getByRole('textbox', { name: 'Find products to add' });

  await userEvent.clear(input);
  await userEvent.type(input, 'gamma');

  expect(await within(picker).findByRole('button', { name: /Gamma tee/ })).toBeTruthy();
  await vi.waitFor(() =>
    expect(within(picker).queryByRole('button', { name: /Alpha tee/ })).toBeNull()
  );
});
