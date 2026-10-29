import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { sha256Hex } from '../lib/hash';
import type { MediaSource } from '../lib/media-url';
import { getSettings } from './settings';
import { StoreLimitError } from '../lib/settings-definitions';
import {
  cartItems,
  carts,
  products as productsT,
  shippingRates,
  shippingZones,
  stock as stockT,
  variants as variantsT,
} from '../db/schema';

// Server cart (Phase 6 / plan Step 5): the cart lives in D1 (`carts` +
// `cart_items`) and the browser holds only a capability cookie,
// `<cartId>.<token>`. The token is stored as a SHA-256 hash, so a database
// leak does not hand out writable carts. Loaders read the cookie and return
// priced lines, so the first render already shows the real cart — no
// localStorage flash, no $0.00 SKUs.
export type CartLine = { sku: string; qty: number };
export type PricedLine = CartLine & {
  weightGrams: number | null;
  continueSelling: boolean;
  priceCents: number;
  productTitle: string;
  available: number;
  cover: MediaSource | null;
};
export type CartCreds = { id: string; token: string };

export const CART_COOKIE = 'cart';
const CART_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hashToken = sha256Hex;

export function parseCartCookie(cookieHeader: string | null): CartCreds | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== CART_COOKIE) continue;
    let value: string;
    try {
      value = decodeURIComponent(rest.join('='));
    } catch {
      // A malformed cookie is treated as no cart: the shopper starts
      // fresh instead of every cart and checkout call throwing.
      return null;
    }
    const dot = value.indexOf('.');
    if (dot <= 0 || dot === value.length - 1) return null;
    return { id: value.slice(0, dot), token: value.slice(dot + 1) };
  }
  return null;
}

export function cartCookieHeader(creds: CartCreds): string {
  const value = encodeURIComponent(`${creds.id}.${creds.token}`);
  return `${CART_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(CART_TTL_MS / 1000)}`;
}

export const clearCartCookieHeader = `${CART_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export const CART_COUNT_COOKIE = 'cart_count';

export function cartCountCookieHeader(count: number): string {
  return `${CART_COUNT_COOKIE}=${Math.max(0, Math.floor(count))}; Path=/; SameSite=Lax; Max-Age=${Math.floor(CART_TTL_MS / 1000)}`;
}

export { cartCountFromCookie } from '../lib/cart-cookie';

async function validCart(db: D1Database, creds: CartCreds): Promise<boolean> {
  const row = await getDb(db).query.carts.findFirst({ where: eq(carts.id, creds.id) });
  if (!row || row.status !== 'open') return false;
  if (new Date(row.expiresAt).getTime() <= Date.now()) return false;
  return row.tokenHash === (await hashToken(creds.token));
}

/** Public cart identity is safe to expose; the write capability stays HttpOnly. */
export async function cartIdentity(db: D1Database, creds: CartCreds | null) {
  if (!creds) return null;
  const row = await db
    .prepare('SELECT revision,token_hash,status,expires_at FROM carts WHERE id=?')
    .bind(creds.id)
    .first<{ revision: number; token_hash: string; status: string; expires_at: string }>();
  if (
    !row ||
    row.expires_at <= new Date().toISOString() ||
    row.token_hash !== (await hashToken(creds.token))
  )
    return null;
  return { id: creds.id, revision: row.revision, status: row.status };
}

export async function getCartLines(db: D1Database, creds: CartCreds | null): Promise<CartLine[]> {
  if (!creds || !(await validCart(db, creds))) return [];
  const rows = await getDb(db)
    .select({ sku: cartItems.sku, qty: cartItems.qty })
    .from(cartItems)
    .where(eq(cartItems.cartId, creds.id))
    .orderBy(sql`rowid`);
  return rows;
}

export async function ensureCart(
  db: D1Database,
  creds: CartCreds | null
): Promise<{ creds: CartCreds; created: boolean }> {
  if (creds && (await validCart(db, creds))) return { creds, created: false };
  const fresh: CartCreds = { id: crypto.randomUUID(), token: crypto.randomUUID() };
  const now = new Date();
  await getDb(db)
    .insert(carts)
    .values({
      id: fresh.id,
      tokenHash: await hashToken(fresh.token),
      status: 'open',
      expiresAt: new Date(now.getTime() + CART_TTL_MS).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  return { creds: fresh, created: true };
}

export class CartConflictError extends Error {
  constructor() {
    super('Your cart changed. Reload it and try again.');
    this.name = 'CartConflictError';
  }
}

/** Set one line's absolute quantity (0 removes it). Creates the cart first
 *  when the cookie is missing or no longer valid. */
export async function setCartLine(
  db: D1Database,
  creds: CartCreds | null,
  sku: string,
  qty: number
): Promise<{ creds: CartCreds; created: boolean; lines: CartLine[] }> {
  const ensured = await ensureCart(db, creds);
  const cart = ensured.creds;
  if (!Number.isSafeInteger(qty) || qty < 0) throw new StoreLimitError('Invalid quantity');
  const { limits } = await getSettings(db);
  const existing = await getCartLines(db, cart);
  const prior = existing.find((line) => line.sku === sku)?.qty ?? 0;
  if (qty > limits.cart_max_qty && qty > prior)
    throw new StoreLimitError(`Quantity is limited to ${limits.cart_max_qty}`);
  const clamped = qty;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        "INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM carts WHERE id=? AND status='open' AND expires_at>?)"
      )
      .bind(cart.id, now),
  ];
  if (clamped === 0) {
    statements.push(
      db.prepare('DELETE FROM cart_items WHERE cart_id=? AND sku=?').bind(cart.id, sku)
    );
  } else {
    if (!existing.some((l) => l.sku === sku) && existing.length >= limits.cart_max_lines) {
      throw new StoreLimitError(`Cart is limited to ${limits.cart_max_lines} lines`);
    }
    const variant = await db
      .prepare(
        "SELECT v.price_cents AS priceCents FROM variants v JOIN products p ON p.id=v.product_id WHERE v.sku=? AND v.status='active' AND p.status='active'"
      )
      .bind(sku)
      .first<{ priceCents: number }>();
    if (!variant) throw new Error('Item is no longer available');
    statements.push(
      db
        .prepare(
          'INSERT INTO cart_items(id,cart_id,sku,qty,unit_price_cents) VALUES(?,?,?,?,?) ON CONFLICT(cart_id,sku) DO UPDATE SET qty=excluded.qty,unit_price_cents=excluded.unit_price_cents'
        )
        .bind(crypto.randomUUID(), cart.id, sku, clamped, variant.priceCents)
    );
  }
  statements.push(db.prepare('UPDATE carts SET updated_at=? WHERE id=?').bind(now, cart.id));
  try {
    await db.batch(statements);
  } catch (error) {
    const current = await cartIdentity(db, cart);
    if (!current || current.status !== 'open') throw new CartConflictError();
    throw error;
  }
  return { creds: cart, created: ensured.created, lines: await getCartLines(db, cart) };
}

export async function addCartLine(
  db: D1Database,
  creds: CartCreds | null,
  sku: string,
  qty: number
): Promise<{ creds: CartCreds; created: boolean; lines: CartLine[] }> {
  const ensured = await ensureCart(db, creds);
  if (!Number.isSafeInteger(qty) || qty < 1) throw new StoreLimitError('Invalid quantity');
  let result;
  try {
    result = await db.batch([
      db
        .prepare(
          `INSERT INTO cart_items(id,cart_id,sku,qty,unit_price_cents)
        SELECT ?,?,v.sku,?,v.price_cents FROM variants v JOIN products p ON p.id=v.product_id
        WHERE v.sku=? AND v.status='active' AND p.status='active' AND EXISTS(SELECT 1 FROM carts WHERE id=? AND status='open' AND expires_at>?)
        ON CONFLICT(cart_id,sku) DO UPDATE SET qty=cart_items.qty+excluded.qty,unit_price_cents=excluded.unit_price_cents`
        )
        .bind(
          crypto.randomUUID(),
          ensured.creds.id,
          qty,
          sku,
          ensured.creds.id,
          new Date().toISOString()
        ),
      db
        .prepare('UPDATE carts SET updated_at=? WHERE id=? AND changes()>0')
        .bind(new Date().toISOString(), ensured.creds.id),
    ]);
  } catch (error) {
    if (error instanceof Error && /cart .*limit/.test(error.message))
      throw new StoreLimitError('Cart line or quantity limit exceeded');
    throw error;
  }
  if (!result[0]?.meta.changes) throw new Error('Item is no longer available');
  return { ...ensured, lines: await getCartLines(db, ensured.creds) };
}

export async function clearCart(db: D1Database, creds: CartCreds | null): Promise<void> {
  if (!creds || !(await validCart(db, creds))) return;
  const d = getDb(db);
  await d.batch([
    d.delete(cartItems).where(eq(cartItems.cartId, creds.id)),
    d
      .update(carts)
      .set({ status: 'converted', updatedAt: new Date().toISOString() })
      .where(eq(carts.id, creds.id)),
  ]);
}

export async function priceCartLines(db: D1Database, lines: CartLine[]): Promise<PricedLine[]> {
  if (lines.length === 0) return [];
  const rows = [];
  // Two status parameters share D1's per-statement parameter budget with SKUs.
  for (let offset = 0; offset < lines.length; offset += 90)
    rows.push(
      ...(await getDb(db)
        .select({
          sku: variantsT.sku,
          priceCents: variantsT.priceCents,
          weightGrams: variantsT.weightGrams,
          continueSelling: variantsT.continueSelling,
          productTitle: productsT.title,
          available: sql<number>`COALESCE(${stockT.onHand} - ${stockT.reserved}, 0)`,
          coverKey: sql<
            string | null
          >`(SELECT m.r2_key FROM product_media pm JOIN media m ON m.id=pm.media_id WHERE pm.product_id=${productsT.id} AND m.ready=1 AND m.deletion_pending=0 ORDER BY pm.position, pm.media_id LIMIT 1)`,
          coverPublicUrl: sql<
            string | null
          >`(SELECT m.public_url FROM product_media pm JOIN media m ON m.id=pm.media_id WHERE pm.product_id=${productsT.id} AND m.ready=1 AND m.deletion_pending=0 ORDER BY pm.position, pm.media_id LIMIT 1)`,
          coverVariantsJson: sql<
            string | null
          >`(SELECT json_group_array(json_object('width',v.width,'url',COALESCE(v.public_url,'/media/'||m.r2_key||'?w='||v.width))) FROM media_variants v JOIN media m ON m.id=v.media_id WHERE v.ready=1 AND m.ready=1 AND m.deletion_pending=0 AND m.id=(SELECT media_id FROM product_media WHERE product_id=${productsT.id} ORDER BY position, media_id LIMIT 1) ORDER BY v.width)`,
        })
        .from(variantsT)
        .innerJoin(productsT, eq(productsT.id, variantsT.productId))
        .leftJoin(stockT, eq(stockT.sku, variantsT.sku))
        .where(
          and(
            inArray(
              variantsT.sku,
              lines.slice(offset, offset + 90).map((l) => l.sku)
            ),
            eq(variantsT.status, 'active'),
            eq(productsT.status, 'active')
          )
        ))
    );
  const bySku = new Map(rows.map((r) => [r.sku, r]));
  return lines.flatMap((l) => {
    const priced = bySku.get(l.sku);
    if (!priced) return [];
    const { coverKey, coverPublicUrl, coverVariantsJson, ...rest } = priced;
    let variants: MediaSource['variants'] = [];
    try {
      const parsed: unknown = coverVariantsJson ? JSON.parse(coverVariantsJson) : [];
      if (Array.isArray(parsed))
        variants = parsed.filter(
          (v): v is { width: number; url: string } =>
            typeof v === 'object' &&
            v !== null &&
            typeof (v as { width?: unknown }).width === 'number' &&
            typeof (v as { url?: unknown }).url === 'string'
        );
    } catch {
      variants = [];
    }
    return [
      {
        ...l,
        ...rest,
        cover: coverKey ? { key: coverKey, publicUrl: coverPublicUrl ?? null, variants } : null,
      },
    ];
  });
}

export type ShippingZoneView = {
  id: string;
  name: string;
  countries: string[];
  rates: Array<{
    id: string;
    name: string;
    kind: string;
    amountCents: number;
    freeOverCents: number | null;
    perKgCents: number | null;
  }>;
};

export async function getShippingZones(db: D1Database): Promise<ShippingZoneView[]> {
  const d = getDb(db);
  const [zones, rates] = await Promise.all([
    d
      .select({
        id: shippingZones.id,
        name: shippingZones.name,
        countriesJson: shippingZones.countriesJson,
      })
      .from(shippingZones)
      .orderBy(asc(shippingZones.name)),
    d
      .select({
        id: shippingRates.id,
        zoneId: shippingRates.zoneId,
        name: shippingRates.name,
        kind: shippingRates.kind,
        amountCents: shippingRates.amountCents,
        freeOverCents: shippingRates.freeOverCents,
        perKgCents: shippingRates.perKgCents,
      })
      .from(shippingRates)
      .orderBy(asc(shippingRates.amountCents)),
  ]);
  return zones.map((z) => {
    let countries: string[] = [];
    try {
      countries = JSON.parse(z.countriesJson) as string[];
    } catch {
      countries = [];
    }
    return { id: z.id, name: z.name, countries, rates: rates.filter((r) => r.zoneId === z.id) };
  });
}
