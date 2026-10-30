import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { present } from './helpers/fixtures';
import { runAdminAction } from '../web/src/server/admin-actions';

let db: D1Database, env: Env, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };

beforeEach(async () => {
  ({ db, env, dispose } = await createTestDb());
  await seedProduct(db);
  for (let i = 2; i <= 25; i++) {
    await db
      .prepare(
        "INSERT INTO variants(id,product_id,sku,title,price_cents,created_at) VALUES(?, 'p1', ?, ?, 1000, '2026')"
      )
      .bind(`v${i}`, `TEE-${i}`, `Size ${i}`)
      .run();
    await db
      .prepare("INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES(?, 5, 0, '2026')")
      .bind(`TEE-${i}`)
      .run();
  }
});
afterEach(async () => {
  await dispose();
});

async function firstVariantId(): Promise<string> {
  const row = await db
    .prepare("SELECT id FROM variants WHERE sku = 'TEE-1'")
    .first<{ id: string }>();
  return present(row, 'the TEE-1 variant').id;
}

describe('Phase 4C bulk variant pricing', () => {
  it('applies 25 price edits in one bounded action', async () => {
    const ids = (
      await db.prepare('SELECT id FROM variants ORDER BY sku').all<{ id: string }>()
    ).results.map((row) => row.id);
    expect(ids).toHaveLength(25);
    const result = await runAdminAction(db, env, owner, 'variant.bulkUpdate', {
      variantIds: ids,
      priceCents: 3000,
      stockDelta: 0,
    });
    expect(result.ok).toBe(true);
    const changed = await db
      .prepare('SELECT COUNT(*) AS n FROM variants WHERE price_cents = 3000')
      .first<{ n: number }>();
    expect(changed?.n).toBe(25);
  });

  it('applies nothing when one selected variant is unknown', async () => {
    const known = await firstVariantId();
    const result = await runAdminAction(db, env, owner, 'variant.bulkUpdate', {
      variantIds: [known, 'missing-variant'],
      priceCents: 3000,
      stockDelta: 0,
    });
    expect(result.ok).toBe(false);
    const row = await db
      .prepare('SELECT price_cents FROM variants WHERE id = ?')
      .bind(known)
      .first<{ price_cents: number }>();
    expect(row?.price_cents).not.toBe(3000);
  });

  it('rejects more than 50 variants', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `v${i}`);
    const result = await runAdminAction(db, env, owner, 'variant.bulkUpdate', {
      variantIds: ids,
      priceCents: 3000,
      stockDelta: 0,
    });
    expect(result.ok).toBe(false);
  });
});

describe('FF-20: price edits against a prepared shopper quote', () => {
  it('a bulk price edit after quoting rejects the stale submission and requotes at the new price', async () => {
    const { quoteOrder, createPendingOrder } = await import('../web/src/server/checkout');
    const { getSettings } = await import('../web/src/server/settings');
    const { pendingIntent } = await import('./helpers/pending-intent');
    const input = {
      email: 'ff20@example.invalid',
      lines: [{ sku: 'TEE-1', qty: 1 }],
      shippingRateId: 'test-rate',
      shippingCountry: 'US',
    };
    const settings = await getSettings(db);
    const quote = await quoteOrder(db, input, settings);
    const variantId = await firstVariantId();
    const edited = await runAdminAction(db, env, owner, 'variant.bulkUpdate', {
      variantIds: [variantId],
      priceCents: 4321,
      stockDelta: 0,
    });
    expect(edited.ok).toBe(true);
    // The prepared submission must not charge the old price or silently reprice.
    await expect(
      createPendingOrder(db, input, pendingIntent(), settings, quote)
    ).rejects.toMatchObject({ code: 'STALE_QUOTE' });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>())?.n).toBe(
      0
    );
    // A fresh quote reflects the authoritative D1 price.
    const fresh = await quoteOrder(db, input, await getSettings(db));
    expect(fresh.subtotalCents).toBe(4321);
  });
});
