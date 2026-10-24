import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TRANSPORT_RETRY_BUDGET, createTestDb, withTransportRetry } from './helpers/d1';

// workerd closes a connection idle for 5s; a blocked loop cannot run undici's 1s idle timer.
const WORKERD_IDLE_TIMEOUT_MS = 5000;

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

it('redelivers a statement after a socket error and logs the retry', async () => {
  const { db, calls } = flakyDb(real, [socketError()]);
  await expect(db.prepare('SELECT 1').bind().run()).resolves.toMatchObject({ success: true });
  expect(calls.run).toBe(2);
  expect(logged(warn)).toEqual([
    { event: 'test_d1_transport_retry', code: 'UND_ERR_SOCKET', retries: 1 },
  ]);
});

it('redelivers an atomic batch after a socket error', async () => {
  const { db, calls } = flakyDb(real, [socketError('ECONNRESET')]);
  await expect(db.batch([db.prepare('SELECT 1')])).resolves.toHaveLength(1);
  expect(calls.batch).toBe(2);
});

it('keeps redelivering while each attempt meets another closed socket', async () => {
  const { db, calls } = flakyDb(real, [socketError(), socketError()]);
  await expect(db.prepare('SELECT 1').run()).resolves.toMatchObject({ success: true });
  expect(calls.run).toBe(3);
  expect(logged(warn).map(({ retries }) => retries)).toEqual([1, 2]);
});

it('recognises a reset whose cause carries no code', async () => {
  const reset = new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });
  const { db, calls } = flakyDb(real, [reset]);
  await expect(db.prepare('SELECT 1').run()).resolves.toMatchObject({ success: true });
  expect(calls.run).toBe(2);
  expect(logged(warn)).toEqual([
    { event: 'test_d1_transport_retry', code: 'ECONNRESET', retries: 1 },
  ]);
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

it('stops redelivering once the run has spent its retry budget', async () => {
  const { db, calls } = flakyDb(
    real,
    Array.from({ length: TRANSPORT_RETRY_BUDGET + 1 }, () => socketError())
  );
  await expect(db.prepare('SELECT 1').run()).rejects.toThrow('fetch failed');
  expect(calls.run).toBe(TRANSPORT_RETRY_BUDGET + 1);
});

it(
  'survives every pooled socket going stale while the event loop is blocked past the idle timeout',
  { timeout: 60_000 },
  async () => {
    const { db: pooled, dispose: disposePooled } = await createTestDb({ transportRetry: true });
    try {
      const selects = () =>
        Promise.all([1, 2, 3, 4, 5, 6].map((n) => pooled.prepare(`SELECT ${n}`).first()));
      await selects();
      const idleUntil = Date.now() + WORKERD_IDLE_TIMEOUT_MS + 1500;
      while (Date.now() < idleUntil);
      await expect(selects()).resolves.toHaveLength(6);
    } finally {
      await disposePooled();
    }
  }
);
