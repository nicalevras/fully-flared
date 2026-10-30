import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import { calculateDiscount } from '../web/src/server/checkout';
import { localDateTimeInputToIso } from '../web/src/lib/format';

let db: D1Database, env: Cloudflare.Env, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };

beforeEach(async () => {
  ({ db, env, dispose } = await createTestDb());
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await dispose();
});

describe('MS-1 discount expiry is an exact instant', () => {
  it('a code expiring 2026-11-30T23:59 local is still valid at 2026-11-30T23:00Z', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    const created = await runAdminAction(db, env, owner, 'discount.create', {
      code: 'NOV',
      type: 'percentage',
      value: 10,
      expiresAt: localDateTimeInputToIso('2026-11-30T23:59'),
    });
    expect(created.ok).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-30T23:00:00.000Z'));
    expect(await calculateDiscount(db, 'NOV', 2000, null)).not.toBeNull();
    vi.setSystemTime(new Date('2026-12-01T05:00:00.000Z'));
    expect(await calculateDiscount(db, 'NOV', 2000, null)).toBeNull();
  });

  it('admin rejects a date-only expiresAt', async () => {
    const created = await runAdminAction(db, env, owner, 'discount.create', {
      code: 'DATEONLY',
      type: 'percentage',
      value: 10,
      expiresAt: '2026-11-30',
    });
    expect(created.ok).toBe(false);
    const row = await db.prepare("SELECT 1 FROM discounts WHERE code = 'DATEONLY'").first();
    expect(row).toBeNull();
  });
});
