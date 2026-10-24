import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { buildCatalogReadModels } from './helpers/catalog-driver';
import { runWithRequestContext } from '../web/src/server/exec-context';
import { getSettings, readSettings, setSetting } from '../web/src/server/settings';
import { robotsTxt } from '../web/src/server/robots';

class Kv {
  map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
}

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => dispose());

/** A D1 that counts the statements it prepares, optionally only matching ones. */
function counting(match = /./) {
  const counted = { queries: 0, db };
  counted.db = new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === 'prepare')
        return (sql: string) => {
          if (match.test(sql)) counted.queries++;
          return target.prepare(sql);
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return counted;
}

const request = <T>(operation: () => Promise<T>) =>
  runWithRequestContext({} as ExecutionContext, operation);

it('reads settings once per request and per call outside one', async () => {
  const settings = counting(/"settings"/);
  await request(async () => {
    for (let call = 0; call < 3; call++) await getSettings(settings.db);
  });
  expect(settings.queries).toBe(1);
  for (let call = 0; call < 3; call++) await getSettings(settings.db);
  expect(settings.queries).toBe(4);
});

it('sees a setting written earlier in the same request through readSettings', async () => {
  await request(async () => {
    expect((await getSettings(db)).storeName).toBe('My Store');
    await setSetting(db, 'store_name', 'Renamed');
    expect((await readSettings(db)).storeName).toBe('Renamed');
  });
});

it('serves robots.txt from the published layout without touching D1', async () => {
  const kv = new Kv();
  await setSetting(db, 'canonical_base_url', 'https://store.example');
  await buildCatalogReadModels(db, kv);
  const all = counting();
  const robots = await request(() => robotsTxt(all.db, { CATALOG_KV: kv }, 'https://shop.invalid'));
  expect(all.queries).toBe(0);
  expect(await robots.text()).toContain('Sitemap: https://store.example/sitemap.xml');
});
