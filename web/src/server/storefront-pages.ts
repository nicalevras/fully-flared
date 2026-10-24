import { notFound, redirect } from '@tanstack/react-router';
import {
  getStorefrontLayout,
  listPublishedPosts,
  readEditorialDocument,
  readProductDocument,
  type CatalogKv,
} from './catalog-read';
import { getPublishedCollection } from './catalog-discovery';

type StorefrontEnv = { CATALOG_KV?: CatalogKv };

async function movedPath(db: D1Database, fromPath: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT to_path FROM redirects WHERE from_path = ?')
    .bind(fromPath)
    .first<{ to_path: string }>();
  return row?.to_path ?? null;
}

/** `beforeFallback` runs only when KV has no slug pointer, before D1 is asked. */
export async function loadProductPage(
  db: D1Database,
  env: StorefrontEnv,
  slug: string,
  beforeFallback: () => Promise<void>
) {
  const [layout, doc] = await Promise.all([
    getStorefrontLayout(db, env),
    readProductDocument(db, env.CATALOG_KV, slug, beforeFallback),
  ]);
  if (doc && 'redirect' in doc) throw redirect({ to: doc.redirect, statusCode: 301 });
  if (doc && doc.status === 'active') return { layout, doc };
  const moved = await movedPath(db, `/products/${slug}`);
  if (moved) throw redirect({ to: moved, statusCode: 301 });
  throw notFound();
}

export async function loadPostPage(db: D1Database, env: StorefrontEnv, slug: string) {
  const [layout, doc] = await Promise.all([
    getStorefrontLayout(db, env),
    readEditorialDocument(db, env.CATALOG_KV, 'post', slug),
  ]);
  if (doc && 'redirect' in doc) throw redirect({ to: doc.redirect, statusCode: 301 });
  if (doc) return { layout, doc };
  const moved = await movedPath(db, `/blog/${slug}`);
  if (moved) throw redirect({ to: moved, statusCode: 301 });
  throw notFound();
}

export async function loadEditorialPage(db: D1Database, env: StorefrontEnv, slug: string) {
  const [layout, doc] = await Promise.all([
    getStorefrontLayout(db, env),
    readEditorialDocument(db, env.CATALOG_KV, 'page', slug),
  ]);
  if (!doc || 'redirect' in doc) throw notFound();
  return { layout, doc };
}

export async function loadCollectionPage(
  db: D1Database,
  env: StorefrontEnv,
  slug: string,
  page: number
) {
  const [layout, result] = await Promise.all([
    getStorefrontLayout(db, env),
    getPublishedCollection(db, env, slug, page),
  ]);
  if (!result) throw notFound();
  return { layout, result };
}

export async function loadPostsIndex(db: D1Database, env: StorefrontEnv, page: number) {
  const [layout, posts] = await Promise.all([
    getStorefrontLayout(db, env),
    listPublishedPosts(db, env, page),
  ]);
  return { layout, posts };
}
