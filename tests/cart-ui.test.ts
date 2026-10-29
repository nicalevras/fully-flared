import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CartLockUnavailableError,
  nextQtyOnIncrement,
  ratePriceLabel,
  withCartMutationLock,
  zoneForCountry,
  type CartMutationLocks,
  type Zone,
  type ZoneRate,
} from '../web/src/lib/cart';

describe('cart "+" increment', () => {
  it('adds one below the limit', () => {
    expect(nextQtyOnIncrement(3, 10)).toBe(4);
  });

  it('stops at the configured limit', () => {
    expect(nextQtyOnIncrement(9, 10)).toBe(10);
    expect(nextQtyOnIncrement(10, 10)).toBe(10);
  });

  it('never decreases a quantity already above a lowered limit', () => {
    expect(nextQtyOnIncrement(10, 5)).toBe(10);
  });

  it('both "+" handlers use the helper, not an availability cap', () => {
    const cartPage = readFileSync('web/src/routes/_shop.cart.tsx', 'utf8');
    const drawer = readFileSync('web/src/components/CartDrawer.tsx', 'utf8');
    for (const source of [cartPage, drawer]) {
      expect(source).toContain('nextQtyOnIncrement(l.qty, view.limits.cart_max_qty)');
      expect(source).not.toContain('continueSelling ? Infinity : l.available');
    }
  });
});

describe('zone selection', () => {
  const zones = [
    { name: 'Canada', countries: ['CA'], rates: [] },
    { name: 'Europe', countries: ['DE', 'FR'], rates: [] },
  ] as unknown as Zone[];

  it('returns the serving zone and undefined for an unsupported destination', () => {
    expect(zoneForCountry(zones, 'CA')?.name).toBe('Canada');
    expect(zoneForCountry(zones, 'FR')?.name).toBe('Europe');
    expect(zoneForCountry(zones, 'US')).toBeUndefined();
    expect(zoneForCountry([], 'CA')).toBeUndefined();
  });

  it('cart page has no first-zone fallback and surfaces update state', () => {
    const page = readFileSync('web/src/routes/_shop.cart.tsx', 'utf8');
    expect(page).not.toContain('?? zones[0]');
    expect(page).toContain('zoneForCountry(zones, country)');
    expect(page).toContain('Delivery is not available to {country}');
    expect(page).toContain('disabled={pending}');
    expect(page).toContain('role="alert"');
  });
});

describe('delivery option label', () => {
  it('weight-based rate displays base plus rounded-up per-kg charge ($9, not $5)', () => {
    const rate = {
      id: 'w1',
      name: 'Weighted',
      kind: 'weight',
      amountCents: 500,
      perKgCents: 200,
      freeOverCents: null,
    } as ZoneRate;
    // 1.5 kg rounds up to 2 kg: $5.00 + 2 x $2.00 = $9.00.
    expect(ratePriceLabel(rate, 10_000, 1500, 'USD')).toBe('$9.00');
  });

  it('free-over rate at the threshold displays Free; flat rate displays its amount', () => {
    const freeOver = {
      id: 'f1',
      name: 'Free over',
      kind: 'free_over',
      amountCents: 700,
      perKgCents: null,
      freeOverCents: 5_000,
    } as ZoneRate;
    expect(ratePriceLabel(freeOver, 5_000, 0, 'USD')).toBe('Free');
    expect(ratePriceLabel(freeOver, 4_999, 0, 'USD')).toBe('$7.00');
  });

  it('cart page label is wired to ratePriceLabel', () => {
    const cartPage = readFileSync('web/src/routes/_shop.cart.tsx', 'utf8');
    expect(cartPage).toContain('ratePriceLabel(r, subtotal, totalWeight, currency)');
    expect(cartPage).not.toContain('formatMoney(r.amountCents, currency)');
  });
});

describe('cart mutation lock', () => {
  function fakeLocks() {
    let tail: Promise<void> = Promise.resolve();
    let active = 0;
    let maxActive = 0;
    const locks: CartMutationLocks = {
      request: async (_name, _options, callback) => {
        const run = tail.then(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            await callback();
          } finally {
            active--;
          }
        });
        tail = run.catch(() => {});
        await run;
      },
    };
    return { locks, maxActive: () => maxActive };
  }

  it('serializes two concurrent mutations into one-at-a-time runs', async () => {
    const { locks, maxActive } = fakeLocks();
    const order: string[] = [];
    const slow = (label: string) => async () => {
      order.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`${label}:end`);
      return label;
    };
    const results = await Promise.all([
      withCartMutationLock(locks, slow('a')),
      withCartMutationLock(locks, slow('b')),
    ]);
    expect(results).toEqual(['a', 'b']);
    expect(maxActive()).toBe(1);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('fails closed with no locks and never runs the mutation', async () => {
    let ran = false;
    await expect(
      withCartMutationLock(undefined, async () => {
        ran = true;
      })
    ).rejects.toBeInstanceOf(CartLockUnavailableError);
    expect(ran).toBe(false);
  });
});
