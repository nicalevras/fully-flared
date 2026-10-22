import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { loadAccountOrders } from '../web/src/server/account-orders';

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await db.batch([
    db.prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('u1','One','one@example.invalid',1,'2026','2026'),('u2','Two','two@example.invalid',1,'2026','2026')"
    ),
  ]);
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < 51; i++) {
    const id = `o${String(i).padStart(3, '0')}`;
    stmts.push(
      db
        .prepare(
          "INSERT INTO orders(id,number,customer_email,user_id,subtotal_cents,total_cents,status,payment_status,created_at,updated_at) VALUES(?,?,?, 'u1',100,100,'paid','paid','2026-01-01','2026-01-01')"
        )
        .bind(id, id, 'one@example.invalid')
    );
  }
  stmts.push(
    db.prepare(
      "INSERT INTO orders(id,number,customer_email,user_id,subtotal_cents,total_cents,status,payment_status,created_at,updated_at) VALUES('x1','x1','two@example.invalid','u2',100,100,'paid','paid','2026-01-01','2026-01-01')"
    ),
    db.prepare(
      "INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES('oi0','o000','TEE-1','Tee',3,100)"
    ),
    db.prepare(
      "INSERT INTO returns(id,order_id,user_id,status,created_at) VALUES('r1','o000','u1','refunded','2026-02-01'),('r2','o000','u1','requested','2026-03-01')"
    ),
    db.prepare(
      "INSERT INTO return_items(id,return_id,order_item_id,sku,title,qty,unit_price_cents) VALUES('ri1','r1','oi0','TEE-1','Tee',1,100),('ri2','r2','oi0','TEE-1','Tee',1,100)"
    )
  );
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
});
afterEach(async () => {
  await dispose();
});

it('pages through 51 orders with stable timestamp-plus-id ordering', async () => {
  const p1 = await loadAccountOrders(db, 'u1', 1);
  expect(p1.totalOrders).toBe(51);
  expect(p1.pageCount).toBe(3);
  expect(p1.orders).toHaveLength(20);
  expect(p1.orders[0]?.id).toBe('o050');
  const p2 = await loadAccountOrders(db, 'u1', 2);
  expect(p2.orders).toHaveLength(20);
  const p3 = await loadAccountOrders(db, 'u1', 3);
  expect(p3.orders).toHaveLength(11);
  expect(p3.orders.at(-1)?.id).toBe('o000');
  const all = [...p1.orders, ...p2.orders, ...p3.orders].map((o) => o.id);
  expect(new Set(all).size).toBe(51);
});

it('clamps invalid and out-of-range pages at the server boundary', async () => {
  expect((await loadAccountOrders(db, 'u1', 0)).page).toBe(1);
  expect((await loadAccountOrders(db, 'u1', -3)).page).toBe(1);
  const last = await loadAccountOrders(db, 'u1', 99);
  expect(last.page).toBe(3);
  expect(last.orders).toHaveLength(11);
  const empty = await loadAccountOrders(db, 'nobody', 5);
  expect(empty).toMatchObject({ orders: [], totalOrders: 0, page: 1, pageCount: 1 });
});

it('a full page of multi-item orders stays within D1 variable limits', async () => {
  // 20 displayed orders x 6 items = 120 items: binding every item id would
  // exceed D1's SQL variable limit; binding the 20 order ids must not.
  const stmts: D1PreparedStatement[] = [];
  for (let o = 0; o < 20; o++) {
    const oid = `y${String(o).padStart(3, '0')}`;
    stmts.push(
      db
        .prepare(
          "INSERT INTO orders(id,number,customer_email,user_id,subtotal_cents,total_cents,status,payment_status,created_at,updated_at) VALUES(?,?,?,'u2',100,100,'paid','paid','2026-01-01','2026-01-01')"
        )
        .bind(oid, oid, 'two@example.invalid')
    );
    for (let i = 0; i < 6; i++)
      stmts.push(
        db
          .prepare(
            "INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES(?,?,?,'Tee',2,100)"
          )
          .bind(`${oid}-i${i}`, oid, `SKU-${o}-${i}`)
      );
  }
  stmts.push(
    db.prepare(
      "INSERT INTO returns(id,order_id,user_id,status,created_at) VALUES('ry','y000','u2','refunded','2026-02-01')"
    ),
    db.prepare(
      "INSERT INTO return_items(id,return_id,order_item_id,sku,title,qty,unit_price_cents) VALUES('riy','ry','y000-i0','SKU-0-0','Tee',1,100)"
    )
  );
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
  const page = await loadAccountOrders(db, 'u2', 1);
  expect(page.orders).toHaveLength(20);
  const first = page.orders.find((o) => o.id === 'y000');
  expect(first?.items).toHaveLength(6);
  expect(first?.items[0]?.returned_qty).toBe(1);
});

it('isolates customers and keeps return data complete for displayed orders', async () => {
  const mine = await loadAccountOrders(db, 'u1', 3);
  expect(mine.orders.some((o) => o.id === 'x1')).toBe(false);
  const other = await loadAccountOrders(db, 'u2', 1);
  expect(other.orders.some((o) => o.id === 'x1')).toBe(true);
  expect(other.orders.some((o) => o.id.startsWith('o0'))).toBe(false);
  // The oldest order is on page 3; both of its returns and its full
  // returned quantity are present there.
  expect(mine.returns.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  const oldest = mine.orders.find((o) => o.id === 'o000');
  expect(oldest?.items[0]?.returned_qty).toBe(2);
});
