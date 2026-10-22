// Focused local-only checkpoint. Every child status is captured before log I/O.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const logDir = resolve(process.argv[2] ?? join(tmpdir(), `store-reclamation-${Date.now()}`));
mkdirSync(logDir, { recursive: true });
const files = [
  'web/src/db/schema.ts',
  'web/src/server/catalog-gc.ts',
  'web/src/server/catalog-exec.ts',
  'web/src/server/catalog-publisher.ts',
  'web/src/server/operations.ts',
  'tests/catalog-reclamation.test.ts',
  'tests/helpers/catalog-queue.ts',
  'web/scripts/verify-reclamation.mjs',
  'web/scripts/load-gate.mjs',
];
const gates = [
  ['focused', ['node_modules/vitest/vitest.mjs', 'run', 'tests/catalog-reclamation.test.ts']],
  ['lint', ['node_modules/eslint/bin/eslint.js', ...files]],
  ['typecheck', ['web/node_modules/typescript/bin/tsc', '-p', 'web/tsconfig.json', '--noEmit']],
  ['migration-check', ['web/scripts/check-migrations.mjs']],
  ['format', ['node_modules/prettier/bin/prettier.cjs', '--check', ...files]],
];
for (const [name, args] of gates) {
  const child = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  const code = child.status ?? 1;
  writeFileSync(
    join(logDir, `${name}.log`),
    `${child.stdout ?? ''}${child.stderr ?? ''}${child.error ? String(child.error) : ''}\nEXITCODE: ${code}\n`
  );
  console.log(`${name}: EXITCODE ${code}`);
  if (code !== 0) {
    console.error(`Stopped. Logs: ${logDir}`);
    process.exit(code);
  }
}
console.log(`Focused checkpoint passed. Logs: ${logDir}`);
