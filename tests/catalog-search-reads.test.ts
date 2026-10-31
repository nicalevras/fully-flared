import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { meterRowsRead } from './helpers/rows-read';
import {
  searchCatalog,
  SEARCH_PAGE_SIZE,
  suggestCatalog,
  SUGGEST_SIZE,
} from '../web/src/server/catalog-discovery';

const PRODUCTS = 20_000;
const SHIRT_EVERY = 8;

let db: D1Database, dispose: () => Promise<void>;
beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  const ids = JSON.stringify(Array.from({ length: PRODUCTS }, (_, i) => i));
  await db
    .prepare(
      `INSERT INTO products (id, slug, title, description, status, created_at, updated_at)
       SELECT 'p' || value, 'p-' || value,
              CASE WHEN value % ?2 = 0 THEN 'Cotton Shirt ' ELSE 'Wool Hat ' END || value,
              '', 'active', printf('2026-01-01T00:00:%08d', value), '2026-01-01'
       FROM json_each(?1)`
    )
    .bind(ids, SHIRT_EVERY)
    .run();
  await db
    .prepare(
      `INSERT INTO catalog_cards (product_id, slug, card_json, revision, doc_revision, updated_at)
       SELECT id, slug, json_object('id', id, 'slug', slug, 'title', title,
         'status', status, 'priceCents', NULL, 'imageKey', NULL), 'r', 'r', '2026-01-01'
       FROM products WHERE title LIKE 'Cotton Shirt %'`
    )
    .run();
}, 60_000);
afterAll(async () => dispose());

const ftsReads = (sql: string) => sql.includes('products_fts');

it('common term reads ≤ 3×LIMIT+ε at 20k products', async () => {
  const meter = meterRowsRead(db);
  const page = await searchCatalog(meter.db, {}, 'shirt');
  expect(page.cards).toHaveLength(SEARCH_PAGE_SIZE);
  expect(meter.rowsRead(ftsReads)).toBeLessThanOrEqual(3 * (SEARCH_PAGE_SIZE + 1) + 3);

  meter.reset();
  const palette = await suggestCatalog(meter.db, {}, 'shirt');
  expect(palette.cards).toHaveLength(SUGGEST_SIZE);
  expect(meter.rowsRead(ftsReads)).toBeLessThanOrEqual(3 * (SUGGEST_SIZE + 1) + 3);
});

it('a term with 2,500 matches returns every match exactly once across pages', async () => {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await searchCatalog(db, {}, 'shirt', cursor);
    seen.push(...page.cards.map((card) => card.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const expected = Array.from({ length: PRODUCTS / SHIRT_EVERY }, (_, i) => `p${i * SHIRT_EVERY}`);
  expect(seen).toHaveLength(expected.length);
  expect(new Set(seen)).toEqual(new Set(expected));
}, 60_000);
