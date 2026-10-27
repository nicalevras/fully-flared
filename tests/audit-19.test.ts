import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function adminRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...adminRouteFiles(path));
    else if (name.endsWith('.tsx') || name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('Phase 19 consistency audit', () => {
  it('no admin route uses a browser native confirm dialog', () => {
    const offenders = adminRouteFiles('web/src/routes/admin').filter((file) =>
      readFileSync(file, 'utf8').includes('window.confirm')
    );
    expect(offenders).toEqual([]);
  });
});
