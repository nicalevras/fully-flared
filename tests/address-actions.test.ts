import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { saveAddress } from '../web/src/server/account-addresses';
import { createTestDb, type TestDb } from './helpers/d1';

let db: D1Database;
let dispose: () => Promise<void>;

const fields = {
  name: 'Pat',
  line1: '1 Main',
  line2: '',
  city: 'Springfield',
  region: 'IL',
  postalCode: '62701',
  country: 'US',
  phone: '',
};

async function defaults(): Promise<Array<{ id: string; is_default: number; name: string }>> {
  const rows = await db
    .prepare('SELECT id, is_default, name FROM addresses ORDER BY id')
    .all<{ id: string; is_default: number; name: string }>();
  return rows.results;
}

function withBatch(dbRef: D1Database, batch: D1Database['batch']): D1Database {
  return new Proxy(dbRef, {
    get(target, key) {
      if (key === 'batch') return batch;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

beforeAll(async () => {
  const created: TestDb = await createTestDb();
  db = created.db;
  dispose = created.dispose;
  await db
    .prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('u1', 'U1', 'u1@x.invalid', 1, 1), ('u2', 'U2', 'u2@x.invalid', 1, 1)"
    )
    .run();
  await db
    .prepare(
      `INSERT INTO addresses (id, user_id, name, line1, city, state, postal_code, country, is_default) VALUES
       ('a1', 'u1', 'First', '1 Main', 'Springfield', 'IL', '62701', 'US', 1),
       ('a2', 'u1', 'Second', '2 Main', 'Springfield', 'IL', '62701', 'US', 0),
       ('b1', 'u2', 'Other', '3 Main', 'Springfield', 'IL', '62701', 'US', 1)`
    )
    .run();
});

afterAll(async () => {
  await dispose();
});

describe('address default writes', () => {
  it('missing address update returns not-found and preserves the default', async () => {
    const result = await saveAddress(db, 'u1', {
      action: 'address.update',
      addressId: 'missing',
      ...fields,
      isDefault: true,
    });
    expect(result).toEqual({ ok: false, error: 'Address not found' });
    expect((await defaults()).find((row) => row.id === 'a1')?.is_default).toBe(1);
  });

  it('foreign address update returns not-found and preserves both defaults', async () => {
    const result = await saveAddress(db, 'u1', {
      action: 'address.update',
      addressId: 'b1',
      ...fields,
      isDefault: true,
    });
    expect(result).toEqual({ ok: false, error: 'Address not found' });
    const rows = await defaults();
    expect(rows.find((row) => row.id === 'a1')?.is_default).toBe(1);
    expect(rows.find((row) => row.id === 'b1')?.is_default).toBe(1);
  });

  it('deletion between precheck and batch aborts and preserves the default', async () => {
    const proxied = withBatch(db, async (statements) => {
      await db.prepare("DELETE FROM addresses WHERE id = 'a2'").run();
      return db.batch(statements);
    });
    const result = await saveAddress(proxied, 'u1', {
      action: 'address.update',
      addressId: 'a2',
      ...fields,
      name: 'Changed',
      isDefault: true,
    });
    expect(result).toEqual({ ok: false, error: 'Address not found' });
    expect((await defaults()).find((row) => row.id === 'a1')?.is_default).toBe(1);
    // Restore a2 for later cases.
    await db
      .prepare(
        "INSERT INTO addresses (id, user_id, name, line1, city, state, postal_code, country, is_default) VALUES ('a2', 'u1', 'Second', '2 Main', 'Springfield', 'IL', '62701', 'US', 0)"
      )
      .run();
  });

  it('failure after the target update rolls the whole change back', async () => {
    const proxied = withBatch(db, (statements) =>
      db.batch([...statements, db.prepare('INSERT INTO nonexistent_table VALUES (1)')])
    );
    await expect(
      saveAddress(proxied, 'u1', {
        action: 'address.update',
        addressId: 'a2',
        ...fields,
        name: 'Changed',
        isDefault: true,
      })
    ).rejects.toThrow();
    const rows = await defaults();
    expect(rows.find((row) => row.id === 'a2')?.name).toBe('Second');
    expect(rows.find((row) => row.id === 'a2')?.is_default).toBe(0);
    expect(rows.find((row) => row.id === 'a1')?.is_default).toBe(1);
  });

  it('non-guard database failures stay generic, not Address not found', async () => {
    const proxied = new Proxy(db, {
      get(target, key) {
        if (key === 'batch')
          return async () => {
            throw new Error('database outage');
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      saveAddress(proxied, 'u1', { action: 'address.create', ...fields, isDefault: true })
    ).rejects.toThrow('database outage');
  });

  it('failed follow-up lookup after a batch failure stays an error, not not-found', async () => {
    let batchAttempted = false;
    const proxied = new Proxy(db, {
      get(target, key) {
        if (key === 'batch')
          return async () => {
            batchAttempted = true;
            throw new Error('database outage');
          };
        if (key === 'prepare')
          return (sql: string) => {
            if (batchAttempted && sql.includes('SELECT id FROM addresses'))
              return {
                bind: () => ({
                  first: async () => {
                    throw new Error('lookup outage');
                  },
                }),
              };
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      saveAddress(proxied, 'u1', {
        action: 'address.update',
        addressId: 'a2',
        ...fields,
        isDefault: true,
      })
    ).rejects.toThrow('lookup outage');
  });

  it('successful default switch moves the flag exactly once', async () => {
    const result = await saveAddress(db, 'u1', {
      action: 'address.update',
      addressId: 'a2',
      ...fields,
      name: 'Second updated',
      isDefault: true,
    });
    expect(result).toEqual({ ok: true });
    const mine = (await defaults()).filter((row) => row.id.startsWith('a'));
    expect(mine.filter((row) => row.is_default === 1).map((row) => row.id)).toEqual(['a2']);
  });

  it('creating a default address clears the previous default', async () => {
    const result = await saveAddress(db, 'u1', {
      action: 'address.create',
      ...fields,
      name: 'Third',
      isDefault: true,
    });
    expect(result).toEqual({ ok: true });
    const rows = await defaults();
    const mine = rows.filter((row) => ['a1', 'a2'].includes(row.id) || row.name === 'Third');
    expect(mine.filter((row) => row.is_default === 1)).toHaveLength(1);
    expect(mine.find((row) => row.is_default === 1)?.name).toBe('Third');
  });
});
