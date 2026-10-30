import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  draftKey,
  evaluateRecovery,
  memoryDraftStore,
  parseDraft,
  serializeDraft,
  type DraftRecord,
} from '../web/src/lib/draft-recovery';

function record(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    version: 1,
    staffId: 'staff-1',
    entityType: 'post',
    entityId: 'post-1',
    baseUpdatedAt: '2026-01-01T00:00:00.000Z',
    savedAt: 1000,
    fields: { title: 'Draft title', contentHtml: '<p>Unsaved</p>' },
    ...overrides,
  };
}

describe('Phase 12 draft recovery contract', () => {
  it('scopes keys by staff, entity type, and entity', () => {
    expect(draftKey('staff-1', 'post', 'post-1')).toBe('ff-draft:v1:staff-1:post:post-1');
    expect(draftKey('staff-2', 'post', 'post-1')).not.toBe(draftKey('staff-1', 'post', 'post-1'));
  });

  it('rejects other versions, other staff, and corrupt payloads', async () => {
    const store = memoryDraftStore();
    const key = draftKey('staff-1', 'post', 'post-1');
    await store.set(key, serializeDraft(record()));
    expect(parseDraft(await store.get(key), 'staff-1', 'post', 'post-1')?.fields.title).toBe(
      'Draft title'
    );
    expect(parseDraft(await store.get(key), 'staff-2', 'post', 'post-1')).toBeNull();
    await store.set(key, serializeDraft(record({ version: 99 })));
    expect(parseDraft(await store.get(key), 'staff-1', 'post', 'post-1')).toBeNull();
    await store.set(key, '{not json');
    expect(parseDraft(await store.get(key), 'staff-1', 'post', 'post-1')).toBeNull();
  });

  it('offers recovery, flags a newer server version as stale, and discards identical drafts', () => {
    const draft = record();
    const current = { title: 'Published title', contentHtml: '<p>Live</p>' };
    expect(evaluateRecovery(draft, '2026-01-01T00:00:00.000Z', current)).toEqual({
      action: 'offer',
      stale: false,
    });
    expect(evaluateRecovery(draft, '2026-02-01T00:00:00.000Z', current)).toEqual({
      action: 'offer',
      stale: true,
    });
    expect(evaluateRecovery(draft, '2026-01-01T00:00:00.000Z', draft.fields)).toEqual({
      action: 'discard',
      reason: 'same-as-current',
    });
  });
});

describe('FF-06: clean-state cleanup cannot race the recovery read', () => {
  it('never removes before the read settles or while an offer is shown', async () => {
    const { shouldRemoveDraftOnClean } = await import('../web/src/lib/draft-recovery');
    expect(shouldRemoveDraftOnClean({ readSettled: false, recoveryShown: false })).toBe(false);
    expect(shouldRemoveDraftOnClean({ readSettled: false, recoveryShown: true })).toBe(false);
    expect(shouldRemoveDraftOnClean({ readSettled: true, recoveryShown: true })).toBe(false);
    expect(shouldRemoveDraftOnClean({ readSettled: true, recoveryShown: false })).toBe(true);
  });
});

describe('FF-06 release gate: draft recovery ships disabled', () => {
  it('neither editor wires the recovery hook', () => {
    for (const file of [
      'web/src/routes/admin/blog_/$id.tsx',
      'web/src/routes/admin/pages_/$id.tsx',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toContain('useDraftRecovery');
      expect(source, file).not.toContain('Saved on this device');
    }
  });
});
