import * as z from 'zod';
import { escapeLike, ftsTitleMatch, ftsUsable } from '../lib/fts-search';
import type { ProductStatus } from '../db/schema';
import { pageSizeSchema } from '../schemas/pagination';
import { requireStaffPermission } from './session';

export const inventoryListInputSchema = z.object({
  q: z.string().max(200).default(''),
  page: z.number().int().min(1).default(1),
  size: pageSizeSchema,
  low: z.boolean().default(false),
});
export type InventoryListInput = z.infer<typeof inventoryListInputSchema>;

export type InventorySkuRow = {
  sku: string;
  variantTitle: string;
  onHand: number;
  reserved: number;
  available: number;
};

export type InventoryProductGroup = {
  id: string;
  slug: string;
  title: string;
  status: ProductStatus;
  image_key: string | null;
  variantCount: number;
  onHand: number;
  reserved: number;
  available: number;
  lowCount: number;
  matchedSkus: string[];
  skus: InventorySkuRow[];
};

export type InventoryListResult = {
  products: InventoryProductGroup[];
  total: number;
  page: number;
  pageSize: number;
};

export const LOW_STOCK_AVAILABLE = 5;

export async function adminInventoryList(
  db: D1Database,
  input: InventoryListInput
): Promise<InventoryListResult> {
  const q = input.q.trim();
  const page = Math.max(1, input.page);
  // Callers may pass unparsed input; the schema default is 25.
  const size = input.size ?? 25;
  const clauses: string[] = [];
  const binds: string[] = [];
  if (q) {
    // Title search goes through products_fts and waits for its 3-char
    // threshold; the SKU prefix is served by variants_sku_nocase_idx.
    const skuPrefix = `p.id IN (SELECT product_id FROM variants WHERE sku LIKE ? ESCAPE '\\')`;
    if (ftsUsable(q)) {
      clauses.push(
        `(p.rowid IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?) OR ${skuPrefix})`
      );
      binds.push(ftsTitleMatch('title', q), `${escapeLike(q)}%`);
    } else {
      clauses.push(skuPrefix);
      binds.push(`${escapeLike(q)}%`);
    }
  }
  if (input.low) {
    clauses.push(
      `EXISTS (SELECT 1 FROM variants v LEFT JOIN stock s ON s.sku = v.sku WHERE v.product_id = p.id AND COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) <= ${LOW_STOCK_AVAILABLE})`
    );
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM products p ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;
  const pageRows = (
    await db
      .prepare(
        `SELECT p.id FROM products p ${where} ORDER BY p.title COLLATE NOCASE, p.id LIMIT ? OFFSET ?`
      )
      .bind(...binds, size, (page - 1) * size)
      .all<{ id: string }>()
  ).results;
  if (pageRows.length === 0) return { products: [], total, page, pageSize: size };
  const placeholders = pageRows.map(() => '?').join(',');
  const rows = (
    await db
      .prepare(
        `SELECT p.id, p.slug, p.title, p.status,
          (SELECT m.r2_key FROM product_media pm JOIN media m ON m.id = pm.media_id
            WHERE pm.product_id = p.id AND m.ready = 1 AND m.deletion_pending = 0
            ORDER BY pm.position LIMIT 1) AS image_key,
          v.sku, v.title AS variantTitle,
          COALESCE(s.on_hand, 0) AS onHand, COALESCE(s.reserved, 0) AS reserved
         FROM products p
         LEFT JOIN variants v ON v.product_id = p.id
         LEFT JOIN stock s ON s.sku = v.sku
         WHERE p.id IN (${placeholders})
         ORDER BY p.title COLLATE NOCASE, p.id, v.sku`
      )
      .bind(...pageRows.map((row) => row.id))
      .all<{
        id: string;
        slug: string;
        title: string;
        status: ProductStatus;
        image_key: string | null;
        sku: string | null;
        variantTitle: string | null;
        onHand: number;
        reserved: number;
      }>()
  ).results;
  const byId = new Map<string, InventoryProductGroup>();
  for (const row of rows) {
    let group = byId.get(row.id);
    if (!group) {
      group = {
        id: row.id,
        slug: row.slug,
        title: row.title,
        status: row.status,
        image_key: row.image_key,
        variantCount: 0,
        onHand: 0,
        reserved: 0,
        available: 0,
        lowCount: 0,
        matchedSkus: [],
        skus: [],
      };
      byId.set(row.id, group);
    }
    if (!row.sku) continue;
    const available = row.onHand - row.reserved;
    group.skus.push({
      sku: row.sku,
      variantTitle: row.variantTitle ?? '',
      onHand: row.onHand,
      reserved: row.reserved,
      available,
    });
    group.variantCount += 1;
    group.onHand += row.onHand;
    group.reserved += row.reserved;
    group.available += available;
    if (available <= LOW_STOCK_AVAILABLE) group.lowCount += 1;
    if (q && row.sku.toUpperCase().startsWith(q.toUpperCase())) group.matchedSkus.push(row.sku);
  }
  return {
    products: pageRows.flatMap((row) => {
      const group = byId.get(row.id);
      return group ? [group] : [];
    }),
    total,
    page,
    pageSize: size,
  };
}

export type InventoryDetail = {
  sku: string;
  variantTitle: string;
  productId: string;
  productTitle: string;
  onHand: number;
  reserved: number;
  available: number;
  history: Array<{
    id: string;
    delta_on_hand: number;
    delta_reserved: number;
    reason: string;
    created_at: string;
  }>;
};

export const skuDetailInputSchema = z.object({ sku: z.string().max(100) });

export async function adminInventoryDetail(
  db: D1Database,
  staff: { role?: string | null | undefined },
  sku: string
): Promise<InventoryDetail | null> {
  requireStaffPermission(staff, 'stock', 'view');
  const head = await db
    .prepare(
      `SELECT v.sku, v.title AS variantTitle, v.product_id AS productId, p.title AS productTitle,
                COALESCE(s.on_hand, 0) AS onHand, COALESCE(s.reserved, 0) AS reserved
         FROM variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN stock s ON s.sku = v.sku
         WHERE v.sku = ?`
    )
    .bind(sku.trim())
    .first<{
      sku: string;
      variantTitle: string;
      productId: string;
      productTitle: string;
      onHand: number;
      reserved: number;
    }>();
  if (!head) return null;
  const history = await db
    .prepare(
      'SELECT id, delta_on_hand, delta_reserved, reason, created_at FROM stock_ledger WHERE sku = ? ORDER BY created_at DESC, id DESC LIMIT 50'
    )
    .bind(head.sku)
    .all<InventoryDetail['history'][number]>();
  return { ...head, available: head.onHand - head.reserved, history: history.results };
}
