// @vitest-environment happy-dom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AdminReturnRow } from '@/server/admin-lists';
import { renderTree } from './render-route';

const adminAction = vi.hoisted(() =>
  vi.fn<(action: string, payload: object) => Promise<{ ok: true; data: object }>>(async () => ({
    ok: true,
    data: {},
  }))
);
vi.mock('@/components/AdminNav', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/AdminNav')>()),
  useAdminAction: () => adminAction,
}));

const { Route: OrdersRoute } = await import('@/routes/admin/orders/index');

const requestedReturn: AdminReturnRow = {
  id: 'ret_1',
  order_id: 'ord_1',
  number: '#1001',
  reason: 'Too small',
  status: 'requested',
  created_at: '2026-10-01T00:00:00.000Z',
  total_cents: 2000,
  currency: 'USD',
  refundable_cents: 2000,
  refund_status: null,
};

async function renderReturns() {
  const { component, validateSearch } = OrdersRoute.options;
  const rootRoute = createRootRoute({ component: Outlet });
  const ordersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/orders/',
    ...(validateSearch ? { validateSearch } : {}),
    loader: () => ({
      orders: [],
      returns: [requestedReturn],
      nextCursor: null,
      previousCursor: null,
      returnsNextCursor: null,
      returnsPreviousCursor: null,
      canRefund: true,
      canApprove: true,
      canReject: true,
    }),
    ...(component ? { component } : {}),
  });
  await renderTree(rootRoute.addChildren([ordersRoute]), '/admin/orders/?view=returns');
  return screen.findByRole('table', { name: 'Return requests' });
}

beforeEach(() => adminAction.mockClear());

it('approve requires confirm', async () => {
  const table = await renderReturns();

  await userEvent.click(within(table).getByRole('button', { name: 'Approve return' }));
  expect(adminAction).not.toHaveBeenCalled();
  const dialog = await screen.findByRole('alertdialog', { name: 'Approve this return?' });

  await userEvent.click(within(dialog).getByRole('button', { name: 'Approve return' }));
  expect(adminAction).toHaveBeenCalledTimes(1);
  expect(adminAction).toHaveBeenCalledWith('return.approve', { returnId: 'ret_1' });
});

it('reject requires confirm, and cancel sends nothing', async () => {
  const table = await renderReturns();

  await userEvent.click(within(table).getByRole('button', { name: 'Reject' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Reject this return?' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(adminAction).not.toHaveBeenCalled();

  await userEvent.click(within(table).getByRole('button', { name: 'Reject' }));
  await userEvent.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reject return' })
  );
  expect(adminAction).toHaveBeenCalledTimes(1);
  expect(adminAction).toHaveBeenCalledWith('return.reject', { returnId: 'ret_1' });
});
