import { expect, it } from 'vitest';
import { isRedirect } from '../web/node_modules/@tanstack/react-router';
import { Route, guardAdminHome } from '../web/src/routes/admin/index';

function enterAdminHome(role: string) {
  expect(Route.options.beforeLoad).toBe(guardAdminHome);
  try {
    guardAdminHome({ context: { staff: { role } } });
    return 'stays';
  } catch (error) {
    if (isRedirect(error)) return error.options.to;
    throw error;
  }
}

it('sends staff without report access from /admin to the orders list', () => {
  expect(enterAdminHome('warehouse')).toBe('/admin/orders');
  expect(enterAdminHome('support')).toBe('/admin/orders');
});

it('keeps staff with report access on the admin home', () => {
  for (const role of ['owner', 'admin', 'manager']) expect(enterAdminHome(role)).toBe('stays');
});
