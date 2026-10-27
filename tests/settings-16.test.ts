import { describe, expect, it } from 'vitest';
import { buildSetupChecklist } from '../web/src/lib/setup-checklist';

describe('Phase 16 setup checklist', () => {
  it('marks every step incomplete for an empty store', () => {
    const items = buildSetupChecklist({
      productCount: 0,
      shippingZoneCount: 0,
      shippingRateCount: 0,
      storeName: '',
      currency: '',
    });
    expect(items.every((i) => !i.done)).toBe(true);
  });

  it('derives completion from verifiable state only', () => {
    const items = buildSetupChecklist({
      productCount: 3,
      shippingZoneCount: 1,
      shippingRateCount: 0,
      storeName: 'Fully Flared',
      currency: 'USD',
    });
    expect(items.find((i) => i.key === 'first-product')?.done).toBe(true);
    expect(items.find((i) => i.key === 'shipping-rate')?.done).toBe(false);
    expect(items.find((i) => i.key === 'store-identity')?.done).toBe(true);
  });
});
