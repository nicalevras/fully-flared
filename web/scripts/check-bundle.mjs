// Fails when a library that must stay off a hot path ends up in it:
// zod in any browser chunk, and Kysely, Tiptap or sanitize-html in the
// modules the Worker loads at startup (static imports from its entry).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const staticImport =
  /(?:\bimport|\bexport\s*\{[^}]*\}\s*from)\s*(?:[\w$*{}\s,]+from\s*)?["'](\.{1,2}\/[^"']+)["']/g;

function startupGraph(entry) {
  const seen = new Set();
  const pending = [entry];
  for (let file = pending.pop(); file; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, path] of readFileSync(file, 'utf8').matchAll(staticImport))
      pending.push(join(dirname(file), path));
  }
  return [...seen];
}

function offenders(files, markers) {
  return files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return Object.entries(markers)
      .filter(([, marker]) => source.includes(marker))
      .map(([library]) => `${library} in ${file.slice(dist.length + 1)}`);
  });
}

const clientDir = join(dist, 'client/assets');
const client = readdirSync(clientDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(clientDir, f));
const server = startupGraph(join(dist, 'server/index.js'));
const found = [
  ...offenders(client, { zod: '$ZodType' }),
  ...offenders(server, {
    kysely: 'kysely',
    tiptap: 'ProseMirror',
    'sanitize-html': 'allowedSchemesByTag',
  }),
];
const size = (files) => files.reduce((sum, f) => sum + readFileSync(f).length, 0);
console.log(
  `client JS ${size(client)} B in ${client.length} chunks; server startup ${size(server)} B in ${server.length} modules`
);
if (found.length) {
  console.error(`Bundle check failed:\n${found.join('\n')}`);
  process.exit(1);
}
