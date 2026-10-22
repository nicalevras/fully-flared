import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import {
  addCartLine,
  cartCookieHeader,
  cartCountCookieHeader,
  cartCountFromCookie,
  clearCart,
  getCartLines,
  parseCartCookie,
  priceCartLines,
  setCartLine,
} from '../web/src/server/cart';

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db, { onHand: 10 });
});
afterAll(async () => {
  await dispose();
});

describe('server cart with capability cookie', () => {
  it('creates a cart, prices its lines server-side, and reads them back from the cookie creds', async () => {
    const added = await addCartLine(db, null, 'TEE-1', 2);
    expect(added.created).toBe(true);
    const cookie = cartCookieHeader(added.creds);
    const creds = parseCartCookie(cookie.split(';')[0] ?? '');
    expect(creds).toEqual(added.creds);
    const lines = await getCartLines(db, creds);
    expect(lines).toEqual([{ sku: 'TEE-1', qty: 2 }]);
    const priced = await priceCartLines(db, lines);
    expect(priced).toHaveLength(1);
    expect(priced[0]?.priceCents).toBeGreaterThan(0);
    expect(priced[0]?.available).toBe(10);
  });

  it('a forged token reads nothing and cannot mutate the real cart', async () => {
    const added = await addCartLine(db, null, 'TEE-1', 1);
    const forged = { id: added.creds.id, token: 'forged-token' };
    expect(await getCartLines(db, forged)).toEqual([]);
    const mutated = await setCartLine(db, forged, 'TEE-1', 9);
    // A bad capability is treated as "no cart": a fresh cart is created
    // instead of touching the victim's.
    expect(mutated.creds.id).not.toBe(added.creds.id);
    expect(await getCartLines(db, added.creds)).toEqual([{ sku: 'TEE-1', qty: 1 }]);
  });

  it('a malformed cart cookie is treated as no cart instead of throwing', async () => {
    expect(parseCartCookie('cart=%')).toBeNull();
    expect(parseCartCookie('other=1; cart=%zz')).toBeNull();
    const added = await addCartLine(db, parseCartCookie('cart=%'), 'TEE-1', 1);
    expect(added.created).toBe(true);
  });

  it('the badge count comes from the count cookie with no database access', () => {
    expect(cartCountFromCookie(cartCountCookieHeader(3).split(';')[0] ?? '')).toBe(3);
    expect(cartCountFromCookie('cart=abc.def')).toBe(0);
    expect(cartCountFromCookie(null)).toBe(0);
  });

  it('setCartLine with qty 0 removes the line; clearCart converts the cart', async () => {
    const added = await addCartLine(db, null, 'TEE-1', 3);
    const removed = await setCartLine(db, added.creds, 'TEE-1', 0);
    expect(removed.lines).toEqual([]);
    const refilled = await addCartLine(db, added.creds, 'TEE-1', 1);
    await clearCart(db, refilled.creds);
    expect(await getCartLines(db, refilled.creds)).toEqual([]);
  });
});
