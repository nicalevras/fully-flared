import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, withTransportRetry } from './helpers/d1';

const socketError = (code = 'UND_ERR_SOCKET') =>
  new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code }) });

/** A real test database whose statements and batches fail with the queued outcomes first
 *  (an error fails the attempt, null lets it through), counting the attempts made. */
function flakyDb(real: D1Database, outcomes: (Error | null)[]) {
  const calls = { run: 0, batch: 0 };
  const failure = () => outcomes.shift() ?? null;
  const statement = (target: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(target, {
      get(inner, prop) {
        if (prop === 'bind') return (...values: unknown[]) => statement(inner.bind(...values));
        if (prop === 'run')
          return async () => {
            calls.run++;
            const error = failure();
            if (error) throw error;
            return inner.run();
          };
        const member: unknown = Reflect.get(inner, prop);
        return typeof member === 'function' ? member.bind(inner) : member;
      },
    });
  const db = new Proxy(real, {
    get(inner, prop) {
      if (prop === 'prepare') return (sql: string) => statement(inner.prepare(sql));
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          calls.batch++;
          const error = failure();
          if (error) throw error;
          return inner.batch(statements);
        };
      const member: unknown = Reflect.get(inner, prop);
      return typeof member === 'function' ? member.bind(inner) : member;
    },
  });
  return { db: withTransportRetry(db), calls };
}

let real: D1Database, dispose: () => Promise<void>;
let warn: ReturnType<typeof vi.spyOn>, error: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  ({ db: real, dispose } = await createTestDb());
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await dispose();
});

const logged = (spy: typeof warn) => spy.mock.calls.map(([line]) => JSON.parse(String(line)));

it('redelivers a statement once after a socket error and logs the retry', async () => {
  const { db, calls } = flakyDb(real, [socketError()]);
  await expect(db.prepare('SELECT 1').bind().run()).resolves.toMatchObject({ success: true });
  expect(calls.run).toBe(2);
  expect(logged(warn)).toEqual([
    { event: 'test_d1_transport_retry', code: 'UND_ERR_SOCKET', retries: 1 },
  ]);
});

it('redelivers an atomic batch once after a socket error', async () => {
  const { db, calls } = flakyDb(real, [socketError('ECONNRESET')]);
  await expect(db.batch([db.prepare('SELECT 1')])).resolves.toHaveLength(1);
  expect(calls.batch).toBe(2);
});

it('fails when the redelivered statement hits the socket error again', async () => {
  const { db, calls } = flakyDb(real, [socketError(), socketError()]);
  await expect(db.prepare('SELECT 1').run()).rejects.toThrow('fetch failed');
  expect(calls.run).toBe(2);
});

it('does not retry a TypeError whose cause is not a socket error, and logs the cause', async () => {
  const { db, calls } = flakyDb(real, [socketError('ETIMEDOUT')]);
  await expect(db.prepare('SELECT 1').run()).rejects.toThrow('fetch failed');
  expect(calls.run).toBe(1);
  expect(warn).not.toHaveBeenCalled();
  expect(logged(error)).toEqual([
    {
      event: 'test_d1_transport_failed',
      cause: { name: 'Error', code: 'ETIMEDOUT', message: 'other side closed' },
    },
  ]);
});

it('does not retry other errors', async () => {
  const { db, calls } = flakyDb(real, [new Error('UNIQUE constraint failed')]);
  await expect(db.prepare('SELECT 1').run()).rejects.toThrow('UNIQUE constraint failed');
  expect(calls.run).toBe(1);
  expect(error).not.toHaveBeenCalled();
});

it('stops retrying after three transport retries in a run', async () => {
  const { db, calls } = flakyDb(real, [
    socketError(),
    null,
    socketError(),
    null,
    socketError(),
    null,
    socketError(),
  ]);
  for (let i = 0; i < 3; i++) await db.prepare('SELECT 1').run();
  await expect(db.prepare('SELECT 1').run()).rejects.toThrow('fetch failed');
  expect(calls.run).toBe(7);
});
