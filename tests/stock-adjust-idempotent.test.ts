import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 5 });
});
afterEach(async () => {
  await dispose();
});

const adjust = (payload: Record<string, unknown>) =>
  runAdminAction(db, env, owner, 'stock.adjust', payload);

const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;

const onHand = async () =>
  (await db.prepare("SELECT on_hand FROM stock WHERE sku = 'TEE-1'").first<{ on_hand: number }>())
    ?.on_hand;

it('replaying the same operationId applies once', async () => {
  const payload = {
    sku: 'TEE-1',
    delta: 5,
    reason: 'restock',
    operationId: 'op-replay',
    expectedOnHand: 5,
  };
  expect(await adjust(payload)).toEqual(expect.objectContaining({ ok: true }));
  expect(await adjust(payload)).toEqual(
    expect.objectContaining({ ok: true, data: expect.objectContaining({ replayed: true }) })
  );
  expect(await onHand()).toBe(10);
  expect(await count("SELECT COUNT(*) AS n FROM stock_ledger WHERE ref_id = 'op-replay'")).toBe(1);
});

it('a stale expectedOnHand is a conflict and writes nothing', async () => {
  const result = await adjust({
    sku: 'TEE-1',
    delta: 5,
    reason: 'restock',
    operationId: 'op-stale',
    expectedOnHand: 3,
  });
  expect(result).toEqual(expect.objectContaining({ ok: false, conflict: true }));
  expect(await onHand()).toBe(5);
  expect(await count("SELECT COUNT(*) AS n FROM stock_operations WHERE id = 'op-stale'")).toBe(0);
  expect(await count("SELECT COUNT(*) AS n FROM stock_ledger WHERE ref_id = 'op-stale'")).toBe(0);
  expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'stock.adjust'")).toBe(0);
});
