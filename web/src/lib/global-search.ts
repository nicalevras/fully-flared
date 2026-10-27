export type SearchGate = {
  begin: () => number;
  invalidate: () => void;
  isCurrent: (token: number, responseQuery: string, currentQuery: string) => boolean;
};

export function createSearchGate(): SearchGate {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    invalidate() {
      current += 1;
    },
    isCurrent(token, responseQuery, currentQuery) {
      const query = currentQuery.trim();
      return token === current && query.length >= 2 && query === responseQuery.trim();
    },
  };
}

export async function runLatestSearch<T>(
  gate: SearchGate,
  query: string,
  currentQuery: () => string,
  search: (query: string) => Promise<T>
): Promise<{ applied: true; value: T } | { applied: false }> {
  const token = gate.begin();
  try {
    const value = await search(query);
    return gate.isCurrent(token, query, currentQuery())
      ? { applied: true, value }
      : { applied: false };
  } catch (error) {
    if (!gate.isCurrent(token, query, currentQuery())) return { applied: false };
    throw error;
  }
}
