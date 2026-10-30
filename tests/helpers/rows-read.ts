type Reading = { sql: string; rowsRead: number };

/** Wraps a D1 binding so every run, all, first and batch statement records the
 *  `meta.rows_read` D1 bills for it, keyed by its SQL text. */
export function meterRowsRead(db: D1Database) {
  const readings: Reading[] = [];
  const sqlOf = new WeakMap<D1PreparedStatement, string>();
  const nativeOf = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const record = <T>(sql: string, result: D1Result<T>) => {
    readings.push({ sql, rowsRead: result.meta.rows_read });
    return result;
  };
  const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(sql, target.bind(...values));
        if (prop === 'run') return async () => record(sql, await target.run());
        if (prop === 'all') return async () => record(sql, await target.all());
        if (prop === 'first')
          return async (column?: string) => {
            const row = record(sql, await target.all<Record<string, unknown>>()).results[0] ?? null;
            return column === undefined ? row : (row?.[column] ?? null);
          };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    sqlOf.set(proxy, sql);
    nativeOf.set(proxy, statement);
    return proxy;
  };
  const metered = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(sql, target.prepare(sql));
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements.map((s) => nativeOf.get(s) ?? s));
          for (const [i, statement] of statements.entries())
            readings.push({
              sql: sqlOf.get(statement) ?? '',
              rowsRead: results[i]?.meta.rows_read ?? 0,
            });
          return results;
        };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    db: metered,
    readings: (match: (sql: string) => boolean = () => true) =>
      readings.filter((r) => match(r.sql)),
    rowsRead: (match: (sql: string) => boolean = () => true) =>
      readings.filter((r) => match(r.sql)).reduce((sum, r) => sum + r.rowsRead, 0),
    reset: () => void readings.splice(0),
  };
}
