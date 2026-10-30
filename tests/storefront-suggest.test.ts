import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import {
  getPaletteSuggestions,
  suggestCatalog,
  SUGGEST_SIZE,
} from '../web/src/server/catalog-discovery';

let db: D1Database, dispose: () => Promise<void>;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  for (let i = 1; i <= 10; i++) {
    const id = `p${i}`;
    await db
      .prepare(
        `INSERT INTO products (id, slug, title, description, status, created_at, updated_at)
         VALUES (?, ?, ?, '', 'active', ?, ?)`
      )
      .bind(
        id,
        `hat-${i}`,
        `Cotton Hat ${i}`,
        `2026-01-${String(i).padStart(2, '0')}`,
        '2026-01-01'
      )
      .run();
    await db
      .prepare(
        `INSERT INTO catalog_cards (product_id, slug, card_json, revision, doc_revision, updated_at)
         VALUES (?, ?, ?, 'r', 'r', '2026-01-01')`
      )
      .bind(
        id,
        `hat-${i}`,
        JSON.stringify({
          id,
          slug: `hat-${i}`,
          title: `Cotton Hat ${i}`,
          status: 'active',
          priceCents: 1000,
          imageKey: null,
        })
      )
      .run();
  }
});

afterEach(async () => {
  await dispose();
});

describe('storefront search suggestions', () => {
  it('caps suggestions at SUGGEST_SIZE and reports that more matches exist', async () => {
    const result = await suggestCatalog(db, {}, 'cotton hat');
    expect(result.cards).toHaveLength(SUGGEST_SIZE);
    expect(result.hasMore).toBe(true);
  });

  it('fails loudly on a published card that is not a card', async () => {
    await db
      .prepare(`UPDATE catalog_cards SET card_json = ? WHERE product_id = 'p10'`)
      .bind(JSON.stringify({ id: 'p10', slug: 'hat-10', title: 'Cotton Hat 10' }))
      .run();
    await expect(suggestCatalog(db, {}, 'cotton hat')).rejects.toThrow();
  });

  it('palette suggestions are empty when no listing is published', async () => {
    expect(await getPaletteSuggestions(db, {})).toEqual([]);
  });

  it('does not search below three characters', async () => {
    expect(await suggestCatalog(db, {}, 'co')).toEqual({ cards: [], hasMore: false });
    expect((await suggestCatalog(db, {}, 'cot')).cards.length).toBeGreaterThan(0);
  });
});

describe('storefront search palette wiring', () => {
  it('matches the shadcn palette classes and keeps one shared keyboard model', () => {
    const palette = readFileSync('web/src/components/SearchPalette.tsx', 'utf8');
    expect(palette).toContain('rounded-3xl bg-popover p-2');
    expect(palette).not.toContain('border-input');
    expect(palette).not.toContain('bg-zinc-50');
    expect(palette).toContain('min-h-72');
    expect(palette).toContain('Skeleton');
    expect(palette).toContain('>Results</p>');
    expect(palette).toContain('(pointer: fine)');
    expect(palette).toContain('<Dialog.Root');
    expect(palette).toContain('<Dialog.Portal>');
    expect(palette).toContain('<Dialog.Close');
    expect(palette).not.toContain('autoFocus');
    expect(palette).toContain('max-h-72 min-h-72');
    expect(palette).toContain('min-h-0 flex-1 scroll-py-1');
    expect(palette).toContain('px-2 py-1.5 text-xs font-medium text-muted-foreground');
    expect(palette).toContain('rounded-xl px-2 py-1.5');
    expect(palette).toContain('bg-muted text-foreground');
    expect(palette).toContain('No results found.');
    expect(palette).toContain("to: '/search'");
    expect(palette).toContain('View all results');
    expect(palette).not.toContain('suggestionCards');
    expect(palette).toContain('Suggested');
    const shop = readFileSync('web/src/routes/_shop.shop.tsx', 'utf8');
    expect(shop).toContain('openSearchPalette');
    expect(shop).not.toContain('to="/search"');
    const root = readFileSync('web/src/routes/__root.tsx', 'utf8');
    expect(root).toContain('<SearchPaletteDialog />');
    expect(root).toContain('openSearchPalette');
    const admin = readFileSync('web/src/components/GlobalSearch.tsx', 'utf8');
    expect(admin).not.toContain('Math.min(a + 1');
  });

  it('keeps server-only modules out of the client module graph', () => {
    const palette = readFileSync('web/src/components/SearchPalette.tsx', 'utf8');
    expect(palette).not.toMatch(/^import .* from '@tanstack\/react-start\/server'/m);
    expect(palette).not.toMatch(/^import .* from '\.\.\/server\/catalog-discovery'/m);
    expect(palette).not.toMatch(/^import .* from '\.\.\/server\/storefront-limit'/m);
    expect(palette).toContain("await import('@tanstack/react-start/server')");
    expect(palette).toContain("await import('../server/catalog-discovery')");
    expect(palette).toContain("await import('../server/storefront-limit')");
  });
});
