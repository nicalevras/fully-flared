// Isolated D1 races and inventory invariants; never opens a payment session.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    cli,
    'run',
    'tests/checkout-caps.test.ts',
    'tests/reserve-guards.test.ts',
    'tests/commerce-safety.test.ts',
  ],
  { cwd: root, stdio: 'inherit', shell: false }
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
