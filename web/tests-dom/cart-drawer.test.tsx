// @vitest-environment happy-dom
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { CartDrawer } from '@/components/CartDrawer';
import { Route as CartRoute } from '@/routes/_shop.cart';
import { cartView, line, zone } from './fixtures';
import { renderPage } from './render-route';

const view = cartView(
  [line('TEE-1')],
  [zone('north', ['CA'], 5_000), zone('europe', ['GB'], 10_000)]
);
const CartPage = CartRoute.options.component;

function CartWithDrawer() {
  return (
    <>
      {CartPage ? <CartPage /> : null}
      <CartDrawer initial={view} />
    </>
  );
}

it('progress uses selected zone threshold', async () => {
  await renderPage(CartWithDrawer, view);
  const country = await screen.findByRole('combobox', { name: 'Country' });
  country.focus();
  await userEvent.keyboard('{Enter}');
  await userEvent.click(await screen.findByRole('option', { name: 'United Kingdom' }));
  expect(country.textContent).toBe('United Kingdom');

  act(() => {
    window.dispatchEvent(new Event('cart-open'));
  });
  const drawer = await screen.findByRole('dialog', { name: /Your cart/ });
  expect(within(drawer).queryByText('$40.00')).toBeNull();
  expect(within(drawer).getByText('$90.00')).toBeTruthy();
});
