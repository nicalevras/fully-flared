// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { expect, it, vi } from 'vitest';
import { Route as SuccessRoute } from '@/routes/checkout/success';

const loadOrder = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-start', async (importOriginal) => {
  type Builder = {
    validator: () => Builder;
    handler: () => () => Promise<unknown>;
  };
  const builder: Builder = {
    validator: () => builder,
    handler: () => async () => loadOrder(),
  };
  return {
    ...(await importOriginal<typeof import('@tanstack/react-start')>()),
    createServerFn: () => builder,
  };
});

const order = (guest: boolean) => ({
  number: 'FF-1042',
  status: 'paid',
  payment_status: 'paid',
  total_cents: 2000,
  currency: 'USD',
  customer_email: 'guest@example.com',
  guest,
  items: [{ sku: 'TOTE-001', title: 'Tote', qty: 1, unit_price_cents: 2000 }],
});

async function renderSuccess() {
  const router = createRouter({
    routeTree: SuccessRoute,
    history: createMemoryHistory({ initialEntries: ['/?order=o1&t=signed'] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
}

it('guest sees contact path', async () => {
  loadOrder.mockResolvedValue(order(true));
  await renderSuccess();

  const returns = await screen.findByRole('region', { name: 'Returns' });
  expect(returns.textContent).toContain(
    'To return something from this order, reply to your order confirmation email and include order FF-1042.'
  );
});

it('an account order points to the account for returns', async () => {
  loadOrder.mockResolvedValue(order(false));
  await renderSuccess();

  await screen.findByText('FF-1042');
  expect(screen.queryByRole('region', { name: 'Returns' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Track your order' })).toBeTruthy();
});
