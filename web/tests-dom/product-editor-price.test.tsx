// @vitest-environment happy-dom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProductEditor, type ProductDetail } from '@/components/ProductEditor';
import type { AdminPayload } from '@/components/AdminNav';
import { renderRoute } from './render-route';

const action = vi.fn(async (_action: string, _payload: AdminPayload) => ({ ok: true as const }));

vi.mock('@/components/AdminNav', () => ({ useAdminAction: () => action }));
vi.mock('@/lib/use-store-currency', () => ({ useStoreCurrency: () => 'USD' }));
vi.mock('@/components/ExpandableEditor', () => ({ ExpandableEditor: () => null }));

beforeEach(() => {
  action.mockClear();
});

const product: ProductDetail = {
  id: 'p1',
  slug: 'tote',
  title: 'Tote',
  description: '',
  status: 'active',
  seo_title: null,
  seo_description: null,
  revision: null,
  processed_revision: null,
  variants: [
    {
      id: 'v1',
      sku: 'TOTE-001',
      title: 'Default',
      price_cents: 2000,
      compare_at_cents: null,
      status: 'active',
      weight_grams: null,
      continue_selling: 0,
      on_hand: 5,
      reserved: 0,
    },
  ],
  media: [],
  collections: [],
  allCollections: [],
};

async function openVariants() {
  await renderRoute(() => (
    <ProductEditor product={product} open onClose={() => {}} refresh={async () => {}} />
  ));
  await userEvent.click(await screen.findByRole('button', { name: 'Variants', hidden: true }));
}

const variantPrice = () => screen.getByLabelText('Price', { selector: '#v-price-v1' });
const save = () => screen.getByRole('button', { name: 'Save changes', hidden: true });
const savedVariants = () => action.mock.calls.filter(([name]) => name === 'variant.save');

it('typing "12.50" saves 1250 cents', async () => {
  await openVariants();
  await userEvent.clear(variantPrice());
  await userEvent.type(variantPrice(), '12.50');
  expect(variantPrice()).toHaveProperty('value', '12.50');

  await userEvent.click(save());
  expect(savedVariants()).toEqual([
    ['variant.save', expect.objectContaining({ variantId: 'v1', priceCents: 1250 })],
  ]);
});

it('clearing price shows an error instead of 0', async () => {
  await openVariants();
  await userEvent.clear(variantPrice());
  expect(variantPrice()).toHaveProperty('value', '');

  await userEvent.click(save());
  expect(screen.getByRole('alert', { hidden: true }).textContent).toMatch(/price/i);
  expect(savedVariants()).toEqual([]);
});

it('blank new-variant price blocks Add', async () => {
  await openVariants();
  await userEvent.type(screen.getByLabelText('New SKU', { selector: 'input' }), 'TOTE-002');
  const newPrice = screen.getByLabelText('Price', { selector: '#nv-price' });
  await userEvent.clear(newPrice);
  await userEvent.click(screen.getByRole('button', { name: 'Add variant', hidden: true }));

  expect(screen.queryByText('New — will be added on save')).toBeNull();
  expect(screen.getByRole('alert', { hidden: true }).textContent).toMatch(/price/i);
});
