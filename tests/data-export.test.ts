import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from './helpers/json';
import { createTestDb } from './helpers/d1';
import { exportJson, exportSecret } from './helpers/data-export';
import { present, withOverrides } from './helpers/fixtures';
import { readDataExportPage } from '../web/src/server/data-export';
import { collectDataExport } from '../web/src/lib/data-export';
import { claimVerifiedGuestOrders } from '../web/src/server/account';
import type { ExportPage, ExportRequest } from '../web/src/schemas/data-export';

let db: D1Database;
let dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
const alice = { id: 'alice', role: 'customer' };
const itemSchema = z.object({ id: z.string(), orderId: z.string(), sku: z.string() });
const exportSchema = z.object({
  formatVersion: z.literal(2),
  consistency: z.literal('paged-live'),
  complete: z.literal(true),
  profile: z.object({ id: z.string() }).nullable(),
  orders: z.array(z.object({ id: z.string(), shippingAddress: z.unknown() })),
  items: z.array(itemSchema),
  addresses: z.array(z.object({ id: z.string() })),
  returns: z.array(z.object({ id: z.string(), orderId: z.string() })),
  returnItems: z.array(z.object({ id: z.string(), returnId: z.string(), orderItemId: z.string() })),
  refunds: z.array(z.object({ id: z.string(), orderId: z.string() })),
});

async function insertOrder(id: string, userId: string | null, email = 'alice@example.com') {
  await db
    .prepare(
      `INSERT INTO orders
    (id,number,user_id,customer_email,status,payment_status,subtotal_cents,total_cents,shipping_address_json,created_at,updated_at)
    VALUES (?,?,?,?,'paid','paid',1000,1000,'{"line1":"1 Main St"}',?,?)`
    )
    .bind(id, id, userId, email, new Date().toISOString(), new Date().toISOString())
    .run();
}

beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  for (const id of ['owner', 'alice', 'bob'])
    await db
      .prepare(
        `INSERT INTO user
    (id,name,email,email_verified,role,created_at,updated_at) VALUES (?,?,?,1,?,1,1)`
      )
      .bind(id, id, `${id}@example.com`, id === 'owner' ? 'owner' : 'customer')
      .run();
  await db
    .prepare(
      `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<220)
    INSERT INTO orders (id,number,user_id,customer_email,status,payment_status,subtotal_cents,total_cents,shipping_address_json,created_at,updated_at)
    SELECT printf('order-%04d',221-x),printf('FF-%04d',x),'alice','alice@example.com','paid','paid',1000,1000,'{"line1":"1 Main St"}','2026-01-01','2026-01-01' FROM n`
    )
    .run();
  await db.prepare("UPDATE settings SET value='100' WHERE key='cart_max_lines'").run();
  await db
    .prepare(
      `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1105)
    INSERT INTO order_items (id,order_id,sku,title,qty,unit_price_cents)
    SELECT printf('item-%04d',1106-x),printf('order-%04d',220-CAST((x-1)/100 AS INTEGER)),printf('TEE-%04d',x),printf('%300s','Tee'),1,1 FROM n`
    )
    .run();
  await db.batch([
    db.prepare(`INSERT INTO addresses (id,user_id,label,name,line1,city,state,postal_code,country,is_default)
      VALUES ('address-a','alice','Home','Alice','1 Main St','Boston','MA','02101','US',1)`),
    db.prepare(`INSERT INTO returns (id,order_id,user_id,status,reason,created_at)
      VALUES ('return-a','order-0220','alice','approved','Too small','2026-01-01')`),
    db.prepare(`INSERT INTO return_items (id,return_id,order_item_id,sku,title,qty,unit_price_cents)
      VALUES ('return-item-a','return-a','item-1105','TEE','Tee',1,1)`),
    db.prepare(`INSERT INTO refunds (id,order_id,return_id,status,amount_cents,purpose,created_at)
      VALUES ('refund-a','order-0220','return-a','succeeded',1,'return','2026-01-01')`),
  ]);
  await insertOrder('bob-order', 'bob');
  await insertOrder('guest-order', null);
});
afterAll(async () => {
  await dispose();
});

describe('complete bounded data exports', () => {
  it('exports all orders and child records past the old limits in bounded requests', async () => {
    let requests = 0;
    let largestChunk = 0;
    const blob = await collectDataExport(
      { kind: 'self' },
      async (input) => {
        requests++;
        const page = await readDataExportPage(db, exportSecret, alice, input);
        largestChunk = Math.max(largestChunk, new TextEncoder().encode(page.chunk).length);
        return page;
      },
      new AbortController().signal
    );
    const json: unknown = JSON.parse(await blob.text());
    const data = exportSchema.parse(json);
    expect(data.profile?.id).toBe('alice');
    expect(data.orders).toHaveLength(220);
    expect(data.orders.at(0)?.id).toBe('order-0220');
    expect(data.orders.at(-1)?.id).toBe('order-0001');
    expect(new Set(data.orders.map((order) => order.id)).size).toBe(220);
    expect(data.orders[0]?.shippingAddress).toEqual({ line1: '1 Main St' });
    expect(data.items).toHaveLength(1105);
    expect(new Set(data.items.map((item) => item.id)).size).toBe(1105);
    expect(data.addresses.map((address) => address.id)).toEqual(['address-a']);
    expect(data.returns.map((ret) => ret.id)).toEqual(['return-a']);
    expect(data.returnItems).toEqual([
      { id: 'return-item-a', returnId: 'return-a', orderItemId: 'item-1105' },
    ]);
    expect(data.refunds.map((refund) => refund.id)).toEqual(['refund-a']);
    expect(requests).toBeGreaterThan(10);
    expect(largestChunk).toBeLessThan(256 * 1024);
  });

  it('guest exports exclude account orders with the same email', async () => {
    const data = await exportJson(
      db,
      owner,
      { kind: 'guest', email: 'alice@example.com' },
      exportSchema
    );
    expect(data.orders.map((order) => order.id)).toEqual(['guest-order']);
    expect(data.profile).toBeNull();
    expect(data.items).toEqual([]);
  });

  it('captures row bounds rather than using random identifiers as a cutoff', async () => {
    const first = await readDataExportPage(db, exportSecret, alice, { target: { kind: 'self' } });
    await insertOrder('000-inserted-after-start', 'alice');
    const parts = [first.chunk];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await readDataExportPage(db, exportSecret, alice, { cursor });
      parts.push(page.chunk);
      cursor = page.nextCursor;
    }
    const json: unknown = JSON.parse(parts.join(''));
    const data = exportSchema.parse(json);
    expect(data.orders).toHaveLength(220);
    expect(data.orders.some((order) => order.id === '000-inserted-after-start')).toBe(false);
  });

  it('follows verified guest claims through order ownership', async () => {
    await insertOrder('claimed-order', null, 'bob@example.com');
    expect(
      await claimVerifiedGuestOrders(db, {
        id: 'bob',
        email: 'bob@example.com',
        emailVerified: true,
      })
    ).toBe(1);
    const data = await exportJson(
      db,
      { id: 'bob', role: 'customer' },
      { kind: 'self' },
      exportSchema
    );
    expect(data.orders.map((order) => order.id)).toEqual(['bob-order', 'claimed-order']);
  });

  it('rechecks guest ownership before each continuation', async () => {
    await insertOrder('guest-claimed-during-export', null, 'claim@example.com');
    const first = await readDataExportPage(db, exportSecret, owner, {
      target: { kind: 'guest', email: 'claim@example.com' },
    });
    await db
      .prepare("UPDATE orders SET user_id='bob' WHERE id='guest-claimed-during-export'")
      .run();
    const parts = [first.chunk];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await readDataExportPage(db, exportSecret, owner, { cursor });
      parts.push(page.chunk);
      cursor = page.nextCursor;
    }
    const json: unknown = JSON.parse(parts.join(''));
    expect(exportSchema.parse(json).orders).toEqual([]);
  });

  it('rejects cross-account requests, revoked permissions and forged or transferred cursors', async () => {
    await expect(
      readDataExportPage(db, exportSecret, alice, { target: { kind: 'account', userId: 'bob' } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const page = await readDataExportPage(db, exportSecret, owner, {
      target: { kind: 'account', userId: 'alice' },
    });
    const cursor = present(page.nextCursor, 'export continuation');
    await expect(
      readDataExportPage(db, exportSecret, { id: 'owner', role: 'support' }, { cursor })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      readDataExportPage(db, exportSecret, { id: 'bob', role: 'owner' }, { cursor })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      readDataExportPage(db, exportSecret, owner, { cursor: cursor + '0' })
    ).rejects.toThrow('Invalid export cursor');
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60 * 1000 + 1);
    try {
      await expect(readDataExportPage(db, exportSecret, owner, { cursor })).rejects.toMatchObject({
        status: 410,
      });
    } finally {
      now.mockRestore();
    }
  });

  it('does not issue an admin continuation when the requested audit cannot be saved', async () => {
    await db
      .prepare(
        `CREATE TRIGGER export_audit_fault BEFORE INSERT ON audit_log
      WHEN NEW.action='customer.export' BEGIN SELECT RAISE(ABORT,'export audit unavailable'); END`
      )
      .run();
    try {
      await expect(
        readDataExportPage(db, exportSecret, owner, {
          target: { kind: 'account', userId: 'alice' },
        })
      ).rejects.toThrow('export audit unavailable');
    } finally {
      await db.prepare('DROP TRIGGER export_audit_fault').run();
    }
  });

  it('stops an account export after deletion', async () => {
    await db
      .prepare(
        `INSERT INTO user (id,name,email,email_verified,role,created_at,updated_at)
      VALUES ('erased','Erased','erased@example.com',1,'customer',1,1)`
      )
      .run();
    const page = await readDataExportPage(
      db,
      exportSecret,
      { id: 'erased', role: 'customer' },
      { target: { kind: 'self' } }
    );
    await db.prepare("DELETE FROM user WHERE id='erased'").run();
    await expect(
      readDataExportPage(
        db,
        exportSecret,
        { id: 'erased', role: 'customer' },
        { cursor: present(page.nextCursor, 'export continuation') }
      )
    ).rejects.toMatchObject({ status: 404 });
  });

  it('bounds returned bytes when records grow during a page read', async () => {
    await db
      .prepare(
        `INSERT INTO user (id,name,email,email_verified,role,created_at,updated_at)
      VALUES ('growth','Growth','growth@example.com',1,'customer',1,1)`
      )
      .run();
    for (let index = 0; index < 3; index++) await insertOrder(`growth-${index}`, 'growth');
    const actor = { id: 'growth', role: 'customer' };
    const page = await readDataExportPage(db, exportSecret, actor, { target: { kind: 'self' } });
    let changed = false;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          const member: unknown = Reflect.get(target, property);
          if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
          if (property === 'all')
            return async () => {
              const result = await target.all();
              if (!changed) {
                changed = true;
                await db
                  .prepare(
                    `UPDATE orders SET shipping_address_json=json_object('line1',printf('%100000s','grown'))
              WHERE user_id='growth'`
                  )
                  .run();
              }
              return result;
            };
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
    const racing = withOverrides(db, { prepare: (sql) => wrap(db.prepare(sql)) });
    const result = await readDataExportPage(racing, exportSecret, actor, {
      cursor: present(page.nextCursor, 'export continuation'),
    });
    expect(changed).toBe(true);
    expect(new TextEncoder().encode(result.chunk).length).toBeLessThan(256 * 1024);
  });

  it('reads a bounded window of child rows from a large history', async () => {
    await db
      .prepare(
        `INSERT INTO user (id,name,email,email_verified,role,created_at,updated_at)
      VALUES ('large','Large','large@example.com',1,'customer',1,1)`
      )
      .run();
    await db
      .prepare(
        `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300)
      INSERT INTO orders (id,number,user_id,customer_email,status,payment_status,subtotal_cents,total_cents,created_at,updated_at)
      SELECT 'large-'||x,'large-'||x,'large','large@example.com','paid','paid',1000,1000,'2026-01-01','2026-01-01' FROM n`
      )
      .run();
    await db
      .prepare(
        `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<30000)
      INSERT INTO order_items (id,order_id,sku,title,qty,unit_price_cents)
      SELECT 'large-item-'||x,'large-'||(1+CAST((x-1)/100 AS INTEGER)),'large-sku-'||x,printf('%300s','Item'),1,1 FROM n`
      )
      .run();
    const actor = { id: 'large', role: 'customer' };
    let page = await readDataExportPage(db, exportSecret, actor, { target: { kind: 'self' } });
    do {
      page = await readDataExportPage(db, exportSecret, actor, {
        cursor: present(page.nextCursor, 'orders continuation'),
      });
    } while (!page.chunk.includes('"items":['));
    const reads: number[] = [];
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          const member: unknown = Reflect.get(target, property);
          if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
          if (property === 'all')
            return async () => {
              const result = await target.all();
              reads.push(result.meta.rows_read);
              return result;
            };
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
    const counted = withOverrides(db, { prepare: (sql) => wrap(db.prepare(sql)) });
    const items = await readDataExportPage(counted, exportSecret, actor, {
      cursor: present(page.nextCursor, 'items continuation'),
    });
    expect(items.nextCursor).not.toBeNull();
    expect(reads).toHaveLength(1);
    expect(reads[0]).toBeGreaterThan(0);
    expect(reads[0]).toBeLessThan(10_000);
    expect(new TextEncoder().encode(items.chunk).length).toBeLessThan(256 * 1024);
  });
});

it('does not produce a file when a later export page fails', async () => {
  const reader = vi
    .fn<(request: ExportRequest) => Promise<ExportPage>>()
    .mockResolvedValueOnce({ chunk: '{"orders":[', nextCursor: 'next' })
    .mockRejectedValueOnce(new Error('offline'));
  await expect(
    collectDataExport({ kind: 'self' }, reader, new AbortController().signal)
  ).rejects.toThrow('offline');
  expect(reader).toHaveBeenCalledTimes(2);
});

it('does not produce a file or request another page after cancellation', async () => {
  let complete: ((page: ExportPage) => void) | undefined;
  const reader = vi.fn<(request: ExportRequest) => Promise<ExportPage>>(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  const controller = new AbortController();
  const collecting = collectDataExport({ kind: 'self' }, reader, controller.signal);
  controller.abort();
  present(complete, 'pending export page')({ chunk: '{"orders":[', nextCursor: 'next' });
  await expect(collecting).rejects.toMatchObject({ name: 'AbortError' });
  expect(reader).toHaveBeenCalledTimes(1);
});
