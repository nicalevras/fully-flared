// @vitest-environment happy-dom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ProductDetail } from '@/components/ProductEditor';
import { renderPage } from './render-route';

const adminAction = vi.hoisted(() =>
  vi.fn<
    (
      action: string,
      payload: object
    ) => Promise<{ ok: boolean; error?: string; conflict?: boolean; data?: object }>
  >(async () => ({ ok: true, data: {} }))
);
vi.mock('@/components/AdminNav', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/AdminNav')>()),
  useAdminAction: () => adminAction,
}));

const { ProductEditor } = await import('@/components/ProductEditor');

const product = (version: number, weight: number): ProductDetail => ({
  id: 'p1',
  slug: 'tee',
  title: 'Tee',
  description: '',
  status: 'active',
  seo_title: null,
  seo_description: null,
  revision: 1,
  processed_revision: 1,
  variants: [
    {
      id: 'v1',
      sku: 'TEE-1',
      title: 'Default',
      price_cents: 2000,
      compare_at_cents: null,
      status: 'active',
      weight_grams: weight,
      continue_selling: 0,
      version,
      on_hand: 5,
      reserved: 0,
    },
  ],
  media: [],
  collections: [],
  allCollections: [],
});

beforeEach(() => adminAction.mockClear());

/** The editor with a stand-in for the product route: "Another session
 * saves" swaps in the row the next reload would bring back. */
function Harness() {
  const [loaded, setLoaded] = useState(() => product(3, 100));
  const [next, setNext] = useState(loaded);
  return (
    <>
      <button type="button" onClick={() => setNext(product(4, 250))}>
        Another session saves
      </button>
      <ProductEditor
        product={loaded}
        open
        onClose={() => {}}
        refresh={async () => setLoaded(next)}
      />
    </>
  );
}

const variantSaves = () =>
  adminAction.mock.calls.filter(([action]) => action === 'variant.save').map(([, p]) => p);

async function editWeight(value: string) {
  await userEvent.click(await screen.findByRole('button', { name: 'Variants', hidden: true }));
  const weight = await screen.findByLabelText('Weight for TEE-1');
  await userEvent.clear(weight);
  await userEvent.type(weight, value);
  return weight;
}

it('a variant edit is saved against the version it was loaded at', async () => {
  await renderPage(Harness, {});
  await editWeight('120');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes', hidden: true }));

  expect(variantSaves()).toEqual([
    expect.objectContaining({ variantId: 'v1', weightGrams: 120, expectedVersion: 3 }),
  ]);
});

it('a stale variant save keeps the edit and offers a reload', async () => {
  adminAction.mockResolvedValueOnce({ ok: false, conflict: true, error: 'Changed elsewhere.' });
  await renderPage(Harness, {});
  await editWeight('120');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes', hidden: true }));

  expect(
    await screen.findByText('The saved version changed. Your edits are still here.')
  ).toBeTruthy();
  expect(screen.getByLabelText('Weight for TEE-1')).toHaveProperty('value', '120');
});

it('an unrelated reload does not make a stale edit current', async () => {
  adminAction.mockImplementation(async (action) =>
    action === 'variant.save'
      ? { ok: false, conflict: true, error: 'Changed elsewhere.' }
      : { ok: true, data: {} }
  );
  await renderPage(Harness, {});
  await editWeight('120');
  await userEvent.click(
    screen.getByRole('button', { name: 'Another session saves', hidden: true })
  );
  await userEvent.type(await screen.findByLabelText('Title'), ' shirt');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes', hidden: true }));
  await userEvent.click(screen.getByRole('button', { name: 'Save changes', hidden: true }));

  expect(variantSaves()).toEqual([
    expect.objectContaining({ expectedVersion: 3 }),
    expect.objectContaining({ expectedVersion: 3 }),
  ]);
  adminAction.mockReset();
  adminAction.mockImplementation(async () => ({ ok: true, data: {} }));
});

it('reloading the current version lets the edit save over it', async () => {
  adminAction.mockResolvedValueOnce({ ok: false, conflict: true, error: 'Changed elsewhere.' });
  await renderPage(Harness, {});
  await editWeight('120');
  await userEvent.click(
    screen.getByRole('button', { name: 'Another session saves', hidden: true })
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save changes', hidden: true }));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Reload current version', hidden: true })
  );
  expect(screen.getByLabelText('Weight for TEE-1')).toHaveProperty('value', '120');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes', hidden: true }));

  expect(variantSaves()).toEqual([
    expect.objectContaining({ weightGrams: 120, expectedVersion: 3 }),
    expect.objectContaining({ weightGrams: 120, expectedVersion: 4 }),
  ]);
});
