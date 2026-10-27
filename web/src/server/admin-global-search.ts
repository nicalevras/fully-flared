import { z } from 'zod';
import { adminProductDiscovery } from './admin-product-discovery';
import { adminOrderDiscovery } from './admin-order-discovery';
import { lookupContact } from './admin-contacts';

export const globalSearchInputSchema = z.object({ q: z.string().max(200).default('') });

export type GlobalSearchResult = {
  products: Array<{ id: string; title: string; status: string }>;
  orders: Array<{ id: string; number: string; customer_email: string }>;
  customers: Array<{
    email: string;
    accountId: string | null;
    guestOrderCount: number;
    accountOrderCount: number;
  }>;
};

const EMPTY: GlobalSearchResult = { products: [], orders: [], customers: [] };

export async function globalSearch(
  db: D1Database,
  rawQ: unknown,
  allowed: { orders: boolean; customers: boolean }
): Promise<GlobalSearchResult> {
  const { q } = globalSearchInputSchema.parse({ q: rawQ });
  const query = q.trim();
  if (query.length < 2) return EMPTY;

  const byTitle = await adminProductDiscovery(db, { q: query, mode: 'title' });
  const bySku = await adminProductDiscovery(db, { q: query, mode: 'sku-prefix' });
  const productMap = new Map<string, GlobalSearchResult['products'][number]>();
  for (const p of [...byTitle.products, ...bySku.products]) {
    if (!productMap.has(p.id)) productMap.set(p.id, { id: p.id, title: p.title, status: p.status });
  }
  const products = [...productMap.values()].slice(0, 5);

  let orders: GlobalSearchResult['orders'] = [];
  if (allowed.orders) {
    const found = await adminOrderDiscovery(db, {
      q: query,
      view: 'all',
      payment: 'all',
      from: '',
      to: '',
    });
    orders = found.orders
      .slice(0, 5)
      .map((o) => ({ id: o.id, number: o.number, customer_email: o.customer_email }));
  }

  const customers: GlobalSearchResult['customers'] = [];
  if (allowed.customers && query.includes('@')) {
    const escaped = query.toLowerCase().replace(/[\\%_]/g, '\\$&');
    const emails = (
      await db
        .prepare(
          `SELECT email FROM (
             SELECT lower(customer_email) AS email FROM orders
             UNION
             SELECT lower(email) AS email FROM user
           ) WHERE email LIKE ? ESCAPE '\\' ORDER BY email LIMIT 5`
        )
        .bind(`${escaped}%`)
        .all<{ email: string }>()
    ).results;
    for (const row of emails) {
      const contact = await lookupContact(db, row.email);
      if (contact && (contact.account || contact.guestOrderCount > 0)) {
        customers.push({
          email: contact.email,
          accountId: contact.account?.id ?? null,
          guestOrderCount: contact.guestOrderCount,
          accountOrderCount: contact.accountOrderCount,
        });
      }
    }
  }

  return { products, orders, customers };
}
