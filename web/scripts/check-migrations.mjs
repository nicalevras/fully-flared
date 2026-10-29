import { mkdtempSync, cpSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';
// drizzle-kit 0.31 emits invalid SQL for expression indexes, so these live only in the migrations.
const migrationOnlyIndexes = new Set([
  'outbox_retention_idx',
  'webhook_inbox_retention_idx',
  'orders_email_lower_idx',
  'user_email_lower_idx',
]);
// Tables, the FTS5 virtual table with its shadow tables, and triggers are written by hand in the migrations.
const migrationOnlyTables = /^(batch_guard|products_fts(_.*)?)$/;
const internalName = /^(sqlite_|_cf_|d1_)/;

function applySql(db, files) {
  for (const file of files)
    for (const statement of readFileSync(file, 'utf8').split(STATEMENT_BREAKPOINT))
      db.exec(statement);
}

function describeSchema(db) {
  const tables = new Map();
  const indexes = new Map();
  for (const { name, type, tbl_name: table, sql } of db
    .prepare('SELECT name, type, tbl_name, sql FROM sqlite_master')
    .all()) {
    if (internalName.test(name)) continue;
    if (type === 'table') {
      if (migrationOnlyTables.test(name)) continue;
      tables.set(name, {
        columns: db
          .prepare(`PRAGMA table_info("${name}")`)
          .all()
          .map(
            (c) =>
              `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value === 'false' ? 0 : c.dflt_value === 'true' ? 1 : c.dflt_value} pk=${c.pk}`
          ),
        foreignKeys: db
          .prepare(`PRAGMA foreign_key_list("${name}")`)
          .all()
          .map((f) => `${f.from}->${f.table}.${f.to} delete=${f.on_delete} update=${f.on_update}`)
          .sort(),
      });
    } else if (type === 'index' && sql) {
      indexes.set(
        name,
        JSON.stringify({
          table,
          unique: /^CREATE UNIQUE/i.test(sql),
          columns: db
            .prepare(`PRAGMA index_xinfo("${name}")`)
            .all()
            .filter((c) => c.key)
            .map((c) => `${c.name}${c.desc ? ' desc' : ''}`),
          where: (sql.match(/\sWHERE\s.*$/is)?.[0] ?? '').replace(/[`"\s]+/g, ' ').toLowerCase(),
        })
      );
    }
  }
  return { tables, indexes };
}

function compareSchemas(migrated, generated) {
  const problems = [];
  for (const [name, table] of migrated.tables) {
    const expected = generated.tables.get(name);
    if (!expected) problems.push(`table ${name} exists only in the migrations`);
    else {
      const missing = table.columns.filter((c) => !expected.columns.includes(c));
      const extra = expected.columns.filter((c) => !table.columns.includes(c));
      if (missing.length || extra.length)
        problems.push(
          `table ${name} columns differ: migrations only [${missing.join('; ')}], schema.ts only [${extra.join('; ')}]`
        );
      if (table.foreignKeys.join('\n') !== expected.foreignKeys.join('\n'))
        problems.push(`table ${name} foreign keys differ`);
    }
  }
  for (const name of generated.tables.keys())
    if (!migrated.tables.has(name)) problems.push(`table ${name} exists only in schema.ts`);
  for (const [name, index] of migrated.indexes) {
    if (migrationOnlyIndexes.has(name)) continue;
    const expected = generated.indexes.get(name);
    if (!expected) problems.push(`index ${name} exists only in the migrations`);
    else if (index !== expected)
      problems.push(`index ${name} differs:\n  migrations: ${index}\n  schema.ts:  ${expected}`);
  }
  for (const name of generated.indexes.keys())
    if (!migrated.indexes.has(name)) problems.push(`index ${name} exists only in schema.ts`);
  return problems;
}

function generateFresh(scratch) {
  const out = join(scratch, 'fresh');
  execFileSync(
    process.execPath,
    [join(root, 'node_modules/drizzle-kit/bin.cjs'), 'generate', '--config', 'config-fresh.ts'],
    { cwd: scratch, encoding: 'utf8', shell: false }
  );
  return readdirSync(out)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => join(out, f));
}

const scratch = mkdtempSync(join(tmpdir(), 'store-drift-'));
if (!scratch.startsWith(join(tmpdir(), 'store-drift-'))) throw new Error('Unexpected scratch path');
try {
  cpSync(join(root, 'migrations/meta'), join(scratch, 'generated/meta'), { recursive: true });
  const schema = join(root, 'src/db/schema.ts').replaceAll('\\', '/');
  writeFileSync(
    join(scratch, 'config.ts'),
    `export default {schema:${JSON.stringify(schema)},out:'./generated',dialect:'sqlite'};`
  );
  writeFileSync(
    join(scratch, 'config-fresh.ts'),
    `export default {schema:${JSON.stringify(schema)},out:'./fresh',dialect:'sqlite'};`
  );
  const output = execFileSync(
    process.execPath,
    [join(root, 'node_modules/drizzle-kit/bin.cjs'), 'generate', '--config', 'config.ts'],
    { cwd: scratch, encoding: 'utf8', shell: false }
  );
  if (readdirSync(join(scratch, 'generated')).some((f) => f.endsWith('.sql')))
    throw new Error(`Schema drift detected:\n${output}`);
  // Every forward migration after the squashed baseline is scanned
  // (this previously started at 0014, leaving the new sequence
  // unchecked). Intentional drops are reviewed exceptions, named here
  // with their reason — anything else destructive fails the check.
  const reviewedDrops = new Map([
    ['0005_drop_catalog_publication.sql', 'catalog_publication'],
    ['0008_publication_progress.sql', 'catalog_listing_pages'],
  ]);
  for (const file of readdirSync(join(root, 'migrations')).filter(
    (f) => /^\d{4}_.*\.sql$/.test(f) && !f.startsWith('0000_')
  )) {
    const sql = readFileSync(join(root, 'migrations', file), 'utf8');
    if (/__new_/i.test(sql)) throw new Error(`Unsafe table reconstruction in ${file}`);
    const drops = [
      ...sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:`|"|\[)?(\w+)(?:`|"|\])?/gi),
    ];
    for (const drop of drops) {
      if (drop[1] !== reviewedDrops.get(file))
        throw new Error(`Unreviewed table drop in ${file}: ${drop[1]}`);
    }
  }
  const migrated = new DatabaseSync(':memory:');
  applySql(
    migrated,
    readdirSync(join(root, 'migrations'))
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort()
      .map((f) => join(root, 'migrations', f))
  );
  const fresh = new DatabaseSync(':memory:');
  applySql(fresh, generateFresh(scratch));
  const problems = compareSchemas(describeSchema(migrated), describeSchema(fresh));
  if (problems.length) throw new Error(`Migrations differ from schema.ts:\n${problems.join('\n')}`);
  console.log(
    'Migration metadata and SQL match schema; forward repairs contain no table reconstruction.'
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
