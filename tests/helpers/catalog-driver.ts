import {
  processCatalogBuild,
  type CatalogBuildResult,
} from '../../web/src/server/catalog-publisher';

type KvLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
};

/** Test-only driver: invoke successive bounded build units until
 *  the build completes, without the queue handler's budget. */
export async function buildCatalogReadModels(
  db: D1Database,
  kv?: KvLike
): Promise<CatalogBuildResult> {
  for (let guard = 0; guard < 100_000; guard++) {
    const step = await processCatalogBuild(db, kv);
    if (step.done) return step.result!;
  }
  throw new Error('catalog build did not converge');
}
