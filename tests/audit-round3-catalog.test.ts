import { expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { readProductDocument } from '../web/src/server/catalog-read';
import { published } from './helpers/fixtures';

it('assembles 5000 complete product documents with sorted variants and media', async () => {
  const { db, dispose } = await createTestDb();
  try {
    await db.batch([
      db.prepare(
        "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<5000) INSERT INTO products(id,slug,title,status,created_at,updated_at) SELECT 'p'||n,'product-'||n,'Product '||n,'active','2026','2026' FROM c"
      ),
      db.prepare(
        "INSERT INTO variants(id,product_id,sku,title,price_cents,created_at) SELECT id||'-high',id,id||'-HIGH','High',200,'2026' FROM products UNION ALL SELECT id||'-low',id,id||'-LOW','Low',100,'2026' FROM products"
      ),
      db.prepare(
        "INSERT INTO media(id,r2_key,filename,content_type,created_at) VALUES('first','first.jpg','first.jpg','image/jpeg','2026'),('second','second.jpg','second.jpg','image/jpeg','2026')"
      ),
      db.prepare(
        "INSERT INTO product_media(product_id,media_id,position) SELECT id,'second',2 FROM products UNION ALL SELECT id,'first',1 FROM products"
      ),
    ]);
    const values = new Map<string, string>();
    const env = {
      CATALOG_KV: {
        get: async (key: string) => values.get(key) ?? null,
        put: async (key: string, value: string) => {
          values.set(key, value);
        },
      },
    };
    const start = performance.now();
    const built = await buildCatalogReadModels(db, env.CATALOG_KV);
    expect(built.products).toBe(5000);
    expect(built.docsChanged).toBe(5000);
    for (const slug of ['product-1', 'product-2500', 'product-5000']) {
      const detail = published(await readProductDocument(db, env.CATALOG_KV, slug));
      expect(detail.variants.map((v) => v.priceCents)).toEqual([100, 200]);
      expect(detail.images.map((image) => image.key)).toEqual(['first.jpg', 'second.jpg']);
    }
    console.warn(
      `5000-product assembly: ${Math.round(performance.now() - start)}ms; 10000 variants and 10000 media links, complete output. Local fixture only.`
    );
  } finally {
    await dispose();
  }
});
import { buildCatalogReadModels } from './helpers/catalog-driver';
