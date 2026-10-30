import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { env } from './helpers/cloudflare-workers-stub';
import { createTestDb } from './helpers/d1';
import { Route } from '../web/src/routes/api/reports';
import { parseCsv } from '../web/src/server/csv';

vi.mock('../web/src/server/session', async (original) => ({
  ...(await original<typeof import('../web/src/server/session')>()),
  requireStaff: async () => ({ id: 'staff', role: 'owner' }),
}));
let db: D1Database, dispose: () => Promise<void>;
beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  env.DB = db;
});
afterAll(async () => {
  delete env.DB;
  await dispose();
});

async function get(query: string) {
  const handlers = Route.options.server!.handlers;
  if (typeof handlers === 'function') throw new Error('Expected direct route handlers');
  const handler = handlers!.GET;
  if (typeof handler !== 'function') throw new Error('Expected GET handler');
  return handler({
    request: new Request(`http://localhost:8799/api/reports?${query}`),
  } as never) as Promise<Response>;
}

async function seedMonth(prefix: string, month: string, count: number) {
  await db
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i+1<?)
       INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,currency,status,payment_status,created_at,updated_at)
       SELECT ?||i, ?||i, 'fixture@example.invalid', 100, 100, 'USD', 'paid', 'paid',
              strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+'||(i % 28)||' days', '+'||(i % 86400)||' seconds'),
              ? FROM n`
    )
    .bind(
      count,
      `${prefix}-`,
      `${prefix}-`,
      `${month}-01T00:00:00.000Z`,
      `${month}-01T00:00:00.000Z`
    )
    .run();
}

it('30k orders export in two ranges under the cap', async () => {
  await seedMonth('jan', '2026-01', 15_000);
  await seedMonth('feb', '2026-02', 15_000);
  expect((await get('type=orders&format=csv')).status).toBe(413);

  const jan = await get('type=orders&format=csv&from=2026-01-01&to=2026-01-31');
  const feb = await get('type=orders&format=csv&from=2026-02-01&to=2026-02-28');
  expect([jan.status, feb.status]).toEqual([200, 200]);
  const janRows = parseCsv(await jan.text()).slice(1);
  const febRows = parseCsv(await feb.text()).slice(1);
  expect([janRows.length, febRows.length]).toEqual([15_000, 15_000]);
  expect(new Set([...janRows, ...febRows].map((row) => row[0])).size).toBe(30_000);
}, 300_000);

it('rejects a range that is not a calendar date or ends before it starts', async () => {
  for (const range of ['from=2026-02-30', 'to=yesterday', 'from=2026-02-01&to=2026-01-01'])
    expect((await get(`type=orders&${range}`)).status).toBe(400);
});
