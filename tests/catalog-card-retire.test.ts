import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { buildCatalogReadModels } from './helpers/catalog-driver';

class Kv {
  map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => dispose());

it('retires all 200 inactive cards in one run', async () => {
  await db
    .prepare(
      "INSERT INTO products(id,slug,title,description,status,created_at,updated_at) SELECT 'p'||value,'slug-'||value,'Title '||value,'','draft','2026-01-01','2026-01-01' FROM json_each(?1)"
    )
    .bind(JSON.stringify(Array.from({ length: 200 }, (_, i) => i)))
    .run();
  await db
    .prepare(
      "INSERT INTO catalog_cards(product_id,slug,card_json,revision,doc_revision,updated_at) SELECT 'p'||value,'slug-'||value,'{}','r','r','2026-01-01' FROM json_each(?1)"
    )
    .bind(JSON.stringify(Array.from({ length: 200 }, (_, i) => i)))
    .run();
  await buildCatalogReadModels(db, new Kv());
  expect(
    (await db.prepare('SELECT COUNT(*) AS n FROM catalog_cards').first<{ n: number }>())?.n
  ).toBe(0);
});
