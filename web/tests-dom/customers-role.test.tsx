// @vitest-environment happy-dom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { beforeEach, expect, it, vi } from 'vitest';
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

const { Route: CustomersRoute } = await import('@/routes/admin/customers');

async function renderCustomers() {
  const { component, validateSearch } = CustomersRoute.options;
  const rootRoute = createRootRoute({ component: Outlet });
  const customersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/customers',
    ...(validateSearch ? { validateSearch } : {}),
    loader: () => ({
      customers: [
        {
          id: 'u_ada',
          name: 'Ada',
          email: 'ada@example.com',
          role: 'customer',
          created_at: 1_790_000_000_000,
          orders: 0,
          last_order_at: null,
          spending: [],
        },
      ],
      total: 1,
      page: 1,
      lookup: null,
      history: null,
      myRole: 'owner',
      myId: 'u_owner',
    }),
    ...(component ? { component } : {}),
  });
  await renderTree(rootRoute.addChildren([customersRoute]), '/admin/customers');
  return screen.findByLabelText('Role for ada@example.com');
}

beforeEach(() => adminAction.mockClear());

it('changing select alone sends nothing', async () => {
  const select = await renderCustomers();

  await userEvent.selectOptions(select, 'support');
  expect(adminAction).not.toHaveBeenCalled();
  expect(select.isConnected).toBe(true);
  expect(document.activeElement).toBe(select);
  expect(select).toHaveProperty('value', 'support');

  await userEvent.click(screen.getByRole('button', { name: 'Save role for ada@example.com' }));
  expect(adminAction).not.toHaveBeenCalled();
  const dialog = await screen.findByRole('alertdialog', { name: 'Change this role?' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Make support' }));

  expect(adminAction).toHaveBeenCalledTimes(1);
  expect(adminAction).toHaveBeenCalledWith('user.setRole', { userId: 'u_ada', role: 'support' });
});

it('discarding a staged role restores the saved one', async () => {
  const select = await renderCustomers();

  await userEvent.selectOptions(select, 'manager');
  await userEvent.click(
    screen.getByRole('button', { name: 'Discard role change for ada@example.com' })
  );

  expect(screen.getByLabelText('Role for ada@example.com')).toHaveProperty('value', 'customer');
  expect(screen.queryByRole('button', { name: /Save role/ })).toBeNull();
  expect(adminAction).not.toHaveBeenCalled();
});

it('making someone an owner spells out what that grants', async () => {
  const select = await renderCustomers();

  await userEvent.selectOptions(select, 'owner');
  await userEvent.click(screen.getByRole('button', { name: 'Save role for ada@example.com' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Make this account an owner?' });

  expect(dialog.textContent).toContain('every setting and every role');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(adminAction).not.toHaveBeenCalled();
});
