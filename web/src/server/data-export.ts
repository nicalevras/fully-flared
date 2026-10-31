import { z } from 'zod';
import type { ExportPage, ExportRequest } from '../schemas/data-export';
import { requireStaffPermission } from './session';

const sections = ['orders', 'items', 'addresses', 'returns', 'returnItems', 'refunds'] as const;
const sectionSchema = z.enum(sections);
type Section = z.infer<typeof sectionSchema>;
const boundSchema = z.number().int().nonnegative();
const boundsSchema = z.object({
  orders: boundSchema,
  items: boundSchema,
  addresses: boundSchema,
  returns: boundSchema,
  returnItems: boundSchema,
  refunds: boundSchema,
});
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), userId: z.string() }),
  z.object({ kind: z.literal('guest'), email: z.email() }),
]);
const cursorSchema = z.object({
  actor: z.string(),
  admin: z.boolean(),
  scope: scopeSchema,
  bounds: boundsSchema,
  section: sectionSchema,
  position: z.tuple([boundSchema, boundSchema, boundSchema]),
  emitted: z.boolean(),
  expires: z.number().int(),
});
type Cursor = z.infer<typeof cursorSchema>;
type Actor = { id: string; role?: string | null | undefined };
const PAGE_SIZE = 250;

export class DataExportError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

function key(secret: string) {
  if (secret.length < 32) throw new DataExportError('Export signing is not configured', 503);
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function sign(secret: string, cursor: Cursor) {
  const body = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await key(secret),
      new TextEncoder().encode(`data-export-v2.${body}`)
    )
  );
  return `${body}.${Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function verify(secret: string, token: string): Promise<Cursor> {
  const [body, hex, extra] = token.split('.');
  if (!body || !hex || extra || !/^[a-f0-9]{64}$/.test(hex))
    throw new DataExportError('Invalid export cursor');
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      await key(secret),
      bytes,
      new TextEncoder().encode(`data-export-v2.${body}`)
    ))
  )
    throw new DataExportError('Invalid export cursor');
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(body.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
          char.charCodeAt(0)
        )
      )
    );
  } catch {
    throw new DataExportError('Invalid export cursor');
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success) throw new DataExportError('Invalid export cursor');
  if (parsed.data.expires <= Date.now())
    throw new DataExportError('Export expired. Start the download again.', 410);
  return parsed.data;
}

function orderScope(scope: Cursor['scope']) {
  return scope.kind === 'account'
    ? { sql: 'o.user_id = ?', value: scope.userId }
    : { sql: 'o.user_id IS NULL AND lower(o.customer_email) = ?', value: scope.email };
}

async function authorize(db: D1Database, actor: Actor, cursor: Cursor) {
  if (cursor.actor !== actor.id)
    throw new DataExportError('Export belongs to another session user', 403);
  if (cursor.admin) requireStaffPermission(actor, 'customer', 'export');
  else if (cursor.scope.kind !== 'account' || cursor.scope.userId !== actor.id)
    throw new DataExportError('Export access denied', 403);
  if (cursor.scope.kind === 'account') {
    const profile = await db
      .prepare('SELECT id FROM user WHERE id = ?')
      .bind(cursor.scope.userId)
      .first();
    if (!profile) throw new DataExportError('Account no longer exists', 404);
  }
}

async function start(
  db: D1Database,
  secret: string,
  actor: Actor,
  target: Extract<ExportRequest, { target: unknown }>['target']
): Promise<ExportPage> {
  await key(secret);
  const admin = target.kind !== 'self';
  if (admin) requireStaffPermission(actor, 'customer', 'export');
  const scope =
    target.kind === 'guest'
      ? ({ kind: 'guest', email: target.email } satisfies Cursor['scope'])
      : ({
          kind: 'account',
          userId: target.kind === 'self' ? actor.id : target.userId,
        } satisfies Cursor['scope']);
  const bounds = boundsSchema.parse(
    await db
      .prepare(
        `SELECT
    (SELECT COALESCE(MAX(rowid),0) FROM orders) AS orders,
    (SELECT COALESCE(MAX(rowid),0) FROM order_items) AS items,
    (SELECT COALESCE(MAX(rowid),0) FROM addresses) AS addresses,
    (SELECT COALESCE(MAX(rowid),0) FROM returns) AS returns,
    (SELECT COALESCE(MAX(rowid),0) FROM return_items) AS returnItems,
    (SELECT COALESCE(MAX(rowid),0) FROM refunds) AS refunds`
      )
      .first()
  );
  const cursor: Cursor = {
    actor: actor.id,
    admin,
    scope,
    bounds,
    section: 'orders',
    position: [0, 0, 0],
    emitted: false,
    expires: Date.now() + 60 * 60 * 1000,
  };
  await authorize(db, actor, cursor);
  const profile =
    scope.kind === 'account'
      ? await db
          .prepare(
            'SELECT id, name, email, email_verified AS emailVerified, role, created_at AS createdAt FROM user WHERE id = ?'
          )
          .bind(scope.userId)
          .first()
      : null;
  if (admin)
    await db
      .prepare(
        `INSERT INTO audit_log
    (id,actor_user_id,action,entity_type,entity_id,details_json,created_at) VALUES (?,?,?,?,?,?,?)`
      )
      .bind(
        crypto.randomUUID(),
        actor.id,
        scope.kind === 'account' ? 'customer.export' : 'guest.export',
        scope.kind === 'account' ? 'user' : 'guest',
        scope.kind === 'account' ? scope.userId : scope.email,
        JSON.stringify({ outcome: 'requested', formatVersion: 2 }),
        new Date().toISOString()
      )
      .run();
  const metadata = {
    formatVersion: 2,
    consistency: 'paged-live',
    exportedAt: new Date().toISOString(),
    profile,
    ...(scope.kind === 'guest' ? { email: scope.email } : {}),
  };
  return {
    chunk: `${JSON.stringify(metadata).slice(0, -1)},"orders":[`,
    nextCursor: await sign(secret, cursor),
  };
}

function pageQuery(cursor: Cursor, measure = false): { sql: string; values: (string | number)[] } {
  const {
    section,
    bounds,
    position: [order, parent, row],
    scope,
  } = cursor;
  if (section === 'addresses') {
    const columns = `a.id, a.label, a.name, a.line1, a.line2, a.city, a.state, a.postal_code AS postalCode,
      a.country, a.phone, a.is_default AS isDefault`;
    return {
      sql: `SELECT a.rowid AS _order, 0 AS _parent, 0 AS _row,
        ${measure ? byteSize(columns) : `${columns}, ${moreRowsSql} AS _more`}
        FROM ${measure ? 'addresses a' : 'selected s CROSS JOIN addresses a'}
        WHERE a.user_id = ? AND a.rowid > ? AND a.rowid <= ?
        ${measure ? '' : 'AND s._order=a.rowid'}
        ORDER BY a.rowid LIMIT ?`,
      values: [scope.kind === 'account' ? scope.userId : '', order, bounds.addresses, PAGE_SIZE],
    };
  }

  const filter = orderScope(scope);
  const definitions: Record<
    Exclude<Section, 'addresses'>,
    {
      from: string;
      columns: string;
      middle: string;
      last: string;
      bound: string;
      limit: number;
      seek: string;
      seekValues: number[];
    }
  > = {
    orders: {
      from: 'orders o',
      columns: `o.id, o.number, o.status, o.payment_status AS paymentStatus,
      o.currency, o.subtotal_cents AS subtotalCents, o.discount_cents AS discountCents,
      o.shipping_cents AS shippingCents, o.tax_cents AS taxCents, o.total_cents AS totalCents,
      o.shipping_name AS shippingName, o.shipping_address_json AS shippingAddressJson, o.created_at AS createdAt`,
      middle: '0',
      last: '0',
      bound: 'o.rowid',
      limit: bounds.orders,
      seek: '1=1',
      seekValues: [],
    },
    items: {
      from: 'orders o JOIN order_items i ON i.order_id = o.id',
      columns:
        'i.id, i.order_id AS orderId, i.sku, i.title, i.qty, i.unit_price_cents AS unitPriceCents',
      middle: '0',
      last: 'i.rowid',
      bound: 'i.rowid',
      limit: bounds.items,
      seek: 'i.rowid > CASE WHEN o.rowid=? THEN ? ELSE 0 END',
      seekValues: [order, row],
    },
    returns: {
      from: 'orders o JOIN returns r ON r.order_id = o.id',
      columns: 'r.id, r.order_id AS orderId, r.status, r.reason, r.created_at AS createdAt',
      middle: 'r.rowid',
      last: '0',
      bound: 'r.rowid',
      limit: bounds.returns,
      seek: 'r.rowid > CASE WHEN o.rowid=? THEN ? ELSE 0 END',
      seekValues: [order, parent],
    },
    returnItems: {
      from: 'orders o JOIN returns r ON r.order_id = o.id JOIN return_items i ON i.return_id = r.id',
      columns:
        'i.id, i.return_id AS returnId, i.order_item_id AS orderItemId, i.sku, i.title, i.qty, i.unit_price_cents AS unitPriceCents',
      middle: 'r.rowid',
      last: 'i.rowid',
      bound: 'i.rowid',
      limit: bounds.returnItems,
      seek: `r.rowid >= CASE WHEN o.rowid=? THEN ? ELSE 0 END
        AND i.rowid > CASE WHEN o.rowid=? AND r.rowid=? THEN ? ELSE 0 END`,
      seekValues: [order, parent, order, parent, row],
    },
    refunds: {
      from: 'orders o JOIN refunds f ON f.order_id = o.id',
      columns:
        'f.id, f.order_id AS orderId, f.return_id AS returnId, f.amount_cents AS amountCents, f.status, f.purpose, f.created_at AS createdAt',
      middle: '0',
      last: 'f.rowid',
      bound: 'f.rowid',
      limit: bounds.refunds,
      seek: 'f.rowid > CASE WHEN o.rowid=? THEN ? ELSE 0 END',
      seekValues: [order, row],
    },
  };
  const def = definitions[section];
  const index = scope.kind === 'account' ? 'orders_export_owner_idx' : 'orders_export_guest_idx';
  const source = measure
    ? def.from
        .replace('orders o', `orders o INDEXED BY ${index}`)
        .replaceAll(' JOIN ', ' CROSS JOIN ')
    : `selected s CROSS JOIN ${def.from.replaceAll(' JOIN ', ' CROSS JOIN ')}`;
  const ordering = ['o.rowid', def.middle, def.last].filter((column) => column !== '0').join(',');
  return {
    sql: `SELECT o.rowid AS _order, ${def.middle} AS _parent, ${def.last} AS _row,
      ${measure ? byteSize(def.columns) : `${def.columns}, ${moreRowsSql} AS _more`}
      FROM ${source} WHERE ${filter.sql}
      AND o.rowid >= ? AND o.rowid <= ? AND ${def.bound} <= ?
      AND (o.rowid, ${def.middle}, ${def.last}) > (?, ?, ?)
      AND ${def.seek}
      ${section === 'returnItems' ? 'AND r.rowid <= ?' : ''}
      ${measure ? '' : `AND s._order=o.rowid AND s._parent=${def.middle} AND s._row=${def.last}`}
      ORDER BY ${measure ? ordering : 's._order,s._parent,s._row'} LIMIT ?`,
    values: [
      filter.value,
      order,
      bounds.orders,
      def.limit,
      order,
      parent,
      row,
      ...def.seekValues,
      ...(section === 'returnItems' ? [bounds.returns] : []),
      PAGE_SIZE,
    ],
  };
}

const moreRowsSql = `(SELECT COUNT(*) FROM candidates) = ${PAGE_SIZE}
  OR (SELECT COUNT(*) FROM selected) < (SELECT COUNT(*) FROM candidates)`;

function byteSize(columns: string) {
  const lengths = columns
    .split(',')
    .map((column) => `COALESCE(length(CAST(${column.trim().split(/\s+AS\s+/i)[0]} AS BLOB)),0)`);
  // JSON escapes can expand a source byte to six bytes.
  return `6 * (${lengths.join('+')}) + 1024 AS _bytes`;
}

const rowSchema = z
  .object({
    _order: boundSchema,
    _parent: boundSchema,
    _row: boundSchema,
    _more: z.number().int().min(0).max(1),
  })
  .catchall(z.json());

export async function readDataExportPage(
  db: D1Database,
  secret: string,
  actor: Actor,
  input: ExportRequest
): Promise<ExportPage> {
  if ('target' in input) return start(db, secret, actor, input.target);
  const cursor = await verify(secret, input.cursor);
  await authorize(db, actor, cursor);
  const candidateQuery = pageQuery(cursor, true);
  const dataQuery = pageQuery(cursor);
  const rows = z.array(rowSchema).parse(
    (
      await db
        .prepare(
          `
    WITH candidates AS MATERIALIZED (${candidateQuery.sql}),
    cumulative AS (
      SELECT *, SUM(_bytes) OVER(ORDER BY _order,_parent,_row) AS _total,
        ROW_NUMBER() OVER(ORDER BY _order,_parent,_row) AS _rank FROM candidates
    ), selected AS MATERIALIZED (
      SELECT _order,_parent,_row FROM cumulative WHERE _total <= 262144 OR _rank=1
    ) ${dataQuery.sql}`
        )
        .bind(...candidateQuery.values, ...dataQuery.values)
        .all()
    ).results
  );
  const last = rows.at(-1);
  const position: Cursor['position'] = last
    ? [last._order, last._parent, last._row]
    : cursor.position;
  let chunk = rows
    .map(({ _order, _parent, _row, _more, ...record }, index) => {
      const comma = index > 0 || cursor.emitted ? ',' : '';
      if (cursor.section === 'orders') {
        const { shippingAddressJson, ...order } = record;
        let shippingAddress: unknown = null;
        if (typeof shippingAddressJson === 'string') {
          try {
            shippingAddress = JSON.parse(shippingAddressJson);
          } catch {
            shippingAddress = null;
          }
        }
        return comma + JSON.stringify({ ...order, shippingAddress });
      }
      return comma + JSON.stringify(record);
    })
    .join('');
  if (last?._more)
    return {
      chunk,
      nextCursor: await sign(secret, {
        ...cursor,
        position,
        emitted: cursor.emitted || rows.length > 0,
      }),
    };
  const next = sections[sections.indexOf(cursor.section) + 1];
  if (!next) return { chunk: chunk + '],"complete":true}', nextCursor: null };
  chunk += `],${JSON.stringify(next)}:[`;
  return {
    chunk,
    nextCursor: await sign(secret, {
      ...cursor,
      section: next,
      position: [0, 0, 0],
      emitted: false,
    }),
  };
}
