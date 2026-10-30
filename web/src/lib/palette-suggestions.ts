export function createPaletteSuggestionsCache<T>() {
  let cached: T[] | null = null;
  let pending: Promise<T[]> | null = null;

  return {
    read: () => cached,
    load(fetchSuggestions: () => Promise<T[]>): Promise<T[]> {
      if (cached !== null) return Promise.resolve(cached);
      if (pending) return pending;
      pending = fetchSuggestions().then(
        (cards) => {
          cached = cards;
          pending = null;
          return cards;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        }
      );
      return pending;
    },
  };
}
