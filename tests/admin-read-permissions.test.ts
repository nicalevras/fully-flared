import { describe, expect, it } from 'vitest';
import { roleCan, type statement } from '../web/src/lib/permissions';

// D-6: who may read each admin loader. Owner and admin read everything;
// a manager reads what it can already edit.
const loaders: ReadonlyArray<readonly [string, keyof typeof statement, readonly string[]]> = [
  ['products list and product detail', 'product', ['support', 'warehouse', 'manager']],
  ['collection options', 'product', ['support', 'warehouse', 'manager']],
  ['inventory list and SKU detail', 'stock', ['support', 'warehouse', 'manager']],
  ['shipping zones', 'shipping', ['warehouse', 'manager']],
  ['discounts list', 'discount', ['manager']],
  ['collections list', 'collection', ['manager']],
  ['media list and media detail', 'media', ['manager']],
  ['pages list and page detail', 'page', ['manager']],
  ['articles list and post detail', 'post', ['manager']],
  ['settings', 'settings', []],
];
const staffRoles = ['owner', 'admin', 'manager', 'support', 'warehouse'] as const;

describe('admin read permissions (MS-4, D-6)', () => {
  it('support cannot list discounts', () => {
    expect(roleCan('support', 'discount', 'view')).toBe(false);
  });

  describe.each(loaders)('%s', (_loader, resource, readers) => {
    it.each(staffRoles)(`%s view on ${resource}`, (role) => {
      const allowed = role === 'owner' || role === 'admin' || readers.includes(role);
      expect(roleCan(role, resource, 'view')).toBe(allowed);
    });
    it('customers cannot read it', () => {
      expect(roleCan('customer', resource, 'view')).toBe(false);
    });
  });
});
