// @vitest-environment happy-dom
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRootRoute, createRoute } from '@tanstack/react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PublishedProductCard } from '@/server/catalog';
import { renderTree } from './render-route';

const card = (slug: string): PublishedProductCard => ({
  id: slug,
  slug,
  title: `${slug} product`,
  status: 'active',
  priceCents: 1000,
  imageKey: null,
});

const server = vi.fn(
  async (request?: {
    data: { q: string };
  }): Promise<PublishedProductCard[] | { cards: PublishedProductCard[]; hasMore: boolean }> =>
    request
      ? { cards: [card(`${request.data.q}-one`), card(`${request.data.q}-two`)], hasMore: false }
      : [card('suggested')]
);

vi.mock('@tanstack/react-start', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-start')>()),
  useServerFn: () => server,
}));

const { SearchPaletteDialog, openSearchPalette } = await import('@/components/SearchPalette');

async function openPalette() {
  const rootRoute = createRootRoute({
    loader: () => ({ currency: 'USD' }),
    component: SearchPaletteDialog,
  });
  const product = createRoute({ getParentRoute: () => rootRoute, path: '/products/$slug' });
  const rendered = await renderTree(rootRoute.addChildren([product]), '/');
  act(() => openSearchPalette());
  return { ...rendered, input: await screen.findByRole('combobox', { name: 'Search products' }) };
}

const searched = () => server.mock.calls.filter(([request]) => request !== undefined);

beforeEach(() => {
  server.mockClear();
});

it('opening the palette lists the suggested products', async () => {
  await openPalette();
  expect(await screen.findByRole('option', { name: /suggested product/ })).toBeTruthy();
});

it('typing three characters lists that query’s results', async () => {
  const user = userEvent.setup();
  const { input } = await openPalette();
  await user.type(input, 'tee');
  expect(await screen.findByRole('option', { name: /tee-one product/ })).toBeTruthy();
  expect(screen.queryByRole('option', { name: /suggested product/ })).toBeNull();
});

it('shortening the query back under three characters shows the suggestions again', async () => {
  const user = userEvent.setup();
  const { input } = await openPalette();
  await user.type(input, 'tee');
  await screen.findByRole('option', { name: /tee-one product/ });
  await user.keyboard('{Backspace}');
  expect(await screen.findByRole('option', { name: /suggested product/ })).toBeTruthy();
});

it('returning to a query already searched reuses its results without searching again', async () => {
  const user = userEvent.setup();
  const { input } = await openPalette();
  await user.type(input, 'cap');
  await screen.findByRole('option', { name: /cap-one product/ });
  await user.type(input, 's');
  await screen.findByRole('option', { name: /caps-one product/ });
  await user.keyboard('{Backspace}');
  expect(await screen.findByRole('option', { name: /cap-one product/ })).toBeTruthy();
  expect(searched().map(([request]) => request?.data.q)).toEqual(['cap', 'caps']);
});

it('arrow keys and Enter open the highlighted product', async () => {
  const user = userEvent.setup();
  const { input, router } = await openPalette();
  await user.type(input, 'hat');
  await screen.findByRole('option', { name: /hat-two product/ });
  await user.keyboard('{ArrowDown}');
  expect(
    screen.getByRole('option', { name: /hat-two product/ }).getAttribute('aria-selected')
  ).toBe('true');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(router.state.location.pathname).toBe('/products/hat-two'));
});
