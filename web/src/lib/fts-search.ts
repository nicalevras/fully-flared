// FTS5 MATCH builders for admin toolbar search. User input is always quoted,
// so it cannot inject FTS operators (same approach as catalog-discovery).
// All admin FTS tables use the trigram tokenizer (substring match); they need
// >= 3 chars to hit the index, so below that callers return an empty page
// instead of falling back to a substring LIKE scan.
// ftsTitleMatch remains only for the pre-existing unicode61 products_fts,
// whose word-prefix behavior the storefront already depends on.
export function ftsPhrase(q: string): string {
  return `"${q.replaceAll('"', '""')}"`;
}

export function ftsTitleMatch(column: string, q: string): string {
  const terms = q
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => {
      const quoted = `"${term.replaceAll('"', '""')}"`;
      return [...term].length >= 3 ? `${quoted}*` : quoted;
    });
  return `${column} : (${terms.join(' AND ')})`;
}

// Prefix LIKE on B-tree-indexed columns (SKU, discount code, order number/email)
// stays at any length: the index serves it. Only substring search needs >= 3.
export function ftsUsable(q: string): boolean {
  return [...q.trim()].length >= 3;
}

// Escape LIKE wildcards in user input; pair with ESCAPE '\' in the SQL.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
