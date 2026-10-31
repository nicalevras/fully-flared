// @vitest-environment happy-dom
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRootRoute, createRoute } from '@tanstack/react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { GlobalSearchResult } from '@/server/admin-global-search';
import { renderTree } from './render-route';

const search = vi.fn(async ({ data }: { data: { q: string } }): Promise<GlobalSearchResult> => ({
  products: [{ id: 'p1', title: `${data.q} tee`, status: 'active' }],
  orders: [{ id: 'o1', number: '#1001', customer_email: 'ada@example.com' }],
  customers: [],
}));

vi.mock('@tanstack/react-start', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-start')>()),
  useServerFn: () => search,
}));

const { GlobalSearchDialog, GLOBAL_SEARCH_EVENT } = await import('@/components/GlobalSearch');
const { AdminNav } = await import('@/components/AdminNav');

async function openSearch() {
  const rootRoute = createRootRoute({ component: GlobalSearchDialog });
  const page = (path: string) => createRoute({ getParentRoute: () => rootRoute, path });
  const tree = rootRoute.addChildren([page('/admin/products'), page('/admin/orders/$id')]);
  const rendered = await renderTree(tree, '/');
  act(() => {
    window.dispatchEvent(new Event(GLOBAL_SEARCH_EVENT));
  });
  return { ...rendered, input: screen.getByLabelText('Search products, orders, and customers') };
}

beforeEach(() => {
  search.mockClear();
});

it('typing a query lists its matches', async () => {
  const user = userEvent.setup();
  const { input } = await openSearch();
  await user.type(input, 'blue');
  expect(await screen.findByRole('link', { name: /blue tee/ })).toBeTruthy();
  expect(search).toHaveBeenLastCalledWith({ data: { q: 'blue' } });
});

it('shortening the query below two characters clears the matches', async () => {
  const user = userEvent.setup();
  const { input } = await openSearch();
  await user.type(input, 'blue');
  await screen.findByRole('link', { name: /blue tee/ });
  await user.clear(input);
  await user.type(input, 'b');
  expect(screen.queryByRole('link')).toBeNull();
});

it('changing to another query immediately removes old links before debounce', async () => {
  const user = userEvent.setup();
  const { input, router } = await openSearch();
  await user.type(input, 'blue');
  await screen.findByRole('link', { name: /blue tee/ });
  await user.type(input, 's');
  expect(screen.queryByRole('link')).toBeNull();
  await user.keyboard('{Enter}');
  expect(router.state.location.pathname).toBe('/');
  expect(await screen.findByRole('link', { name: /blues tee/ })).toBeTruthy();
});

it('ignores a late error from a replaced query', async () => {
  let rejectOld: (error: Error) => void = () => {
    throw new Error('request not started');
  };
  search.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectOld = reject;
      })
  );
  const user = userEvent.setup();
  const { input } = await openSearch();
  await user.type(input, 'blue');
  await waitFor(() => expect(search).toHaveBeenCalled());
  await user.type(input, 's');
  await act(async () => {
    rejectOld(new Error('offline'));
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(await screen.findByRole('link', { name: /blues tee/ })).toBeTruthy();
});

it('contains keyboard focus while open', async () => {
  const user = userEvent.setup();
  await openSearch();
  const dialog = screen.getByRole('dialog', { name: 'Global search' });
  await user.click(screen.getByLabelText('Search products, orders, and customers'));
  for (let index = 0; index < 5; index++) {
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  }
});

it('arrow keys and Enter open the highlighted match', async () => {
  const user = userEvent.setup();
  const { input, router } = await openSearch();
  await user.type(input, 'blue');
  await screen.findByRole('link', { name: /#1001/ });
  await user.keyboard('{ArrowDown}{Enter}');
  await waitFor(() => expect(router.state.location.pathname).toBe('/admin/orders/o1'));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Escape closes the search', async () => {
  const user = userEvent.setup();
  const { input } = await openSearch();
  await user.type(input, 'blue');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('a failed search says so in an alert', async () => {
  search.mockRejectedValueOnce(new Error('offline'));
  const user = userEvent.setup();
  const { input } = await openSearch();
  await user.type(input, 'bl');
  expect((await screen.findByRole('alert')).textContent).toContain('Search failed');
});

it('the admin nav mobile trigger opens the search and closing returns focus to it', async () => {
  const user = userEvent.setup();
  const rootRoute = createRootRoute({ component: () => <AdminNav role="owner" /> });
  await renderTree(rootRoute, '/');
  const [trigger] = screen.getAllByRole('button', { name: 'Open global search' });
  if (!trigger) throw new Error('mobile search trigger missing');
  await user.click(trigger);
  expect(screen.getByRole('dialog', { name: 'Global search' })).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Global search' })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
