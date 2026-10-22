import { mkdtempSync, cpSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'store-drift-'));
if (!scratch.startsWith(join(tmpdir(), 'store-drift-'))) throw new Error('Unexpected scratch path');
try {
  cpSync(join(root, 'migrations/meta'), join(scratch, 'generated/meta'), { recursive: true });
  const schema = join(root, 'src/db/schema.ts').replaceAll('\\', '/');
  writeFileSync(
    join(scratch, 'config.ts'),
    `export default {schema:${JSON.stringify(schema)},out:'./generated',dialect:'sqlite'};`
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
  console.log(
    'Migration metadata matches schema; forward repairs contain no table reconstruction.'
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
