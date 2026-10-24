import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';

const web = resolve(__dirname, '../web');
let copy: string;

beforeAll(() => {
  copy = mkdtempSync(join(tmpdir(), 'check-migrations-'));
  mkdirSync(join(copy, 'scripts'));
  mkdirSync(join(copy, 'src/db'), { recursive: true });
  cpSync(join(web, 'scripts/check-migrations.mjs'), join(copy, 'scripts/check-migrations.mjs'));
  cpSync(join(web, 'src/db/schema.ts'), join(copy, 'src/db/schema.ts'));
  cpSync(join(web, 'migrations'), join(copy, 'migrations'), { recursive: true });
  symlinkSync(join(web, 'node_modules'), join(copy, 'node_modules'));
});
afterAll(() => rmSync(copy, { recursive: true, force: true }));

function check() {
  return spawnSync(process.execPath, [join(copy, 'scripts/check-migrations.mjs')], {
    encoding: 'utf8',
  });
}

it('accepts migrations that produce the schema.ts tables and indexes', () => {
  expect(check().status).toBe(0);
});

it('rejects a migration SQL file that no longer creates a column schema.ts declares', () => {
  const file = join(copy, 'migrations/0009_checkout_recovery_guards.sql');
  const original = readFileSync(file, 'utf8');
  const statement = 'ALTER TABLE `checkout_intents` ADD `provider_step` text;';
  expect(original).toContain(statement);
  writeFileSync(file, original.replace(statement, 'SELECT 1;'));
  try {
    const result = check();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('table checkout_intents columns differ');
  } finally {
    writeFileSync(file, original);
  }
});
