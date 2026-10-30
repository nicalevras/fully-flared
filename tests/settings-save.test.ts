import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import {
  saveSettings,
  type SettingsAction,
  type SettingsSnapshot,
} from '../web/src/lib/settings-save';
import {
  ADMISSION_DEFINITIONS,
  ADMISSION_KEYS,
  LIMIT_DEFINITIONS,
  LIMIT_KEYS,
} from '../web/src/lib/settings-definitions';

const initial: SettingsSnapshot = {
  limits: Object.fromEntries(LIMIT_KEYS.map((key) => [key, LIMIT_DEFINITIONS[key].default])),
  admission: Object.fromEntries(
    ADMISSION_KEYS.map((key) => [key, ADMISSION_DEFINITIONS[key].default])
  ),
  form: { store_name: 'Shop', currency: 'USD', canonical_base_url: 'https://shop.invalid' },
  tax: { enabled: false, confirmed: false },
};
const versions = { store_name: '2026-10-01T00:00:00.000Z' };

function fakeAction(result: Awaited<ReturnType<SettingsAction>> = { ok: true }) {
  const calls: Array<Parameters<SettingsAction>> = [];
  const action: SettingsAction = async (...args) => {
    calls.push(args);
    return result;
  };
  return { action, calls };
}

describe('settings save flow', () => {
  it('unchanged keys are not written; changed keys go in one setMany with their versions', async () => {
    const { action, calls } = fakeAction();
    const next = {
      ...initial,
      form: { ...initial.form, store_name: 'New shop' },
      tax: { enabled: true, confirmed: false },
    };

    expect(await saveSettings(action, { initial, next, versions })).toEqual({ ok: true });
    expect(calls).toEqual([
      [
        'settings.setMany',
        {
          changes: [
            { key: 'store_name', value: 'New shop', expectedUpdatedAt: versions.store_name },
            { key: 'stripe_tax_enabled', value: '1', expectedUpdatedAt: null },
          ],
        },
      ],
    ]);
  });

  it('an untouched form sends nothing', async () => {
    const { action, calls } = fakeAction();
    expect(await saveSettings(action, { initial, next: initial, versions })).toEqual({ ok: true });
    expect(calls).toEqual([]);
  });

  it('a refused batch reports its error and conflict', async () => {
    const { action } = fakeAction({ ok: false, error: 'Changed elsewhere', conflict: true });
    const next = { ...initial, form: { ...initial.form, store_name: 'New shop' } };
    expect(await saveSettings(action, { initial, next, versions })).toEqual({
      ok: false,
      error: 'Changed elsewhere',
      conflict: true,
    });
  });

  it('out-of-range limits are refused before anything is sent', async () => {
    const { action, calls } = fakeAction();
    const next = { ...initial, limits: { ...initial.limits, cart_max_qty: 0 } };
    expect(await saveSettings(action, { initial, next, versions })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});

describe('settings.setMany', () => {
  let db: D1Database, env: Cloudflare.Env, dispose: () => Promise<void>;
  const owner = { id: 'owner', role: 'owner' };
  const stamp = '2026-10-01T00:00:00.000Z';

  beforeEach(async () => {
    ({ db, env, dispose } = await createTestDb());
    await db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('store_name', 'Shop', ?), ('announcement_text', 'Hi', ?)"
      )
      .bind(stamp, stamp)
      .run();
  });
  afterEach(async () => {
    await dispose();
  });

  const value = async (key: string) =>
    (await db
      .prepare('SELECT value, updated_at FROM settings WHERE key = ?')
      .bind(key)
      .first<{ value: string; updated_at: string }>()) ?? null;
  const audited = async () =>
    (
      await db
        .prepare(
          "SELECT entity_id FROM audit_log WHERE action LIKE 'settings.%' ORDER BY entity_id"
        )
        .all<{ entity_id: string }>()
    ).results.map((r) => r.entity_id);

  it('a failing key writes none', async () => {
    await db
      .prepare(
        "CREATE TRIGGER fail_announcement BEFORE UPDATE ON settings WHEN NEW.key = 'announcement_text' BEGIN SELECT RAISE(ABORT, 'forced setting failure'); END"
      )
      .run();
    const result = await runAdminAction(db, env, owner, 'settings.setMany', {
      changes: [
        { key: 'store_name', value: 'New shop', expectedUpdatedAt: stamp },
        { key: 'announcement_text', value: 'Sale', expectedUpdatedAt: stamp },
      ],
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result).not.toHaveProperty('conflict');
    expect(await value('store_name')).toEqual({ value: 'Shop', updated_at: stamp });
    expect(await audited()).toEqual([]);
  });

  it('a stale version is a conflict and writes none', async () => {
    const result = await runAdminAction(db, env, owner, 'settings.setMany', {
      changes: [
        { key: 'store_name', value: 'New shop', expectedUpdatedAt: stamp },
        { key: 'announcement_text', value: 'Sale', expectedUpdatedAt: '2026-09-01T00:00:00.000Z' },
      ],
    });
    expect(result).toMatchObject({ ok: false, conflict: true, status: 409 });
    expect((await value('store_name'))?.value).toBe('Shop');
    expect(await audited()).toEqual([]);
  });

  it('a key first saved elsewhere is a conflict for a page that saw it unset', async () => {
    const result = await runAdminAction(db, env, owner, 'settings.setMany', {
      changes: [{ key: 'store_name', value: 'New shop', expectedUpdatedAt: null }],
    });
    expect(result).toMatchObject({ ok: false, conflict: true });
  });

  it('writes and audits only the keys whose value changed', async () => {
    const result = await runAdminAction(db, env, owner, 'settings.setMany', {
      changes: [
        { key: 'store_name', value: 'Shop', expectedUpdatedAt: stamp },
        { key: 'announcement_text', value: 'Sale', expectedUpdatedAt: stamp },
        { key: 'seo_title_template', value: '{product} | Shop', expectedUpdatedAt: null },
      ],
    });
    expect(result).toEqual({ ok: true });
    expect(await value('store_name')).toEqual({ value: 'Shop', updated_at: stamp });
    expect((await value('announcement_text'))?.value).toBe('Sale');
    expect((await value('seo_title_template'))?.value).toBe('{product} | Shop');
    expect(await audited()).toEqual(['announcement_text', 'seo_title_template']);
  });

  it('a key the page cannot change refuses the whole batch', async () => {
    const result = await runAdminAction(db, env, owner, 'settings.setMany', {
      changes: [
        { key: 'announcement_text', value: 'Sale', expectedUpdatedAt: stamp },
        { key: 'commerce_revision', value: '9', expectedUpdatedAt: null },
      ],
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((await value('announcement_text'))?.value).toBe('Hi');
  });
});
