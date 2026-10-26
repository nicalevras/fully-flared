import { expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { adminProductDiscovery } from '../web/src/server/admin-product-discovery';
import { listProducts } from '../web/src/server/catalog';

const sizes = process.env.DISCOVERY_100K === '1' ? [10, 5000, 100000] : [10, 5000];

function recordingDb(db: D1Database) {
  const reads: Array<{ sql: string; rowsRead: number }> = [];
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === 'all')
          return async () => {
            const result = await target.all();
            reads.push({ sql, rowsRead: result.meta.rows_read });
            return result;
          };
        if (property === 'raw')
          return async () => {
            const result = await target.all();
            reads.push({ sql, rowsRead: result.meta.rows_read });
            return target.raw();
          };
        const member: unknown = Reflect.get(target, property);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
  }
  return {
    db: new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
        const member: unknown = Reflect.get(target, property);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    }),
    reads,
  };
}

for (const size of sizes)
  it(`records real D1 discovery resources with ${size} products`, { timeout: 600000 }, async () => {
    const { db, dispose } = await createTestDb({ transportRetry: true });
    try {
      for (let start = 1; start <= size; start += 1000) {
        const rows = Array.from({ length: Math.min(1000, size - start + 1) }, (_, offset) => {
          const n = start + offset;
          const id = `p${String(n).padStart(6, '0')}`;
          return {
            id,
            title: n === 1 ? 'Narrow Azure Hat' : 'Common Shirt',
            sku: `SKU-${String(n).padStart(6, '0')}`,
            created: String(n).padStart(6, '0'),
          };
        });
        const json = JSON.stringify(rows);
        await db.batch([
          db
            .prepare(
              "INSERT INTO products(id,slug,title,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.id'),json_extract(value,'$.title'),json_extract(value,'$.created'),json_extract(value,'$.created') FROM json_each(?)"
            )
            .bind(json),
          db
            .prepare(
              "INSERT INTO variants(id,product_id,sku,title,price_cents,created_at) SELECT 'v'||json_extract(value,'$.id'),json_extract(value,'$.id'),json_extract(value,'$.sku'),'Default',100,'2026' FROM json_each(?)"
            )
            .bind(json),
        ]);
      }
      const scenarios = [
        ['baseline_count_shape', 'SELECT COUNT(*) AS n FROM products', []],
        [
          'baseline_first_shape',
          "SELECT p.id FROM products p LEFT JOIN variants v ON v.product_id=p.id AND v.status='active' LEFT JOIN stock s ON s.sku=v.sku GROUP BY p.id ORDER BY p.created_at DESC,p.id DESC LIMIT 100 OFFSET 0",
          [],
        ],
        [
          'baseline_deep_shape',
          "SELECT p.id FROM products p LEFT JOIN variants v ON v.product_id=p.id AND v.status='active' LEFT JOIN stock s ON s.sku=v.sku GROUP BY p.id ORDER BY p.created_at DESC,p.id DESC LIMIT 100 OFFSET 4000",
          [],
        ],
        [
          'browse_first',
          'SELECT id,created_at FROM products ORDER BY created_at DESC,id DESC LIMIT 51',
          [],
        ],
        [
          'browse_deep',
          'SELECT id,created_at FROM products WHERE (created_at,id) < (?,?) ORDER BY created_at DESC,id DESC LIMIT 51',
          ['001000', 'p001000'],
        ],
        [
          'sku_exact_hit',
          'SELECT p.id,p.created_at FROM variants v JOIN products p ON p.id=v.product_id WHERE v.sku=? LIMIT 1001',
          ['SKU-000001'],
        ],
        [
          'sku_exact_miss',
          'SELECT p.id,p.created_at FROM variants v JOIN products p ON p.id=v.product_id WHERE v.sku=? LIMIT 1001',
          ['ABSENT'],
        ],
        [
          'sku_prefix_narrow',
          'SELECT p.id,p.created_at FROM variants v JOIN products p ON p.id=v.product_id WHERE v.sku>=? AND v.sku<? LIMIT 1001',
          ['SKU-000001', 'SKU-000002'],
        ],
        [
          'sku_prefix_broad',
          'SELECT p.id,p.created_at FROM variants v JOIN products p ON p.id=v.product_id WHERE v.sku>=? AND v.sku<? LIMIT 1001',
          ['SKU-', 'SKU.'],
        ],
        [
          'title_narrow',
          'SELECT p.id,p.created_at FROM products_fts f JOIN products p ON p.rowid=f.rowid WHERE products_fts MATCH ? LIMIT 1001',
          ['title : ("Narrow" AND "Azure")'],
        ],
        [
          'title_common',
          'SELECT p.id,p.created_at FROM products_fts f JOIN products p ON p.rowid=f.rowid WHERE products_fts MATCH ? LIMIT 1001',
          ['title : ("Common")'],
        ],
        [
          'title_multi_absent',
          'SELECT p.id,p.created_at FROM products_fts f JOIN products p ON p.rowid=f.rowid WHERE products_fts MATCH ? LIMIT 1001',
          ['title : ("Common" AND "Absent")'],
        ],
      ] as const;
      for (const [name, sql, bindings] of scenarios) {
        const plan = await db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .bind(...bindings)
          .all<{ detail: string }>();
        const result = await db
          .prepare(sql)
          .bind(...bindings)
          .all();
        console.warn(
          JSON.stringify({
            size,
            name,
            rows: result.results.length,
            rowsRead: result.meta.rows_read,
            plan: plan.results.map((row) => row.detail),
          })
        );
      }
      let deepCursor: string | null = null;
      if (size > 1000) {
        for (let page = 0; page < 20; page++) {
          const result = await adminProductDiscovery(db, { cursor: deepCursor });
          deepCursor = result.nextCursor;
        }
      }
      for (const [name, run] of [
        [
          'old_cards_first',
          async (recorded: D1Database) => {
            await listProducts(recorded, { limit: 100, offset: 0 });
            await recorded.prepare('SELECT COUNT(*) AS n FROM products').all();
          },
        ],
        [
          'old_cards_deep',
          async (recorded: D1Database) => {
            await listProducts(recorded, { limit: 100, offset: 4000 });
            await recorded.prepare('SELECT COUNT(*) AS n FROM products').all();
          },
        ],
        ['new_browse_first', (recorded: D1Database) => adminProductDiscovery(recorded, {})],
        [
          'new_browse_deep',
          (recorded: D1Database) => adminProductDiscovery(recorded, { cursor: deepCursor }),
        ],
        [
          'new_title_common',
          (recorded: D1Database) => adminProductDiscovery(recorded, { q: 'Common', mode: 'title' }),
        ],
      ] as const) {
        const { db: recorded, reads } = recordingDb(db);
        await run(recorded);
        const rowsRead = reads.reduce((sum, read) => sum + read.rowsRead, 0);
        if (name === 'new_browse_first' || name === 'new_browse_deep') {
          expect(rowsRead).toBeLessThan(1000);
        }
        if (name === 'new_title_common') expect(rowsRead).toBeLessThan(2100);
        console.warn(
          JSON.stringify({
            size,
            name,
            statements: reads.length,
            rowsRead,
            details: reads.map((read) => ({ rowsRead: read.rowsRead, sql: read.sql })),
          })
        );
      }
      const first = await adminProductDiscovery(db, {});
      const deep = await adminProductDiscovery(db, { cursor: first.nextCursor });
      expect(first.products).toHaveLength(Math.min(50, size));
      expect(deep.products).toHaveLength(size === 10 ? 10 : 50);
      expect((await adminProductDiscovery(db, { q: 'Common', mode: 'title' })).state).toBe(
        size > 1000 ? 'refine' : 'ready'
      );
    } finally {
      await dispose();
    }
  });

it(
  'records a heavy 50-product page with variant and media fanout',
  { timeout: 120000 },
  async () => {
    const { db, dispose } = await createTestDb({ transportRetry: true });
    try {
      await db
        .prepare(
          "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<50) INSERT INTO products(id,slug,title,created_at,updated_at) SELECT printf('h%03d',n),printf('h%03d',n),'Heavy','2026','2026' FROM c"
        )
        .run();
      await db
        .prepare(
          "WITH RECURSIVE p(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM p WHERE n<50), v(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM v WHERE n<20) INSERT INTO variants(id,product_id,sku,title,price_cents,created_at) SELECT printf('hv%03d-%02d',p.n,v.n),printf('h%03d',p.n),printf('H%03d-%02d',p.n,v.n),'Variant',100+v.n,'2026' FROM p,v"
        )
        .run();
      await db
        .prepare(
          "WITH RECURSIVE p(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM p WHERE n<50), m(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM m WHERE n<5) INSERT INTO media(id,r2_key,filename,content_type,created_at,ready) SELECT printf('hm%03d-%d',p.n,m.n),printf('hk%03d-%d',p.n,m.n),'x.jpg','image/jpeg','2026',1 FROM p,m"
        )
        .run();
      await db
        .prepare(
          "INSERT INTO product_media(product_id,media_id,position) SELECT printf('h%03d',CAST(SUBSTR(id,3,3) AS INTEGER)),id,CAST(SUBSTR(id,7) AS INTEGER) FROM media"
        )
        .run();
      await db
        .prepare(
          "INSERT INTO stock(sku,on_hand,reserved,updated_at) SELECT sku,10,1,'2026' FROM variants"
        )
        .run();
      const { db: recorded, reads } = recordingDb(db);
      const result = await adminProductDiscovery(recorded, {});
      expect(result.products).toHaveLength(50);
      expect(result.products[0]).toMatchObject({
        id: 'h050',
        price_cents: 101,
        available: 180,
        image_key: 'hk050-1',
      });
      const totalRowsRead = reads.reduce((sum, read) => sum + read.rowsRead, 0);
      console.warn(
        JSON.stringify({
          name: 'heavy_page_50x20x5',
          statements: reads.length,
          rowsRead: totalRowsRead,
          details: reads.map((read) => ({ rowsRead: read.rowsRead, sql: read.sql.slice(0, 80) })),
        })
      );
      expect(totalRowsRead).toBeLessThan(20000);
    } finally {
      await dispose();
    }
  }
);

it.runIf(process.env.DISCOVERY_100K === '1')(
  'keeps deep cursor pages bounded for every sort and status filter at 100000 products',
  { timeout: 600000 },
  async () => {
    const { db, dispose } = await createTestDb({ transportRetry: true });
    try {
      const size = 100000;
      for (let start = 1; start <= size; start += 1000) {
        const rows = Array.from({ length: Math.min(1000, size - start + 1) }, (_, offset) => {
          const n = start + offset;
          const id = `p${String(n).padStart(6, '0')}`;
          return {
            id,
            title: `Product ${String(n).padStart(6, '0')}`,
            created: String(n).padStart(6, '0'),
            status: n % 100 < 90 ? 'active' : n % 100 < 99 ? 'draft' : 'archived',
          };
        });
        const json = JSON.stringify(rows);
        await db.batch([
          db
            .prepare(
              "INSERT INTO products(id,slug,title,status,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.id'),json_extract(value,'$.title'),json_extract(value,'$.status'),json_extract(value,'$.created'),json_extract(value,'$.created') FROM json_each(?)"
            )
            .bind(json),
          db
            .prepare(
              "INSERT INTO variants(id,product_id,sku,title,price_cents,created_at) SELECT 'v'||json_extract(value,'$.id'),json_extract(value,'$.id'),'SKU-'||json_extract(value,'$.id'),'Default',100,'2026' FROM json_each(?)"
            )
            .bind(json),
        ]);
      }
      const sorts = ['newest', 'oldest', 'title', 'updated'] as const;
      const statuses = ['all', 'active', 'draft', 'archived'] as const;
      for (const sort of sorts) {
        for (const status of statuses) {
          const pages = status === 'archived' ? 5 : status === 'draft' ? 10 : 20;
          let cursor: string | null | undefined;
          for (let page = 0; page < pages; page++) {
            const result = await adminProductDiscovery(db, { sort, status, cursor });
            expect(result.products).toHaveLength(50);
            cursor = result.nextCursor;
          }
          const { db: recorded, reads } = recordingDb(db);
          const deep = await adminProductDiscovery(recorded, { sort, status, cursor });
          const deepRows = reads.reduce((sum, read) => sum + read.rowsRead, 0);
          console.warn(
            JSON.stringify({
              name: 'deep_page',
              sort,
              status,
              pages,
              statements: reads.length,
              rowsRead: deepRows,
              details: reads.map((read) => ({
                rowsRead: read.rowsRead,
                sql: read.sql.slice(0, 90),
              })),
            })
          );
          expect(deep.products).toHaveLength(50);
          expect(deepRows).toBeLessThan(1500);
          const { db: recordedBack, reads: backReads } = recordingDb(db);
          const back = await adminProductDiscovery(recordedBack, {
            sort,
            status,
            cursor: deep.previousCursor,
          });
          const backRows = backReads.reduce((sum, read) => sum + read.rowsRead, 0);
          console.warn(
            JSON.stringify({ name: 'deep_page_back', sort, status, rowsRead: backRows })
          );
          expect(back.products).toHaveLength(50);
          expect(backRows).toBeLessThan(1500);
        }
      }
    } finally {
      await dispose();
    }
  }
);


it.runIf(process.env.DISCOVERY_100K === '1')(
  'keeps deep pages bounded in a draft-heavy catalog at 100000 products',
  { timeout: 600000 },
  async () => {
    const { db, dispose } = await createTestDb({ transportRetry: true });
    try {
      const size = 100000;
      for (let start = 1; start <= size; start += 1000) {
        const rows = Array.from({ length: Math.min(1000, size - start + 1) }, (_, offset) => {
          const n = start + offset;
          const id = `p${String(n).padStart(6, '0')}`;
          return {
            id,
            title: `Product ${String(n).padStart(6, '0')}`,
            created: String(n).padStart(6, '0'),
            status: n % 100 < 80 ? 'draft' : n % 100 < 95 ? 'active' : 'archived',
          };
        });
        const json = JSON.stringify(rows);
        await db.batch([
          db
            .prepare(
              "INSERT INTO products(id,slug,title,status,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.id'),json_extract(value,'$.title'),json_extract(value,'$.status'),json_extract(value,'$.created'),json_extract(value,'$.created') FROM json_each(?)"
            )
            .bind(json),
          db
            .prepare(
              "INSERT INTO variants(id,product_id,sku,title,price_cents,created_at) SELECT 'v'||json_extract(value,'$.id'),json_extract(value,'$.id'),'SKU-'||json_extract(value,'$.id'),'Default',100,'2026' FROM json_each(?)"
            )
            .bind(json),
        ]);
      }
      for (const sort of ['newest', 'title', 'updated'] as const) {
        for (const status of ['draft', 'active'] as const) {
          let cursor: string | null | undefined;
          for (let page = 0; page < 10; page++) {
            const result = await adminProductDiscovery(db, { sort, status, cursor });
            expect(result.products).toHaveLength(50);
            cursor = result.nextCursor;
          }
          const { db: recorded, reads } = recordingDb(db);
          const deep = await adminProductDiscovery(recorded, { sort, status, cursor });
          const rowsRead = reads.reduce((sum, read) => sum + read.rowsRead, 0);
          console.warn(JSON.stringify({ name: 'draft_heavy_deep', sort, status, rowsRead }));
          expect(deep.products).toHaveLength(50);
          expect(rowsRead).toBeLessThan(1500);
        }
      }
    } finally {
      await dispose();
    }
  }
);
