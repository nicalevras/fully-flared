// @vitest-environment happy-dom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { parseAdmissionConfig, parseLimits } from '@/schemas/limits';
import type { StoreSettings } from '@/server/settings';
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

const { Route: SettingsRoute } = await import('@/routes/admin/settings');

const settings: StoreSettings = {
  limits: parseLimits({}),
  admission: parseAdmissionConfig({}),
  storeName: 'Shop',
  logoMediaId: '',
  heroMediaId: '',
  currency: 'USD',
  currencyLocked: false,
  canonicalBaseUrl: '',
  emailFromName: '',
  emailFromAddress: 'shop@example.com',
  operationalAlertEmail: '',
  stripeTaxEnabled: false,
  stripeTaxConfirmed: false,
  collectShipping: true,
  announcementText: '',
  seoTitleTemplate: '',
  turnstileSiteKey: '',
  configRevision: 0,
  abandonedRemindersEnabled: false,
  mediaPublicBaseUrl: '',
};

async function renderSettings() {
  const { component } = SettingsRoute.options;
  const rootRoute = createRootRoute({ component: Outlet });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/settings',
    loader: () => ({
      settings,
      versions: { store_name: '2026-10-01T00:00:00.000Z' },
      checklist: [],
      logoSource: null,
      heroSource: null,
    }),
    ...(component ? { component } : {}),
  });
  const ordersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/orders',
    component: () => <h1>Orders</h1>,
  });
  const { router } = await renderTree(
    rootRoute.addChildren([settingsRoute, ordersRoute]),
    '/admin/settings'
  );
  return { router, storeName: await screen.findByLabelText('Store name') };
}

beforeEach(() => adminAction.mockClear());

it('navigation blocked while dirty', async () => {
  const { router, storeName } = await renderSettings();
  await userEvent.clear(storeName);
  await userEvent.type(storeName, 'New shop');

  router.history.push('/admin/orders');
  const dialog = await screen.findByRole('alertdialog', { name: 'Leave with unsaved settings?' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(router.state.location.pathname).toBe('/admin/settings');
  expect(screen.getByLabelText('Store name')).toHaveProperty('value', 'New shop');

  router.history.push('/admin/orders');
  const again = await screen.findByRole('alertdialog', { name: 'Leave with unsaved settings?' });
  await userEvent.click(within(again).getByRole('button', { name: 'Leave and discard' }));
  expect(await screen.findByRole('heading', { name: 'Orders' })).toBeTruthy();
  expect(adminAction).not.toHaveBeenCalled();
});

it('an untouched or saved form leaves without asking', async () => {
  const { router, storeName } = await renderSettings();
  await userEvent.clear(storeName);
  await userEvent.type(storeName, 'New shop');
  await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(adminAction).toHaveBeenCalledWith('settings.setMany', {
    changes: [
      { key: 'store_name', value: 'New shop', expectedUpdatedAt: '2026-10-01T00:00:00.000Z' },
    ],
  });

  router.history.push('/admin/orders');
  expect(await screen.findByRole('heading', { name: 'Orders' })).toBeTruthy();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});
