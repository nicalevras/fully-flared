// @vitest-environment happy-dom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { expect, it } from 'vitest';
import { Route } from '@/routes/_shop.search';
import { catalogSearch } from '@/lib/search-params';
import { renderTree } from './render-route';

const card = (id: string) => ({
  id,
  slug: id,
  title: `Product ${id}`,
  status: 'active' as const,
  priceCents: 1000,
  imageKey: null,
});

const pages: Record<string, { cards: ReturnType<typeof card>[]; nextCursor: string | null }> = {
  first: { cards: [card('first')], nextCursor: 'second' },
  second: { cards: [card('second')], nextCursor: null },
};

async function renderSearch(path: string) {
  const { component } = Route.options;
  const rootRoute = createRootRoute({ loader: () => ({ currency: 'USD' }), component: Outlet });
  const searchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/search',
    validateSearch: catalogSearch,
    loaderDeps: ({ search: { q, cursor } }) => ({ q, cursor }),
    loader: ({ deps }) => pages[deps.cursor ?? 'first'] ?? pages.first,
    ...(component ? { component } : {}),
  });
  return renderTree(rootRoute.addChildren([searchRoute]), path);
}

it('back returns to page 1', async () => {
  await renderSearch('/search?q=tee');
  expect(await screen.findByText('Product first')).toBeTruthy();

  await userEvent.click(screen.getByRole('link', { name: 'More results' }));
  expect(await screen.findByText('Product second')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('Page 2');

  await userEvent.click(screen.getByRole('link', { name: 'Back to page 1' }));
  expect(await screen.findByText('Product first')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Back to page 1' })).toBeNull();
});

it('the empty search copy matches a form that searches on submit', async () => {
  await renderSearch('/search');
  const hint = await screen.findByText(/titles and descriptions/);

  expect(hint.textContent).not.toMatch(/start typing/i);
  expect(hint.textContent).toContain('press Search');
});
