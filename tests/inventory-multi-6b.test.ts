import { describe, expect, it } from 'vitest';
import {
  applyMultiOutcome,
  parseMultiAdjustments,
  retryableItems,
  summarizeMulti,
} from '../web/src/lib/inventory-multi';
import { createTestDb, seedProduct } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';

let seq = 0;
const makeId = () => `op-multi-${++seq}`;
const shared = { reason: 'restock', note: '' };

describe('Phase 6B multi SKU parsing and retry state', () => {
  it('parses signed amounts and rejects duplicates and excess rows', () => {
    const ok = parseMultiAdjustments('TEE-1, 5\nHAT-2 -3', shared, makeId);
    expect(ok.errors).toEqual([]);
    expect(ok.items.map((i) => [i.sku, i.delta])).toEqual([
      ['TEE-1', 5],
      ['HAT-2', -3],
    ]);
    const dup = parseMultiAdjustments('TEE-1, 5\nTEE-1, 2', shared, makeId);
    expect(dup.items).toEqual([]);
    expect(dup.errors[0]).toContain('more than once');
    const many = parseMultiAdjustments(
      Array.from({ length: 21 }, (_, i) => `SKU-${i}, 1`).join('\n'),
      shared,
      makeId
    );
    expect(many.errors[0]).toContain('at most 20');
  });

  it('preserves applied rows and original operation IDs on retry', () => {
    const { items } = parseMultiAdjustments('TEE-1, 5\nHAT-2, 2', shared, makeId);
    let next = applyMultiOutcome(items, 'TEE-1', { ok: true, message: 'Recorded' });
    next = applyMultiOutcome(next, 'HAT-2', { ok: false, message: 'No stock record' });
    const summary = summarizeMulti(next);
    expect(summary.partial).toBe(true);
    expect(summary.applied).toBe(1);
    const retry = retryableItems(next);
    expect(retry).toHaveLength(1);
    expect(retry[0]?.sku).toBe('HAT-2');
    expect(retry[0]?.operationId).toBe(items[1]?.operationId);
  });
});

describe('Phase 6B per SKU server outcomes', () => {
  it('applies each SKU once and a replay retry changes nothing twice', async () => {
    const { db, dispose } = await createTestDb();
    try {
      await seedProduct(db, { onHand: 5 });
      const payloads = [
        { sku: 'TEE-1', delta: 4, reason: 'restock', operationId: 'multi-a' },
        { sku: 'MISSING', delta: 1, reason: 'restock', operationId: 'multi-b' },
      ];
      const results = [];
      for (const payload of payloads) {
        results.push(
          await runAdminAction(
            db,
            {} as Cloudflare.Env,
            { id: 'owner', role: 'owner' },
            'stock.adjust',
            payload
          )
        );
      }
      expect(results[0]?.ok).toBe(true);
      expect(results[1]?.ok).toBe(false);
      const retry = await runAdminAction(
        db,
        {} as Cloudflare.Env,
        { id: 'owner', role: 'owner' },
        'stock.adjust',
        payloads[0]!
      );
      expect(retry.ok).toBe(true);
      const row = await db
        .prepare("SELECT on_hand FROM stock WHERE sku = 'TEE-1'")
        .first<{ on_hand: number }>();
      expect(row?.on_hand).toBe(9);
    } finally {
      await dispose();
    }
  });
});
