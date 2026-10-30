// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  draftKey,
  memoryDraftStore,
  parseDraft,
  serializeDraft,
  DRAFT_FORMAT_VERSION,
  type DraftEntityType,
} from '@/lib/draft-recovery';

const store = memoryDraftStore();

vi.mock('@/lib/draft-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/draft-recovery')>()),
  indexedDbDraftStore: () => store,
}));

const { useDraftRecovery } = await import('@/lib/use-draft-recovery');

const server = { title: 'Live title' };
const entityType: DraftEntityType = 'post';
const key = draftKey('staff-1', 'post', 'post-1');
const props = (currentFields: Record<string, string>) => ({
  staffId: 'staff-1',
  entityType,
  entityId: 'post-1',
  baseUpdatedAt: '2026-01-01T00:00:00.000Z',
  serverFields: server,
  currentFields,
});

it('offers a stored draft and keeps it while the offer is on screen', async () => {
  store.map.clear();
  await store.set(
    key,
    serializeDraft({
      version: DRAFT_FORMAT_VERSION,
      staffId: 'staff-1',
      entityType: 'post',
      entityId: 'post-1',
      baseUpdatedAt: '2026-01-01T00:00:00.000Z',
      savedAt: 1,
      fields: { title: 'Unsaved title' },
    })
  );
  const { result } = renderHook(() => useDraftRecovery(props(server)));
  await waitFor(() => expect(result.current.recovery?.draft.fields.title).toBe('Unsaved title'));
  expect(store.map.has(key)).toBe(true);
});

it('saves the latest edited fields after a pause and removes the draft once clean', async () => {
  store.map.clear();
  const { result, rerender } = renderHook(
    (fields: Record<string, string>) => useDraftRecovery(props(fields)),
    { initialProps: server }
  );
  rerender({ title: 'Edit one' });
  rerender({ title: 'Edit two' });
  await waitFor(() => expect(result.current.savedAt).not.toBeNull());
  expect(parseDraft(await store.get(key), 'staff-1', 'post', 'post-1')?.fields).toEqual({
    title: 'Edit two',
  });
  rerender(server);
  await waitFor(() => expect(store.map.has(key)).toBe(false));
});
