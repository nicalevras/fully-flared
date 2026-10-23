// Sitemap protocol (sitemaps.org): at most 50,000 URLs per file, so the
// index lists keyset-paged children instead of one unbounded urlset.

/** URLs per child sitemap. */
export const SITEMAP_CHUNK = 10_000;

const LIVE_POST = `((status = 'published' AND (published_at IS NULL OR datetime(published_at) <= datetime('now'))) OR (status = 'scheduled' AND published_at IS NOT NULL AND datetime(published_at) <= datetime('now')))`;

const PAGED = {
  products: {
    table: 'products',
    where: "status = 'active'",
    lastmod: 'updated_at',
    path: 'products',
  },
  collections: { table: 'collections', where: '1 = 1', lastmod: 'NULL', path: 'collections' },
  posts: { table: 'posts', where: LIVE_POST, lastmod: 'published_at', path: 'blog' },
} as const;
type PagedKind = keyof typeof PAGED;
const isPagedKind = (kind: string): kind is PagedKind => Object.hasOwn(PAGED, kind);

const CURSOR = /^[A-Za-z0-9_-]{0,100}$/;

const escXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function urlset(urls: { loc: string; lastmod?: string | null }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map(
      (u) =>
        `  <url><loc>${escXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ''}</url>`
    )
    .join('\n')}\n</urlset>`;
}

/** The sitemap index: one child for fixed routes and pages, then one
 *  child per `SITEMAP_CHUNK` rows of each paged kind, keyed by first id. */
export async function sitemapIndex(db: D1Database, base: string): Promise<string> {
  const kinds = Object.keys(PAGED).filter(isPagedKind);
  const starts = await Promise.all(
    kinds.map((kind) =>
      db
        .prepare(
          `SELECT id FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS rn FROM ${PAGED[kind].table} WHERE ${PAGED[kind].where}) WHERE rn % ${SITEMAP_CHUNK} = 0 ORDER BY id`
        )
        .all<{ id: string }>()
    )
  );
  const locs = [
    `${base}/sitemap/pages.xml`,
    ...kinds.flatMap((kind, i) =>
      (starts[i]?.results ?? []).map(
        (row) => `${base}/sitemap/${kind}.xml?from=${encodeURIComponent(row.id)}`
      )
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs
    .map((loc) => `  <sitemap><loc>${escXml(loc)}</loc></sitemap>`)
    .join('\n')}\n</sitemapindex>`;
}

/** One child sitemap, or null for an unknown kind or malformed cursor. */
export async function sitemapChild(
  db: D1Database,
  base: string,
  kind: string,
  from: string | null
): Promise<string | null> {
  if (kind === 'pages') {
    const pages = await db.prepare('SELECT slug FROM pages').all<{ slug: string }>();
    return urlset([
      { loc: `${base}/` },
      { loc: `${base}/shop` },
      { loc: `${base}/blog` },
      ...pages.results.map((p) => ({ loc: `${base}/pages/${p.slug}` })),
    ]);
  }
  if (!isPagedKind(kind) || !CURSOR.test(from ?? '')) return null;
  const spec = PAGED[kind];
  const rows = await db
    .prepare(
      `SELECT slug, ${spec.lastmod} AS lastmod FROM ${spec.table} WHERE ${spec.where} AND id >= ? ORDER BY id LIMIT ${SITEMAP_CHUNK}`
    )
    .bind(from ?? '')
    .all<{ slug: string; lastmod: string | null }>();
  return urlset(
    rows.results.map((r) => ({ loc: `${base}/${spec.path}/${r.slug}`, lastmod: r.lastmod }))
  );
}

export function sitemapResponse(xml: string): Response {
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=3600' },
  });
}
