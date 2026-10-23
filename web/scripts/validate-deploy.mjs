import JSON5 from 'json5';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values, positionals } = parseArgs({
  options: { config: { type: 'string' }, env: { type: 'string' } },
  allowPositionals: true,
});
const env = values.env ?? positionals[0];
// Parse the repository's JSONC directly; no Wrangler JavaScript API dependency.
const raw = JSON5.parse(readFileSync(values.config ?? join(root, 'wrangler.jsonc'), 'utf8'));
if (env && !Object.hasOwn(raw.env ?? {}, env)) throw new Error('Unknown deployment environment');
const selected = env ? raw.env[env] : raw;
const config = { ...raw, ...selected };
// These bindings do not inherit across named environments (Wrangler config docs).
const vars = selected.vars ?? {};
const origin = vars.BETTER_AUTH_URL;
if (typeof origin !== 'string' || !origin.startsWith('https://') || origin.includes('REPLACE_WITH'))
  throw new Error('Set BETTER_AUTH_URL to the deployment HTTPS origin');
const owners =
  typeof vars.OWNER_EMAIL === 'string'
    ? vars.OWNER_EMAIL.split(',').map((email) => email.trim())
    : [];
if (!owners.length || owners.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
  throw new Error('Set OWNER_EMAIL to a nonempty comma-separated email list');
if (vars.DEV_TRUSTED_ORIGINS)
  throw new Error('Remove development trusted origins before deployment');
for (const binding of [...(selected.kv_namespaces ?? []), ...(selected.ratelimits ?? [])]) {
  const id = binding.id ?? binding.namespace_id;
  if (typeof id !== 'string' || !id || id.includes('REPLACE_WITH'))
    throw new Error('Replace all KV and rate-limit namespace placeholders');
}
const catalogQueue = selected.queues?.producers?.find((q) => q.binding === 'CATALOG_JOBS')?.queue;
const publisher = selected.queues?.consumers?.find((q) => q.queue === catalogQueue);
for (const binding of ['JOBS', 'NOTIFICATIONS', 'CATALOG_JOBS']) {
  const producer = selected.queues?.producers?.find((q) => q.binding === binding);
  if (!producer || vars.QUEUE_NAMES?.[binding] !== producer.queue)
    throw new Error(`QUEUE_NAMES.${binding} must match its producer queue`);
}
if (
  !vars.QUEUE_NAMES?.DLQ ||
  !selected.queues?.consumers?.some((q) => q.queue === vars.QUEUE_NAMES.DLQ) ||
  selected.queues?.consumers?.some(
    (q) => q.dead_letter_queue && q.dead_letter_queue !== vars.QUEUE_NAMES.DLQ
  )
)
  throw new Error('QUEUE_NAMES.DLQ must match the shared dead-letter queue');
if (publisher?.max_concurrency !== 1)
  throw new Error('Catalog queue consumer concurrency must be one');
if (!(config.routes?.length || config.route))
  console.warn(
    'Note: workers.dev deployment is supported; HTML caching becomes effective when a custom domain or route is added.'
  );
console.log(
  'Deployment configuration validated. Secrets, Stripe subscriptions, cache hits and performance still require deployment checks.'
);
