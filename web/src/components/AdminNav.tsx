import { useServerFn } from '@tanstack/react-start';
import { useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactElement } from 'react';
import type { z } from 'zod';
import { Link, linkOptions, useLocation } from '@tanstack/react-router';
import { MenuIcon } from 'lucide-react';
import { GlobalSearchDialog, GlobalSearchMobileTrigger } from './GlobalSearch';
import { adminActionFn } from '../lib/adminFns';
import { mediaUrl, type MediaSource } from '../lib/media-url';
import { roleCan, type statement } from '../lib/permissions';
import { Button } from './ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './ui/sheet';
import {
  BagIcon,
  BoxIcon,
  ChartIcon,
  FileIcon,
  ImageIcon,
  HomeIcon,
  OrdersIcon,
  PenIcon,
  LayersIcon,
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
  | '/admin/inventory'
  | '/admin/collections'
  | '/admin/discounts'
  | '/admin/orders'
  | '/admin/customers'
  | '/admin/shipping'
  | '/admin/articles'
  | '/admin/media'
  | '/admin/pages'
  | '/admin/reports'
  | '/admin/settings';
const nav = (to: AdminPath) => linkOptions({ to });
type Permission = {
  [R in keyof typeof statement]: readonly [R, (typeof statement)[R][number]];
}[keyof typeof statement];
type NavItem = {
  link: ReturnType<typeof nav>;
  label: string;
  Icon: IconType;
  requires?: Permission;
};
type NavSection = { label?: string; items: readonly NavItem[] };

const settingsItem: NavItem = {
  link: nav('/admin/settings'),
  label: 'Settings',
  Icon: SettingsIcon,
  requires: ['settings', 'view'],
};
const sections: readonly NavSection[] = [
  { items: [{ link: nav('/admin'), label: 'Home', Icon: HomeIcon, requires: ['report', 'view'] }] },
  {
    label: 'Catalog',
    items: [
      { link: nav('/admin/products'), label: 'Products', Icon: BagIcon },
      { link: nav('/admin/collections'), label: 'Collections', Icon: LayersIcon },
      { link: nav('/admin/discounts'), label: 'Discounts', Icon: TagIcon },
      { link: nav('/admin/inventory'), label: 'Inventory', Icon: OrdersIcon },
    ],
  },
  {
    label: 'Sales',
    items: [
      {
        link: nav('/admin/orders'),
        label: 'Orders',
        Icon: BoxIcon,
        requires: ['order', 'view'],
      },
      {
        link: nav('/admin/customers'),
        label: 'Customers',
        Icon: UserIcon,
        requires: ['user', 'list'],
      },
      { link: nav('/admin/shipping'), label: 'Shipping', Icon: TruckIcon },
    ],
  },
  {
    label: 'Content',
    items: [
      { link: nav('/admin/articles'), label: 'Articles', Icon: PenIcon },
      { link: nav('/admin/pages'), label: 'Pages', Icon: FileIcon },
      { link: nav('/admin/media'), label: 'Media', Icon: ImageIcon },
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

const itemClass =
  'flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-950';
const activeClass =
  'flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium text-zinc-950';

function NavigationLinks({
  sections,
  settings,
  onNavigate,
}: {
  sections: readonly NavSection[];
  settings: NavItem | null;
  onNavigate?: () => void;
}): ReactElement {
  const renderItem = ({ link, label, Icon }: NavItem) => (
    <li key={link.to}>
      <Link
        {...link}
        className={itemClass}
        activeProps={{ className: activeClass, 'aria-current': 'page' }}
        activeOptions={{ exact: link.to === '/admin', includeSearch: false }}
        onClick={onNavigate}
      >
        <Icon className="h-[18px] w-[18px] shrink-0" />
        <span>{label}</span>
      </Link>
    </li>
  );
  return (
    <>
      <nav aria-label="Admin" className="min-h-0 flex-1 space-y-7 overflow-y-auto px-4 pb-4">
        {sections.map((section) => (
          <div key={section.label ?? 'main'}>
            {section.label ? (
              <p className="px-2.5 pb-1.5 text-[13px] font-medium text-zinc-950">{section.label}</p>
            ) : null}
            <ul className="space-y-0.5">{section.items.map(renderItem)}</ul>
          </div>
        ))}
      </nav>
      <div className="px-4 pt-2 pb-5">
        <ul className="space-y-0.5">
          {settings ? renderItem(settings) : null}
          <li>
            <Link to="/" className={itemClass} onClick={onNavigate}>
              <StoreIcon className="h-[18px] w-[18px] shrink-0" />
              <span>View store</span>
            </Link>
          </li>
        </ul>
      </div>
    </>
  );
}

export function AdminNav({
  storeName = 'Your store',
  logo = null,
  role,
}: {
  storeName?: string;
  logo?: MediaSource | null;
  role: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const railRef = useRef<HTMLElement>(null);
  const visible = (item: NavItem) =>
    !item.requires || roleCan(role, item.requires[0], item.requires[1]);
  const visibleSections = sections
    .map((section) => ({ ...section, items: section.items.filter(visible) }))
    .filter((section) => section.items.length > 0);
  const settings = visible(settingsItem) ? settingsItem : null;

  useEffect(() => setOpen(false), [location.href]);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 640px)');
    const closeOnRail = () => {
      if (media.matches) setOpen(false);
    };
    media.addEventListener('change', closeOnRail);
    closeOnRail();
    return () => media.removeEventListener('change', closeOnRail);
  }, []);

  const storeIdentity = (
    <div className="flex items-center gap-2.5 px-5 pt-6 pb-5">
      {logo ? (
        <img
          src={mediaUrl(logo, 320)}
          alt=""
          className="size-6 shrink-0 rounded-md bg-white object-contain"
        />
      ) : (
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-zinc-300 bg-white text-[11px] font-medium text-zinc-800">
          {storeName.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="block min-w-0 truncate text-sm font-medium text-zinc-950">{storeName}</span>
      <GlobalSearchMobileTrigger />
    </div>
  );

  return (
    <>
      <aside
        ref={railRef}
        tabIndex={-1}
        aria-label="Admin navigation"
        className="fixed inset-y-0 left-0 z-40 hidden w-[260px] flex-col bg-white sm:flex"
      >
        {storeIdentity}
        <NavigationLinks sections={visibleSections} settings={settings} />
      </aside>
      <div className="flex h-[62px] items-center gap-2 border-b border-zinc-100 bg-white px-4 sm:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Open admin navigation">
              <MenuIcon aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="data-[side=left]:w-[min(290px,85vw)] gap-0 border-zinc-100 bg-white p-0"
            onCloseAutoFocus={(event) => {
              if (window.matchMedia('(min-width: 640px)').matches) {
                event.preventDefault();
                railRef.current?.focus({ preventScroll: true });
              }
            }}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Admin navigation</SheetTitle>
              <SheetDescription>Store pages and settings</SheetDescription>
            </SheetHeader>
            {storeIdentity}
            <NavigationLinks
              sections={visibleSections}
              settings={settings}
              onNavigate={() => setOpen(false)}
            />
          </SheetContent>
        </Sheet>
        {logo ? (
          <img
            src={mediaUrl(logo, 320)}
            alt=""
            className="size-6 shrink-0 rounded-md bg-white object-contain"
          />
        ) : null}
        <span className="min-w-0 truncate text-sm font-medium text-zinc-950">{storeName}</span>
        <GlobalSearchMobileTrigger />
      </div>
      <GlobalSearchDialog />
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
      return {
        ok: false as const,
        uncertain: true as const,
        error: 'The connection was lost before the result came back.',
      };
    }
  };
}
