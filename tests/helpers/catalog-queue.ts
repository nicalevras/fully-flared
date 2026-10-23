import { expect, vi } from 'vitest';
import type { JobMessage } from '../../web/src/schemas/queue';

/** Real exported Worker handler; counters wrap the physical bindings. */
export async function catalogQueueHarness(
  db: D1Database,
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
    delete?(key: string): Promise<void>;
    beginInvocation?(): void;
  }
) {
  const { default: worker } = await import('../../web/src/server');
  const native = new WeakMap<object, D1PreparedStatement>();
  let d1 = 0,
    kvOps = 0,
    other = 0,
    rows = 0;
  let failSend = false;
  let acked = false,
    retried = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind')
          return (...values: unknown[]) => {
            expect(values.length).toBeLessThanOrEqual(90);
            const bound = target.bind(...values);
            const w = wrap(bound);
            native.set(w, bound);
            return w;
          };
        if (['run', 'all', 'first', 'raw'].includes(String(prop)))
          return async (...args: unknown[]) => {
            d1++;
            expect(d1).toBeLessThanOrEqual(40);
            const result = await (
              Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>
            ).apply(target, args);
            if (prop === 'all') rows += (result as { results: unknown[] }).results.length;
            if (prop === 'raw') rows += (result as unknown[][]).length;
            if (prop === 'first' && result != null) rows++;
            expect(rows).toBeLessThanOrEqual(5000);
            return result;
          };
        return Reflect.get(target, prop);
      },
    });
  const counted = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const raw = target.prepare(sql),
            w = wrap(raw);
          native.set(w, raw);
          return w;
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          d1 += statements.length;
          expect(d1).toBeLessThanOrEqual(40);
          return target.batch(statements.map((s) => native.get(s) ?? s));
        };
      return Reflect.get(target, prop);
    },
  });
  const binding = new Proxy(kv, {
    get(target, prop) {
      if (['get', 'put', 'delete', 'list'].includes(String(prop)) && Reflect.get(target, prop))
        return async (...args: unknown[]) => {
          kvOps++;
          expect(kvOps).toBeLessThanOrEqual(800);
          return (Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>).apply(
            target,
            args
          );
        };
      return Reflect.get(target, prop);
    },
  });
  return {
    failNextSend() {
      failSend = true;
    },
    async deliver(job: JobMessage = { type: 'catalog.rebuild' }) {
      if (vi.isFakeTimers()) vi.setSystemTime(Date.now() + 2000);
      kv.beginInvocation?.();
      d1 = 0;
      kvOps = 0;
      other = 0;
      rows = 0;
      acked = false;
      retried = false;
      let sent = false;
      let sendOptions: { delaySeconds?: number } | undefined;
      await worker.queue(
        {
          queue: 'store-catalog',
          messages: [
            {
              body: job,
              ack() {
                acked = true;
              },
              retry() {
                retried = true;
              },
            },
          ],
        } as never,
        {
          QUEUE_NAMES: { CATALOG_JOBS: 'store-catalog', DLQ: 'store-jobs-dlq' },
          DB: counted,
          CATALOG_KV: binding,
          CATALOG_JOBS: {
            async send(_body: JobMessage, options?: { delaySeconds?: number }) {
              other++;
              sendOptions = options;
              if (failSend) {
                failSend = false;
                throw new Error('Injected continuation send failure');
              }
              sent = true;
            },
          },
          REALTIME: {
            getByName() {
              return {
                async broadcast() {
                  other++;
                },
              };
            },
          },
        } as never,
        {
          waitUntil() {},
          exports: {
            PublicStorefront: {
              async purgeInvalidations() {
                other++;
              },
            },
          },
        } as never
      );
      expect(d1 + kvOps + other).toBeLessThanOrEqual(900);
      return { d1, kv: kvOps, other, rows, acked, retried, continued: sent, sendOptions };
    },
  };
}
