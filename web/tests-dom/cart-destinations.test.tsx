// @vitest-environment happy-dom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { Route } from '@/routes/_shop.cart';
import { cartView, line, zone } from './fixtures';
import { renderPage } from './render-route';

it('US listed once; default is first shippable', async () => {
  await renderPage(
    Route.options.component,
    cartView([line('TEE-1')], [zone('north', ['CA', 'US']), zone('europe', ['GB', 'US'])])
  );
  const country = await screen.findByRole('combobox', { name: 'Country' });
  expect(country.textContent).toBe('Canada');
  expect(screen.getByText('Delivery — north zone')).toBeTruthy();

  country.focus();
  await userEvent.keyboard('{Enter}');
  const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
  expect(options).toEqual(['Canada', 'United States', 'United Kingdom']);
});

it('no admin copy', async () => {
  await renderPage(Route.options.component, cartView([line('TEE-1')], []));
  const summary = await screen.findByLabelText('Order summary');

  expect(summary.textContent).not.toMatch(/admin|store owner/i);
  expect(summary.textContent).toContain('Delivery is not available yet');
});
