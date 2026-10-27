export type SetupChecklistItem = {
  key: string;
  label: string;
  done: boolean;
  href: string;
};

export function buildSetupChecklist(state: {
  productCount: number;
  shippingZoneCount: number;
  shippingRateCount: number;
  storeName: string;
  currency: string;
}): SetupChecklistItem[] {
  return [
    {
      key: 'store-identity',
      label: 'Name your store and set its currency',
      done: state.storeName.trim().length > 0 && state.currency.trim().length > 0,
      href: '/admin/settings',
    },
    {
      key: 'first-product',
      label: 'Add your first product',
      done: state.productCount > 0,
      href: '/admin/products',
    },
    {
      key: 'shipping-zone',
      label: 'Create a shipping zone',
      done: state.shippingZoneCount > 0,
      href: '/admin/shipping',
    },
    {
      key: 'shipping-rate',
      label: 'Add a shipping rate so customers can check out',
      done: state.shippingRateCount > 0,
      href: '/admin/shipping',
    },
  ];
}
