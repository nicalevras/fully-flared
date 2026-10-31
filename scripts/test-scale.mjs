import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const result = spawnSync(
  process.execPath,
  [vitest, 'run', 'tests/catalog-scale-100k.test.ts', ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, CATALOG_SCALE: '1' } }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
