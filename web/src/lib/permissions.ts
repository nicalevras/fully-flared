import type { AdminAction } from '../schemas/admin';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements, userAc } from 'better-auth/plugins/admin/access';

// Better Auth admin-plugin access control. The statement combines Better
// Auth's built-in user/session resources with this store's admin resources;
// every admin action maps to exactly one resource + action pair below.
export const statement = {
  ...defaultStatements,
  product: ['create', 'update', 'update-status', 'attach-media', 'detach-media'],
  variant: ['save', 'delete', 'bulk-update'],
  stock: ['adjust'],
  media: ['upload', 'update-alt', 'delete'],
  discount: ['create', 'update', 'toggle', 'delete'],
  collection: ['create', 'update', 'delete', 'set-products', 'toggle-product'],
  shipping: ['create-zone', 'add-rate'],
  order: ['view', 'ship', 'refund'],
  return: ['approve', 'reject'],
  webhook: ['replay'],
  settings: ['view', 'set'],
  report: ['view'],
  page: ['save'],
  post: ['save'],
  import: ['products-csv'],
  customer: ['export', 'delete'],
} as const;

export const ac = createAccessControl(statement);

const catalogWrite = {
  product: ['create', 'update', 'update-status', 'attach-media', 'detach-media'],
  variant: ['save', 'delete', 'bulk-update'],
  stock: ['adjust'],
  media: ['upload', 'update-alt', 'delete'],
} as const;

export const roles = {
  customer: userAc,
  support: ac.newRole({
    user: ['get', 'list'],
    session: [],
    order: ['view', 'ship'],
    return: ['approve', 'reject'],
  }),
  warehouse: ac.newRole({
    user: [],
    session: [],
    product: ['update-status'],
    stock: ['adjust'],
    order: ['view', 'ship'],
  }),
  manager: ac.newRole({
    user: ['get', 'list'],
    session: [],
    ...catalogWrite,
    discount: ['create', 'update', 'toggle', 'delete'],
    collection: ['create', 'update', 'delete', 'set-products', 'toggle-product'],
    shipping: ['create-zone', 'add-rate'],
    order: ['view', 'ship'],
    return: ['approve', 'reject'],
    report: ['view'],
    page: ['save'],
    post: ['save'],
    import: ['products-csv'],
    customer: ['export'],
  }),
  owner: ac.newRole({
    user: [...defaultStatements.user],
    session: [...defaultStatements.session],
    product: ['create', 'update', 'update-status', 'attach-media', 'detach-media'],
    variant: ['save', 'delete', 'bulk-update'],
    stock: ['adjust'],
    media: ['upload', 'update-alt', 'delete'],
    discount: ['create', 'update', 'toggle', 'delete'],
    collection: ['create', 'update', 'delete', 'set-products', 'toggle-product'],
    shipping: ['create-zone', 'add-rate'],
    order: ['view', 'ship', 'refund'],
    return: ['approve', 'reject'],
    webhook: ['replay'],
    settings: ['view', 'set'],
    report: ['view'],
    customer: ['export', 'delete'],
    page: ['save'],
    post: ['save'],
    import: ['products-csv'],
  }),
  // Legacy role kept equivalent to owner for accounts created before the
  // named staff roles existed.
  admin: ac.newRole({
    user: [...defaultStatements.user],
    session: [...defaultStatements.session],
    product: ['create', 'update', 'update-status', 'attach-media', 'detach-media'],
    variant: ['save', 'delete', 'bulk-update'],
    stock: ['adjust'],
    media: ['upload', 'update-alt', 'delete'],
    discount: ['create', 'update', 'toggle', 'delete'],
    collection: ['create', 'update', 'delete', 'set-products', 'toggle-product'],
    shipping: ['create-zone', 'add-rate'],
    order: ['view', 'ship', 'refund'],
    return: ['approve', 'reject'],
    webhook: ['replay'],
    settings: ['view', 'set'],
    report: ['view'],
    customer: ['export', 'delete'],
    page: ['save'],
    post: ['save'],
    import: ['products-csv'],
  }),
};

export type StaffRole = keyof typeof roles;

export function roleCan(
  role: string | null | undefined,
  resource: keyof typeof statement,
  action: string
): boolean {
  const granted = Object.entries(roles).find(([name]) => name === role)?.[1];
  return granted?.authorize({ [resource]: [action] }).success ?? false;
}

/** The Better Auth permission pair guarding one admin action. */
export const ACTION_PERMISSIONS: Record<
  AdminAction['action'],
  { resource: string; action: string }
> = {
  'product.create': { resource: 'product', action: 'create' },
  'product.update': { resource: 'product', action: 'update' },
  'product.updateStatus': { resource: 'product', action: 'update-status' },
  'product.attachMedia': { resource: 'product', action: 'attach-media' },
  'product.detachMedia': { resource: 'product', action: 'detach-media' },
  'product.reorderMedia': { resource: 'product', action: 'attach-media' },
  'variant.save': { resource: 'variant', action: 'save' },
  'variant.delete': { resource: 'variant', action: 'delete' },
  'variant.bulkUpdate': { resource: 'variant', action: 'bulk-update' },
  'stock.adjust': { resource: 'stock', action: 'adjust' },
  'media.updateAlt': { resource: 'media', action: 'update-alt' },
  'media.delete': { resource: 'media', action: 'delete' },
  'discount.create': { resource: 'discount', action: 'create' },
  'discount.update': { resource: 'discount', action: 'update' },
  'discount.toggle': { resource: 'discount', action: 'toggle' },
  'discount.delete': { resource: 'discount', action: 'delete' },
  'collection.create': { resource: 'collection', action: 'create' },
  'collection.update': { resource: 'collection', action: 'update' },
  'collection.delete': { resource: 'collection', action: 'delete' },
  'collection.setProducts': { resource: 'collection', action: 'set-products' },
  'collection.toggleProduct': { resource: 'collection', action: 'toggle-product' },
  'shipping.createZone': { resource: 'shipping', action: 'create-zone' },
  'shipping.addRate': { resource: 'shipping', action: 'add-rate' },
  'order.ship': { resource: 'order', action: 'ship' },
  'order.refund': { resource: 'order', action: 'refund' },
  'return.approve': { resource: 'return', action: 'approve' },
  'return.refund': { resource: 'order', action: 'refund' },
  'return.reject': { resource: 'return', action: 'reject' },
  'webhook.replay': { resource: 'webhook', action: 'replay' },
  'settings.set': { resource: 'settings', action: 'set' },
  'page.save': { resource: 'page', action: 'save' },
  'post.save': { resource: 'post', action: 'save' },
  'import.productsCsv': { resource: 'import', action: 'products-csv' },
  'customer.export': { resource: 'customer', action: 'export' },
  'customer.delete': { resource: 'customer', action: 'delete' },
  'guest.export': { resource: 'customer', action: 'export' },
  'user.setRole': { resource: 'user', action: 'set-role' },
};
