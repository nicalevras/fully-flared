import { z } from 'zod';
import { ftsTitleMatch } from '../lib/fts-search';
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

  // Bounded lookup: global search shows 5 products, so it never runs the
  // full discovery projection (which ranks up to 1001 candidates).
  const byTitle = await db
    .prepare(
      `SELECT p.id, p.title, p.status FROM products_fts f JOIN products p ON p.rowid = f.rowid
         WHERE products_fts MATCH ? LIMIT 5`
    )
    .bind(ftsTitleMatch('title', query))
    .all<GlobalSearchResult['products'][number]>();
  const products = byTitle.results.slice(0, 5);

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
    const prefix = query.toLowerCase();
    const prefixEnd = `${prefix}\ufffd`;
    const [orderEmails, userEmails] = await Promise.all([
      db
        .prepare(
          `SELECT lower(customer_email) AS email FROM orders
           WHERE lower(customer_email) >= ? AND lower(customer_email) < ?
           GROUP BY lower(customer_email) ORDER BY lower(customer_email) LIMIT 5`
        )
        .bind(prefix, prefixEnd)
        .all<{ email: string }>(),
      db
        .prepare(
          `SELECT lower(email) AS email FROM user
           WHERE lower(email) >= ? AND lower(email) < ?
           GROUP BY lower(email) ORDER BY lower(email) LIMIT 5`
        )
        .bind(prefix, prefixEnd)
        .all<{ email: string }>(),
    ]);
    const emails = [
      ...new Set([...orderEmails.results, ...userEmails.results].map((row) => row.email)),
    ]
      .sort()
      .slice(0, 5);
    for (const email of emails) {
      const contact = await lookupContact(db, email);
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
