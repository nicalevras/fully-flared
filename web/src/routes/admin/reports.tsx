import { createFileRoute } from '@tanstack/react-router';
import { staffMiddleware } from '../../server/staff-middleware';
import { requireStaffPermission } from '../../server/session';
import { useStoreCurrency } from '../../lib/use-store-currency';
import { createServerFn } from '@tanstack/react-start';
import { formatMoney } from '../../components/ProductCard';
import { cardCls, pageSub, pageTitle } from '../../components/ui';
import { paidRevenueByCurrency } from '../../server/reports';
import { roles, type StaffRole } from '../../lib/permissions';

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .handler(async ({ context }) => {
    requireStaffPermission(context.staff, 'report', 'view');
    const { env } = await import('cloudflare:workers');
    const revenues = await paidRevenueByCurrency(env.DB);
    const low = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM stock WHERE on_hand - reserved <= 5'
    ).first<{ n: number }>();
    return {
      revenues,
      orders: revenues.reduce((sum, row) => sum + row.orders, 0),
      lowStockSkus: low?.n ?? 0,
      canExportCustomers:
        roles[context.staff.role as StaffRole]?.authorize({ customer: ['export'] }).success ??
        false,
    };
  });

export const Route = createFileRoute('/admin/reports')({
  loader: async () => getData(),
  component: Page,
});

function Page() {
  const currency = useStoreCurrency();
  const r = Route.useLoaderData();
  const stats: Array<[string, string, string]> = [
    ...(r.revenues.length ? r.revenues : [{ currency, revenue: 0, orders: 0 }]).map(
      (row): [string, string, string] => [
        `Gross sales (${row.currency})`,
        formatMoney(row.revenue, row.currency),
        'Original amounts, including refunded sales',
      ]
    ),
    ['Sales orders', String(r.orders), 'Includes refunded sales; excludes unpaid orders'],
    ['Low-stock SKUs', String(r.lowStockSkus), '5 or fewer available'],
  ];
  const exportsList: Array<[string, string, string]> = [
    ...(r.canExportCustomers
      ? ([
          [
            'Sales by day',
            'Complete daily gross sales and order counts, grouped by day and currency; includes refunded sales.',
            '/api/reports?type=sales&format=csv',
          ],
          [
            'Orders',
            'Full order export for accounting: every order, newest first.',
            '/api/reports?type=orders&format=csv',
          ],
        ] as Array<[string, string, string]>)
      : []),
    [
      'Inventory',
      'Every SKU with on-hand, reserved, and available counts.',
      '/api/reports?type=inventory&format=csv',
    ],
    [
      'Products',
      'Complete units and gross merchandise value per product before discounts, shipping and tax.',
      '/api/reports?type=products&format=csv',
    ],
    ...(r.canExportCustomers
      ? [
          [
            'Customers',
            'Complete orders and gross spending per customer, including refunded sales.',
            '/api/reports?type=customers&format=csv',
          ] as [string, string, string],
        ]
      : []),
  ];
  return (
    <main>
      <h1 className={pageTitle}>Reports</h1>
      <p className={pageSub}>
        Live numbers from your store database, plus CSV exports for accounting.
      </p>
      <dl className="mt-6 grid gap-4 sm:grid-cols-3">
        {stats.map(([label, value, sub]) => (
          <div key={label} className={`${cardCls} p-5`}>
            <dt className="text-[13px] font-medium text-zinc-500">{label}</dt>
            <dd className="mt-1.5 text-2xl font-medium tracking-tight text-zinc-950">{value}</dd>
            <dd className="mt-0.5 text-[13px] text-zinc-500">{sub}</dd>
          </div>
        ))}
      </dl>
      <section className={`${cardCls} mt-5 divide-y divide-zinc-100 overflow-hidden`}>
        {exportsList.map(([title, desc, href]) => (
          <div key={href} className="flex flex-wrap items-center gap-3 px-5 py-4">
            <div>
              <p className="text-sm font-medium text-zinc-950">{title}</p>
              <p className="text-[13px] text-zinc-500">{desc}</p>
            </div>
            <a
              className="ml-auto text-[13px] font-medium text-zinc-950 hover:underline"
              href={href}
            >
              Download CSV
            </a>
          </div>
        ))}
      </section>
    </main>
  );
}
