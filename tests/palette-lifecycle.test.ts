import { describe, expect, it, vi } from 'vitest';
import { createPaletteSuggestionsCache } from '../web/src/lib/palette-suggestions';
import { createSearchGate, runLatestSearch } from '../web/src/lib/global-search';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('palette suggestions across openings', () => {
  it('reuses an unfinished request and keeps its result after the first opening closes', async () => {
    const resource = createPaletteSuggestionsCache<string>();
    const request = deferred<string[]>();
    const load = vi.fn(() => request.promise);
    const firstOpening = resource.load(load);
    const reopened = resource.load(load);
    expect(load).toHaveBeenCalledTimes(1);
    request.resolve(['hat']);
    await expect(firstOpening).resolves.toEqual(['hat']);
    await expect(reopened).resolves.toEqual(['hat']);
    expect(resource.read()).toEqual(['hat']);
    await expect(resource.load(load)).resolves.toEqual(['hat']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('caches a successful empty catalog', async () => {
    const resource = createPaletteSuggestionsCache<string>();
    const load = vi.fn(async () => []);
    await resource.load(load);
    await resource.load(load);
    expect(resource.read()).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed opening instead of caching failure as an empty catalog', async () => {
    const resource = createPaletteSuggestionsCache<string>();
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(['mug']);
    await expect(resource.load(load)).rejects.toThrow('offline');
    expect(resource.read()).toBeNull();
    await expect(resource.load(load)).resolves.toEqual(['mug']);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('palette query changes during debounce', () => {
  it.each(['success', 'failure'] as const)(
    'ignores stale %s before the new request starts',
    async (completion) => {
      const gate = createSearchGate();
      const request = deferred<string>();
      let query = 'hat';
      const outcome = runLatestSearch(
        gate,
        query,
        () => query,
        () => request.promise
      );
      gate.invalidate();
      query = 'shirt';
      if (completion === 'success') request.resolve('old hat');
      else request.reject(new Error('old request failed'));
      await expect(outcome).resolves.toEqual({ applied: false });
    }
  );

  it('does not revive an earlier request when the same query is typed again', async () => {
    const gate = createSearchGate();
    const request = deferred<string>();
    const outcome = runLatestSearch(
      gate,
      'hat',
      () => 'hat',
      () => request.promise
    );
    gate.invalidate();
    gate.invalidate();
    request.resolve('old hat');
    await expect(outcome).resolves.toEqual({ applied: false });
  });
});
