import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  Miniflare,
  convertV4MiniflareOptions,
} from '../../web/node_modules/miniflare/dist/src/index.js';

// Real D1 (workerd SQLite) for server-module tests: migrations are applied
// exactly as wrangler applies them, so constraints/triggers under test are
// the ones production runs.
export async function applyMigrationFile(db: D1Database, file: string): Promise<void> {
  const sql = readFileSync(join(process.cwd(), 'web', 'migrations', file), 'utf8');
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) await db.prepare(trimmed).run();
  }
}

const TRANSPORT_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);
/** A call can meet one stale pooled socket per attempt, so this bounds the redeliveries in a run. */
export const TRANSPORT_RETRY_BUDGET = 20;

function transportCause(error: unknown): string | null {
  if (!(error instanceof TypeError)) return null;
  const { cause } = error;
  if (typeof cause !== 'object' || cause === null) return null;
  if ('code' in cause && typeof cause.code === 'string' && TRANSPORT_CODES.has(cause.code))
    return cause.code;
  const message = cause instanceof Error ? cause.message : '';
  return [...TRANSPORT_CODES].find((code) => message.includes(code)) ?? null;
}

function describeCause({ cause }: Error) {
  if (typeof cause !== 'object' || cause === null) return { message: String(cause) };
  return {
    name: cause instanceof Error ? cause.name : undefined,
    code: 'code' in cause ? cause.code : undefined,
    message: cause instanceof Error ? cause.message : undefined,
  };
}

/** Miniflare serves D1 over a pooled loopback socket. workerd closes a connection idle for 5s, and
 *  a test process that blocks its event loop that long cannot run undici's 1s idle timer, so the
 *  next calls meet closed sockets as `TypeError: fetch failed`, which Cloudflare's D1 binding
 *  never raises. Redelivers a call after each such socket error, logging every retry, until the
 *  run's TRANSPORT_RETRY_BUDGET is spent; any other failure is logged with its cause and rethrown. */
export function withTransportRetry(db: D1Database): D1Database {
  let retries = 0;
  const attempt = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        const code = transportCause(error);
        if (code === null || retries >= TRANSPORT_RETRY_BUDGET) {
          if (error instanceof TypeError)
            console.error(
              JSON.stringify({ event: 'test_d1_transport_failed', cause: describeCause(error) })
            );
          throw error;
        }
        retries++;
        console.warn(JSON.stringify({ event: 'test_d1_transport_retry', code, retries }));
      }
    }
  };
  const raw = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        const member: unknown = Reflect.get(target, prop);
        if (typeof member !== 'function') return member;
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw')
          return (...args: unknown[]) => attempt(async () => Reflect.apply(member, target, args));
        return member.bind(target);
      },
    });
    raw.set(wrapped, statement);
    return wrapped;
  };
  return new Proxy(db, {
    get(target, prop) {
      const member: unknown = Reflect.get(target, prop);
      if (typeof member !== 'function') return member;
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (prop === 'batch')
        return (statements: D1PreparedStatement[]) =>
          attempt(() =>
            target.batch(statements.map((statement) => raw.get(statement) ?? statement))
          );
      if (prop === 'exec') return (query: string) => attempt(() => target.exec(query));
      return member.bind(target);
    },
  });
}

export async function createTestDb(
  opts: { skipFiles?: string[]; through?: string; transportRetry?: boolean } = {}
): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'test-db',
      compatibilityDate: '2026-10-17',
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: ['DB'],
    })
  );
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const dir = join(process.cwd(), 'web', 'migrations');
  // `through` builds a historical fixture: apply migrations up to and
  // including that file (sorted names compare correctly), instead of
  // excluding individual later files and missing their dependencies.
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !opts.through || f <= opts.through)
    .filter((f) => !(opts.skipFiles ?? []).includes(f));
  for (const file of files) {
    await applyMigrationFile(db, file);
  }
  return { db: opts.transportRetry ? withTransportRetry(db) : db, dispose: () => mf.dispose() };
}

export async function seedProduct(
  db: D1Database,
  opts: { sku?: string; priceCents?: number; onHand?: number; continueSelling?: boolean } = {}
) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO shipping_zones (id, name, countries_json, created_at) VALUES ('test-zone', 'US', '[\"US\"]', '2026-01-01')"
    )
    .run();
  await db
    .prepare(
      "INSERT OR IGNORE INTO shipping_rates (id, zone_id, name, amount_cents) VALUES ('test-rate', 'test-zone', 'Free', 0)"
    )
    .run();
  const sku = opts.sku ?? 'TEE-1';
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO products (id, slug, title, description, status, created_at, updated_at)
         VALUES ('p1', 'tee', 'Tee', '', 'active', ?, ?)`
      )
      .bind(now, now),
    db
      .prepare(
        `INSERT INTO variants (id, product_id, sku, title, price_cents, status, continue_selling, created_at)
         VALUES ('v1', 'p1', ?, 'Default', ?, 'active', ?, ?)`
      )
      .bind(sku, opts.priceCents ?? 2000, opts.continueSelling ? 1 : 0, now),
    db
      .prepare('INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES (?, ?, 0, ?)')
      .bind(sku, opts.onHand ?? 5, now),
    db
      .prepare(
        `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, created_at)
         VALUES ('seed-ledger', ?, ?, 0, 'restock', ?)`
      )
      .bind(sku, opts.onHand ?? 5, now),
  ]);
  return sku;
}

/** The ledger is the source of truth: summed deltas must equal counters. */
export async function expectLedgerMatchesCounters(db: D1Database, sku: string) {
  const counters = await db
    .prepare('SELECT on_hand, reserved FROM stock WHERE sku = ?')
    .bind(sku)
    .first<{ on_hand: number; reserved: number }>();
  const sums = await db
    .prepare(
      `SELECT COALESCE(SUM(delta_on_hand), 0) AS on_hand, COALESCE(SUM(delta_reserved), 0) AS reserved
       FROM stock_ledger WHERE sku = ?`
    )
    .bind(sku)
    .first<{ on_hand: number; reserved: number }>();
  if (!counters || !sums) throw new Error('missing stock rows');
  if (counters.on_hand !== sums.on_hand || counters.reserved !== sums.reserved) {
    throw new Error(
      `ledger/counter drift for ${sku}: counters on_hand=${counters.on_hand} reserved=${counters.reserved}, ledger on_hand=${sums.on_hand} reserved=${sums.reserved}`
    );
  }
  return counters;
}
