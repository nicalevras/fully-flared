import { expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { handleCheckoutRequest } from '../web/src/routes/api/checkout';
import { ensureCart, setCartLine, getCartLines } from '../web/src/server/cart';
import { quoteOrder } from '../web/src/server/checkout';
import { runAdminAction } from '../web/src/server/admin-actions';
import { exactDevOrigins, runtimeConfigSchema } from '../web/src/server/env';
import { resolveAuthBaseUrl } from '../web/src/server/session';
import { operationalRecipients } from '../web/src/server/email';
import { at, withOverrides } from './helpers/fixtures';

it('missing Stripe configuration returns native HTTP 503 without changing a cart, order, reservation or stock', async () => {
  const { db, env, dispose } = await createTestDb();
  try {
    await seedProduct(db);
    const cart = await ensureCart(db, null);
    await setCartLine(db, cart.creds, 'TEE-1', 1);
    const response = await handleCheckoutRequest(
      new Request('http://localhost/api/checkout', { method: 'POST', body: '{}' }),
      env
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'DEPENDENCY' });
    expect(await getCartLines(db, cart.creds)).toEqual([{ sku: 'TEE-1', qty: 1 }]);
    for (const table of ['orders', 'reservations'])
      expect(
        (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n
      ).toBe(0);
    expect(
      await db.prepare("SELECT on_hand,reserved FROM stock WHERE sku='TEE-1'").first()
    ).toEqual({ on_hand: 5, reserved: 0 });
  } finally {
    await dispose();
  }
});
it('exact Tunnel origins are accepted and arbitrary hosts and wildcard origins are refused', () => {
  const allowed = exactDevOrigins('http://localhost:8799,https://exact-tunnel.trycloudflare.com');
  expect(resolveAuthBaseUrl(undefined, new Request(at(allowed, 1)), allowed)).toBe(allowed[1]);
  expect(() =>
    resolveAuthBaseUrl(undefined, new Request('https://untrusted.test'), allowed)
  ).toThrow();
  expect(() => exactDevOrigins('https://*.trycloudflare.com')).toThrow();
  expect(() => runtimeConfigSchema.parse({ BETTER_AUTH_SECRET: 'short' })).toThrow();
});
it('failed media deletion preserves its database record and returns a generic error', async () => {
  const { db, env, dispose } = await createTestDb();
  try {
    await db
      .prepare(
        "INSERT INTO media(id,r2_key,filename,content_type,created_at) VALUES('failed-media','media/unique-key.webp','test.webp','image/webp','2026-10-18')"
      )
      .run();
    const result = await runAdminAction(
      db,
      withOverrides(env, {
        MEDIA: withOverrides(env.MEDIA, {
          async delete() {
            throw new Error('secret internal R2 error');
          },
        }),
      }),
      { id: 'owner', role: 'owner' },
      'media.delete',
      { mediaId: 'failed-media' }
    );
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(JSON.stringify(result)).not.toContain('secret internal');
    expect(await db.prepare("SELECT id FROM media WHERE id='failed-media'").first()).not.toBeNull();
  } finally {
    await dispose();
  }
});
it('operational alerts fall back to verified owners and never the sender address', async () => {
  const { db, dispose } = await createTestDb();
  try {
    await db
      .prepare(
        "INSERT INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES('owner-alert','Owner','verified@example.test',1,'owner',0,0)"
      )
      .run();
    await db
      .prepare(
        "INSERT INTO settings VALUES('email_from_address','sender@example.test','2026-10-18')"
      )
      .run();
    expect(await operationalRecipients(db)).toEqual(['verified@example.test']);
  } finally {
    await dispose();
  }
});
it('distinct-line and aggregate-quantity boundaries are checked before database lookup', async () => {
  const { db, dispose } = await createTestDb();
  try {
    await expect(
      quoteOrder(db, {
        email: 'limit@test.com',
        lines: Array.from({ length: 51 }, (_, i) => ({ sku: String(i), qty: 1 })),
      })
    ).rejects.toThrow('Too many lines');
    await expect(
      quoteOrder(db, {
        email: 'limit@test.com',
        lines: [
          { sku: 'X', qty: 50 },
          { sku: 'X', qty: 50 },
        ],
      })
    ).rejects.toThrow('Too many units');
    const cart = await ensureCart(db, null);
    for (let i = 0; i < 50; i++)
      await db
        .prepare('INSERT INTO cart_items VALUES(?,?,?,?,?)')
        .bind(`line-${i}`, cart.creds.id, `SKU-${i}`, 1, 100)
        .run();
    await expect(
      db
        .prepare('INSERT INTO cart_items VALUES(?,?,?,?,?)')
        .bind('line-51', cart.creds.id, 'SKU-51', 1, 100)
        .run()
    ).rejects.toThrow(/limit/);
  } finally {
    await dispose();
  }
});
