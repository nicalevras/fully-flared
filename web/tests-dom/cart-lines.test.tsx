// @vitest-environment happy-dom
import { screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Route } from '@/routes/_shop.cart';
import { cartView, line, zone } from './fixtures';
import { renderPage } from './render-route';

it('shows option title and over-stock warning', async () => {
  await renderPage(
    Route.options.component,
    cartView(
      [
        line('TEE-L', { productTitle: 'Tee', variantTitle: 'Large', qty: 3, available: 2 }),
        line('MUG-1', {
          productTitle: 'Mug',
          variantTitle: 'Blue',
          qty: 4,
          available: 1,
          continueSelling: true,
        }),
      ],
      [zone('north', ['CA'])]
    )
  );
  const [tee, mug] = await screen.findAllByRole('listitem');
  if (!tee || !mug) throw new Error('expected two cart lines');

  expect(within(tee).getByText(/Large/)).toBeTruthy();
  expect(within(tee).queryByText(/TEE-L/)).toBeNull();
  expect(within(tee).getByRole('alert').textContent).toBe(
    'Only 2 left. Lower the quantity to check out.'
  );
  expect(within(mug).getByText(/Blue/)).toBeTruthy();
  expect(within(mug).queryByRole('alert')).toBeNull();
});
