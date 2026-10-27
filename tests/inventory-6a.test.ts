import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
const env = {} as Cloudflare.Env;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 5 });
});
afterEach(async () => {
  await dispose();
});

const adjust = (payload: Record<string, unknown>) =>
  runAdminAction(db, env, owner, 'stock.adjust', payload);

async function onHand(): Promise<number> {
  const row = await db
    .prepare("SELECT on_hand FROM stock WHERE sku = 'TEE-1'")
    .first<{ on_hand: number }>();
  return row?.on_hand ?? 0;
}

describe('Phase 6A replay-protected stock adjustment', () => {
  it('applies once and replays the same operation without adjusting twice', async () => {
    const payload = { sku: 'TEE-1', delta: 10, reason: 'restock', operationId: 'op-1' };
    const first = await adjust(payload);
    expect(first.ok).toBe(true);
    const replay = await adjust(payload);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect((replay.data as { replayed: boolean }).replayed).toBe(true);
    expect(await onHand()).toBe(15);
    const ledger = await db
      .prepare("SELECT COUNT(*) AS n FROM stock_ledger WHERE ref_type = 'stock_operation'")
      .first<{ n: number }>();
    expect(ledger?.n).toBe(1);
  });

  it('conflicts when the same operation ID carries a changed payload', async () => {
    await adjust({ sku: 'TEE-1', delta: 10, reason: 'restock', operationId: 'op-2' });
    const changed = await adjust({
      sku: 'TEE-1',
      delta: 4,
      reason: 'restock',
      operationId: 'op-2',
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.conflict).toBe(true);
    expect(await onHand()).toBe(15);
  });

  it('reports a missing SKU', async () => {
    const result = await adjust({ sku: 'NOPE', delta: 1, reason: 'restock', operationId: 'op-3' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('No stock record');
  });

  it('keeps the ledger reconciled with the counter after a replayed adjustment', async () => {
    await adjust({ sku: 'TEE-1', delta: -2, reason: 'damaged', operationId: 'op-4' });
    await adjust({ sku: 'TEE-1', delta: -2, reason: 'damaged', operationId: 'op-4' });
    const ledgerSum = await db
      .prepare(
        "SELECT COALESCE(SUM(delta_on_hand), 0) AS total FROM stock_ledger WHERE sku = 'TEE-1' AND ref_type = 'stock_operation'"
      )
      .first<{ total: number }>();
    expect(await onHand()).toBe(3);
    expect(ledgerSum?.total).toBe(-2);
  });
});
