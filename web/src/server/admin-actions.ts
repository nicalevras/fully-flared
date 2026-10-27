import { requestRefund } from './refunds';
import { adjustStock } from './inventory';
import { canonicalizeMediaUrls, mediaKeysInContent, mediaRawSpellings } from './media';
import { parseCsv } from './csv';
import { getStripeProvider } from './payments';
import { getSettings, setSetting } from './settings';
import { emailStatement, commitWithEmails, enqueueJob } from './email';
import { broadcastAdminRealtime } from './realtime';
import { escapeHtml, plainTextFromHtml, sanitizeHtml } from './sanitize';
import { adminActionSchema, csvProductRowSchema } from '../schemas/admin';
import { z } from 'zod';
import { settingKeySchema, validateSetting } from '../schemas/settings';
import { zodIssues } from '../schemas/common';
import { ACTION_PERMISSIONS, roles, type StaffRole } from '../lib/permissions';
import type { Auth } from '../lib/auth';

export const CSV_IMPORT_MAX_ROWS = 1000;
import { AccountDeletionError, deleteAccountAtomically } from './account-deletion';
import { exportCustomerData } from './account';
import { deleteMediaObjects, publicMediaEnvironment } from './media-delivery';
import { SHIPPABLE_ORDER_STATUSES, SHIPPABLE_PAYMENT_STATUSES } from '../lib/order-actions';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function auditStmt(
  db: D1Database,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  details?: unknown
) {
  return db
    .prepare(
      'INSERT INTO audit_log (id, actor_user_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      id(),
      actorId,
      action,
      entityType,
      entityId,
      details ? JSON.stringify(details) : null,
      now()
    );
}

async function audit(
  db: D1Database,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  details?: unknown
) {
  await auditStmt(db, actorId, action, entityType, entityId, details).run();
}

export type AdminActionResult =
  | { ok: true; data?: z.infer<ReturnType<typeof z.json>> }
  | { ok: false; error: string; status?: number; conflict?: boolean };

/** Refund an order (full remaining balance by default). Cumulative:
 *  refunds are tracked against the order total and can never exceed the
 *  un-refunded remainder. The Stripe call is keyed on the local refund row
 *  id, so two partial refunds of the same amount stay distinct and a retry
 *  of one row cannot double-refund. Restock (full refunds only) writes
 *  ledger rows via adjustStock. */
export async function refundOrder(
  db: D1Database,
  env: Cloudflare.Env,
  orderId: string,
  amountCents?: number,
  restock = false,
  requestId: string = crypto.randomUUID(),
  returnId?: string
) {
  const existing = await db
    .prepare('SELECT id FROM refunds WHERE request_id=? AND order_id=?')
    .bind(requestId, orderId)
    .first();
  if (existing)
    return requestRefund(db, getStripeProvider(env) ?? undefined, {
      orderId,
      amountCents,
      restock,
      requestId,
      purpose: returnId ? 'return' : 'staff',
      ...(returnId ? { returnId } : {}),
    });
  const order = await db
    .prepare('SELECT payment_status FROM orders WHERE id=?')
    .bind(orderId)
    .first<{ payment_status: string }>();
  if (!order || !['paid', 'partially_refunded'].includes(order.payment_status))
    return { ok: false as const, error: 'Only a paid order can be refunded' };
  const provider = getStripeProvider(env);
  if (!provider) return { ok: false as const, error: 'Payment provider unavailable', status: 503 };
  try {
    return await requestRefund(db, provider, {
      orderId,
      amountCents,
      restock,
      requestId,
      purpose: returnId ? 'return' : 'staff',
      ...(returnId ? { returnId } : {}),
    });
  } catch (error) {
    if (error instanceof Error && /balance|refund exceeds/.test(error.message))
      return { ok: false as const, error: 'Refund exceeds remaining balance' };
    throw error;
  }
}

function chunkStrings(values: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

/** Origins whose absolute /media/ URLs count as local references: the
 * configured canonical origin plus the origin of the current request. */
async function acceptedMediaOrigins(db: D1Database, requestOrigin?: string): Promise<string[]> {
  const settings = await getSettings(db);
  return [
    ...new Set(
      [
        originOf(settings.canonicalBaseUrl),
        originOf(settings.mediaPublicBaseUrl),
        requestOrigin ?? '',
      ].filter(Boolean)
    ),
  ];
}

type MediaSaveTarget = {
  table: 'posts' | 'pages';
  rowId: string;
  keys: string[];
  coverMediaId?: string | undefined;
  /** Raw (e.g. percent-encoded) spellings of submitted keys found in
   * the stored content, as extra grandfathering search patterns. */
  spellings?: Map<string, string[]>;
};

/** Guard statements for a content save, run in the same batch before the
 * upsert: pending references abort (all submitted keys), and references
 * with no media row abort unless already present in the stored content
 * (HTML and JSON), evaluated against database state at batch time.
 * Key lists are chunked to stay below D1's parameter limit. */
function mediaSaveGuards(db: D1Database, target: MediaSaveTarget): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const keys of chunkStrings(target.keys, 50))
    statements.push(
      db
        .prepare(
          `INSERT INTO batch_guard SELECT 1 WHERE EXISTS(SELECT 1 FROM media WHERE (deletion_pending = 1 OR ready=0) AND r2_key IN (${keys.map(() => '?').join(',')}))`
        )
        .bind(...keys)
    );
  if (target.coverMediaId)
    statements.push(
      db
        .prepare(
          `INSERT INTO batch_guard SELECT 1 WHERE EXISTS(SELECT 1 FROM media WHERE id = ? AND (deletion_pending = 1 OR ready=0))
           OR (NOT EXISTS(SELECT 1 FROM media WHERE id = ?) AND COALESCE((SELECT cover_media_id FROM posts WHERE id = ?), '') != ?)`
        )
        .bind(target.coverMediaId, target.coverMediaId, target.rowId, target.coverMediaId)
    );
  // Missing-reference guard: abort iff a key has no media row AND no
  // stored spelling of it remains (plain form or any legacy spelling).
  // Spellings bind as one JSON array per key via json_each, so a key's
  // cost is constant (posts 4 binds, pages 3) however many spellings it
  // has. Keys are chunked by accumulated parameter count — CTE binds
  // included (posts 2, pages 1) — against a 90-bind budget.
  const cte =
    target.table === 'posts'
      ? `WITH s AS (SELECT COALESCE((SELECT content_html FROM posts WHERE id = ?), '') AS h, COALESCE((SELECT content_json FROM posts WHERE id = ?), '') AS j)`
      : `WITH s AS (SELECT COALESCE((SELECT content_html FROM pages WHERE id = ?), '') AS h, '' AS j)`;
  const cteBinds = target.table === 'posts' ? 2 : 1;
  const perKeyBinds = target.table === 'posts' ? 4 : 3;
  const keyCondition =
    target.table === 'posts'
      ? `(NOT EXISTS(SELECT 1 FROM media WHERE r2_key = ?)
          AND instr(REPLACE(s.h, '\\/', '/'), '/media/' || ?) = 0
          AND instr(REPLACE(s.j, '\\/', '/'), '/media/' || ?) = 0
          AND NOT EXISTS(SELECT 1 FROM json_each(?) WHERE instr(REPLACE(s.h, '\\/', '/'), value) > 0 OR instr(REPLACE(s.j, '\\/', '/'), value) > 0))`
      : `(NOT EXISTS(SELECT 1 FROM media WHERE r2_key = ?)
          AND instr(REPLACE(s.h, '\\/', '/'), '/media/' || ?) = 0
          AND NOT EXISTS(SELECT 1 FROM json_each(?) WHERE instr(REPLACE(s.h, '\\/', '/'), value) > 0))`;
  let chunk: string[] = [];
  let chunkBinds = cteBinds;
  const flush = () => {
    if (chunk.length === 0) return;
    const binds: string[] = [target.rowId, ...(target.table === 'posts' ? [target.rowId] : [])];
    for (const key of chunk) {
      binds.push(key, key);
      if (target.table === 'posts') binds.push(key);
      binds.push(JSON.stringify(target.spellings?.get(key) ?? []));
    }
    statements.push(
      db
        .prepare(
          `${cte} INSERT INTO batch_guard SELECT 1 FROM s WHERE ${chunk.map(() => keyCondition).join(' OR ')}`
        )
        .bind(...binds)
    );
    chunk = [];
    chunkBinds = cteBinds;
  };
  for (const key of target.keys) {
    if (chunk.length > 0 && chunkBinds + perKeyBinds > 90) flush();
    chunk.push(key);
    chunkBinds += perKeyBinds;
  }
  flush();
  return statements;
}

/** After a guarded save batch fails, classify it: pending reference,
 * newly broken reference, or neither (rethrown by the caller). Runs after
 * the rollback, so stored content still reflects pre-save state. */
async function mediaSaveFailure(
  db: D1Database,
  target: MediaSaveTarget,
  origins: string[]
): Promise<{ ok: false; error: string; status: 409 } | null> {
  for (const keys of chunkStrings(target.keys, 50)) {
    const pending = await db
      .prepare(
        `SELECT r2_key FROM media WHERE (deletion_pending = 1 OR ready=0) AND r2_key IN (${keys.map(() => '?').join(',')}) LIMIT 1`
      )
      .bind(...keys)
      .first();
    if (pending)
      return {
        ok: false,
        error:
          'One of the images is incomplete or being deleted. Remove it or finish its upload first.',
        status: 409,
      };
  }
  if (target.coverMediaId) {
    const cover = await db
      .prepare('SELECT deletion_pending,ready FROM media WHERE id = ?')
      .bind(target.coverMediaId)
      .first<{ deletion_pending: number; ready: number }>();
    if (cover && (cover.deletion_pending || !cover.ready))
      return {
        ok: false,
        error: 'One of the images is being deleted; remove it or wait for deletion to finish.',
        status: 409,
      };
    if (!cover) {
      const stored = await db
        .prepare('SELECT cover_media_id FROM posts WHERE id = ?')
        .bind(target.rowId)
        .first<{ cover_media_id: string | null }>();
      if (stored?.cover_media_id !== target.coverMediaId)
        return { ok: false, error: 'The cover image no longer exists.', status: 409 };
    }
  }
  const storedRow = await db
    .prepare(
      target.table === 'posts'
        ? 'SELECT content_html, content_json FROM posts WHERE id = ?'
        : 'SELECT content_html, NULL AS content_json FROM pages WHERE id = ?'
    )
    .bind(target.rowId)
    .first<{ content_html: string | null; content_json: string | null }>();
  const storedKeys = new Set([
    ...mediaKeysInContent(storedRow?.content_html, origins),
    ...mediaKeysInContent(storedRow?.content_json, origins),
  ]);
  const candidates = target.keys.filter((key) => !storedKeys.has(key));
  for (const keys of chunkStrings(candidates, 50)) {
    const found = await db
      .prepare(`SELECT r2_key FROM media WHERE r2_key IN (${keys.map(() => '?').join(',')})`)
      .bind(...keys)
      .all<{ r2_key: string }>();
    const foundKeys = new Set(found.results.map((row) => row.r2_key));
    if (keys.some((key) => !foundKeys.has(key)))
      return {
        ok: false,
        error: 'One of the images no longer exists; remove the reference before saving.',
        status: 409,
      };
  }
  return null;
}

export async function runAdminAction(
  db: D1Database,
  env: Cloudflare.Env,
  actor: { id: string; role: string },
  action: string,
  payload: Record<string, unknown>,
  authContext?: { auth: Auth; headers: Headers },
  requestOrigin?: string
): Promise<AdminActionResult> {
  const parsedAction = adminActionSchema.safeParse({ ...payload, action });
  if (!parsedAction.success)
    return { ok: false, error: 'Invalid input: ' + zodIssues(parsedAction.error), status: 400 };

  const permission = ACTION_PERMISSIONS[parsedAction.data.action];
  if (!permission) return { ok: false, error: `Unknown action ${action}`, status: 400 };
  let allowed = false;
  if (authContext) {
    const result = await authContext.auth.api.userHasPermission({
      body: {
        userId: actor.id,
        role: actor.role as StaffRole,
        permissions: { [permission.resource]: [permission.action] },
      },
    });
    allowed = result.success;
  } else {
    const role = roles[actor.role as keyof typeof roles];
    allowed = Boolean(role?.authorize({ [permission.resource]: [permission.action] }).success);
  }
  if (!allowed) {
    return { ok: false, error: `Your role (${actor.role}) cannot perform ${action}`, status: 403 };
  }

  const extraPermissions = [];
  if ('restock' in parsedAction.data && parsedAction.data.restock)
    extraPermissions.push({ resource: 'stock', action: 'adjust' });
  for (const required of extraPermissions) {
    const granted = authContext
      ? (
          await authContext.auth.api.userHasPermission({
            body: {
              userId: actor.id,
              role: actor.role as StaffRole,
              permissions: { [required.resource]: [required.action] },
            },
          })
        ).success
      : roles[actor.role as StaffRole]?.authorize({ [required.resource]: [required.action] })
          .success;
    if (!granted)
      return {
        ok: false,
        error: `Your role cannot perform ${required.resource}.${required.action}`,
        status: 403,
      };
  }

  try {
    switch (parsedAction.data.action) {
      case 'product.create': {
        const f = parsedAction.data;
        const dupeSlug = await db
          .prepare('SELECT id FROM products WHERE slug = ?')
          .bind(f.slug)
          .first();
        if (dupeSlug) return { ok: false, error: `A product with slug ${f.slug} already exists` };
        for (const v of f.variants) {
          const dupeSku = await db
            .prepare('SELECT sku FROM variants WHERE sku = ?')
            .bind(v.sku)
            .first();
          if (dupeSku) return { ok: false, error: `SKU ${v.sku} is already in use` };
        }
        const productId = id();
        await db.batch([
          db
            .prepare(
              `INSERT INTO products (id, slug, title, description, status, seo_title, seo_description, tax_code, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              productId,
              f.slug,
              f.title,
              f.description,
              f.status || 'draft',
              f.seoTitle || null,
              f.seoDescription || null,
              f.taxCode || null,
              now(),
              now()
            ),
          ...(f.variants ?? []).flatMap((v) => [
            db
              .prepare(
                `INSERT INTO variants (id, product_id, sku, title, price_cents, continue_selling, weight_grams, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(
                id(),
                productId,
                v.sku,
                v.title,
                v.priceCents,
                v.continueSelling ? 1 : 0,
                v.weightGrams,
                now()
              ),
            db
              .prepare(
                `INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(sku) DO UPDATE SET on_hand = stock.on_hand + excluded.on_hand`
              )
              .bind(v.sku, v.stock ?? 0, now()),
            db
              .prepare(
                `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, ref_type, ref_id, created_at)
               VALUES (?, ?, ?, 0, 'restock', 'product', ?, ?)`
              )
              .bind(id(), v.sku, v.stock ?? 0, productId, now()),
          ]),
          db
            .prepare(
              'INSERT INTO audit_log (id, actor_user_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            )
            .bind(
              id(),
              actor.id,
              'product.create',
              'product',
              productId,
              JSON.stringify({ slug: f.slug }),
              now()
            ),
        ]);
        return { ok: true, data: { productId } };
      }
      case 'stock.adjust': {
        const f = parsedAction.data;
        await adjustStock(db, f.sku, f.delta, (f.reason as 'restock') || 'restock');
        await audit(db, actor.id, 'stock.adjust', 'stock', f.sku, { delta: f.delta });
        await broadcastAdminRealtime('inventory.updated', { sku: f.sku as string });
        return { ok: true };
      }
      case 'discount.create': {
        const f = parsedAction.data;
        const existing = await db
          .prepare('SELECT id FROM discounts WHERE code = ?')
          .bind(f.code.toUpperCase())
          .first();
        if (existing)
          return { ok: false, error: `A discount code ${f.code.toUpperCase()} already exists` };
        const discountId = id();
        await db
          .prepare(
            `INSERT INTO discounts (id, code, type, value, status, min_purchase_cents, usage_limit, starts_at, expires_at, created_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
          )
          .bind(
            discountId,
            f.code.toUpperCase(),
            f.type || 'percentage',
            f.value,
            f.minPurchaseCents,
            f.usageLimit ?? null,
            f.startsAt || null,
            f.expiresAt || null,
            now()
          )
          .run();
        await audit(db, actor.id, 'discount.create', 'discount', discountId);
        return { ok: true, data: { discountId } };
      }
      case 'discount.toggle': {
        const f = parsedAction.data;
        await db
          .prepare('UPDATE discounts SET status = ? WHERE id = ?')
          .bind(f.active ? 'active' : 'inactive', f.discountId)
          .run();
        await audit(db, actor.id, 'discount.toggle', 'discount', f.discountId, {
          active: Boolean(f.active),
        });
        return { ok: true };
      }
      case 'shipping.createZone': {
        const f = parsedAction.data;
        const zoneId = id();
        await db
          .prepare(
            'INSERT INTO shipping_zones (id, name, countries_json, created_at) VALUES (?, ?, ?, ?)'
          )
          .bind(zoneId, f.name, JSON.stringify(f.countries ?? []), now())
          .run();
        await audit(db, actor.id, 'shipping.createZone', 'shipping_zone', zoneId);
        return { ok: true, data: { zoneId } };
      }
      case 'shipping.addRate': {
        const f = parsedAction.data;
        const rateId = id();
        const freeOver = f.freeOverCents ?? null;
        await db
          .prepare(
            'INSERT INTO shipping_rates (id, zone_id, name, kind, amount_cents, free_over_cents, per_kg_cents) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(
            rateId,
            f.zoneId,
            f.name,
            f.kind ?? (freeOver != null ? 'free_over' : 'flat'),
            f.rateCents,
            freeOver,
            f.perKgCents ?? null
          )
          .run();
        await audit(db, actor.id, 'shipping.addRate', 'shipping_rate', rateId);
        return { ok: true, data: { rateId } };
      }
      case 'order.ship': {
        const f = parsedAction.data;
        const transition = id();
        const shippedOrder = await db
          .prepare('SELECT number,customer_email FROM orders WHERE id=?')
          .bind(f.orderId)
          .first<{ number: string; customer_email: string }>();
        if (!shippedOrder) return { ok: false, error: 'Order not found', status: 404 };
        const results = await commitWithEmails(
          db,
          [
            db
              .prepare(
                `UPDATE orders SET status='shipped',tracking_number=?,tracking_url=?,shipped_at=?,updated_at=?,transition_id=? WHERE id=? AND restocked_at IS NULL AND status IN (${SHIPPABLE_ORDER_STATUSES.map((s) => `'${s}'`).join(',')}) AND payment_status IN (${SHIPPABLE_PAYMENT_STATUSES.map((s) => `'${s}'`).join(',')})`
              )
              .bind(f.trackingNumber, f.trackingUrl || null, now(), now(), transition, f.orderId),
            emailStatement(
              db,
              `shipment-${f.orderId}`,
              {
                to: shippedOrder.customer_email,
                subject: `Order ${shippedOrder.number} has shipped`,
                text: `Order ${shippedOrder.number} is on its way. Track it from your account.`,
                html: `<p>Order <strong>${escapeHtml(shippedOrder.number)}</strong> is on its way. Track it from your account.</p>`,
              },
              {
                sql: 'EXISTS(SELECT 1 FROM orders WHERE id=? AND transition_id=?)',
                values: [f.orderId, transition],
              }
            ),
          ],
          [`shipment-${f.orderId}`]
        );
        if (!results[0]?.meta.changes)
          return { ok: false, error: 'Only a paid, undisputed order can be shipped', status: 409 };
        await audit(db, actor.id, 'order.ship', 'order', f.orderId);
        return { ok: true };
      }
      case 'order.refund': {
        const f = parsedAction.data;
        const openReturn = await db
          .prepare(
            "SELECT id FROM returns WHERE order_id=? AND status IN ('requested','approved','refund_failed') LIMIT 1"
          )
          .bind(f.orderId)
          .first();
        if (openReturn)
          return {
            ok: false,
            error: 'This order has an open return. Refund it from the return.',
            status: 409,
          };
        const result = await refundOrder(
          db,
          env,
          f.orderId,
          f.amountCents,
          Boolean(f.restock),
          f.requestId
        );
        if (!result.ok) return result;
        await audit(db, actor.id, 'order.refund', 'order', f.orderId, {
          amount: result.amount,
          restock: Boolean(f.restock),
        });
        await broadcastAdminRealtime('order.refunded', { orderId: f.orderId as string });
        return {
          ok: true,
          data: {
            stripeRefundId: result.stripeRefundId,
            refundStatus: result.status,
            amountCents: result.amount,
          },
        };
      }
      case 'return.approve': {
        const f = parsedAction.data;
        const result = await db
          .prepare("UPDATE returns SET status='approved' WHERE id=? AND status='requested'")
          .bind(f.returnId)
          .run();
        if (!result.meta.changes)
          return { ok: false, error: 'Return already decided', status: 409 };
        await audit(db, actor.id, 'return.approve', 'return', f.returnId);
        return { ok: true, data: { refundStatus: null, amountCents: 0 } };
      }
      case 'return.refund': {
        const f = parsedAction.data;
        const ret = await db
          .prepare('SELECT r.id, r.order_id, r.status FROM returns r WHERE r.id = ?')
          .bind(f.returnId)
          .first<{ id: string; order_id: string; status: string }>();
        if (!ret) return { ok: false, error: 'Return not found' };
        if (ret.status !== 'approved' && ret.status !== 'refund_failed')
          return { ok: false, error: 'Return is not approved', status: 409 };
        const live = await db
          .prepare(
            "SELECT COUNT(*) AS n FROM refunds WHERE return_id=? AND status NOT IN ('failed','canceled')"
          )
          .bind(ret.id)
          .first<{ n: number }>();
        if ((live?.n ?? 0) > 0)
          return {
            ok: false,
            error: 'Return refund already in progress or completed',
            status: 409,
          };
        const prior = await db
          .prepare(
            "SELECT COUNT(*) AS n FROM refunds WHERE return_id=? AND status IN ('failed','canceled')"
          )
          .bind(ret.id)
          .first<{ n: number }>();
        const result = await refundOrder(
          db,
          env,
          ret.order_id,
          f.amountCents,
          false,
          `return-${ret.id}-${prior?.n ?? 0}`,
          ret.id
        );
        if (!result.ok) return result;
        await audit(db, actor.id, 'return.refund', 'return', ret.id, {
          amount: result.amount,
        });
        await broadcastAdminRealtime('order.refunded', { orderId: ret.order_id });
        return {
          ok: true,
          data: {
            stripeRefundId: result.stripeRefundId,
            refundStatus: result.status,
            amountCents: result.amount,
          },
        };
      }
      case 'return.reject': {
        const f = parsedAction.data;
        const current = await db
          .prepare('SELECT status FROM returns WHERE id = ?')
          .bind(f.returnId)
          .first<{ status: string }>();
        if (!current) return { ok: false, error: 'Return not found', status: 404 };
        // Closing a refund_failed return is a money decision (it frees the
        // order for general refunds), so only refund holders may do it.
        // No migration: return_decision_update only guards transitions out
        // of 'requested', and the 0007 guards already allow 'rejected'.
        if (current.status === 'refund_failed') {
          const canRefund = authContext
            ? (
                await authContext.auth.api.userHasPermission({
                  body: {
                    userId: actor.id,
                    role: actor.role as StaffRole,
                    permissions: { order: ['refund'] },
                  },
                })
              ).success
            : roles[actor.role as StaffRole]?.authorize({ order: ['refund'] }).success;
          if (!canRefund)
            return {
              ok: false,
              error: 'Only staff who can refund can close a failed refund',
              status: 403,
            };
          // A live retry refund must settle first: closing now would let
          // its success pay out on a rejected return (refunds.ts only
          // closes requested/approved/refund_failed) and free the order
          // for a second, general refund.
          const live = await db
            .prepare(
              "SELECT COUNT(*) AS n FROM refunds WHERE return_id=? AND status NOT IN ('failed','canceled')"
            )
            .bind(f.returnId)
            .first<{ n: number }>();
          if ((live?.n ?? 0) > 0)
            return {
              ok: false,
              error: 'Return refund already in progress or completed',
              status: 409,
            };
        } else if (current.status !== 'requested')
          return { ok: false, error: 'Return already decided', status: 409 };
        const result = await db
          .prepare(
            `UPDATE returns SET status = 'rejected' WHERE id = ? AND status = ? AND NOT EXISTS (SELECT 1 FROM refunds WHERE return_id = ? AND status NOT IN ('failed','canceled'))`
          )
          .bind(f.returnId, current.status, f.returnId)
          .run();
        if (!result.meta.changes)
          return { ok: false, error: 'Return already decided', status: 409 };
        await audit(db, actor.id, 'return.reject', 'return', f.returnId);
        return { ok: true };
      }
      case 'webhook.replay': {
        const f = parsedAction.data;
        const current = await db
          .prepare('SELECT status, type FROM webhook_inbox WHERE event_id = ?')
          .bind(f.eventId)
          .first<{ status: string; type: string }>();
        if (!current) return { ok: false, error: 'Webhook event not found', status: 404 };
        if (current.status === 'processed')
          return { ok: false, error: 'Webhook event already processed', status: 409 };
        if (current.status !== 'dead' && current.status !== 'failed')
          return {
            ok: false,
            error: 'Only failed or dead-lettered webhook events can be replayed',
            status: 409,
          };
        // Replay keeps the original event identity; processing stays
        // in the queue consumer (the durable path), never inline here.
        // The attempt budget is reset BEFORE enqueueing: the consumer
        // refuses rows at the attempt cap, so a message that lands
        // before the reset would be dropped. A failed enqueue reverts
        // the row to quarantine below.
        const reset = await db
          .prepare(
            "UPDATE webhook_inbox SET status = 'pending', attempts = 0, retry_after = NULL WHERE event_id = ? AND status IN ('dead','failed')"
          )
          .bind(f.eventId)
          .run();
        if (!reset.meta.changes)
          return {
            ok: false,
            error: 'Webhook event state changed; refresh and retry',
            status: 409,
          };
        const queued = await enqueueJob({ type: 'webhook.process', eventId: f.eventId });
        if (!queued) {
          // Restore quarantine, guarded so a consumer that already
          // picked the row up is never clobbered back to dead.
          await db
            .prepare(
              "UPDATE webhook_inbox SET status = 'dead', attempts = 5, retry_after = NULL WHERE event_id = ? AND status = 'pending' AND attempts = 0"
            )
            .bind(f.eventId)
            .run();
          return {
            ok: false,
            error:
              'Queue unavailable. The event stays quarantined and automatic recovery will retry it.',
            status: 503,
          };
        }
        await audit(db, actor.id, 'webhook.replay', 'webhook', f.eventId, {
          type: current.type,
          fromStatus: current.status,
        });
        return { ok: true, data: { eventId: f.eventId } };
      }
      case 'settings.set': {
        if (parsedAction.data.key === 'media_public_base_url' && parsedAction.data.value) {
          const delivery = publicMediaEnvironment(env);
          if (!delivery.PUBLIC_MEDIA || !delivery.MEDIA_ZONE_ID || !delivery.MEDIA_PURGE_TOKEN)
            return {
              ok: false,
              error:
                'Configure public media storage and purge credentials before enabling delivery',
              status: 503,
            };
        }
        const f = parsedAction.data;
        const key = f.key;
        if (!settingKeySchema.safeParse(key).success) {
          return { ok: false, error: `Setting ${key} cannot be changed here` };
        }
        validateSetting(key, f.value);
        const settings = await getSettings(db);
        // The lock rejects actual currency changes only; an unchanged
        // value (the settings form always submits it) is a no-op write
        // the 0020 triggers also permit. A concurrent lock landing after
        // this read still aborts in the database and maps to 409 below.
        if (key === 'currency' && settings.currencyLocked && f.value !== settings.currency) {
          return { ok: false, error: 'Currency is locked after the first live order', status: 409 };
        }
        try {
          await setSetting(db, key, f.value);
        } catch (error) {
          // Drizzle wraps D1 trigger errors; preserve the expected conflict status.
          let cause = error;
          for (let depth = 0; key === 'currency' && cause instanceof Error && depth < 5; depth++) {
            if (/currency is locked/.test(cause.message))
              return {
                ok: false,
                error:
                  'Currency cannot change while a checkout is pending or after the first completed order',
                status: 409,
              };
            cause = cause.cause;
          }
          throw error;
        }
        await audit(db, actor.id, 'settings.set', 'settings', key);
        return { ok: true };
      }
      case 'page.save': {
        const f = parsedAction.data;
        const pageId = f.id || id();
        const origins = await acceptedMediaOrigins(db, requestOrigin);
        const cleanHtml = canonicalizeMediaUrls(sanitizeHtml(f.contentHtml), origins);
        const submittedKeys = new Set(mediaKeysInContent(cleanHtml, origins));
        const storedPage = await db
          .prepare('SELECT content_html FROM pages WHERE id = ?')
          .bind(pageId)
          .first<{ content_html: string | null }>();
        const target: MediaSaveTarget = {
          table: 'pages',
          rowId: pageId,
          keys: [...submittedKeys],
          spellings: mediaRawSpellings(storedPage?.content_html, submittedKeys, origins),
        };
        try {
          await db.batch([
            ...mediaSaveGuards(db, target),
            db
              .prepare(
                `INSERT INTO pages (id, slug, title, content_html, seo_title, seo_description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, title=excluded.title, content_html=excluded.content_html,
             seo_title=excluded.seo_title, seo_description=excluded.seo_description, updated_at=excluded.updated_at`
              )
              .bind(
                pageId,
                f.slug,
                f.title,
                cleanHtml,
                f.seoTitle || null,
                f.seoDescription || null,
                now(),
                now()
              ),
          ]);
        } catch (error) {
          const failure = await mediaSaveFailure(db, target, origins);
          if (failure) return failure;
          throw error;
        }
        await audit(db, actor.id, 'page.save', 'page', pageId);
        return { ok: true, data: { pageId } };
      }
      case 'product.update': {
        const f = parsedAction.data;
        const productId = f.productId;
        const slug = f.slug.trim();
        const clash = await db
          .prepare('SELECT id FROM products WHERE slug = ? AND id != ?')
          .bind(slug, productId)
          .first();
        if (clash) return { ok: false, error: `Another product already uses slug ${slug}` };
        const before = await db
          .prepare('SELECT slug FROM products WHERE id = ?')
          .bind(productId)
          .first<{ slug: string }>();
        if (!before) {
          return {
            ok: false,
            error: 'This product no longer exists. Your edits have not been saved.',
            conflict: true,
          };
        }
        let storedDescription = f.description;
        let storedHtml: string | null | undefined;
        if (f.descriptionHtml !== undefined) {
          const clean = sanitizeHtml(f.descriptionHtml);
          storedHtml = clean.trim() ? clean : null;
          if (storedHtml) storedDescription = plainTextFromHtml(clean).slice(0, 20_000);
        }
        const updateSql = `UPDATE products SET title = ?, slug = ?, description = ?, ${storedHtml !== undefined ? 'description_html = ?, ' : ''}status = ?, seo_title = ?, seo_description = ?, tax_code = ?, updated_at = ?
           WHERE id = ?`;
        const updateValues = [
          f.title,
          slug,
          storedDescription,
          ...(storedHtml !== undefined ? [storedHtml] : []),
          f.status || 'draft',
          f.seoTitle || null,
          f.seoDescription || null,
          f.taxCode || null,
          now(),
          productId,
        ];
        if (f.expectedRevision !== undefined) {
          const guarded = await db
            .prepare(
              `${updateSql} AND (SELECT target_revision FROM catalog_work WHERE entity_type = 'product' AND entity_id = ?) = ?`
            )
            .bind(...updateValues, productId, f.expectedRevision)
            .run();
          if (!guarded.meta.changes) {
            return {
              ok: false,
              error:
                'This product changed since you opened it. Your edits are still here. Reload to review the current version before saving again.',
              conflict: true,
            };
          }
        } else {
          await db
            .prepare(updateSql)
            .bind(...updateValues)
            .run();
        }
        if (before && before.slug !== slug) {
          // Renamed slugs keep resolving (plan Step 6: renamed slugs redirect).
          await db
            .prepare(
              `INSERT INTO redirects (id, from_path, to_path, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(from_path) DO UPDATE SET to_path = excluded.to_path`
            )
            .bind(id(), `/products/${before.slug}`, `/products/${slug}`, now())
            .run();
        }
        await audit(db, actor.id, 'product.update', 'product', productId);
        const revision = await db
          .prepare(
            "SELECT target_revision FROM catalog_work WHERE entity_type = 'product' AND entity_id = ?"
          )
          .bind(productId)
          .first<{ target_revision: number }>();
        return {
          ok: true,
          data: { revision: revision?.target_revision ?? null, publication: 'pending' },
        };
      }
      case 'variant.bulkUpdate': {
        const f = parsedAction.data;
        const variantIds = f.variantIds;
        if (variantIds.length === 0) return { ok: false, error: 'Select at least one variant' };
        if (variantIds.length > 50)
          return { ok: false, error: 'Bulk edit is capped at 50 variants at a time' };
        const priceCents = f.priceCents;
        const stockDelta = Number(f.stockDelta ?? 0);
        // Atomic: validate everything before any write, then apply all
        // edits in one batch. A missing variant or a stock guard failure
        // aborts the whole edit â€” never a partial bulk update.
        if (priceCents != null && (!Number.isInteger(priceCents) || priceCents < 0)) {
          return { ok: false, error: 'Bulk price must be a whole number of cents, 0 or more' };
        }
        if (!Number.isInteger(stockDelta))
          return { ok: false, error: 'Stock adjustment must be a whole number' };
        const skus: string[] = [];
        for (const variantId of variantIds) {
          const variant = await db
            .prepare('SELECT sku FROM variants WHERE id = ?')
            .bind(variantId)
            .first<{ sku: string }>();
          if (!variant)
            return { ok: false, error: `Unknown variant ${variantId}; no changes applied` };
          skus.push(variant.sku);
        }
        const stmts: D1PreparedStatement[] = [];
        for (let i = 0; i < variantIds.length; i++) {
          if (priceCents != null) {
            stmts.push(
              db
                .prepare('UPDATE variants SET price_cents = ? WHERE id = ?')
                .bind(priceCents, variantIds[i]),
              // Abort the whole batch if this variant disappeared after
              // validation (batch_guard has CHECK (0): any insert fails).
              db
                .prepare(
                  'INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM variants WHERE id = ?)'
                )
                .bind(variantIds[i])
            );
          }
          if (stockDelta !== 0) {
            stmts.push(
              db
                .prepare('UPDATE stock SET on_hand = on_hand + ?, updated_at = ? WHERE sku = ?')
                .bind(stockDelta, now(), skus[i]),
              // Ledger entry only when the stock update actually landed.
              db
                .prepare(
                  `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, created_at)
                 SELECT ?, ?, ?, 0, 'correction', ? WHERE changes()>0`
                )
                .bind(id(), skus[i], stockDelta, now()),
              // Both the variant and its stock row must still exist,
              // otherwise the whole batch aborts instead of reporting a
              // successful adjustment that never happened.
              db
                .prepare(
                  'INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM variants WHERE id = ?) OR NOT EXISTS(SELECT 1 FROM stock WHERE sku = ?)'
                )
                .bind(variantIds[i], skus[i])
            );
          }
        }
        if (stmts.length > 0) await db.batch(stmts);
        await audit(db, actor.id, 'variant.bulkUpdate', 'variant', variantIds[0] ?? '', {
          count: variantIds.length,
          priceCents: priceCents ?? null,
          stockDelta,
        });
        return { ok: true, data: { updated: variantIds.length } };
      }
      case 'media.updateAlt': {
        const f = parsedAction.data;
        await db
          .prepare('UPDATE media SET alt_text = ? WHERE id = ?')
          .bind(f.altText, f.mediaId)
          .run();
        await audit(db, actor.id, 'media.updateAlt', 'media', f.mediaId);
        return { ok: true };
      }
      case 'media.delete': {
        const f = parsedAction.data;
        const mediaId = f.mediaId;
        const media = await db
          .prepare('SELECT r2_key FROM media WHERE id = ?')
          .bind(mediaId)
          .first<{ r2_key: string }>();
        if (!media)
          return {
            ok: false,
            error: 'Image not found or in use. Remove it from its product or post first.',
            status: 409,
          };
        // Encoded references (e.g. /media/%61bc.jpg) cannot be matched
        // in SQL, so scan editorial content with the shared extractor
        // first; the atomic claim below remains the final gate.
        const scanOrigins = await acceptedMediaOrigins(db, requestOrigin);
        const postContents = await db
          .prepare('SELECT content_html, content_json FROM posts')
          .all<{ content_html: string | null; content_json: string | null }>();
        const pageContents = await db
          .prepare('SELECT content_html FROM pages')
          .all<{ content_html: string | null }>();
        const referencedInContent = [
          ...postContents.results.flatMap((row) => [
            ...mediaKeysInContent(row.content_html, scanOrigins),
            ...mediaKeysInContent(row.content_json, scanOrigins),
          ]),
          ...pageContents.results.flatMap((row) =>
            mediaKeysInContent(row.content_html, scanOrigins)
          ),
        ];
        if (referencedInContent.includes(media.r2_key))
          return {
            ok: false,
            error: 'Image not found or in use. Remove it from its product or post first.',
            status: 409,
          };
        // Content references are matched by path substring (/media/<key>)
        // in posts/pages HTML and post JSON: conservative protection that
        // also catches absolute and mirrored URLs embedding the key.
        const claim = await db
          .prepare(
            `UPDATE media SET deletion_pending=1 WHERE id=? AND NOT EXISTS(SELECT 1 FROM product_media WHERE media_id=?) AND NOT EXISTS(SELECT 1 FROM posts WHERE cover_media_id=?)
             AND NOT EXISTS(SELECT 1 FROM posts WHERE instr(REPLACE(content_html, '\\/', '/'), '/media/' || ?) > 0 OR instr(REPLACE(COALESCE(content_json, ''), '\\/', '/'), '/media/' || ?) > 0)
             AND NOT EXISTS(SELECT 1 FROM pages WHERE instr(REPLACE(content_html, '\\/', '/'), '/media/' || ?) > 0)`
          )
          .bind(mediaId, mediaId, mediaId, media.r2_key, media.r2_key, media.r2_key)
          .run();
        if (!claim.meta.changes)
          return {
            ok: false,
            error: 'Image not found or in use. Remove it from its product or post first.',
            status: 409,
          };
        if (media) {
          // Delete the original and every generated responsive variant;
          // leaving variants behind keeps a "deleted" image publicly
          // served at /media/<key>?w=... (B8).
          try {
            await deleteMediaObjects(db, publicMediaEnvironment(env), mediaId, media.r2_key);
          } catch (error) {
            console.error(
              JSON.stringify({
                event: 'media_delete_incomplete',
                mediaId,
                error: error instanceof Error ? error.name : 'unknown',
              })
            );
            return {
              ok: false,
              status: 503,
              error: 'Image deletion is incomplete. Retry deletion to finish removing its files.',
            };
          }
        }
        await db
          .prepare('DELETE FROM media WHERE id = ? AND deletion_pending=1')
          .bind(mediaId)
          .run();
        await audit(db, actor.id, 'media.delete', 'media', mediaId);
        return { ok: true };
      }
      case 'variant.save': {
        const f = parsedAction.data;
        const variantId = f.variantId;
        const priceCents = f.priceCents;
        const sku = f.sku.trim();
        if (!sku) return { ok: false, error: 'SKU is required' };
        if (!Number.isInteger(priceCents) || priceCents < 0)
          return { ok: false, error: 'Price must be a whole number of cents, 0 or more' };
        const skuClash = await db
          .prepare('SELECT sku FROM variants WHERE sku = ? AND id != ?')
          .bind(sku, variantId || '-')
          .first();
        if (skuClash) return { ok: false, error: `SKU ${sku} is already in use` };
        if (variantId) {
          const existing = await db
            .prepare('SELECT sku FROM variants WHERE id = ?')
            .bind(variantId)
            .first<{ sku: string }>();
          if (existing && existing.sku !== sku) {
            return {
              ok: false,
              error:
                'SKU cannot be changed after creation, because stock and orders are tracked by SKU. Add a new variant with the new SKU instead.',
            };
          }
          await db
            .prepare(
              'UPDATE variants SET sku = ?, title = ?, price_cents = ?, compare_at_cents = ?, continue_selling = ?, weight_grams = ? WHERE id = ?'
            )
            .bind(
              sku,
              f.title || 'Default',
              priceCents,
              f.compareAtCents ?? null,
              f.continueSelling ? 1 : 0,
              f.weightGrams,
              variantId
            )
            .run();
          await audit(db, actor.id, 'variant.save', 'variant', variantId);
          return { ok: true, data: { variantId } };
        }
        const newId = id();
        await db.batch([
          db
            .prepare(
              'INSERT INTO variants (id, product_id, sku, title, price_cents, compare_at_cents, continue_selling, weight_grams, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .bind(
              newId,
              f.productId,
              sku,
              f.title || 'Default',
              priceCents,
              f.compareAtCents ?? null,
              f.continueSelling ? 1 : 0,
              f.weightGrams,
              now()
            ),
          db
            .prepare(
              'INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES (?, 0, 0, ?) ON CONFLICT(sku) DO NOTHING'
            )
            .bind(sku, now()),
        ]);
        await audit(db, actor.id, 'variant.save', 'variant', newId);
        return { ok: true, data: { variantId: newId } };
      }
      case 'variant.delete': {
        const f = parsedAction.data;
        const variantId = f.variantId;
        const variant = await db
          .prepare('SELECT product_id, sku FROM variants WHERE id = ?')
          .bind(variantId)
          .first<{ product_id: string; sku: string }>();
        if (!variant) return { ok: false, error: 'Variant not found' };
        try {
          await db.batch([
            db
              .prepare(
                `INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM variants v WHERE v.id=? AND v.sku=? AND (SELECT COUNT(*) FROM variants WHERE product_id=v.product_id)>1 AND NOT EXISTS(SELECT 1 FROM order_items WHERE sku=v.sku) AND NOT EXISTS(SELECT 1 FROM reservations WHERE sku=v.sku AND status IN ('active','committed')) AND NOT EXISTS(SELECT 1 FROM stock WHERE sku=v.sku AND reserved!=0))`
              )
              .bind(variantId, variant.sku),
            db
              .prepare(
                `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, ref_type, ref_id, created_at)
             SELECT ?,sku,-on_hand,0,'correction','variant',?,? FROM stock WHERE sku=?`
              )
              .bind(id(), variantId, now(), variant.sku),
            db
              .prepare("DELETE FROM reservations WHERE sku = ? AND status='released'")
              .bind(variant.sku),
            db.prepare('DELETE FROM stock WHERE sku = ?').bind(variant.sku),
            db.prepare('DELETE FROM variants WHERE id = ?').bind(variantId),
            db
              .prepare(
                "INSERT INTO audit_log(id,actor_user_id,action,entity_type,entity_id,created_at) VALUES(?,?,'variant.delete','variant',?,?)"
              )
              .bind(id(), actor.id, variantId, now()),
          ]);
        } catch (error) {
          if (
            /batch_guard|CHECK constraint failed: 0/.test(
              error instanceof Error ? error.message : ''
            )
          )
            return {
              ok: false,
              error:
                'Variant cannot be deleted: it is the last variant, has orders or has inventory holds. Set the product to draft instead.',
              status: 409,
            };
          throw error;
        }
        return { ok: true };
      }
      case 'product.detachMedia': {
        const f = parsedAction.data;
        await db
          .prepare('DELETE FROM product_media WHERE product_id = ? AND media_id = ?')
          .bind(f.productId, f.mediaId)
          .run();
        await audit(db, actor.id, 'product.detachMedia', 'product', f.productId, {
          mediaId: f.mediaId,
        });
        return { ok: true };
      }
      case 'discount.delete': {
        const f = parsedAction.data;
        await db.prepare('DELETE FROM discounts WHERE id = ?').bind(f.discountId).run();
        await audit(db, actor.id, 'discount.delete', 'discount', f.discountId);
        return { ok: true };
      }
      case 'collection.create': {
        const f = parsedAction.data;
        const collectionId = id();
        const slug = f.slug.trim();
        const clash = await db
          .prepare('SELECT id FROM collections WHERE slug = ?')
          .bind(slug)
          .first();
        if (clash) return { ok: false, error: `A collection with slug ${slug} already exists` };
        const kind = f.kind === 'rule' ? 'rule' : 'manual';
        await db
          .prepare(
            'INSERT INTO collections (id, slug, title, description, kind, rule_json, featured_rank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(
            collectionId,
            slug,
            f.title,
            f.description,
            kind,
            kind === 'rule' ? f.ruleJson || null : null,
            f.featuredRank,
            now()
          )
          .run();
        await audit(db, actor.id, 'collection.create', 'collection', collectionId);
        return { ok: true, data: { collectionId } };
      }
      case 'collection.update': {
        const f = parsedAction.data;
        const kind = f.kind === 'rule' ? 'rule' : 'manual';
        await db
          .prepare(
            'UPDATE collections SET title = ?, description = ?, seo_title = ?, seo_description = ?, kind = ?, rule_json = ?, featured_rank = ? WHERE id = ?'
          )
          .bind(
            f.title,
            f.description,
            f.seoTitle || null,
            f.seoDescription || null,
            kind,
            kind === 'rule' ? f.ruleJson || null : null,
            f.featuredRank,
            f.collectionId
          )
          .run();
        await audit(db, actor.id, 'collection.update', 'collection', f.collectionId);
        return { ok: true };
      }
      case 'collection.delete': {
        const f = parsedAction.data;
        await db.batch([
          db
            .prepare('DELETE FROM product_collections WHERE collection_id = ?')
            .bind(f.collectionId),
          db.prepare('DELETE FROM collections WHERE id = ?').bind(f.collectionId),
        ]);
        await audit(db, actor.id, 'collection.delete', 'collection', f.collectionId);
        return { ok: true };
      }
      case 'collection.setProducts': {
        const f = parsedAction.data;
        const productIds = f.productIds;
        await db.batch([
          db
            .prepare('DELETE FROM product_collections WHERE collection_id = ?')
            .bind(f.collectionId),
          ...productIds.map((pid) =>
            db
              .prepare('INSERT INTO product_collections (product_id, collection_id) VALUES (?, ?)')
              .bind(pid, f.collectionId)
          ),
        ]);
        await audit(db, actor.id, 'collection.setProducts', 'collection', f.collectionId, {
          count: productIds.length,
        });
        return { ok: true };
      }
      case 'collection.toggleProduct': {
        const f = parsedAction.data;
        if (f.included) {
          await db
            .prepare(
              'INSERT INTO product_collections (product_id, collection_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
            )
            .bind(f.productId, f.collectionId)
            .run();
        } else {
          await db
            .prepare('DELETE FROM product_collections WHERE product_id = ? AND collection_id = ?')
            .bind(f.productId, f.collectionId)
            .run();
        }
        await audit(db, actor.id, 'collection.toggleProduct', 'collection', f.collectionId, {
          productId: f.productId,
          included: Boolean(f.included),
        });
        return { ok: true };
      }
      case 'user.setRole': {
        const f = parsedAction.data;
        const role = f.role;
        if (!['customer', 'support', 'warehouse', 'manager', 'owner'].includes(role)) {
          return { ok: false, error: 'Unknown role' };
        }
        const target = await db
          .prepare('SELECT id, role, banned FROM user WHERE id = ?')
          .bind(f.userId)
          .first<{ id: string; role: string; banned: number }>();
        if (!target) return { ok: false, error: 'User not found' };
        if (
          ['owner', 'admin'].includes(target.role) &&
          !target.banned &&
          !['owner', 'admin'].includes(role)
        ) {
          const owners = await db
            .prepare("SELECT COUNT(*) AS n FROM user WHERE role IN ('owner','admin') AND banned=0")
            .first<{ n: number }>();
          if ((owners?.n ?? 0) <= 1)
            return { ok: false, error: 'The last owner cannot be demoted' };
        }
        if (!authContext)
          return { ok: false, error: 'Auth context is required to change roles', status: 500 };
        // Better Auth's admin plugin owns role writes; changing a role must
        // also revoke the target's existing sessions, which the plugin call
        // is paired with explicitly.
        await authContext.auth.api.setRole({
          body: { userId: f.userId, role: role as StaffRole },
          headers: authContext.headers,
        });
        await authContext.auth.api.revokeUserSessions({
          body: { userId: f.userId },
          headers: authContext.headers,
        });
        await audit(db, actor.id, 'user.setRole', 'user', f.userId, { role });
        return { ok: true };
      }
      case 'customer.export': {
        const f = parsedAction.data;
        const userId = f.userId;
        const data = await exportCustomerData(db, userId);
        if (!data) return { ok: false, error: 'Customer not found' };
        await audit(db, actor.id, 'customer.export', 'user', userId, {});
        return { ok: true, data: z.json().parse(data) };
      }
      case 'customer.delete': {
        const f = parsedAction.data;
        const userId = f.userId;
        if (userId === actor.id)
          return { ok: false, error: 'You cannot delete your own account from the admin' };
        const target = await db
          .prepare('SELECT id, role FROM user WHERE id = ?')
          .bind(userId)
          .first<{ id: string; role: string }>();
        if (!target) return { ok: false, error: 'Customer not found' };
        if (target.role === 'owner' || target.role === 'admin') {
          return {
            ok: false,
            error: 'Another owner must demote this account before it can be deleted.',
            status: 409,
          };
        }
        if (!authContext)
          return { ok: false, error: 'Auth context is required to delete a customer', status: 500 };
        try {
          await deleteAccountAtomically(db, userId, actor.id);
        } catch (error) {
          if (error instanceof AccountDeletionError)
            return { ok: false, error: error.message, status: error.status };
          return { ok: false, error: 'Account deletion failed. Please try again.', status: 500 };
        }
        return { ok: true };
      }
      case 'product.reorderMedia': {
        const f = parsedAction.data;
        const attached = await db
          .prepare('SELECT media_id FROM product_media WHERE product_id = ?')
          .bind(f.productId)
          .all<{ media_id: string }>();
        const attachedIds = new Set(attached.results.map((row) => row.media_id));
        if (
          attachedIds.size !== f.mediaIds.length ||
          f.mediaIds.some((mediaId) => !attachedIds.has(mediaId)) ||
          attachedIds.size !== f.expectedMediaIds.length ||
          f.expectedMediaIds.some((mediaId) => !attachedIds.has(mediaId))
        ) {
          return {
            ok: false,
            error: 'The image order changed since this page loaded. Reload before reordering.',
            conflict: true,
          };
        }
        // Atomic guard (FF-04): the batch aborts unless the stored order is
        // still exactly the order this editor loaded. The audit row commits
        // in the same batch (FF-16 Tier A), so neither can land alone.
        const expectedSignature = f.expectedMediaIds.join(',');
        const caseSql = f.mediaIds.map((_, index) => `WHEN ? THEN ${index}`).join(' ');
        try {
          await db.batch([
            db
              .prepare(
                `INSERT INTO batch_guard (id) SELECT 'media-order' WHERE (SELECT group_concat(media_id, ',') FROM (SELECT media_id FROM product_media WHERE product_id = ? ORDER BY position, media_id)) IS NOT ?`
              )
              .bind(f.productId, expectedSignature),
            db
              .prepare(
                `UPDATE product_media SET position = CASE media_id ${caseSql} ELSE position END WHERE product_id = ?`
              )
              .bind(...f.mediaIds, f.productId),
            auditStmt(db, actor.id, 'product.reorderMedia', 'product', f.productId, {
              count: f.mediaIds.length,
            }),
          ]);
        } catch (error) {
          const current = await db
            .prepare(
              "SELECT group_concat(media_id, ',') AS signature FROM (SELECT media_id FROM product_media WHERE product_id = ? ORDER BY position, media_id)"
            )
            .bind(f.productId)
            .first<{ signature: string | null }>();
          if (current?.signature !== expectedSignature) {
            return {
              ok: false,
              error: 'The image order changed since this page loaded. Reload before reordering.',
              conflict: true,
            };
          }
          throw error;
        }
        return { ok: true };
      }
      case 'product.attachMedia': {
        const f = parsedAction.data;
        const existing = await db
          .prepare('SELECT media_id FROM product_media WHERE product_id = ? AND media_id = ?')
          .bind(f.productId, f.mediaId)
          .first();
        if (existing)
          return { ok: false, error: 'That image is already attached to this product.' };
        const pos = await db
          .prepare(
            'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM product_media WHERE product_id = ?'
          )
          .bind(f.productId)
          .first<{ p: number }>();
        await db
          .prepare('INSERT INTO product_media (product_id, media_id, position) VALUES (?, ?, ?)')
          .bind(f.productId, f.mediaId, pos?.p ?? 0)
          .run();
        await audit(db, actor.id, 'product.attachMedia', 'product', f.productId, {
          mediaId: f.mediaId,
        });
        return { ok: true };
      }
      case 'product.updateStatus': {
        const f = parsedAction.data;
        await db
          .prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?')
          .bind(f.status, now(), f.productId)
          .run();
        await audit(db, actor.id, 'product.updateStatus', 'product', f.productId, {
          status: f.status,
        });
        return { ok: true };
      }
      case 'post.save': {
        const f = parsedAction.data;
        const postId = f.id || id();
        const status = f.status || 'draft';
        if (!['draft', 'published', 'scheduled'].includes(status))
          return { ok: false, error: 'Unknown post status' };
        const scheduledFor = f.publishedAt;
        if (status === 'scheduled' && !scheduledFor)
          return { ok: false, error: 'Scheduled posts need a publish date and time' };
        const publishedAt =
          status === 'published'
            ? now()
            : status === 'scheduled'
              ? new Date(scheduledFor).toISOString()
              : null;
        const existing = await db
          .prepare('SELECT slug, published_at, content_html, content_json FROM posts WHERE id = ?')
          .bind(postId)
          .first<{
            slug: string;
            published_at: string | null;
            content_html: string | null;
            content_json: string | null;
          }>();
        if (existing && status === 'published' && existing.published_at) {
          // Keep the original publish date on re-publish/edits.
        }
        const origins = await acceptedMediaOrigins(db, requestOrigin);
        const cleanHtml = canonicalizeMediaUrls(sanitizeHtml(f.contentHtml), origins);
        const cleanJson = f.contentJson
          ? canonicalizeMediaUrls(f.contentJson, origins)
          : f.contentJson;
        const submittedKeys = new Set([
          ...mediaKeysInContent(cleanHtml, origins),
          ...mediaKeysInContent(cleanJson, origins),
        ]);
        const target: MediaSaveTarget = {
          table: 'posts',
          rowId: postId,
          keys: [...submittedKeys],
          coverMediaId: f.coverMediaId || undefined,
          spellings: (() => {
            const merged = mediaRawSpellings(existing?.content_html, submittedKeys, origins);
            for (const [key, list] of mediaRawSpellings(
              existing?.content_json,
              submittedKeys,
              origins
            )) {
              const current = merged.get(key) ?? [];
              for (const spelling of list) if (!current.includes(spelling)) current.push(spelling);
              merged.set(key, current);
            }
            return merged;
          })(),
        };
        try {
          await db.batch([
            ...mediaSaveGuards(db, target),
            db
              .prepare(
                `INSERT INTO posts (id, slug, title, excerpt, content_html, content_json, status, cover_media_id, author_id, published_at, seo_title, seo_description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, title=excluded.title, excerpt=excluded.excerpt,
             content_html=excluded.content_html, content_json=excluded.content_json, status=excluded.status,
             cover_media_id=excluded.cover_media_id, author_id=excluded.author_id,
             published_at=excluded.published_at, seo_title=excluded.seo_title, seo_description=excluded.seo_description,
             updated_at=excluded.updated_at`
              )
              .bind(
                postId,
                f.slug,
                f.title,
                f.excerpt,
                cleanHtml,
                cleanJson || null,
                status,
                f.coverMediaId || null,
                actor.id,
                existing && status === 'published' && existing.published_at
                  ? existing.published_at
                  : publishedAt,
                f.seoTitle || null,
                f.seoDescription || null,
                now(),
                now()
              ),
          ]);
        } catch (error) {
          const failure = await mediaSaveFailure(db, target, origins);
          if (failure) return failure;
          throw error;
        }
        if (existing && existing.slug !== f.slug) {
          await db
            .prepare(
              `INSERT INTO redirects (id, from_path, to_path, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(from_path) DO UPDATE SET to_path = excluded.to_path`
            )
            .bind(id(), `/blog/${existing.slug}`, `/blog/${f.slug}`, now())
            .run();
        }
        // Tags: free-form names, synced wholesale on each save.
        const tagNames = [
          ...new Set(
            f.tags
              .split(',')
              .map((t) => t.trim().toLowerCase())
              .filter(Boolean)
          ),
        ].slice(0, 10);
        const tagOps: D1PreparedStatement[] = [
          db.prepare('DELETE FROM post_tags WHERE post_id = ?').bind(postId),
        ];
        for (const name of tagNames) {
          const tagSlug = name.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          tagOps.push(
            db
              .prepare(
                `INSERT INTO tags (id, slug, name) VALUES (?, ?, ?) ON CONFLICT(slug) DO NOTHING`
              )
              .bind(id(), tagSlug, name),
            db
              .prepare(
                `INSERT INTO post_tags (post_id, tag_id) SELECT ?, id FROM tags WHERE slug = ? ON CONFLICT DO NOTHING`
              )
              .bind(postId, tagSlug)
          );
        }
        await db.batch(tagOps);
        await audit(db, actor.id, 'post.save', 'post', postId, { status });
        return { ok: true, data: { postId } };
      }
      case 'import.productsCsv': {
        const f = parsedAction.data;
        const csv = f.csv;
        const rows = parseCsv(csv);
        if (rows.length - 1 > CSV_IMPORT_MAX_ROWS)
          return {
            ok: false,
            error: `CSV import is limited to ${CSV_IMPORT_MAX_ROWS} product rows per file`,
            status: 400,
          };
        const header = (rows[0] ?? []).map((h) => h.trim());
        const idx = (name: string) => header.indexOf(name);
        let imported = 0;
        const errors: { row: number; error: string }[] = [];
        for (let i = 1; i < rows.length; i++) {
          const cols = rows[i] ?? [];
          try {
            const { title, slug, sku, price, stockQty } = csvProductRowSchema.parse({
              title: cols[idx('title')]?.trim(),
              slug: cols[idx('slug')]?.trim(),
              sku: cols[idx('sku')]?.trim(),
              price: cols[idx('price_cents')],
              stockQty: cols[idx('stock')],
            });
            const productId = id();
            // The ledger must log the real difference, not the target:
            // overwriting on_hand with stockQty while logging stockQty as
            // the delta made the ledger drift from the counters.
            const existingStock = await db
              .prepare('SELECT on_hand FROM stock WHERE sku = ?')
              .bind(sku)
              .first<{ on_hand: number }>();
            const stockDelta = stockQty - (existingStock?.on_hand ?? 0);
            await db.batch([
              db
                .prepare(
                  'INSERT INTO products (id, slug, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
                )
                .bind(productId, slug, title, '', 'active', now(), now()),
              db
                .prepare(
                  'INSERT INTO variants (id, product_id, sku, title, price_cents, continue_selling, weight_grams, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                )
                .bind(id(), productId, sku, 'Default', price, 0, null, now()),
              db
                .prepare(
                  'INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(sku) DO UPDATE SET on_hand = excluded.on_hand'
                )
                .bind(sku, stockQty, now()),
              db
                .prepare(
                  `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, ref_type, ref_id, created_at)
                 VALUES (?, ?, ?, 0, 'restock', 'product', ?, ?)`
                )
                .bind(id(), sku, stockDelta, productId, now()),
            ]);
            imported++;
          } catch (err) {
            errors.push({
              row: i + 1,
              error: err instanceof z.ZodError ? zodIssues(err) : safeActionError(err),
            });
          }
        }
        await audit(db, actor.id, 'import.productsCsv', 'product', 'csv', {
          imported,
          errors: errors.length,
        });
        return { ok: true, data: { imported, errors } };
      }
      default: {
        // Exhaustive over the Zod discriminated union: adding an action
        // without a handler is a compile error, not a runtime surprise.
        const exhaustive: never = parsedAction.data;
        return {
          ok: false,
          error: `Unknown action ${String((exhaustive as { action: string }).action)}`,
        };
      }
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'admin_action_failed',
        action,
        actorId: actor.id,
        error: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
      })
    );
    if (err instanceof z.ZodError)
      return { ok: false, error: 'Invalid input: ' + zodIssues(err), status: 400 };
    return {
      ok: false,
      error: /D1_ERROR|SQLITE|constraint/i.test(err instanceof Error ? err.message : '')
        ? safeActionError(err)
        : 'Action failed. Please try again.',
      status: /D1_ERROR|SQLITE|constraint/i.test(err instanceof Error ? err.message : '')
        ? 409
        : 500,
    };
  }
}

/** Database and constraint errors are logged, never sent to the client. */
function safeActionError(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (/D1_ERROR|SQLITE|constraint|FOREIGN KEY|UNIQUE/i.test(message)) {
    return 'That change conflicts with existing data. Check for duplicates and try again.';
  }
  return 'Action failed. Please try again.';
}
