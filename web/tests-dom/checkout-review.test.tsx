// @vitest-environment happy-dom
import { Profiler } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CartView } from '@/lib/cartFns';
import type { StoreLimits } from '@/lib/settings-definitions';
import { Route } from '@/routes/checkout/index';

const fns = vi.hoisted(() => ({
  getCart: vi.fn(),
  quote: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@tanstack/react-start', async (importOriginal) => {
  type Builder = {
    validator: () => Builder;
    handler: () => () => Promise<unknown>;
  };
  const builder: Builder = {
    validator: () => builder,
    handler: () => async () => ({ turnstileSiteKey: '', authenticated: true }),
  };
  return {
    ...(await importOriginal<typeof import('@tanstack/react-start')>()),
    createServerFn: () => builder,
    useServerFn: <T,>(fn: T) => fn,
  };
});
vi.mock('@/lib/cartFns', () => ({
  getCart: fns.getCart,
  setCartLineFn: vi.fn(),
  addCartLineFn: vi.fn(),
  clearCartFn: vi.fn(),
}));
vi.mock('@/lib/shopFns', () => ({ checkoutQuoteFn: fns.quote, validateDiscountFn: vi.fn() }));
vi.mock('@/lib/checkoutFns', () => ({ confirmCheckoutFn: fns.confirm }));
vi.mock('@/lib/use-store-currency', () => ({ useStoreCurrency: () => 'USD' }));

const limits: StoreLimits = {
  checkout_email_cap: 5,
  checkout_account_cap: 5,
  checkout_ip_cap: 10,
  cart_max_qty: 99,
  cart_max_lines: 50,
  order_max_units: 500,
  checkout_session_minutes: 32,
  refund_retry_cap: 5,
  refund_stuck_minutes: 60,
};

function cartView(cartRevision: number): CartView {
  return {
    cartId: 'cart-1',
    cartRevision,
    limits,
    count: 1,
    lines: [
      {
        sku: 'TEE-1',
        qty: 1,
        weightGrams: null,
        continueSelling: false,
        priceCents: 2000,
        productTitle: 'Tee',
        variantTitle: 'Default',
        available: 5,
        cover: null,
      },
    ],
    zones: [
      {
        id: 'zone-us',
        name: 'United States',
        countries: ['US'],
        rates: [
          {
            id: 'rate-std',
            name: 'Standard',
            kind: 'flat',
            amountCents: 500,
            freeOverCents: null,
            perKgCents: null,
          },
        ],
      },
    ],
  };
}

const reviewQuote = {
  subtotalCents: 2000,
  discountCents: 0,
  shippingCents: 500,
  taxCents: 200,
  totalCents: 2700,
  currency: 'USD',
};

function reviewResponse() {
  return new Response(
    JSON.stringify({
      state: 'review_ready',
      intentId: 'intent-1',
      quoteHash: 'hash-1',
      quote: reviewQuote,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

const fetchMock = vi.fn<typeof fetch>();
const commits: Array<{ email: string; review: boolean; canReview: boolean }> = [];

beforeEach(() => {
  commits.length = 0;
  fns.getCart.mockResolvedValue(cartView(1));
  fns.quote.mockReset();
  fns.quote.mockImplementation(async () => ({
    configRevision: 1,
    subtotalCents: 2000,
    discountCents: 0,
    shippingCents: 500,
    totalCents: 2500,
    currency: 'USD',
    items: [{ sku: 'TEE-1', unitPriceCents: 2000 }],
  }));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

function recordCommit() {
  const email = document.getElementById('ck-email');
  commits.push({
    email: email instanceof HTMLInputElement ? email.value : '',
    review: screen.queryByText('Review your order') !== null,
    canReview:
      screen.queryByRole('button', { name: /^Review order/ })?.hasAttribute('disabled') === false,
  });
}

async function renderCheckout() {
  const router = createRouter({
    routeTree: Route,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  render(
    <Profiler id="checkout" onRender={recordCommit}>
      <RouterProvider router={router} />
    </Profiler>
  );
  await screen.findByLabelText('Email');
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function fillDetails() {
  type('Email', 'shopper@example.com');
  type('Full name', 'Ada Shopper');
  type('Address', '1 Main St');
  type('City', 'Springfield');
  type('Postal code', '12345');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Review order/ }).hasAttribute('disabled')).toBe(
      false
    )
  );
}

async function openReview() {
  fetchMock.mockResolvedValueOnce(reviewResponse());
  fireEvent.click(screen.getByRole('button', { name: /^Review order/ }));
  await screen.findByText('Review your order');
}

it('editing email hides the review in the same render', async () => {
  await renderCheckout();
  await fillDetails();
  await openReview();

  commits.length = 0;
  type('Email', 'other@example.com');

  expect(commits.length).toBeGreaterThan(0);
  expect(commits.filter((c) => c.email === 'other@example.com' && c.review)).toEqual([]);
  expect(screen.queryByText('Review your order')).toBeNull();
});

it('editing email drops the old quote in the same render', async () => {
  await renderCheckout();
  await fillDetails();

  commits.length = 0;
  type('Email', 'other@example.com');

  expect(commits.length).toBeGreaterThan(0);
  expect(commits.filter((c) => c.email === 'other@example.com' && c.canReview)).toEqual([]);
  expect(fns.quote).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(fns.quote).toHaveBeenCalledTimes(2));
  expect(fns.quote).toHaveBeenLastCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ email: 'other@example.com' }) })
  );
});

it('submit after a details change is rejected', async () => {
  await renderCheckout();
  await fillDetails();
  let respond: (response: Response) => void = () => {};
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      respond = resolve;
    })
  );
  fireEvent.click(screen.getByRole('button', { name: /^Review order/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  act(() => {
    window.dispatchEvent(new CustomEvent('cart-changed', { detail: { view: cartView(2) } }));
  });
  await act(async () => respond(reviewResponse()));

  expect(await screen.findByText('Checkout details changed. Prepare a fresh review.')).toBeTruthy();
  expect(screen.queryByText('Review your order')).toBeNull();
});

it('unchanged details keep the review', async () => {
  await renderCheckout();
  await fillDetails();
  await openReview();

  type('Discount code', 'SAVE10');

  expect(screen.getByText('Review your order')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Confirm and pay/ }).hasAttribute('disabled')).toBe(
    false
  );
});
