import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith('.tsx')
        ? [join(dir, e.name)]
        : []
  );
}

const surfaces: Record<string, 'left' | 'right'> = {
  'web/src/routes/__root.tsx': 'left',
  'web/src/components/AdminNav.tsx': 'left',
  'web/src/components/CartDrawer.tsx': 'right',
  'web/src/components/ProductCreateDrawer.tsx': 'right',
  'web/src/components/ProductEditor.tsx': 'right',
  'web/src/components/BlogPostEditor.tsx': 'right',
  'web/src/components/PageEditor.tsx': 'right',
  'web/src/routes/admin/collections.tsx': 'right',
  'web/src/routes/admin/discounts.tsx': 'right',
  'web/src/routes/admin/inventory.tsx': 'right',
  'web/src/routes/admin/media.tsx': 'right',
  'web/src/routes/admin/articles.tsx': 'right',
  'web/src/routes/admin/pages.tsx': 'right',
  'web/src/routes/admin/products/index.tsx': 'right',
};

describe('sheets to drawers migration', () => {
  it('leaves no Sheet usage in web/src and deletes the sheet primitive', () => {
    for (const file of sources('web/src')) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/<Sheet[\s>]/);
      expect(source, file).not.toContain('ui/sheet');
      expect(source, file).not.toContain('Sheet');
    }
    expect(existsSync('web/src/components/ui/sheet.tsx')).toBe(false);
    expect(existsSync('web/src/components/ui/drawer.tsx')).toBe(true);
  });

  it('matches the base-rhea drawer source classes exactly', () => {
    const drawer = readFileSync('web/src/components/ui/drawer.tsx', 'utf8');
    expect(drawer).toContain('supports-backdrop-filter:backdrop-blur-sm');
    expect(drawer).toContain('rounded-[min(var(--radius-4xl),24px)]');
    expect(drawer).toContain('[--drawer-inset:--spacing(2)]');
    expect(drawer).toContain('[--drawer-bleed-background:transparent]');
    expect(drawer).toContain('shadow-xl');
    expect(drawer).toContain('after:h-[100px]');
    expect(drawer).toContain(
      'p-4 pb-0 group-data-[swipe-axis=y]/drawer-popup:text-center md:gap-1.5 md:text-left'
    );
    expect(drawer).toContain('mt-auto flex shrink-0 flex-col gap-2 p-4 pt-0');
    expect(readFileSync('web/src/styles.css', 'utf8')).toContain('position: relative');
  });

  it('gives every admin drawer the collections width', () => {
    const adminFiles = [
      'web/src/components/ProductEditor.tsx',
      'web/src/components/ProductCreateDrawer.tsx',
      'web/src/components/BlogPostEditor.tsx',
      'web/src/components/PageEditor.tsx',
      'web/src/routes/admin/collections.tsx',
      'web/src/routes/admin/discounts.tsx',
      'web/src/routes/admin/media.tsx',
      'web/src/routes/admin/inventory.tsx',
      'web/src/routes/admin/articles.tsx',
      'web/src/routes/admin/pages.tsx',
      'web/src/routes/admin/products/index.tsx',
    ];
    const classes = new Set<string>();
    for (const file of adminFiles) {
      const source = readFileSync(file, 'utf8');
      const found = [...source.matchAll(/<DrawerContent[^>]*?className="([^"]+)"/gs)].map(
        (m) => m[1] ?? ''
      );
      expect(found.length, file).toBeGreaterThan(0);
      for (const cls of found) {
        expect(cls, file).toContain('sm:max-w-2xl');
        expect(cls, file).not.toContain('sm:max-w-4xl');
        classes.add(cls);
      }
    }
    expect(classes.size).toBe(1);
  });

  it('opens admin drawers instantly with no transition', () => {
    const drawer = readFileSync('web/src/components/ui/drawer.tsx', 'utf8');
    expect(drawer).toContain('instant');
    expect(drawer).toContain('transition-none');
    const adminFiles = [
      'web/src/components/AdminNav.tsx',
      'web/src/components/ProductEditor.tsx',
      'web/src/components/ProductCreateDrawer.tsx',
      'web/src/components/BlogPostEditor.tsx',
      'web/src/components/PageEditor.tsx',
      'web/src/routes/admin/collections.tsx',
      'web/src/routes/admin/discounts.tsx',
      'web/src/routes/admin/media.tsx',
      'web/src/routes/admin/inventory.tsx',
      'web/src/routes/admin/articles.tsx',
      'web/src/routes/admin/pages.tsx',
      'web/src/routes/admin/products/index.tsx',
    ];
    for (const file of adminFiles) {
      const source = readFileSync(file, 'utf8');
      const roots = [...source.matchAll(/<Drawer\b[^>]*>/gs)].map((m) => m[0]);
      expect(roots.length, file).toBeGreaterThan(0);
      for (const root of roots) {
        expect(root, file).toContain('instant');
      }
    }
    for (const file of ['web/src/components/CartDrawer.tsx', 'web/src/routes/__root.tsx']) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('instant');
    }
  });

  it('layers ConfirmDialog above the drawer', () => {
    expect(readFileSync('web/src/components/ConfirmDialog.tsx', 'utf8')).toContain(
      'fixed inset-0 z-[60]'
    );
  });

  it('builds the drawer on Base UI with the current side as swipe direction', () => {
    const drawer = readFileSync('web/src/components/ui/drawer.tsx', 'utf8');
    expect(drawer).toContain('@base-ui/react/drawer');
    for (const [file, side] of Object.entries(surfaces)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain(`swipeDirection="${side}"`);
      expect(source, file).toContain('<DrawerClose');
      expect(source, file).not.toContain('DrawerTrigger asChild');
    }
  });

  it('keeps the dirty-close guards on the controlled onOpenChange', () => {
    for (const file of [
      'web/src/components/ProductEditor.tsx',
      'web/src/components/BlogPostEditor.tsx',
      'web/src/components/PageEditor.tsx',
    ]) {
      expect(readFileSync(file, 'utf8')).toContain('if (!next) requestClose();');
    }
    expect(readFileSync('web/src/routes/admin/collections.tsx', 'utf8')).toContain(
      'detailsDirtyOf(editingCollection)'
    );
    expect(readFileSync('web/src/routes/admin/discounts.tsx', 'utf8')).toContain(
      'setConfirmDiscard(true)'
    );
  });
});
