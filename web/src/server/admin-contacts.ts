import { z } from 'zod';

export function normalizeContactEmail(value: string): string {
  return value.trim().toLowerCase();
}

export const contactLookupInputSchema = z.object({
  email: z.string().max(320).default(''),
});
export type ContactLookupInput = z.infer<typeof contactLookupInputSchema>;

export type ContactOrderRow = {
  id: string;
  number: string;
  status: string;
  payment_status: string;
  total_cents: number;
  currency: string;
  created_at: string;
};

export type ContactLookup = {
  email: string;
  account: { id: string; name: string; email: string; role: string } | null;
  guestOrderCount: number;
  accountOrderCount: number;
};

const ORDER_COLUMNS = 'id, number, status, payment_status, total_cents, currency, created_at';

export async function lookupContact(
  db: D1Database,
  rawEmail: unknown
): Promise<ContactLookup | null> {
  const { email: parsed } = contactLookupInputSchema.parse({ email: rawEmail });
  const email = normalizeContactEmail(parsed);
  if (!email) return null;
  const account = await db
    .prepare('SELECT id, name, email, role FROM user WHERE lower(email) = ?')
    .bind(email)
    .first<NonNullable<ContactLookup['account']>>();
  const guest = await db
    .prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id IS NULL AND lower(customer_email) = ?')
    .bind(email)
    .first<{ n: number }>();
  const accountOrders = account
    ? await db
        .prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?')
        .bind(account.id)
        .first<{ n: number }>()
    : null;
  return {
    email,
    account: account ?? null,
    guestOrderCount: guest?.n ?? 0,
    accountOrderCount: accountOrders?.n ?? 0,
  };
}

export async function contactHistory(
  db: D1Database,
  rawEmail: unknown
): Promise<{ email: string; guest: ContactOrderRow[]; account: ContactOrderRow[] }> {
  const { email: parsed } = contactLookupInputSchema.parse({ email: rawEmail });
  const email = normalizeContactEmail(parsed);
  if (!email) return { email, guest: [], account: [] };
  const account = await db
    .prepare('SELECT id FROM user WHERE lower(email) = ?')
    .bind(email)
    .first<{ id: string }>();
  const guest = await db
    .prepare(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE user_id IS NULL AND lower(customer_email) = ? ORDER BY created_at DESC, id DESC LIMIT 50`
    )
    .bind(email)
    .all<ContactOrderRow>();
  const accountOrders = account
    ? (
        await db
          .prepare(
            `SELECT ${ORDER_COLUMNS} FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`
          )
          .bind(account.id)
          .all<ContactOrderRow>()
      ).results
    : [];
  return { email, guest: guest.results, account: accountOrders };
}
