import { useServerFn } from '@tanstack/react-start';
import { useRef } from 'react';
import type { z } from 'zod';
import { adminActionFn } from '../lib/adminFns';
import { roleCan, type statement } from '../lib/permissions';
import type { ComponentType } from 'react';
import { Link, linkOptions } from '@tanstack/react-router';
import {
  BoxIcon,
  ChartIcon,
  FileIcon,
  HomeIcon,
  OrdersIcon,
  PenIcon,
  PercentIcon,
  SettingsIcon,
  StoreIcon,
  TruckIcon,
  UserIcon,
  TagIcon,
} from './icons';
type IconType = ComponentType<{ className?: string }>;
type AdminPath =
  | '/admin'
  | '/admin/products'
  | '/admin/collections'
  | '/admin/discounts'
  | '/admin/orders'
  | '/admin/customers'
  | '/admin/shipping'
  | '/admin/blog'
  | '/admin/media'
  | '/admin/pages'
  | '/admin/reports'
  | '/admin/settings';
const nav = (to: AdminPath) => linkOptions({ to });
type NavItem = {
  link: ReturnType<typeof nav>;
  label: string;
  Icon: IconType;
  requires?: readonly [keyof typeof statement, string];
};
const settingsItem: NavItem = {
  link: nav('/admin/settings'),
  label: 'Settings',
  Icon: SettingsIcon,
  requires: ['settings', 'view'],
};
const sections: Array<{ label?: string; items: NavItem[] }> = [
  { items: [{ link: nav('/admin'), label: 'Home', Icon: HomeIcon, requires: ['report', 'view'] }] },
  {
    label: 'Catalog',
    items: [
      { link: nav('/admin/products'), label: 'Products', Icon: BoxIcon },
      { link: nav('/admin/collections'), label: 'Collections', Icon: TagIcon },
      { link: nav('/admin/discounts'), label: 'Discounts', Icon: PercentIcon },
    ],
  },
  {
    label: 'Sales',
    items: [
      {
        link: nav('/admin/orders'),
        label: 'Orders',
        Icon: OrdersIcon,
        requires: ['order', 'view'],
      },
      { link: nav('/admin/customers'), label: 'Customers', Icon: UserIcon },
      { link: nav('/admin/shipping'), label: 'Shipping', Icon: TruckIcon },
    ],
  },
  {
    label: 'Content',
    items: [
      { link: nav('/admin/blog'), label: 'Blog', Icon: PenIcon },
      { link: nav('/admin/media'), label: 'Media', Icon: FileIcon },
      { link: nav('/admin/pages'), label: 'Pages', Icon: FileIcon },
    ],
  },
  {
    label: 'Insights',
    items: [
      {
        link: nav('/admin/reports'),
        label: 'Reports',
        Icon: ChartIcon,
        requires: ['report', 'view'],
      },
    ],
  },
];

const itemCls =
  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950';
const itemActive =
  'flex items-center gap-2.5 rounded-lg bg-zinc-950 px-3 py-2 text-sm font-medium text-white';

export function AdminNav({
  storeName = 'Your store',
  role,
}: {
  storeName?: string;
  role: string | null | undefined;
}) {
  const visible = (item: NavItem) => !item.requires || roleCan(role, ...item.requires);
  const visibleSections = sections
    .map((s) => ({ ...s, items: s.items.filter(visible) }))
    .filter((s) => s.items.length > 0);
  return (
    <>
      <aside
        className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-zinc-200 bg-white lg:flex"
        aria-label="Admin"
      >
        <div className="flex items-center gap-2.5 px-4 pt-5 pb-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-950 text-sm font-medium text-white">
            {storeName.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-zinc-950">{storeName}</span>
            <span className="block text-xs text-zinc-500">Store admin</span>
          </span>
        </div>
        <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-4">
          {visibleSections.map((s) => (
            <div key={s.label ?? 'main'}>
              {s.label ? (
                <p className="px-3 pb-2 text-xs font-medium text-zinc-400">{s.label}</p>
              ) : null}
              <ul className="space-y-0.5">
                {s.items.map(({ link, label, Icon }) => (
                  <li key={link.to}>
                    <Link
                      {...link}
                      className={itemCls}
                      activeProps={{ className: itemActive }}
                      activeOptions={{ exact: link.to === '/admin' }}
                    >
                      <Icon className="h-[18px] w-[18px] shrink-0" /> {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="space-y-0.5 border-t border-zinc-200 px-3 py-3">
          {visible(settingsItem) ? (
            <Link
              {...settingsItem.link}
              className={itemCls}
              activeProps={{ className: itemActive }}
            >
              <SettingsIcon className="h-[18px] w-[18px] shrink-0" /> Settings
            </Link>
          ) : null}
          <Link to="/" className={itemCls}>
            <StoreIcon className="h-[18px] w-[18px] shrink-0" /> View store
          </Link>
        </div>
      </aside>

      <nav
        className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-zinc-200 bg-white p-1.5 lg:hidden"
        aria-label="Admin"
      >
        {visibleSections
          .flatMap((s) => s.items)
          .concat(visible(settingsItem) ? [settingsItem] : [])
          .map(({ link, label, Icon }) => (
            <Link
              key={link.to}
              {...link}
              className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-zinc-600"
              activeProps={{
                className:
                  'flex shrink-0 items-center gap-1.5 rounded-full bg-zinc-950 px-3 py-1.5 text-[13px] font-medium text-white',
              }}
              activeOptions={{ exact: link.to === '/admin' }}
            >
              <Icon className="h-4 w-4" /> {label}
            </Link>
          ))}
      </nav>
    </>
  );
}

export type AdminPayload = Record<string, z.infer<ReturnType<typeof z.json>>>;

export function useAdminAction() {
  const run = useServerFn(adminActionFn);
  const requests = useRef(new Map<string, string>());
  return async (action: string, payload: AdminPayload) => {
    const input = { ...payload };
    const key = JSON.stringify({ action, payload });
    if (action === 'order.refund') {
      let requestId = requests.current.get(key);
      if (!requestId) {
        requestId = crypto.randomUUID();
        requests.current.set(key, requestId);
      }
      input.requestId = requestId;
    }
    try {
      const result = await run({ data: { action, payload: input } });
      if (result.ok) requests.current.delete(key);
      return result;
    } catch {
      return { ok: false as const, error: 'Action could not reach the server. Try again.' };
    }
  };
}
