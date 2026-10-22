import { createFileRoute } from '@tanstack/react-router';
import { requireStaff, requireStaffPermission } from '../../server/session';
import { reportQuerySchema } from '../../schemas/account';

import { serializeCsvCell } from '../../server/csv';
import { grossSalePredicate } from '../../server/reports';

// Complete exports, one SQL statement each. A single statement executes
// against one consistent state, so the export reflects the consistent state
// seen by its SQL statement — concurrent writes are wholly in or wholly
// out. The LIMIT is an overflow detector only: one extra row proves the
// export is too large, and staff get an explicit error instead of a
// silently truncated file. Row count is capped; result memory is not
// directly capped (.all() materializes rows), so the limits stay
// conservative. Serialization is measured incrementally on the actual
// output (headers, wrapper, separators and escaping included) without
// retaining a second complete representation.
export const EXPORT_MAX_ROWS = 25_000;
export const EXPORT_MAX_BYTES = 16 * 1024 * 1024;

type ExportType = 'sales' | 'products' | 'inventory' | 'orders' | 'customers';

const EXPORT_QUERIES: Record<ExportType, string> = {
  sales: `SELECT date(created_at) AS day,COUNT(*) AS orders,SUM(total_cents) AS total_cents,currency FROM orders o WHERE ${grossSalePredicate('o')} GROUP BY day,currency ORDER BY day DESC,currency ASC LIMIT ?`,
  products: `SELECT i.sku,i.title,o.currency,SUM(i.qty) AS units,SUM(i.qty*i.unit_price_cents) AS revenue_cents FROM order_items i JOIN orders o ON o.id=i.order_id WHERE ${grossSalePredicate('o')} GROUP BY i.sku,i.title,o.currency ORDER BY i.sku,i.title,o.currency LIMIT ?`,
  inventory: `SELECT sku, on_hand, reserved, on_hand - reserved AS available FROM stock ORDER BY sku LIMIT ?`,
  orders: `SELECT number, customer_email, status, payment_status, total_cents, currency, tracking_number, created_at
                 FROM orders ORDER BY created_at DESC, id DESC LIMIT ?`,
  customers: `SELECT customer_email,currency,COUNT(*) AS orders,SUM(total_cents) AS spent_cents FROM orders o WHERE ${grossSalePredicate('o')} GROUP BY customer_email,currency ORDER BY customer_email,currency LIMIT ?`,
};

class ExportTooLarge extends Error {}

export async function exportReport(
  db: D1Database,
  type: ExportType,
  format: 'json' | 'csv',
  limits: { maxRows: number; maxBytes: number } = {
    maxRows: EXPORT_MAX_ROWS,
    maxBytes: EXPORT_MAX_BYTES,
  }
): Promise<Response> {
  let rows: Record<string, unknown>[];
  try {
    const result = await db
      .prepare(EXPORT_QUERIES[type])
      .bind(limits.maxRows + 1)
      .all<Record<string, unknown>>();
    rows = result.results;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'report_export_failed',
        type,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return Response.json({ error: 'Report export failed' }, { status: 500 });
  }
  if (rows.length > limits.maxRows) {
    console.error(
      JSON.stringify({
        event: 'report_export_too_large',
        type,
        reason: 'rows',
        limit: limits.maxRows,
      })
    );
    return Response.json(
      {
        error: `Export exceeds the ${limits.maxRows}-row limit. Narrow the store data or split the export.`,
      },
      { status: 413 }
    );
  }
  const encoder = new TextEncoder();
  const state = { bytes: 0 };
  const withinBytes = (text: string): string => {
    state.bytes += encoder.encode(text).length;
    if (state.bytes > limits.maxBytes) throw new ExportTooLarge('bytes');
    return text;
  };
  try {
    if (format === 'csv') {
      if (!rows.length) return new Response('', { headers: csvHeaders(type) });
      const headers = Object.keys(rows[0]!);
      const parts: string[] = [withinBytes(headers.join(','))];
      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows
          .slice(i, i + 500)
          .map((r) => headers.map((h) => serializeCsvCell(r[h])).join(','))
          .join('\n');
        parts.push(withinBytes(`\n${slice}`));
      }
      return new Response(parts.join(''), { headers: csvHeaders(type) });
    }
    const parts: string[] = [withinBytes(`{"type":${JSON.stringify(type)},"rows":[`)];
    for (let i = 0; i < rows.length; i += 500) {
      const slice = rows
        .slice(i, i + 500)
        .map((r) => JSON.stringify(r))
        .join(',');
      parts.push(withinBytes(i === 0 ? slice : `,${slice}`));
    }
    parts.push(withinBytes(']}'));
    return new Response(parts.join(''), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof ExportTooLarge) {
      console.error(
        JSON.stringify({
          event: 'report_export_too_large',
          type,
          reason: 'bytes',
          limit: limits.maxBytes,
        })
      );
      return Response.json(
        {
          error: `Export exceeds the ${limits.maxBytes}-byte limit. Narrow the store data or split the export.`,
        },
        { status: 413 }
      );
    }
    throw error;
  }
}

function csvHeaders(type: ExportType): Record<string, string> {
  return {
    'Content-Type': 'text/csv',
    'Content-Disposition': `attachment; filename="${type}-report.csv"`,
  };
}

export const Route = createFileRoute('/api/reports')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        let staff;
        try {
          staff = await requireStaff(env.DB, request);
        } catch {
          return Response.json({ error: 'Staff access required' }, { status: 403 });
        }
        const url = new URL(request.url);
        const parsedQuery = reportQuerySchema.safeParse({
          type: url.searchParams.get('type') ?? undefined,
          format: url.searchParams.get('format') ?? undefined,
        });
        if (!parsedQuery.success)
          return Response.json({ error: 'Unknown report type' }, { status: 400 });
        const { type, format } = parsedQuery.data;
        if (type === 'customers' || type === 'orders' || type === 'sales') {
          try {
            requireStaffPermission(staff, 'customer', 'export');
          } catch {
            return Response.json({ error: 'Customer export permission required' }, { status: 403 });
          }
        }
        return exportReport(env.DB, type, format);
      },
    },
  },
});
