import {
  processCatalogBuild,
  processCatalogWork,
  runCatalogUnit,
  type CatalogBuildResult,
  type CatalogWorkResult,
} from '../../web/src/server/catalog-publisher';
import { vi } from 'vitest';
import { CatalogBudget } from '../../web/src/server/catalog-exec';
import { present } from './fixtures';

type KvLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
};

/** One work pass under a fresh invocation budget: a single queue-handler step. */
export function catalogPass(
  db: D1Database,
  kv?: KvLike,
  limit?: number
): Promise<CatalogWorkResult> {
  return processCatalogWork(db, kv, {
    budget: new CatalogBudget(),
    ...(limit === undefined ? {} : { limit }),
  });
}

/** Work passes until the claimed work is done, then the queued builds it scheduled until they
 *  settle: the published result the queue reaches. */
export async function catalogWork(
  db: D1Database,
  kv?: KvLike,
  limit?: number
): Promise<CatalogWorkResult> {
  const total: CatalogWorkResult = {
    processed: 0,
    productsPublished: 0,
    listingsRefreshed: [],
    kvPuts: 0,
  };
  for (let passes = 0; passes < 500; passes++) {
    const pass = await catalogPass(db, kv, limit);
    total.processed += pass.processed;
    total.productsPublished += pass.productsPublished;
    total.listingsRefreshed.push(...pass.listingsRefreshed);
    total.kvPuts += pass.kvPuts;
    if (!pass.more) break;
  }
  if (!kv) return total;
  for (let units = 0; units < 500; units++) {
    const unit = await runCatalogUnit(db, kv, { budget: new CatalogBudget() });
    if (unit.done || unit.busy || unit.retryAfterSeconds) return total;
  }
  throw new Error('catalog units did not settle');
}

/** Test-only driver: invoke successive bounded build units until
 *  the build completes, each under its own invocation budget. Under a faked clock the
 *  requested retry delay elapses instantly, as in the queue harness. */
export async function buildCatalogReadModels(
  db: D1Database,
  kv?: KvLike
): Promise<CatalogBuildResult> {
  for (let guard = 0; guard < 100_000; guard++) {
    const step = await processCatalogBuild(db, kv, { budget: new CatalogBudget() });
    if (step.done) return present(step.result, 'the finished build result');
    if (step.retryAfterSeconds && vi.isFakeTimers())
      vi.setSystemTime(Date.now() + step.retryAfterSeconds * 1000);
  }
  throw new Error('catalog build did not converge');
}
