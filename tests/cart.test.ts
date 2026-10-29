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
import { mediaUrl } from '../web/src/lib/media-url';

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

  it('prices lines with the cover so callers reuse the smallest variant', async () => {
    const noMedia = await priceCartLines(db, [{ sku: 'TEE-1', qty: 1 }]);
    expect(noMedia[0]?.cover).toBeNull();
    const now = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          "INSERT INTO media (id,r2_key,filename,content_type,created_at,ready) VALUES ('m1','cover.jpg','cover.jpg','image/jpeg',?,1)"
        )
        .bind(now),
      db
        .prepare('INSERT INTO product_media (product_id,media_id,position) VALUES (?,?,0)')
        .bind('p1', 'm1'),
      db
        .prepare(
          "INSERT INTO media_variants (media_id,width,r2_key,content_type,bytes,sha256,created_at,ready) VALUES ('m1',640,'cover.w640.jpg','image/jpeg',200,'b',?,1),('m1',320,'cover.w320.jpg','image/jpeg',100,'a',?,1)"
        )
        .bind(now, now),
    ]);
    const priced = await priceCartLines(db, [{ sku: 'TEE-1', qty: 1 }]);
    expect(priced[0]?.cover?.key).toBe('cover.jpg');
    expect(priced[0]?.cover ? mediaUrl(priced[0].cover, 320) : null).toBe('/media/cover.jpg?w=320');
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
