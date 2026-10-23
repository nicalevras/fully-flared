// Bounded catalog execution (Round 2): one production unit per
// queue invocation under a shared invocation budget and a fenced
// publisher lease. The budget covers D1 statements, KV operations,
// combined external operations, source rows and materialized payload
// bytes — including bookkeeping and continuation headroom. Queries
// are bounded before execution; counters never substitute for that.

export class BudgetExhausted extends Error {
  constructor(public readonly kind: string) {
    super(`catalog invocation budget exhausted: ${kind}`);
    this.name = 'BudgetExhausted';
  }
}

export const CATALOG_BUDGET_LIMITS = {
  d1Statements: 40,
  kvOps: 800,
  combinedOps: 900,
  sourceRows: 5_000,
  payloadBytes: 8 * 1024 * 1024,
  maxBinds: 90,
} as const;

// Headroom reserved so an exhausted unit can still checkpoint and
// enqueue its continuation.
export const BUDGET_RESERVE = 60;

export class CatalogBudget {
  private finishing = false;
  d1 = 0;
  kv = 0;
  other = 0;
  rows = 0;
  bytes = 0;
  constructor(private readonly limits = CATALOG_BUDGET_LIMITS) {}
  get combined(): number {
    return this.d1 + this.kv + this.other;
  }
  /** Generic bounded-work operation (unit ticks that are neither a
   *  directly counted statement nor a KV call). */
  tickOp(n = 1): void {
    if (this.combined + n > this.limits.combinedOps) throw new BudgetExhausted('combined');
    this.other += n;
  }
  get remaining(): number {
    return this.limits.combinedOps - this.combined;
  }
  get remainingStatements(): number {
    return this.limits.d1Statements - this.d1;
  }
  // Counters pre-check: an operation that would cross a ceiling is
  // refused (BudgetExhausted) BEFORE it happens, so recorded usage
  // never exceeds the limits. The caller checkpoints and continues
  // in a later invocation; partial chunk writes are idempotent.
  statement(n = 1): void {
    if (this.d1 + n > this.limits.d1Statements - (this.finishing ? 0 : 4))
      throw new BudgetExhausted('d1');
    if (this.combined + n > this.limits.combinedOps) throw new BudgetExhausted('combined');
    this.d1 += n;
  }
  async finalize<T>(operation: () => Promise<T>): Promise<T> {
    this.finishing = true;
    try {
      return await operation();
    } finally {
      this.finishing = false;
    }
  }
  kvOp(n = 1): void {
    if (this.kv + n > this.limits.kvOps) throw new BudgetExhausted('kv');
    if (this.combined + n > this.limits.combinedOps) throw new BudgetExhausted('combined');
    this.kv += n;
  }
  addRows(n: number): void {
    if (this.rows + n > this.limits.sourceRows) throw new BudgetExhausted('rows');
    this.rows += n;
  }
  addBytes(n: number): void {
    if (this.bytes + n > this.limits.payloadBytes - (this.finishing ? 0 : 64 * 1024))
      throw new BudgetExhausted('bytes');
    this.bytes += n;
  }
  /** True when too little budget remains to start more work; the
   *  caller must checkpoint and continue in a later invocation. */
  spent(): boolean {
    return this.remaining <= BUDGET_RESERVE || this.rows >= 500 || this.bytes >= 4 * 1024 * 1024;
  }
}

const realStatement = new WeakMap<object, unknown>();

function wrapStatement(stmt: D1PreparedStatement, budget: CatalogBudget): D1PreparedStatement {
  const wrapped = Object.create(stmt) as D1PreparedStatement;
  const rawBind = stmt.bind.bind(stmt);
  (wrapped as { bind: (...v: unknown[]) => D1PreparedStatement }).bind = (...values: unknown[]) => {
    if (values.length > CATALOG_BUDGET_LIMITS.maxBinds) throw new BudgetExhausted('binds');
    for (const v of values) {
      if (typeof v === 'string') budget.addBytes(new TextEncoder().encode(v).byteLength);
    }
    const bound = rawBind(...values);
    const bw = wrapStatement(bound, budget);
    realStatement.set(bw, bound);
    return bw;
  };
  const rawRun = stmt.run.bind(stmt);
  (wrapped as { run: () => Promise<unknown> }).run = async () => {
    budget.statement();
    return rawRun();
  };
  const rawAll = stmt.all.bind(stmt);
  (wrapped as { all: () => Promise<{ results?: unknown[] }> }).all = async () => {
    budget.statement();
    const r = await rawAll();
    budget.addRows(r.results?.length ?? 0);
    budget.addBytes(new TextEncoder().encode(JSON.stringify(r.results ?? [])).byteLength);
    return r;
  };
  const rawRows = stmt.raw.bind(stmt);
  (wrapped as { raw: (...args: unknown[]) => Promise<unknown[][]> }).raw = async (
    ...args: unknown[]
  ) => {
    budget.statement();
    const result = await (rawRows as (...a: unknown[]) => Promise<unknown[][]>)(...args);
    budget.addRows(result.length);
    budget.addBytes(new TextEncoder().encode(JSON.stringify(result)).byteLength);
    return result;
  };
  const rawFirst = stmt.first.bind(stmt);
  (wrapped as { first: () => Promise<unknown> }).first = async () => {
    budget.statement();
    const r = await rawFirst();
    if (r != null) budget.addRows(1);
    if (r != null) budget.addBytes(new TextEncoder().encode(JSON.stringify(r)).byteLength);
    return r;
  };
  realStatement.set(wrapped, stmt);
  return wrapped;
}

/** Wrap a D1 handle so every statement/row/byte is counted against
 *  the shared budget. batch() unwraps to native statements (D1
 *  requires them) and counts each statement individually. */
export function countedDb(db: D1Database, budget: CatalogBudget): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => wrapStatement(target.prepare(sql), budget);
      }
      if (prop === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          budget.statement(stmts.length);
          const native = stmts.map(
            (s) => (realStatement.get(s) as D1PreparedStatement | undefined) ?? s
          );
          const result = await target.batch(native);
          for (const row of result) {
            budget.addRows(row.results?.length ?? 0);
            budget.addBytes(new TextEncoder().encode(JSON.stringify(row.results ?? [])).byteLength);
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

export type CatalogLease = { token: string; fencing: number };

/** Fence mutable staging/checkpoints too: a stale worker must not corrupt
 *  the durable projections used by the next publisher or replica repair. */
export function fencedCatalogDb(db: D1Database, lease: CatalogLease): D1Database {
  const original = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (prop === 'run')
          return async () => {
            const result = await db.batch([leaseGuardStatement(db, lease), target]);
            return result[1];
          };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    original.set(proxy, statement);
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (prop === 'batch')
        return (statements: D1PreparedStatement[]) =>
          target.batch([
            leaseGuardStatement(db, lease),
            ...statements.map((s) => original.get(s) ?? s),
          ]);
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function countedKv<
  T extends {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
    delete?(key: string): Promise<void>;
    list?(options: {
      prefix: string;
      limit: number;
      cursor?: string;
    }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
  },
>(kv: T, budget: CatalogBudget): T {
  return new Proxy(kv, {
    get(target, prop) {
      if (prop === 'get')
        return async (key: string) => {
          budget.kvOp();
          const value = await target.get(key);
          if (value) budget.addBytes(new TextEncoder().encode(value).byteLength);
          return value;
        };
      if (prop === 'put')
        return async (key: string, value: string) => {
          const bytes = new TextEncoder().encode(value).byteLength;
          if (bytes > 1_500_000) throw new Error('Catalog artifact exceeds byte budget');
          budget.kvOp();
          budget.addBytes(bytes);
          return target.put(key, value);
        };
      if (prop === 'delete' && target.delete)
        return async (key: string) => {
          budget.kvOp();
          return target.delete!(key);
        };
      if (prop === 'list' && target.list)
        return async (options: Parameters<NonNullable<T['list']>>[0]) => {
          budget.kvOp();
          const result = await target.list!(options);
          budget.addBytes(new TextEncoder().encode(JSON.stringify(result)).byteLength);
          return result;
        };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const LEASE_TTL_MS = 120_000;

function iso(msEpoch: number): string {
  return new Date(msEpoch).toISOString().replace('T', ' ').slice(0, 19);
}

/** Claim the publisher lease. A live lease held by someone else
 *  returns null (the caller stops harmlessly); an expired lease is
 *  taken over with a higher fencing generation. */
export async function claimCatalogLease(
  db: D1Database,
  nowMs: number = Date.now()
): Promise<CatalogLease | null> {
  const token = crypto.randomUUID();
  const res = await db
    .prepare(
      `UPDATE catalog_publication_state
       SET lease_token = ?, lease_fencing = lease_fencing + 1, lease_expires_at = ?, updated_at = ?
       WHERE id = 1 AND (lease_expires_at IS NULL OR lease_expires_at < ?)`
    )
    .bind(token, iso(nowMs + LEASE_TTL_MS), iso(nowMs), iso(nowMs))
    .run();
  if ((res.meta?.changes ?? 0) === 0) return null;
  const row = await db
    .prepare('SELECT lease_fencing FROM catalog_publication_state WHERE id = 1')
    .first<{ lease_fencing: number }>();
  return { token, fencing: row?.lease_fencing ?? 0 };
}

export async function releaseCatalogLease(db: D1Database, lease: CatalogLease): Promise<void> {
  await db
    .prepare(
      'UPDATE catalog_publication_state SET lease_token = NULL, lease_expires_at = NULL WHERE id = 1 AND lease_token = ? AND lease_fencing = ?'
    )
    .bind(lease.token, lease.fencing)
    .run()
    .catch((error: unknown) =>
      console.error(
        JSON.stringify({
          event: 'catalog_lease_release_failed',
          errorType: error instanceof Error ? error.name : 'unknown',
        })
      )
    );
}

/** In-batch guard: aborts the batch unless the lease is still held
 *  and unexpired. Prepend to any commit batch. */
export function leaseGuardStatement(
  db: D1Database,
  lease: CatalogLease,
  nowMs: number = Date.now()
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS (
         SELECT 1 FROM catalog_publication_state
         WHERE id = 1 AND lease_token = ? AND lease_fencing = ? AND lease_expires_at > ?)`
    )
    .bind(lease.token, lease.fencing, iso(nowMs));
}
