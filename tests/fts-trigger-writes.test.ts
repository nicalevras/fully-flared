import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => {
  await dispose();
});

async function ftsData(fts: string): Promise<unknown[]> {
  const { results } = await db.prepare(`SELECT id, block FROM ${fts}_data ORDER BY id`).all();
  return results;
}

async function matches(fts: string, term: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${fts} WHERE ${fts} MATCH ?`)
    .bind(`"${term}"`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('fts-trigger-writes', () => {
  beforeEach(async () => {
    await db
      .prepare(
        "INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,status,payment_status,created_at,updated_at) VALUES('o1','ORD-1001','ada@example.invalid',100,100,'paid','paid','2026-01-01','2026-01-01')"
      )
      .run();
  });

  it('an orders status update writes 1 row and leaves orders_fts unchanged', async () => {
    const before = await ftsData('orders_fts');
    const result = await db
      .prepare("UPDATE orders SET status = 'processing' WHERE id = 'o1'")
      .run();
    expect(result.meta.rows_written).toBe(1);
    expect(await ftsData('orders_fts')).toEqual(before);
    expect(await matches('orders_fts', 'ORD-1001')).toBe(1);
  });

  it('changing customer_email reindexes orders_fts', async () => {
    await db
      .prepare("UPDATE orders SET customer_email = 'grace@example.invalid' WHERE id = 'o1'")
      .run();
    expect(await matches('orders_fts', 'grace@example')).toBe(1);
    expect(await matches('orders_fts', 'ada@example')).toBe(0);
  });

  it('changing number reindexes orders_fts', async () => {
    await db.prepare("UPDATE orders SET number = 'ORD-2002' WHERE id = 'o1'").run();
    expect(await matches('orders_fts', 'ORD-2002')).toBe(1);
    expect(await matches('orders_fts', 'ORD-1001')).toBe(0);
  });
});

const tables = [
  {
    table: 'discounts',
    column: 'code',
    insert:
      "INSERT INTO discounts(id,code,type,value,created_at) VALUES('d1','SPRING10','percentage',10,'2026-01-01')",
    from: 'SPRING10',
    to: 'AUTUMN20',
  },
  {
    table: 'posts',
    column: 'title',
    insert:
      "INSERT INTO posts(id,slug,title,created_at,updated_at) VALUES('d1','hello','Hello world','2026-01-01','2026-01-01')",
    from: 'Hello world',
    to: 'Goodbye moon',
  },
  {
    table: 'pages',
    column: 'title',
    insert:
      "INSERT INTO pages(id,slug,title,created_at,updated_at) VALUES('d1','about','About us','2026-01-01','2026-01-01')",
    from: 'About us',
    to: 'Contact desk',
  },
  {
    table: 'media',
    column: 'filename',
    insert:
      "INSERT INTO media(id,r2_key,filename,content_type,created_at) VALUES('d1','k/1','sunrise.jpg','image/jpeg','2026-01-01')",
    from: 'sunrise.jpg',
    to: 'harbour.png',
  },
  {
    table: 'collections',
    column: 'title',
    insert:
      "INSERT INTO collections(id,slug,title,created_at) VALUES('d1','new','New arrivals','2026-01-01')",
    from: 'New arrivals',
    to: 'Best sellers',
  },
];

describe.each(tables)('fts-trigger-writes: $table', ({ table, column, insert, from, to }) => {
  const fts = `${table}_fts`;
  beforeEach(async () => {
    await db.prepare(insert).run();
  });

  it(`an update that leaves ${column} alone leaves ${table}_fts unchanged`, async () => {
    const before = await ftsData(fts);
    await db.prepare(`UPDATE ${table} SET created_at = '2026-02-02' WHERE id = 'd1'`).run();
    expect(await ftsData(fts)).toEqual(before);
    expect(await matches(fts, from)).toBe(1);
  });

  it(`changing ${column} reindexes ${table}_fts`, async () => {
    await db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = 'd1'`).bind(to).run();
    expect(await matches(fts, to)).toBe(1);
    expect(await matches(fts, from)).toBe(0);
  });
});
