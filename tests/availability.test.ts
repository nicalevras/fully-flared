import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { getAvailability } from '../web/src/server/availability';
import { availabilityInputSchema, type AvailabilityInput } from '../web/src/schemas/availability';
import { setCartLine } from '../web/src/server/cart';
import { createPendingOrder } from '../web/src/server/checkout';
import { InsufficientStock } from '../web/src/server/inventory';
let db: D1Database, dispose: () => Promise<void>;
beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db);
});
afterAll(async () => {
  await dispose();
});
const read = (
  data: AvailabilityInput = { mode: 'products', ids: ['p1'] },
  database = db,
  storage?: CacheStorage
) =>
  getAvailability(availabilityInputSchema.parse(data), database, 'https://store.example', storage);
it('validates the server-function input and reports sold out and zero-stock backorders', async () => {
  for (const data of [
    { mode: 'invalid', ids: ['p1'] },
    { mode: 'product', ids: ['p1', 'p2'] },
    { mode: 'products', ids: Array.from({ length: 51 }, (_, i) => 'p' + i) },
    { mode: 'products', ids: ["p1' OR 1=1"] },
  ])
    expect(availabilityInputSchema.safeParse(data).success).toBe(false);
  expect(availabilityInputSchema.parse({ mode: 'products', ids: ['p1', 'p1'] }).ids).toEqual([
    'p1',
  ]);
  expect(await read()).toMatchObject({ products: [{ id: 'p1', status: 'in_stock' }] });
  await db.prepare("UPDATE stock SET on_hand=0 WHERE sku='TEE-1'").run();
  expect(await read()).toMatchObject({ products: [{ status: 'sold_out' }] });
  await db.prepare("UPDATE variants SET continue_selling=1 WHERE sku='TEE-1'").run();
  expect(await read({ mode: 'product', ids: ['p1'] })).toMatchObject({
    products: [
      { status: 'backorder', variants: [{ sku: 'TEE-1', available: 0, continueSelling: true }] },
    ],
  });
  await db.prepare("UPDATE variants SET continue_selling=0 WHERE sku='TEE-1'").run();
  await db.prepare("UPDATE stock SET on_hand=5 WHERE sku='TEE-1'").run();
});
it('cart accepts additions/increases above current stock without reserving; checkout still rejects them atomically', async () => {
  const cart = await setCartLine(db, null, 'TEE-1', 4);
  await db.prepare("UPDATE stock SET on_hand=1 WHERE sku='TEE-1'").run();
  await expect(setCartLine(db, cart.creds, 'TEE-1', 5)).resolves.toMatchObject({
    lines: [{ qty: 5 }],
  });
  await setCartLine(db, cart.creds, 'TEE-1', 0);
  await expect(setCartLine(db, cart.creds, 'TEE-1', 2)).resolves.toMatchObject({
    lines: [{ qty: 2 }],
  });
  await expect(
    createPendingOrder(db, {
      email: 'fixture@example.test',
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      lines: [{ sku: 'TEE-1', qty: 2 }],
    })
  ).rejects.toBeInstanceOf(InsufficientStock);
  expect((await db.prepare("SELECT reserved FROM stock WHERE sku='TEE-1'").first())?.reserved).toBe(
    0
  );
  await db.prepare("UPDATE stock SET on_hand=0 WHERE sku='TEE-1'").run();
  await expect(setCartLine(db, cart.creds, 'TEE-1', 3)).resolves.toMatchObject({
    lines: [{ qty: 3 }],
  });
  await setCartLine(db, cart.creds, 'TEE-1', 1);
  await setCartLine(db, cart.creds, 'TEE-1', 0);
  await db.prepare("UPDATE products SET status='archived' WHERE id='p1'").run();
  await expect(setCartLine(db, cart.creds, 'TEE-1', 1)).rejects.toThrow('no longer available');
  await db.prepare("UPDATE products SET status='active' WHERE id='p1'").run();
});
it('reuses overlapping per-product cache entries, coalesces concurrent reads, and expires after five seconds', async () => {
  let time = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
  const entries = new Map<string, { body: string; until: number }>();
  const cache = {
    match: async (r: Request) => {
      const v = entries.get(r.url);
      return v && v.until > time ? new Response(v.body) : undefined;
    },
    put: async (r: Request, v: Response) => {
      expect(v.headers.get('cache-control')).toBe('public, max-age=5');
      entries.set(r.url, { body: await v.text(), until: time + 5000 });
    },
  };
  const storage = { open: async () => cache } as never;
  const prepare = vi.fn(db.prepare.bind(db));
  const counted = { prepare } as unknown as D1Database;
  try {
    await Promise.all([read(undefined, counted, storage), read(undefined, counted, storage)]);
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockClear();
    await read({ mode: 'products', ids: ['p1', 'missing'] }, counted, storage);
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockClear();
    await read(undefined, counted, storage);
    expect(prepare).not.toHaveBeenCalled();
    time += 5001;
    await read(undefined, counted, storage);
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockClear();
    await read({ mode: 'product', ids: ['p1'] }, counted, storage);
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});
it('cache failures and ineffective storage fall back; failed D1 reads use the function-boundary dependency error', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(
      (
        await read(undefined, db, {
          open: async () => {
            throw new Error('private');
          },
        } as never)
      ).products
    ).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join('')).not.toContain('private');
    const put = vi.fn();
    const broken = {
      prepare() {
        throw new Error('Availability database unavailable');
      },
    } as never;
    await expect(
      read(undefined, broken, {
        open: async () => ({ match: async () => undefined, put }),
      } as never)
    ).rejects.toMatchObject({
      status: 503,
      code: 'DEPENDENCY',
      message: 'Availability temporarily unavailable',
    });
    expect(put).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join('')).toContain('Availability database unavailable');
    const prepare = vi.fn(db.prepare.bind(db));
    const counted = { prepare } as unknown as D1Database;
    const noop = {
      open: async () => ({ match: async () => undefined, put: async () => {} }),
    } as never;
    await read(undefined, counted, noop);
    await read(undefined, counted, noop);
    expect(prepare).toHaveBeenCalledTimes(2);
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});
it('handles fifty distinct IDs, missing stock, multiple variants, archived and absent products', async () => {
  expect(
    (await read({ mode: 'products', ids: Array.from({ length: 50 }, (_, i) => 'p' + i) })).products
  ).toHaveLength(50);
  await db
    .prepare(
      "INSERT INTO variants(id,product_id,sku,title,price_cents,status,continue_selling,created_at) VALUES('v2','p1','SECOND','Second',100,'active',1,'now'),('v3','p1','INACTIVE','Third',100,'draft',1,'now')"
    )
    .run();
  await db
    .prepare("INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES('SECOND',0,0,'now')")
    .run();
  const detail = await read({ mode: 'product', ids: ['p1'] });
  expect(detail.products[0].status).toBe('backorder');
  expect(detail.products[0].variants).toHaveLength(2);
  await db.prepare("DELETE FROM stock WHERE sku IN('SECOND','TEE-1')").run();
  expect(await read({ mode: 'product', ids: ['p1'] })).toMatchObject({
    products: [{ status: 'unavailable', variants: [{ available: null }, { available: null }] }],
  });
  await db.prepare("UPDATE products SET status='archived' WHERE id='p1'").run();
  expect(await read({ mode: 'products', ids: ['p1', 'absent'] })).toEqual({
    products: [
      { id: 'p1', status: 'unavailable' },
      { id: 'absent', status: 'unavailable' },
    ],
  });
});
